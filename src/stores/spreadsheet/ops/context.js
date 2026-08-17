/**
 * ops/context.js — Document access, sheet resolution, and the schema-lockstep guard.
 *
 * Foundation for the shared operations layer: every op in ops/* goes through
 * these helpers so document traversal and write-safety rules exist once.
 *
 * ## Schema lockstep
 * The browser client and the Node API import SCHEMA_VERSION from the same
 * constants.js, so they cannot drift at build time. `prepareForWrite()` closes
 * the runtime half of that guarantee:
 *   - doc newer than this code  → refuse to write (we'd corrupt structures we
 *     don't understand, and Y.Map LWW would let our stale write win)
 *   - doc older than this code  → run the SAME migration the client runs
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import * as Y from 'yjs';
import { YKeyValue } from 'y-utility/y-keyvalue';
import { SCHEMA_VERSION } from '../constants.js';
import { spreadsheetSchema, readSchemaVersion, stampSchemaVersion, mkCellValuesKV, mkCellStylesKV } from '../schema.js';
import { YJS_ORIGIN } from '../yjsOrigins.js';

/** This code's schema version as an integer. */
export const CODE_SCHEMA_VERSION = parseInt(SCHEMA_VERSION, 10);

/**
 * Error carrying a machine-readable code, so HTTP/MCP layers can map failures
 * to status codes and agents can branch on `code` instead of parsing prose.
 */
export class OpError extends Error {
    /**
     * @param {string} code   e.g. 'SHEET_NOT_FOUND', 'SCHEMA_TOO_NEW'
     * @param {string} message
     * @param {object} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'OpError';
        this.code = code;
        this.details = details;
    }
}

// ─── Root traversal ────────────────────────────────────────────────────────

/** @param {Y.Doc} ydoc */
export function root(ydoc) {
    return ydoc.getMap('spreadsheet');
}

/** @param {Y.Doc} ydoc */
export function sheetsMap(ydoc) {
    return root(ydoc).get('sheets');
}

/** @param {Y.Doc} ydoc */
export function tableDataMap(ydoc) {
    return root(ydoc).get('tableData');
}

/**
 * Resolve a sheet by ID, falling back to a case-insensitive name match.
 *
 * Agents overwhelmingly refer to sheets by the name a human sees, so accepting
 * either avoids a mandatory lookup round-trip before every call.
 * @param {Y.Doc} ydoc
 * @param {string} idOrName
 * @returns {{ id: string, sheet: Y.Map<any> }}
 */
export function resolveSheet(ydoc, idOrName) {
    const sheets = sheetsMap(ydoc);
    if (!sheets) throw new OpError('NOT_A_SPREADSHEET', 'Document has no spreadsheet structure');

    const direct = sheets.get(idOrName);
    if (direct) return { id: idOrName, sheet: direct };

    const wanted = String(idOrName ?? '').trim().toLowerCase();
    for (const [id, sheet] of sheets.entries()) {
        if (String(sheet.get('name') ?? '').trim().toLowerCase() === wanted) {
            return { id, sheet };
        }
    }
    throw new OpError('SHEET_NOT_FOUND', `Sheet "${idOrName}" not found`, {
        available: listSheetNames(ydoc),
    });
}

/** @param {Y.Doc} ydoc @returns {string[]} */
export function listSheetNames(ydoc) {
    const sheets = sheetsMap(ydoc);
    if (!sheets) return [];
    return [...sheets.values()].map(s => s.get('name')).filter(Boolean);
}

/**
 * Sheet dimensions, used to resolve whole-column/row A1 bands.
 * @param {Y.Map<any>} sheet
 * @returns {{ rowCount: number, colCount: number }}
 */
export function sheetBounds(sheet) {
    return {
        rowCount: sheet.get('rowCount') ?? 0,
        colCount: sheet.get('colCount') ?? 0,
    };
}

// ─── KeyValue accessors ────────────────────────────────────────────────────

export { mkCellValuesKV, mkCellStylesKV };

/**
 * Wrap a sheet-level Y.Array-backed YKeyValue collection by key name.
 * @param {Y.Map<any>} sheet
 * @param {string} name  'rowMeta' | 'colMeta' | 'borders'
 * @returns {import('y-utility/y-keyvalue').YKeyValue|null}
 */
export function mkSheetKV(sheet, name) {
    const arr = sheet?.get(name);
    return arr instanceof Y.Array ? new YKeyValue(arr) : null;
}

// ─── Schema lockstep ───────────────────────────────────────────────────────

/**
 * Report how a document's schema version relates to this code.
 * @param {Y.Doc} ydoc
 * @returns {{ docVersion: number|null, codeVersion: number, status: 'match'|'older'|'newer'|'unstamped' }}
 */
export function schemaStatus(ydoc) {
    const docVersion = readSchemaVersion(ydoc);
    const codeVersion = CODE_SCHEMA_VERSION;
    let status;
    if (docVersion == null) status = 'unstamped';
    else if (docVersion === codeVersion) status = 'match';
    else if (docVersion < codeVersion) status = 'older';
    else status = 'newer';
    return { docVersion, codeVersion, status };
}

/**
 * Gate every write on schema compatibility, migrating forward when needed.
 *
 * Call once per document per request, before any mutation. Cheap on the happy
 * path: `migrate()` short-circuits when the doc is already stamped current.
 *
 * @param {Y.Doc} ydoc
 * @returns {{ docVersion: number|null, codeVersion: number, status: string, migrated: boolean }}
 * @throws {OpError} SCHEMA_TOO_NEW when the doc was written by newer code
 */
export function prepareForWrite(ydoc) {
    const before = schemaStatus(ydoc);

    if (before.status === 'newer') {
        throw new OpError(
            'SCHEMA_TOO_NEW',
            `Document schema v${before.docVersion} is newer than this server's v${before.codeVersion}. ` +
            `Refusing to write — upgrade the server before editing this document.`,
            before,
        );
    }

    // An unstamped doc with no sheets is not a spreadsheet we should touch.
    if (!sheetsMap(ydoc)) {
        throw new OpError('NOT_A_SPREADSHEET', 'Document has no spreadsheet structure');
    }

    let migrated = false;
    if (before.status === 'older' || before.status === 'unstamped') {
        spreadsheetSchema.migrate(ydoc);
        stampSchemaVersion(ydoc);
        migrated = true;
    }

    return { ...schemaStatus(ydoc), migrated };
}

/**
 * Run a mutation inside a Yjs transaction tagged as an API write.
 *
 * Grouping a whole operation into one transaction keeps it atomic for
 * collaborators and makes it a single undo step.
 * @template T
 * @param {Y.Doc} ydoc
 * @param {() => T} fn
 * @returns {T}
 */
export function apiTransact(ydoc, fn) {
    return ydoc.transact(fn, YJS_ORIGIN.API);
}
