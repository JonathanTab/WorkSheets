/**
 * CanvasPrintEngine - Client-side PDF generation using jsPDF + CanvasRenderer.
 *
 * Generates a PDF from a spreadsheet by:
 * 1. Computing page breaks using the existing PrintEngine logic
 * 2. For each page, painting that cell range onto an offscreen canvas
 *    at print resolution
 * 3. Adding each page as a PNG image to a jsPDF document
 * 4. Returning the PDF as a Blob (for download or print preview)
 */

import { jsPDF } from 'jspdf';
import { CanvasRenderer } from './CanvasRenderer.js';
import { buildPaneData } from './CellPaintData.js';
import { PrintEngine } from '../features/PrintEngine.js';

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
        } = params;

        const totalRows = renderContext?.effectiveRowCount ?? sheetStore?.rowCount ?? 100;
        const totalCols = renderContext?.effectiveColCount ?? sheetStore?.colCount ?? 26;

        // ── 1. Compute page breaks ─────────────────────────────────────────────
        const { rowBreaks, colBreaks } = this.#printEngine.computePageBreaks(
            printSettings,
            rowMetrics,
            colMetrics,
            totalRows,
            totalCols,
        );

        // ── 2. Page dimensions ─────────────────────────────────────────────────
        const orientation = printSettings.orientation ?? 'portrait';
        const paperSize = this.#getPaperSizeMM(printSettings.paperSize ?? 'A4');
        const printDPI = 150; // Balance quality vs. file size

        const pageW = orientation === 'landscape' ? paperSize.height : paperSize.width;
        const pageH = orientation === 'landscape' ? paperSize.width : paperSize.height;

        const marginTop = printSettings.marginTop ?? 10;
        const marginBottom = printSettings.marginBottom ?? 10;
        const marginLeft = printSettings.marginLeft ?? 10;
        const marginRight = printSettings.marginRight ?? 10;

        const pxPerMM = printDPI / 25.4;
        const printableW = (pageW - marginLeft - marginRight) * pxPerMM;
        const printableH = (pageH - marginTop - marginBottom) * pxPerMM;

        // ── 3. Create jsPDF document ───────────────────────────────────────────
        const pdf = new jsPDF({
            orientation,
            unit: 'mm',
            format: [pageW, pageH],
        });

        // ── 4. Offscreen canvas + renderer ────────────────────────────────────
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = Math.ceil(printableW);
        offscreenCanvas.height = Math.ceil(printableH);

        const renderer = new CanvasRenderer(offscreenCanvas);
        renderer.resize(printableW, printableH, 1); // DPR=1 for print (we handle size ourselves)

        // ── 5. Render each page ────────────────────────────────────────────────
        let isFirstPage = true;

        for (let ri = 0; ri < rowBreaks.length; ri++) {
            const startRow = rowBreaks[ri];
            const endRow = ri + 1 < rowBreaks.length
                ? rowBreaks[ri + 1] - 1
                : (printSettings.areaEndRow ?? totalRows - 1);

            for (let ci = 0; ci < colBreaks.length; ci++) {
                const startCol = colBreaks[ci];
                const endCol = ci + 1 < colBreaks.length
                    ? colBreaks[ci + 1] - 1
                    : (printSettings.areaEndCol ?? totalCols - 1);

                // Compute pixel extents of this page's content
                const contentLeft = colMetrics.offsetOf(startCol);
                const contentTop = rowMetrics.offsetOf(startRow);
                const contentRight = colMetrics.offsetOf(endCol + 1);
                const contentBottom = rowMetrics.offsetOf(endRow + 1);
                const contentW = contentRight - contentLeft;
                const contentH = contentBottom - contentTop;

                if (contentW <= 0 || contentH <= 0) continue;

                // Scale to fit printable area
                const scaleX = printableW / contentW;
                const scaleY = printableH / contentH;
                const scale = Math.min(scaleX, scaleY);

                // Resize canvas to scaled page size
                const scaledW = Math.ceil(contentW * scale);
                const scaledH = Math.ceil(contentH * scale);
                offscreenCanvas.width = scaledW;
                offscreenCanvas.height = scaledH;
                renderer.resize(scaledW, scaledH, 1);

                // Build paint data for this range
                const rowRange = { start: startRow, end: endRow, count: endRow - startRow + 1 };
                const colRange = { start: startCol, end: endCol, count: endCol - startCol + 1 };

                // For print: all cells are treated as "frozen" (no scroll offset)
                // We shift X/Y so the first cell starts at 0,0
                const cells = buildPaneData({
                    rowRange,
                    colRange,
                    rowMetrics,
                    colMetrics,
                    renderContext,
                    sheetStore,
                    session,
                    selectionState: null,  // no selection in print
                    formulaEditState: null,
                    frozenRows: 0,
                    frozenCols: 0,
                    frozenHeight: 0,
                    frozenWidth: 0,
                    scrollLeft: contentLeft,
                    scrollTop: contentTop,
                });

                // Scale cell positions to match print scale
                for (const cell of cells) {
                    cell.x *= scale;
                    cell.y *= scale;
                    cell.width *= scale;
                    cell.height *= scale;
                    if (cell.fontSize) cell.fontSize = Math.round(cell.fontSize * scale);
                }

                // Paint
                renderer.clear();
                renderer.paintPane(cells, {
                    clipX: 0, clipY: 0,
                    clipW: scaledW, clipH: scaledH,
                });

                // Add page to PDF
                if (!isFirstPage) pdf.addPage([pageW, pageH], orientation);
                isFirstPage = false;

                const imgData = offscreenCanvas.toDataURL('image/png');
                const imgW = pageW - marginLeft - marginRight;
                const imgH = imgW * (scaledH / scaledW);
                pdf.addImage(imgData, 'PNG', marginLeft, marginTop, imgW, imgH);
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
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    #getPaperSizeMM(key) {
        const sizes = {
            A4: { width: 210, height: 297 },
            letter: { width: 215.9, height: 279.4 },
            legal: { width: 215.9, height: 355.6 },
            A3: { width: 297, height: 420 },
            A5: { width: 148, height: 210 },
        };
        return sizes[key] ?? sizes.A4;
    }
}

export default CanvasPrintEngine;
