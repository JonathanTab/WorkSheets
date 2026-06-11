/**
 * Docs Schema — Yjs document lifecycle contract for the docs sub-app.
 *
 * The docs doc shape is intentionally FLAT (it predates the AppSchema contract
 * and the content fragment is bound to y-prosemirror at the top level, so it
 * cannot be re-parented):
 *
 *   ydoc.getXmlFragment('document')   ← ProseMirror content (owned by y-prosemirror)
 *   ydoc.getMap('metadata')           ← { title, createdAt, updatedAt, sys: Y.Map }
 *   ydoc.getMap('pageSetup')          ← { paperSize, orientation, margin* }
 *
 * The schema-version stamp lives at `metadata.sys.schemaVersion`. We therefore
 * point the AppSchema's `rootKey` at 'metadata' and its `metadataKey` at 'sys',
 * so the generic readSchemaVersion/stampSchemaVersion helpers read/write the
 * stamp inside the nested `sys` map.
 *
 * "Has this doc been initialized?" is answered by metadata.createdAt — that is
 * the marker `initialize` writes and the only thing distinguishing a populated
 * doc from a never-initialized (or not-yet-synced) one.
 *
 * See src/lib/FileRegistry/WRITING-A-SUBAPP.md for the full contract.
 */

import * as Y from 'yjs';
import {
    DOCS_SCHEMA_VERSION,
    DOCS_META_KEYS,
    DEFAULT_PAGE_SETUP,
} from './constants.js';
import { DOCS_YJS_ORIGIN } from './yjsOrigins.js';
import {
    readSchemaVersion as _readSchemaVersionGeneric,
    stampSchemaVersion as _stampSchemaVersionGeneric,
} from '../../lib/FileRegistry/yjsDocLifecycle.js';

/** Shorthand: run a Yjs transaction tagged as a migration (never undoable). */
const migrateTransact = (ydoc, fn) => ydoc.transact(fn, DOCS_YJS_ORIGIN.MIGRATION);

// ─── Public helpers ────────────────────────────────────────────────────────────

/** Read the stamped schema version (or null if unstamped). */
export function readSchemaVersion(ydoc) {
    return _readSchemaVersionGeneric(ydoc, docsAppSchema);
}

/** Stamp the current client schema version into metadata.sys. */
export function stampSchemaVersion(ydoc) {
    _stampSchemaVersionGeneric(ydoc, docsAppSchema, DOCS_YJS_ORIGIN.MIGRATION);
}

/** True once `initialize` has stamped this doc's creation marker. */
function isInitialized(ydoc) {
    return ydoc.getMap('metadata').get(DOCS_META_KEYS.CREATED_AT) != null;
}

/** Apply the default page-setup values onto a pageSetup map if absent. Idempotent. */
function ensurePageSetupDefaults(pageSetup) {
    if (pageSetup.get('paperSize')) return;
    for (const [k, v] of Object.entries(DEFAULT_PAGE_SETUP)) {
        pageSetup.set(k, v);
    }
}

// ─── Schema initialisation ─────────────────────────────────────────────────────

/**
 * Create the docs root structure on an empty Y.Doc. Idempotent.
 *
 * Called two ways:
 *   (a) by `createDocument` (via createAndInitializeFile) at create time, and
 *   (b) by prepareDocForUse as the auto-init recovery path when the server has
 *       confirmed the doc is genuinely empty.
 *
 * MUST be safe to run on an already-initialized doc (guards on createdAt).
 * MUST NOT touch the content XmlFragment — y-prosemirror owns that and seeds it
 * with an empty paragraph on first editor mount.
 *
 * @param {Y.Doc} ydoc
 */
export function initializeDocument(ydoc) {
    const meta = ydoc.getMap('metadata');
    if (meta.get(DOCS_META_KEYS.CREATED_AT)) return; // belt-and-braces idempotency

    migrateTransact(ydoc, () => {
        const now = Date.now();
        meta.set(DOCS_META_KEYS.CREATED_AT, now);
        meta.set(DOCS_META_KEYS.UPDATED_AT, now);

        ensurePageSetupDefaults(ydoc.getMap('pageSetup'));

        // Stamp the schema version inside metadata.sys.
        let sys = meta.get(DOCS_META_KEYS.SYS);
        if (!(sys instanceof Y.Map)) {
            sys = new Y.Map();
            meta.set(DOCS_META_KEYS.SYS, sys);
        }
        sys.set(DOCS_META_KEYS.SCHEMA_VERSION, parseInt(DOCS_SCHEMA_VERSION));
    });
}

// ─── Migration chain ───────────────────────────────────────────────────────────

export const docsSchema = {
    version: DOCS_SCHEMA_VERSION,
    /**
     * Forward-only, idempotent migration of an EXISTING document.
     *
     * IMPORTANT: never create the root structure here. If the doc isn't
     * initialized (no createdAt) it is either brand-new (initialized solely by
     * createDocument → initializeDocument) or its server state hasn't synced
     * yet. Writing structure now would race the server's real data and win via
     * Y.Map LWW. prepareDocForUse waits for server sync before invoking us and
     * runs `initialize` itself when the doc is confirmed empty.
     *
     * @param {Y.Doc} ydoc
     */
    migrate: (ydoc) => {
        if (!isInitialized(ydoc)) return; // never create structure here

        const stamped = readSchemaVersion(ydoc);
        if (stamped != null && stamped >= parseInt(DOCS_SCHEMA_VERSION)) return;

        // v1 — adopt the lifecycle contract. Pre-contract docs were created via
        // plain createFile and got their metadata/pageSetup written speculatively
        // on first load; backfill any page-setup defaults that never landed so
        // every stamped doc has a complete shape. Idempotent.
        migrateTransact(ydoc, () => {
            ensurePageSetupDefaults(ydoc.getMap('pageSetup'));
        });

        stampSchemaVersion(ydoc);
    },
};

/** @type {import('../../lib/FileRegistry/yjsDocLifecycle.js').AppSchema} */
export const docsAppSchema = {
    rootKey: 'metadata',
    version: parseInt(DOCS_SCHEMA_VERSION),
    metadataKey: DOCS_META_KEYS.SYS,
    schemaVersionKey: DOCS_META_KEYS.SCHEMA_VERSION,
    isStructureValid: (ydoc) => isInitialized(ydoc),
    initialize: (ydoc) => initializeDocument(ydoc),
    migrate: (ydoc) => docsSchema.migrate(ydoc),
};

export default docsSchema;
