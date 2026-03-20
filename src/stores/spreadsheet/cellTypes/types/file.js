/**
 * File cell type descriptor.
 *
 * Cell value (v): blob file ID string (UUID), e.g. "file_a1b2c3d4"
 * Cell type config (ct): { type: 'file', mimeType?: string, filename?: string, size?: number, fit?: string }
 *
 * Renders as file icon + filename on the canvas.
 * For image MIME types, renders the image directly (like the image type).
 * The editor component is 'file-picker' (FileEditor.svelte).
 */

import { loadImage } from '../../rendering/ImageCache.js';
import storage from '../../../storage.js';

// ─── File category helpers ─────────────────────────────────────────────────

const CATEGORY_COLORS = {
    image: '#10b981',
    pdf:   '#ef4444',
    text:  '#3b82f6',
    video: '#8b5cf6',
    audio: '#f59e0b',
    other: '#64748b',
};

/**
 * Classify a MIME type into a broad category.
 * @param {string} mimeType
 * @returns {'image'|'pdf'|'text'|'video'|'audio'|'other'}
 */
export function getFileCategory(mimeType) {
    if (!mimeType) return 'other';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.startsWith('text/')) return 'text';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'other';
}

/**
 * Human-readable file size string.
 * @param {number|null} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ─── Cell type descriptor ──────────────────────────────────────────────────

export const fileType = {
    id: 'file',

    formatValue(blobId) {
        return blobId ? String(blobId) : '';
    },

    parseInput(val) {
        return val || null;
    },

    defaultStyle() {
        return { horizontalAlign: 'left', verticalAlign: 'middle' };
    },

    getEditorComponent() {
        return { component: 'file-picker' };
    },

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {string|null} blobId
     * @param {import('../../rendering/CellPaintData.js').CellPaintItem} cellItem
     * @param {{x:number,y:number,width:number,height:number}} rect
     * @param {Object} style
     * @param {Object} theme
     */
    paintCell(ctx, blobId, cellItem, rect, style, theme) {
        const { x, y, width, height } = rect;
        const ct = cellItem?.ctConfig ?? {};
        const mimeType = ct.mimeType ?? '';
        const filename  = ct.filename  ?? '';
        const category  = getFileCategory(mimeType);
        const color     = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;

        if (!blobId) {
            _drawEmptyPlaceholder(ctx, x, y, width, height);
            return;
        }

        // Image MIME types: render the actual image
        if (category === 'image') {
            const url   = storage.app.getBlobUrl(blobId);
            const entry = loadImage(blobId, url);

            if (entry.status === 'loaded' && entry.img) {
                const fit = ct.fit ?? 'contain';
                _drawFittedImage(ctx, entry.img, x + 3, y + 3, width - 6, height - 6, fit);
                return;
            } else if (entry.status === 'loading') {
                _drawLoadingState(ctx, x, y, width, height, color, filename);
                return;
            }
            // fall through to document icon on error
        }

        _drawFileCell(ctx, x, y, width, height, color, filename, theme);
    },
};

// ─── Private draw helpers ─────────────────────────────────────────────────

function _drawFittedImage(ctx, img, x, y, w, h, fit) {
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const imgW = img.naturalWidth  || img.width;
    const imgH = img.naturalHeight || img.height;

    if (fit === 'fill') {
        ctx.drawImage(img, x, y, w, h);
    } else if (fit === 'none') {
        ctx.drawImage(img, Math.round(x + (w - imgW) / 2), Math.round(y + (h - imgH) / 2), imgW, imgH);
    } else {
        const scaleW = w / imgW;
        const scaleH = h / imgH;
        const scale  = fit === 'cover' ? Math.max(scaleW, scaleH) : Math.min(scaleW, scaleH);
        const dw = Math.round(imgW * scale);
        const dh = Math.round(imgH * scale);
        ctx.drawImage(img, Math.round(x + (w - dw) / 2), Math.round(y + (h - dh) / 2), dw, dh);
    }
    ctx.restore();
}

function _drawFileCell(ctx, x, y, w, h, color, filename, theme) {
    const pad      = 6;
    const iconSize = Math.min(h - pad * 2, 22);
    const iconX    = x + pad;
    const iconY    = y + (h - iconSize) / 2;

    _drawDocumentIcon(ctx, iconX, iconY, iconSize, color);

    const textX = iconX + iconSize + 6;
    const maxW  = w - (textX - x) - pad;

    ctx.save();
    ctx.font = `12px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle     = theme?.textColor ?? '#1e293b';
    ctx.textAlign     = 'left';
    ctx.textBaseline  = 'middle';

    if (filename && maxW > 10) {
        let text = filename;
        while (text.length > 1 && ctx.measureText(text + '…').width > maxW) {
            text = text.slice(0, -1);
        }
        if (text !== filename) text += '…';
        ctx.fillText(text, textX, y + h / 2);
    } else if (!filename) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText('File attached', textX, y + h / 2);
    }
    ctx.restore();
}

function _drawDocumentIcon(ctx, x, y, size, color) {
    const w    = size * 0.72;
    const h    = size;
    const fold = size * 0.22;

    ctx.save();

    // Body
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w - fold, y);
    ctx.lineTo(x + w, y + fold);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fillStyle   = color + '22';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.stroke();

    // Fold corner
    ctx.beginPath();
    ctx.moveTo(x + w - fold, y);
    ctx.lineTo(x + w - fold, y + fold);
    ctx.lineTo(x + w, y + fold);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.stroke();

    // Content lines
    const lineX  = x + w * 0.18;
    const lineW  = w * 0.55;
    const line1Y = y + h * 0.45;
    const line2Y = y + h * 0.6;
    const line3Y = y + h * 0.75;

    ctx.strokeStyle = color + '88';
    ctx.lineWidth   = 0.8;
    for (const ly of [line1Y, line2Y, line3Y]) {
        ctx.beginPath();
        ctx.moveTo(lineX, ly);
        ctx.lineTo(lineX + lineW, ly);
        ctx.stroke();
    }

    ctx.restore();
}

function _drawLoadingState(ctx, x, y, w, h, color, _filename) {
    ctx.save();
    ctx.fillStyle = color + '11';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading…', x + w / 2, y + h / 2);
    ctx.restore();
}

function _drawEmptyPlaceholder(ctx, x, y, w, h) {
    const pad = Math.max(3, Math.min(w, h) * 0.1);
    ctx.save();
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x + pad, y + pad, w - pad * 2, h - pad * 2, 2);
    else               ctx.rect(x + pad, y + pad, w - pad * 2, h - pad * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Paperclip icon
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r  = Math.min(w, h) * 0.12;
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx,       cy + r * 2);
    ctx.lineTo(cx,       cy - r);
    ctx.arcTo(cx + r * 2, cy - r, cx + r * 2, cy + r, r);
    ctx.lineTo(cx + r * 2, cy + r * 2.5);
    ctx.arcTo(cx + r * 2, cy + r * 4.5, cx, cy + r * 4.5, r * 2);
    ctx.lineTo(cx,       cy + r * 4.5);
    ctx.stroke();

    ctx.restore();
}

export default fileType;
