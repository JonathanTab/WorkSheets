/**
 * Canvas drawing utilities for cell type painters.
 *
 * These functions draw cell-type-specific icons and content onto a
 * CanvasRenderingContext2D. All coordinates are in CSS pixels (the caller
 * is responsible for applying the devicePixelRatio scale via ctx.scale).
 *
 * Size/proportion constants come from CellPrimitiveGeometry.js so the
 * canvas and PDF renderers stay in sync.
 */

import {
    checkboxLayout,
    ratingLayout,
    starVertices,
    CHECKBOX_MAX_SIZE,
    CHECKBOX_PADDING,
} from '../rendering/CellPrimitiveGeometry.js';

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

    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, size, size, radius);
    } else {
        ctx.rect(x, y, size, size);
    }

    if (checked) {
        ctx.fillStyle = checkedColor;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.5, size * 0.12);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x + size * 0.2,  y + size * 0.52);
        ctx.lineTo(x + size * 0.42, y + size * 0.72);
        ctx.lineTo(x + size * 0.8,  y + size * 0.28);
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
 * Draw a checkbox centred inside a cell rect.
 * Uses the shared CellPrimitiveGeometry layout so canvas and PDF match.
 */
export function drawCheckboxInCell(ctx, cellX, cellY, cellW, cellH, checked) {
    const { x, y, size } = checkboxLayout(cellW, cellH, {
        maxSize:   CHECKBOX_MAX_SIZE,
        padding:   CHECKBOX_PADDING,
        minRadius: 1,
    });
    drawCheckbox(ctx, cellX + x, cellY + y, size, checked);
}

/**
 * Draw a single star (5-pointed) at (cx, cy).
 */
export function drawStar(ctx, cx, cy, outerR, innerR, filled, filledColor = '#fbbc04', emptyColor = '#d1d5db') {
    const verts = starVertices(cx, cy, outerR, innerR);
    ctx.beginPath();
    ctx.moveTo(verts[0][0], verts[0][1]);
    for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i][0], verts[i][1]);
    ctx.closePath();
    ctx.fillStyle = filled ? filledColor : emptyColor;
    ctx.fill();
}

/**
 * Draw a row of rating stars inside the given cell rect.
 * Uses the shared CellPrimitiveGeometry layout so canvas and PDF match.
 */
export function drawRating(ctx, cellX, cellY, cellW, cellH, value, max = 5, filledColor = '#fbbc04') {
    for (const { cx, cy, outerR, innerR, filled } of ratingLayout(value, max, cellW, cellH)) {
        drawStar(ctx, cellX + cx, cellY + cy, outerR, innerR, filled, filledColor);
    }
}

/**
 * Measure text width using an existing canvas context.
 */
export function measureText(ctx, text) {
    return ctx.measureText(text).width;
}
