<script>
    /**
     * SvgEditor — infinite-canvas SVG editor.
     *
     * Uses live DOM rendering: the parsed SVGSVGElement is inserted directly
     * into the page. All supported SVG features render natively for free.
     * An overlay SVG on top handles selection boxes, resize handles, and
     * tool-specific overlays.
     *
     * Pointer/keyboard events are dispatched to the active tool via TOOL_REGISTRY.
     * Pan (space+drag, middle-mouse) and wheel-zoom are handled here directly.
     *
     * Props:
     *   onChanged()  — called after any edit that marks the doc dirty
     */
    import { onMount, onDestroy, tick } from 'svelte';
    import { svgEditorState, getBBox, getTranslate, round } from '../../stores/svg/svgEditorState.svelte.js';
    import { TOOL_REGISTRY, selectTool, nodeTool } from '../../lib/svg/tools/index.js';
    import NodeEditorOverlay from './overlays/NodeEditorOverlay.svelte';
    import SvgContextMenu from './SvgContextMenu.svelte';

    let { onChanged = () => {} } = $props();

    // ── DOM refs ──────────────────────────────────────────────────────────────
    /** @type {HTMLDivElement} */ let canvasArea = $state(null);
    /** @type {HTMLDivElement} */ let svgHost    = $state(null);
    /** @type {SVGSVGElement}  */ let overlaySvg = $state(null);

    // ── Pan state (canvas-level, not a tool) ──────────────────────────────────
    let panning   = false;
    let spaceDown = false;
    let midDrag   = false;
    let panStart  = { x: 0, y: 0, px: 0, py: 0 };

    // ── Overlay reactive state ────────────────────────────────────────────────
    // Incremented every pointermove during drag/resize to force overlay recompute
    let _overlayTick = $state(0);
    // Rubber-band rect (updated by selectTool via ctx.setRubberBand)
    let rubberBand = $state(null);  // { x1, y1, x2, y2 } in SVG coords

    // ── Context menu state ────────────────────────────────────────────────────
    let ctxMenu = $state(/** @type {{x:number,y:number}|null} */ (null));

    function onContextMenu(e) {
        e.preventDefault();
        const hit = findShapeAt(e);
        // Select the right-clicked shape if not already in selection
        if (hit && !svgEditorState.selectedIds.has(hit.id)) {
            svgEditorState.selectId(hit.id, false);
        }
        // Clamp so menu doesn't overflow viewport
        const x = Math.min(e.clientX, window.innerWidth  - 210);
        const y = Math.min(e.clientY, window.innerHeight - 320);
        ctxMenu = { x: Math.max(4, x), y: Math.max(4, y) };
    }

    // ── Inline text edit state ────────────────────────────────────────────────
    let textEditId  = $state(null);
    let textEditVal = $state('');

    // ── Coordinate helpers ────────────────────────────────────────────────────

    /** Client coords → SVG user units */
    function toSvg(clientX, clientY) {
        if (!canvasArea) return { x: 0, y: 0 };
        const r = canvasArea.getBoundingClientRect();
        return {
            x: (clientX - r.left - svgEditorState.panX) / svgEditorState.zoom,
            y: (clientY - r.top  - svgEditorState.panY) / svgEditorState.zoom,
        };
    }

    /** Client coords → canvas-area local coords */
    function toCanvas(clientX, clientY) {
        if (!canvasArea) return { x: 0, y: 0 };
        const r = canvasArea.getBoundingClientRect();
        return { x: clientX - r.left, y: clientY - r.top };
    }

    // ── Snap to grid ──────────────────────────────────────────────────────────

    function snapPt(pt) {
        const g = svgEditorState.grid;
        if (!svgEditorState.showGrid || !g?.enabled) return pt;
        return {
            x: Math.round((pt.x - g.originx) / g.spacingx) * g.spacingx + g.originx,
            y: Math.round((pt.y - g.originy) / g.spacingy) * g.spacingy + g.originy,
        };
    }

    // ── Shape hit test ────────────────────────────────────────────────────────

    function findShapeAt(e) {
        const shapes = [...svgEditorState.shapes].reverse();
        for (const s of shapes) {
            if (!s.visible) continue;
            if (s.el.contains(e.target) && s.el !== svgEditorState.svgEl) return s;
        }
        if (!svgEditorState.svgEl) return null;
        const els = document.elementsFromPoint(e.clientX, e.clientY);
        for (const el of els) {
            for (const s of shapes) {
                if (s.el === el || s.el.contains(el)) return s;
            }
        }
        return null;
    }

    // ── Text edit helpers ─────────────────────────────────────────────────────

    function startTextEdit(id) {
        const s = svgEditorState.shapes.find(s => s.id === id);
        textEditId  = id;
        textEditVal = s?.el.textContent ?? '';
    }

    function commitEdit() {
        if (!textEditId) return;
        const s = svgEditorState.shapes.find(s => s.id === textEditId);
        if (s) {
            s.el.textContent = textEditVal;
            svgEditorState.pushHistory();
            onChanged();
        }
        textEditId  = null;
        textEditVal = '';
    }

    // ── ToolContext factory ───────────────────────────────────────────────────

    function makeCtx() {
        return {
            state:          svgEditorState,
            toSvg,
            snap:           snapPt,
            onChanged,
            tickOverlay:    () => { _overlayTick++; },
            setRubberBand:  (rb) => { rubberBand = rb; },
            findShapeAt,
            startTextEdit,
        };
    }

    // ── Tool lifecycle (activate / deactivate) ────────────────────────────────

    let _prevToolId = svgEditorState.activeTool;

    $effect(() => {
        const toolId = svgEditorState.activeTool;
        if (toolId === _prevToolId) return;
        TOOL_REGISTRY[_prevToolId]?.onDeactivate?.(makeCtx());
        TOOL_REGISTRY[toolId]?.onActivate?.(makeCtx());
        _prevToolId = toolId;
    });

    // ── SVG host management ───────────────────────────────────────────────────

    let _mountedSvgEl = null;

    $effect(() => {
        const root = svgEditorState.svgEl;
        if (!svgHost || !root) return;
        if (root === _mountedSvgEl) return;
        svgHost.innerHTML = '';
        svgHost.appendChild(root);
        _mountedSvgEl = root;
        tick().then(() => {
            if (canvasArea) {
                const r = canvasArea.getBoundingClientRect();
                svgEditorState.fitToView(r.width, r.height);
            }
        });
    });

    // ── Pointer events ────────────────────────────────────────────────────────

    function onPointerDown(e) {
        canvasArea.setPointerCapture(e.pointerId);

        // Pan: middle-mouse or Space+left
        if (e.button === 1 || (e.button === 0 && spaceDown)) {
            panning  = true;
            midDrag  = e.button === 1;
            panStart = { x: e.clientX, y: e.clientY, px: svgEditorState.panX, py: svgEditorState.panY };
            e.preventDefault();
            return;
        }
        if (e.button !== 0) return;

        const tool = TOOL_REGISTRY[svgEditorState.activeTool];
        if (!tool) return;

        const pt = snapPt(toSvg(e.clientX, e.clientY));
        tool.onPointerDown(makeCtx(), pt, e);
    }

    function onPointerMove(e) {
        const pt = snapPt(toSvg(e.clientX, e.clientY));
        svgEditorState.cursorX = round(pt.x);
        svgEditorState.cursorY = round(pt.y);

        if (panning) {
            const dx = e.clientX - panStart.x;
            const dy = e.clientY - panStart.y;
            svgEditorState.panX = panStart.px + dx;
            svgEditorState.panY = panStart.py + dy;
            return;
        }

        const tool = TOOL_REGISTRY[svgEditorState.activeTool];
        tool?.onPointerMove(makeCtx(), pt, e);
    }

    function onPointerUp(e) {
        canvasArea?.releasePointerCapture(e.pointerId);

        if (panning) { panning = false; midDrag = false; return; }

        const pt = snapPt(toSvg(e.clientX, e.clientY));
        const tool = TOOL_REGISTRY[svgEditorState.activeTool];
        tool?.onPointerUp(makeCtx(), pt, e);
    }

    function onWheel(e) {
        e.preventDefault();
        const cv    = toCanvas(e.clientX, e.clientY);
        const delta = e.deltaY > 0 ? 0.9 : 1 / 0.9;
        svgEditorState.setZoom(svgEditorState.zoom * delta, cv.x, cv.y);
    }

    function onDblClick(e) {
        const activeTool = TOOL_REGISTRY[svgEditorState.activeTool];
        if (activeTool?.onDblClick) {
            activeTool.onDblClick(makeCtx(), e);
        }
        // Double-clicking a path in select mode → enter node editor
        if (svgEditorState.activeTool === 'select') {
            const hit = findShapeAt(e);
            if (hit?.tag === 'path') {
                svgEditorState.activeTool = 'node';
                // nodeTool.onActivate will pick up the selection
            }
        }
    }

    // ── Keyboard ──────────────────────────────────────────────────────────────

    const KEY_TOOLS = { v: 'select', r: 'rect', e: 'ellipse', l: 'line', t: 'text', p: 'pencil', n: 'node', b: 'pen' };

    async function onKeydown(e) {
        if (textEditId) {
            if (e.key === 'Escape') commitEdit();
            return;
        }

        // Let the active tool handle key events first (node editor, pen tool, etc.)
        const activeTool = TOOL_REGISTRY[svgEditorState.activeTool];
        if (activeTool?.onKeyDown) {
            activeTool.onKeyDown(makeCtx(), e);
            if (e.defaultPrevented) return;
        }

        const mod = e.ctrlKey || e.metaKey;

        if (mod && e.key === 'a') { e.preventDefault(); svgEditorState.selectAll(); return; }
        if (mod && e.key === 'c') { e.preventDefault(); await svgEditorState.copySelected(); return; }
        if (mod && e.key === 'x') { e.preventDefault(); await svgEditorState.cutSelected(); onChanged(); return; }
        if (mod && e.key === 'v') { e.preventDefault(); await svgEditorState.pasteClipboard(); onChanged(); return; }
        if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); svgEditorState.undo(); return; }
        if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); svgEditorState.redo(); return; }
        if (mod && e.key === 'g' && !e.shiftKey) { e.preventDefault(); svgEditorState.groupSelected(); onChanged(); return; }
        if (mod && e.key === 'g' && e.shiftKey)  { e.preventDefault(); svgEditorState.ungroupSelected(); onChanged(); return; }
        if (mod && (e.key === '=' || e.key === '+')) {
            e.preventDefault();
            if (canvasArea) {
                const r = canvasArea.getBoundingClientRect();
                svgEditorState.setZoom(svgEditorState.zoom * 1.2, r.width / 2, r.height / 2);
            }
            return;
        }
        if (mod && e.key === '-') {
            e.preventDefault();
            if (canvasArea) {
                const r = canvasArea.getBoundingClientRect();
                svgEditorState.setZoom(svgEditorState.zoom / 1.2, r.width / 2, r.height / 2);
            }
            return;
        }
        if (mod && e.key === '0') {
            e.preventDefault();
            if (canvasArea) {
                const r = canvasArea.getBoundingClientRect();
                svgEditorState.fitToView(r.width, r.height);
            }
            return;
        }

        if (!mod && !e.altKey) {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (svgEditorState.selectedIds.size > 0) {
                    e.preventDefault();
                    svgEditorState.deleteSelected();
                    onChanged();
                }
                return;
            }
            if (e.key === 'Escape') { svgEditorState.clearSelection(); return; }
            const tool = KEY_TOOLS[e.key.toLowerCase()];
            if (tool) { svgEditorState.activeTool = tool; return; }

            const NUDGE = e.shiftKey ? 10 : 1;
            if (e.key === 'ArrowLeft')  { svgEditorState.moveSelected(-NUDGE, 0); svgEditorState.pushHistory(); onChanged(); e.preventDefault(); }
            if (e.key === 'ArrowRight') { svgEditorState.moveSelected( NUDGE, 0); svgEditorState.pushHistory(); onChanged(); e.preventDefault(); }
            if (e.key === 'ArrowUp')    { svgEditorState.moveSelected(0, -NUDGE); svgEditorState.pushHistory(); onChanged(); e.preventDefault(); }
            if (e.key === 'ArrowDown')  { svgEditorState.moveSelected(0,  NUDGE); svgEditorState.pushHistory(); onChanged(); e.preventDefault(); }
        }

        if (e.key === ' ') { e.preventDefault(); spaceDown = true; }
    }

    function onKeyup(e) {
        if (e.key === ' ') spaceDown = false;
    }

    onMount(() => {
        window.addEventListener('keydown', onKeydown);
        window.addEventListener('keyup',   onKeyup);
    });
    onDestroy(() => {
        window.removeEventListener('keydown', onKeydown);
        window.removeEventListener('keyup',   onKeyup);
    });

    // ── Derived selection info ────────────────────────────────────────────────

    const selShapes = $derived(svgEditorState.selectedShapes);
    const selSingle = $derived(selShapes.length === 1 ? selShapes[0] : null);

    // Union bbox of all selected shapes (touching _overlayTick recomputes on every drag frame)
    const selBbox = $derived.by(() => {
        void _overlayTick;
        if (!selShapes.length || !svgEditorState.svgEl) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of selShapes) {
            const b = getBBox(s.el);
            const t = getTranslate(s.el);
            if (b.w === 0 && b.h === 0) continue;
            const vx = b.x + t.x, vy = b.y + t.y;
            minX = Math.min(minX, vx); minY = Math.min(minY, vy);
            maxX = Math.max(maxX, vx + b.w); maxY = Math.max(maxY, vy + b.h);
        }
        if (!isFinite(minX)) return null;
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    });

    // ── Cursor ────────────────────────────────────────────────────────────────

    const cursor = $derived.by(() => {
        if (panning || midDrag) return 'grabbing';
        if (spaceDown) return 'grab';
        return TOOL_REGISTRY[svgEditorState.activeTool]?.cursor() ?? 'default';
    });

    // ── Overlay constants ─────────────────────────────────────────────────────

    const HANDLES   = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const HANDLE_R  = 5;
    const overlayVB = $derived(`0 0 ${svgEditorState.artboardW} ${svgEditorState.artboardH}`);
    const HR        = $derived(HANDLE_R / svgEditorState.zoom);

    function handlePos(bbox, handle) {
        const { x, y, w, h } = bbox;
        switch (handle) {
            case 'nw': return { cx: x,       cy: y       };
            case 'n':  return { cx: x + w/2, cy: y       };
            case 'ne': return { cx: x + w,   cy: y       };
            case 'e':  return { cx: x + w,   cy: y + h/2 };
            case 'se': return { cx: x + w,   cy: y + h   };
            case 's':  return { cx: x + w/2, cy: y + h   };
            case 'sw': return { cx: x,       cy: y + h   };
            case 'w':  return { cx: x,       cy: y + h/2 };
        }
    }

    function onHandlePointerDown(e, handle) {
        e.stopPropagation();
        // stopPropagation prevents canvasArea.onPointerDown from firing, so pointer
        // capture must be set here to keep move/up events flowing during fast drags.
        canvasArea?.setPointerCapture(e.pointerId);
        const pt = snapPt(toSvg(e.clientX, e.clientY));
        selectTool.onHandlePointerDown(makeCtx(), pt, e, handle);
    }

    // ── Node editor overlay events ────────────────────────────────────────────

    function onNodePointerDown(e, segIdx) {
        // Called from NodeEditorOverlay when user presses an anchor diamond.
        // stopPropagation is already done in the overlay; capture pointer here so
        // move/up events keep reaching canvasArea during fast drags.
        canvasArea?.setPointerCapture(e.pointerId);
        const pt = snapPt(toSvg(e.clientX, e.clientY));
        nodeTool.onNodePointerDown(makeCtx(), pt, e, segIdx);
    }

    function onNodeHandlePointerDown(e, segIdx, handleType) {
        // Called from NodeEditorOverlay when user presses a control handle circle.
        canvasArea?.setPointerCapture(e.pointerId);
        const pt = snapPt(toSvg(e.clientX, e.clientY));
        nodeTool.onHandlePointerDown(makeCtx(), pt, e, segIdx, handleType);
    }

    // ── Text edit position (client px, for floating textarea) ─────────────────

    const textEditPos = $derived.by(() => {
        if (!textEditId || !svgEditorState.svgEl || !canvasArea) return null;
        const s = svgEditorState.shapes.find(s => s.id === textEditId);
        if (!s) return null;
        try {
            const b  = s.el.getBoundingClientRect();
            const ca = canvasArea.getBoundingClientRect();
            return {
                left: b.left - ca.left,
                top:  b.top  - ca.top,
                w:    Math.max(120, b.width),
                h:    Math.max(28,  b.height),
            };
        } catch { return null; }
    });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
    class="canvas-area"
    bind:this={canvasArea}
    style="cursor:{cursor}"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    ondblclick={onDblClick}
    oncontextmenu={onContextMenu}
    onwheel={onWheel}
    tabindex="-1"
>
    <!-- Infinite pan/zoom viewport -->
    <div
        class="viewport"
        style="transform: translate({svgEditorState.panX}px, {svgEditorState.panY}px) scale({svgEditorState.zoom}); transform-origin: 0 0;"
    >
        <!-- Artboard background (page color from document properties) -->
        <div
            class="artboard-bg"
            style="width:{svgEditorState.artboardW}px; height:{svgEditorState.artboardH}px; background:{svgEditorState.pageColor};"
        ></div>

        <!-- Grid overlay (inside artboard bounds) -->
        {#if svgEditorState.showGrid && svgEditorState.grid}
            {@const g = svgEditorState.grid}
            <div
                class="grid-overlay"
                style="width:{svgEditorState.artboardW}px; height:{svgEditorState.artboardH}px;
                       background-image: repeating-linear-gradient(0deg, rgba(79,142,247,0.18) 0, rgba(79,142,247,0.18) 1px, transparent 1px, transparent {g.spacingy}px), repeating-linear-gradient(90deg, rgba(79,142,247,0.18) 0, rgba(79,142,247,0.18) 1px, transparent 1px, transparent {g.spacingx}px);
                       background-size: {g.spacingx}px {g.spacingy}px;
                       background-position: {g.originx}px {g.originy}px;"
            ></div>
        {/if}

        <!-- Live SVG document host -->
        <div
            class="svg-host"
            bind:this={svgHost}
            style="width:{svgEditorState.artboardW}px; height:{svgEditorState.artboardH}px;"
        ></div>

        <!-- Overlay: selection, handles, rubber-band, tool overlays -->
        <svg
            bind:this={overlaySvg}
            class="overlay"
            viewBox={overlayVB}
            style="width:{svgEditorState.artboardW}px; height:{svgEditorState.artboardH}px;"
            overflow="visible"
        >
            <!-- Guides (infinite lines from namedview) -->
            {#if svgEditorState.showGuides}
                {#each svgEditorState.guides as guide (guide.id)}
                    {@const HUGE = 1e6}
                    {@const lx1 = guide.x + guide.dy * HUGE}
                    {@const ly1 = guide.y - guide.dx * HUGE}
                    {@const lx2 = guide.x - guide.dy * HUGE}
                    {@const ly2 = guide.y + guide.dx * HUGE}
                    <line
                        x1={lx1} y1={ly1} x2={lx2} y2={ly2}
                        stroke="#4f8ef7"
                        stroke-width={1 / svgEditorState.zoom}
                        stroke-dasharray="{8 / svgEditorState.zoom} {4 / svgEditorState.zoom}"
                        opacity="0.55"
                        pointer-events="none"
                    />
                {/each}
            {/if}

            <!-- Rubber-band selection rect -->
            {#if rubberBand}
                {@const rb = rubberBand}
                {@const rx = Math.min(rb.x1, rb.x2)}
                {@const ry = Math.min(rb.y1, rb.y2)}
                {@const rw = Math.abs(rb.x2 - rb.x1)}
                {@const rh = Math.abs(rb.y2 - rb.y1)}
                <rect
                    x={rx} y={ry} width={rw} height={rh}
                    fill="rgba(79,142,247,0.08)"
                    stroke="#4f8ef7"
                    stroke-width={1 / svgEditorState.zoom}
                    stroke-dasharray="{4 / svgEditorState.zoom} {2 / svgEditorState.zoom}"
                    pointer-events="none"
                />
            {/if}

            <!-- Selection bbox -->
            {#if selBbox}
                {@const pad = 4 / svgEditorState.zoom}
                {@const bx = selBbox.x - pad}
                {@const by = selBbox.y - pad}
                {@const bw = selBbox.w + pad * 2}
                {@const bh = selBbox.h + pad * 2}
                <rect
                    x={bx} y={by} width={bw} height={bh}
                    fill="none"
                    stroke="#4f8ef7"
                    stroke-width={1.5 / svgEditorState.zoom}
                    stroke-dasharray="{6 / svgEditorState.zoom} {3 / svgEditorState.zoom}"
                    pointer-events="none"
                />

                <!-- Resize handles (single selection only) -->
                {#if selSingle && !selSingle.locked}
                    {#each HANDLES as h}
                        {@const hp = handlePos({ x: bx, y: by, w: bw, h: bh }, h)}
                        {#if hp}
                            <circle
                                cx={hp.cx} cy={hp.cy}
                                r={HR}
                                fill="white"
                                stroke="#4f8ef7"
                                stroke-width={1.5 / svgEditorState.zoom}
                                style="cursor:{h}-resize; pointer-events:all;"
                                data-handle={h}
                                onpointerdown={(e) => onHandlePointerDown(e, h)}
                            />
                        {/if}
                    {/each}
                {/if}
            {/if}

            <!-- Node editor / pen tool overlay -->
            {#if svgEditorState.activeTool === 'node' || svgEditorState.activeTool === 'pen'}
                <NodeEditorOverlay
                    onNodePointerDown={onNodePointerDown}
                    onHandlePointerDown={onNodeHandlePointerDown}
                />
            {/if}
        </svg>
    </div>

    <!-- Inline text editor (floating textarea) -->
    {#if textEditId && textEditPos}
        <textarea
            class="text-editor-overlay"
            style="left:{textEditPos.left}px; top:{textEditPos.top}px; min-width:{textEditPos.w}px; min-height:{textEditPos.h}px;"
            bind:value={textEditVal}
            onblur={commitEdit}
            onkeydown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                if (e.key === 'Escape') commitEdit();
            }}
            use:autoFocus
        ></textarea>
    {/if}

    <!-- Zoom indicator -->
    <div class="zoom-badge">{Math.round(svgEditorState.zoom * 100)}%</div>
</div>

{#if ctxMenu}
    <SvgContextMenu
        x={ctxMenu.x}
        y={ctxMenu.y}
        onClose={() => { ctxMenu = null; }}
        {onChanged}
    />
{/if}

<script module>
    function autoFocus(node) {
        node.focus();
        node.select();
    }
</script>

<style>
    .canvas-area {
        flex: 1;
        overflow: hidden;
        position: relative;
        min-height: 0;
        touch-action: none;
        user-select: none;
        /* Transparency checkerboard — the artboard artboard-bg sits on top */
        background-color: #888;
        background-image:
            linear-gradient(45deg, #666 25%, transparent 25%),
            linear-gradient(-45deg, #666 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #666 75%),
            linear-gradient(-45deg, transparent 75%, #666 75%);
        background-size: 16px 16px;
        background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
    }

    .viewport {
        position: absolute;
        top: 0; left: 0;
        width: 0; height: 0;
        will-change: transform;
    }

    /* Artboard background */
    .artboard-bg {
        position: absolute;
        top: 0; left: 0;
        box-shadow: 0 4px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.15);
        pointer-events: none;
    }

    /* Grid overlay */
    .grid-overlay {
        position: absolute;
        top: 0; left: 0;
        pointer-events: none;
    }

    /* SVG host */
    .svg-host {
        position: absolute;
        top: 0; left: 0;
        pointer-events: none;
    }
    .svg-host :global(svg) {
        display: block;
        width: 100%;
        height: 100%;
        overflow: visible;
        pointer-events: all;
        /* Prevent imported SVGs with background-color styles from hiding the artboard-bg */
        background: transparent !important;
    }

    /* Overlay */
    .overlay {
        position: absolute;
        top: 0; left: 0;
        pointer-events: none;
        overflow: visible;
    }

    /* Inline text editor */
    .text-editor-overlay {
        position: absolute;
        z-index: 100;
        background: rgba(15, 15, 30, 0.92);
        color: #e0e0e0;
        border: 1.5px solid #4f8ef7;
        border-radius: 3px;
        font-size: 14px;
        padding: 2px 6px;
        resize: both;
        outline: none;
        min-width: 80px;
        min-height: 24px;
        font-family: sans-serif;
    }

    /* Zoom badge */
    .zoom-badge {
        position: absolute;
        bottom: 8px;
        right: 12px;
        font-size: 11px;
        color: rgba(255,255,255,0.35);
        pointer-events: none;
        user-select: none;
    }
</style>
