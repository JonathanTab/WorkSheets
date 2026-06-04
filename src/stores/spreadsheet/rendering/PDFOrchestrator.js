/**
 * PDFOrchestrator.js — PDF generation orchestration.
 *
 * Owns the page-geometry setup, print-area detection, page-break computation,
 * page-list building, header/footer wiring, and page loop. Per-page rendering
 * is delegated to a PageRenderer backend (currently only VectorPageRenderer).
 *
 * ## Usage
 *   const blob = await orchestratePDF(params, new VectorPageRenderer());
 *
 * ## PageRenderer interface
 *   prepare(params, geo)            — async setup (e.g. preload images)
 *   extendUsedArea?(bounds, ...)    — optional; may expand bounds for floating content
 *   renderCells(pdf, cells, pd)     — render cell data to the current PDF page
 *   renderExtras?(pdf, pd)          — optional extras (e.g. floating images)
 *   cleanup()                       — free resources after all pages are done
 */

import { jsPDF } from 'jspdf';
import { buildPaneData } from './CellPaintData.js';
import {
    PAPER_SIZES,
    DEFAULT_PRINT_MARGIN_MM,
    computePrintBounds,
    computePageBreaks,
    substituteVars,
    drawHF,
    buildPageList,
    buildHFVarsBase,
} from './PrintShared.js';

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
    // For 'usedArea' we compute cell+image bounds via the shared helper so the
    // grid overlay, preview, and exported PDF all agree on what gets printed.
    let settingsForBreaks = { ...printSettings };
    const printArea = printSettings.printArea ?? 'usedArea';
    let hadContent = printArea !== 'usedArea'; // selection / explicit area always counts as content
    if (printArea === 'usedArea') {
        const bounds = computePrintBounds(sheetStore, rowMetrics, colMetrics);
        if (bounds) {
            hadContent = true;
            settingsForBreaks = {
                ...settingsForBreaks,
                areaStartRow: bounds.startRow,
                areaStartCol: bounds.startCol,
                areaEndRow:   bounds.endRow,
                areaEndCol:   bounds.endCol,
            };
        }
    }

    // ── Create PDF (always start with one page) ─────────────────────────────────
    // compress: true wraps content streams in Flate (zlib) — vector text/shapes
    // shrink dramatically with no visual change. Images are compressed separately
    // by the renderer (see VectorPrintEngine image embedding).
    const pdf = new jsPDF({ orientation, unit: 'mm', format: [pageW, pageH], compress: true });

    // Empty sheet — emit a single blank page so downstream callers always get
    // a valid PDF. Without this guard, computePageBreaks would produce
    // areaEndRow = totalRows-1 etc. and fill the file with blanks.
    if (!hadContent) {
        await pageRenderer.prepare?.(params, geo);
        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, 0, pageW, pageH, 'F');
        pageRenderer.cleanup?.();
        return pdf.output('blob');
    }

    // ── Page breaks ─────────────────────────────────────────────────────────────
    const { rowBreaks, colBreaks } = computePageBreaks(
        settingsForBreaks, rowMetrics, colMetrics, totalRows, totalCols,
    );

    // ── Options ─────────────────────────────────────────────────────────────────
    const showGridLines = printSettings.showGridLines ?? false;
    const pageOrder     = printSettings.pageOrder ?? 'downThenOver';

    // ── Header / footer ─────────────────────────────────────────────────────────
    const hfVarsBase = buildHFVarsBase(sheetStore?.name ?? '', docName);
    const hasHeader  = printSettings.headerLeft || printSettings.headerCenter || printSettings.headerRight;
    const hasFooter  = printSettings.footerLeft || printSettings.footerCenter || printSettings.footerRight;

    // ── Renderer setup ───────────────────────────────────────────────────────────
    await pageRenderer.prepare?.(params, geo);

    // ── Pre-pass: filter out zero-size pages so totalPages is accurate ──────────
    const allPages = buildPageList(rowBreaks, colBreaks, pageOrder);
    const pagesToRender = [];
    for (const { ri, ci } of allPages) {
        const startRow = rowBreaks[ri];
        const endRow   = ri + 1 < rowBreaks.length
            ? rowBreaks[ri + 1] - 1
            : (settingsForBreaks.areaEndRow ?? totalRows - 1);
        const startCol = colBreaks[ci];
        const endCol   = ci + 1 < colBreaks.length
            ? colBreaks[ci + 1] - 1
            : (settingsForBreaks.areaEndCol ?? totalCols - 1);

        const contentLeft  = colMetrics.offsetOf(startCol);
        const contentTop   = rowMetrics.offsetOf(startRow);
        const contentW_css = colMetrics.offsetOf(endCol + 1) - contentLeft;
        const contentH_css = rowMetrics.offsetOf(endRow + 1) - contentTop;
        if (contentW_css <= 0 || contentH_css <= 0) continue;

        pagesToRender.push({
            startRow, endRow, startCol, endCol,
            contentLeft, contentTop, contentW_css, contentH_css,
        });
    }
    const totalPages = Math.max(1, pagesToRender.length);

    // ── Page loop ────────────────────────────────────────────────────────────────
    let pageNum = 0;
    for (const page of pagesToRender) {
        pageNum++;
        if (pageNum > 1) pdf.addPage([pageW, pageH], orientation);

        const { startRow, endRow, startCol, endCol, contentLeft, contentTop, contentW_css, contentH_css } = page;
        const rowRange = { start: startRow, end: endRow, count: endRow - startRow + 1 };
        const colRange = { start: startCol, end: endCol, count: endCol - startCol + 1 };

        const cells = buildPaneData({
            rowRange, colRange, rowMetrics, colMetrics,
            renderContext, sheetStore, session,
            selectionState: null, formulaEditState: null,
            frozenRows: 0, frozenCols: 0, frozenHeight: 0, frozenWidth: 0,
            scrollLeft: contentLeft,
            scrollTop:  contentTop,
        });

        const pageData = {
            startRow, endRow, startCol, endCol,
            contentLeft, contentTop, contentW_css, contentH_css,
            rowRange, colRange,
            pageNum, totalPages, geo, s, showGridLines,
        };

        await pageRenderer.renderCells(pdf, cells, pageData, params);
        await pageRenderer.renderExtras?.(pdf, pageData, params);

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
