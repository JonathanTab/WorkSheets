/**
 * CanvasPrintEngine - Client-side PDF generation using jsPDF + CanvasRenderer.
 *
 * Features:
 *  - printArea: 'usedArea' (auto-detect data bounds) or 'selection' (use areaStart/End props)
 *  - pageOrder: 'downThenOver' (row pages first) or 'overThenDown' (col pages first)
 *  - Header/footer: left/center/right text with variable substitution
 *  - Consistent render scale across all pages (printDPI / 96 canvas px per CSS px)
 *
 * Scale model:
 *   - "scale" in printSettings (0.1–4.0) maps 1 CSS px → scale × (25.4/96) mm on paper.
 *   - At scale=1: 96 CSS px = 1 inch = 25.4mm (standard screen reference pixel).
 *   - printDPI controls render quality (default 300). Higher = sharper, larger file.
 */

import { jsPDF } from 'jspdf';
import { CanvasRenderer } from './CanvasRenderer.js';
import { buildPaneData } from './CellPaintData.js';
import { PrintEngine } from '../features/PrintEngine.js';

// Standard paper sizes in mm
const PAPER_SIZES = {
    A4:     { width: 210,   height: 297   },
    letter: { width: 215.9, height: 279.4 },
    legal:  { width: 215.9, height: 355.6 },
    A3:     { width: 297,   height: 420   },
    A5:     { width: 148,   height: 210   },
};

const CSS_PX_PER_INCH = 96;
const MM_PER_INCH = 25.4;

/**
 * Determine the bounding box of cells that actually have data.
 * Returns null if the sheet is empty.
 * @param {import('../SheetStore.svelte.js').SheetStore} sheetStore
 * @returns {{ startRow: number, startCol: number, endRow: number, endCol: number } | null}
 */
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

/**
 * Substitute template variables in a header/footer string.
 * Variables: {page}, {pages}, {sheetName}, {docName}, {date}, {time}
 */
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

/**
 * Draw header or footer text (left/center/right) on the current jsPDF page.
 * @param {jsPDF} pdf
 * @param {'header'|'footer'} which
 * @param {{ pageW: number, pageH: number, marginTop: number, marginBottom: number, marginLeft: number, marginRight: number }} geo
 * @param {{ left: string, center: string, right: string }} texts  (already substituted)
 */
function drawHF(pdf, which, geo, texts) {
    const { pageW, pageH, marginTop, marginBottom, marginLeft, marginRight } = geo;
    const y = which === 'header'
        ? marginTop / 2          // midpoint of top margin
        : pageH - marginBottom / 2; // midpoint of bottom margin

    pdf.setFontSize(8);
    pdf.setTextColor(80, 80, 80);

    if (texts.left)   pdf.text(texts.left,   marginLeft,         y, { align: 'left',   baseline: 'middle' });
    if (texts.center) pdf.text(texts.center, pageW / 2,          y, { align: 'center', baseline: 'middle' });
    if (texts.right)  pdf.text(texts.right,  pageW - marginRight, y, { align: 'right',  baseline: 'middle' });
}

export class CanvasPrintEngine {
    #printEngine;

    constructor() {
        this.#printEngine = new PrintEngine();
    }

    /**
     * Generate a PDF blob for the active sheet.
     *
     * @param {Object} params
     * @param {Object} [params.printSettings]
     * @param {import('../features/SheetRenderContext.svelte.js').SheetRenderContext} params.renderContext
     * @param {import('../SheetStore.svelte.js').SheetStore} params.sheetStore
     * @param {import('../SpreadsheetSession.svelte.js').SpreadsheetSession} params.session
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} params.rowMetrics
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} params.colMetrics
     * @param {string} [params.docName]
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

        // ── 1. Page geometry ────────────────────────────────────────────────────
        const orientation = printSettings.orientation ?? 'portrait';
        const paperKey    = printSettings.paperSize ?? 'A4';
        const paper       = PAPER_SIZES[paperKey] ?? PAPER_SIZES.A4;

        const pageW = orientation === 'landscape' ? paper.height : paper.width; // mm
        const pageH = orientation === 'landscape' ? paper.width  : paper.height; // mm

        const marginTop    = printSettings.marginTop    ?? 19; // mm
        const marginBottom = printSettings.marginBottom ?? 19;
        const marginLeft   = printSettings.marginLeft   ?? 18;
        const marginRight  = printSettings.marginRight  ?? 18;

        const printableW_mm = pageW  - marginLeft - marginRight;
        const printableH_mm = pageH  - marginTop  - marginBottom;

        const userScale = printSettings.scale ?? 1.0;

        // Printable area in CSS pixels at the user's scale
        const printableW_css = (printableW_mm / MM_PER_INCH) * CSS_PX_PER_INCH / userScale;
        const printableH_css = (printableH_mm / MM_PER_INCH) * CSS_PX_PER_INCH / userScale;

        // ── 2. Determine print area bounds ──────────────────────────────────────
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
            // else: empty sheet — falls through to whole sheet bounds
        }
        // 'selection': areaStart/End already embedded in printSettings by PageSetupPanel

        // ── 3. Compute page breaks (whole rows & cols) ──────────────────────────
        const { rowBreaks, colBreaks } = this.#printEngine.computePageBreaks(
            settingsForBreaks,
            rowMetrics,
            colMetrics,
            totalRows,
            totalCols,
        );

        // ── 4. Render quality ───────────────────────────────────────────────────
        const printDPI = printSettings.printDPI ?? 300;
        const renderScale = printDPI / CSS_PX_PER_INCH;

        // ── 5. Options ──────────────────────────────────────────────────────────
        const showGridLines = printSettings.showGridLines ?? true;
        const pageOrder     = printSettings.pageOrder ?? 'downThenOver';

        // ── 6. Header/footer setup ──────────────────────────────────────────────
        const now = new Date();
        const dateStr = now.toLocaleDateString();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const sheetName = sheetStore?.name ?? '';

        const hfVarsBase = { sheetName, docName, date: dateStr, time: timeStr };
        const hasHeader = printSettings.headerLeft || printSettings.headerCenter || printSettings.headerRight;
        const hasFooter = printSettings.footerLeft || printSettings.footerCenter || printSettings.footerRight;

        // Total page count
        const totalPages = rowBreaks.length * colBreaks.length;

        // ── 7. Create jsPDF document ────────────────────────────────────────────
        const pdf = new jsPDF({
            orientation,
            unit: 'mm',
            format: [pageW, pageH],
        });

        // ── 8. Offscreen canvas + renderer ─────────────────────────────────────
        const offscreenCanvas = document.createElement('canvas');
        const renderer = new CanvasRenderer(offscreenCanvas);

        const geo = { pageW, pageH, marginTop, marginBottom, marginLeft, marginRight };

        let isFirstPage = true;
        let pageNum = 0;

        // ── 9. Build page list respecting page order ────────────────────────────
        const pages = [];
        if (pageOrder === 'overThenDown') {
            for (let ci = 0; ci < colBreaks.length; ci++) {
                for (let ri = 0; ri < rowBreaks.length; ri++) {
                    pages.push({ ri, ci });
                }
            }
        } else {
            // default: down then over
            for (let ri = 0; ri < rowBreaks.length; ri++) {
                for (let ci = 0; ci < colBreaks.length; ci++) {
                    pages.push({ ri, ci });
                }
            }
        }

        // ── 10. Render each page ────────────────────────────────────────────────
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

            // Content bounds in CSS pixels (natural cell sizes, no scroll)
            const contentLeft   = colMetrics.offsetOf(startCol);
            const contentTop    = rowMetrics.offsetOf(startRow);
            const contentRight  = colMetrics.offsetOf(endCol + 1);
            const contentBottom = rowMetrics.offsetOf(endRow + 1);
            const contentW_css  = contentRight  - contentLeft;
            const contentH_css  = contentBottom - contentTop;

            if (contentW_css <= 0 || contentH_css <= 0) continue;

            // Tell the renderer the CSS size and use renderScale as DPR.
            // paintPane() applies ctx.scale(renderScale, renderScale) internally,
            // so all coordinates — including hardcoded pixel values inside custom
            // cell painters (checkbox size, star radius, etc.) — are treated as
            // CSS pixels and uniformly scaled to the high-resolution canvas.
            renderer.resize(contentW_css, contentH_css, renderScale);

            const rowRange = { start: startRow, end: endRow,   count: endRow   - startRow + 1 };
            const colRange = { start: startCol, end: endCol,   count: endCol   - startCol + 1 };

            const cells = buildPaneData({
                rowRange,
                colRange,
                rowMetrics,
                colMetrics,
                renderContext,
                sheetStore,
                session,
                selectionState:  null,
                formulaEditState: null,
                frozenRows:    0,
                frozenCols:    0,
                frozenHeight:  0,
                frozenWidth:   0,
                scrollLeft: contentLeft,
                scrollTop:  contentTop,
            });

            // Paint — all coordinates are CSS pixels; renderer scales internally.
            renderer.clear();
            renderer.paintPane(cells, {
                clipX: 0,
                clipY: 0,
                clipW: contentW_css,
                clipH: contentH_css,
                showGridLines,
            });

            // Size of this content in mm on the printed page
            const imgW_mm = contentW_css * (MM_PER_INCH / CSS_PX_PER_INCH) * userScale;
            const imgH_mm = contentH_css * (MM_PER_INCH / CSS_PX_PER_INCH) * userScale;

            const clampedW = Math.min(imgW_mm, printableW_mm);
            const clampedH = Math.min(imgH_mm, printableH_mm);

            // Add page to PDF
            if (!isFirstPage) pdf.addPage([pageW, pageH], orientation);
            isFirstPage = false;

            const imgData = offscreenCanvas.toDataURL('image/png');
            pdf.addImage(imgData, 'PNG', marginLeft, marginTop, clampedW, clampedH, undefined, 'FAST');

            // Header / Footer
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

        renderer.destroy();

        return pdf.output('blob');
    }

    /**
     * Generate and download a PDF.
     * @param {Object} params - Same as generatePDF
     * @param {string} [filename='spreadsheet.pdf']
     */
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

export default CanvasPrintEngine;
