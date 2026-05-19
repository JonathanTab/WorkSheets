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
// fontSize values are stored in points (matching the UI picker and Google Sheets convention).
const DEFAULT_FONT_PT   = 10;
const DEFAULT_TEXT_COLOR = '#1e293b';
const DEFAULT_GRID_COLOR = '#e2e8f0';

// ── Unit helpers ───────────────────────────────────────────────────────────────

function px2mm(px, s) { return px * s * MM_PER_INCH / CSS_PX_PER_INCH; }
function px2pt(px, s) { return px * s * PT_PER_INCH / CSS_PX_PER_INCH; }
// pt2mm: convert a font-size (or other pt value) to mm at the given user scale.
function pt2mm(pt, s) { return pt * s * MM_PER_INCH / PT_PER_INCH; }

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
    // fontSize is stored in pt (matches UI picker / Google Sheets convention).
    // Apply user scale only — no px→pt conversion needed.
    const sizePt = run?.f || cell.fontSize || DEFAULT_FONT_PT;
    pdf.setFontSize(sizePt * s);
    return sizePt;
}

/**
 * Measure a string's rendered width in mm at the current jsPDF font.
 */
function textWidthMm(pdf, text, sizePt, s) {
    if (!text) return 0;
    const pt = sizePt * s;
    return pdf.getStringUnitWidth(text) * pt / pdf.internal.scaleFactor;
}

// ── Floating image helpers ─────────────────────────────────────────────────────

/** Convert a Blob to a base64 data URL. */
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(/** @type {string} */ (reader.result));
        reader.onerror   = reject;
        reader.readAsDataURL(blob);
    });
}

/** Load a data URL into an Image element and return its natural dimensions. */
function getImgNaturalSize(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = dataUrl;
    });
}

/**
 * Compute jsPDF draw rect for a given fit mode (all values in mm).
 * @returns {{ dx:number, dy:number, dw:number, dh:number }}
 */
function fitRectMm(srcW, srcH, dstX, dstY, dstW, dstH, fit) {
    if (!srcW || !srcH || !fit || fit === 'fill') return { dx: dstX, dy: dstY, dw: dstW, dh: dstH };
    const sa = srcW / srcH, da = dstW / dstH;
    if (fit === 'contain') {
        if (sa > da) { const dh = dstW / sa; return { dx: dstX, dy: dstY + (dstH - dh) / 2, dw: dstW, dh }; }
        else         { const dw = dstH * sa; return { dx: dstX + (dstW - dw) / 2, dy: dstY, dw, dh: dstH }; }
    }
    if (fit === 'cover') {
        if (sa > da) { const dw = dstH * sa; return { dx: dstX + (dstW - dw) / 2, dy: dstY, dw, dh: dstH }; }
        else         { const dh = dstW / sa; return { dx: dstX, dy: dstY + (dstH - dh) / 2, dw: dstW, dh }; }
    }
    if (fit === 'none') return { dx: dstX, dy: dstY, dw: srcW, dh: srcH };
    return { dx: dstX, dy: dstY, dw: dstW, dh: dstH };
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
 * Word-wrap one '\n'-split line of rich-text runs to fit within maxW mm.
 * Splits at whitespace boundaries; a single word wider than maxW is kept whole.
 * Returns an array of wrapped sub-lines, each being an array of run segments.
 */
function wrapRichLine(pdf, runs, maxW, cell, s, defaultSizePt) {
    const outLines = [[]];
    let curW = 0;   // mm used by committed segments in the current output line

    for (const run of runs) {
        if (!run.t) continue;
        applyFont(pdf, cell, s, run);
        const sizePt = run.f || defaultSizePt;

        // Tokenize: alternating word / whitespace chunks
        const chunks = run.t.split(/(\s+)/);
        let segText = '';
        let segW    = 0;

        for (const chunk of chunks) {
            if (!chunk) continue;
            const chunkW   = textWidthMm(pdf, chunk, sizePt, s);
            const isSpace  = /^\s+$/.test(chunk);

            if (!isSpace && curW + segW + chunkW > maxW && curW + segW > 0) {
                // Overflow — flush current segment, start new line
                const trimmed = segText.trimEnd();
                if (trimmed) outLines[outLines.length - 1].push({ ...run, t: trimmed });
                outLines.push([]);
                curW    = 0;
                segText = chunk;
                segW    = chunkW;
            } else {
                segText += chunk;
                segW    += chunkW;
            }
        }

        if (segText) {
            outLines[outLines.length - 1].push({ ...run, t: segText });
            curW += segW;
        }
    }

    return outLines.filter(l => l.length > 0);
}

/**
 * Render a cell's richTextRuns array as per-run styled PDF text.
 * Always word-wraps to match canvas behaviour (canvas ignores wrapText for rich text).
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

    const hAlign        = cell.hAlign || 'left';
    const vAlign        = cell.vAlign || 'middle';
    const padMm         = pt2mm(4, s);
    const maxW          = Math.max(1, cw - 2 * padMm);
    // fontSize is stored in pt (matches UI/Google Sheets convention).
    const defaultSizePt = cell.fontSize || DEFAULT_FONT_PT;

    // Step 1: split runs into raw lines on explicit '\n'
    const rawLines = [[]];
    for (const run of runs) {
        if (!run.t) continue;
        const parts = run.t.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) rawLines.push([]);
            if (parts[i]) rawLines[rawLines.length - 1].push({ ...run, t: parts[i] });
        }
    }

    // Step 2: word-wrap each raw line to fit maxW (always, matching canvas)
    const lines = [];
    for (const rawLine of rawLines) {
        if (rawLine.length === 0) { lines.push([]); continue; }
        const wrapped = wrapRichLine(pdf, rawLine, maxW, cell, s, defaultSizePt);
        if (wrapped.length === 0) lines.push([]);
        else for (const wl of wrapped) lines.push(wl);
    }

    // Line height = 1.5× font size, computed in mm from pt.
    const lineH      = pt2mm(defaultSizePt * 1.5, s);
    const halfFontMm = pt2mm(defaultSizePt / 2, s);
    const totalH     = lines.length * lineH;

    // startY = center of the first line (matches canvas convention).
    // top/bottom: offset by halfFontMm so the em-square touches the padding edge.
    // middle: block centered; lineH/2 places first line center at mid-slot.
    const minStartY = cy + padMm + halfFontMm;

    let startY;
    if (vAlign === 'top') {
        startY = minStartY;
    } else if (vAlign === 'bottom') {
        // Last line center at cy + ch - padMm - halfFontMm; solve for first line.
        startY = cy + ch - padMm - halfFontMm - (totalH - lineH);
    } else {
        // Center — clamp so first line doesn't bleed above top padding when overflowing
        startY = Math.max(cy + (ch - totalH) / 2 + lineH / 2, minStartY);
    }

    // Rich text always clips to cell bounds to prevent bleed
    beginClip(pdf, cx, cy, cw, ch);

    for (let li = 0; li < lines.length; li++) {
        const lineRuns = lines[li];
        if (!lineRuns.length) continue;

        // startY is the center of line 0; subsequent lines step by lineH.
        const lineY = startY + li * lineH;

        // Measure total line width for horizontal alignment
        let lineW = 0;
        for (const run of lineRuns) {
            const sizePt = run.f || defaultSizePt;
            applyFont(pdf, cell, s, run);
            lineW += textWidthMm(pdf, run.t, sizePt, s);
        }

        let runX;
        if (hAlign === 'right')       runX = cx + cw - padMm - lineW;
        else if (hAlign === 'center') runX = cx + (cw - lineW) / 2;
        else                          runX = cx + padMm;

        for (const run of lineRuns) {
            const sizePt = applyFont(pdf, cell, s, run);
            const color  = overrideColor || run.c || cell.textColor || DEFAULT_TEXT_COLOR;
            setTextCol(pdf, color);

            pdf.text(run.t, runX, lineY, { align: 'left', baseline: 'middle' });

            const runW = textWidthMm(pdf, run.t, sizePt, s);

            const doUnderline = run.u !== undefined ? !!run.u : (cell.underline || false);
            const doStrike    = run.s !== undefined ? !!run.s : (cell.strikethrough || false);

            if (doUnderline || doStrike) {
                setDraw(pdf, color);
                pdf.setLineWidth(0.2);
                if (doUnderline) pdf.line(runX, lineY + pt2mm(sizePt * 0.6, s),  runX + runW, lineY + pt2mm(sizePt * 0.6, s));
                if (doStrike)    pdf.line(runX, lineY,                             runX + runW, lineY);
            }

            runX += runW;
        }
    }

    endClip(pdf);
}

// ── Cell text painter ──────────────────────────────────────────────────────────

/**
 * Draw text for a cell. Coordinates in mm.
 * - Rich text (richTextRuns) and any wrapped/multi-line plain text delegate to
 *   drawRichTextContent for unified layout.
 * - True single-line text is drawn directly without a clip, preserving overspill
 *   into adjacent empty cells (buildPaneData extends cell.width for those).
 *
 * @param {jsPDF}  pdf
 * @param {Object} cell         CellPaintItem
 * @param {number} cx cy cw ch  Cell bounds in mm
 * @param {number} s            userScale
 * @param {string} [overrideColor]
 */
function drawTextContent(pdf, cell, cx, cy, cw, ch, s, overrideColor) {
    if (cell.richTextRuns?.length) {
        drawRichTextContent(pdf, cell, cx, cy, cw, ch, s, overrideColor);
        return;
    }

    const text = cell.displayValue;

    if ((!text || text === '') && cell.placeholderText) {
        pdf.setFont('helvetica', 'italic');
        pdf.setFontSize((cell.fontSize || DEFAULT_FONT_PT) * 0.9 * s);
        setTextCol(pdf, '#94a3b8');
        pdf.text(cell.placeholderText, cx + pt2mm(4, s), cy + ch / 2, { align: 'left', baseline: 'middle' });
        return;
    }

    if (!text) return;

    // Wrapped and multi-line text: delegate to rich-text path with a synthetic
    // single-run array. Matches CanvasRenderer's approach — no duplicate wrap logic.
    if (cell.wrapText || text.includes('\n')) {
        drawRichTextContent(pdf, { ...cell, richTextRuns: [{ t: text }] }, cx, cy, cw, ch, s, overrideColor);
        return;
    }

    // Single-line, no-wrap: draw without clip so text can overspill into adjacent empty cells.
    const sizePt     = applyFont(pdf, cell, s);
    setTextCol(pdf, overrideColor || cell.textColor || DEFAULT_TEXT_COLOR);

    const padMm      = pt2mm(4, s);
    const hAlign     = cell.hAlign || 'left';
    const vAlign     = cell.vAlign || 'middle';
    const halfFontMm = pt2mm(sizePt / 2, s);
    const maxW       = cw - 2 * padMm;

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

    let textY;
    if (vAlign === 'top')         textY = cy + padMm + halfFontMm;
    else if (vAlign === 'bottom') textY = cy + ch - padMm - halfFontMm;
    else                          textY = cy + ch / 2;

    // Draw the full text — no splitting. The page-level clip handles overflow,
    // matching canvas behaviour where single-line text overspills adjacent cells.
    pdf.text(text, textX, textY, { align: jsPDFAlign, baseline: 'middle' });

    if (cell.underline || cell.strikethrough) {
        const wMm      = textWidthMm(pdf, text, sizePt, s);
        const clampedW = Math.min(wMm, maxW);
        let decorX;
        if (hAlign === 'center')     decorX = cx + cw / 2 - clampedW / 2;
        else if (hAlign === 'right') decorX = cx + cw - padMm - clampedW;
        else                         decorX = cx + padMm;
        const midY = cy + ch / 2;
        setDraw(pdf, overrideColor || cell.textColor || DEFAULT_TEXT_COLOR);
        pdf.setLineWidth(0.2);
        if (cell.underline)     pdf.line(decorX, midY + pt2mm(sizePt * 0.55, s), decorX + clampedW, midY + pt2mm(sizePt * 0.55, s));
        if (cell.strikethrough) pdf.line(decorX, midY,                            decorX + clampedW, midY);
    }
}

// ── Border painter ─────────────────────────────────────────────────────────────

function drawBordersVec(pdf, borders, x, y, w, h) {
    // Square linecap extends stroke past endpoints, filling corner gaps when
    // adjacent edges meet at the same point.
    pdf.setLineCap(2); // 2 = square
    const edge = (b, x1, y1, x2, y2) => {
        if (!b) return;
        setDraw(pdf, b.color || '#000000', [0, 0, 0]);
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
    edge(borders.top,    x,     y,     x + w, y    );
    edge(borders.right,  x + w, y,     x + w, y + h);
    edge(borders.bottom, x,     y + h, x + w, y + h);
    edge(borders.left,   x,     y,     x,     y + h);
    pdf.setLineCap(0); // restore butt
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
    // Always paint a white base so transparent overlays below blend correctly.
    pdf.setFillColor(255, 255, 255);
    pdf.rect(cx, cy, cw, ch, 'F');

    const bg = cell.bgColor;
    if (bg && !bg.startsWith('rgba(0,0,0,0')) {
        setFill(pdf, bg);
        pdf.rect(cx, cy, cw, ch, 'F');
    }

    // Zebra striping — rgba(0,0,0,0.018) over white ≈ (250,250,250)
    if (cell.zebraRow && !cell.bgColor) {
        pdf.setFillColor(250, 250, 250);
        pdf.rect(cx, cy, cw, ch, 'F');
    }

    // Formula column tint — rgba(0,0,0,0.015) over white ≈ (251,251,251)
    if (cell.isFormulaCol) {
        pdf.setFillColor(251, 251, 251);
        pdf.rect(cx, cy, cw, ch, 'F');
    }

    // Repeater copy overlay — rgba(124,58,237,0.028) over white ≈ (251,250,255)
    if (cell.isRepeaterCopy) {
        pdf.setFillColor(251, 250, 255);
        pdf.rect(cx, cy, cw, ch, 'F');
    }

    // ── 2. Data validation invalid — red outline (before content, matches CanvasRenderer) ──
    if (cell.dvInvalid) {
        setDraw(pdf, '#ef4444');
        pdf.setLineWidth(0.4);
        const inset = 0.2;
        pdf.rect(cx + inset, cy + inset, cw - 2 * inset, ch - 2 * inset, 'S');
    }

    // ── 3. Content ────────────────────────────────────────────────────────────
    switch (cell.renderType) {
        case 'text':
        case 'dropdown':
            drawTextContent(pdf, cell, cx, cy, cw, ch, s);
            if (cell.renderType === 'dropdown') {
                // Dropdown chevron (▾) — matches CanvasRenderer #paintDropdownContent
                const arrowW  = px2mm(16, s);
                const arrowSz = px2mm(4, s);
                const arrowX  = cx + cw - arrowW / 2;
                const arrowY  = cy + ch / 2;
                setFill(pdf, '#64748b');
                setDraw(pdf, '#64748b');
                pdf.setLineWidth(0.1);
                pdf.lines(
                    [[arrowSz * 2, 0], [-arrowSz, arrowSz]],
                    arrowX - arrowSz, arrowY - arrowSz / 2,
                    [1, 1], 'F', true,
                );
            }
            break;

        case 'checkbox':
            drawCheckboxVec(pdf, cx, cy, cw, ch, !!cell.rawValue, s);
            break;

        case 'rating':
            drawRatingVec(pdf, cx, cy, cw, ch, cell.rawValue ?? 0, cell.ratingMax ?? 5, s);
            break;

        default:
            // image / file / custom types: fall back to text representation
            drawTextContent(pdf, cell, cx, cy, cw, ch, s);
            break;
    }

    // ── 4. Grid lines ─────────────────────────────────────────────────────────
    // Drawn before custom borders so borders render on top, matching CanvasRenderer.
    // Suppress each edge where a custom border exists so the gridline can't bleed
    // through thin or dashed borders.
    if (showGridLines) {
        const [r, g, b] = parseColor(DEFAULT_GRID_COLOR, [226, 232, 240]);
        pdf.setDrawColor(r, g, b);
        pdf.setLineWidth(0.13);
        // naturalWidth: for overflow cells right/bottom lines stay at original boundary
        const gridCw = cell.naturalWidth ? px2mm(cell.naturalWidth, s) : cw;
        if (!cell.borders?.right)  pdf.line(cx + gridCw, cy,      cx + gridCw, cy + ch);
        if (!cell.borders?.bottom) pdf.line(cx,          cy + ch, cx + gridCw, cy + ch);
    }

    // ── 5. Custom borders (after gridlines so they render on top) ─────────────
    if (cell.borders) drawBordersVec(pdf, cell.borders, cx, cy, cw, ch);
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
            fetchBlobFn = null,
        } = params;

        const totalRows = renderContext?.effectiveRowCount ?? sheetStore?.rowCount ?? 100;
        const totalCols = renderContext?.effectiveColCount ?? sheetStore?.colCount ?? 26;

        // ── Paper geometry ────────────────────────────────────────────────────
        const orientation = printSettings.orientation ?? 'portrait';
        const paperKey    = printSettings.paperSize ?? 'letter';
        const paper       = PAPER_SIZES[paperKey] ?? PAPER_SIZES.letter;
        const pageW = orientation === 'landscape' ? paper.height : paper.width;
        const pageH = orientation === 'landscape' ? paper.width  : paper.height;

        const marginTop    = printSettings.marginTop    ?? 19.05;
        const marginBottom = printSettings.marginBottom ?? 19.05;
        const marginLeft   = printSettings.marginLeft   ?? 19.05;
        const marginRight  = printSettings.marginRight  ?? 19.05;

        const printableW = pageW  - marginLeft - marginRight;
        const printableH = pageH  - marginTop  - marginBottom;
        const s          = printSettings.scale ?? 1.0; // user scale

        // ── Floating images list (needed for both area bounds and rendering) ──
        const floatingImages = [...(sheetStore?.floatingImages?.values() ?? [])];

        // ── Print area ────────────────────────────────────────────────────────
        const printArea = printSettings.printArea ?? 'usedArea';
        let settingsForBreaks = { ...printSettings };
        if (printArea === 'usedArea') {
            const used = computeUsedArea(sheetStore);
            let startRow = used?.startRow ?? 0;
            let startCol = used?.startCol ?? 0;
            let endRow   = used?.endRow   ?? -1;
            let endCol   = used?.endCol   ?? -1;
            // Extend bounds in all directions to fully cover floating images
            for (const img of floatingImages) {
                const imgRight  = colMetrics.offsetOf(img.anchorCol) + img.offsetX + img.width;
                const imgBottom = rowMetrics.offsetOf(img.anchorRow) + img.offsetY + img.height;
                if (imgRight  > 0) { const c = colMetrics.indexAtOffset(Math.max(0, imgRight  - 1)); if (c > endCol) endCol = c; }
                if (imgBottom > 0) { const r = rowMetrics.indexAtOffset(Math.max(0, imgBottom - 1)); if (r > endRow) endRow = r; }
                if (img.anchorRow < startRow) startRow = img.anchorRow;
                if (img.anchorCol < startCol) startCol = img.anchorCol;
            }
            if (endRow >= 0) {
                settingsForBreaks.areaStartRow = startRow;
                settingsForBreaks.areaStartCol = startCol;
                settingsForBreaks.areaEndRow   = endRow;
                settingsForBreaks.areaEndCol   = Math.max(endCol, 0);
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

        // ── Floating images: preload all unique blobs ─────────────────────────
        /** @type {Map<string, {dataUrl:string, naturalW:number, naturalH:number}>} */
        const imgAssets = new Map();
        if (floatingImages.length && fetchBlobFn) {
            const uniqueIds = [...new Set(floatingImages.map(f => f.blobId))];
            await Promise.all(uniqueIds.map(async (blobId) => {
                try {
                    const blob    = await fetchBlobFn(blobId);
                    const dataUrl = await blobToDataUrl(blob);
                    const { w, h } = await getImgNaturalSize(dataUrl);
                    imgAssets.set(blobId, { dataUrl, naturalW: w, naturalH: h });
                } catch { /* skip images that fail to load */ }
            }));
        }

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
            const pageContentW = colMetrics.offsetOf(endCol + 1) - contentLeft;
            const pageContentH = rowMetrics.offsetOf(endRow + 1) - contentTop;

            beginClip(pdf, marginLeft, marginTop, printableW, printableH);
            for (const cell of cells) {
                drawCell(pdf, cell, marginLeft, marginTop, s, showGridLines);
            }
            endClip(pdf);

            // Floating images: drawn outside the cell clip to avoid nested PDF clips.
            // Each image gets its own clip = intersection(image bounds, printable area).
            for (const img of floatingImages) {
                const asset = imgAssets.get(img.blobId);
                if (!asset) continue;
                const imgX = colMetrics.offsetOf(img.anchorCol) + img.offsetX - contentLeft;
                const imgY = rowMetrics.offsetOf(img.anchorRow) + img.offsetY - contentTop;
                if (imgX + img.width <= 0 || imgX >= pageContentW) continue;
                if (imgY + img.height <= 0 || imgY >= pageContentH) continue;
                const imgX_mm = marginLeft + px2mm(imgX, s);
                const imgY_mm = marginTop  + px2mm(imgY, s);
                const imgW_mm = px2mm(img.width,  s);
                const imgH_mm = px2mm(img.height, s);
                const { dx, dy, dw, dh } = fitRectMm(asset.naturalW, asset.naturalH, imgX_mm, imgY_mm, imgW_mm, imgH_mm, img.fit ?? 'contain');
                const clipX  = Math.max(imgX_mm, marginLeft);
                const clipY  = Math.max(imgY_mm, marginTop);
                const clipX2 = Math.min(imgX_mm + imgW_mm, marginLeft + printableW);
                const clipY2 = Math.min(imgY_mm + imgH_mm, marginTop  + printableH);
                if (clipX2 <= clipX || clipY2 <= clipY) continue;
                beginClip(pdf, clipX, clipY, clipX2 - clipX, clipY2 - clipY);
                pdf.addImage(asset.dataUrl, '', dx, dy, dw, dh, undefined, 'FAST');
                endClip(pdf);
            }

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
