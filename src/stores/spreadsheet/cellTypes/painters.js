/**
 * Canvas drawing utilities for cell type painters.
 *
 * These functions draw cell-type-specific icons and content onto a
 * CanvasRenderingContext2D. All coordinates are in CSS pixels (the caller
 * is responsible for applying the devicePixelRatio scale via ctx.scale).
 *
 * New cell types can import and use these helpers, or add their own below.
 */

/**
 * Draw a checkbox icon.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x       - Left edge of checkbox square
 * @param {number} y       - Top edge of checkbox square
 * @param {number} size    - Width and height of the checkbox square
 * @param {boolean} checked
 * @param {string} [checkedColor='#1a73e8']
 */
export function drawCheckbox(ctx, x, y, size, checked, checkedColor = '#1a73e8') {
    const radius = Math.max(1, size * 0.12);

    ctx.save();

    // Box
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, size, size, radius);
    } else {
        // Fallback for older browsers
        ctx.rect(x, y, size, size);
    }

    if (checked) {
        ctx.fillStyle = checkedColor;
        ctx.fill();

        // Checkmark
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.5, size * 0.12);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x + size * 0.2, y + size * 0.52);
        ctx.lineTo(x + size * 0.42, y + size * 0.72);
        ctx.lineTo(x + size * 0.8, y + size * 0.28);
        ctx.stroke();
    } else {
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#c0c0c0';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Draw a single star (5-pointed) at (cx, cy).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx      - Center X
 * @param {number} cy      - Center Y
 * @param {number} outerR  - Outer radius
 * @param {number} innerR  - Inner radius
 * @param {boolean} filled
 * @param {string} [filledColor='#fbbc04']
 * @param {string} [emptyColor='#d1d5db']
 */
export function drawStar(ctx, cx, cy, outerR, innerR, filled, filledColor = '#fbbc04', emptyColor = '#d1d5db') {
    const points = 5;
    const step = Math.PI / points;

    ctx.beginPath();
    for (let i = 0; i < 2 * points; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const angle = i * step - Math.PI / 2;
        const px = cx + r * Math.cos(angle);
        const py = cy + r * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.closePath();

    ctx.fillStyle = filled ? filledColor : emptyColor;
    ctx.fill();
}

/**
 * Draw a row of rating stars inside the given cell rect.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cellX       - Cell left in CSS pixels
 * @param {number} cellY       - Cell top in CSS pixels
 * @param {number} cellW       - Cell width
 * @param {number} cellH       - Cell height
 * @param {number} value       - Current rating (0–max)
 * @param {number} [max=5]     - Max stars
 * @param {string} [filledColor='#fbbc04']
 */
export function drawRating(ctx, cellX, cellY, cellW, cellH, value, max = 5, filledColor = '#fbbc04') {
    const starSize = Math.min(Math.floor(cellH - 6), 16);
    const outerR = starSize / 2;
    const innerR = outerR * 0.4;
    const gap = 2;
    const totalW = max * (starSize + gap) - gap;
    const startX = cellX + (cellW - totalW) / 2 + outerR;
    const cy = cellY + cellH / 2;

    for (let i = 0; i < max; i++) {
        drawStar(ctx, startX + i * (starSize + gap), cy, outerR, innerR, i < value, filledColor);
    }
}

/**
 * Measure text width using an existing canvas context (cached externally if needed).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @returns {number} Width in current CSS pixels
 */
export function measureText(ctx, text) {
    return ctx.measureText(text).width;
}
