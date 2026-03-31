/**
 * Doc Store — manages a single y-prosemirror document session.
 *
 * Uses the same storage singleton as the spreadsheet app for consistent
 * offline-first Yjs sync via IndexedDB + WebSocket.
 *
 * Yjs schema:
 *   root = ydoc.getXmlFragment('document')   ← ProseMirror content
 *   ydoc.getMap('metadata')                  ← { title, createdAt, updatedAt }
 */

import * as Y from 'yjs';
import storage from '../storage.js';

class DocSession {
    /** @type {string|null} */ docId = $state(null);
    /** @type {Y.Doc|null} */ ydoc = $state.raw(null);
    /** @type {Y.XmlFragment|null} */ fragment = $state.raw(null);
    /** @type {any} */ awareness = $state.raw(null);
    /** @type {Record<string,any>|null} */ metadata = $state(null);
    /** @type {boolean} */ isLoading = $state(false);
    /** @type {string|null} */ error = $state(null);

    /** @type {function|null} */ _metaObserver = null;

    async load(docId) {
        if (this.docId === docId && this.ydoc) return;

        this.isLoading = true;
        this.error = null;

        // Unload previous doc
        if (this.docId && this.docId !== docId) {
            this._teardown();
        }

        try {
            const ydoc = await storage.drive.loadDoc(docId);

            this.ydoc = ydoc;
            this.docId = docId;
            this.fragment = ydoc.getXmlFragment('document');

            // Get awareness for collaborative cursors
            this.awareness = storage.getAwareness?.(docId) ?? null;

            // Reactive metadata
            const metaMap = ydoc.getMap('metadata');
            this._readMeta(metaMap);
            this._metaObserver = () => this._readMeta(metaMap);
            metaMap.observe(this._metaObserver);

            // Set default metadata if empty
            if (!metaMap.get('createdAt')) {
                ydoc.transact(() => {
                    metaMap.set('createdAt', Date.now());
                    metaMap.set('updatedAt', Date.now());
                });
            }

            // Initialize page setup settings if not present
            const pageSetupMap = ydoc.getMap('pageSetup');
            if (!pageSetupMap.get('paperSize')) {
                ydoc.transact(() => {
                    pageSetupMap.set('paperSize', 'letter');
                    pageSetupMap.set('orientation', 'portrait');
                    pageSetupMap.set('marginTop', 25.4);
                    pageSetupMap.set('marginBottom', 25.4);
                    pageSetupMap.set('marginLeft', 25.4);
                    pageSetupMap.set('marginRight', 25.4);
                });
            }

            // Sync title from FileRegistry file descriptor
            const file = storage.drive.getFile(docId);
            if (file?.title && !metaMap.get('title')) {
                ydoc.transact(() => metaMap.set('title', file.title));
            }

        } catch (e) {
            console.error('[DocSession] Failed to load doc:', e);
            this.error = e.message;
        } finally {
            this.isLoading = false;
        }
    }

    _readMeta(metaMap) {
        this.metadata = {
            title: metaMap.get('title') ?? null,
            createdAt: metaMap.get('createdAt') ?? null,
            updatedAt: metaMap.get('updatedAt') ?? null,
        };
    }

    setTitle(title) {
        if (!this.ydoc) return;
        const metaMap = this.ydoc.getMap('metadata');
        this.ydoc.transact(() => {
            metaMap.set('title', title);
            metaMap.set('updatedAt', Date.now());
        });
        // Also rename via FileRegistry so drive view updates
        if (this.docId) {
            storage.drive.renameFile(this.docId, title).catch(console.warn);
        }
    }

    touchUpdatedAt() {
        if (!this.ydoc) return;
        this.ydoc.transact(() => {
            this.ydoc.getMap('metadata').set('updatedAt', Date.now());
        });
    }

    unload() {
        this._teardown();
        this.docId = null;
        this.ydoc = null;
        this.fragment = null;
        this.awareness = null;
        this.metadata = null;
        this.error = null;
    }

    _teardown() {
        if (this.ydoc && this._metaObserver) {
            this.ydoc.getMap('metadata').unobserve(this._metaObserver);
            this._metaObserver = null;
        }
    }

    // ── Page Setup ───────────────────────────────────────────────────────────
    getPageSetup() {
        if (!this.ydoc) return null;
        const pageSetupMap = this.ydoc.getMap('pageSetup');
        return {
            paperSize: pageSetupMap.get('paperSize') ?? 'letter',
            orientation: pageSetupMap.get('orientation') ?? 'portrait',
            marginTop: pageSetupMap.get('marginTop') ?? 25.4,
            marginBottom: pageSetupMap.get('marginBottom') ?? 25.4,
            marginLeft: pageSetupMap.get('marginLeft') ?? 25.4,
            marginRight: pageSetupMap.get('marginRight') ?? 25.4,
        };
    }

    setPageSetup(settings) {
        if (!this.ydoc) return;
        const pageSetupMap = this.ydoc.getMap('pageSetup');
        this.ydoc.transact(() => {
            if (settings.paperSize !== undefined) pageSetupMap.set('paperSize', settings.paperSize);
            if (settings.orientation !== undefined) pageSetupMap.set('orientation', settings.orientation);
            if (settings.marginTop !== undefined) pageSetupMap.set('marginTop', settings.marginTop);
            if (settings.marginBottom !== undefined) pageSetupMap.set('marginBottom', settings.marginBottom);
            if (settings.marginLeft !== undefined) pageSetupMap.set('marginLeft', settings.marginLeft);
            if (settings.marginRight !== undefined) pageSetupMap.set('marginRight', settings.marginRight);
        });
    }
}

export const docSession = new DocSession();

export async function loadDoc(docId) {
    return docSession.load(docId);
}

export function unloadDoc() {
    return docSession.unload();
}

/**
 * Rename a document via FileRegistry.
 * @param {string} docId
 * @param {string} newTitle
 */
export async function renameDocument(docId, newTitle) {
    await storage.drive.renameFile(docId, newTitle);
    // Also update the session metadata if this is the current doc
    if (docSession.docId === docId) {
        docSession.setTitle(newTitle);
    }
}
