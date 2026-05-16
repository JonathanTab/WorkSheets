<script>
    /**
     * FloatingImages - Over-grid floating image layer.
     *
     * Renders floating images anchored to grid cells. Images scroll with the
     * grid (anchored to cell), can be dragged to move, and resized via corner handles.
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
     *   { blobId, anchorRow, anchorCol, offsetX, offsetY, width, height, fit }
     */
    import { onDestroy } from 'svelte';
    import storage from '../../stores/storage.js';

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

    // ── Helpers: grid coordinates ─────────────────────────────────────────────

    /**
     * Convert grid cell + offset to canvas-relative CSS px.
     * @param {number} anchorRow
     * @param {number} anchorCol
     * @param {number} offsetX
     * @param {number} offsetY
     * @returns {{ x: number, y: number }}
     */
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

    /**
     * Convert a container-relative screen position to the nearest cell anchor + offset.
     * @param {number} screenX
     * @param {number} screenY
     * @returns {{ anchorRow: number, anchorCol: number, offsetX: number, offsetY: number }}
     */
    function screenPosToAnchor(screenX, screenY) {
        if (!virtualizer) return { anchorRow: 0, anchorCol: 0, offsetX: screenX - headerWidth, offsetY: screenY - headerHeight };

        // Determine the logical (document) coordinate at this screen position
        let logicalX = screenX - headerWidth;
        let logicalY = screenY - headerHeight;

        // In the scrollable region, add back the scroll offset
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

    // ── Drag handling ─────────────────────────────────────────────────────────

    function startDrag(e, id, img) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        selectedId = id;
        dragging = {
            id,
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            startOffsetX: img.offsetX,
            startOffsetY: img.offsetY,
            anchorRow: img.anchorRow,
            anchorCol: img.anchorCol,
        };
        document.addEventListener('mousemove', handleDragMove);
        document.addEventListener('mouseup', handleDragEnd);
    }

    function handleDragMove(e) {
        if (!dragging || !sheetStore) return;
        const dx = e.clientX - dragging.startMouseX;
        const dy = e.clientY - dragging.startMouseY;

        // Compute current screen position of anchor
        const anchorPos = imageScreenPos(dragging.anchorRow, dragging.anchorCol, dragging.startOffsetX, dragging.startOffsetY);
        const newScreenX = anchorPos.x + dx;
        const newScreenY = anchorPos.y + dy;

        // Re-anchor to closest cell
        const anchor = screenPosToAnchor(newScreenX, newScreenY);
        sheetStore.updateFloatingImage(dragging.id, {
            anchorRow: anchor.anchorRow,
            anchorCol: anchor.anchorCol,
            offsetX: anchor.offsetX,
            offsetY: anchor.offsetY,
        });
    }

    function handleDragEnd(e) {
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
            id,
            handle,
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            startW: img.width,
            startH: img.height,
            startOffsetX: img.offsetX,
            startOffsetY: img.offsetY,
            anchorRow: img.anchorRow,
            anchorCol: img.anchorCol,
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
        let extraOffX = 0;
        let extraOffY = 0;

        if (handle === 'se') {
            newW = Math.max(40, resizing.startW + dx);
            newH = Math.max(40, resizing.startH + dy);
        } else if (handle === 'sw') {
            newW = Math.max(40, resizing.startW - dx);
            newH = Math.max(40, resizing.startH + dy);
            extraOffX = dx;
        } else if (handle === 'ne') {
            newW = Math.max(40, resizing.startW + dx);
            newH = Math.max(40, resizing.startH - dy);
            extraOffY = dy;
        } else if (handle === 'nw') {
            newW = Math.max(40, resizing.startW - dx);
            newH = Math.max(40, resizing.startH - dy);
            extraOffX = dx;
            extraOffY = dy;
        }

        const newOffX = resizing.startOffsetX + (handle.includes('w') ? Math.min(dx, resizing.startW - 40) : 0);
        const newOffY = resizing.startOffsetY + (handle.includes('n') ? Math.min(dy, resizing.startH - 40) : 0);

        sheetStore.updateFloatingImage(resizing.id, {
            width: Math.round(newW),
            height: Math.round(newH),
            offsetX: Math.round(newOffX),
            offsetY: Math.round(newOffY),
        });
    }

    function handleResizeEnd() {
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
        resizing = null;
    }

    // ── Delete selected ───────────────────────────────────────────────────────

    function handleKeydown(e) {
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
            sheetStore?.removeFloatingImage(selectedId);
            selectedId = null;
            e.preventDefault();
        } else if (e.key === 'Escape') {
            selectedId = null;
        }
    }

    // Deselect when clicking outside any floating image
    function handleDocMousedown(e) {
        if (!selectedId) return;
        if (e.target.closest?.('.floating-image')) return;
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

    // ── Reactive image list ───────────────────────────────────────────────────

    let images = $derived.by(() => {
        if (!sheetStore) return [];
        // Depend on version to trigger re-render on any change
        const _v = sheetStore.floatingImagesVersion;
        return [...(sheetStore.floatingImages?.values() ?? [])];
    });

    // Build position for each image, incorporating live drag/resize updates
    function getStyle(img) {
        const pos = imageScreenPos(img.anchorRow, img.anchorCol, img.offsetX, img.offsetY);
        return [
            `left:${Math.round(pos.x)}px`,
            `top:${Math.round(pos.y)}px`,
            `width:${img.width}px`,
            `height:${img.height}px`,
        ].join(';');
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="floating-images-root"
    tabindex="-1"
    onkeydown={handleKeydown}
>
    {#each images as img (img.id)}
        {@const selected = selectedId === img.id}
        {@const imgUrl = storage.app.getBlobUrl(img.blobId)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="floating-image"
            class:floating-image--selected={selected}
            style={getStyle(img)}
            onmousedown={(e) => startDrag(e, img.id, img)}
            onclick={(e) => { e.stopPropagation(); selectedId = img.id; }}
        >
            <img
                src={imgUrl}
                alt="Floating image"
                class="floating-image__img"
                style="object-fit: {img.fit ?? 'contain'};"
                draggable="false"
            />

            {#if selected}
                <!-- Corner resize handles -->
                {#each ['nw','ne','sw','se'] as handle}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        class="floating-image__handle floating-image__handle--{handle}"
                        onmousedown={(e) => startResize(e, img.id, img, handle)}
                    ></div>
                {/each}

                <!-- Delete button -->
                <button
                    class="floating-image__delete"
                    onclick={(e) => { e.stopPropagation(); sheetStore?.removeFloatingImage(img.id); selectedId = null; }}
                    title="Delete image"
                    aria-label="Delete floating image"
                >✕</button>
            {/if}
        </div>
    {/each}
</div>

<style>
    .floating-images-root {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 15;
        overflow: hidden;
    }

    .floating-image {
        position: absolute;
        pointer-events: auto;
        cursor: move;
        user-select: none;
        border: 1px solid transparent;
        border-radius: 2px;
        overflow: hidden;
        transition: box-shadow 0.1s;
    }

    .floating-image--selected {
        border-color: #3b82f6;
        box-shadow: 0 0 0 1px #3b82f680;
        overflow: visible;
    }

    .floating-image__img {
        width: 100%;
        height: 100%;
        display: block;
        pointer-events: none;
    }

    /* Corner resize handles */
    .floating-image__handle {
        position: absolute;
        width: 8px;
        height: 8px;
        background: #ffffff;
        border: 1.5px solid #3b82f6;
        border-radius: 2px;
        pointer-events: auto;
        z-index: 2;
    }

    .floating-image__handle--nw { top: -4px; left: -4px; cursor: nw-resize; }
    .floating-image__handle--ne { top: -4px; right: -4px; cursor: ne-resize; }
    .floating-image__handle--sw { bottom: -4px; left: -4px; cursor: sw-resize; }
    .floating-image__handle--se { bottom: -4px; right: -4px; cursor: se-resize; }

    .floating-image__delete {
        position: absolute;
        top: -10px;
        right: -10px;
        width: 20px;
        height: 20px;
        background: #ef4444;
        color: #fff;
        border: none;
        border-radius: 50%;
        font-size: 10px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        pointer-events: auto;
        z-index: 3;
    }

    .floating-image__delete:hover {
        background: #dc2626;
    }
</style>
