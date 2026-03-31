/**
 * SpreadsheetClient - Programmatic API for reading and writing plainTab sheets.
 *
 * Combines StorageAPI (file listing/lookup) with NodeYjsRuntime (Yjs sync)
 * into a single ergonomic class suitable for scripts and automation.
 *
 * Usage:
 *   import { SpreadsheetClient } from './src/cli/SpreadsheetClient.js';
 *
 *   const client = new SpreadsheetClient({ apiKey: process.env.PLAINTAB_API_KEY });
 *   await client.init();
 *
 *   const files  = client.listFiles();
 *   const file   = client.findFile('My Sheet');
 *   const ydoc   = await client.openDoc(file.id);
 *
 *   const sheets = client.listSheets(ydoc);
 *   client.setCell(ydoc, sheetId, 0, 0, 'Hello');
 *   client.insertTableRow(ydoc, sheetId, tableId, { name: 'Alice', score: 42 });
 *
 *   await client.flush();
 *   await client.close();
 */

import { StorageAPI } from '../lib/FileRegistry/api/StorageAPI.js';
import { NodeYjsRuntime } from './runtime.js';
import * as ops from './operations.js';

const DEFAULTS = {
    baseUrl: 'https://instrumenta.cf/api/storage.php',
    blobUrl: 'https://instrumenta.cf/api/blob-storage.php',
    wsUrl:   'wss://instrumenta.cf/congruum/',
};

export class SpreadsheetClient {
    /**
     * @param {object} opts
     * @param {string}  opts.apiKey   Bearer token (API key or PHP session token)
     * @param {string} [opts.baseUrl] Override storage API URL
     * @param {string} [opts.blobUrl] Override blob storage URL
     * @param {string} [opts.wsUrl]   Override WebSocket URL
     */
    constructor(opts = {}) {
        const { apiKey, baseUrl, blobUrl, wsUrl } = { ...DEFAULTS, ...opts };
        if (!apiKey) throw new Error('SpreadsheetClient: apiKey is required');

        this._apiKey  = apiKey;
        this._api     = new StorageAPI(baseUrl, blobUrl, () => apiKey);
        this._runtime = new NodeYjsRuntime(wsUrl, apiKey);

        /** @type {Map<string, import('yjs').Doc>} fileId → ydoc */
        this._docs  = new Map();
        /** @type {Map<string, object>} id → FileDescriptor */
        this._files = new Map();
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    /**
     * Fetch the current file list from the server.
     * Must be called before listFiles() / findFile() / openDoc().
     */
    async init() {
        const { files } = await this._api.fullSync();
        this._files.clear();
        for (const f of files) this._files.set(f.id, f);
    }

    /**
     * Flush outgoing Yjs updates over WebSocket, then tear down all connections.
     * @param {number} [flushMs=1000]
     */
    async close(flushMs = 1000) {
        await this._runtime.flush(flushMs);
        this._runtime.shutdown();
        this._docs.clear();
    }

    /**
     * Wait for outgoing Yjs updates to be pushed without closing.
     * @param {number} [ms=1000]
     */
    flush(ms = 1000) {
        return this._runtime.flush(ms);
    }

    // ─── File list ──────────────────────────────────────────────────────────

    /**
     * All worksheet files (scope=app, app=worksheets).
     * Requires init() to have been called first.
     * @returns {object[]}
     */
    listFiles() {
        return [...this._files.values()].filter(
            f => !f.deleted && f.type === 'yjs' && f.scope === 'app' && f.app === 'worksheets'
        );
    }

    /**
     * All non-deleted files across all apps and scopes.
     * @returns {object[]}
     */
    listAllFiles() {
        return [...this._files.values()].filter(f => !f.deleted);
    }

    /**
     * Find a file by exact title (case-sensitive). Returns the first match or null.
     * Searches all non-deleted files unless opts.app or opts.scope is specified.
     * @param {string} title
     * @param {{ app?: string, scope?: string }} [opts]
     * @returns {object|null}
     */
    findFile(title, opts = {}) {
        for (const f of this._files.values()) {
            if (f.deleted) continue;
            if (opts.app   && f.app   !== opts.app)   continue;
            if (opts.scope && f.scope !== opts.scope) continue;
            if (f.title === title) return f;
        }
        return null;
    }

    /**
     * Get a file descriptor by ID.
     * @param {string} id
     * @returns {object|null}
     */
    getFile(id) {
        return this._files.get(id) ?? null;
    }

    // ─── Document loading ───────────────────────────────────────────────────

    /**
     * Load and sync a Yjs document. Returns the same instance if already open.
     * @param {string} fileId
     * @returns {Promise<import('yjs').Doc>}
     */
    async openDoc(fileId) {
        if (this._docs.has(fileId)) return this._docs.get(fileId);

        const file = this._files.get(fileId);
        if (!file) throw new Error(`File "${fileId}" not found — did you call init()?`);
        if (file.type !== 'yjs') throw new Error(`File "${fileId}" is not a Yjs document`);

        const ydoc = await this._runtime.load(fileId, file.roomId);
        this._docs.set(fileId, ydoc);
        return ydoc;
    }

    // ─── Sheets ─────────────────────────────────────────────────────────────

    listSheets(ydoc)                    { return ops.listSheets(ydoc); }
    getSheetMeta(ydoc, sheetId)         { return ops.getSheetMeta(ydoc, sheetId); }
    createSheet(ydoc, name, opts)       { return ops.createSheet(ydoc, name, opts); }
    renameSheet(ydoc, sheetId, name)    { return ops.renameSheet(ydoc, sheetId, name); }
    deleteSheet(ydoc, sheetId)          { return ops.deleteSheet(ydoc, sheetId); }

    // ─── Cells ──────────────────────────────────────────────────────────────

    getCell(ydoc, sheetId, row, col)              { return ops.getCell(ydoc, sheetId, row, col); }
    setCell(ydoc, sheetId, row, col, value, props){ return ops.setCell(ydoc, sheetId, row, col, value, props); }
    clearCell(ydoc, sheetId, row, col)            { return ops.clearCell(ydoc, sheetId, row, col); }
    getRange(ydoc, sheetId, r1, c1, r2, c2)       { return ops.getRange(ydoc, sheetId, r1, c1, r2, c2); }
    setRange(ydoc, sheetId, r, c, values, props)  { return ops.setRange(ydoc, sheetId, r, c, values, props); }
    clearRange(ydoc, sheetId, r1, c1, r2, c2)     { return ops.clearRange(ydoc, sheetId, r1, c1, r2, c2); }

    // ─── Tables ─────────────────────────────────────────────────────────────

    listTables(ydoc, sheetId)                          { return ops.listTables(ydoc, sheetId); }
    findTableByName(ydoc, sheetId, name)               { return ops.findTableByName(ydoc, sheetId, name); }
    resolveColumnNames(ydoc, sheetId, tableId, data)   { return ops.resolveColumnNames(ydoc, sheetId, tableId, data); }
    getTableRows(ydoc, sheetId, tableId)               { return ops.getTableRows(ydoc, sheetId, tableId); }
    findTableRows(ydoc, sheetId, tableId, where)       { return ops.findTableRows(ydoc, sheetId, tableId, where); }
    insertTableRow(ydoc, sheetId, tableId, rowData)    { return ops.insertTableRow(ydoc, sheetId, tableId, rowData); }
    updateTableRow(ydoc, sheetId, tableId, idx, data)  { return ops.updateTableRow(ydoc, sheetId, tableId, idx, data); }
    upsertTableRow(ydoc, sheetId, tableId, where, data){ return ops.upsertTableRow(ydoc, sheetId, tableId, where, data); }
    deleteTableRow(ydoc, sheetId, tableId, rowIndex)   { return ops.deleteTableRow(ydoc, sheetId, tableId, rowIndex); }
}
