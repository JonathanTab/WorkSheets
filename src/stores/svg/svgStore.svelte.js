/**
 * SVG Store — manages a single SVG drawing session using blob storage.
 *
 * SVG files are stored as blob files:
 *   type: 'blob', app: 'svg', mimeType: 'image/svg+xml'
 *
 * Load/save delegates to the FileRegistry blob API.
 */

import storage from '../storage.js';

const EMPTY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"></svg>`;

class SvgSession {
    /** @type {string|null} */ fileId = $state(null);
    /** @type {string|null} */ title = $state(null);
    /** @type {string|null} */ svgContent = $state(null);
    /** @type {boolean} */ isLoading = $state(false);
    /** @type {string|null} */ error = $state(null);
    /** @type {boolean} */ isDirty = $state(false);

    async load(fileId) {
        if (this.fileId === fileId && this.svgContent && !this.error) return;

        this.isLoading = true;
        this.error = null;
        this.isDirty = false;

        if (this.fileId && this.fileId !== fileId) {
            this._reset();
        }

        this.fileId = fileId;

        try {
            const file = storage.drive.getFile(fileId);
            this.title = file?.title ?? 'Untitled Drawing';

            const blob = await storage.drive.fetchBlob(fileId);
            this.svgContent = blob ? await blob.text() : EMPTY_SVG;
        } catch (e) {
            console.error('[SvgSession] load error', e);
            this.error = e.message;
        } finally {
            this.isLoading = false;
        }
    }

    async save(svgString) {
        if (!this.fileId) throw new Error('No file loaded');
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        await storage.drive.updateBlob(this.fileId, blob);
        this.isDirty = false;
    }

    markDirty() {
        this.isDirty = true;
    }

    unload() {
        this._reset();
        this.fileId = null;
    }

    _reset() {
        this.title = null;
        this.svgContent = null;
        this.isLoading = false;
        this.error = null;
        this.isDirty = false;
    }
}

export const svgSession = new SvgSession();

export async function loadSvgFile(fileId) {
    await svgSession.load(fileId);
}
