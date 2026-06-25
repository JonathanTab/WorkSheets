/**
 * BorderGeometry.js — Shared border-painting logic for the spreadsheet renderer.
 *
 * Provides a single source of truth for:
 *   - Border style normalization (style / width / color / dash patterns / double gap).
 *   - Pixel snapping math (`snapOffset`) shared between canvas and PDF.
 *   - Canvas painter `paintBordersCanvas(ctx, borders, x, y, w, h, dpr)`.
 *   - jsPDF painter   `paintBordersVec(pdf, borders, cx, cy, cw, ch, parseColor, s)`.
 *   - `normalizeBorderStyle(edge)` — canonical border descriptor helper.
 *   - `bordersStylesEqual(a, b)` — value equality after normalization (used by clipboard).
 *
 * Constants are defined once and used by both renderers, so canvas + PDF render
 * dashed / dotted / double borders with matching dimensions.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** CSS px → mm conversion factor (at userScale s=1). 25.4 mm/in ÷ 96 css-px/in. */
const PX_TO_MM = 25.4 / 96;

const DEFAULT_COLOR = '#000000';
const DEFAULT_STYLE = 'solid';
const DEFAULT_WIDTH = 1;

// ── Style normalization ───────────────────────────────────────────────────────

/**
 * Return a canonical border descriptor. Accepts partial / undefined input.
 * Color is lowercased and short hex (#abc) expanded to #aabbcc so equality
 * tests don't false-negative on representation differences.
 * @param {{ style?: string, width?: number, color?: string } | null | undefined} edge
 * @returns {{ style: 'solid'|'dashed'|'dotted'|'double', width: number, color: string } | null}
 */
export function normalizeBorderStyle(edge) {
    if (!edge) return null;
    const style = edge.style || DEFAULT_STYLE;
    const width = typeof edge.width === 'number' && edge.width > 0 ? edge.width : DEFAULT_WIDTH;
    let color = edge.color || DEFAULT_COLOR;
    if (typeof color === 'string') {
        color = color.toLowerCase().trim();
        // Expand #rgb → #rrggbb
        const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(color);
        if (m) color = `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
    }
    return { style, width, color };
}

/**
 * Value-equality for border style descriptors after normalization.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function bordersStylesEqual(a, b) {
    const na = normalizeBorderStyle(a);
    const nb = normalizeBorderStyle(b);
    if (!na && !nb) return true;
    if (!na || !nb) return false;
    return na.style === nb.style && na.width === nb.width && na.color === nb.color;
}

// ── Geometry helpers (shared by canvas + PDF) ─────────────────────────────────

/**
 * Returns the CSS-px offset needed to snap a stroke of `cssWidth` to the
 * physical pixel grid at the given DPR. Returns 0 for even-physical-px widths
 * (which already sit on integer pixel boundaries), 0.5/dpr for odd widths.
 *
 * @param {number} cssWidth   Stroke width in CSS pixels.
 * @param {number} [dpr]      Device pixel ratio. Defaults to 1.
 * @returns {number}          Offset in CSS pixels.
 */
export function snapOffset(cssWidth, dpr = 1) {
    const physPx = Math.max(1, Math.round(cssWidth * dpr));
    return (physPx % 2 === 1) ? 0.5 / dpr : 0;
}

/**
 * Quantize a stroke width (CSS px) to a whole number of physical pixels so it
 * renders crisply at the given DPR. At DPR=1 this is a no-op for integer widths.
 *
 * @param {number} cssWidth
 * @param {number} dpr
 * @returns {number}  Quantized CSS width.
 */
export function quantizeStrokeWidth(cssWidth, dpr = 1) {
    const physPx = Math.max(1, Math.round(cssWidth * dpr));
    return physPx / dpr;
}

/**
 * Dash pattern in CSS px for a given stroke width.
 * Scales with width so thick dashes don't look like ticks.
 */
export function dashPatternCss(width) {
    const w = Math.max(1, width);
    return [4 * w, 4 * w];
}

/**
 * Dotted pattern in CSS px for a given stroke width.
 * Round dots are achieved by setting lineCap='round' at the caller; pattern is
 * [0, 2w] so each "on" segment is just the cap (= a circle of diameter w).
 */
export function dottedPatternCss(width) {
    const w = Math.max(1, width);
    return [0, 2 * w];
}

/**
 * Gap between the two strokes of a "double" border, in CSS px.
 * Scales with width so doubles read as two distinct lines at any thickness.
 */
export function doubleGapCss(width) {
    return Math.max(2, Math.round(width) + 1);
}

// ── Canvas (2D context) painter ───────────────────────────────────────────────

/**
 * Paint custom borders on a 2D canvas for a single cell.
 * Caller is responsible for any clip / save / restore around the batch — this
 * function does not touch ctx state beyond stroke style, line width, dash, and
 * line cap, and resets them to neutral defaults on exit.
 *
 * Geometry rules:
 *   - Strokes are snapped using `snapOffset(width, dpr)` so 1-px lines land on
 *     a single physical pixel row/column (no blurry half-pixel rendering).
 *   - Edges are inset by exactly half their stroke width so the stroke sits
 *     *on* the cell boundary, not bleeding into the neighbour cell.
 *   - Each edge extends `lineWidth/2` past both endpoints so adjacent borders
 *     overlap cleanly at corners (the canvas equivalent of jsPDF's projecting
 *     square cap).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ top?, right?, bottom?, left? }} borders   Each edge or null.
 * @param {number} x   Cell left   (CSS px)
 * @param {number} y   Cell top    (CSS px)
 * @param {number} w   Cell width  (CSS px)
 * @param {number} h   Cell height (CSS px)
 * @param {number} [dpr]
 */
export function paintBordersCanvas(ctx, borders, x, y, w, h, dpr = 1) {
    if (!borders) return;

    const paintEdge = (rawEdge, position) => {
        const edge = normalizeBorderStyle(rawEdge);
        if (!edge) return;

        // Border widths are authored in CSS px and must render at the same visual
        // thickness as the PDF (which uses CSS px directly) — so widths > 1 use
        // their nominal CSS px and read as genuinely thicker. The one exception is
        // the default "normal" border (width ≤ 1): it's painted as a 1-physical-px
        // hairline so it stays crisp and matches the gridlines (also 1 physical px),
        // rather than the dpr× thicker line a plain CSS-px width would give.
        const lineWidth = edge.width <= 1 ? 1 / dpr : edge.width;
        // Snap odd-physical-pixel strokes onto a half-physical-pixel position
        // so they render as a single crisp row/column instead of antialiasing
        // across two. Even widths already sit on the physical-pixel grid.
        const physPx = Math.max(1, Math.round(lineWidth * dpr));
        const snap = (physPx % 2 === 1) ? 0.5 / dpr : 0;

        // Each endpoint extends to meet the far edge of the PERPENDICULAR border
        // at that corner — i.e. by the perpendicular edge's half-width, not this
        // edge's. This fills the corner square exactly: no gap (the old butt-cap
        // notch) and no stub (which a same-width extension leaves when this edge
        // is thicker than the border it terminates into). Returns 0 where the
        // perpendicular edge is absent, so a lone border keeps clean butt ends.
        const perpHalf = (rawPerp) => {
            const pe = normalizeBorderStyle(rawPerp);
            if (!pe) return 0;
            const pw = pe.width <= 1 ? 1 / dpr : pe.width;
            return pw / 2;
        };

        let x1, y1, x2, y2;
        if (position === 'top') {
            const py = y + snap;
            x1 = x - perpHalf(borders.left);  y1 = py;
            x2 = x + w + perpHalf(borders.right); y2 = py;
        } else if (position === 'bottom') {
            const py = y + h + snap;
            x1 = x - perpHalf(borders.left);  y1 = py;
            x2 = x + w + perpHalf(borders.right); y2 = py;
        } else if (position === 'left') {
            const px = x + snap;
            x1 = px; y1 = y - perpHalf(borders.top);
            x2 = px; y2 = y + h + perpHalf(borders.bottom);
        } else { // right
            const px = x + w + snap;
            x1 = px; y1 = y - perpHalf(borders.top);
            x2 = px; y2 = y + h + perpHalf(borders.bottom);
        }

        ctx.strokeStyle = edge.color;

        if (edge.style === 'double') {
            // Two parallel strokes of `lineWidth` each, separated by doubleGapCss.
            const gap = doubleGapCss(lineWidth);
            const halfGap = gap / 2;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'butt'; // endpoints already extended by overlap; butt avoids double-extension
            ctx.setLineDash([]);
            const isH = (y1 === y2);
            ctx.beginPath();
            if (isH) {
                ctx.moveTo(x1, y1 - halfGap); ctx.lineTo(x2, y2 - halfGap);
                ctx.moveTo(x1, y1 + halfGap); ctx.lineTo(x2, y2 + halfGap);
            } else {
                ctx.moveTo(x1 - halfGap, y1); ctx.lineTo(x2 - halfGap, y2);
                ctx.moveTo(x1 + halfGap, y1); ctx.lineTo(x2 + halfGap, y2);
            }
            ctx.stroke();
            return;
        }

        ctx.lineWidth = lineWidth;
        if (edge.style === 'dashed') {
            ctx.lineCap = 'butt';
            ctx.setLineDash(dashPatternCss(lineWidth));
        } else if (edge.style === 'dotted') {
            ctx.lineCap = 'round';
            ctx.setLineDash(dottedPatternCss(lineWidth));
        } else {
            ctx.lineCap = 'butt'; // endpoints already extended by overlap; butt avoids double-extension
            ctx.setLineDash([]);
        }

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    };

    if (borders.top)    paintEdge(borders.top,    'top');
    if (borders.right)  paintEdge(borders.right,  'right');
    if (borders.bottom) paintEdge(borders.bottom, 'bottom');
    if (borders.left)   paintEdge(borders.left,   'left');

    // Reset state the caller might rely on.
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
}

// ── PDF (jsPDF) painter ───────────────────────────────────────────────────────

/**
 * Paint custom borders on a jsPDF document for a single cell.
 * Coordinates in mm; lineWidths are converted from CSS px scaled by `s`.
 *
 * Dash / double dimensions are derived from the same constants as the canvas
 * painter (`dashPatternCss`, `doubleGapCss`) so visual output matches.
 *
 * @param {import('jspdf').jsPDF} pdf
 * @param {{ top?, right?, bottom?, left? }} borders
 * @param {number} cx  Cell left mm
 * @param {number} cy  Cell top  mm
 * @param {number} cw  Cell width  mm
 * @param {number} ch  Cell height mm
 * @param {(color: string, fallback?: [number,number,number]) => [number,number,number]} parseColorFn
 * @param {number} [s]  userScale (print zoom). Defaults to 1.
 */
export function paintBordersVec(pdf, borders, cx, cy, cw, ch, parseColorFn, s = 1) {
    if (!borders) return;

    pdf.setLineCap(0); // butt — endpoints are explicitly extended to fill corners; a projecting cap would double-extend

    const edge = (rawEdge, position) => {
        const e = normalizeBorderStyle(rawEdge);
        if (!e) return;
        const [r, g, b] = parseColorFn(e.color, [0, 0, 0]);
        pdf.setDrawColor(r, g, b);

        const lineWidthCss = Math.max(0.5, e.width);
        const lineW = Math.max(0.05, lineWidthCss * PX_TO_MM * s);

        // Centre the stroke on the cell boundary so adjacent cells' shared
        // edge (e.g. cell N's bottom + cell N+1's top) paints to exactly the
        // same line and merges, matching the canvas convention.
        //
        // Extend each endpoint to the far edge of the PERPENDICULAR border at
        // that corner — by the perpendicular edge's half-width, not this edge's.
        // This fills the corner exactly with no gap and no stub when the two
        // edges differ in width. Returns 0 where the perpendicular edge is absent
        // (lone border keeps clean butt ends). Mirrors the canvas painter.
        const perpHalf = (rawPerp) => {
            const pe = normalizeBorderStyle(rawPerp);
            if (!pe) return 0;
            return Math.max(0.05, Math.max(0.5, pe.width) * PX_TO_MM * s) / 2;
        };

        let x1, y1, x2, y2;
        if (position === 'top')         { const py = cy;       x1 = cx - perpHalf(borders.left); y1 = py; x2 = cx + cw + perpHalf(borders.right); y2 = py; }
        else if (position === 'bottom') { const py = cy + ch;  x1 = cx - perpHalf(borders.left); y1 = py; x2 = cx + cw + perpHalf(borders.right); y2 = py; }
        else if (position === 'left')   { const px = cx;       x1 = px; y1 = cy - perpHalf(borders.top); x2 = px; y2 = cy + ch + perpHalf(borders.bottom); }
        else                            { const px = cx + cw;  x1 = px; y1 = cy - perpHalf(borders.top); x2 = px; y2 = cy + ch + perpHalf(borders.bottom); }

        if (e.style === 'double') {
            const gapCss = doubleGapCss(lineWidthCss);
            const gapMm  = gapCss * PX_TO_MM * s;
            const halfGap = gapMm / 2;
            pdf.setLineWidth(lineW);
            pdf.setLineDashPattern([], 0);
            const isH = (y1 === y2);
            if (isH) {
                pdf.line(x1, y1 - halfGap, x2, y2 - halfGap);
                pdf.line(x1, y1 + halfGap, x2, y2 + halfGap);
            } else {
                pdf.line(x1 - halfGap, y1, x2 - halfGap, y2);
                pdf.line(x1 + halfGap, y1, x2 + halfGap, y2);
            }
            return;
        }

        if (e.style === 'dashed') {
            const [on, off] = dashPatternCss(lineWidthCss);
            pdf.setLineWidth(lineW);
            pdf.setLineDashPattern([on * PX_TO_MM * s, off * PX_TO_MM * s], 0);
            pdf.line(x1, y1, x2, y2);
            pdf.setLineDashPattern([], 0);
            return;
        }

        if (e.style === 'dotted') {
            // Approximate round dots by drawing very short dashes with round caps
            // (jsPDF supports round line caps via setLineCap(1)).
            const stepCss = 2 * lineWidthCss;
            const stepMm = stepCss * PX_TO_MM * s;
            pdf.setLineCap(1); // round
            pdf.setLineWidth(lineW);
            pdf.setLineDashPattern([0.01 * PX_TO_MM * s, stepMm], 0);
            pdf.line(x1, y1, x2, y2);
            pdf.setLineDashPattern([], 0);
            pdf.setLineCap(0); // restore butt for subsequent edges
            return;
        }

        // solid
        pdf.setLineWidth(lineW);
        pdf.line(x1, y1, x2, y2);
    };

    edge(borders.top,    'top');
    edge(borders.right,  'right');
    edge(borders.bottom, 'bottom');
    edge(borders.left,   'left');

    pdf.setLineDashPattern([], 0);
    pdf.setLineCap(0); // restore butt
}
