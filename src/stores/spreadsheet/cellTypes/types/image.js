/**
 * Image cell type descriptor.
 *
 * Cell value (v): blob file ID string (UUID), e.g. "img_a1b2c3d4"
 * Cell type config (ct): { type: 'image', fit: 'contain'|'cover'|'fill'|'none' }
 *
 * The canvas paintCell loads images via ImageCache (async, triggers re-render on load).
 * The editor component is 'image-picker' (ImageEditor.svelte).
 */

import { loadImage } from '../../rendering/ImageCache.js';
import storage from '../../../storage.js';

export const imageType = {
    id: 'image',
    renderType: 'image',

    formatValue(blobId) {
        return blobId ? String(blobId) : '';
    },

    parseInput(val) {
        return val || null;
    },

    defaultStyle() {
        return { horizontalAlign: 'center', verticalAlign: 'middle' };
    },

    getEditorComponent() {
        return { component: 'image-picker' };
    },

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {string|null} blobId  - The cell's raw value (blob file ID)
     * @param {import('../../rendering/CellPaintData.js').CellPaintItem} cellItem
     * @param {{x:number,y:number,width:number,height:number}} rect
     * @param {Object} style
     * @param {Object} theme
     */
    paintCell(ctx, blobId, cellItem, rect, style, theme) {
        const { x, y, width, height } = rect;
        const pad = 3;

        if (!blobId) {
            _drawEmptyImagePlaceholder(ctx, x, y, width, height, theme);
            return;
        }

        const url = storage.app.getBlobUrl(blobId);
        const entry = loadImage(blobId, url);

        if (entry.status === 'loaded' && entry.img) {
            const fit = cellItem?.ctConfig?.fit ?? 'contain';
            _drawFittedImage(ctx, entry.img, x + pad, y + pad, width - pad * 2, height - pad * 2, fit);
        } else if (entry.status === 'loading') {
            _drawLoadingPlaceholder(ctx, x, y, width, height, theme);
        } else {
            _drawErrorPlaceholder(ctx, x, y, width, height, theme);
        }
    },
};

// ─── Private draw helpers ─────────────────────────────────────────────────────

function _drawFittedImage(ctx, img, x, y, w, h, fit) {
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;

    if (fit === 'fill') {
        ctx.drawImage(img, x, y, w, h);
    } else if (fit === 'none') {
        const dx = Math.round(x + (w - imgW) / 2);
        const dy = Math.round(y + (h - imgH) / 2);
        ctx.drawImage(img, dx, dy, imgW, imgH);
    } else {
        // 'contain' (default) or 'cover'
        const scaleW = w / imgW;
        const scaleH = h / imgH;
        const scale = fit === 'cover' ? Math.max(scaleW, scaleH) : Math.min(scaleW, scaleH);
        const dw = Math.round(imgW * scale);
        const dh = Math.round(imgH * scale);
        const dx = Math.round(x + (w - dw) / 2);
        const dy = Math.round(y + (h - dh) / 2);
        ctx.drawImage(img, dx, dy, dw, dh);
    }

    ctx.restore();
}

function _drawEmptyImagePlaceholder(ctx, x, y, w, h, theme) {
    const pad = Math.max(4, Math.min(w, h) * 0.15);
    const ix = x + pad, iy = y + pad;
    const iw = Math.max(0, w - pad * 2), ih = Math.max(0, h - pad * 2);
    if (iw < 4 || ih < 4) return;

    ctx.save();
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(ix, iy, iw, ih, 2);
    } else {
        ctx.rect(ix, iy, iw, ih);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Image icon lines
    const iconSize = Math.min(iw, ih) * 0.5;
    const cx = x + w / 2;
    const cy = y + h / 2;

    // Frame
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    const fr = iconSize * 0.5;
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(cx - fr, cy - fr, fr * 2, fr * 2, 1);
    } else {
        ctx.rect(cx - fr, cy - fr, fr * 2, fr * 2);
    }
    ctx.stroke();

    // Sun dot
    const dotR = fr * 0.18;
    ctx.beginPath();
    ctx.arc(cx - fr * 0.35, cy - fr * 0.3, dotR, 0, Math.PI * 2);
    ctx.stroke();

    // Mountain lines
    ctx.beginPath();
    ctx.moveTo(cx - fr, cy + fr);
    ctx.lineTo(cx - fr * 0.1, cy);
    ctx.lineTo(cx + fr * 0.3, cy + fr * 0.4);
    ctx.lineTo(cx + fr * 0.6, cy - fr * 0.05);
    ctx.lineTo(cx + fr, cy + fr);
    ctx.stroke();

    ctx.restore();
}

function _drawLoadingPlaceholder(ctx, x, y, w, h, theme) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const size = Math.min(w, h, 16);

    ctx.save();
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);

    ctx.fillStyle = '#94a3b8';
    ctx.font = `${size}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('…', cx, cy);
    ctx.restore();
}

function _drawErrorPlaceholder(ctx, x, y, w, h, theme) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const size = Math.min(w, h, 14);

    ctx.save();
    ctx.fillStyle = '#fef2f2';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);

    ctx.fillStyle = '#ef4444';
    ctx.font = `${size}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚠', cx, cy);
    ctx.restore();
}

export default imageType;
