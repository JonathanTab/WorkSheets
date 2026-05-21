/**
 * Dropdown cell type descriptor
 *
 * Presents a list of allowed values. The chosen value is stored as a plain
 * string/number. config shape:
 *   { type: 'dropdown', options: ['Option A', 'Option B', ...], allowCustom: false }
 *
 * Canvas rendering shows a ▾ indicator at the right edge of the cell.
 * Clicking/pressing Enter opens a DOM dropdown overlay (handled in Grid.svelte).
 */
export const dropdownType = {
    id: 'dropdown',
    renderType: 'dropdown',

    formatValue(rawValue, _config) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return '';
        return String(rawValue);
    },

    parseInput(inputString, config) {
        if (inputString === '' || inputString === null) return null;
        if (config?.allowCustom === false && Array.isArray(config?.options)) {
            const match = config.options.find(
                o => String(o).toLowerCase() === inputString.toLowerCase()
            );
            return match !== undefined ? match : inputString;
        }
        return inputString;
    },

    defaultStyle() {
        return { horizontalAlign: 'left' };
    },

    /**
     * Canvas cell painter — text value + ▾ chevron on the right.
     * Implements the CellTypeRegistry paintCell contract so CanvasRenderer
     * handles dropdown through the descriptor path (no special switch case needed).
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {any} _value        raw cell value (unused; cell.displayValue is preferred)
     * @param {import('../../rendering/CellPaintData.js').CellPaintItem} cell
     * @param {{ x:number, y:number, width:number, height:number }} rect
     * @param {{ textColor?:string, bold?:boolean, italic?:boolean, fontSize?:number, fontFamily?:string }} style
     * @param {object} theme
     */
    paintCell(ctx, _value, cell, rect, style, theme) {
        const { x, y, width, height } = rect;
        const ARROW_W = 16;
        const PAD     = 4;
        const text    = cell.displayValue ?? '';

        // Build font string directly — no CanvasRenderer internals needed
        const italic  = style.italic  ? 'italic'  : 'normal';
        const weight  = style.bold    ? 'bold'    : 'normal';
        const sizePx  = (style.fontSize  || theme?.defaultFontSize  || 10) * 4 / 3;
        const family  = style.fontFamily || theme?.defaultFontFamily || 'system-ui, sans-serif';
        ctx.font = `${italic} ${weight} ${sizePx}px ${family}`;
        ctx.fillStyle    = style.textColor || theme?.defaultText || '#1e293b';
        ctx.textBaseline = 'middle';
        ctx.textAlign    = 'left';

        // Clip text to leave room for the arrow
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + PAD, y, width - ARROW_W - PAD * 2, height);
        ctx.clip();
        if (text) ctx.fillText(text, x + PAD, y + height / 2);
        ctx.restore();

        // ▾ chevron
        const arrowX    = x + width - ARROW_W / 2;
        const arrowY    = y + height / 2;
        const arrowSize = 4;
        ctx.fillStyle = '#64748b';
        ctx.beginPath();
        ctx.moveTo(arrowX - arrowSize, arrowY - arrowSize / 2);
        ctx.lineTo(arrowX + arrowSize, arrowY - arrowSize / 2);
        ctx.lineTo(arrowX,             arrowY + arrowSize / 2);
        ctx.closePath();
        ctx.fill();
    },
};

export default dropdownType;
