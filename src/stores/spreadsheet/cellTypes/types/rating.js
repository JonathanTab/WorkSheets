/**
 * Rating cell type descriptor
 */
import { drawRating } from '../painters.js';

export const ratingType = {
    id: 'rating',
    renderType: 'rating',
    formatValue(rawValue) {
        return ''; // Rendered via canvas painter
    },
    parseInput(inputString) {
        const val = parseInt(inputString, 10);
        return isNaN(val) ? 0 : val;
    },
    defaultStyle() {
        return { horizontalAlign: 'center' };
    },
    /**
     * Canvas paint method — called by CanvasRenderer for each visible rating cell.
     * @param {CanvasRenderingContext2D} ctx
     * @param {any} value        Raw cell value (number)
     * @param {Object} config    Cell type config object ({ type:'rating', max:5, ... })
     * @param {{x:number,y:number,width:number,height:number}} rect
     * @param {Object} style
     */
    paintCell(ctx, value, config, rect, style) {
        // config is the CellPaintItem; ratingMax is set by CellPaintData from ct.max.
        // Also accept config?.max for direct descriptor calls with the ct object.
        const max = config?.ratingMax ?? config?.max ?? 5;
        drawRating(ctx, rect.x, rect.y, rect.width, rect.height, Number(value) || 0, max);
    },
    handlesClick: true,
};

export default ratingType;
