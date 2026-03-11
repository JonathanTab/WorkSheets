/**
 * HitTestEngine - Maps pixel coordinates to cell (row, col) and UI region.
 *
 * Accounts for frozen panes, column/row headers, scroll offsets, and resize zones.
 * All input coordinates are relative to the grid container's top-left corner.
 */
import { HEADER_WIDTH, HEADER_HEIGHT } from '../constants.js';

/** Pixels from a column/row boundary that triggers the resize cursor */
const RESIZE_ZONE_PX = 4;

export class HitTestEngine {
    /** @type {import('../virtualization/GridVirtualizer.svelte.js').GridVirtualizer | null} */
    #virtualizer = null;

    /**
     * @param {import('../virtualization/GridVirtualizer.svelte.js').GridVirtualizer} virtualizer
     */
    setVirtualizer(virtualizer) {
        this.#virtualizer = virtualizer;
    }

    /**
     * Perform a hit test at the given container-relative coordinates.
     *
     * @param {number} localX  X relative to grid container left edge
     * @param {number} localY  Y relative to grid container top edge
     * @returns {{
     *   row: number,
     *   col: number,
     *   region: 'cell'|'colHeader'|'rowHeader'|'corner'|'colResize'|'rowResize'|null,
     *   pane: 'body'|'top'|'left'|'corner'|null,
     *   resizeCol?: number,
     *   resizeRow?: number
     * }}
     */
    hitTest(localX, localY) {
        const v = this.#virtualizer;
        if (!v) return { row: -1, col: -1, region: null, pane: null };

        const frozenH = v.frozenHeight;
        const frozenW = v.frozenWidth;

        // ── Corner ───────────────────────────────────────────────────────────
        if (localX < HEADER_WIDTH && localY < HEADER_HEIGHT) {
            return { row: -1, col: -1, region: 'corner', pane: null };
        }

        // ── Column header row ─────────────────────────────────────────────────
        if (localY < HEADER_HEIGHT) {
            const contentX = localX - HEADER_WIDTH;
            const col = this.#resolveCol(contentX, frozenW, v);
            const resizeCol = this.#checkColResize(contentX, frozenW, v);
            return {
                row: -1,
                col,
                region: resizeCol !== null ? 'colResize' : 'colHeader',
                pane: null,
                resizeCol: resizeCol ?? undefined,
            };
        }

        // ── Row header column ─────────────────────────────────────────────────
        if (localX < HEADER_WIDTH) {
            const contentY = localY - HEADER_HEIGHT;
            const row = this.#resolveRow(contentY, frozenH, v);
            const resizeRow = this.#checkRowResize(contentY, frozenH, v);
            return {
                row,
                col: -1,
                region: resizeRow !== null ? 'rowResize' : 'rowHeader',
                pane: null,
                resizeRow: resizeRow ?? undefined,
            };
        }

        // ── Cell area ─────────────────────────────────────────────────────────
        const contentX = localX - HEADER_WIDTH;
        const contentY = localY - HEADER_HEIGHT;

        const col = this.#resolveCol(contentX, frozenW, v);
        const row = this.#resolveRow(contentY, frozenH, v);

        const inFrozenX = frozenW > 0 && contentX < frozenW;
        const inFrozenY = frozenH > 0 && contentY < frozenH;

        let pane = 'body';
        if (inFrozenX && inFrozenY) pane = 'corner';
        else if (inFrozenY) pane = 'top';
        else if (inFrozenX) pane = 'left';

        return { row, col, region: 'cell', pane };
    }

    /**
     * Get the CSS cursor string for a hit test result.
     * @param {{ region: string|null }} hitResult
     * @returns {string}
     */
    getCursor(hitResult) {
        switch (hitResult?.region) {
            case 'colResize': return 'col-resize';
            case 'rowResize': return 'row-resize';
            case 'colHeader':
            case 'rowHeader':
            case 'corner': return 'pointer';
            case 'cell': return 'cell';
            default: return 'default';
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Resolve column index from content-area X (relative to left edge of cell area).
     */
    #resolveCol(contentX, frozenW, v) {
        const rowMetrics = v.colMetrics;
        if (frozenW > 0 && contentX < frozenW) {
            // In frozen columns
            return rowMetrics.indexAtOffset(contentX);
        }
        // In scrollable columns — adjust for frozen width and scroll
        const scrollableX = contentX - frozenW + v.scrollLeft;
        let col = rowMetrics.indexAtOffset(Math.max(0, scrollableX));
        if (col < v.frozenCols) col = v.frozenCols;
        return Math.min(col, v.colCount - 1);
    }

    /**
     * Resolve row index from content-area Y (relative to top edge of cell area).
     */
    #resolveRow(contentY, frozenH, v) {
        const rowMetrics = v.rowMetrics;
        if (frozenH > 0 && contentY < frozenH) {
            // In frozen rows
            return rowMetrics.indexAtOffset(contentY);
        }
        // In scrollable rows — adjust for frozen height and scroll
        const scrollableY = contentY - frozenH + v.scrollTop;
        let row = rowMetrics.indexAtOffset(Math.max(0, scrollableY));
        if (row < v.frozenRows) row = v.frozenRows;
        return Math.min(row, v.rowCount - 1);
    }

    /**
     * Check if content-area X is within RESIZE_ZONE_PX of a column's right edge.
     * Returns the column index if so, null otherwise.
     * @returns {number|null}
     */
    #checkColResize(contentX, frozenW, v) {
        // Determine the effective column at this X
        const col = this.#resolveCol(contentX, frozenW, v);
        if (col < 0) return null;

        // Screen X of this column's right edge
        const colRightOffset = v.colMetrics.offsetOf(col + 1);
        let screenRightX;
        if (col < v.frozenCols) {
            screenRightX = colRightOffset; // frozen — no scroll adjustment
        } else {
            screenRightX = frozenW + colRightOffset - v.scrollLeft;
        }

        if (Math.abs(contentX - screenRightX) <= RESIZE_ZONE_PX) {
            return col;
        }

        // Also check the previous column's right edge (for the left side of the zone)
        if (col > 0) {
            const prevCol = col - 1;
            const prevRightOffset = v.colMetrics.offsetOf(prevCol + 1);
            let prevScreenX;
            if (prevCol < v.frozenCols) {
                prevScreenX = prevRightOffset;
            } else {
                prevScreenX = frozenW + prevRightOffset - v.scrollLeft;
            }
            if (Math.abs(contentX - prevScreenX) <= RESIZE_ZONE_PX) {
                return prevCol;
            }
        }

        return null;
    }

    /**
     * Check if content-area Y is within RESIZE_ZONE_PX of a row's bottom edge.
     * Returns the row index if so, null otherwise.
     * @returns {number|null}
     */
    #checkRowResize(contentY, frozenH, v) {
        const row = this.#resolveRow(contentY, frozenH, v);
        if (row < 0) return null;

        const rowBottomOffset = v.rowMetrics.offsetOf(row + 1);
        let screenBottomY;
        if (row < v.frozenRows) {
            screenBottomY = rowBottomOffset;
        } else {
            screenBottomY = frozenH + rowBottomOffset - v.scrollTop;
        }

        if (Math.abs(contentY - screenBottomY) <= RESIZE_ZONE_PX) {
            return row;
        }

        if (row > 0) {
            const prevRow = row - 1;
            const prevBottomOffset = v.rowMetrics.offsetOf(prevRow + 1);
            let prevScreenY;
            if (prevRow < v.frozenRows) {
                prevScreenY = prevBottomOffset;
            } else {
                prevScreenY = frozenH + prevBottomOffset - v.scrollTop;
            }
            if (Math.abs(contentY - prevScreenY) <= RESIZE_ZONE_PX) {
                return prevRow;
            }
        }

        return null;
    }
}

export default HitTestEngine;
