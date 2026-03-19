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
 *   await client.init();                            // sync file list
 *
 *   const files = client.listFiles();               // all worksheet files
 *   const ydoc  = await client.openDoc(fileId);     // load + sync Yjs doc
 *
 *   const sheets = client.listSheets(ydoc);
 *   client.setCell(ydoc, sheetId, 0, 0, 'Hello');
 *   await client.insertTableRow(ydoc, sheetId, tableId, { name: 'Alice', score: 42 });
 *
 *   await client.flush();   // wait for WS to push outgoing changes
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
     * @param {string}  opts.apiKey   Bearer token for authentication
     * @param {string} [opts.baseUrl] Override storage API URL
     * @param {string} [opts.blobUrl] Override blob storage URL
     * @param {string} [opts.wsUrl]   Override WebSocket URL
     */
    constructor(opts = {}) {
        const { apiKey, baseUrl, blobUrl, wsUrl } = { ...DEFAULTS, ...opts };
        if (!apiKey) throw new Error('SpreadsheetClient: apiKey is required');

        this._api     = new StorageAPI(baseUrl, blobUrl, () => apiKey);
        this._runtime = new NodeYjsRuntime(wsUrl);
        /** @type {Map<string, import('yjs').Doc>} docId → ydoc */
        this._docs = new Map();
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
     * @param {number} [flushMs=800]
     */
    async close(flushMs = 800) {
        await this._runtime.flush(flushMs);
        this._runtime.shutdown();
        this._docs.clear();
    }

    /**
     * Wait for outgoing Yjs updates to be pushed without closing.
     * @param {number} [ms=800]
     */
    flush(ms = 800) {
        return this._runtime.flush(ms);
    }

    // ─── File list ──────────────────────────────────────────────────────────

    /**
     * All worksheet files (scope=app, app=worksheets).
     * Requires init() to have been called first.
     * @returns {import('../lib/FileRegistry/FileRegistry.js').FileDescriptor[]}
     */
    listFiles() {
        return [...this._files.values()].filter(
            f => !f.deleted && f.type === 'yjs' && f.scope === 'app' && f.app === 'worksheets'
        );
    }

    /**
     * Find a worksheet file by exact title.
     * @param {string} title
     * @returns {import('../lib/FileRegistry/FileRegistry.js').FileDescriptor|null}
     */
    findFile(title) {
        for (const f of this._files.values()) {
            if (!f.deleted && f.title === title) return f;
        }
        return null;
    }

    /**
     * Get a file descriptor by ID.
     * @param {string} id
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

    /** @param {import('yjs').Doc} ydoc */
    listSheets(ydoc) { return ops.listSheets(ydoc); }

    // ─── Cells ──────────────────────────────────────────────────────────────

    /**
     * @param {import('yjs').Doc} ydoc
     * @param {string} sheetId
     * @param {number} row  0-based
     * @param {number} col  0-based
     */
    getCell(ydoc, sheetId, row, col) { return ops.getCell(ydoc, sheetId, row, col); }

    /**
     * @param {import('yjs').Doc} ydoc
     * @param {string} sheetId
     * @param {number} row
     * @param {number} col
     * @param {any} value  Plain value or "=formula"
     * @param {object} [props]
     */
    setCell(ydoc, sheetId, row, col, value, props) {
        return ops.setCell(ydoc, sheetId, row, col, value, props);
    }

    /** @param {import('yjs').Doc} ydoc */
    clearCell(ydoc, sheetId, row, col) { return ops.clearCell(ydoc, sheetId, row, col); }

    /** @param {import('yjs').Doc} ydoc */
    getRange(ydoc, sheetId, startRow, startCol, endRow, endCol) {
        return ops.getRange(ydoc, sheetId, startRow, startCol, endRow, endCol);
    }

    // ─── Tables ─────────────────────────────────────────────────────────────

    /** @param {import('yjs').Doc} ydoc */
    listTables(ydoc, sheetId) { return ops.listTables(ydoc, sheetId); }

    /** @param {import('yjs').Doc} ydoc */
    getTableRows(ydoc, sheetId, tableId) { return ops.getTableRows(ydoc, sheetId, tableId); }

    /**
     * Add a row to a table.
     * @param {import('yjs').Doc} ydoc
     * @param {string} sheetId
     * @param {string} tableId
     * @param {object} rowData  { columnId: value, ... }
     */
    insertTableRow(ydoc, sheetId, tableId, rowData) {
        return ops.insertTableRow(ydoc, sheetId, tableId, rowData);
    }

    /** @param {import('yjs').Doc} ydoc */
    updateTableRow(ydoc, sheetId, tableId, rowIndex, updates) {
        return ops.updateTableRow(ydoc, sheetId, tableId, rowIndex, updates);
    }

    /** @param {import('yjs').Doc} ydoc */
    deleteTableRow(ydoc, sheetId, tableId, rowIndex) {
        return ops.deleteTableRow(ydoc, sheetId, tableId, rowIndex);
    }
}
