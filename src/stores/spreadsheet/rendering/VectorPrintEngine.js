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

// State-dedup cache for the STROKING color and line width only. jsPDF re-emits a
// state operator on every set*() call even when unchanged, bloating the content
// stream (and slowing viewers, which re-apply state on each repaint); skipping the
// redundant sets is a meaningful win for the thousands of gridline/border strokes.
//
// IMPORTANT: this only covers stroke color + line width. The *fill* (non-stroking)
// color is deliberately NOT cached, because jsPDF paints text glyphs with the fill
// color — so every pdf.text() silently changes the PDF's current fill register
// behind our back. A fill-color cache would then wrongly skip a needed
// setFillColor and later cells would inherit the dark text color as their
// background (green header cells rendered black). Always emitting fill is cheap
// (≤1–2 fills per cell) and correct.
//
// Invalidated on every save/restoreGraphicsState (clip boundary), where the PDF
// graphics state resets — see resetStateCache(), called by beginClip/endClip.
let _lastDraw = null, _lastLineW = null;
function resetStateCache() { _lastDraw = _lastLineW = null; }

function setFillRgb(pdf, r, g, b) {
    pdf.setFillColor(r, g, b);
}
function setDrawRgb(pdf, r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    if (key === _lastDraw) return;
    _lastDraw = key;
    pdf.setDrawColor(r, g, b);
}
function setLineW(pdf, w) {
    if (w === _lastLineW) return;
    _lastLineW = w;
    pdf.setLineWidth(w);
}

function setFill(pdf, color, fallback = [255, 255, 255]) {
    pdf.setFillColor(...parseColor(color, fallback));
}
function setDraw(pdf, color, fallback = [0, 0, 0]) {
    setDrawRgb(pdf, ...parseColor(color, fallback));
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
    resetStateCache(); // graphics state is pushed — cached color/lineW no longer valid
    pdf.rect(x, y, w, h, null); // add rect to current path without painting
    pdf.clip();                  // "W" — mark current path as clip
    pdf.discardPath();           // "n" — terminate path (required after W)
}

function endClip(pdf) {
    pdf.restoreGraphicsState();
    resetStateCache(); // graphics state is popped — restores prior (unknown to us) values
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

/** Load a data URL into an Image element (resolves null on error). */
function loadImage(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

// Target resolution for embedded raster images. 150 DPI is visually crisp for
// print/screen while keeping file size low; full-res source photos (often 300+
// DPI at display size) are downsampled to this before embedding.
const IMAGE_TARGET_DPI = 150;
// Above this JPEG quality we keep the original PNG only when it has alpha.
const JPEG_QUALITY = 0.82;

/**
 * Downscale a source image to at most (maxW × maxH) device pixels and re-encode.
 * Photographic content → JPEG (much smaller); images with alpha → PNG to keep
 * transparency. Returns a data URL plus the image's natural aspect dimensions.
 *
 * @param {HTMLImageElement} img    Loaded source image
 * @param {number} maxW maxH        Target pixel budget (the largest the image is
 *                                  drawn anywhere in the document, at target DPI)
 * @param {boolean} hasAlpha        Whether the source may contain transparency
 * @returns {{ dataUrl:string, naturalW:number, naturalH:number }}
 */
function encodeScaledImage(img, maxW, maxH, hasAlpha) {
    const srcW = img.naturalWidth, srcH = img.naturalHeight;
    if (!srcW || !srcH) return { dataUrl: img.src, naturalW: srcW, naturalH: srcH };

    // Never upscale — cap the target at the source resolution.
    const scale = Math.min(1, maxW / srcW, maxH / srcH);
    const outW = Math.max(1, Math.round(srcW * scale));
    const outH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: img.src, naturalW: srcW, naturalH: srcH };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (!hasAlpha) {
        // Flatten onto white so JPEG (no alpha) matches the canvas composite.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);
    }
    ctx.drawImage(img, 0, 0, outW, outH);

    const dataUrl = hasAlpha
        ? canvas.toDataURL('image/png')
        : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return { dataUrl, naturalW: srcW, naturalH: srcH };
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
        setDrawRgb(pdf, 255, 255, 255);
        setLineW(pdf, Math.max(0.3, size * 0.12));
        pdf.setLineCap('round');
        pdf.setLineJoin('round');
        pdf.lines(
            [[size * 0.22, size * 0.20], [size * 0.38, -size * 0.44]],
            bx + size * 0.20, by + size * 0.52,
            [1, 1], 'S', false
        );
    } else {
        setFillRgb(pdf, 255, 255, 255);
        setDraw(pdf, '#c0c0c0');
        setLineW(pdf, Math.max(0.1, size * 0.05));
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
        setLineW(pdf, Math.max(0.05, outerR * 0.05));
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
                setLineW(pdf, Math.max(0.05, 0.2 * s));
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
        setLineW(pdf, Math.max(0.05, 0.2 * s));
        if (cell.underline)     pdf.line(decorX, midY + pt2mm(sizePt * 0.55, s), decorX + clampedW, midY + pt2mm(sizePt * 0.55, s));
        if (cell.strikethrough) pdf.line(decorX, midY,                            decorX + clampedW, midY);
    }
}

// ── Border painter ─────────────────────────────────────────────────────────────

/** Delegates to the shared BorderGeometry module (single source of truth). */
function drawBordersVec(pdf, borders, x, y, w, h, s = 1) {
    paintBordersVec(pdf, borders, x, y, w, h, parseColor, s);
}

// ── In-cell image painter ───────────────────────────────────────────────────────

/**
 * Render an `image` cell type by embedding its preloaded raster. Mirrors
 * CanvasRenderer's imageType.paintCell: a 3px inset, clip to the padded box,
 * and the same contain/cover/fill/none fit modes. Coordinates are in mm.
 *
 * If the asset failed to preload, draws nothing (the white cell background plus
 * grid/borders still render) rather than leaking the blobId as text.
 */
function drawCellImage(pdf, cell, cx, cy, cw, ch, imgAssets) {
    const blobId = cell.rawValue;
    const asset  = blobId && imgAssets?.get(blobId);
    if (!asset || !asset.naturalW || !asset.naturalH) return;

    const pad = px2mm(3, 1); // 3 CSS px inset, scale-independent like canvas pad
    const bx = cx + pad, by = cy + pad;
    const bw = cw - 2 * pad, bh = ch - 2 * pad;
    if (bw <= 0 || bh <= 0) return;

    const fit = cell.ctConfig?.fit ?? 'contain';
    const sa  = asset.naturalW / asset.naturalH;
    const da  = bw / bh;

    let dx = bx, dy = by, dw = bw, dh = bh;
    if (fit === 'fill') {
        // stretch — already set
    } else if (fit === 'none') {
        // Natural size (in CSS px → mm), centered; clip handles overflow.
        dw = px2mm(asset.naturalW, 1); dh = px2mm(asset.naturalH, 1);
        dx = bx + (bw - dw) / 2;       dy = by + (bh - dh) / 2;
    } else if (fit === 'cover') {
        if (sa > da) { dw = bh * sa; dx = bx + (bw - dw) / 2; }
        else         { dh = bw / sa; dy = by + (bh - dh) / 2; }
    } else { // 'contain' (default) — center, fit within box
        if (sa > da) { dh = bw / sa; dy = by + (bh - dh) / 2; }
        else         { dw = bh * sa; dx = bx + (bw - dw) / 2; }
    }

    const fmt = asset.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
    beginClip(pdf, bx, by, bw, bh);
    pdf.addImage(asset.dataUrl, fmt, dx, dy, dw, dh, undefined, 'FAST');
    endClip(pdf);
}

// ── Main cell painter ──────────────────────────────────────────────────────────

function drawCell(pdf, cell, pageX, pageY, s, showGridLines, imgAssets, gridSegs) {
    const cx = pageX + px2mm(cell.x, s);
    const cy = pageY + px2mm(cell.y, s);
    const cw = px2mm(cell.width,  s);
    const ch = px2mm(cell.height, s);
    if (cw <= 0 || ch <= 0) return;

    // Overflow-shadow cell: skip content, draw gridlines and borders at natural boundary.
    // Mirrors CanvasRenderer: right gridline suppressed, bottom suppressed when a custom
    // bottom border exists, and borders rendered so horizontal run borders are continuous.
    if (cell.gridlineOnly) {
        if (showGridLines && !cell.borders?.bottom) {
            // Bottom gridline only; right suppressed (overflow shadow — matches
            // CanvasRenderer). Collected for batched stroking by renderCells.
            gridSegs.push([cx, cy + ch, cx + cw, cy + ch]);
        }
        // Borders for shadow cells are drawn in the separate border pass.
        return;
    }

    // ── 1. Background ─────────────────────────────────────────────────────────
    // The page is already painted white by renderCells, so no per-cell white base
    // is needed. The tint overlays below are pre-blended-on-white opaque constants,
    // so each cell emits at most one fill rect (and most emit none).
    const bg = cell.bgColor;
    if (bg && !bg.startsWith('rgba(0,0,0,0')) {
        setFill(pdf, bg);
        pdf.rect(cx, cy, cw, ch, 'F');
    } else if (cell.zebraRow) {
        // Zebra striping — rgba(0,0,0,0.018) over white ≈ (250,250,250)
        setFillRgb(pdf, 250, 250, 250);
        pdf.rect(cx, cy, cw, ch, 'F');
    }

    // Formula column tint — rgba(0,0,0,0.015) over white ≈ (251,251,251)
    if (cell.isFormulaCol) {
        setFillRgb(pdf, 251, 251, 251);
        pdf.rect(cx, cy, cw, ch, 'F');
    }

    // Repeater copy overlay — rgba(124,58,237,0.028) over white ≈ (251,250,255)
    if (cell.isRepeaterCopy) {
        setFillRgb(pdf, 251, 250, 255);
        pdf.rect(cx, cy, cw, ch, 'F');
    }

    // ── 2. Data validation invalid — red outline (before content, matches CanvasRenderer) ──
    if (cell.dvInvalid) {
        setDraw(pdf, '#ef4444');
        const dvW = Math.max(0.1, 0.4 * s);
        const inset = dvW / 2;
        setLineW(pdf, dvW);
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
                setLineW(pdf, 0.1);
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

        case 'image':
            // In-cell image: embed the scaled raster if it preloaded, matching
            // CanvasRenderer's imageType.paintCell (3px pad, same fit modes).
            drawCellImage(pdf, cell, cx, cy, cw, ch, imgAssets);
            break;

        default:
            // file / custom types: fall back to text representation
            drawTextContent(pdf, cell, cx, cy, cw, ch, s);
            break;
    }

    // ── 4. Grid lines ─────────────────────────────────────────────────────────
    // Collected here and stroked in one batch by renderCells before the border
    // pass, so borders still render on top (matching CanvasRenderer). Each edge
    // is suppressed where a custom border exists so the gridline can't bleed
    // through thin or dashed borders.
    if (showGridLines) {
        const spec   = getOverflowBorderSpec(cell);
        const gridCx = pageX + px2mm(spec.boxX, s);
        const gridCw = px2mm(spec.boxWidth, s);
        if (!cell.borders?.right && !spec.suppressRightGridline) {
            gridSegs.push([gridCx + gridCw, cy, gridCx + gridCw, cy + ch]);
        }
        if (!cell.borders?.bottom) {
            gridSegs.push([gridCx, cy + ch, gridCx + gridCw, cy + ch]);
        }
    }
}

/**
 * Draw a cell's custom borders. Run as a separate pass after gridlines so
 * borders render on top (matching CanvasRenderer). Handles both normal cells
 * (overflow spec) and overflow-shadow cells (shadow spec, which suppresses inner
 * vertical bars through overflowing text).
 */
function drawCellBorders(pdf, cell, pageX, pageY, s) {
    if (!cell.borders) return;
    const cy = pageY + px2mm(cell.y, s);
    const ch = px2mm(cell.height, s);
    if (ch <= 0) return;

    const spec = cell.gridlineOnly ? getShadowBorderSpec(cell) : getOverflowBorderSpec(cell);
    if (spec.paintBorders) {
        const bx = pageX + px2mm(spec.boxX, s);
        const bw = px2mm(spec.boxWidth, s);
        drawBordersVec(pdf, spec.paintBorders, bx, cy, bw, ch, s);
    }
}

/**
 * Stroke a batch of axis-aligned gridline segments, merging collinear/contiguous
 * ones into long runs first. A row of per-cell bottom edges collapses into one
 * line; a column of right edges likewise. Color and line width are set once.
 *
 * @param {jsPDF}  pdf
 * @param {Array<[number,number,number,number]>} segs  [x1,y1,x2,y2] each
 * @param {number} s  userScale (gridline width tracks scale, as before)
 */
function strokeGridSegments(pdf, segs, s) {
    const EPS = 1e-4;
    const horiz = new Map(); // y → [[x1,x2], ...]
    const vert  = new Map(); // x → [[y1,y2], ...]
    const keyOf = (v) => Math.round(v / EPS); // quantize to dedupe float noise

    const pushRange = (map, k, range) => {
        let arr = map.get(k);
        if (!arr) map.set(k, arr = []);
        arr.push(range);
    };
    for (const [x1, y1, x2, y2] of segs) {
        if (Math.abs(y1 - y2) < EPS) {           // horizontal
            pushRange(horiz, keyOf(y1), [Math.min(x1, x2), Math.max(x1, x2), y1]);
        } else if (Math.abs(x1 - x2) < EPS) {    // vertical
            pushRange(vert, keyOf(x1), [Math.min(y1, y2), Math.max(y1, y2), x1]);
        }
    }

    const [r, g, b] = parseColor(DEFAULT_GRID_COLOR, [226, 232, 240]);
    setDrawRgb(pdf, r, g, b);
    setLineW(pdf, 0.13 * s);

    // Merge contiguous runs along an axis, then emit one line per merged run.
    const emitRuns = (groups, makeLine) => {
        for (const ranges of groups.values()) {
            ranges.sort((a, b) => a[0] - b[0]);
            let [lo, hi, fixed] = ranges[0];
            for (let i = 1; i < ranges.length; i++) {
                const [a, bb] = ranges[i];
                if (a <= hi + EPS) { if (bb > hi) hi = bb; }   // overlap/touch → extend
                else { makeLine(lo, hi, fixed); lo = a; hi = bb; }
            }
            makeLine(lo, hi, fixed);
        }
    };

    emitRuns(horiz, (x1, x2, y) => pdf.line(x1, y, x2, y));
    emitRuns(vert,  (y1, y2, x) => pdf.line(x, y1, x, y2));
}

// ── VectorPageRenderer — inline backend for PDFOrchestrator ──────────────────

class VectorPageRenderer {
    /** @type {Map<string, {dataUrl:string, naturalW:number, naturalH:number}>} */
    #imgAssets = new Map();
    #floatingImages = [];
    /** @type {Function|null} blobId → Promise<Blob> */
    #fetchBlobFn = null;
    /** Print user-scale, captured in prepare() for on-demand in-cell image loads. */
    #scale = 1;

    /**
     * Fetch a blob, downscale to (maxW × maxH) device px, and cache the encoded
     * asset under `blobId`. No-op if already cached or no fetcher is available.
     * @param {string} blobId
     * @param {number} maxW maxH  Target pixel budget
     */
    async #loadAsset(blobId, maxW, maxH) {
        if (!blobId || this.#imgAssets.has(blobId) || !this.#fetchBlobFn) return;
        try {
            const blob   = await this.#fetchBlobFn(blobId);
            const srcUrl = await blobToDataUrl(blob);
            const img    = await loadImage(srcUrl);
            if (!img) return;
            // PNG/GIF/SVG/WebP may carry alpha; JPEG never does.
            const hasAlpha = !/^data:image\/jpe?g/i.test(srcUrl);
            const asset    = encodeScaledImage(img, Math.max(1, Math.ceil(maxW)), Math.max(1, Math.ceil(maxH)), hasAlpha);
            this.#imgAssets.set(blobId, asset);
        } catch { /* skip images that fail to load */ }
    }

    /** CSS px → target device px at the current print scale and IMAGE_TARGET_DPI. */
    #dpiFactor() {
        return this.#scale * IMAGE_TARGET_DPI / CSS_PX_PER_INCH;
    }

    async prepare(params, geo) {
        const { fetchBlobFn = null, sheetStore } = params;
        this.#fetchBlobFn = fetchBlobFn;
        this.#scale = geo.s ?? 1;
        this.#floatingImages = [...(sheetStore?.floatingImages?.values() ?? [])];
        if (this.#floatingImages.length && fetchBlobFn) {
            // For each blob, the largest on-page footprint (in CSS px) it's drawn
            // at. The embedded raster only needs enough pixels to look crisp at
            // that size and the print scale — so we cap resolution per blob.
            const maxDisplay = new Map(); // blobId → { w, h } in CSS px
            for (const f of this.#floatingImages) {
                const cur = maxDisplay.get(f.blobId);
                maxDisplay.set(f.blobId, {
                    w: Math.max(cur?.w ?? 0, f.width),
                    h: Math.max(cur?.h ?? 0, f.height),
                });
            }
            const dpiFactor = this.#dpiFactor();
            await Promise.all([...maxDisplay.keys()].map(blobId => {
                const disp = maxDisplay.get(blobId);
                return this.#loadAsset(blobId, disp.w * dpiFactor, disp.h * dpiFactor);
            }));
        }
    }

    async renderCells(pdf, cells, pd, _params) {
        const { geo, s, showGridLines } = pd;
        const { marginLeft, marginTop, printableW, printableH } = geo;

        // Preload any in-cell image assets on this page before drawing, sized to
        // the cell's footprint so we don't embed full-res photos for a thumbnail.
        const dpiFactor = this.#dpiFactor();
        await Promise.all(cells
            .filter(c => c.renderType === 'image' && c.rawValue)
            .map(c => this.#loadAsset(c.rawValue, c.width * dpiFactor, c.height * dpiFactor)));

        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, 0, geo.pageW, geo.pageH, 'F');

        // Expand the clip by ~1mm beyond the printable area so the outermost
        // custom borders (which sit centred on the cell boundary and overflow
        // by half their stroke width — up to ~0.4mm for a 3px border at s=1)
        // render fully instead of being half-clipped at the margin.
        const pad = 1;
        beginClip(pdf, marginLeft - pad, marginTop - pad, printableW + 2 * pad, printableH + 2 * pad);

        // Pass 1: backgrounds + content; gridline segments are collected, not drawn.
        const gridSegs = [];
        for (const cell of cells) {
            drawCell(pdf, cell, marginLeft, marginTop, s, showGridLines, this.#imgAssets, gridSegs);
        }

        // Pass 2: gridlines — merged into long polylines and stroked once. This
        // collapses thousands of per-cell line ops (a major PDF-viewer slowdown)
        // into a handful of operators.
        if (gridSegs.length) strokeGridSegments(pdf, gridSegs, s);

        // Pass 3: custom borders on top of gridlines (matches CanvasRenderer order).
        // drawBordersVec (BorderGeometry) sets draw color/width directly, bypassing
        // the dedup cache, so invalidate it afterwards to keep the cache honest.
        for (const cell of cells) {
            drawCellBorders(pdf, cell, marginLeft, marginTop, s);
        }
        resetStateCache();

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
            // Format is known from how we encoded in prepare(): JPEG for opaque
            // photos (embedded as a DCT stream — already compressed), PNG for
            // images with alpha. Passing it explicitly skips jsPDF's sniffing.
            const fmt = asset.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
            pdf.addImage(asset.dataUrl, fmt, dx, dy, dw, dh, undefined, 'FAST');
            endClip(pdf);
        }
    }

    cleanup() {
        this.#imgAssets.clear();
        this.#floatingImages = [];
        this.#fetchBlobFn = null;
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
