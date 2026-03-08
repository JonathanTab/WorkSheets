/**
 * Virtualization Types
 *
 * JSDoc typedefs for the virtualization subsystem.
 * These types define the data structures used for efficient grid rendering.
 */

/**
 * @typedef {'row' | 'col'} AxisKind
 * @description Distinguishes row vs column axis logic.
 */

/**
 * @typedef {Object} AxisRange
 * @property {number} start - Inclusive start index
 * @property {number} end - Inclusive end index
 * @property {number} count - Number of items in range (Math.max(0, end - start + 1))
 * @description Represents a contiguous range of indices on an axis.
 */

/**
 * @typedef {Object} AxisViewportQuery
 * @property {number} scrollPx - Current scroll position in pixels
 * @property {number} viewportPx - Viewport size in pixels
 * @property {number} overscanPx - Extra pixels to render beyond viewport
 * @property {number} frozenCount - Number of frozen items at start
 * @property {number} axisCount - Total items on this axis
 * @description Normalized query for visible-range calculation.
 */

/**
 * @typedef {'corner' | 'top' | 'left' | 'body'} PaneKind
 * @description Identifies one of the four virtualization panes.
 * - corner: frozen rows × frozen cols (top-left, doesn't scroll)
 * - top: frozen rows × scrollable cols (header strip, scrolls horizontally)
 * - left: scrollable rows × frozen cols (left strip, scrolls vertically)
 * - body: scrollable rows × scrollable cols (main area, scrolls both ways)
 */

/**
 * @typedef {Object} PaneRenderPlan
 * @property {PaneKind} pane - Which pane this plan is for
 * @property {AxisRange} rowRange - Row indices for this pane
 * @property {AxisRange} colRange - Column indices for this pane
 * @property {number} x - Absolute left position in grid content
 * @property {number} y - Absolute top position in grid content
 * @property {number} width - Width of this pane in pixels
 * @property {number} height - Height of this pane in pixels
 * @property {number} scrollX - Pane-specific horizontal scroll transform
 * @property {number} scrollY - Pane-specific vertical scroll transform
 * @description Complete rendering instructions for a single pane.
 */

/**
 * @typedef {Object} GridRenderPlan
 * @property {Record<PaneKind, PaneRenderPlan>} plans - Render plans for all four panes
 * @property {number} totalWidth - Total grid content width in pixels
 * @property {number} totalHeight - Total grid content height in pixels
 * @property {number} frozenWidth - Width of frozen columns in pixels
 * @property {number} frozenHeight - Height of frozen rows in pixels
 * @property {number} bodyViewportWidth - Visible width of body pane
 * @property {number} bodyViewportHeight - Visible height of body pane
 * @description Complete rendering plan for all grid panes.
 */

/**
 * @typedef {Object} AxisOverrideEvent
 * @property {AxisKind} axis - Which axis was affected
 * @property {number[]} indices - Indices that changed
 * @property {'rowMeta' | 'colMeta' | 'resize-temp' | 'resize-commit' | 'structure'} source - Source of the change
 * @description Incremental update payload from SheetStore to virtualizer.
 */

/**
 * @typedef {Object} CellRenderModel
 * @property {boolean} exists - Whether cell has content
 * @property {any} displayValue - Computed display value (formula result or raw value)
 * @property {string} textStyle - CSS style string for text formatting
 * @property {string} containerStyle - CSS style string for container (background, borders)
 * @property {boolean} isFormula - Whether cell contains a formula
 * @property {Object|null} borders - Border styles { top, bottom, left, right }
 * @description Precomputed cell rendering data to avoid repeated computation in render loops.
 */

/**
 * Create an AxisRange object with validation
 * @param {number} start - Start index (inclusive)
 * @param {number} end - End index (inclusive)
 * @returns {AxisRange}
 */
export function createAxisRange(start, end) {
    const clampedStart = Math.max(0, start);
    const clampedEnd = Math.max(clampedStart - 1, end);
    return {
        start: clampedStart,
        end: clampedEnd,
        count: Math.max(0, clampedEnd - clampedStart + 1)
    };
}

/**
 * Create an empty AxisRange
 * @returns {AxisRange}
 */
export function emptyAxisRange() {
    return { start: 0, end: -1, count: 0 };
}

/**
 * Check if an AxisRange is empty
 * @param {AxisRange} range
 * @returns {boolean}
 */
export function isAxisRangeEmpty(range) {
    return range.count <= 0;
}

/**
 * Check if an index is within an AxisRange
 * @param {AxisRange} range
 * @param {number} index
 * @returns {boolean}
 */
export function isIndexInRange(range, index) {
    return index >= range.start && index <= range.end;
}

/**
 * Create an empty PaneRenderPlan
 * @param {PaneKind} pane
 * @returns {PaneRenderPlan}
 */
export function emptyPanePlan(pane) {
    return {
        pane,
        rowRange: emptyAxisRange(),
        colRange: emptyAxisRange(),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        scrollX: 0,
        scrollY: 0
    };
}

/**
 * Axis kind constants
 * @type {{ ROW: AxisKind, COL: AxisKind }}
 */
export const AXIS = {
    ROW: 'row',
    COL: 'col'
};

/**
 * Pane kind constants
 * @type {{ CORNER: PaneKind, TOP: PaneKind, LEFT: PaneKind, BODY: PaneKind }}
 */
export const PANE = {
    CORNER: 'corner',
    TOP: 'top',
    LEFT: 'left',
    BODY: 'body'
};

/**
 * Override source constants
 * @type {{ ROW_META: string, COL_META: string, RESIZE_TEMP: string, RESIZE_COMMIT: string, STRUCTURE: string }}
 */
export const OVERRIDE_SOURCE = {
    ROW_META: 'rowMeta',
    COL_META: 'colMeta',
    RESIZE_TEMP: 'resize-temp',
    RESIZE_COMMIT: 'resize-commit',
    STRUCTURE: 'structure'
};
