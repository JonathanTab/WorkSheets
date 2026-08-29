import { getFontMetrics, computeBaselineY, ptToPx, snapToDevice } from '../../rendering/fontUnits.js';

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
        // Only the static "list" source carries its valid values in config.options.
        // For range/table sources the options are resolved dynamically (at the grid
        // layer) and aren't available here, so we can't validate against them —
        // accept the value as-is. Guarding on a non-empty options array also avoids
        // rejecting every value when source!=='list' leaves options as [].
        const isListSource = !config?.source || config.source === 'list';
        if (config?.allowCustom === false && isListSource &&
            Array.isArray(config?.options) && config.options.length > 0) {
            const match = config.options.find(o => {
                const optVal = typeof o === 'string' ? o : o?.value ?? String(o);
                return optVal.toLowerCase() === String(inputString).toLowerCase();
            });
            // allowCustom:false means only listed options are valid — reject a
            // non-matching value rather than silently storing it.
            // Extract value if match is an object, otherwise return as-is.
            if (match !== undefined) {
                return typeof match === 'string' ? match : match?.value ?? String(match);
            }
            return null;
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
    paintCell(ctx, _value, cell, rect, style, theme, dpr = 1) {
        const { x, y, width, height } = rect;
        const ARROW_W = 16;
        const PAD     = 4;
        const text    = cell.displayValue ?? '';

        // Build font string directly — no CanvasRenderer internals needed
        const italic  = style.italic  ? 'italic'  : 'normal';
        const weight  = style.bold    ? 'bold'    : 'normal';
        const sizePx  = ptToPx(style.fontSize  || theme?.defaultFontSize  || 10);
        const family  = style.fontFamily || theme?.defaultFontFamily || 'system-ui, sans-serif';
        const font = `${italic} ${weight} ${sizePx}px ${family}`;
        ctx.font = font;
        ctx.fillStyle    = style.textColor || theme?.defaultText || '#1e293b';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign    = 'left';

        // Snap baseline + x to the device-pixel grid so glyphs stay crisp at
        // fractional cell positions / non-integer DPR (matches CanvasRenderer).
        const textY = snapToDevice(computeBaselineY(y, height, 'middle', getFontMetrics(font), 2), dpr);

        // Clip text to leave room for the arrow
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + PAD, y, width - ARROW_W - PAD * 2, height);
        ctx.clip();
        if (text) ctx.fillText(text, snapToDevice(x + PAD, dpr), textY);
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
