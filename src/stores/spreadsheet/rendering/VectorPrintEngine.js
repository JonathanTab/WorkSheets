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

import { buildWrappedLines } from './RichTextLayout.js';
import { orchestratePDF, downloadPDF as _downloadPDF } from './PDFOrchestrator.js';
import { CSS_PX_PER_INCH, MM_PER_INCH, parseCssColor } from './PrintShared.js';
import { paintBordersVec } from './BorderGeometry.js';
import { getOverflowBorderSpec, getShadowBorderSpec } from './OverflowGeometry.js';
import {
    checkboxLayout, ratingLayout, starVertices,
    CHECKBOX_MAX_SIZE, CHECKBOX_PADDING,
    RATING_MAX_SIZE, RATING_GAP,
} from './CellPrimitiveGeometry.js';
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

/** Thin wrapper to keep the local call sites short. */
const parseColor = parseCssColor;

function setFill(pdf, color, fallback = [255, 255, 255]) {
    pdf.setFillColor(...parseColor(color, fallback));
}
function setDraw(pdf, color, fallback = [0, 0, 0]) {
    pdf.setDrawColor(...parseColor(color, fallback));
}
const _defaultTextRgb = parseColor(DEFAULT_TEXT_COLOR);
function setTextCol(pdf, color, fallback = _defaultTextRgb) {
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
 * Returns the effective font size in points.
 *
 * @param {jsPDF} pdf
 * @param {Object} cell   CellPaintItem
 * @param {number} s      userScale
 * @param {Object} [run]  Rich-text run — may override b, i, f, ff
 * @returns {number}      Effective font size in points
 */
function applyFont(pdf, cell, s, run) {
    const bold   = run?.b !== undefined ? !!run.b : (cell.bold   || false);
    const italic = run?.i !== undefined ? !!run.i : (cell.italic || false);
    const style  = bold && italic ? 'bolditalic'
                 : bold           ? 'bold'
                 : italic         ? 'italic'
                 : 'normal';
    const family = mapFontFamily(run?.ff ?? cell.fontFamily);
    pdf.setFont(family, style);
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

// substituteVars, drawHF, computeUsedArea — imported from PrintShared.js

// ── Vector shape painters — use CellPrimitiveGeometry for shared layout math ────

function drawCheckboxVec(pdf, cx, cy, cw, ch, checked, s) {
    // CellPrimitiveGeometry constants are in px; convert to mm for this backend.
    const maxMm  = px2mm(CHECKBOX_MAX_SIZE, s);
    const padMm  = px2mm(CHECKBOX_PADDING,  s);
    const { x: ox, y: oy, size, radius } = checkboxLayout(cw, ch, {
        maxSize: maxMm, padding: padMm, minRadius: 0.2,
    });
    const bx = cx + ox;
    const by = cy + oy;

    if (checked) {
        setFill(pdf, '#1a73e8');
        pdf.roundedRect(bx, by, size, size, radius, radius, 'F');
        pdf.setDrawColor(255, 255, 255);
        pdf.setLineWidth(Math.max(0.3, size * 0.12));
        pdf.setLineCap('round');
        pdf.setLineJoin('round');
        pdf.lines(
            [[size * 0.22, size * 0.20], [size * 0.38, -size * 0.44]],
            bx + size * 0.20, by + size * 0.52,
            [1, 1], 'S', false
        );
    } else {
        pdf.setFillColor(255, 255, 255);
        setDraw(pdf, '#c0c0c0');
        pdf.setLineWidth(Math.max(0.1, size * 0.05));
        pdf.roundedRect(bx, by, size, size, radius, radius, 'FD');
    }
}

function drawRatingVec(pdf, cx, cy, cw, ch, value, max, s) {
    const maxMm = px2mm(RATING_MAX_SIZE, s);
    const gapMm = px2mm(RATING_GAP,      s);
    for (const { cx: scx, cy: scy, outerR, innerR, filled } of ratingLayout(value, max, cw, ch, { maxStarSize: maxMm, gap: gapMm })) {
        const verts = starVertices(cx + scx, cy + scy, outerR, innerR);
        const segs  = verts.slice(1).map((v, i) => [v[0] - verts[i][0], v[1] - verts[i][1]]);
        setFill(pdf, filled ? '#fbbc04' : '#d1d5db');
        setDraw(pdf, filled ? '#fbbc04' : '#d1d5db');
        pdf.setLineWidth(Math.max(0.05, outerR * 0.05));
        pdf.lines(segs, verts[0][0], verts[0][1], [1, 1], 'FD', true);
    }
}

// ── Rich-text content painter ──────────────────────────────────────────────────

/**
 * Word-wrap one '\n'-split line of rich-text runs to fit within maxW mm.
 * Delegates to the shared RichTextLayout algorithm with pdf.getStringUnitWidth
 * (via textWidthMm) as the width function.
 */
function wrapRichLine(pdf, runs, maxW, cell, s, defaultSizePt) {
    const withText = runs.filter(r => r.t);
    return buildWrappedLines(withText, maxW, (chunk, run) => {
        applyFont(pdf, cell, s, run);
        return textWidthMm(pdf, chunk, run.f || defaultSizePt, s);
    }).filter(l => l.length > 0);
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
                pdf.setLineWidth(Math.max(0.05, 0.2 * s));
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
        pdf.setLineWidth(Math.max(0.05, 0.2 * s));
        if (cell.underline)     pdf.line(decorX, midY + pt2mm(sizePt * 0.55, s), decorX + clampedW, midY + pt2mm(sizePt * 0.55, s));
        if (cell.strikethrough) pdf.line(decorX, midY,                            decorX + clampedW, midY);
    }
}

// ── Border painter ─────────────────────────────────────────────────────────────

/** Delegates to the shared BorderGeometry module (single source of truth). */
function drawBordersVec(pdf, borders, x, y, w, h, s = 1) {
    paintBordersVec(pdf, borders, x, y, w, h, parseColor, s);
}

// ── Main cell painter ──────────────────────────────────────────────────────────

function drawCell(pdf, cell, pageX, pageY, s, showGridLines) {
    const cx = pageX + px2mm(cell.x, s);
    const cy = pageY + px2mm(cell.y, s);
    const cw = px2mm(cell.width,  s);
    const ch = px2mm(cell.height, s);
    if (cw <= 0 || ch <= 0) return;

    // Overflow-shadow cell: skip content, draw gridlines and borders at natural boundary.
    // Mirrors CanvasRenderer: right gridline suppressed, bottom suppressed when a custom
    // bottom border exists, and borders rendered so horizontal run borders are continuous.
    if (cell.gridlineOnly) {
        if (showGridLines) {
            const [r, g, b] = parseColor(DEFAULT_GRID_COLOR, [226, 232, 240]);
            pdf.setDrawColor(r, g, b);
            pdf.setLineWidth(0.13 * s);
            if (!cell.borders?.bottom) {
                pdf.line(cx, cy + ch, cx + cw, cy + ch);
            }
            // right gridline suppressed (overflow shadow — matches CanvasRenderer)
        }
        if (cell.borders) {
            // Shadow cells use the shadow spec so inner edges of an overflow
            // run don't draw vertical bars through the overflowing text.
            const spec = getShadowBorderSpec(cell);
            if (spec.paintBorders) {
                const bx = pageX + px2mm(spec.boxX, s);
                const bw = px2mm(spec.boxWidth, s);
                drawBordersVec(pdf, spec.paintBorders, bx, cy, bw, ch, s);
            }
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
        const dvW = Math.max(0.1, 0.4 * s);
        const inset = dvW / 2;
        pdf.setLineWidth(dvW);
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
        pdf.setLineWidth(0.13 * s);
        const spec = getOverflowBorderSpec(cell);
        const gridCx = pageX + px2mm(spec.boxX, s);
        const gridCw = px2mm(spec.boxWidth, s);
        if (!cell.borders?.right && !spec.suppressRightGridline) {
            pdf.line(gridCx + gridCw, cy,      gridCx + gridCw, cy + ch);
        }
        if (!cell.borders?.bottom) {
            pdf.line(gridCx,          cy + ch, gridCx + gridCw, cy + ch);
        }
    }

    // ── 5. Custom borders (after gridlines so they render on top) ─────────────
    if (cell.borders) {
        const spec = getOverflowBorderSpec(cell);
        if (spec.paintBorders) {
            const bx = pageX + px2mm(spec.boxX, s);
            const bw = px2mm(spec.boxWidth, s);
            drawBordersVec(pdf, spec.paintBorders, bx, cy, bw, ch, s);
        }
    }
}

// ── VectorPageRenderer — inline backend for PDFOrchestrator ──────────────────

class VectorPageRenderer {
    /** @type {Map<string, {dataUrl:string, naturalW:number, naturalH:number}>} */
    #imgAssets = new Map();
    #floatingImages = [];

    async prepare(params, _geo) {
        const { fetchBlobFn = null, sheetStore } = params;
        this.#floatingImages = [...(sheetStore?.floatingImages?.values() ?? [])];
        if (this.#floatingImages.length && fetchBlobFn) {
            const uniqueIds = [...new Set(this.#floatingImages.map(f => f.blobId))];
            await Promise.all(uniqueIds.map(async blobId => {
                try {
                    const blob    = await fetchBlobFn(blobId);
                    const dataUrl = await blobToDataUrl(blob);
                    const { w, h } = await getImgNaturalSize(dataUrl);
                    this.#imgAssets.set(blobId, { dataUrl, naturalW: w, naturalH: h });
                } catch { /* skip images that fail to load */ }
            }));
        }
    }

    renderCells(pdf, cells, pd, _params) {
        const { geo, s, showGridLines } = pd;
        const { marginLeft, marginTop, printableW, printableH } = geo;

        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, 0, geo.pageW, geo.pageH, 'F');

        // Expand the clip by ~1mm beyond the printable area so the outermost
        // custom borders (which sit centred on the cell boundary and overflow
        // by half their stroke width — up to ~0.4mm for a 3px border at s=1)
        // render fully instead of being half-clipped at the margin.
        const pad = 1;
        beginClip(pdf, marginLeft - pad, marginTop - pad, printableW + 2 * pad, printableH + 2 * pad);
        for (const cell of cells) {
            drawCell(pdf, cell, marginLeft, marginTop, s, showGridLines);
        }
        endClip(pdf);
    }

    renderExtras(pdf, pd, params) {
        const { geo, s, contentLeft, contentTop, contentW_css, contentH_css } = pd;
        const { marginLeft, marginTop, printableW, printableH } = geo;
        const { rowMetrics, colMetrics } = params;
        for (const img of this.#floatingImages) {
            const asset = this.#imgAssets.get(img.blobId);
            if (!asset) continue;
            // Clamp anchors so corrupt negative indices can't drag the placement
            // outside the page; offsetOf() can throw on negative inputs.
            const ar = Math.max(0, img.anchorRow);
            const ac = Math.max(0, img.anchorCol);
            const imgX = colMetrics.offsetOf(ac) + img.offsetX - contentLeft;
            const imgY = rowMetrics.offsetOf(ar) + img.offsetY - contentTop;
            if (imgX + img.width <= 0 || imgX >= contentW_css) continue;
            if (imgY + img.height <= 0 || imgY >= contentH_css) continue;
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
    }

    cleanup() {
        this.#imgAssets.clear();
        this.#floatingImages = [];
    }
}

// ── VectorPrintEngine class ────────────────────────────────────────────────────

export class VectorPrintEngine {
    /** @returns {Promise<Blob>} */
    async generatePDF(params) {
        return orchestratePDF(params, new VectorPageRenderer());
    }

    async downloadPDF(params, filename = 'spreadsheet.pdf') {
        return _downloadPDF(params, new VectorPageRenderer(), filename);
    }
}


export default VectorPrintEngine;
