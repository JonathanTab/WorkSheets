/**
 * Barrel exports for the canvas rendering subsystem.
 */
export { CanvasRenderer } from './CanvasRenderer.js';
export { RenderScheduler } from './RenderScheduler.js';
export { HitTestEngine } from './HitTestEngine.js';
export { buildPaneData } from './CellPaintData.js';
export { VectorPrintEngine } from './VectorPrintEngine.js';
export { PaintInvalidator } from './PaintInvalidator.js';
export { buildWrappedLines } from './RichTextLayout.js';
export { orchestratePDF, downloadPDF } from './PDFOrchestrator.js';
export {
    paintBordersCanvas,
    paintBordersVec,
    normalizeBorderStyle,
    bordersStylesEqual,
    snapOffset,
    quantizeStrokeWidth,
    dashPatternCss,
    dottedPatternCss,
    doubleGapCss,
} from './BorderGeometry.js';
export {
    checkboxLayout, ratingLayout, starVertices,
    CHECKBOX_PADDING, CHECKBOX_MAX_SIZE, CHECKBOX_RADIUS_FRACTION,
    RATING_GAP, RATING_MAX_SIZE, RATING_INNER_RATIO, RATING_POINTS,
} from './CellPrimitiveGeometry.js';
export {
    PAPER_SIZES,
    parseCssColor,
    computeUsedArea,
    computePrintBounds,
    computePageBreaks,
    substituteVars,
    drawHF,
    buildPageList,
    buildHFVarsBase,
} from './PrintShared.js';
