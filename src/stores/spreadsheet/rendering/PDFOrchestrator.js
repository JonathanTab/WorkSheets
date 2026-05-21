/**
 * PDFOrchestrator.js — Shared PDF generation orchestration.
 *
 * Hosts the page-geometry setup, print-area detection, page-break computation,
 * page-list building, header/footer wiring, and page loop. The per-page cell
 * rendering is delegated to a PageRenderer backend so CanvasPrintEngine and
 * VectorPrintEngine can share the 200+ lines of identical orchestration code.
 *
 * ## Usage
 *   const blob = await orchestratePDF(params, new CanvasPageRenderer());
 *   const blob = await orchestratePDF(params, new VectorPageRenderer());
 *
 * ## PageRenderer interface
 *   prepare(params, geo)            — async setup (e.g. preload images)
 *   renderCells(pdf, cells, pd)     — render cell data to the current PDF page
 *   renderExtras(pdf, pd)           — optional extras (e.g. floating images)
 *   cleanup()                       — free resources after all pages are done
 *
 * pd = { startRow, endRow, startCol, endCol, contentLeft, contentTop,
 *         contentW_css, contentH_css, pageNum, geo, s, showGridLines }
 */

import { jsPDF } from 'jspdf';
import { buildPaneData } from './CellPaintData.js';
import { PrintEngine } from '../features/PrintEngine.js';
import {
    PAPER_SIZES,
    CSS_PX_PER_INCH,
    MM_PER_INCH,
    DEFAULT_PRINT_MARGIN_MM,
    computeUsedArea,
    substituteVars,
    drawHF,
    buildPageList,
    buildHFVarsBase,
} from './PrintShared.js';

const _printEngine = new PrintEngine();

/**
 * Orchestrate PDF generation, delegating per-page rendering to `pageRenderer`.
 * @param {object} params
 * @param {object} pageRenderer  Implements prepare / renderCells / renderExtras / cleanup
 * @returns {Promise<Blob>}
 */
export async function orchestratePDF(params, pageRenderer) {
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

    // ── Paper geometry ──────────────────────────────────────────────────────────
    const orientation = printSettings.orientation ?? 'portrait';
    const paperKey    = printSettings.paperSize ?? 'letter';
    const paper       = PAPER_SIZES[paperKey] ?? PAPER_SIZES.letter;
    const pageW = orientation === 'landscape' ? paper.height : paper.width;
    const pageH = orientation === 'landscape' ? paper.width  : paper.height;

    const marginTop    = printSettings.marginTop    ?? DEFAULT_PRINT_MARGIN_MM;
    const marginBottom = printSettings.marginBottom ?? DEFAULT_PRINT_MARGIN_MM;
    const marginLeft   = printSettings.marginLeft   ?? DEFAULT_PRINT_MARGIN_MM;
    const marginRight  = printSettings.marginRight  ?? DEFAULT_PRINT_MARGIN_MM;

    const printableW = pageW - marginLeft - marginRight;
    const printableH = pageH - marginTop  - marginBottom;
    const s          = printSettings.scale ?? 1.0;

    const geo = { pageW, pageH, marginTop, marginBottom, marginLeft, marginRight, printableW, printableH, s };

    // ── Print area ──────────────────────────────────────────────────────────────
    let settingsForBreaks = { ...printSettings };
    const printArea = printSettings.printArea ?? 'usedArea';
    if (printArea === 'usedArea') {
        // Allow the renderer to extend the used-area bounds (e.g. to cover floating images)
        const used = computeUsedArea(sheetStore);
        if (used) {
            const extended = pageRenderer.extendUsedArea?.(used, params, { rowMetrics, colMetrics }) ?? used;
            if (extended) {
                settingsForBreaks = {
                    ...settingsForBreaks,
                    areaStartRow: extended.startRow,
                    areaStartCol: extended.startCol,
                    areaEndRow:   extended.endRow,
                    areaEndCol:   Math.max(extended.endCol, 0),
                };
            }
        }
    }

    // ── Page breaks ─────────────────────────────────────────────────────────────
    const { rowBreaks, colBreaks } = _printEngine.computePageBreaks(
        settingsForBreaks, rowMetrics, colMetrics, totalRows, totalCols,
    );

    // ── Options ─────────────────────────────────────────────────────────────────
    const showGridLines = printSettings.showGridLines ?? true;
    const pageOrder     = printSettings.pageOrder ?? 'downThenOver';

    // ── Header / footer ─────────────────────────────────────────────────────────
    const hfVarsBase = buildHFVarsBase(sheetStore?.name ?? '', docName);
    const hasHeader  = printSettings.headerLeft || printSettings.headerCenter || printSettings.headerRight;
    const hasFooter  = printSettings.footerLeft || printSettings.footerCenter || printSettings.footerRight;
    const totalPages = rowBreaks.length * colBreaks.length;

    // ── Create PDF ───────────────────────────────────────────────────────────────
    const pdf = new jsPDF({ orientation, unit: 'mm', format: [pageW, pageH] });
    const pages = buildPageList(rowBreaks, colBreaks, pageOrder);

    // ── Renderer setup ───────────────────────────────────────────────────────────
    await pageRenderer.prepare?.(params, geo);

    // ── Page loop ────────────────────────────────────────────────────────────────
    let isFirstPage = true;
    let pageNum = 0;

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
        const contentW_css = colMetrics.offsetOf(endCol + 1) - contentLeft;
        const contentH_css = rowMetrics.offsetOf(endRow + 1) - contentTop;

        if (contentW_css <= 0 || contentH_css <= 0) continue;

        const rowRange = { start: startRow, end: endRow,   count: endRow   - startRow + 1 };
        const colRange = { start: startCol, end: endCol,   count: endCol   - startCol + 1 };

        const cells = buildPaneData({
            rowRange, colRange, rowMetrics, colMetrics,
            renderContext, sheetStore, session,
            selectionState: null, formulaEditState: null,
            frozenRows: 0, frozenCols: 0, frozenHeight: 0, frozenWidth: 0,
            scrollLeft: contentLeft,
            scrollTop:  contentTop,
        });

        if (!isFirstPage) pdf.addPage([pageW, pageH], orientation);
        isFirstPage = false;

        const pageData = {
            startRow, endRow, startCol, endCol,
            contentLeft, contentTop, contentW_css, contentH_css,
            rowRange, colRange,
            pageNum, totalPages, geo, s, showGridLines,
        };

        await pageRenderer.renderCells(pdf, cells, pageData, params);
        await pageRenderer.renderExtras?.(pdf, pageData, params);

        // Header / footer
        const hfVars = { ...hfVarsBase, page: pageNum, pages: totalPages };
        if (hasHeader) drawHF(pdf, 'header', geo, {
            left:   substituteVars(printSettings.headerLeft,   hfVars),
            center: substituteVars(printSettings.headerCenter, hfVars),
            right:  substituteVars(printSettings.headerRight,  hfVars),
        });
        if (hasFooter) drawHF(pdf, 'footer', geo, {
            left:   substituteVars(printSettings.footerLeft,   hfVars),
            center: substituteVars(printSettings.footerCenter, hfVars),
            right:  substituteVars(printSettings.footerRight,  hfVars),
        });
    }

    pageRenderer.cleanup?.();
    return pdf.output('blob');
}

/**
 * Download a PDF — convenience wrapper around orchestratePDF.
 * @param {object} params
 * @param {object} pageRenderer
 * @param {string} [filename='spreadsheet.pdf']
 */
export async function downloadPDF(params, pageRenderer, filename = 'spreadsheet.pdf') {
    const blob = await orchestratePDF(params, pageRenderer);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
