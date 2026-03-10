/**
 * PrintEngine - Page break computation and print CSS generation
 *
 * Stateless utility class. Call computePageBreaks() to determine which rows
 * and columns start a new physical page given paper size and margins.
 * Call generatePrintCSS() to get the @page CSS for the print dialog.
 */

// Standard paper sizes in mm
const PAPER_SIZES = {
    A4: { width: 210, height: 297 },
    letter: { width: 215.9, height: 279.4 },
    legal: { width: 215.9, height: 355.6 },
    A3: { width: 297, height: 420 },
    A5: { width: 148, height: 210 },
};

const MM_PER_INCH = 25.4;
const PX_PER_INCH = 96; // CSS reference pixel at 96 dpi
const MM_TO_PX = PX_PER_INCH / MM_PER_INCH;

export class PrintEngine {
    /**
     * Compute page breaks given current row/col metrics and print settings.
     *
     * @param {Object} printSettings  Plain object with print options
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} rowMetrics
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
     * @param {number} totalRows
     * @param {number} totalCols
     * @returns {{ rowBreaks: number[], colBreaks: number[] }}
     *   rowBreaks: sorted list of row indices that start a new page
     *   colBreaks: sorted list of col indices that start a new page
     */
    computePageBreaks(printSettings = {}, rowMetrics, colMetrics, totalRows, totalCols) {
        const orientation = printSettings.orientation ?? "portrait";
        const paperKey = printSettings.paperSize ?? "A4";
        const paper = PAPER_SIZES[paperKey] ?? PAPER_SIZES.A4;

        // Paper dimensions in mm for the chosen orientation
        const paperW = orientation === "landscape" ? paper.height : paper.width;
        const paperH = orientation === "landscape" ? paper.width : paper.height;

        const marginTop = printSettings.marginTop ?? 10;
        const marginBottom = printSettings.marginBottom ?? 10;
        const marginLeft = printSettings.marginLeft ?? 10;
        const marginRight = printSettings.marginRight ?? 10;
        const scale = printSettings.scale ?? 1.0;

        // Printable area in pixels (CSS reference pixels at 96dpi)
        const printableH = ((paperH - marginTop - marginBottom) * MM_TO_PX) / scale;
        const printableW = ((paperW - marginLeft - marginRight) * MM_TO_PX) / scale;

        // Print area bounds (default = whole sheet)
        const areaStartRow = printSettings.areaStartRow ?? 0;
        const areaEndRow = printSettings.areaEndRow ?? totalRows - 1;
        const areaStartCol = printSettings.areaStartCol ?? 0;
        const areaEndCol = printSettings.areaEndCol ?? totalCols - 1;

        const rowBreaks = [areaStartRow];
        const colBreaks = [areaStartCol];

        if (!rowMetrics || !colMetrics) {
            return { rowBreaks, colBreaks };
        }

        // Row breaks
        let pageStart = rowMetrics.offsetOf(areaStartRow);
        for (let r = areaStartRow + 1; r <= areaEndRow; r++) {
            const rowBottom = rowMetrics.offsetOf(r + 1);
            if (rowBottom - pageStart > printableH) {
                rowBreaks.push(r);
                pageStart = rowMetrics.offsetOf(r);
            }
        }

        // Column breaks
        let pageLeft = colMetrics.offsetOf(areaStartCol);
        for (let c = areaStartCol + 1; c <= areaEndCol; c++) {
            const colRight = colMetrics.offsetOf(c + 1);
            if (colRight - pageLeft > printableW) {
                colBreaks.push(c);
                pageLeft = colMetrics.offsetOf(c);
            }
        }

        // Respect manually-set page breaks (merge and deduplicate)
        const manualRowBreaks = printSettings.pageBreakRows ?? [];
        const manualColBreaks = printSettings.pageBreakCols ?? [];

        const allRowBreaks = [...new Set([...rowBreaks, ...manualRowBreaks])].sort((a, b) => a - b);
        const allColBreaks = [...new Set([...colBreaks, ...manualColBreaks])].sort((a, b) => a - b);

        return { rowBreaks: allRowBreaks, colBreaks: allColBreaks };
    }

    /**
     * Generate CSS for @page and @media print.
     *
     * @param {Object} printSettings  Plain object with print options
     * @returns {string} CSS string to inject into a <style> element
     */
    generatePrintCSS(printSettings = {}) {
        const orientation = printSettings.orientation ?? "portrait";
        const paperKey = printSettings.paperSize ?? "A4";
        const marginTop = printSettings.marginTop ?? 10;
        const marginBottom = printSettings.marginBottom ?? 10;
        const marginLeft = printSettings.marginLeft ?? 10;
        const marginRight = printSettings.marginRight ?? 10;
        const showGridLines = printSettings.showGridLines ?? true;

        const sizeStr =
            paperKey === "letter" || paperKey === "legal"
                ? `${paperKey} ${orientation}`
                : paperKey === "A4" || paperKey === "A3" || paperKey === "A5"
                    ? `${paperKey} ${orientation}`
                    : `${paperKey} ${orientation}`;

        return `
@page {
    size: ${sizeStr};
    margin: ${marginTop}mm ${marginRight}mm ${marginBottom}mm ${marginLeft}mm;
}

@media print {
    .grid-root,
    .toolbar,
    .sheet-tabs,
    .formula-bar,
    .col-headers,
    .row-headers {
        display: none !important;
    }

    .print-preview {
        display: block !important;
    }

    .print-page-break {
        page-break-before: always;
        break-before: page;
    }

    .print-cell {
        border-right: ${showGridLines ? "1px solid #ddd" : "none"};
        border-bottom: ${showGridLines ? "1px solid #ddd" : "none"};
        overflow: hidden;
        white-space: nowrap;
        box-sizing: border-box;
        padding: 1px 3px;
        vertical-align: middle;
    }
}
        `.trim();
    }

    /**
     * Format a print settings object for display (e.g. in a print settings dialog).
     * @param {Object} printSettings
     * @returns {{ paperLabel: string, orientationLabel: string, sizeLabel: string }}
     */
    formatSettings(printSettings = {}) {
        const paper = PAPER_SIZES[printSettings.paperSize ?? "A4"] ?? PAPER_SIZES.A4;
        const orientation = printSettings.orientation ?? "portrait";
        const w = orientation === "landscape" ? paper.height : paper.width;
        const h = orientation === "landscape" ? paper.width : paper.height;
        return {
            paperLabel: printSettings.paperSize ?? "A4",
            orientationLabel: orientation === "landscape" ? "Landscape" : "Portrait",
            sizeLabel: `${w}×${h} mm`,
        };
    }

    /**
     * List of available paper sizes.
     */
    get availablePaperSizes() {
        return Object.keys(PAPER_SIZES);
    }
}

export default PrintEngine;
