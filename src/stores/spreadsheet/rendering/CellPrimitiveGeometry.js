/**
 * CellPrimitiveGeometry.js — Shared layout math for checkbox and rating cells.
 *
 * Provides unit-agnostic geometry calculations used by both the canvas renderer
 * (CSS px) and the vector PDF renderer (mm). Callers supply cell dimensions in
 * their own units and receive positions/sizes in the same units.
 *
 * ## Why this exists
 * Previously `painters.js` (canvas) and `VectorPrintEngine` (jsPDF) each
 * duplicated the size, centering, and proportion constants. A 1-pixel tweak to
 * the checkbox radius required two edits in two files. This module is the single
 * source of truth for those constants.
 *
 * ## Shared constants
 *   Checkbox: padding = 4 units, max = 16 units, corner-radius = 12% of size
 *   Rating: star gap = 2 units, max star = 16 units, inner/outer ratio = 0.4, 5 points
 */

// ── Shared constants ────────────────────────────────────────────────────────────
/** Default checkbox padding (each side) in the caller's unit system */
export const CHECKBOX_PADDING  = 4;
/** Default checkbox max size in the caller's unit system */
export const CHECKBOX_MAX_SIZE = 16;
/** Corner-radius as a fraction of checkbox size */
export const CHECKBOX_RADIUS_FRACTION = 0.12;

/** Gap between rating stars in the caller's unit system */
export const RATING_GAP      = 2;
/** Max star size in the caller's unit system */
export const RATING_MAX_SIZE = 16;
/** Inner-to-outer radius ratio for the 5-point star shape */
export const RATING_INNER_RATIO = 0.4;
/** Number of points on each star */
export const RATING_POINTS = 5;

// ── Checkbox geometry ───────────────────────────────────────────────────────────

/**
 * Compute the layout of a checkbox inside a cell.
 * All inputs and outputs are in the same unit (px or mm).
 *
 * @param {number} cellW
 * @param {number} cellH
 * @param {object} [opts]
 * @param {number} [opts.maxSize=CHECKBOX_MAX_SIZE]   — upper bound on box size
 * @param {number} [opts.padding=CHECKBOX_PADDING]    — space to leave on each side
 * @param {number} [opts.minRadius=0]                 — floor on corner radius
 * @returns {{ x:number, y:number, size:number, radius:number }}
 *   `x`, `y` are offsets from the cell top-left corner.
 */
export function checkboxLayout(cellW, cellH, {
    maxSize  = CHECKBOX_MAX_SIZE,
    padding  = CHECKBOX_PADDING,
    minRadius = 0,
} = {}) {
    const size   = Math.max(0, Math.min(maxSize, cellH - padding, cellW - padding));
    const x      = (cellW - size) / 2;
    const y      = (cellH - size) / 2;
    const radius = Math.max(minRadius, size * CHECKBOX_RADIUS_FRACTION);
    return { x, y, size, radius };
}

// ── Rating geometry ─────────────────────────────────────────────────────────────

/**
 * Compute the layout of a row of rating stars inside a cell.
 * All inputs and outputs are in the same unit (px or mm).
 *
 * @param {number} value    — current rating (0–max)
 * @param {number} max      — total number of stars
 * @param {number} cellW
 * @param {number} cellH
 * @param {object} [opts]
 * @param {number} [opts.maxStarSize=RATING_MAX_SIZE]
 * @param {number} [opts.gap=RATING_GAP]
 * @returns {Array<{ cx:number, cy:number, outerR:number, innerR:number, filled:boolean }>}
 *   Star centres are relative to the cell top-left corner.
 */
export function ratingLayout(value, max, cellW, cellH, {
    maxStarSize = RATING_MAX_SIZE,
    gap         = RATING_GAP,
} = {}) {
    const starSize = Math.min(Math.floor(cellH - gap), maxStarSize);
    const outerR   = starSize / 2;
    const innerR   = outerR * RATING_INNER_RATIO;
    const totalW   = max * (starSize + gap) - gap;
    const startCx  = (cellW - totalW) / 2 + outerR;
    const cy       = cellH / 2;

    return Array.from({ length: max }, (_, i) => ({
        cx:     startCx + i * (starSize + gap),
        cy,
        outerR,
        innerR,
        filled: i < value,
    }));
}

/**
 * Compute the polygon vertices for a single star, returned as a flat [x, y][]
 * list (alternating outer/inner points). Angles measured from 12 o'clock.
 * @param {number} cx @param {number} cy @param {number} outerR @param {number} innerR
 * @param {number} [points=RATING_POINTS]
 * @returns {[number, number][]}
 */
export function starVertices(cx, cy, outerR, innerR, points = RATING_POINTS) {
    const step = Math.PI / points;
    return Array.from({ length: 2 * points }, (_, i) => {
        const r     = i % 2 === 0 ? outerR : innerR;
        const angle = i * step - Math.PI / 2;
        return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    });
}
