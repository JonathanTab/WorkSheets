<script>
    /**
     * ViewPlacementOverlay — grid overlay for positioning a view by clicking.
     *
     * Sits at z-index:20 inside the grid-root div, covering the full grid
     * including headers. Converts mouse position to (row, col) using the
     * virtualizer's AxisMetrics, compensating for scroll and header offsets.
     *
     * Interaction modes:
     *   1. Move mouse   → live cell highlight + cell-ref tooltip
     *   2. Click cell   → confirms placement
     *   3. Type in ref  → live-parse A1-style input, Enter to confirm
     *   4. ESC / Cancel → calls viewPlacementStore.cancel()
     */

    import { onMount } from 'svelte';
    import { viewPlacementStore } from '../../../stores/spreadsheet/viewPlacementStore.svelte.js';
    import { HEADER_WIDTH, HEADER_HEIGHT } from '../../../stores/spreadsheetStore.svelte.js';

    /** @type {{ rowMetrics: any, colMetrics: any, scrollLeft: number, scrollTop: number }} */
    let { virtualizer } = $props();

    let overlayEl = $state(/** @type {HTMLDivElement|null} */ (null));
    let hoveredRow = $state(-1);
    let hoveredCol = $state(-1);
    let cellRef    = $state('');
    let refInputEl = $state(/** @type {HTMLInputElement|null} */ (null));
    let refError   = $state(false);

    // ── Coordinate conversion ────────────────────────────────────────────────

    function mouseToCellContent(mouseX, mouseY) {
        // mouseX/Y are relative to the grid-root top-left
        const contentX = mouseX - HEADER_WIDTH + virtualizer.scrollLeft;
        const contentY = mouseY - HEADER_HEIGHT + virtualizer.scrollTop;
        if (contentX < 0 || contentY < 0) return null;
        return {
            row: virtualizer.rowMetrics.indexAtOffset(contentY),
            col: virtualizer.colMetrics.indexAtOffset(contentX),
        };
    }

    function cellToPixel(row, col) {
        // Returns top-left pixel in grid-root coordinates
        const x = HEADER_WIDTH + virtualizer.colMetrics.offsetOf(col) - virtualizer.scrollLeft;
        const y = HEADER_HEIGHT + virtualizer.rowMetrics.offsetOf(row) - virtualizer.scrollTop;
        return { x, y };
    }

    // ── A1-style cell reference helpers ─────────────────────────────────────

    function toRef(row, col) {
        if (row < 0 || col < 0) return '';
        let colStr = '';
        let c = col + 1;
        while (c > 0) {
            colStr = String.fromCharCode(64 + ((c - 1) % 26 + 1)) + colStr;
            c = Math.floor((c - 1) / 26);
        }
        return colStr + (row + 1);
    }

    function parseRef(ref) {
        const m = ref.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
        if (!m) return null;
        let col = 0;
        for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        return { row: parseInt(m[2], 10) - 1, col: col - 1 };
    }

    // ── Mouse event handlers ──────────────────────────────────────────────────

    function handleMouseMove(e) {
        const rect = overlayEl?.getBoundingClientRect();
        if (!rect) return;
        const pos = mouseToCellContent(e.clientX - rect.left, e.clientY - rect.top);
        if (!pos) return;
        hoveredRow = pos.row;
        hoveredCol = pos.col;
        cellRef    = toRef(pos.row, pos.col);
        refError   = false;
    }

    function handleMouseLeave() {
        hoveredRow = -1;
        hoveredCol = -1;
    }

    function handleClick(e) {
        // Ignore clicks on the banner toolbar itself
        if (/** @type {Element} */ (e.target)?.closest('.placement-banner')) return;
        const rect = overlayEl?.getBoundingClientRect();
        if (!rect) return;
        const pos = mouseToCellContent(e.clientX - rect.left, e.clientY - rect.top);
        if (pos) viewPlacementStore.place(pos.row, pos.col);
    }

    // ── Keyboard / ref input ─────────────────────────────────────────────────

    function handleOverlayKeydown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            viewPlacementStore.cancel();
        }
    }

    function handleRefInput(e) {
        cellRef  = /** @type {HTMLInputElement} */ (e.target).value;
        refError = false;
        const parsed = parseRef(cellRef);
        if (parsed) {
            hoveredRow = parsed.row;
            hoveredCol = parsed.col;
        } else {
            hoveredRow = -1;
            hoveredCol = -1;
        }
    }

    function handleRefKeydown(e) {
        e.stopPropagation();
        if (e.key === 'Enter') {
            const parsed = parseRef(cellRef);
            if (parsed) {
                viewPlacementStore.place(parsed.row, parsed.col);
            } else {
                refError = true;
            }
        } else if (e.key === 'Escape') {
            viewPlacementStore.cancel();
        }
    }

    function confirmFromInput() {
        const parsed = parseRef(cellRef);
        if (parsed) {
            viewPlacementStore.place(parsed.row, parsed.col);
        } else {
            refError = true;
        }
    }

    // ── Highlight geometry ────────────────────────────────────────────────────

    // Show a 5-col × 4-row ghost rectangle to hint at where the table would land
    const GHOST_COLS = 5;
    const GHOST_ROWS = 4;

    let highlightStyle = $derived.by(() => {
        if (hoveredRow < 0 || hoveredCol < 0 || !virtualizer) return null;
        const { x, y } = cellToPixel(hoveredRow, hoveredCol);

        // Width: sum GHOST_COLS columns
        let w = 0;
        const totalCols = virtualizer.colMetrics.count ?? 999;
        for (let i = 0; i < GHOST_COLS && hoveredCol + i < totalCols; i++) {
            w += virtualizer.colMetrics.sizeOf(hoveredCol + i);
        }

        // Height: sum GHOST_ROWS rows
        let h = 0;
        const totalRows = virtualizer.rowMetrics.count ?? 9999;
        for (let i = 0; i < GHOST_ROWS && hoveredRow + i < totalRows; i++) {
            h += virtualizer.rowMetrics.sizeOf(hoveredRow + i);
        }

        return { x, y, w, h };
    });

    onMount(() => {
        // Focus the overlay so ESC works immediately without extra click
        overlayEl?.focus();
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    bind:this={overlayEl}
    class="placement-overlay"
    onmousemove={handleMouseMove}
    onmouseleave={handleMouseLeave}
    onclick={handleClick}
    onkeydown={handleOverlayKeydown}
    tabindex="-1"
    role="application"
    aria-label="View placement mode. Click to position the view."
>
    <!-- ── Ghost rectangle ──────────────────────────────────────────────── -->
    {#if highlightStyle}
        <div
            class="ghost-rect"
            style="
                left: {highlightStyle.x}px;
                top:  {highlightStyle.y}px;
                width: {highlightStyle.w}px;
                height: {highlightStyle.h}px;
            "
        >
            <!-- Header row highlight -->
            <div class="ghost-header" style="height: {virtualizer.rowMetrics.sizeOf(hoveredRow)}px"></div>
        </div>

        <!-- Cell-ref label at the top-right of ghost -->
        <div
            class="cell-label"
            style="left: {highlightStyle.x + highlightStyle.w + 6}px; top: {highlightStyle.y}px;"
        >
            {toRef(hoveredRow, hoveredCol)}
        </div>
    {/if}

    <!-- ── Banner ───────────────────────────────────────────────────────── -->
    <div class="placement-banner">
        <div class="banner-icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                <circle cx="12" cy="10" r="3"/>
            </svg>
        </div>
        <span class="banner-label">Placing <strong>{viewPlacementStore.viewName}</strong></span>
        <span class="banner-sep">—</span>
        <span class="banner-hint">click the grid to set position</span>

        <!-- Cell ref input -->
        <div class="ref-input-wrap" class:error={refError}>
            <input
                bind:this={refInputEl}
                class="ref-input"
                type="text"
                value={cellRef}
                placeholder="B3"
                oninput={handleRefInput}
                onkeydown={handleRefKeydown}
                title="Type a cell reference (e.g. B3) and press Enter"
                aria-label="Cell position"
                spellcheck="false"
            />
        </div>
        <button class="banner-go-btn" onclick={confirmFromInput}>
            Place here
        </button>
        <button class="banner-cancel" onclick={() => viewPlacementStore.cancel()}>
            ESC
        </button>
    </div>
</div>

<style>
    .placement-overlay {
        position: absolute;
        inset: 0;
        z-index: 20;
        cursor: crosshair;
        outline: none;

        /* Very light tint so grid content is still readable */
        background: rgba(59, 130, 246, 0.04);
    }

    /* ── Ghost rectangle ─────────────────────────────────────────────────── */
    .ghost-rect {
        position: absolute;
        pointer-events: none;
        border: 2px solid #3b82f6;
        border-radius: 3px;
        background: rgba(59, 130, 246, 0.08);
        box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.2);
        transition: left 0.04s, top 0.04s, width 0.04s, height 0.04s;
    }

    .ghost-header {
        width: 100%;
        background: rgba(59, 130, 246, 0.18);
        border-bottom: 1px dashed rgba(59, 130, 246, 0.5);
    }

    /* ── Cell label ──────────────────────────────────────────────────────── */
    .cell-label {
        position: absolute;
        pointer-events: none;
        background: #1e3a5f;
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 4px;
        white-space: nowrap;
        font-family: monospace;
        box-shadow: 0 1px 4px rgba(0,0,0,0.25);
        transition: left 0.04s, top 0.04s;
    }

    /* ── Banner ──────────────────────────────────────────────────────────── */
    .placement-banner {
        position: absolute;
        top: 6px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 21;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px 7px 10px;
        background: #1e3a5f;
        color: #e2e8f0;
        border-radius: 20px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255,255,255,0.1);
        font-size: 12px;
        white-space: nowrap;
        user-select: none;
        cursor: default;
    }

    .banner-icon {
        display: flex;
        align-items: center;
        color: #60a5fa;
    }

    .banner-label {
        color: #cbd5e1;
    }
    .banner-label strong {
        color: #fff;
        font-weight: 700;
    }

    .banner-sep { color: #475569; }

    .banner-hint { color: #94a3b8; font-size: 11px; }

    /* ── Ref input ───────────────────────────────────────────────────────── */
    .ref-input-wrap {
        background: rgba(255,255,255,0.1);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 6px;
        padding: 1px;
        transition: border-color 0.15s;
    }
    .ref-input-wrap.error { border-color: #f87171; }

    .ref-input {
        width: 46px;
        height: 24px;
        background: transparent;
        border: none;
        outline: none;
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        font-family: monospace;
        text-align: center;
        padding: 0 4px;
        text-transform: uppercase;
    }
    .ref-input::placeholder { color: #64748b; }

    /* ── Action buttons ──────────────────────────────────────────────────── */
    .banner-go-btn {
        height: 26px;
        padding: 0 10px;
        background: #3b82f6;
        border: none;
        border-radius: 12px;
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.1s;
        white-space: nowrap;
    }
    .banner-go-btn:hover { background: #2563eb; }

    .banner-cancel {
        height: 24px;
        padding: 0 8px;
        background: rgba(255,255,255,0.1);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 10px;
        color: #94a3b8;
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: background 0.1s;
    }
    .banner-cancel:hover { background: rgba(255,255,255,0.18); color: #e2e8f0; }
</style>
