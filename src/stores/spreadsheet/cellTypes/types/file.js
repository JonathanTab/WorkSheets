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

import storage from '../../../storage.js';

// ─── File category helpers ─────────────────────────────────────────────────

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
    renderType: 'file',

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

        if (!blobId) {
            _drawEmptyPlaceholder(ctx, x, y, width, height);
            return;
        }

        const descriptor = storage.app.get(blobId);
        if (!descriptor) storage.app.resolveBlob(blobId).catch(() => {});
        const filename = descriptor?.filename ?? '';
        _drawFileCell(ctx, x, y, width, height, filename, theme);
    },
};

// ─── Private draw helpers ─────────────────────────────────────────────────

function _drawFileCell(ctx, x, y, w, h, filename, theme) {
    const color = '#64748b';
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
