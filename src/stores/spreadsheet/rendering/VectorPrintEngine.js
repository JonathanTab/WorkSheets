/**
 * VectorPrintEngine - Client-side PDF generation using jsPDF vector ops.
 *
 * Produces real searchable text, scalable vector shapes, and crisp lines
 * instead of a canvas bitmap. Cell backgrounds, borders, grid lines, text,
 * checkboxes, and rating stars are all drawn as native PDF primitives.
 *
 * Scale model:
 *   - CSS pixels → mm: px * userScale * 25.4 / 96
 *   - Font pt:          px * userScale * 72  / 96
 *
 * ## Clipping note (jsPDF 4.x)
 *   pdf.clip() emits the PDF "W" operator (mark clip intent) but does NOT
 *   emit "n" (path terminator). You MUST call pdf.discardPath() after
 *   pdf.clip() so the path is cleared; otherwise the next fill/stroke
 *   command merges with the clip path and corrupts the clip region.
 */

import { jsPDF } from 'jspdf';
import { buildPaneData } from './CellPaintData.js';
import { PrintEngine } from '../features/PrintEngine.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const PAPER_SIZES = {
    A4:     { width: 210,   height: 297   },
    letter: { width: 215.9, height: 279.4 },
    legal:  { width: 215.9, height: 355.6 },
    A3:     { width: 297,   height: 420   },
    A5:     { width: 148,   height: 210   },
};

const CSS_PX_PER_INCH   = 96;
const MM_PER_INCH       = 25.4;
const PT_PER_INCH       = 72;
const DEFAULT_FONT_PX   = 12;
const DEFAULT_TEXT_COLOR = '#1e293b';
const DEFAULT_GRID_COLOR = '#e2e8f0';
const ACCENT_BAR_PX     = 3;

// ── Unit helpers ───────────────────────────────────────────────────────────────

function px2mm(px, s) { return px * s * MM_PER_INCH / CSS_PX_PER_INCH; }
function px2pt(px, s) { return px * s * PT_PER_INCH / CSS_PX_PER_INCH; }

// ── Color helpers ──────────────────────────────────────────────────────────────

function parseColor(color, fallback = [0, 0, 0]) {
    if (!color || typeof color !== 'string') return fallback;
    if (color.startsWith('#')) {
        const h = color.slice(1);
        if (h.length === 3) return [
            parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16),
        ];
        if (h.length === 6) return [
            parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
        ];
    }
    if (color.startsWith('rgba(')) {
        const m = color.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
        if (m) {
            const r = +m[1], g = +m[2], b = +m[3], a = +m[4];
            return [
                Math.round(255 * (1 - a) + r * a),
                Math.round(255 * (1 - a) + g * a),
                Math.round(255 * (1 - a) + b * a),
            ];
        }
    }
    if (color.startsWith('rgb(')) {
        const m = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
        if (m) return [+m[1], +m[2], +m[3]];
    }
    return fallback;
}

function setFill(pdf, color, fallback = [255, 255, 255]) {
    pdf.setFillColor(...parseColor(color, fallback));
}
function setDraw(pdf, color, fallback = [0, 0, 0]) {
    pdf.setDrawColor(...parseColor(color, fallback));
}
function setTextCol(pdf, color, fallback = parseColor(DEFAULT_TEXT_COLOR)) {
    pdf.setTextColor(...parseColor(color, fallback));
}

// ── Clipping ───────────────────────────────────────────────────────────────────

/**
 * Begin a rectangular clip region.
 *
 * IMPORTANT: jsPDF's clip() only emits "W" (set-clip intent); without a
 * subsequent "n" (discardPath), the active path bleeds into the next paint
 * command and corrupts the clip. Always pair with endClip().
 */
function beginClip(pdf, x, y, w, h) {
    pdf.saveGraphicsState();
    pdf.rect(x, y, w, h, null); // add rect to current path without painting
    pdf.clip();                  // "W" — mark current path as clip
    pdf.discardPath();           // "n" — terminate path (required after W)
}

function endClip(pdf) {
    pdf.restoreGraphicsState();
}

// ── Font helpers ───────────────────────────────────────────────────────────────

/**
 * Map a CSS font-family string to a jsPDF built-in font name.
 * jsPDF only has: helvetica (sans-serif), times (serif), courier (mono).
 */
function mapFontFamily(fontFamily) {
    if (!fontFamily) return 'helvetica';
    const f = fontFamily.toLowerCase();
    if (f.includes('courier') || f.includes('mono') || f.includes('code')) return 'courier';
    if (f.includes('times') || f.includes('georgia') || f.includes('serif')) return 'times';
    return 'helvetica';
}

/**
 * Set the jsPDF font from cell properties, with optional per-run overrides.
 * Returns the effective font size in CSS px.
 *
 * @param {jsPDF} pdf
 * @param {Object} cell   CellPaintItem
 * @param {number} s      userScale
 * @param {Object} [run]  Rich-text run — may override b, i, f, fontFamily
 * @returns {number}      Effective font size in CSS px
 */
function applyFont(pdf, cell, s, run) {
    const bold   = run?.b !== undefined ? !!run.b : (cell.bold   || false);
    const italic = run?.i !== undefined ? !!run.i : (cell.italic || false);
    const style  = bold && italic ? 'bolditalic'
                 : bold           ? 'bold'
                 : italic         ? 'italic'
                 : 'normal';
    const family = mapFontFamily(cell.fontFamily);
    pdf.setFont(family, style);
    const sizePx = run?.f || cell.fontSize || DEFAULT_FONT_PX;
    pdf.setFontSize(px2pt(sizePx, s));
    return sizePx;
}

/**
 * Measure a string's rendered width in mm at the current jsPDF font.
 */
function textWidthMm(pdf, text, sizePx, s) {
    if (!text) return 0;
    const pt = px2pt(sizePx, s);
    return pdf.getStringUnitWidth(text) * pt / pdf.internal.scaleFactor;
}

// ── Variable substitution ──────────────────────────────────────────────────────

function substituteVars(text, vars) {
    if (!text) return '';
    return text
        .replace(/\{page\}/g,      String(vars.page))
        .replace(/\{pages\}/g,     String(vars.pages))
        .replace(/\{sheetName\}/g, vars.sheetName ?? '')
        .replace(/\{docName\}/g,   vars.docName ?? '')
        .replace(/\{date\}/g,      vars.date)
        .replace(/\{time\}/g,      vars.time);
}

function drawHF(pdf, which, geo, texts) {
    const { pageW, pageH, marginTop, marginBottom, marginLeft, marginRight } = geo;
    const y = which === 'header' ? marginTop / 2 : pageH - marginBottom / 2;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(80, 80, 80);
    if (texts.left)   pdf.text(texts.left,   marginLeft,          y, { align: 'left',   baseline: 'middle' });
    if (texts.center) pdf.text(texts.center, pageW / 2,           y, { align: 'center', baseline: 'middle' });
    if (texts.right)  pdf.text(texts.right,  pageW - marginRight, y, { align: 'right',  baseline: 'middle' });
}

// ── Used-area detection ────────────────────────────────────────────────────────

function computeUsedArea(sheetStore) {
    let minRow = Infinity, maxRow = -Infinity;
    let minCol = Infinity, maxCol = -Infinity;
    sheetStore.cells.forEach((cell, key) => {
        if (!cell || !cell.exists) return;
        const comma = key.indexOf(',');
        const row = parseInt(key.slice(0, comma), 10);
        const col = parseInt(key.slice(comma + 1), 10);
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
    });
    if (maxRow < 0 || !isFinite(maxRow)) return null;
    return { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol };
}

// ── Vector shape painters ──────────────────────────────────────────────────────

function drawCheckboxVec(pdf, cx, cy, cw, ch, checked, s) {
    const sizeMm = Math.max(0.5, Math.min(px2mm(14, s), ch - px2mm(4, s), cw - px2mm(4, s)));
    const bx = cx + (cw - sizeMm) / 2;
    const by = cy + (ch - sizeMm) / 2;
    const radius = Math.max(0.2, sizeMm * 0.12);

    if (checked) {
        setFill(pdf, '#1a73e8');
        pdf.roundedRect(bx, by, sizeMm, sizeMm, radius, radius, 'F');
        // Checkmark
        pdf.setDrawColor(255, 255, 255);
        pdf.setLineWidth(Math.max(0.3, sizeMm * 0.12));
        pdf.setLineCap('round');
        pdf.setLineJoin('round');
        pdf.lines(
            [[sizeMm * 0.22, sizeMm * 0.20], [sizeMm * 0.38, -sizeMm * 0.44]],
            bx + sizeMm * 0.20,
            by + sizeMm * 0.52,
            [1, 1], 'S', false
        );
    } else {
        pdf.setFillColor(255, 255, 255);
        setDraw(pdf, '#c0c0c0');
        pdf.setLineWidth(0.2);
        pdf.roundedRect(bx, by, sizeMm, sizeMm, radius, radius, 'FD');
    }
}

function drawRatingVec(pdf, cx, cy, cw, ch, value, max, s) {
    const starSizePx = Math.min(Math.floor(ch / s * CSS_PX_PER_INCH / MM_PER_INCH) - 6, 16);
    const starSize   = px2mm(Math.max(2, starSizePx), s);
    const outerR     = starSize / 2;
    const innerR     = outerR * 0.4;
    const gapMm      = px2mm(2, s);
    const totalW     = max * (starSize + gapMm) - gapMm;
    const startCx    = cx + (cw - totalW) / 2 + outerR;
    const starCy     = cy + ch / 2;
    const numPts     = 5;
    const step       = Math.PI / numPts;

    for (let i = 0; i < max; i++) {
        const scx    = startCx + i * (starSize + gapMm);
        const filled = i < value;
        const coords = [];
        for (let p = 0; p < 2 * numPts; p++) {
            const r     = p % 2 === 0 ? outerR : innerR;
            const angle = p * step - Math.PI / 2;
            coords.push([scx + r * Math.cos(angle), starCy + r * Math.sin(angle)]);
        }
        const segs = [];
        for (let j = 1; j < coords.length; j++) {
            segs.push([coords[j][0] - coords[j - 1][0], coords[j][1] - coords[j - 1][1]]);
        }
        setFill(pdf, filled ? '#fbbc04' : '#d1d5db');
        setDraw(pdf, filled ? '#fbbc04' : '#d1d5db');
        pdf.setLineWidth(0.1);
        pdf.lines(segs, coords[0][0], coords[0][1], [1, 1], 'FD', true);
    }
}

// ── Rich-text content painter ──────────────────────────────────────────────────

/**
 * Render a cell's richTextRuns array as per-run styled PDF text.
 * Runs are split on '\n' to form visual lines; each run may override
 * bold, italic, font-size, color, underline, and strikethrough.
 * The entire cell area is clipped so runs never bleed outside the cell.
 *
 * @param {jsPDF}  pdf
 * @param {Object} cell          CellPaintItem
 * @param {number} cx cy cw ch   Cell bounds in mm
 * @param {number} s             userScale
 * @param {string} [overrideColor]  Force all run text to this color
 */
function drawRichTextContent(pdf, cell, cx, cy, cw, ch, s, overrideColor) {
    const runs = cell.richTextRuns;
    if (!runs || runs.length === 0) return;

    const hAlign       = cell.hAlign || 'left';
    const vAlign       = cell.vAlign || 'middle';
    const padMm        = px2mm(4, s);
    const defaultSizePx = cell.fontSize || DEFAULT_FONT_PX;

    // Split runs into visual lines by '\n' within run text
    const lines = [[]];
    for (const run of runs) {
        if (!run.t) continue;
        const parts = run.t.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) lines.push([]);
            if (parts[i]) lines[lines.length - 1].push({ ...run, t: parts[i] });
        }
    }

    // Use the same line-height multiplier as CanvasRenderer (1.5) for visual parity.
    const lineH  = px2mm(defaultSizePx * 1.5, s);
    const totalH = lines.length * lineH;

    // lineY = startY + li * lineH + halfFontMm  (baseline:'middle' offset)
    // mirrors canvas: lineY = startY + li * lineH  where startY already includes fontSize/2.
    const halfFontMm = px2mm(defaultSizePx / 2, s);

    // Minimum startY so first line doesn't appear above the top padding
    const minStartY = cy + padMm - halfFontMm;

    let startY;
    if (vAlign === 'top') {
        startY = cy + padMm - halfFontMm;  // first lineY = cy + padMm + halfFontMm ≈ canvas top
    } else if (vAlign === 'bottom') {
        startY = cy + ch - totalH;
    } else {
        // Center — clamp so first line doesn't bleed above top padding when overflowing
        startY = Math.max(cy + (ch - totalH) / 2, minStartY);
    }

    // Rich text always clips to cell bounds to prevent bleed
    beginClip(pdf, cx, cy, cw, ch);

    for (let li = 0; li < lines.length; li++) {
        const lineRuns = lines[li];
        if (!lineRuns.length) continue;

        // Vertical midpoint of this line (for baseline:'middle')
        const lineY = startY + li * lineH + halfFontMm;

        // Measure total line width for horizontal alignment
        let lineW = 0;
        for (const run of lineRuns) {
            const sizePx = run.f || defaultSizePx;
            applyFont(pdf, cell, s, run);
            lineW += textWidthMm(pdf, run.t, sizePx, s);
        }

        let runX;
        if (hAlign === 'right')       runX = cx + cw - padMm - lineW;
        else if (hAlign === 'center') runX = cx + (cw - lineW) / 2;
        else                          runX = cx + padMm;

        for (const run of lineRuns) {
            const sizePx = applyFont(pdf, cell, s, run);
            const color  = overrideColor || run.c || cell.textColor || DEFAULT_TEXT_COLOR;
            setTextCol(pdf, color);

            pdf.text(run.t, runX, lineY, { align: 'left', baseline: 'middle' });

            const runW = textWidthMm(pdf, run.t, sizePx, s);

            const doUnderline = run.u !== undefined ? !!run.u : (cell.underline || false);
            const doStrike    = run.s !== undefined ? !!run.s : (cell.strikethrough || false);

            if (doUnderline || doStrike) {
                setDraw(pdf, color);
                pdf.setLineWidth(0.2);
                if (doUnderline) pdf.line(runX, lineY + px2mm(sizePx * 0.6, s),  runX + runW, lineY + px2mm(sizePx * 0.6, s));
                if (doStrike)    pdf.line(runX, lineY,                             runX + runW, lineY);
            }

            runX += runW;
        }
    }

    endClip(pdf);
}

// ── Plain-text content painter ─────────────────────────────────────────────────

/**
 * Draw text for a cell. Coordinates in mm.
 * - If cell.richTextRuns is set, delegates to drawRichTextContent.
 * - Wrapped text is clipped to cell bounds.
 * - Single-line text uses splitTextToSize for soft truncation (no per-cell clip),
 *   preserving text-overspill into adjacent empty cells (handled by buildPaneData
 *   extending cell.width for overflow cells).
 *
 * @param {jsPDF}  pdf
 * @param {Object} cell         CellPaintItem
 * @param {number} cx cy cw ch  Cell bounds in mm
 * @param {number} s            userScale
 * @param {string} [overrideColor]
 */
function drawTextContent(pdf, cell, cx, cy, cw, ch, s, overrideColor) {
    // Delegate rich text
    if (cell.richTextRuns?.length) {
        drawRichTextContent(pdf, cell, cx, cy, cw, ch, s, overrideColor);
        return;
    }

    const text = cell.displayValue;
    if (!text) return;

    const sizePx = applyFont(pdf, cell, s);
    setTextCol(pdf, overrideColor || cell.textColor || DEFAULT_TEXT_COLOR);

    const padMm    = px2mm(4, s);
    const hAlign   = cell.hAlign || 'left';
    const vAlign   = cell.vAlign || 'middle';
    const maxW     = cw - 2 * padMm;

    let textX;
    /** @type {'left'|'center'|'right'} */
    let jsPDFAlign;
    if (hAlign === 'center') {
        textX = cx + cw / 2; jsPDFAlign = 'center';
    } else if (hAlign === 'right') {
        textX = cx + cw - padMm; jsPDFAlign = 'right';
    } else {
        textX = cx + padMm; jsPDFAlign = 'left';
    }

    if (cell.wrapText) {
        // Wrap lines and clip to cell so they can't bleed below/outside.
        // Use baseline:'middle' throughout for consistent jsPDF rendering —
        // baseline:'top' support is unreliable across jsPDF versions.
        const lines  = pdf.splitTextToSize(text, maxW);
        const lineH  = px2mm(sizePx * 1.4, s);
        const totalH = lines.length * lineH;
        // lineY is the vertical center of the first line
        let lineY    = vAlign === 'top'    ? cy + padMm + lineH / 2
                     : vAlign === 'bottom' ? cy + ch - totalH + lineH / 2
                     : cy + (ch - totalH) / 2 + lineH / 2;

        beginClip(pdf, cx, cy, cw, ch);
        for (const line of lines) {
            pdf.text(line, textX, lineY, { align: jsPDFAlign, baseline: 'middle' });
            lineY += lineH;
        }
        endClip(pdf);
    } else {
        // Single line: no per-cell clip so that text can overspill into adjacent
        // empty cells (buildPaneData already extends cell.width for those cases).
        const lines = pdf.splitTextToSize(text, maxW);
        const line  = lines[0] ?? text;
        const lineH = px2mm(sizePx * 1.4, s);
        let textY;
        if (vAlign === 'top')         textY = cy + padMm + lineH / 2;
        else if (vAlign === 'bottom') textY = cy + ch - padMm - lineH / 2;
        else                          textY = cy + ch / 2;
        pdf.text(line, textX, textY, { align: jsPDFAlign, baseline: 'middle' });
    }

    // Underline / strikethrough decorations (plain text only; rich text handles per-run)
    if (cell.underline || cell.strikethrough) {
        const fontSizePt = px2pt(sizePx, s);
        const wMm = pdf.getStringUnitWidth(text) * fontSizePt / pdf.internal.scaleFactor;
        const clampedW = Math.min(wMm, maxW);
        let decorX;
        if (hAlign === 'center')      decorX = cx + cw / 2 - clampedW / 2;
        else if (hAlign === 'right')  decorX = cx + cw - padMm - clampedW;
        else                          decorX = cx + padMm;
        const midY = cy + ch / 2;
        setDraw(pdf, overrideColor || cell.textColor || DEFAULT_TEXT_COLOR);
        pdf.setLineWidth(0.2);
        if (cell.underline)     pdf.line(decorX, midY + px2mm(sizePx * 0.55, s), decorX + clampedW, midY + px2mm(sizePx * 0.55, s));
        if (cell.strikethrough) pdf.line(decorX, midY,                            decorX + clampedW, midY);
    }
}

// ── Border painter ─────────────────────────────────────────────────────────────

function drawBordersVec(pdf, borders, x, y, w, h) {
    const edge = (b, x1, y1, x2, y2) => {
        if (!b) return;
        setDraw(pdf, b.color, [0, 0, 0]);
        pdf.setLineWidth(Math.max(0.1, (b.width || 1) * 0.264));
        pdf.line(x1, y1, x2, y2);
    };
    edge(borders.top,    x,     y,     x + w, y    );
    edge(borders.right,  x + w, y,     x + w, y + h);
    edge(borders.bottom, x,     y + h, x + w, y + h);
    edge(borders.left,   x,     y,     x,     y + h);
}

// ── Main cell painter ──────────────────────────────────────────────────────────

function drawCell(pdf, cell, pageX, pageY, s, showGridLines) {
    const cx = pageX + px2mm(cell.x, s);
    const cy = pageY + px2mm(cell.y, s);
    const cw = px2mm(cell.width,  s);
    const ch = px2mm(cell.height, s);
    if (cw <= 0 || ch <= 0) return;

    // Overflow-shadow cell: skip content, only draw gridlines at natural boundary
    if (cell.gridlineOnly) {
        if (showGridLines) {
            const [r, g, b] = parseColor(DEFAULT_GRID_COLOR, [226, 232, 240]);
            pdf.setDrawColor(r, g, b);
            pdf.setLineWidth(0.13);
            pdf.line(cx + cw, cy,      cx + cw, cy + ch);
            pdf.line(cx,      cy + ch, cx + cw, cy + ch);
        }
        return;
    }

    // ── 1. Background ─────────────────────────────────────────────────────────
    const bg = cell.bgColor;
    if (bg && !bg.startsWith('rgba(0,0,0,0')) {
        setFill(pdf, bg);
        pdf.rect(cx, cy, cw, ch, 'F');
    }
    if (cell.zebraRow && !cell.bgColor) {
        pdf.setFillColor(246, 248, 250);
        pdf.rect(cx, cy, cw, ch, 'F');
    }
    if (cell.renderType === 'table_header') {
        pdf.setFillColor(241, 245, 249);
        pdf.rect(cx, cy, cw, ch, 'F');
    }
    if (cell.renderType === 'table_entry') {
        pdf.setFillColor(248, 250, 252);
        pdf.rect(cx, cy, cw, ch, 'F');
    }
    if (cell.isFormulaCol) {
        pdf.setFillColor(245, 243, 255);
        pdf.rect(cx, cy, cw, ch, 'F');
    }

    // ── 2. Accent decorations ─────────────────────────────────────────────────
    if (cell.renderType === 'table_header' && cell.tableAccentColor) {
        const [r, g, b] = parseColor(cell.tableAccentColor, [59, 130, 246]);
        pdf.setFillColor(r, g, b);
        pdf.rect(cx, cy, cw, px2mm(2, s), 'F'); // accent top stripe
    }
    if (cell.isFirstTableCol && cell.tableAccentColor) {
        const [r, g, b] = parseColor(cell.tableAccentColor, [59, 130, 246]);
        pdf.setFillColor(r, g, b);
        pdf.rect(cx, cy, px2mm(ACCENT_BAR_PX, s), ch, 'F');
    }

    // ── 3. Custom borders ─────────────────────────────────────────────────────
    if (cell.borders) drawBordersVec(pdf, cell.borders, cx, cy, cw, ch);

    // ── 4. Content ────────────────────────────────────────────────────────────
    const accentOff = cell.isFirstTableCol ? px2mm(ACCENT_BAR_PX, s) : 0;

    switch (cell.renderType) {
        case 'text':
        case 'dropdown':
            drawTextContent(pdf, cell, cx + accentOff, cy, cw - accentOff, ch, s);
            break;

        case 'url':
            drawTextContent(pdf, { ...cell, underline: true }, cx, cy, cw, ch, s, '#1a73e8');
            break;

        case 'checkbox':
            drawCheckboxVec(pdf, cx, cy, cw, ch, !!cell.rawValue, s);
            break;

        case 'rating':
            drawRatingVec(pdf, cx, cy, cw, ch, cell.rawValue ?? 0, cell.ratingMax ?? 5, s);
            break;

        case 'table_header': {
            const info = cell.tableHeaderInfo;
            if (!info) break;
            const padMm     = px2mm(4, s) + accentOff;
            const filterW   = px2mm(20, s);
            const textAreaW = Math.max(0.5, cw - padMm - filterW);
            const textY     = cy + ch / 2;

            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(px2pt(DEFAULT_FONT_PX, s));
            pdf.setTextColor(51, 65, 85);

            // Clip header text to its text area
            beginClip(pdf, cx + padMm, cy, textAreaW, ch);
            pdf.text(info.colName, cx + padMm, textY, { align: 'left', baseline: 'middle' });
            endClip(pdf);

            if (info.sortIcon) {
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(px2pt(8, s));
                const [r, g, b] = parseColor(info.accentColor, [59, 130, 246]);
                pdf.setTextColor(r, g, b);
                pdf.text(info.sortIcon, cx + cw - filterW / 2, textY, { align: 'center', baseline: 'middle' });
            }
            // Bottom border
            setDraw(pdf, '#94a3b8');
            pdf.setLineWidth(0.35);
            pdf.line(cx, cy + ch, cx + cw, cy + ch);
            break;
        }

        case 'table_entry': {
            if (cell.isNonEntryCol) {
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(px2pt(DEFAULT_FONT_PX, s));
                pdf.setTextColor(139, 92, 246);
                pdf.text('fx', cx + cw / 2, cy + ch / 2, { align: 'center', baseline: 'middle' });
            } else if (cell.displayValue) {
                drawTextContent(pdf, cell, cx + accentOff, cy, cw - accentOff, ch, s);
            }
            break;
        }
    }

    // ── 5. Grid lines ─────────────────────────────────────────────────────────
    if (showGridLines) {
        const [r, g, b] = parseColor(DEFAULT_GRID_COLOR, [226, 232, 240]);
        pdf.setDrawColor(r, g, b);
        pdf.setLineWidth(0.13);
        // Use naturalWidth for overflow cells so the right/bottom lines stay at
        // the original column boundary, not the extended spill edge.
        const gridCw = cell.naturalWidth ? px2mm(cell.naturalWidth, s) : cw;
        pdf.line(cx + gridCw, cy,      cx + gridCw, cy + ch); // right
        pdf.line(cx,          cy + ch, cx + gridCw, cy + ch); // bottom
    }
}

// ── VectorPrintEngine class ────────────────────────────────────────────────────

export class VectorPrintEngine {
    #printEngine;

    constructor() {
        this.#printEngine = new PrintEngine();
    }

    /**
     * Generate a PDF blob for the active sheet using vector ops.
     * @returns {Promise<Blob>}
     */
    async generatePDF(params) {
        const {
            printSettings = {},
            renderContext,
            sheetStore,
            session,
            rowMetrics,
            colMetrics,
            docName = '',
        } = params;

        const totalRows = renderContext?.effectiveRowCount ?? sheetStore?.rowCount ?? 100;
        const totalCols = renderContext?.effectiveColCount ?? sheetStore?.colCount ?? 26;

        // ── Paper geometry ────────────────────────────────────────────────────
        const orientation = printSettings.orientation ?? 'portrait';
        const paperKey    = printSettings.paperSize ?? 'A4';
        const paper       = PAPER_SIZES[paperKey] ?? PAPER_SIZES.A4;
        const pageW = orientation === 'landscape' ? paper.height : paper.width;
        const pageH = orientation === 'landscape' ? paper.width  : paper.height;

        const marginTop    = printSettings.marginTop    ?? 19;
        const marginBottom = printSettings.marginBottom ?? 19;
        const marginLeft   = printSettings.marginLeft   ?? 18;
        const marginRight  = printSettings.marginRight  ?? 18;

        const printableW = pageW  - marginLeft - marginRight;
        const printableH = pageH  - marginTop  - marginBottom;
        const s          = printSettings.scale ?? 1.0; // user scale

        // ── Print area ────────────────────────────────────────────────────────
        const printArea = printSettings.printArea ?? 'usedArea';
        let settingsForBreaks = { ...printSettings };
        if (printArea === 'usedArea') {
            const used = computeUsedArea(sheetStore);
            if (used) {
                settingsForBreaks.areaStartRow = used.startRow;
                settingsForBreaks.areaStartCol = used.startCol;
                settingsForBreaks.areaEndRow   = used.endRow;
                settingsForBreaks.areaEndCol   = used.endCol;
            }
        }

        // ── Page breaks ───────────────────────────────────────────────────────
        const { rowBreaks, colBreaks } = this.#printEngine.computePageBreaks(
            settingsForBreaks, rowMetrics, colMetrics, totalRows, totalCols,
        );

        // ── Options ───────────────────────────────────────────────────────────
        const showGridLines = printSettings.showGridLines ?? true;
        const pageOrder     = printSettings.pageOrder ?? 'downThenOver';

        // ── Header / footer ───────────────────────────────────────────────────
        const now        = new Date();
        const dateStr    = now.toLocaleDateString();
        const timeStr    = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const sheetName  = sheetStore?.name ?? '';
        const hfVarsBase = { sheetName, docName, date: dateStr, time: timeStr };
        const hasHeader  = printSettings.headerLeft || printSettings.headerCenter || printSettings.headerRight;
        const hasFooter  = printSettings.footerLeft || printSettings.footerCenter || printSettings.footerRight;
        const totalPages = rowBreaks.length * colBreaks.length;

        // ── Build page list ───────────────────────────────────────────────────
        const pages = [];
        if (pageOrder === 'overThenDown') {
            for (let ci = 0; ci < colBreaks.length; ci++)
                for (let ri = 0; ri < rowBreaks.length; ri++)
                    pages.push({ ri, ci });
        } else {
            for (let ri = 0; ri < rowBreaks.length; ri++)
                for (let ci = 0; ci < colBreaks.length; ci++)
                    pages.push({ ri, ci });
        }

        // ── Create PDF ────────────────────────────────────────────────────────
        const pdf = new jsPDF({ orientation, unit: 'mm', format: [pageW, pageH] });
        const geo = { pageW, pageH, marginTop, marginBottom, marginLeft, marginRight };
        let isFirstPage = true;
        let pageNum     = 0;

        // ── Render pages ──────────────────────────────────────────────────────
        for (const { ri, ci } of pages) {
            pageNum++;

            const startRow = rowBreaks[ri];
            const endRow   = ri + 1 < rowBreaks.length
                ? rowBreaks[ri + 1] - 1
                : (settingsForBreaks.areaEndRow ?? totalRows - 1);
            const startCol = colBreaks[ci];
            const endCol   = ci + 1 < colBreaks.length
                ? colBreaks[ci + 1] - 1
                : (settingsForBreaks.areaEndCol ?? totalCols - 1);

            const contentLeft = colMetrics.offsetOf(startCol);
            const contentTop  = rowMetrics.offsetOf(startRow);
            const rowRange    = { start: startRow, end: endRow, count: endRow - startRow + 1 };
            const colRange    = { start: startCol, end: endCol, count: endCol - startCol + 1 };

            // cell.x / cell.y are already 0-based relative to this page's content origin
            const cells = buildPaneData({
                rowRange, colRange, rowMetrics, colMetrics,
                renderContext, sheetStore, session,
                frozenRows: 0, frozenCols: 0, frozenHeight: 0, frozenWidth: 0,
                scrollLeft: contentLeft,
                scrollTop:  contentTop,
            });

            if (!isFirstPage) pdf.addPage([pageW, pageH], orientation);
            isFirstPage = false;

            // White background
            pdf.setFillColor(255, 255, 255);
            pdf.rect(0, 0, pageW, pageH, 'F');

            // Clip all cell drawing to the printable area so content doesn't
            // bleed into margins. Uses the corrected clip sequence: clip → discardPath.
            beginClip(pdf, marginLeft, marginTop, printableW, printableH);
            for (const cell of cells) {
                drawCell(pdf, cell, marginLeft, marginTop, s, showGridLines);
            }
            endClip(pdf);

            // Header / footer are drawn OUTSIDE the printable-area clip
            const hfVars = { ...hfVarsBase, page: pageNum, pages: totalPages };
            if (hasHeader) {
                drawHF(pdf, 'header', geo, {
                    left:   substituteVars(printSettings.headerLeft,   hfVars),
                    center: substituteVars(printSettings.headerCenter, hfVars),
                    right:  substituteVars(printSettings.headerRight,  hfVars),
                });
            }
            if (hasFooter) {
                drawHF(pdf, 'footer', geo, {
                    left:   substituteVars(printSettings.footerLeft,   hfVars),
                    center: substituteVars(printSettings.footerCenter, hfVars),
                    right:  substituteVars(printSettings.footerRight,  hfVars),
                });
            }
        }

        return pdf.output('blob');
    }

    async downloadPDF(params, filename = 'spreadsheet.pdf') {
        const blob = await this.generatePDF(params);
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

export default VectorPrintEngine;
