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
 *   - Formula refs:     one colored outline rect per unique referenced range
 *                       (not one per cell — ranges draw a single bounding box)
 */

const SELECTION_FILL        = 'rgba(26, 115, 232, 0.12)';
const SELECTION_BORDER      = 'rgba(26, 115, 232, 0.8)';
const PRIMARY_CELL_BORDER   = '#1a73e8';
const CUT_MARQUEE_COLOR     = '#1a73e8';

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
            // Size the CSS box from the rounded backing store so 1 backing px maps
            // to exactly 1 device px (no bilinear resample). Must match
            // CanvasRenderer.resize() so this overlay stays pixel-aligned with the
            // data canvas it sits on top of. See the detailed note there.
            this.#canvas.style.width  = (physW / this.#dpr) + 'px';
            this.#canvas.style.height = (physH / this.#dpr) + 'px';
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
     * @param {any} [params.mergeEngine]
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
            mergeEngine,
            frozenRows, frozenCols,
            scrollLeft, scrollTop,
            rowCount, colCount,
            cutMarquee,
        } = params;

        if (!rowRange || rowRange.count <= 0 || !colRange || colRange.count <= 0) return;

        const dpr = this.#dpr;

        ctx.save();
        ctx.scale(dpr, dpr);

        try {
            ctx.beginPath();
            ctx.rect(clipX, clipY, clipW, clipH);
            ctx.clip();

            // ── 1. Per-cell selection fills (skip primary cell) ───────────────
            for (let r = rowRange.start; r <= rowRange.end; r++) {
                const isFrozenRow = r < frozenRows;
                const y = isFrozenRow
                    ? rowMetrics.offsetOf(r)
                    : rowMetrics.offsetOf(r) - scrollTop;
                const h = rowMetrics.sizeOf(r);

                for (let c = colRange.start; c <= colRange.end; c++) {
                    // Shadow cells are never rendered independently — their primary
                    // paints the entire merge area.
                    if (mergeEngine?.isMergeCell(r, c) && !mergeEngine.isMergePrimary(r, c)) continue;

                    const selected  = selectionState?.isSelected(r, c, rowCount, colCount) ?? false;
                    const isPrimary = selected && (selectionState?.isPrimaryCell(r, c) ?? false);
                    if (!selected || isPrimary) continue;

                    const isFrozenCol = c < frozenCols;
                    const x = isFrozenCol
                        ? colMetrics.offsetOf(c)
                        : colMetrics.offsetOf(c) - scrollLeft;

                    let w = colMetrics.sizeOf(c);
                    let cellH = h;
                    if (mergeEngine?.isMergePrimary(r, c)) {
                        const merge = mergeEngine.getMergeAt(r, c);
                        if (merge) {
                            if (merge.endCol > c) {
                                const isFCEnd = merge.endCol < frozenCols;
                                const x2 = isFCEnd
                                    ? colMetrics.offsetOf(merge.endCol) + colMetrics.sizeOf(merge.endCol)
                                    : colMetrics.offsetOf(merge.endCol) + colMetrics.sizeOf(merge.endCol) - scrollLeft;
                                w = x2 - x;
                            }
                            if (merge.endRow > r) {
                                const isFREnd = merge.endRow < frozenRows;
                                const y2 = isFREnd
                                    ? rowMetrics.offsetOf(merge.endRow) + rowMetrics.sizeOf(merge.endRow)
                                    : rowMetrics.offsetOf(merge.endRow) + rowMetrics.sizeOf(merge.endRow) - scrollTop;
                                cellH = y2 - y;
                            }
                        }
                    }

                    ctx.fillStyle = SELECTION_FILL;
                    ctx.fillRect(x, y, w, cellH);
                }
            }

            // ── 2. Per-range selection border outlines ────────────────────────
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

            // ── 3. Formula ref highlights — one rect per unique range ─────────
            // One descriptor per unique ref string: one outline box per range,
            // never one per cell. Merges within the ref rect are expanded out.
            const refHighlights = formulaEditState?.rangeHighlights ?? [];
            for (const hl of refHighlights) {
                if (hl.sheetName !== null) continue; // cross-sheet: skip on this sheet

                const expanded = mergeEngine ? mergeEngine.expandRange(hl) : hl;

                const rect = this.#rangePixelRect(
                    { startRow: expanded.startRow, endRow: expanded.endRow,
                      startCol: expanded.startCol, endCol: expanded.endCol },
                    rowMetrics, colMetrics,
                    frozenRows, frozenCols, scrollTop, scrollLeft,
                );
                if (!rect || rect.w <= 0 || rect.h <= 0) continue;

                ctx.strokeStyle = hl.color;
                ctx.lineWidth = 2;
                ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
            }

            // ── 4. Primary-cell border (2px, no fill) — spans full merge ──────
            const pc = selectionState?.primaryCell ?? selectionState?.anchor;
            if (pc) {
                const { row: pr, col: pc_ } = pc;
                if (pr >= rowRange.start && pr <= rowRange.end &&
                    pc_ >= colRange.start && pc_ <= colRange.end &&
                    (selectionState?.isSelected(pr, pc_, rowCount, colCount) ?? false)) {

                    let rect = null;
                    if (mergeEngine) {
                        const merge = mergeEngine.getMergeAt(pr, pc_);
                        if (merge) {
                            rect = this.#rangePixelRect(
                                { startRow: merge.startRow, endRow: merge.endRow,
                                  startCol: merge.startCol, endCol: merge.endCol },
                                rowMetrics, colMetrics, frozenRows, frozenCols, scrollTop, scrollLeft,
                            );
                        }
                    }
                    if (!rect) {
                        const isFR = pr < frozenRows;
                        const iFC  = pc_ < frozenCols;
                        rect = {
                            x: iFC ? colMetrics.offsetOf(pc_) : colMetrics.offsetOf(pc_) - scrollLeft,
                            y: isFR ? rowMetrics.offsetOf(pr)  : rowMetrics.offsetOf(pr)  - scrollTop,
                            w: colMetrics.sizeOf(pc_) ?? 0,
                            h: rowMetrics.sizeOf(pr)  ?? 0,
                        };
                    }
                    if (rect.w > 0 && rect.h > 0) {
                        ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
                        ctx.strokeStyle = PRIMARY_CELL_BORDER;
                        ctx.lineWidth = 2;
                        ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
                    }
                }
            }

            // ── 5. Cut marquee (marching ants) — dashed animated outline ──────
            if (cutMarquee?.ranges?.length) {
                ctx.strokeStyle = CUT_MARQUEE_COLOR;
                ctx.lineWidth = 1;
                ctx.setLineDash([5, 3]);
                ctx.lineDashOffset = cutMarquee.dashOffset || 0;
                for (const range of cutMarquee.ranges) {
                    const rect = this.#rangePixelRect(
                        range, rowMetrics, colMetrics,
                        frozenRows, frozenCols, scrollTop, scrollLeft,
                    );
                    if (rect && rect.w > 0 && rect.h > 0) {
                        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
                    }
                }
                ctx.setLineDash([]);
                ctx.lineDashOffset = 0;
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
