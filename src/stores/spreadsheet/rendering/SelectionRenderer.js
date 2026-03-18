/**
 * SelectionRenderer - Paints selection fills and formula-reference highlights
 * onto a dedicated overlay canvas, separate from the data canvas.
 *
 * Separating selection from the data canvas means arrow-key navigation and
 * range-drag repaint only this lightweight canvas (~0.3ms) instead of
 * triggering a full buildPaneData + paintPane cycle (~6ms).
 *
 * ## What it paints
 *   - Semi-transparent blue fill on selected cells
 *   - Colored stroke border on formula-reference-highlighted cells
 *
 * ## What it does NOT paint
 *   - Cell backgrounds, text, borders, gridlines — those stay on the data canvas
 */

const SELECTION_FILL = 'rgba(59, 130, 246, 0.08)';

export class SelectionRenderer {
    /** @type {HTMLCanvasElement | null} */
    #canvas = null;

    /** @type {CanvasRenderingContext2D | null} */
    #ctx = null;

    /** @type {number} */
    #dpr = 1;

    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this.#canvas = canvas;
        if (canvas) {
            this.#ctx = canvas.getContext('2d');
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Resize the canvas backing store. Call on mount, container resize, or DPR change.
     * @param {number} cssWidth
     * @param {number} cssHeight
     * @param {number} [dpr]
     */
    resize(cssWidth, cssHeight, dpr) {
        this.#dpr = dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;
        if (!this.#canvas) return;

        const physW = Math.round(cssWidth * this.#dpr);
        const physH = Math.round(cssHeight * this.#dpr);
        if (this.#canvas.width !== physW) this.#canvas.width = physW;
        if (this.#canvas.height !== physH) this.#canvas.height = physH;

        if (this.#canvas instanceof HTMLCanvasElement) {
            this.#canvas.style.width = cssWidth + 'px';
            this.#canvas.style.height = cssHeight + 'px';
        }
    }

    /**
     * Clear the entire selection canvas (called once before painting all panes).
     */
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
     * Paint selection fills and formula highlights for one grid pane.
     * Much cheaper than a full buildPaneData + paintPane — no data lookups,
     * just geometry + two canvas ops per selected cell.
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
            frozenHeight, frozenWidth,
            scrollLeft, scrollTop,
            rowCount, colCount,
        } = params;

        if (!rowRange || rowRange.count <= 0 || !colRange || colRange.count <= 0) return;

        const dpr = this.#dpr;

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.beginPath();
        ctx.rect(clipX, clipY, clipW, clipH);
        ctx.clip();

        for (let r = rowRange.start; r <= rowRange.end; r++) {
            const isFrozenRow = r < frozenRows;
            const y = isFrozenRow
                ? rowMetrics.offsetOf(r)
                : rowMetrics.offsetOf(r) - scrollTop + frozenHeight;
            const h = rowMetrics.sizeOf(r);

            for (let c = colRange.start; c <= colRange.end; c++) {
                // Check selection and formula highlight before computing x (early-exit
                // skips coordinate math for the common case of unselected empty cells).
                const selected = selectionState?.isSelected(r, c, rowCount, colCount) ?? false;
                const hlColor = formulaEditState?.getCellHighlightColor(r, c) ?? null;
                if (!selected && !hlColor) continue;

                const isFrozenCol = c < frozenCols;
                const x = isFrozenCol
                    ? colMetrics.offsetOf(c)
                    : colMetrics.offsetOf(c) - scrollLeft + frozenWidth;
                const w = colMetrics.sizeOf(c);

                if (selected) {
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

        ctx.restore();
    }
}

export default SelectionRenderer;
