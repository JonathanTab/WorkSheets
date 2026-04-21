/**
 * SelectionRenderer - Paints selection fills and formula-reference highlights
 * onto a dedicated overlay canvas, separate from the data canvas.
 *
 * Separating selection from the data canvas means arrow-key navigation and
 * range-drag repaint only this lightweight canvas (~0.3ms) instead of
 * triggering a full buildPaneData + paintPane cycle (~6ms).
 *
 * ## Visual style (Google Sheets)
 *   - Selected cells:   light blue fill, thin blue border around each range rect
 *   - Primary cell:     no fill (white), 2px blue border inset
 *   - Formula refs:     colored stroke border per cell
 */

const SELECTION_FILL        = 'rgba(26, 115, 232, 0.12)';
const SELECTION_BORDER      = 'rgba(26, 115, 232, 0.8)';
const PRIMARY_CELL_BORDER   = '#1a73e8';

export class SelectionRenderer {
    /** @type {HTMLCanvasElement | null} */
    #canvas = null;

    /** @type {CanvasRenderingContext2D | null} */
    #ctx = null;

    /** @type {number} */
    #dpr = 1;

    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
        this.#canvas = canvas;
        if (canvas) this.#ctx = canvas.getContext('2d');
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * @param {number} cssWidth
     * @param {number} cssHeight
     * @param {number} [dpr]
     */
    resize(cssWidth, cssHeight, dpr) {
        this.#dpr = dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;
        if (!this.#canvas) return;
        const physW = Math.round(cssWidth * this.#dpr);
        const physH = Math.round(cssHeight * this.#dpr);
        if (this.#canvas.width  !== physW) this.#canvas.width  = physW;
        if (this.#canvas.height !== physH) this.#canvas.height = physH;
        if (this.#canvas instanceof HTMLCanvasElement) {
            this.#canvas.style.width  = cssWidth  + 'px';
            this.#canvas.style.height = cssHeight + 'px';
        }
    }

    clear() {
        if (!this.#ctx || !this.#canvas) return;
        this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    }

    destroy() {
        this.#canvas = null;
        this.#ctx = null;
    }

    // ─── Pane painting ────────────────────────────────────────────────────────

    /**
     * Paint selection fills, range borders, primary-cell border, and formula
     * highlights for one grid pane.
     *
     * @param {Object} params
     * @param {{start:number, end:number, count:number}} params.rowRange
     * @param {{start:number, end:number, count:number}} params.colRange
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} params.rowMetrics
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} params.colMetrics
     * @param {any} params.selectionState
     * @param {any} params.formulaEditState
     * @param {number} params.frozenRows
     * @param {number} params.frozenCols
     * @param {number} params.frozenHeight
     * @param {number} params.frozenWidth
     * @param {number} params.scrollLeft
     * @param {number} params.scrollTop
     * @param {number} params.rowCount
     * @param {number} params.colCount
     * @param {number} params.clipX
     * @param {number} params.clipY
     * @param {number} params.clipW
     * @param {number} params.clipH
     */
    paintSelectionPane(params) {
        const ctx = this.#ctx;
        if (!ctx) return;

        const { clipX, clipY, clipW, clipH } = params;
        if (clipW <= 0 || clipH <= 0) return;

        const {
            rowRange, colRange,
            rowMetrics, colMetrics,
            selectionState, formulaEditState,
            frozenRows, frozenCols,
            scrollLeft, scrollTop,
            rowCount, colCount,
        } = params;

        if (!rowRange || rowRange.count <= 0 || !colRange || colRange.count <= 0) return;

        const dpr = this.#dpr;

        ctx.save();
        ctx.scale(dpr, dpr);

        try {
            ctx.beginPath();
            ctx.rect(clipX, clipY, clipW, clipH);
            ctx.clip();

            // ── 1. Per-cell fills (skip primary cell) and formula borders ────
            for (let r = rowRange.start; r <= rowRange.end; r++) {
                const isFrozenRow = r < frozenRows;
                const y = isFrozenRow
                    ? rowMetrics.offsetOf(r)
                    : rowMetrics.offsetOf(r) - scrollTop;
                const h = rowMetrics.sizeOf(r);

                for (let c = colRange.start; c <= colRange.end; c++) {
                    const selected  = selectionState?.isSelected(r, c, rowCount, colCount) ?? false;
                    const isPrimary = selected && (selectionState?.isPrimaryCell(r, c) ?? false);
                    const hlColor   = formulaEditState?.getCellHighlightColor(r, c) ?? null;
                    if (!selected && !hlColor) continue;

                    const isFrozenCol = c < frozenCols;
                    const x = isFrozenCol
                        ? colMetrics.offsetOf(c)
                        : colMetrics.offsetOf(c) - scrollLeft;
                    const w = colMetrics.sizeOf(c);

                    if (selected && !isPrimary) {
                        ctx.fillStyle = SELECTION_FILL;
                        ctx.fillRect(x, y, w, h);
                    }

                    if (hlColor) {
                        ctx.strokeStyle = hlColor;
                        ctx.lineWidth = 2;
                        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
                    }
                }
            }

            // ── 2. Per-range border outlines ─────────────────────────────────
            const allRanges = selectionState?.allRanges ?? [];
            if (allRanges.length > 0) {
                ctx.strokeStyle = SELECTION_BORDER;
                ctx.lineWidth = 1;
                for (const range of allRanges) {
                    const rect = this.#rangePixelRect(
                        range, rowMetrics, colMetrics,
                        frozenRows, frozenCols, scrollTop, scrollLeft,
                    );
                    if (rect && rect.w > 0 && rect.h > 0) {
                        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
                    }
                }
            }

            // ── 3. Primary-cell border (2px, no fill) ────────────────────────
            const pc = selectionState?.primaryCell ?? selectionState?.anchor;
            if (pc) {
                const { row: pr, col: pc_ } = pc;
                if (pr >= rowRange.start && pr <= rowRange.end &&
                    pc_ >= colRange.start && pc_ <= colRange.end &&
                    (selectionState?.isSelected(pr, pc_, rowCount, colCount) ?? false)) {

                    const isFR = pr < frozenRows;
                    const iFC  = pc_ < frozenCols;
                    const x = iFC ? colMetrics.offsetOf(pc_) : colMetrics.offsetOf(pc_) - scrollLeft;
                    const y = isFR ? rowMetrics.offsetOf(pr) : rowMetrics.offsetOf(pr) - scrollTop;
                    const w = colMetrics.sizeOf(pc_) ?? 0;
                    const h = rowMetrics.sizeOf(pr) ?? 0;
                    if (w > 0 && h > 0) {
                        // Clear fill so primary cell appears white
                        ctx.clearRect(x, y, w, h);
                        ctx.strokeStyle = PRIMARY_CELL_BORDER;
                        ctx.lineWidth = 2;
                        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
                    }
                }
            }

        } finally {
            ctx.restore();
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Compute the pixel bounding rect for a cell range within this pane's
     * coordinate system.  Handles frozen/scrolled rows and cols independently.
     *
     * @param {{ startRow:number, endRow:number, startCol:number, endCol:number }} range
     * @param {any} rowMetrics
     * @param {any} colMetrics
     * @param {number} frozenRows
     * @param {number} frozenCols
     * @param {number} scrollTop
     * @param {number} scrollLeft
     * @returns {{ x:number, y:number, w:number, h:number } | null}
     */
    #rangePixelRect(range, rowMetrics, colMetrics, frozenRows, frozenCols, scrollTop, scrollLeft) {
        const sc = range.startCol; const ec = range.endCol;
        const sr = range.startRow; const er = range.endRow;
        const x1 = sc < frozenCols
            ? (colMetrics.offsetOf(sc) ?? 0)
            : (colMetrics.offsetOf(sc) ?? 0) - scrollLeft;
        const y1 = sr < frozenRows
            ? (rowMetrics.offsetOf(sr) ?? 0)
            : (rowMetrics.offsetOf(sr) ?? 0) - scrollTop;
        const x2 = ec < frozenCols
            ? (colMetrics.offsetOf(ec) ?? 0) + (colMetrics.sizeOf(ec) ?? 0)
            : (colMetrics.offsetOf(ec) ?? 0) + (colMetrics.sizeOf(ec) ?? 0) - scrollLeft;
        const y2 = er < frozenRows
            ? (rowMetrics.offsetOf(er) ?? 0) + (rowMetrics.sizeOf(er) ?? 0)
            : (rowMetrics.offsetOf(er) ?? 0) + (rowMetrics.sizeOf(er) ?? 0) - scrollTop;
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
}

export default SelectionRenderer;
