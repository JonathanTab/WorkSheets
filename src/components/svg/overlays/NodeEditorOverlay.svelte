<script>
    /**
     * NodeEditorOverlay — renders path node editor and pen tool previews
     * inside the parent overlay SVG in SvgEditor.svelte.
     *
     * Reads svgEditorState.toolOverlayData for current state.
     * Fires pointer events back to SvgEditor via callback props:
     *   onNodePointerDown(e, segIdx)
     *   onHandlePointerDown(e, segIdx, handleType)   handleType: 'in' | 'out'
     *
     * This component renders raw SVG elements — it must be placed inside an
     * existing <svg> or <g> in the parent (not wrapped in its own <svg>).
     */
    import { svgEditorState } from '../../../stores/svg/svgEditorState.svelte.js';
    import { anchorPoints, nodeHandles, serializePath } from '../../../lib/svg/pathData.js';

    let {
        onNodePointerDown   = () => {},
        onHandlePointerDown = () => {},
    } = $props();

    const data = $derived(svgEditorState.toolOverlayData);
    const zoom = $derived(svgEditorState.zoom);

    // Scale-independent handle sizes (in SVG user units)
    const NODE_R     = $derived(5  / zoom);   // anchor diamond half-size
    const HANDLE_R   = $derived(3.5 / zoom);  // control handle circle radius
    const STROKE_W   = $derived(1  / zoom);

    // ── Node editor derived state ─────────────────────────────────────────────

    const isNodeEditor = $derived(data?.type === 'nodeEditor');
    const isPen        = $derived(data?.type === 'pen');

    /** Anchor descriptors for node editor */
    const anchors = $derived.by(() => {
        if (!isNodeEditor) return [];
        return anchorPoints(data.segments ?? []);
    });

    /** Handle descriptors: { segIdx, inHandle, outHandle, anchor } */
    const handles = $derived.by(() => {
        if (!isNodeEditor) return [];
        const segs = data.segments ?? [];
        const result = [];
        for (const { index: i } of anchors) {
            const h = nodeHandles(segs, i);
            if (!h) continue;
            result.push({ segIdx: i, ...h });
        }
        return result;
    });

    const selectedNodes = $derived(data?.selectedNodes ?? new Set());

    // ── Pen tool derived state ────────────────────────────────────────────────

    /** Serialized d-string of in-progress pen path */
    const penPathD = $derived.by(() => {
        if (!isPen || !data.segments?.length) return '';
        return serializePath(data.segments);
    });

    /** Preview line from last anchor to cursor */
    const penPreview = $derived.by(() => {
        if (!isPen || !data.previewPt || !data.segments?.length) return null;
        const segs = data.segments;
        const last = segs[segs.length - 1];
        if (!last || last.type === 'Z') return null;
        return { x1: last.x, y1: last.y, x2: data.previewPt.x, y2: data.previewPt.y };
    });

    /** First anchor of pen path (for close-path indicator) */
    const penFirstAnchor = $derived.by(() => {
        if (!isPen || !data.segments?.length) return null;
        const first = data.segments[0];
        if (!first || first.type === 'Z') return null;
        return { x: first.x, y: first.y };
    });

    // ── Event handlers ────────────────────────────────────────────────────────

    function nodeDown(e, idx) {
        e.stopPropagation();
        onNodePointerDown(e, idx);
    }

    function handleDown(e, segIdx, handleType) {
        e.stopPropagation();
        onHandlePointerDown(e, segIdx, handleType);
    }
</script>

<!-- ── Node editor overlay ────────────────────────────────────────────────── -->
{#if isNodeEditor}
    <!-- Control handle lines (drawn first so they appear behind nodes) -->
    {#each handles as h (h.segIdx)}
        {#if h.inHandle}
            <line
                x1={h.anchor.x} y1={h.anchor.y}
                x2={h.inHandle.x} y2={h.inHandle.y}
                stroke="#4f8ef7" stroke-width={STROKE_W}
                stroke-dasharray="{3/zoom} {2/zoom}"
                opacity="0.7"
                pointer-events="none"
            />
        {/if}
        {#if h.outHandle}
            <line
                x1={h.anchor.x} y1={h.anchor.y}
                x2={h.outHandle.x} y2={h.outHandle.y}
                stroke="#4f8ef7" stroke-width={STROKE_W}
                stroke-dasharray="{3/zoom} {2/zoom}"
                opacity="0.7"
                pointer-events="none"
            />
        {/if}
    {/each}

    <!-- Control handle circles (in/out) -->
    {#each handles as h (h.segIdx)}
        {#if h.inHandle}
            <circle
                cx={h.inHandle.x} cy={h.inHandle.y} r={HANDLE_R}
                fill="white" stroke="#4f8ef7" stroke-width={STROKE_W}
                style="cursor:crosshair; pointer-events:all;"
                onpointerdown={(e) => handleDown(e, h.segIdx, 'in')}
            />
        {/if}
        {#if h.outHandle}
            <circle
                cx={h.outHandle.x} cy={h.outHandle.y} r={HANDLE_R}
                fill="white" stroke="#4f8ef7" stroke-width={STROKE_W}
                style="cursor:crosshair; pointer-events:all;"
                onpointerdown={(e) => handleDown(e, h.segIdx, 'out')}
            />
        {/if}
    {/each}

    <!-- Anchor node diamonds -->
    {#each anchors as a (a.index)}
        {@const selected = selectedNodes.has(a.index)}
        <rect
            x={a.x - NODE_R} y={a.y - NODE_R}
            width={NODE_R * 2} height={NODE_R * 2}
            fill={selected ? '#4f8ef7' : 'white'}
            stroke="#4f8ef7"
            stroke-width={STROKE_W}
            transform="rotate(45, {a.x}, {a.y})"
            style="cursor:move; pointer-events:all;"
            onpointerdown={(e) => nodeDown(e, a.index)}
        />
    {/each}
{/if}

<!-- ── Pen tool overlay ───────────────────────────────────────────────────── -->
{#if isPen}
    <!-- Path drawn so far (preview style) -->
    {#if penPathD}
        <path
            d={penPathD}
            fill="none"
            stroke="#4f8ef7"
            stroke-width={1.5 / zoom}
            stroke-dasharray="{5/zoom} {3/zoom}"
            pointer-events="none"
        />
    {/if}

    <!-- Preview line from last point to cursor -->
    {#if penPreview}
        <line
            x1={penPreview.x1} y1={penPreview.y1}
            x2={penPreview.x2} y2={penPreview.y2}
            stroke="#4f8ef7" stroke-width={STROKE_W}
            stroke-dasharray="{4/zoom} {2/zoom}"
            opacity="0.55"
            pointer-events="none"
        />
    {/if}

    <!-- Anchor nodes for pen path -->
    {#if data?.segments}
        {#each anchorPoints(data.segments) as a (a.index)}
            {@const isFirst = a.index === 0}
            <circle
                cx={a.x} cy={a.y}
                r={isFirst ? NODE_R * 1.4 : NODE_R}
                fill={isFirst ? 'rgba(79,142,247,0.18)' : 'white'}
                stroke="#4f8ef7"
                stroke-width={STROKE_W}
                pointer-events="none"
            />
        {/each}
    {/if}
{/if}
