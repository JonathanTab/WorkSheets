/**
 * Doc Store — manages a single y-prosemirror document session.
 *
 * Conforms to the Yjs sub-app lifecycle contract (see
 * src/lib/FileRegistry/WRITING-A-SUBAPP.md). Loading goes through
 * `prepareDocForUse`, which gives us: server-sync gating, auto-init recovery,
 * read-only fallback when a doc was written under a newer schema, and
 * missed-rotation notices — exactly as the spreadsheet sub-app does.
 *
 * Yjs schema (flat, see schema.js):
 *   ydoc.getXmlFragment('document')   ← ProseMirror content
 *   ydoc.getMap('metadata')           ← { title, createdAt, updatedAt, sys }
 *   ydoc.getMap('pageSetup')          ← { paperSize, orientation, margin* }
 */

import storage from '../storage.js';
import { log } from '../../util/log.js';
import { APP_DOCS } from '../../lib/appTypes.js';
import { prepareDocForUse } from '../../lib/FileRegistry/yjsDocLifecycle.js';
import { docsAppSchema, initializeDocument, readSchemaVersion } from './schema.js';
import { DOCS_YJS_ORIGIN } from './yjsOrigins.js';
import { DEFAULT_PAGE_SETUP } from './constants.js';

class DocSession {
    /** @type {string|null} */ docId = $state(null);
    /** @type {import('yjs').Doc|null} */ ydoc = $state.raw(null);
    /** @type {import('yjs').XmlFragment|null} */ fragment = $state.raw(null);
    /** @type {any} */ awareness = $state.raw(null);
    /** @type {Record<string,any>|null} */ metadata = $state(null);
    /** @type {boolean} */ isLoading = $state(false);
    /** @type {string|null} */ error = $state(null);

    /**
     * True when the doc was last written under a schema newer than this client.
     * The editor must refuse mutations and surface a banner in this state.
     */
    /** @type {boolean} */ readOnly = $state(false);
    /** @type {string|null} */ readOnlyReason = $state(null);

    /**
     * Transient notices the UI surfaces as dismissible banners (auto-init
     * recovery, missed-rotation).
     * @type {Array<{id:string, severity:'info'|'warn', message:string}>}
     */
    notices = $state([]);

    /** @type {function|null} */ #metaObserver = null;
    /** @type {function|null} */ #cleanupMissedRotation = null;
    /** @type {Promise<void>|null} */ #loadPromise = null;

    async load(docId) {
        if (this.#loadPromise) await this.#loadPromise;
        if (this.docId === docId && this.ydoc) return;

        this.#loadPromise = this.#doLoad(docId);
        try {
            await this.#loadPromise;
        } finally {
            this.#loadPromise = null;
        }
    }

    /**
     * Force a full teardown and reload of the current document.
     * Used after a history restore: the runtime has already destroyed the old
     * Y.Doc and loaded a fresh one under the new roomId. We tear down session
     * observers (without unloading the runtime doc) and re-initialize.
     */
    async reload() {
        const docId = this.docId;
        if (!docId) return;
        if (this.#loadPromise) await this.#loadPromise;
        this.#teardownSession();
        this.docId = null; // force #doLoad past the early-return guard
        this.#loadPromise = this.#doLoad(docId);
        try {
            await this.#loadPromise;
        } finally {
            this.#loadPromise = null;
        }
    }

    /** @param {string} docId */
    async #doLoad(docId) {
        this.isLoading = true;
        this.error = null;

        try {
            this.#teardownSession();

            const ydoc = await storage.drive.loadDoc(docId);

            // Generic lifecycle: server-sync gate, auto-init recovery, schema
            // version check (read-only on newer-than-client), and migrations
            // with skip-when-stamped-current.
            const prep = await prepareDocForUse({
                ydoc,
                waitForServerSync: () => storage.drive.waitForServerSync(docId),
                schema: docsAppSchema,
                log,
            });

            this.readOnly = prep.readOnly;
            this.readOnlyReason = prep.readOnlyReason;
            this.notices = [];
            if (prep.recovery === 'auto-initialized') {
                this.#pushNotice('warn',
                    'This file was empty on the server and has been re-initialized as a blank document.');
            }

            // Surface missed-rotation events for the currently loaded doc only.
            this.#cleanupMissedRotation?.();
            const handleMissedRotation = (payload) => {
                if (payload?.fileId !== docId) return;
                this.#pushNotice('warn',
                    'This document was restored from a snapshot while you were offline. ' +
                    'Any edits you made offline have been discarded — the restored version is now active.');
            };
            storage.on('missed-rotation', handleMissedRotation);
            this.#cleanupMissedRotation = () => storage.off('missed-rotation', handleMissedRotation);

            this.ydoc = ydoc;
            this.docId = docId;
            this.fragment = ydoc.getXmlFragment('document');
            this.awareness = storage.getAwareness?.(docId) ?? null;

            // Reactive metadata.
            const metaMap = ydoc.getMap('metadata');
            this.#readMeta(metaMap);
            this.#metaObserver = () => this.#readMeta(metaMap);
            metaMap.observe(this.#metaObserver);

            // Sync title from the FileRegistry descriptor if the doc lacks one.
            // Never write while read-only — a stale client must not touch a
            // newer-schema doc.
            if (!this.readOnly) {
                const file = storage.drive.getFile(docId);
                if (file?.title && !metaMap.get('title')) {
                    this.#transactLocal(() => metaMap.set('title', file.title));
                }
            }
        } catch (e) {
            log.error?.('[DocSession] Failed to load doc:', e);
            this.error = e.message;
        } finally {
            this.isLoading = false;
        }
    }

    #readMeta(metaMap) {
        this.metadata = {
            title: metaMap.get('title') ?? null,
            createdAt: metaMap.get('createdAt') ?? null,
            updatedAt: metaMap.get('updatedAt') ?? null,
        };
    }

    /** Run a local (undoable-context-neutral) tagged transaction. */
    #transactLocal(fn) {
        this.ydoc?.transact(fn, DOCS_YJS_ORIGIN.LOCAL);
    }

    setTitle(title) {
        if (!this.ydoc || this.readOnly) return;
        const metaMap = this.ydoc.getMap('metadata');
        this.#transactLocal(() => {
            metaMap.set('title', title);
            metaMap.set('updatedAt', Date.now());
        });
        if (this.docId) {
            storage.drive.renameFile(this.docId, title).catch((e) => log.warn?.(e));
        }
    }

    touchUpdatedAt() {
        if (!this.ydoc || this.readOnly) return;
        this.#transactLocal(() => {
            this.ydoc.getMap('metadata').set('updatedAt', Date.now());
        });
    }

    unload() {
        this.#teardownSession();
        this.docId = null;
        this.ydoc = null;
        this.fragment = null;
        this.awareness = null;
        this.metadata = null;
        this.error = null;
        this.readOnly = false;
        this.readOnlyReason = null;
        this.notices = [];
    }

    /** Detach observers/listeners without clearing the current doc reference. */
    #teardownSession() {
        if (this.ydoc && this.#metaObserver) {
            this.ydoc.getMap('metadata').unobserve(this.#metaObserver);
        }
        this.#metaObserver = null;
        this.#cleanupMissedRotation?.();
        this.#cleanupMissedRotation = null;
    }

    // ── Notices ────────────────────────────────────────────────────────────────
    /**
     * @param {'info'|'warn'} severity
     * @param {string} message
     */
    #pushNotice(severity, message) {
        this.notices = [
            ...this.notices,
            { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, severity, message },
        ];
    }

    /** Dismiss a notice by id. Public so banner components can call it. */
    dismissNotice(id) {
        this.notices = this.notices.filter((n) => n.id !== id);
    }

    // ── Page Setup ───────────────────────────────────────────────────────────
    getPageSetup() {
        if (!this.ydoc) return null;
        const pageSetupMap = this.ydoc.getMap('pageSetup');
        return {
            paperSize: pageSetupMap.get('paperSize') ?? DEFAULT_PAGE_SETUP.paperSize,
            orientation: pageSetupMap.get('orientation') ?? DEFAULT_PAGE_SETUP.orientation,
            marginTop: pageSetupMap.get('marginTop') ?? DEFAULT_PAGE_SETUP.marginTop,
            marginBottom: pageSetupMap.get('marginBottom') ?? DEFAULT_PAGE_SETUP.marginBottom,
            marginLeft: pageSetupMap.get('marginLeft') ?? DEFAULT_PAGE_SETUP.marginLeft,
            marginRight: pageSetupMap.get('marginRight') ?? DEFAULT_PAGE_SETUP.marginRight,
        };
    }

    setPageSetup(settings) {
        if (!this.ydoc || this.readOnly) return;
        const pageSetupMap = this.ydoc.getMap('pageSetup');
        this.#transactLocal(() => {
            for (const key of ['paperSize', 'orientation', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight']) {
                if (settings[key] !== undefined) pageSetupMap.set(key, settings[key]);
            }
        });
    }
}

export const docSession = new DocSession();

/**
 * Create a new document. Initializes the Yjs structure at creation time (with
 * rollback verification) rather than speculatively on first load.
 * @param {string} title
 * @param {string|null} [folderId]
 */
export async function createDocument(title, folderId = null) {
    return storage.drive.createAndInitializeFile({
        title,
        app: APP_DOCS,
        folderId,
        initializer: (ydoc) => initializeDocument(ydoc),
    });
}

export async function loadDoc(docId) {
    return docSession.load(docId);
}

export function unloadDoc() {
    return docSession.unload();
}

/** Read the live doc's stamped schema version (for HistoryManager). */
export function getDocSchemaVersion() {
    return docSession.ydoc ? readSchemaVersion(docSession.ydoc) : null;
}

/**
 * Rename a document via FileRegistry.
 * @param {string} docId
 * @param {string} newTitle
 */
export async function renameDocument(docId, newTitle) {
    await storage.drive.renameFile(docId, newTitle);
    if (docSession.docId === docId) {
        docSession.setTitle(newTitle);
    }
}
