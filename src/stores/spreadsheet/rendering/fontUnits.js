/**
 * Font-unit conversion + metric helpers shared by canvas and DOM render paths.
 *
 * Sizes are stored in points (1pt = 1/72in). CSS pixels are defined as 1/96in.
 * The conversion factor is therefore 96/72 = 4/3. The result is rounded to an
 * integer CSS pixel so glyphs rasterize on a whole-pixel grid (otherwise
 * common pt sizes like 10, 11, 13, 14 land on fractional px and look soft).
 */
export function ptToPx(pt) {
    return Math.round(pt * 4 / 3);
}

/**
 * Inverse of {@link ptToPx}: CSS pixels → points, rounded to a whole point. Used
 * when reading a font-size out of the DOM (contenteditable / pasted HTML) back
 * into the pt-based storage model.
 */
export function pxToPt(px) {
    return Math.round(px * 3 / 4);
}

/**
 * Snap a CSS-pixel coordinate to the device-pixel grid so glyphs and 1px
 * strokes rasterize crisply instead of soft/blurry across two physical pixels.
 * At dpr=2 this rounds to the nearest 0.5 CSS px; at dpr=1 to the nearest 1 px.
 *
 * @param {number} v   coordinate in CSS px
 * @param {number} dpr device pixel ratio (defaults to 1 / no snap)
 * @returns {number}
 */
export function snapToDevice(v, dpr = 1) {
    return dpr ? Math.round(v * dpr) / dpr : v;
}

// ── Font metrics (ascent/descent) ────────────────────────────────────────────
// Cached per font string. Each cell in a typical sheet shares a font with
// dozens of others, so this is essentially free after warm-up.

const _metricsCache = new Map();
let _measureCtx = null;

/**
 * Get ascent/descent/centerOffset for a given canvas font string.
 *
 *   ascent       — distance from baseline to top of typical glyphs (e.g. 'M')
 *   descent      — distance from baseline to bottom of typical descenders ('g', 'p')
 *   centerOffset — how far the visual center of the em-box sits *above* the
 *                  baseline. Used to convert between 'alphabetic' (where we
 *                  position by baseline) and the geometric center of a row.
 *
 * @param {string} fontStr A CSS font shorthand, e.g. "normal normal 13px system-ui"
 * @returns {{ascent:number, descent:number, centerOffset:number}}
 */
export function getFontMetrics(fontStr) {
    const cached = _metricsCache.get(fontStr);
    if (cached) return cached;

    if (!_measureCtx && typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        _measureCtx = c.getContext('2d');
    }

    let ascent = 10;
    let descent = 3;

    if (_measureCtx) {
        _measureCtx.font = fontStr;
        _measureCtx.textBaseline = 'alphabetic';
        // 'Mg' is a conventional probe: 'M' gives a representative cap ascent,
        // 'g' gives a representative descender. Some browsers only report
        // bounding-box metrics for glyphs that actually appear in the string.
        const m = _measureCtx.measureText('Mg');
        if (Number.isFinite(m.actualBoundingBoxAscent)) {
            ascent = m.actualBoundingBoxAscent;
        }
        if (Number.isFinite(m.actualBoundingBoxDescent)) {
            descent = m.actualBoundingBoxDescent;
        }
    }

    // Visual center of (ascent + descent) sits (ascent - descent)/2 above the baseline.
    const centerOffset = (ascent - descent) / 2;

    const entry = { ascent, descent, centerOffset };
    _metricsCache.set(fontStr, entry);
    return entry;
}

/**
 * The single source of truth for multi-line line spacing: (ascent+descent)*1.2
 * of the cell's *default* font, in CSS px. Canvas, the cell editor, and the PDF
 * engine all derive their per-line step from this so a multi-line cell is spaced
 * identically in every render path (editor px, canvas px, PDF px→pt→mm).
 *
 * @param {string} fontStr A CSS font shorthand for the cell's default font.
 * @returns {number} line height in CSS px
 */
export function lineHeightPxFor(fontStr) {
    const m = getFontMetrics(fontStr);
    return (m.ascent + m.descent) * 1.2;
}

/**
 * Compute the baseline Y of the *first line* of a multi-line block whose total
 * height is `blockHeight`. Uses the same alignment rules as computeBaselineY.
 *
 * @param {number} y           Cell top in CSS px
 * @param {number} cellHeight  Cell height in CSS px
 * @param {string} vAlign      'top' | 'middle' | 'bottom'
 * @param {object} metrics     { ascent, descent } of the canonical line font
 * @param {number} blockHeight Total height of all lines (count * lineHeight)
 * @param {number} pad         Inner padding in CSS px
 * @returns {number}           Baseline Y of the first line
 */
export function computeBaselineYForBlock(y, cellHeight, vAlign, metrics, blockHeight, pad = 2) {
    const { ascent, descent } = metrics;
    let blockTop;
    if (vAlign === 'top') {
        blockTop = y + pad;
    } else if (vAlign === 'bottom') {
        blockTop = y + cellHeight - pad - blockHeight;
    } else {
        blockTop = y + (cellHeight - blockHeight) / 2;
    }
    // Clamp so the first line's cap never bleeds above the top pad.
    const minBlockTop = y + pad;
    if (blockTop < minBlockTop) blockTop = minBlockTop;
    // First line's baseline sits `ascent` below the top of the block.
    // (Each line in the block occupies ascent+descent of vertical space.)
    return blockTop + ascent;
}

/**
 * Compute the alphabetic-baseline Y for a single line of text inside a cell rect.
 *
 * @param {number} y         Cell top in CSS px
 * @param {number} height    Cell height in CSS px
 * @param {string} vAlign    'top' | 'middle' | 'bottom'
 * @param {object} metrics   { ascent, descent } from getFontMetrics()
 * @param {number} pad       Inner padding in CSS px (top/bottom)
 * @returns {number}         Baseline Y for ctx.fillText with textBaseline='alphabetic'
 */
export function computeBaselineY(y, height, vAlign, metrics, pad = 2) {
    const { ascent, descent } = metrics;
    // Clamp so the cap doesn't bleed above the top edge.
    const minBaseline = y + pad + ascent;
    // Clamp so the descender doesn't bleed below the bottom edge.
    const maxBaseline = y + height - pad - descent;

    let baseline;
    if (vAlign === 'top') {
        baseline = y + pad + ascent;
    } else if (vAlign === 'bottom') {
        baseline = y + height - pad - descent;
    } else {
        // Center the visual span (ascent + descent) inside the cell.
        baseline = y + (height + ascent - descent) / 2;
    }

    // If text is taller than the cell, anchor to top so the cap stays visible.
    if (maxBaseline < minBaseline) return minBaseline;
    return Math.max(minBaseline, Math.min(maxBaseline, baseline));
}
