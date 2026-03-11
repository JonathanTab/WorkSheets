/**
 * URL cell type descriptor
 */
export const urlType = {
    id: 'url',
    formatValue(rawValue) {
        return String(rawValue);
    },
    parseInput(inputString) {
        return inputString;
    },
    defaultStyle() {
        return { horizontalAlign: 'left', color: '#1a73e8', underline: true };
    },
    /**
     * Canvas paint method — paints URL text with blue color + underline.
     * @param {CanvasRenderingContext2D} ctx
     * @param {any} value
     * @param {Object} config
     * @param {{x:number,y:number,width:number,height:number}} rect
     * @param {Object} style
     * @param {Object} theme
     */
    paintCell(ctx, value, config, rect, style, theme) {
        const text = String(value ?? '');
        if (!text) return;

        const color = theme?.urlColor ?? '#1a73e8';
        const fontSize = style?.fontSize ?? theme?.defaultFontSize ?? 13;
        const fontFamily = style?.fontFamily ?? theme?.defaultFontFamily ?? 'system-ui, -apple-system, sans-serif';

        ctx.font = `normal normal ${fontSize}px ${fontFamily}`;
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        const textX = rect.x + 4;
        const textY = rect.y + rect.height / 2;

        ctx.fillText(text, textX, textY);

        // Underline
        const tw = ctx.measureText(text).width;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(textX, textY + 7);
        ctx.lineTo(textX + tw, textY + 7);
        ctx.stroke();
    },
};

export default urlType;
