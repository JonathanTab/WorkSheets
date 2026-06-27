<script>
    /**
     * FloatingImages - Over-grid floating image layer.
     *
     * Rendering: the image PIXELS are painted on a dedicated <canvas> (consistent with
     * cell images and cheaper than DOM <img> — no per-image layout/decode in the DOM).
     * Interaction (select / drag / resize / properties panel) lives in a thin transparent
     * DOM layer on top of that canvas.
     *
     * Props:
     *   sheetStore    - SheetStore instance (reactive floatingImages + methods)
     *   virtualizer   - GridVirtualizer for row/col metrics + scroll position
     *   frozenWidth   - CSS px width of frozen columns pane
     *   frozenHeight  - CSS px height of frozen rows pane
     *   headerWidth   - CSS px width of row headers
     *   headerHeight  - CSS px height of col headers
     *   docId         - Parent doc ID for new blob uploads
     *
     * Data model (per image in sheetStore.floatingImages):
     *   { blobId, anchorRow, anchorCol, offsetX, offsetY, width, height, fit,
     *     alt, caption, borderWidth, borderColor, borderRadius, opacity }
     */
    import { onDestroy } from 'svelte';
    import storage from '../../stores/storage.js';
    import FloatingImagePanel from './FloatingImagePanel.svelte';
    import ImageEditor from './cellTypes/ImageEditor.svelte';

    let {
        sheetStore = null,
        virtualizer = null,
        frozenWidth = 0,
        frozenHeight = 0,
        headerWidth = 40,
        headerHeight = 24,
        docId = null,
    } = $props();

    // ── Local drag / resize state ──────────────────────────────────────────────

    /** @type {{ id: string, startMouseX: number, startMouseY: number, startOffsetX: number, startOffsetY: number, anchorRow: number, anchorCol: number } | null} */
    let dragging = $state(null);
    /** @type {{ id: string, handle: 'se'|'sw'|'ne'|'nw', startMouseX: number, startMouseY: number, startW: number, startH: number, startOffsetX: number, startOffsetY: number } | null} */
    let resizing = $state(null);
    /** @type {string|null} */
    let selectedId = $state(null);
    let showReplace = $state(false);

    let rootEl = $state(null);
    let canvasEl = $state(null);
    let rootW = $state(0);
    let rootH = $state(0);

    // ── Local image cache (decoupled from the grid's shared ImageCache so loads
    //    repaint THIS canvas) ─────────────────────────────────────────────────
    /** @type {Map<string, { img: HTMLImageElement, status: 'loading'|'loaded'|'error' }>} */
    const imgCache = new Map();
    let loadTick = $state(0);

    function getEntry(blobId) {
        if (!blobId) return null;
        const url = storage.app.getBlobUrl(blobId);
        const existing = imgCache.get(blobId);
        if (existing && existing.url === url) return existing;
        const entry = { img: new Image(), status: 'loading', url };
        entry.img.onload = () => { entry.status = 'loaded'; loadTick++; };
        entry.img.onerror = () => { entry.status = 'error'; loadTick++; };
        entry.img.src = url;
        imgCache.set(blobId, entry);
        return entry;
    }

    // ── Helpers: grid coordinates ─────────────────────────────────────────────

    function imageScreenPos(anchorRow, anchorCol, offsetX, offsetY) {
        if (!virtualizer) return { x: headerWidth + offsetX, y: headerHeight + offsetY };
        const frozenRows = virtualizer.frozenRows ?? 0;
        const frozenCols = virtualizer.frozenCols ?? 0;

        let x, y;
        if (anchorCol < frozenCols) {
            x = headerWidth + virtualizer.colMetrics.offsetOf(anchorCol) + offsetX;
        } else {
            x = headerWidth + frozenWidth + virtualizer.colMetrics.offsetOf(anchorCol) - virtualizer.scrollLeft + offsetX;
        }
        if (anchorRow < frozenRows) {
            y = headerHeight + virtualizer.rowMetrics.offsetOf(anchorRow) + offsetY;
        } else {
            y = headerHeight + frozenHeight + virtualizer.rowMetrics.offsetOf(anchorRow) - virtualizer.scrollTop + offsetY;
        }
        return { x, y };
    }

    function screenPosToAnchor(screenX, screenY) {
        if (!virtualizer) return { anchorRow: 0, anchorCol: 0, offsetX: screenX - headerWidth, offsetY: screenY - headerHeight };
        let logicalX = screenX - headerWidth;
        let logicalY = screenY - headerHeight;
        if (logicalX > frozenWidth) logicalX += virtualizer.scrollLeft - frozenWidth;
        if (logicalY > frozenHeight) logicalY += virtualizer.scrollTop - frozenHeight;
        const col = virtualizer.colMetrics.indexAtOffset(Math.max(0, logicalX));
        const row = virtualizer.rowMetrics.indexAtOffset(Math.max(0, logicalY));
        const colOffset = logicalX - virtualizer.colMetrics.offsetOf(col);
        const rowOffset = logicalY - virtualizer.rowMetrics.offsetOf(row);
        return {
            anchorRow: Math.max(0, row),
            anchorCol: Math.max(0, col),
            offsetX: Math.round(colOffset),
            offsetY: Math.round(rowOffset),
        };
    }

    // ── Reactive image list ───────────────────────────────────────────────────

    let images = $derived.by(() => {
        if (!sheetStore) return [];
        const _v = sheetStore.floatingImagesVersion;
        return [...(sheetStore.floatingImages?.values() ?? [])];
    });

    let selected = $derived(images.find((i) => i.id === selectedId) ?? null);

    // ── Canvas painting ───────────────────────────────────────────────────────

    function roundRectPath(ctx, x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rr); return; }
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    function drawFitted(ctx, img, x, y, w, h, fit) {
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        if (!iw || !ih) return;
        if (fit === 'fill') { ctx.drawImage(img, x, y, w, h); return; }
        if (fit === 'none') {
            const dx = Math.round(x + (w - iw) / 2), dy = Math.round(y + (h - ih) / 2);
            ctx.drawImage(img, dx, dy, iw, ih);
            return;
        }
        const scale = fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
        const dw = iw * scale, dh = ih * scale;
        ctx.drawImage(img, Math.round(x + (w - dw) / 2), Math.round(y + (h - dh) / 2), Math.round(dw), Math.round(dh));
    }

    function drawMissing(ctx, x, y, w, h) {
        ctx.save();
        ctx.fillStyle = '#f1f5f9';
        roundRectPath(ctx, x, y, w, h, 4); ctx.fill();
        ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🖼  image missing', x + w / 2, y + h / 2);
        ctx.restore();
    }

    function paint() {
        const canvas = canvasEl;
        if (!canvas || !rootW || !rootH) return;
        const dpr = window.devicePixelRatio || 1;
        const pxW = Math.round(rootW * dpr), pxH = Math.round(rootH * dpr);
        if (canvas.width !== pxW) canvas.width = pxW;
        if (canvas.height !== pxH) canvas.height = pxH;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rootW, rootH);

        for (const item of images) {
            const { x, y } = imageScreenPos(item.anchorRow, item.anchorCol, item.offsetX, item.offsetY);
            const w = item.width, h = item.height;
            const r = item.borderRadius ?? 0;
            const entry = getEntry(item.blobId);

            ctx.save();
            ctx.globalAlpha = item.opacity ?? 1;
            if (entry?.status === 'loaded') {
                ctx.save();
                roundRectPath(ctx, x, y, w, h, r);
                ctx.clip();
                drawFitted(ctx, entry.img, x, y, w, h, item.fit ?? 'contain');
                ctx.restore();
            } else if (entry?.status === 'error') {
                drawMissing(ctx, x, y, w, h);
            } else {
                ctx.fillStyle = '#e2e8f0';
                roundRectPath(ctx, x, y, w, h, r); ctx.fill();
            }

            // Border
            const bw = item.borderWidth ?? 0;
            if (bw > 0) {
                roundRectPath(ctx, x + bw / 2, y + bw / 2, w - bw, h - bw, Math.max(0, r - bw / 2));
                ctx.lineWidth = bw;
                ctx.strokeStyle = item.borderColor || '#000000';
                ctx.stroke();
            }
            ctx.restore();

            // Caption (below the image, full opacity)
            if (item.caption) {
                ctx.save();
                ctx.font = '12px system-ui, sans-serif';
                ctx.fillStyle = '#475569';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                const cap = item.caption.length > 80 ? item.caption.slice(0, 79) + '…' : item.caption;
                ctx.fillText(cap, x + w / 2, y + h + 4, w);
                ctx.restore();
            }
        }
    }

    // Repaint whenever the image list, scroll, size, or a load completes changes.
    $effect(() => {
        void images;
        void loadTick;
        void rootW; void rootH;
        void virtualizer?.scrollLeft; void virtualizer?.scrollTop;
        paint();
    });

    // ── Drag handling ─────────────────────────────────────────────────────────

    function startDrag(e, id, img) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        selectedId = id;
        dragging = {
            id,
            startMouseX: e.clientX, startMouseY: e.clientY,
            startOffsetX: img.offsetX, startOffsetY: img.offsetY,
            anchorRow: img.anchorRow, anchorCol: img.anchorCol,
        };
        document.addEventListener('mousemove', handleDragMove);
        document.addEventListener('mouseup', handleDragEnd);
    }

    function handleDragMove(e) {
        if (!dragging || !sheetStore) return;
        const dx = e.clientX - dragging.startMouseX;
        const dy = e.clientY - dragging.startMouseY;
        const anchorPos = imageScreenPos(dragging.anchorRow, dragging.anchorCol, dragging.startOffsetX, dragging.startOffsetY);
        const anchor = screenPosToAnchor(anchorPos.x + dx, anchorPos.y + dy);
        sheetStore.updateFloatingImage(dragging.id, {
            anchorRow: anchor.anchorRow, anchorCol: anchor.anchorCol,
            offsetX: anchor.offsetX, offsetY: anchor.offsetY,
        });
    }

    function handleDragEnd() {
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
        dragging = null;
    }

    // ── Resize handling ───────────────────────────────────────────────────────

    function startResize(e, id, img, handle) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        selectedId = id;
        resizing = {
            id, handle,
            startMouseX: e.clientX, startMouseY: e.clientY,
            startW: img.width, startH: img.height,
            startOffsetX: img.offsetX, startOffsetY: img.offsetY,
            anchorRow: img.anchorRow, anchorCol: img.anchorCol,
        };
        document.addEventListener('mousemove', handleResizeMove);
        document.addEventListener('mouseup', handleResizeEnd);
    }

    function handleResizeMove(e) {
        if (!resizing || !sheetStore) return;
        const dx = e.clientX - resizing.startMouseX;
        const dy = e.clientY - resizing.startMouseY;
        const { handle } = resizing;

        let newW = resizing.startW;
        let newH = resizing.startH;
        if (handle === 'se') { newW = Math.max(40, resizing.startW + dx); newH = Math.max(40, resizing.startH + dy); }
        else if (handle === 'sw') { newW = Math.max(40, resizing.startW - dx); newH = Math.max(40, resizing.startH + dy); }
        else if (handle === 'ne') { newW = Math.max(40, resizing.startW + dx); newH = Math.max(40, resizing.startH - dy); }
        else if (handle === 'nw') { newW = Math.max(40, resizing.startW - dx); newH = Math.max(40, resizing.startH - dy); }

        const newOffX = resizing.startOffsetX + (handle.includes('w') ? Math.min(dx, resizing.startW - 40) : 0);
        const newOffY = resizing.startOffsetY + (handle.includes('n') ? Math.min(dy, resizing.startH - 40) : 0);

        sheetStore.updateFloatingImage(resizing.id, {
            width: Math.round(newW), height: Math.round(newH),
            offsetX: Math.round(newOffX), offsetY: Math.round(newOffY),
        });
    }

    function handleResizeEnd() {
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
        resizing = null;
    }

    // ── Selection / delete ────────────────────────────────────────────────────

    function handleKeydown(e) {
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
            deleteSelected();
            e.preventDefault();
        } else if (e.key === 'Escape') {
            selectedId = null;
        }
    }

    /** True if another floating image in this sheet still references the same blob. */
    function blobUsedByOtherFloating(blobId, exceptId) {
        if (!blobId) return false;
        return images.some((i) => i.id !== exceptId && i.blobId === blobId);
    }

    /** Release this doc's claim on a blob unless another floating image still uses it. */
    function maybeRelease(blobId, exceptId) {
        if (!blobId) return;
        if (blobUsedByOtherFloating(blobId, exceptId)) return;
        // releaseBlob is safe whether the blob is doc-owned or a loose Drive reference.
        storage.app.releaseBlob(blobId, docId).catch(() => {});
    }

    function deleteSelected() {
        const img = selected;
        if (img) {
            maybeRelease(img.blobId, img.id);
            sheetStore?.removeFloatingImage(img.id);
        }
        selectedId = null;
        showReplace = false;
    }

    function handleDocMousedown(e) {
        if (!selectedId) return;
        if (e.target.closest?.('.floating-image, .fip, .floating-replace')) return;
        selectedId = null;
    }

    $effect(() => {
        document.addEventListener('mousedown', handleDocMousedown, true);
        return () => document.removeEventListener('mousedown', handleDocMousedown, true);
    });

    onDestroy(() => {
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
        document.removeEventListener('mousedown', handleDocMousedown, true);
    });

    // ── Panel actions ─────────────────────────────────────────────────────────

    function applyUpdate(changes) {
        if (selectedId) sheetStore?.updateFloatingImage(selectedId, changes);
    }

    function handleReplaceCommit(newBlobId) {
        const img = selected;
        showReplace = false;
        if (!img || !newBlobId || newBlobId === img.blobId) return;
        // Release the previous blob from this doc (unless reused), then point at the new one.
        maybeRelease(img.blobId, img.id);
        sheetStore?.updateFloatingImage(img.id, { blobId: newBlobId });
    }

    // Viewport rect of the selected image (for positioning the DOM affordances/panel).
    function rectFor(img) {
        const pos = imageScreenPos(img.anchorRow, img.anchorCol, img.offsetX, img.offsetY);
        return { x: pos.x, y: pos.y, w: img.width, h: img.height };
    }

    let selectedAnchor = $derived.by(() => {
        if (!selected || !rootEl) return null;
        void virtualizer?.scrollLeft; void virtualizer?.scrollTop;
        void sheetStore?.floatingImagesVersion;
        const r = rectFor(selected);
        const rootRect = rootEl.getBoundingClientRect();
        return { x: rootRect.left + r.x, y: rootRect.top + r.y, w: r.w, h: r.h };
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="floating-images-root"
    bind:this={rootEl}
    bind:clientWidth={rootW}
    bind:clientHeight={rootH}
    tabindex="-1"
    onkeydown={handleKeydown}
>
    <!-- Image pixels are painted here -->
    <canvas class="floating-images-canvas" bind:this={canvasEl}></canvas>

    <!-- Transparent interaction boxes (one per image) -->
    {#each images as img (img.id)}
        {@const pos = imageScreenPos(img.anchorRow, img.anchorCol, img.offsetX, img.offsetY)}
        {@const isSel = selectedId === img.id}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="floating-image"
            class:floating-image--selected={isSel}
            style="left:{Math.round(pos.x)}px; top:{Math.round(pos.y)}px; width:{img.width}px; height:{img.height}px;"
            onmousedown={(e) => startDrag(e, img.id, img)}
            onclick={(e) => { e.stopPropagation(); selectedId = img.id; }}
            title={img.alt || undefined}
            aria-label={img.alt || 'Floating image'}
        >
            {#if isSel}
                {#each ['nw','ne','sw','se'] as handle}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        class="floating-image__handle floating-image__handle--{handle}"
                        onmousedown={(e) => startResize(e, img.id, img, handle)}
                    ></div>
                {/each}
            {/if}
        </div>
    {/each}
</div>

<!-- Properties panel for the selected image (portals to <body>); hidden while
     dragging/resizing so it doesn't chase the image around. -->
{#if selected && selectedAnchor && !showReplace && !dragging && !resizing}
    <FloatingImagePanel
        img={selected}
        anchor={selectedAnchor}
        onUpdate={applyUpdate}
        onReplace={() => (showReplace = true)}
        onDelete={deleteSelected}
    />
{/if}

<!-- Replace flow: reuse the multi-source ImageEditor as a modal -->
{#if showReplace && selected}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="floating-replace" onmousedown={() => (showReplace = false)}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="floating-replace__dialog" onmousedown={(e) => e.stopPropagation()}>
            <h3 class="floating-replace__title">Replace Image</h3>
            <ImageEditor
                value={selected.blobId}
                {docId}
                onCommit={(blobId) => handleReplaceCommit(blobId)}
                onCancel={() => (showReplace = false)}
            />
        </div>
    </div>
{/if}

<style>
    .floating-images-root {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 15;
        overflow: hidden;
    }

    .floating-images-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
    }

    .floating-image {
        position: absolute;
        pointer-events: auto;
        cursor: move;
        user-select: none;
        border: 1px solid transparent;
        border-radius: 2px;
        background: transparent;
    }

    .floating-image--selected {
        border-color: #3b82f6;
        box-shadow: 0 0 0 1px #3b82f680;
        overflow: visible;
    }

    .floating-image__handle {
        position: absolute;
        width: 9px;
        height: 9px;
        background: #ffffff;
        border: 1.5px solid #3b82f6;
        border-radius: 2px;
        pointer-events: auto;
        z-index: 2;
    }

    .floating-image__handle--nw { top: -5px; left: -5px; cursor: nw-resize; }
    .floating-image__handle--ne { top: -5px; right: -5px; cursor: ne-resize; }
    .floating-image__handle--sw { bottom: -5px; left: -5px; cursor: sw-resize; }
    .floating-image__handle--se { bottom: -5px; right: -5px; cursor: se-resize; }

    .floating-replace {
        position: fixed;
        inset: 0;
        z-index: 900;
        background: rgba(15, 23, 42, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
    }

    .floating-replace__dialog {
        position: relative;
        background: var(--panel-bg, #fff);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.25);
        padding: 16px;
        width: 360px;
        max-width: 92vw;
    }

    .floating-replace__title {
        margin: 0 0 10px;
        font-size: 0.95rem;
        font-weight: 600;
        color: #1e293b;
    }

    /* The ImageEditor renders absolutely positioned; anchor it within the dialog. */
    .floating-replace__dialog :global(.image-editor) {
        position: relative;
        z-index: auto;
    }
</style>
