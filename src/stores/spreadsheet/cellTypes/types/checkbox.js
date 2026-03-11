/**
 * Checkbox cell type descriptor
 */
import { drawCheckbox } from '../painters.js';

export const checkboxType = {
    id: 'checkbox',
    formatValue(rawValue) {
        return ''; // Rendered via canvas painter
    },
    parseInput(inputString) {
        if (typeof inputString === 'boolean') return inputString;
        if (inputString === 'true' || inputString === '1') return true;
        if (inputString === 'false' || inputString === '0') return false;
        return !!inputString;
    },
    defaultStyle() {
        return { horizontalAlign: 'center' };
    },
    /**
     * Canvas paint method — called by CanvasRenderer for each visible checkbox cell.
     * @param {CanvasRenderingContext2D} ctx
     * @param {any} value       Raw cell value (boolean)
     * @param {Object} config   Cell type config object (ct)
     * @param {{x:number,y:number,width:number,height:number}} rect
     * @param {Object} style    Cell style info
     */
    paintCell(ctx, value, config, rect, style) {
        const checked = !!value;
        const size = Math.min(16, rect.height - 4, rect.width - 4);
        const cx = rect.x + (rect.width - size) / 2;
        const cy = rect.y + (rect.height - size) / 2;
        drawCheckbox(ctx, cx, cy, size, checked);
    },
    handlesClick: true,
};

export default checkboxType;
