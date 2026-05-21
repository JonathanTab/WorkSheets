/**
 * URL cell type descriptor
 */
export const urlType = {
    id: 'url',
    renderType: 'text',
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
        // fontSize is stored in pt; convert to CSS px (× 4/3).
        const fontSizePt = style?.fontSize ?? theme?.defaultFontSize ?? 10;
        const fontPx = fontSizePt * 4 / 3;
        const fontFamily = style?.fontFamily ?? theme?.defaultFontFamily ?? 'system-ui, -apple-system, sans-serif';

        ctx.font = `normal normal ${fontPx}px ${fontFamily}`;
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        const textX = rect.x + 4;
        const textY = rect.y + rect.height / 2;

        ctx.fillText(text, textX, textY);

        // Underline — positioned just below the text's em-box.
        const tw = ctx.measureText(text).width;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(textX, textY + fontPx / 2 + 1);
        ctx.lineTo(textX + tw, textY + fontPx / 2 + 1);
        ctx.stroke();
    },
};

export default urlType;
