/**
 * Generic Yjs document lifecycle helpers — usable by every sub-app (sheets,
 * docs, svg, …). Apps describe their doc shape via an AppSchema and the
 * helpers handle the rest: structure validation, schema-version stamping,
 * migration with skip-when-current, and read-only fallback when a doc was
 * written under a newer schema than the client knows about.
 *
 * The contract is intentionally minimal so adding a new sub-app only requires
 * defining an AppSchema and calling `prepareDocForUse`.
 */

import * as Y from 'yjs';

/**
 * @typedef {Object} AppSchema
 * @property {string} rootKey               Top-level Y.Map key (e.g. 'spreadsheet')
 * @property {number} version               Integer schema version this client knows
 * @property {string} [metadataKey]         Sub-map for metadata (default 'metadata')
 * @property {string} [schemaVersionKey]    Key within metadata storing the version
 *                                          stamp (default 'schemaVersion')
 * @property {(ydoc: Y.Doc) => boolean} isStructureValid
 *   Returns true when the doc has the app's expected root structure.
 *   Used to distinguish a populated doc from an empty/never-initialized one.
 * @property {(ydoc: Y.Doc) => void} initialize
 *   Creates the app's root structure on an empty Y.Doc. Must be idempotent.
 * @property {(ydoc: Y.Doc) => void} migrate
 *   Forward-only migration chain. Must be idempotent. Should NOT create the
 *   root structure (that's `initialize`'s job) — only transform existing data.
 */

const DEFAULT_METADATA_KEY = 'metadata';
const DEFAULT_SCHEMA_VERSION_KEY = 'schemaVersion';

/**
 * Read the integer schemaVersion stamped into the doc's metadata.
 * Returns null when no stamp exists (pre-stamping doc, or never initialized).
 * @param {Y.Doc} ydoc
 * @param {AppSchema} schema
 * @returns {number|null}
 */
export function readSchemaVersion(ydoc, schema) {
    const metaKey = schema.metadataKey ?? DEFAULT_METADATA_KEY;
    const verKey  = schema.schemaVersionKey ?? DEFAULT_SCHEMA_VERSION_KEY;
    const meta = ydoc.getMap(schema.rootKey).get(metaKey);
    if (!(meta instanceof Y.Map)) return null;
    const v = meta.get(verKey);
    return typeof v === 'number' ? v : null;
}

/**
 * Write the client's schemaVersion into the doc's metadata map.
 * Creates the metadata map if absent. Tagged with the supplied origin so
 * apps can keep it out of their undo stack.
 * @param {Y.Doc} ydoc
 * @param {AppSchema} schema
 * @param {*} [origin]  Yjs transaction origin (e.g. an app-specific MIGRATION symbol)
 */
export function stampSchemaVersion(ydoc, schema, origin = undefined) {
    const metaKey = schema.metadataKey ?? DEFAULT_METADATA_KEY;
    const verKey  = schema.schemaVersionKey ?? DEFAULT_SCHEMA_VERSION_KEY;
    const root = ydoc.getMap(schema.rootKey);
    ydoc.transact(() => {
        let meta = root.get(metaKey);
        if (!(meta instanceof Y.Map)) {
            meta = new Y.Map();
            root.set(metaKey, meta);
        }
        meta.set(verKey, schema.version);
    }, origin);
}

/**
 * @typedef {Object} PrepareResult
 * @property {Y.Doc} ydoc
 * @property {boolean} readOnly
 *   True when the doc was last written under a schema newer than this client
 *   knows. Apps must refuse mutations in this state and surface a banner.
 * @property {string|null} readOnlyReason
 * @property {'none'|'auto-initialized'} recovery
 *   'auto-initialized' means the doc was empty after server-sync confirmation
 *   and we ran the app's initializer to recover.
 * @property {boolean} migrated
 *   True when migrations actually ran (i.e. stamp was missing or older).
 */

/**
 * Prepare a loaded Yjs doc for app use. Handles:
 *   - Missing root structure (waits for server sync; auto-initializes if
 *     server confirms the doc is genuinely empty; otherwise throws).
 *   - Schema version check (read-only mode for newer-than-client docs).
 *   - Forward migrations (skipped when the doc is already stamped current).
 *   - Stamping the current version after migrations complete.
 *
 * Callers receive a result describing what happened so the UI can surface
 * banners (read-only, recovered) without having to repeat the dance.
 *
 * @param {Object} ctx
 * @param {Y.Doc} ctx.ydoc                  Already-loaded Y.Doc (from runtime.load)
 * @param {() => Promise<boolean>} ctx.waitForServerSync
 *   Returns true if server sync was confirmed, false on timeout/offline.
 * @param {AppSchema} ctx.schema
 * @param {{ warn?: (msg: string) => void }} [ctx.log]
 * @returns {Promise<PrepareResult>}
 */
export async function prepareDocForUse({ ydoc, waitForServerSync, schema, log }) {
    const warn = log?.warn ?? (() => {});

    /** @type {'none'|'auto-initialized'} */
    let recovery = 'none';

    if (!schema.isStructureValid(ydoc)) {
        const synced = await waitForServerSync();
        if (!schema.isStructureValid(ydoc)) {
            if (!synced) {
                // No local structure and we never reached the server: this
                // file was created elsewhere and hasn't been downloaded for
                // offline use yet. Don't return an empty doc — the app can't
                // distinguish it from a corrupted doc.
                throw new Error(
                    'Document is not available offline. Reconnect to load this file.'
                );
            }
            // Server confirmed the doc is genuinely empty. Either the
            // initializer never finished (half-completed create) or this is a
            // brand-new doc from another device that synced before its
            // creator finished initializing. Either way it's safe to run our
            // initializer now — there is no real data to race against.
            warn(`Doc empty after server sync; auto-initializing structure`);
            schema.initialize(ydoc);
            recovery = 'auto-initialized';
        }
    }

    const docVersion = readSchemaVersion(ydoc, schema);
    if (docVersion != null && docVersion > schema.version) {
        warn(`Doc is at schema v${docVersion}, client is v${schema.version} — opening read-only`);
        return {
            ydoc,
            readOnly: true,
            readOnlyReason:
                `This document was last edited with a newer version of the app ` +
                `(schema v${docVersion}). Reload to get the latest version before editing.`,
            recovery,
            migrated: false,
        };
    }

    // Skip migrations when the doc is already stamped at our version. Migrations
    // are idempotent so re-running is safe, but on large docs they walk every
    // sheet/page — the stamp lets us avoid that cost on warm loads.
    let migrated = false;
    if (docVersion == null || docVersion < schema.version) {
        schema.migrate(ydoc);
        // The migrate function is expected to stamp via stampSchemaVersion,
        // but as a safety net we stamp here too in case a fresh
        // initialize-then-load path skipped the migrate call.
        if (readSchemaVersion(ydoc, schema) !== schema.version) {
            stampSchemaVersion(ydoc, schema);
        }
        migrated = true;
    }

    return {
        ydoc,
        readOnly: false,
        readOnlyReason: null,
        recovery,
        migrated,
    };
}
