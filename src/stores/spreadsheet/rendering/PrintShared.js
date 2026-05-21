/**
 * PrintShared.js — Utilities shared between CanvasPrintEngine and VectorPrintEngine.
 *
 * Consolidates the duplicate definitions that previously lived in both files:
 *   - PAPER_SIZES
 *   - CSS_PX_PER_INCH, MM_PER_INCH
 *   - computeUsedArea()
 *   - substituteVars()
 *   - drawHF()
 *   - buildPageList()
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
 * @param {number[]} rowBreaks - Array of start row indices for each page row
 * @param {number[]} colBreaks - Array of start col indices for each page col
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
 * @returns {{ sheetName: string, docName: string, date: string, time: string }}
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
