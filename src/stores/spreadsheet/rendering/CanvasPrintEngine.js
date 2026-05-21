/**
 * CanvasPrintEngine - Client-side PDF generation using jsPDF + CanvasRenderer.
 *
 * Delegates all page-geometry, print-area, page-break, and header/footer
 * orchestration to PDFOrchestrator. This class only provides the canvas-bitmap
 * page-rendering backend (OffscreenCanvas → PNG → jsPDF addImage).
 */

import { CanvasRenderer } from './CanvasRenderer.js';
import { orchestratePDF, downloadPDF as _downloadPDF } from './PDFOrchestrator.js';
import { CSS_PX_PER_INCH, MM_PER_INCH } from './PrintShared.js';

// ── CanvasPageRenderer — inline backend ────────────────────────────────────────

class CanvasPageRenderer {
    #canvas   = null;
    #renderer = null;

    prepare(_params, _geo) {
        this.#canvas   = document.createElement('canvas');
        this.#renderer = new CanvasRenderer(this.#canvas);
    }

    renderCells(pdf, cells, pd, params) {
        const { geo, s, showGridLines, contentW_css, contentH_css } = pd;
        const { marginLeft, marginTop, printableW, printableH } = geo;
        const printDPI    = params.printSettings?.printDPI ?? 300;
        const renderScale = printDPI / CSS_PX_PER_INCH;

        this.#renderer.resize(contentW_css, contentH_css, renderScale);
        this.#renderer.clear();
        this.#renderer.paintPane(cells, {
            clipX: 0, clipY: 0,
            clipW: contentW_css, clipH: contentH_css,
            showGridLines,
        });

        const imgW_mm = Math.min(contentW_css * (MM_PER_INCH / CSS_PX_PER_INCH) * s, printableW);
        const imgH_mm = Math.min(contentH_css * (MM_PER_INCH / CSS_PX_PER_INCH) * s, printableH);
        const imgData = this.#canvas.toDataURL('image/png');
        pdf.addImage(imgData, 'PNG', marginLeft, marginTop, imgW_mm, imgH_mm, undefined, 'FAST');
    }

    cleanup() {
        this.#renderer?.destroy?.();
        this.#renderer = null;
        this.#canvas   = null;
    }
}

// ── CanvasPrintEngine ──────────────────────────────────────────────────────────

export class CanvasPrintEngine {
    /** @returns {Promise<Blob>} */
    async generatePDF(params) {
        return orchestratePDF(params, new CanvasPageRenderer());
    }

    async downloadPDF(params, filename = 'spreadsheet.pdf') {
        return _downloadPDF(params, new CanvasPageRenderer(), filename);
    }
}

export default CanvasPrintEngine;
