/**
 * PrintShared.js — Single source of truth for print-side math and helpers.
 *
 * Owns:
 *   - PAPER_SIZES (canonical)
 *   - CSS_PX_PER_INCH, MM_PER_INCH, DEFAULT_PRINT_MARGIN_MM
 *   - parseCssColor() — handles #hex / rgb() / rgba() / common named CSS colors
 *   - computeUsedArea(sheetStore)
 *   - computePrintBounds(sheetStore, rowMetrics, colMetrics) — used-area extended for floating images
 *   - computePageBreaks(printSettings, rowMetrics, colMetrics, totalRows, totalCols)
 *   - substituteVars(), drawHF(), buildPageList(), buildHFVarsBase()
 */

// ── Constants ──────────────────────────────────────────────────────────────────

export const PAPER_SIZES = {
    A4:     { width: 210,   height: 297   },
    letter: { width: 215.9, height: 279.4 },
    legal:  { width: 215.9, height: 355.6 },
    A3:     { width: 297,   height: 420   },
    A5:     { width: 148,   height: 210   },
};

export const CSS_PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
/** Default page margin in mm (0.75 in × 25.4 mm/in) */
export const DEFAULT_PRINT_MARGIN_MM = 19.05;
const MM_TO_PX = CSS_PX_PER_INCH / MM_PER_INCH;

// ── Color parsing ──────────────────────────────────────────────────────────────

/** Minimal CSS named-color map. Covers the 17 standard names plus the common extras
 *  toolbar/import paths may emit. Unknown names fall through to the caller's fallback. */
const NAMED_COLORS = {
    transparent: null,
    black:   [0, 0, 0],       white:   [255, 255, 255],
    red:     [255, 0, 0],     lime:    [0, 255, 0],     blue:    [0, 0, 255],
    green:   [0, 128, 0],     yellow:  [255, 255, 0],   cyan:    [0, 255, 255],
    magenta: [255, 0, 255],   silver:  [192, 192, 192], gray:    [128, 128, 128],
    grey:    [128, 128, 128], maroon:  [128, 0, 0],     olive:   [128, 128, 0],
    purple:  [128, 0, 128],   teal:    [0, 128, 128],   navy:    [0, 0, 128],
    orange:  [255, 165, 0],   pink:    [255, 192, 203],
};

/**
 * Parse a CSS color into an [r, g, b] tuple. Accepts:
 *   - "#rgb" / "#rrggbb"
 *   - "rgb(r,g,b)" / "rgba(r,g,b,a)" — alpha is composited over `bg` (default white)
 *   - named CSS colors (limited set; see NAMED_COLORS)
 *
 * @param {string|null|undefined} color
 * @param {[number,number,number]} [fallback]
 * @param {[number,number,number]} [bg]  Background to composite rgba over (default white)
 * @returns {[number,number,number]}
 */
export function parseCssColor(color, fallback = [0, 0, 0], bg = [255, 255, 255]) {
    if (!color || typeof color !== 'string') return fallback;
    const c = color.trim();

    if (c[0] === '#') {
        const h = c.slice(1);
        if (h.length === 3) return [
            parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16),
        ];
        if (h.length === 6) return [
            parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
        ];
        return fallback;
    }

    if (c.startsWith('rgba')) {
        const m = c.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
        if (m) {
            const r = +m[1], g = +m[2], b = +m[3], a = +m[4];
            return [
                Math.round(bg[0] * (1 - a) + r * a),
                Math.round(bg[1] * (1 - a) + g * a),
                Math.round(bg[2] * (1 - a) + b * a),
            ];
        }
        return fallback;
    }

    if (c.startsWith('rgb')) {
        const m = c.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
        if (m) return [+m[1], +m[2], +m[3]];
        return fallback;
    }

    const named = NAMED_COLORS[c.toLowerCase()];
    if (named === null) return fallback;          // 'transparent'
    if (named) return /** @type {[number,number,number]} */ (named);

    return fallback;
}

// ── Used-area detection ────────────────────────────────────────────────────────

/**
 * Determine the bounding box of cells that actually have data.
 * Returns null if the sheet is empty.
 * @param {import('../SheetStore.svelte.js').SheetStore} sheetStore
 * @returns {{ startRow: number, startCol: number, endRow: number, endCol: number } | null}
 */
export function computeUsedArea(sheetStore) {
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

    if (!isFinite(maxRow) || maxRow < 0) return null;
    return { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol };
}

/**
 * Used-area bounds extended to cover any floating images on the sheet.
 * Returns null only when the sheet has no cells AND no images.
 *
 * Image anchors are clamped to non-negative indices so corrupt data can't
 * push the area below row/col 0.
 *
 * @param {import('../SheetStore.svelte.js').SheetStore} sheetStore
 * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} rowMetrics
 * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
 * @returns {{ startRow: number, startCol: number, endRow: number, endCol: number } | null}
 */
export function computePrintBounds(sheetStore, rowMetrics, colMetrics) {
    if (!sheetStore) return null;
    const cellBounds = computeUsedArea(sheetStore);
    const images = [...(sheetStore.floatingImages?.values() ?? [])];
    const merges = sheetStore.mergeEngine?.merges ?? [];
    if (!cellBounds && images.length === 0 && merges.length === 0) return null;

    let startRow = cellBounds?.startRow ?? Infinity;
    let startCol = cellBounds?.startCol ?? Infinity;
    let endRow   = cellBounds?.endRow   ?? -1;
    let endCol   = cellBounds?.endCol   ?? -1;

    // Extend bounds for merges — a merge anchored at the right edge of the used
    // area paints across its full span, so endCol/endRow must include it.
    for (const m of merges) {
        if (m.startRow < startRow) startRow = m.startRow;
        if (m.startCol < startCol) startCol = m.startCol;
        if (m.endRow   > endRow)   endRow   = m.endRow;
        if (m.endCol   > endCol)   endCol   = m.endCol;
    }

    for (const img of images) {
        const ar = Math.max(0, img.anchorRow);
        const ac = Math.max(0, img.anchorCol);
        if (ar < startRow) startRow = ar;
        if (ac < startCol) startCol = ac;

        const imgRight  = colMetrics.offsetOf(ac) + img.offsetX + img.width;
        const imgBottom = rowMetrics.offsetOf(ar) + img.offsetY + img.height;
        if (imgRight > 0) {
            const c = colMetrics.indexAtOffset(Math.max(0, imgRight - 1));
            if (c > endCol) endCol = c;
        }
        if (imgBottom > 0) {
            const r = rowMetrics.indexAtOffset(Math.max(0, imgBottom - 1));
            if (r > endRow) endRow = r;
        }
    }

    if (!isFinite(startRow)) startRow = 0;
    if (!isFinite(startCol)) startCol = 0;
    if (endRow < 0) endRow = startRow;
    if (endCol < 0) endCol = startCol;

    return { startRow, startCol, endRow, endCol };
}

// ── Page break computation ─────────────────────────────────────────────────────

/**
 * Compute row/column page-break indices for the given print settings.
 *
 * Algorithm: walk rows (then columns) accumulating offsets; whenever the
 * next row/col would push the page past the printable area, start a new page.
 * Manual breaks (`printSettings.pageBreakRows` / `pageBreakCols`) are merged
 * in after, then filtered to the active print area.
 *
 * A single row/col larger than the printable area gets its own page and is
 * clipped at the page boundary — that's the only sensible behavior, but
 * callers should be aware.
 *
 * @param {Object} printSettings
 * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} rowMetrics
 * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
 * @param {number} totalRows
 * @param {number} totalCols
 * @returns {{ rowBreaks: number[], colBreaks: number[] }}
 */
export function computePageBreaks(printSettings = {}, rowMetrics, colMetrics, totalRows, totalCols) {
    const orientation = printSettings.orientation ?? 'portrait';
    const paperKey    = printSettings.paperSize   ?? 'letter';
    const paper       = PAPER_SIZES[paperKey] ?? PAPER_SIZES.letter;
    const paperW = orientation === 'landscape' ? paper.height : paper.width;
    const paperH = orientation === 'landscape' ? paper.width  : paper.height;

    const marginTop    = printSettings.marginTop    ?? DEFAULT_PRINT_MARGIN_MM;
    const marginBottom = printSettings.marginBottom ?? DEFAULT_PRINT_MARGIN_MM;
    const marginLeft   = printSettings.marginLeft   ?? DEFAULT_PRINT_MARGIN_MM;
    const marginRight  = printSettings.marginRight  ?? DEFAULT_PRINT_MARGIN_MM;
    const scale = printSettings.scale ?? 1.0;

    // Printable area in CSS pixels at the chosen user scale.
    const printableH = ((paperH - marginTop - marginBottom) * MM_TO_PX) / scale;
    const printableW = ((paperW - marginLeft - marginRight) * MM_TO_PX) / scale;

    const areaStartRow = printSettings.areaStartRow ?? 0;
    const areaEndRow   = printSettings.areaEndRow   ?? totalRows - 1;
    const areaStartCol = printSettings.areaStartCol ?? 0;
    const areaEndCol   = printSettings.areaEndCol   ?? totalCols - 1;

    const rowBreaks = [areaStartRow];
    const colBreaks = [areaStartCol];

    if (!rowMetrics || !colMetrics) {
        return { rowBreaks, colBreaks };
    }

    // Small absolute tolerance (px) absorbs float-precision noise from the
    // fit-to-width round-trip: scale = printW_css/contentW_css, then
    // printableW = printW_css/scale doesn't always equal contentW_css exactly
    // in IEEE 754, leaving the final column ~1 ULP over the limit and forcing
    // a phantom page break. 1e-6 px is far below sub-pixel rendering.
    const EPS = 1e-6;

    let pageStart = rowMetrics.offsetOf(areaStartRow);
    for (let r = areaStartRow + 1; r <= areaEndRow; r++) {
        const rowBottom = rowMetrics.offsetOf(r + 1);
        if (rowBottom - pageStart > printableH + EPS) {
            rowBreaks.push(r);
            pageStart = rowMetrics.offsetOf(r);
        }
    }

    let pageLeft = colMetrics.offsetOf(areaStartCol);
    for (let c = areaStartCol + 1; c <= areaEndCol; c++) {
        const colRight = colMetrics.offsetOf(c + 1);
        if (colRight - pageLeft > printableW + EPS) {
            colBreaks.push(c);
            pageLeft = colMetrics.offsetOf(c);
        }
    }

    // Manual page breaks (if any). Filter to the active area so a stale
    // out-of-range break can't inflate the page count.
    const manualRowBreaks = (printSettings.pageBreakRows ?? [])
        .filter(r => r > areaStartRow && r <= areaEndRow);
    const manualColBreaks = (printSettings.pageBreakCols ?? [])
        .filter(c => c > areaStartCol && c <= areaEndCol);

    const allRowBreaks = [...new Set([...rowBreaks, ...manualRowBreaks])].sort((a, b) => a - b);
    const allColBreaks = [...new Set([...colBreaks, ...manualColBreaks])].sort((a, b) => a - b);

    return { rowBreaks: allRowBreaks, colBreaks: allColBreaks };
}

// ── Variable substitution ──────────────────────────────────────────────────────

/**
 * Substitute template variables in a header/footer string.
 * Variables: {page}, {pages}, {sheetName}, {docName}, {date}, {time}
 * @param {string} text
 * @param {{ page: number, pages: number, sheetName?: string, docName?: string, date: string, time: string }} vars
 * @returns {string}
 */
export function substituteVars(text, vars) {
    if (!text) return '';
    return text
        .replace(/\{page\}/g,      String(vars.page))
        .replace(/\{pages\}/g,     String(vars.pages))
        .replace(/\{sheetName\}/g, vars.sheetName ?? '')
        .replace(/\{docName\}/g,   vars.docName ?? '')
        .replace(/\{date\}/g,      vars.date)
        .replace(/\{time\}/g,      vars.time);
}

// ── Header / footer ────────────────────────────────────────────────────────────

/**
 * Draw header or footer text (left/center/right) on the current jsPDF page.
 * @param {import('jspdf').jsPDF} pdf
 * @param {'header'|'footer'} which
 * @param {{ pageW: number, pageH: number, marginTop: number, marginBottom: number, marginLeft: number, marginRight: number }} geo
 * @param {{ left?: string, center?: string, right?: string }} texts  (already substituted)
 */
export function drawHF(pdf, which, geo, texts) {
    const { pageW, pageH, marginTop, marginBottom, marginLeft, marginRight } = geo;
    const y = which === 'header'
        ? marginTop / 2
        : pageH - marginBottom / 2;

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(80, 80, 80);

    if (texts.left)   pdf.text(texts.left,   marginLeft,          y, { align: 'left',   baseline: 'middle' });
    if (texts.center) pdf.text(texts.center, pageW / 2,           y, { align: 'center', baseline: 'middle' });
    if (texts.right)  pdf.text(texts.right,  pageW - marginRight, y, { align: 'right',  baseline: 'middle' });
}

// ── Page list ──────────────────────────────────────────────────────────────────

/**
 * Build the ordered list of {ri, ci} page indices respecting page order.
 * @param {number[]} rowBreaks
 * @param {number[]} colBreaks
 * @param {'downThenOver'|'overThenDown'} pageOrder
 * @returns {{ ri: number, ci: number }[]}
 */
export function buildPageList(rowBreaks, colBreaks, pageOrder = 'downThenOver') {
    const pages = [];
    if (pageOrder === 'overThenDown') {
        for (let ci = 0; ci < colBreaks.length; ci++) {
            for (let ri = 0; ri < rowBreaks.length; ri++) {
                pages.push({ ri, ci });
            }
        }
    } else {
        for (let ri = 0; ri < rowBreaks.length; ri++) {
            for (let ci = 0; ci < colBreaks.length; ci++) {
                pages.push({ ri, ci });
            }
        }
    }
    return pages;
}

// ── Date/time helpers ──────────────────────────────────────────────────────────

/**
 * Build the header/footer variable base object for a given sheet.
 * @param {string} sheetName
 * @param {string} docName
 */
export function buildHFVarsBase(sheetName, docName) {
    const now = new Date();
    return {
        sheetName: sheetName ?? '',
        docName:   docName   ?? '',
        date: now.toLocaleDateString(),
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
}
