/**
 * GridVirtualizer - Four-Pane Render Plan Engine
 *
 * Computes render plans for a grid with frozen panes.
 * Creates four distinct panes: corner, top, left, and body.
 * Each pane has its own coordinate space and scroll behavior.
 *
 * ## Architecture
 * - Uses two AxisMetrics instances (rows and cols)
 * - Computes visible ranges for each pane
 * - Outputs a complete GridRenderPlan
 *
 * ## Scroll Behavior
 * - corner: No scrolling (fixed at origin)
 * - top: Horizontal scroll only
 * - left: Vertical scroll only
 * - body: Both horizontal and vertical scroll
 */
import { AxisMetrics } from './AxisMetrics.svelte.js';
import {
    createAxisRange,
    emptyAxisRange,
    emptyPanePlan,
    PANE
} from './types.js';
import {
    ROW_HEIGHT,
    COL_WIDTH,
    HEADER_HEIGHT,
    HEADER_WIDTH,
    OVERSCAN_PX_ROWS,
    OVERSCAN_PX_COLS
} from '../constants.js';

/**
 * GridVirtualizer class
 *
 * Main virtualization planner that computes 4-pane render plans.
 */
export class GridVirtualizer {
    /** @type {AxisMetrics} Row axis metrics */
    #rowMetrics;

    /** @type {AxisMetrics} Column axis metrics */
    #colMetrics;

    // Reactive scroll state
    scrollTop = $state(0);
    scrollLeft = $state(0);

    // Reactive container size
    containerWidth = $state(0);
    containerHeight = $state(0);

    // Reactive frozen dimensions
    frozenRows = $state(0);
    frozenCols = $state(0);

    // Sheet dimensions
    rowCount = $state(0);
    colCount = $state(0);

    // Overscan configuration
    overscanRowsMultiplier = $state(OVERSCAN_PX_ROWS ?? 1.0);
    overscanColsMultiplier = $state(OVERSCAN_PX_COLS ?? 1.0);

    // Reactive derived viewport dimensions (content only)
    bodyViewportWidth = $derived(
        Math.max(0, this.containerWidth - HEADER_WIDTH - this.frozenWidth)
    );

    bodyViewportHeight = $derived(
        Math.max(0, this.containerHeight - HEADER_HEIGHT - this.frozenHeight)
    );

    // Reactive overscan in pixels (adaptive)
    overscanRowsPx = $derived(
        Math.max(0, this.bodyViewportHeight * this.overscanRowsMultiplier)
    );

    overscanColsPx = $derived(
        Math.max(0, this.bodyViewportWidth * this.overscanColsMultiplier)
    );

    // Reactive ranges for each axis/pane
    frozenRowRange = $derived.by(() => {
        if (this.rowCount <= 0 || this.frozenRows <= 0) return emptyAxisRange();
        return createAxisRange(0, Math.min(this.frozenRows, this.rowCount) - 1);
    });

    frozenColRange = $derived.by(() => {
        if (this.colCount <= 0 || this.frozenCols <= 0) return emptyAxisRange();
        return createAxisRange(0, Math.min(this.frozenCols, this.colCount) - 1);
    });

    bodyRowRange = $derived.by(() => {
        const _rowVersion = this.#rowMetrics.version;
        _rowVersion;

        return this.#rowMetrics.rangeForViewport({
            scrollPx: this.scrollTop,
            viewportPx: this.bodyViewportHeight,
            overscanPx: this.overscanRowsPx,
            frozenCount: this.frozenRows,
            axisCount: this.rowCount
        });
    });

    bodyColRange = $derived.by(() => {
        const _colVersion = this.#colMetrics.version;
        _colVersion;

        return this.#colMetrics.rangeForViewport({
            scrollPx: this.scrollLeft,
            viewportPx: this.bodyViewportWidth,
            overscanPx: this.overscanColsPx,
            frozenCount: this.frozenCols,
            axisCount: this.colCount
        });
    });

    // Full render plan: stable shape, reactive recomputation
    renderPlan = $derived.by(() => {
        // Explicitly touch versions so size metadata updates force recompute.
        const _rowVersion = this.#rowMetrics.version;
        const _colVersion = this.#colMetrics.version;
        _rowVersion;
        _colVersion;

        const frozenHeight = this.frozenHeight;
        const frozenWidth = this.frozenWidth;

        const cornerPlan = this.#computeCornerPlan();
        const topPlan = this.#computeTopPlan();
        const leftPlan = this.#computeLeftPlan();
        const bodyPlan = this.#computeBodyPlan();

        return {
            plans: {
                corner: cornerPlan,
                top: topPlan,
                left: leftPlan,
                body: bodyPlan
            },
            totalWidth: this.totalWidth,
            totalHeight: this.totalHeight,
            frozenWidth,
            frozenHeight,
            bodyViewportWidth: this.bodyViewportWidth,
            bodyViewportHeight: this.bodyViewportHeight
        };
    });

    /**
     * Create a GridVirtualizer
     * @param {Object} options
     * @param {number} [options.defaultRowHeight]
     * @param {number} [options.defaultColWidth]
     */
    constructor(options = {}) {
        this.#rowMetrics = new AxisMetrics(options.defaultRowHeight ?? ROW_HEIGHT);
        this.#colMetrics = new AxisMetrics(options.defaultColWidth ?? COL_WIDTH);
    }

    // --- Configuration ---

    /**
     * Set container dimensions
     * @param {number} width
     * @param {number} height
     */
    setContainerSize(width, height) {
        if (this.containerWidth !== width || this.containerHeight !== height) {
            this.containerWidth = width;
            this.containerHeight = height;
        }
    }

    /**
     * Set scroll position
     * @param {number} top
     * @param {number} left
     */
    setScroll(top, left) {
        const newTop = Math.max(0, top);
        const newLeft = Math.max(0, left);
        if (this.scrollTop !== newTop) this.scrollTop = newTop;
        if (this.scrollLeft !== newLeft) this.scrollLeft = newLeft;
    }

    /**
     * Set scroll position immediately (no throttling)
     * @param {number} top
     * @param {number} left
     */
    setScrollImmediate(top, left) {
        this.setScroll(top, left);
    }

    /**
     * Set frozen row and column counts
     * @param {number} frozenRows
     * @param {number} frozenCols
     */
    setFrozenDimensions(frozenRows, frozenCols) {
        const newFrozenRows = Math.max(0, Math.min(frozenRows, this.rowCount));
        const newFrozenCols = Math.max(0, Math.min(frozenCols, this.colCount));

        if (this.frozenRows !== newFrozenRows)
            this.frozenRows = newFrozenRows;
        if (this.frozenCols !== newFrozenCols)
            this.frozenCols = newFrozenCols;
    }

    /**
     * Set sheet dimensions
     * @param {number} rowCount
     * @param {number} colCount
     */
    setSheetDimensions(rowCount, colCount) {
        if (this.rowCount !== rowCount || this.colCount !== colCount) {
            this.rowCount = rowCount;
            this.colCount = colCount;
            this.#rowMetrics.setCount(rowCount);
            this.#colMetrics.setCount(colCount);

            // Re-clamp frozen dimensions against new sheet shape.
            this.setFrozenDimensions(this.frozenRows, this.frozenCols);
        }
    }

    /**
     * Set overscan configuration
     * @param {number} rowsMultiplier
     * @param {number} colsMultiplier
     */
    setOverscan(rowsMultiplier, colsMultiplier) {
        this.overscanRowsMultiplier = Math.max(0, rowsMultiplier);
        this.overscanColsMultiplier = Math.max(0, colsMultiplier);
    }

    // --- AxisMetrics Pass-through ---

    /**
     * Get row axis metrics (for direct access if needed)
     * @returns {AxisMetrics}
     */
    get rowMetrics() {
        return this.#rowMetrics;
    }

    /**
     * Get column axis metrics (for direct access if needed)
     * @returns {AxisMetrics}
     */
    get colMetrics() {
        return this.#colMetrics;
    }

    /**
     * Get row height
     * @param {number} row
     * @returns {number}
     */
    getRowHeight(row) {
        return this.#rowMetrics.sizeOf(row);
    }

    /**
     * Get column width
     * @param {number} col
     * @returns {number}
     */
    getColWidth(col) {
        return this.#colMetrics.sizeOf(col);
    }

    /**
     * Get row top offset
     * @param {number} row
     * @returns {number}
     */
    getRowTop(row) {
        return this.#rowMetrics.offsetOf(row);
    }

    /**
     * Get column left offset
     * @param {number} col
     * @returns {number}
     */
    getColLeft(col) {
        return this.#colMetrics.offsetOf(col);
    }

    /**
     * Get cell position
     * @param {number} row
     * @param {number} col
     * @returns {{ top: number, left: number }}
     */
    getCellPosition(row, col) {
        return {
            top: this.#rowMetrics.offsetOf(row),
            left: this.#colMetrics.offsetOf(col)
        };
    }

    /**
     * Apply committed row height override
     * @param {number} row
     * @param {number} height
     */
    applyRowHeight(row, height) {
        this.#rowMetrics.applyCommittedOverride(row, height);
    }

    /**
     * Apply committed column width override
     * @param {number} col
     * @param {number} width
     */
    applyColWidth(col, width) {
        this.#colMetrics.applyCommittedOverride(col, width);
    }

    /**
     * Set temporary row height (during resize)
     * @param {number} row
     * @param {number} height
     */
    setTempRowHeight(row, height) {
        this.#rowMetrics.setTempOverride(row, height);
    }

    /**
     * Set temporary column width (during resize)
     * @param {number} col
     * @param {number} width
     */
    setTempColWidth(col, width) {
        this.#colMetrics.setTempOverride(col, width);
    }

    /**
     * Clear temporary row heights
     * @param {number[]} [rows]
     */
    clearTempRowHeights(rows) {
        this.#rowMetrics.clearTempOverrides(rows);
    }

    /**
     * Clear temporary column widths
     * @param {number[]} [cols]
     */
    clearTempColWidths(cols) {
        this.#colMetrics.clearTempOverrides(cols);
    }

    /**
     * Sync row heights from sheet metadata
     * @param {Map<number, number>} heights
     */
    syncRowHeights(heights) {
        this.#rowMetrics.loadOverrides(heights);
    }

    /**
     * Sync column widths from sheet metadata
     * @param {Map<number, number>} widths
     */
    syncColWidths(widths) {
        this.#colMetrics.loadOverrides(widths);
    }

    // --- Derived State ---

    /**
     * Total grid width
     * @returns {number}
     */
    get totalWidth() {
        return this.#colMetrics.totalSize;
    }

    /**
     * Total grid height
     * @returns {number}
     */
    get totalHeight() {
        return this.#rowMetrics.totalSize;
    }

    /**
     * Frozen rows height in pixels
     * @returns {number}
     */
    get frozenHeight() {
        return this.#rowMetrics.getFrozenOffset(this.frozenRows);
    }

    /**
     * Frozen columns width in pixels
     * @returns {number}
     */
    get frozenWidth() {
        return this.#colMetrics.getFrozenOffset(this.frozenCols);
    }

    // --- Render Plan Computation ---

    /**
     * Compute the complete render plan
     * @returns {import('./types.js').GridRenderPlan}
     */
    getRenderPlan() {
        return this.renderPlan;
    }

    /**
     * Compute corner pane plan (frozen rows × frozen cols)
     */
    #computeCornerPlan() {
        const rowRange = this.frozenRowRange;
        const colRange = this.frozenColRange;

        if (rowRange.count === 0 || colRange.count === 0) {
            return emptyPanePlan(PANE.CORNER);
        }

        return {
            pane: PANE.CORNER,
            rowRange,
            colRange,
            x: 0,
            y: 0,
            width: this.frozenWidth,
            height: this.frozenHeight,
            scrollX: 0,
            scrollY: 0
        };
    }

    /**
     * Compute top pane plan (frozen rows × scrollable cols)
     */
    #computeTopPlan() {
        const rowRange = this.frozenRowRange;
        if (rowRange.count === 0) {
            return emptyPanePlan(PANE.TOP);
        }

        const bodyCols = this.bodyColRange;
        const start = Math.max(this.frozenCols, bodyCols.start);
        const end = bodyCols.end;
        const colRange = end >= start ? createAxisRange(start, end) : emptyAxisRange();

        const width = this.#rangePixelSize(this.#colMetrics, colRange);
        const x = this.frozenWidth;

        return {
            pane: PANE.TOP,
            rowRange,
            colRange,
            x,
            y: 0,
            width,
            height: this.frozenHeight,
            scrollX: this.scrollLeft,
            scrollY: 0
        };
    }

    /**
     * Compute left pane plan (scrollable rows × frozen cols)
     */
    #computeLeftPlan() {
        const colRange = this.frozenColRange;
        if (colRange.count === 0) {
            return emptyPanePlan(PANE.LEFT);
        }

        const bodyRows = this.bodyRowRange;
        const start = Math.max(this.frozenRows, bodyRows.start);
        const end = bodyRows.end;
        const rowRange = end >= start ? createAxisRange(start, end) : emptyAxisRange();

        const height = this.#rangePixelSize(this.#rowMetrics, rowRange);
        const y = this.frozenHeight;

        return {
            pane: PANE.LEFT,
            rowRange,
            colRange,
            x: 0,
            y,
            width: this.frozenWidth,
            height,
            scrollX: 0,
            scrollY: this.scrollTop
        };
    }

    /**
     * Compute body pane plan (scrollable rows × scrollable cols)
     */
    #computeBodyPlan() {
        const rowRange = this.bodyRowRange;
        const colRange = this.bodyColRange;

        const x = this.frozenWidth;
        const y = this.frozenHeight;

        const width = this.#rangePixelSize(this.#colMetrics, colRange);
        const height = this.#rangePixelSize(this.#rowMetrics, rowRange);

        return {
            pane: PANE.BODY,
            rowRange,
            colRange,
            x,
            y,
            width,
            height,
            scrollX: this.scrollLeft,
            scrollY: this.scrollTop
        };
    }

    #rangePixelSize(metrics, range) {
        if (!range || range.count <= 0) return 0;
        return metrics.offsetOf(range.end + 1) - metrics.offsetOf(range.start);
    }

    // --- Scrolling ---

    /**
     * Scroll to make a cell visible
     * @param {number} row
     * @param {number} col
     * @returns {{ scrollTop: number, scrollLeft: number }} Target scroll positions
     */
    scrollToCell(row, col) {
        const cellTop = this.#rowMetrics.offsetOf(row);
        const cellLeft = this.#colMetrics.offsetOf(col);
        const cellHeight = this.#rowMetrics.sizeOf(row);
        const cellWidth = this.#colMetrics.sizeOf(col);

        const frozenHeight = this.frozenHeight;
        const frozenWidth = this.frozenWidth;

        // Calculate body viewport dimensions
        const bodyViewportHeight = this.containerHeight - HEADER_HEIGHT - frozenHeight;
        const bodyViewportWidth = this.containerWidth - HEADER_WIDTH - frozenWidth;

        let newScrollTop = this.scrollTop;
        let newScrollLeft = this.scrollLeft;

        // Scroll vertically if needed (only for non-frozen rows)
        if (row >= this.frozenRows) {
            // Adjust for frozen area
            const visibleTop = newScrollTop;
            const visibleBottom = newScrollTop + bodyViewportHeight;

            if (cellTop < visibleTop) {
                newScrollTop = cellTop;
            } else if (cellTop + cellHeight > visibleBottom) {
                newScrollTop = cellTop + cellHeight - bodyViewportHeight;
            }
        }

        // Scroll horizontally if needed (only for non-frozen columns)
        if (col >= this.frozenCols) {
            const visibleLeft = newScrollLeft;
            const visibleRight = newScrollLeft + bodyViewportWidth;

            if (cellLeft < visibleLeft) {
                newScrollLeft = cellLeft;
            } else if (cellLeft + cellWidth > visibleRight) {
                newScrollLeft = cellLeft + cellWidth - bodyViewportWidth;
            }
        }

        return { scrollTop: newScrollTop, scrollLeft: newScrollLeft };
    }

    /**
     * Get cell at a pixel position
     * @param {number} x - X coordinate relative to grid content area
     * @param {number} y - Y coordinate relative to grid content area
     * @returns {{ row: number, col: number }}
     */
    getCellAtPosition(x, y) {
        // Account for headers
        const contentX = x - HEADER_WIDTH;
        const contentY = y - HEADER_HEIGHT;

        // Determine which pane the click is in
        const frozenHeight = this.frozenHeight;
        const frozenWidth = this.frozenWidth;

        let row, col;

        if (contentY < frozenHeight) {
            // In frozen rows area
            row = this.#rowMetrics.indexAtOffset(contentY);
        } else {
            // In scrollable rows area
            row = this.#rowMetrics.indexAtOffset(contentY - frozenHeight + this.scrollTop);
            // Account for frozen rows offset
            if (row < this.frozenRows) row = this.frozenRows;
        }

        if (contentX < frozenWidth) {
            // In frozen cols area
            col = this.#colMetrics.indexAtOffset(contentX);
        } else {
            // In scrollable cols area
            col = this.#colMetrics.indexAtOffset(contentX - frozenWidth + this.scrollLeft);
            // Account for frozen cols offset
            if (col < this.frozenCols) col = this.frozenCols;
        }

        return { row, col };
    }

    // --- Lifecycle ---

    /**
     * Cleanup resources
     */
    destroy() {
        // no-op for now
    }
}

export default GridVirtualizer;
