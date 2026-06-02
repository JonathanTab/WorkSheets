/**
 * OverflowGeometry - shared helpers for overflow-aware border/gridline painting.
 *
 * When a text cell overflows, its paint width extends beyond its original
 * column. Borders and gridlines should still be anchored to the original cell
 * box (not the extended one), and the edges that are *crossed* by the overflow
 * (the source cell's right/left, and the matching edges on the shadow cells
 * the text flows through) must be suppressed so they don't draw bars through
 * the overflowing text.
 *
 * ## Glossary
 *  - source cell:  the cell whose text actually overflows
 *  - shadow cell:  a cell whose paint is suppressed because the source's text
 *                  covers its area; only its gridlines and any *external*
 *                  borders draw (e.g. its top/bottom, or the far left/right
 *                  edge of the overflow run)
 *
 * Both `getOverflowBorderSpec` (source) and `getShadowBorderSpec` (shadow)
 * return the same shape so the renderer can use either uniformly.
 */

/**
 * @typedef {{
 *   boxX: number,
 *   boxWidth: number,
 *   paintBorders: { top?: any, right?: any, bottom?: any, left?: any } | null,
 *   suppressRightGridline: boolean,
 * }} BorderSpec
 */

/**
 * Return paint geometry + suppressed borders for an overflow *source* cell.
 *
 * Geometry: anchored to the cell's natural box, not the extended overflow
 * width — so gridlines / borders draw at the original column boundary.
 *
 * Suppression:
 *   - right/both:  drop the right border (text crosses into the next column)
 *   - left/both:   drop the left  border (text crosses out of the prior column)
 *
 * @param {any} cell
 * @returns {BorderSpec}
 */
export function getOverflowBorderSpec(cell) {
    const boxX = cell.naturalX ?? cell.x;
    const boxWidth = cell.naturalWidth ?? cell.width;

    let paintBorders = cell.borders ?? null;
    if (paintBorders) {
        const dropRight = cell.overflowSide === 'right' || cell.overflowSide === 'both';
        const dropLeft  = cell.overflowSide === 'left'  || cell.overflowSide === 'both';
        if (dropRight && paintBorders.right) paintBorders = { ...paintBorders, right: null };
        if (dropLeft  && paintBorders.left)  paintBorders = { ...paintBorders, left:  null };
    }

    return {
        boxX,
        boxWidth,
        paintBorders,
        suppressRightGridline: cell.overflowSide === 'right' || cell.overflowSide === 'both',
    };
}

/**
 * Return paint geometry + suppressed borders for an overflow *shadow* cell.
 *
 * Because the shared-edge data model stores ONE border for an edge that both
 * the source's right and the shadow's left refer to, the shadow would re-draw
 * the edge that the source has just suppressed. We drop the side that faces
 * the source (and the source-most shadow's "inner" sides) so the overflow
 * run paints as one continuous strip.
 *
 * Top and bottom borders are always retained — the overflow run is one row
 * tall, so horizontal borders run continuously through it.
 *
 * shadowPos values:
 *   'inner-right' — shadow to the right of a right-overflow source, not the last
 *   'last-right'  — rightmost shadow in a right-overflow run
 *   'inner-left'  — shadow to the left of a left-overflow source, not the first
 *   'first-left'  — leftmost shadow in a left-overflow run
 *
 * Suppression rules:
 *   - inner-right / inner-left:  drop both left AND right (mid-run, no vertical
 *                                edges should appear at all)
 *   - last-right:                drop left only (right edge terminates the run)
 *   - first-left:                drop right only (left edge terminates the run)
 *
 * @param {any} cell
 * @returns {BorderSpec}
 */
export function getShadowBorderSpec(cell) {
    const boxX = cell.naturalX ?? cell.x;
    const boxWidth = cell.naturalWidth ?? cell.width;

    let paintBorders = cell.borders ?? null;
    const pos = cell.shadowPos;
    if (paintBorders && pos) {
        const dropLeft  = pos === 'inner-right' || pos === 'inner-left'  || pos === 'last-right';
        const dropRight = pos === 'inner-right' || pos === 'inner-left'  || pos === 'first-left';
        if (dropLeft  && paintBorders.left)  paintBorders = { ...paintBorders, left:  null };
        if (dropRight && paintBorders.right) paintBorders = { ...paintBorders, right: null };
    }

    return {
        boxX,
        boxWidth,
        paintBorders,
        // Shadows always suppress the right gridline (the overflow run paints
        // its own right edge at the end-of-run boundary, if any).
        suppressRightGridline: true,
    };
}
