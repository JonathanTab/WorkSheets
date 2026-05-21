/**
 * BorderGeometry.js — Shared border-painting logic for the spreadsheet renderer.
 *
 * Provides:
 *   - The border offset math (lineWidth → pixel offset) used by both
 *     CanvasRenderer and VectorPrintEngine.
 *   - `paintBordersCanvas(ctx, borders, x, y, w, h)` — canvas 2D implementation.
 *   - `paintBordersVec(pdf, borders, cx, cy, cw, ch)` — jsPDF implementation.
 *   - `normalizeBorderStyle(edge)` — canonical border descriptor helper.
 *
 * Both renderers previously duplicated the edge-painting logic and the double/
 * dashed/solid branch. Centralising here guarantees they render identically.
 */

// ── Shared math ────────────────────────────────────────────────────────────────

/**
 * Return the stroke offset for a given line width.
 * At lineWidth=1 the offset is 0.5 (centre of pixel); thicker lines need a
 * larger offset so the stroke visually sits outside the cell rect.
 * @param {number} lineWidth
 * @returns {number}
 */
export function borderOffset(lineWidth) {
    return lineWidth === 1 ? 0.5 : Math.ceil(lineWidth / 2);
}

// ── Canvas (2D context) painter ────────────────────────────────────────────────

/**
 * Paint custom borders on a 2D canvas for a single cell.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ top?, right?, bottom?, left? }} borders  Each edge: { style, width, color } or null
 * @param {number} x  Cell left (CSS px)
 * @param {number} y  Cell top  (CSS px)
 * @param {number} w  Cell width  (CSS px)
 * @param {number} h  Cell height (CSS px)
 */
export function paintBordersCanvas(ctx, borders, x, y, w, h) {
    const paintEdge = (edge, x1, y1, x2, y2, position) => {
        if (!edge) return;
        ctx.strokeStyle = edge.color || '#000000';
        ctx.lineCap = 'square';
        const lineWidth = edge.width || 1;
        const style     = edge.style  || 'solid';
        const offset    = borderOffset(lineWidth);

        const adjust = (ax1, ay1, ax2, ay2) => {
            let bx1 = ax1, by1 = ay1, bx2 = ax2, by2 = ay2;
            if (position === 'top')    { by1 -= (offset - 0.5); by2 -= (offset - 0.5); }
            else if (position === 'bottom') { by1 += (offset - 0.5); by2 += (offset - 0.5); }
            else if (position === 'left')   { bx1 -= (offset - 0.5); bx2 -= (offset - 0.5); }
            else if (position === 'right')  { bx1 += (offset - 0.5); bx2 += (offset - 0.5); }
            return [bx1, by1, bx2, by2];
        };

        if (style === 'double') {
            ctx.lineWidth = 1;
            ctx.setLineDash([]);
            const gap = 2;
            const isH = (y1 === y2);
            let [ax1, ay1, ax2, ay2] = adjust(x1, y1, x2, y2);
            if (isH) { ay1 -= gap; ay2 -= gap; } else { ax1 -= gap; ax2 -= gap; }
            ctx.beginPath(); ctx.moveTo(ax1, ay1); ctx.lineTo(ax2, ay2); ctx.stroke();
            let [bx1, by1, bx2, by2] = adjust(x1, y1, x2, y2);
            if (isH) { by1 += gap; by2 += gap; } else { bx1 += gap; bx2 += gap; }
            ctx.beginPath(); ctx.moveTo(bx1, by1); ctx.lineTo(bx2, by2); ctx.stroke();
        } else {
            ctx.lineWidth = lineWidth;
            ctx.setLineDash(style === 'dashed' ? [4, 4] : []);
            const [ax1, ay1, ax2, ay2] = adjust(x1, y1, x2, y2);
            ctx.beginPath(); ctx.moveTo(ax1, ay1); ctx.lineTo(ax2, ay2); ctx.stroke();
            if (style === 'dashed') ctx.setLineDash([]);
        }
    };

    if (borders.top)    paintEdge(borders.top,    x,     y,     x + w, y,     'top');
    if (borders.right)  paintEdge(borders.right,  x + w, y,     x + w, y + h, 'right');
    if (borders.bottom) paintEdge(borders.bottom, x,     y + h, x + w, y + h, 'bottom');
    if (borders.left)   paintEdge(borders.left,   x,     y,     x,     y + h, 'left');
    ctx.lineCap = 'butt'; // restore default
}

// ── PDF (jsPDF) painter ─────────────────────────────────────────────────────────

/**
 * Paint custom borders on a jsPDF document for a single cell.
 * Coordinates in mm; lineWidths are converted from CSS px using px2mmFn.
 *
 * @param {import('jspdf').jsPDF} pdf
 * @param {{ top?, right?, bottom?, left? }} borders
 * @param {number} cx  Cell left mm
 * @param {number} cy  Cell top  mm
 * @param {number} cw  Cell width  mm
 * @param {number} ch  Cell height mm
 * @param {(color: string, fallback?: [number,number,number]) => [number,number,number]} parseColorFn
 *   Convert a CSS color string to [r, g, b]. Pass in VectorPrintEngine's parseColor.
 */
export function paintBordersVec(pdf, borders, cx, cy, cw, ch, parseColorFn) {
    pdf.setLineCap(2); // square — extends stroke past endpoints to fill corners

    const edge = (b, x1, y1, x2, y2) => {
        if (!b) return;
        const [r, g, b_] = parseColorFn(b.color || '#000000', [0, 0, 0]);
        pdf.setDrawColor(r, g, b_);
        const lineW = Math.max(0.1, (b.width || 1) * 0.264);
        const style = b.style || 'solid';

        if (style === 'double') {
            pdf.setLineWidth(0.2);
            const gap = 0.5;
            const isH = (y1 === y2);
            if (isH) {
                pdf.line(x1, y1 - gap, x2, y2 - gap);
                pdf.line(x1, y1 + gap, x2, y2 + gap);
            } else {
                pdf.line(x1 - gap, y1, x2 - gap, y2);
                pdf.line(x1 + gap, y1, x2 + gap, y2);
            }
        } else if (style === 'dashed') {
            pdf.setLineWidth(lineW);
            pdf.setLineDashPattern([1.5, 1.5], 0);
            pdf.line(x1, y1, x2, y2);
            pdf.setLineDashPattern([], 0);
        } else {
            pdf.setLineWidth(lineW);
            pdf.line(x1, y1, x2, y2);
        }
    };

    edge(borders.top,    cx,      cy,      cx + cw, cy     );
    edge(borders.right,  cx + cw, cy,      cx + cw, cy + ch);
    edge(borders.bottom, cx,      cy + ch, cx + cw, cy + ch);
    edge(borders.left,   cx,      cy,      cx,      cy + ch);
    pdf.setLineCap(0); // restore butt
}
