/**
 * spreadsheet-api - General-purpose HTTP API for Scriptorium spreadsheets.
 *
 * Wraps SpreadsheetClient (Yjs + WebSocket) as a persistent REST service.
 * Any app can call this API with a Bearer token to read/write spreadsheet
 * tables, cells, and blob files without needing to run Yjs directly.
 *
 * Auth: the caller's  Authorization: Bearer <token>  is forwarded directly
 * to Scriptorium. The server has no API key of its own — any valid Scriptorium
 * API key works. SpreadsheetClient instances are cached per token so each
 * unique caller keeps a persistent WebSocket connection.
 *
 * Endpoints:
 *   GET  /files
 *   GET  /file/:fileId/sheets
 *   GET  /file/:fileId/sheet/:sheetId/tables
 *   GET  /file/:fileId/sheet/:sheetId/table/:tableId/schema
 *   GET  /file/:fileId/sheet/:sheetId/table/:tableId/rows[?colNames=1]
 *   POST /file/:fileId/sheet/:sheetId/table/:tableId/rows   { colName: value }
 *   GET  /file/:fileId/sheet/:sheetId/cell?row=R&col=C
 *   POST /file/:fileId/sheet/:sheetId/cell                  { row, col, value, props? }
 *   POST /blobs                                             raw body, headers: Content-Type, X-Filename
 *
 * Start: node spreadsheet-api/server.js  (from repo root, or cd into dir)
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SpreadsheetClient } from '../src/cli/SpreadsheetClient.js';
import { parseFormula } from '../src/formulas/parser.js';
import { evaluate } from '../src/formulas/evaluator.js';

// ─── Load .env ──────────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url));
try {
    const envText = readFileSync(path.join(__dir, '.env'), 'utf8');
    for (const line of envText.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
} catch { /* .env is optional */ }

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT            = Number(process.env.PORT            ?? 3456);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map(s => s.trim());
const BASE_URL        = process.env.STORAGE_BASE_URL  ?? 'https://instrumenta.cf/api/storage.php';
const BLOB_URL        = process.env.BLOB_STORAGE_URL  ?? 'https://instrumenta.cf/api/blob-storage.php';
const WS_URL          = process.env.YJS_WS_URL        ?? 'wss://instrumenta.cf/congruum/';

// ─── Per-token client cache ──────────────────────────────────────────────────
// Each unique API key gets its own SpreadsheetClient with a persistent
// WebSocket connection. Clients are created on first use and kept alive.

/** @type {Map<string, SpreadsheetClient>} */
const clientCache = new Map();

async function getClient(apiKey) {
    if (clientCache.has(apiKey)) return clientCache.get(apiKey);
    const c = new SpreadsheetClient({ apiKey, baseUrl: BASE_URL, blobUrl: BLOB_URL, wsUrl: WS_URL });
    await c.init();
    clientCache.set(apiKey, c);
    return c;
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin ?? '';
    const allowOrigin = ALLOWED_ORIGINS.includes('*')
        ? '*'
        : (ALLOWED_ORIGINS.includes(origin) ? origin : '');

    res.setHeader('Access-Control-Allow-Origin', allowOrigin || 'null');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename, X-Parent-Id');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        await route(req, res);
    } catch (err) {
        console.error(`[${req.method} ${req.url}]`, err.message);
        json(res, 500, { error: err.message });
    }
});

server.listen(PORT, () => console.log(`spreadsheet-api listening on :${PORT}`));

// ─── Table-column dropdown resolver ──────────────────────────────────────────

/**
 * Resolve a table-column dropdown source to a deduplicated array of option strings.
 * Evaluates formula/computed columns via getTableRowsWithFormulas so the server
 * returns the same values the browser would show.
 */
function resolveTableColumnOptions(ydoc, tableName, columnId, client) {
    const sheets  = client.listSheets(ydoc);
    const nameUp  = tableName.toUpperCase();
    const colUp   = columnId.toUpperCase();

    for (const sheet of sheets) {
        const tables = client.listTables(ydoc, sheet.id);
        const table  = tables.find(t => (t.name ?? '').toUpperCase() === nameUp);
        if (!table) continue;

        const col = table.columns.find(c =>
            (c.id   ?? '').toUpperCase() === colUp ||
            (c.name ?? '').toUpperCase() === colUp
        );
        if (!col) return [];

        // Use formula-aware rows so computed columns return real values
        const rows = client.getTableRowsWithFormulas(ydoc, sheet.id, table.id);
        const seen = new Set();
        return rows
            .map(row => row[col.id])
            .filter(v => v != null && v !== '')
            .map(String)
            .filter(v => { if (seen.has(v)) return false; seen.add(v); return true; });
    }
    return [];
}

// ─── Range-backed dropdown resolver ──────────────────────────────────────────

/**
 * Resolve a range string (e.g. "A1:A20" or "'Options'!A1:A20") to an array
 * of option strings by reading raw cell values from the Yjs doc.
 * Formula cells store their last-computed result in the `v` property.
 */
function resolveRangeOptions(ydoc, defaultSheetId, rangeStr, sheets, client) {
    let sheetId  = defaultSheetId;
    let cellRange = rangeStr.trim();

    // Parse optional cross-sheet prefix: 'Sheet Name'!A1:A10  or  SheetName!A1:A10
    const sheetRefMatch = cellRange.match(/^(?:'((?:[^']|'')*)'|([^'!][^!]*?))!(.+)$/);
    if (sheetRefMatch) {
        const sheetName = (sheetRefMatch[1] ?? sheetRefMatch[2]).replace(/''/g, "'");
        cellRange = sheetRefMatch[3];
        const entry = sheets.find(s => s.name === sheetName);
        if (entry) sheetId = entry.id;
    }

    // Parse A1-style references  →  0-based { row, col }
    function parseRef(ref) {
        const m = ref.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
        if (!m) return null;
        let col = 0;
        for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        return { row: parseInt(m[2]) - 1, col: col - 1 };
    }

    const parts = cellRange.trim().toUpperCase().split(':');
    const start = parseRef(parts[0]);
    const end   = parts[1] ? parseRef(parts[1]) : start;
    if (!start || !end) return [];

    // Resolve a single cell's effective value, evaluating formulas if needed.
    function getCellValue(r, c, visitedSheetId = sheetId) {
        const cell = client.getCell(ydoc, visitedSheetId, r, c);
        const v = cell?.v;
        if (v == null || v === '') return null;
        if (typeof v === 'string' && v.startsWith('=')) {
            try {
                const ast = parseFormula(v.slice(1));
                return evaluate(
                    ast,
                    (row, col) => getCellValue(row, col, visitedSheetId),
                    {},
                    null,
                    (sheetName, row, col) => {
                        const entry = sheets.find(s => s.name === sheetName);
                        return entry ? getCellValue(row, col, entry.id) : null;
                    },
                );
            } catch { return null; }
        }
        return v;
    }

    const opts = [];
    for (let r = start.row; r <= end.row; r++) {
        for (let c = start.col; c <= end.col; c++) {
            const v = getCellValue(r, c);
            if (v != null && v !== '') opts.push(String(v));
        }
    }
    return opts;
}

// ─── Router ──────────────────────────────────────────────────────────────────

async function route(req, res) {
    const apiKey = extractBearer(req);
    if (!apiKey) return json(res, 401, { error: 'Unauthorized' });
    let client;
    try {
        client = await getClient(apiKey);
    } catch (err) {
        return json(res, 401, { error: `Scriptorium auth failed: ${err.message}` });
    }

    const url    = new URL(req.url, 'http://localhost');
    const p      = url.pathname;
    const method = req.method;
    let m;

    // GET /files
    if (method === 'GET' && p === '/files') {
        await client.init(); // refresh file list
        const files = client.listFiles();
        return json(res, 200, files.map(f => ({ id: f.id, title: f.title, roomId: f.roomId })));
    }

    // GET /file/:fileId/sheets
    if (method === 'GET' && (m = p.match(/^\/file\/([^/]+)\/sheets$/))) {
        const ydoc = await openDoc(client, m[1]);
        return json(res, 200, client.listSheets(ydoc));
    }

    // GET /file/:fileId/sheet/:sheetId/tables
    if (method === 'GET' && (m = p.match(/^\/file\/([^/]+)\/sheet\/([^/]+)\/tables$/))) {
        const ydoc   = await openDoc(client, m[1]);
        const tables = client.listTables(ydoc, m[2]);
        return json(res, 200, tables.map(t => ({ id: t.id, name: t.name, mode: t.mode })));
    }

    // GET /file/:fileId/sheet/:sheetId/table/:tableId/schema
    if (method === 'GET' && (m = p.match(/^\/file\/([^/]+)\/sheet\/([^/]+)\/table\/([^/]+)\/schema$/))) {
        const [, fileId, sheetId, tableId] = m;
        const ydoc   = await openDoc(client, fileId);
        const tables = client.listTables(ydoc, sheetId);
        const table  = tables.find(t => t.id === tableId);
        if (!table) return json(res, 404, { error: `Table "${tableId}" not found` });

        const sheets = client.listSheets(ydoc);
        const columns = table.columns.map(col => {
            const base = {
                id:        col.id,
                name:      col.name,
                type:      col.type      ?? null,
                required:  col.required  ?? false,
                isFormula: col.isNonEntry ?? false,
            };
            if (col.typeConfig) {
                try {
                    const tc = typeof col.typeConfig === 'string' ? JSON.parse(col.typeConfig) : col.typeConfig;
                    if (tc.source === 'range' && tc.range) {
                        base.options = resolveRangeOptions(ydoc, sheetId, tc.range, sheets, client);
                    } else if (tc.source === 'table' && tc.tableName && tc.columnId) {
                        base.options = resolveTableColumnOptions(ydoc, tc.tableName, tc.columnId, client);
                    } else if (Array.isArray(tc.options)) {
                        base.options = tc.options;
                    }
                    if (tc.allowCustom != null) base.allowCustom = tc.allowCustom;
                } catch { /* malformed typeConfig — skip */ }
            }
            return base;
        });
        return json(res, 200, { id: table.id, name: table.name, columns });
    }

    // GET /file/:fileId/sheet/:sheetId/table/:tableId/rows[?colNames=1&formulas=1]
    if (method === 'GET' && (m = p.match(/^\/file\/([^/]+)\/sheet\/([^/]+)\/table\/([^/]+)\/rows$/))) {
        const [, fileId, sheetId, tableId] = m;
        const useNames    = url.searchParams.get('colNames') === '1';
        const withFormulas = url.searchParams.get('formulas') !== '0'; // default on
        const ydoc = await openDoc(client, fileId);

        // Use formula-aware rows by default; fall back to raw on explicit ?formulas=0
        let rows = withFormulas
            ? client.getTableRowsWithFormulas(ydoc, sheetId, tableId)
            : client.getTableRows(ydoc, sheetId, tableId);

        if (useNames) {
            const tables  = client.listTables(ydoc, sheetId);
            const table   = tables.find(t => t.id === tableId);
            const idToName = table
                ? new Map(table.columns.map(c => [c.id, c.name]))
                : new Map();
            rows = rows.map(row => {
                const named = {};
                for (const [k, v] of Object.entries(row)) named[idToName.get(k) ?? k] = v;
                return named;
            });
        }
        return json(res, 200, rows);
    }

    // POST /file/:fileId/sheet/:sheetId/table/:tableId/rows
    if (method === 'POST' && (m = p.match(/^\/file\/([^/]+)\/sheet\/([^/]+)\/table\/([^/]+)\/rows$/))) {
        const [, fileId, sheetId, tableId] = m;
        const body     = await readJsonBody(req);
        const ydoc     = await openDoc(client, fileId);
        const resolved = client.resolveColumnNames(ydoc, sheetId, tableId, body);
        client.insertTableRow(ydoc, sheetId, tableId, resolved);
        return json(res, 200, { ok: true });
    }

    // GET /file/:fileId/sheet/:sheetId/cell?row=R&col=C
    if (method === 'GET' && (m = p.match(/^\/file\/([^/]+)\/sheet\/([^/]+)\/cell$/))) {
        const [, fileId, sheetId] = m;
        const row = Number(url.searchParams.get('row'));
        const col = Number(url.searchParams.get('col'));
        if (isNaN(row) || isNaN(col)) return json(res, 400, { error: 'row and col query params required' });
        const ydoc = await openDoc(client, fileId);
        const cell = client.getCell(ydoc, sheetId, row, col);
        return json(res, 200, { value: cell?.v ?? null });
    }

    // POST /file/:fileId/sheet/:sheetId/cell
    if (method === 'POST' && (m = p.match(/^\/file\/([^/]+)\/sheet\/([^/]+)\/cell$/))) {
        const [, fileId, sheetId] = m;
        const body = await readJsonBody(req);
        const { row, col, value, props } = body;
        if (row == null || col == null || value === undefined)
            return json(res, 400, { error: 'row, col, and value are required' });
        const ydoc = await openDoc(client, fileId);
        client.setCell(ydoc, sheetId, Number(row), Number(col), value, props ?? {});
        return json(res, 200, { ok: true });
    }

    // POST /blobs  (raw binary body; Content-Type, X-Filename, X-Parent-Id headers)
    if (method === 'POST' && p === '/blobs') {
        const mimeType = req.headers['content-type'] ?? 'application/octet-stream';
        const filename = req.headers['x-filename']   ?? 'upload';
        const parentId = req.headers['x-parent-id']  ?? null;
        const chunks   = [];
        for await (const chunk of req) chunks.push(chunk);
        const buf  = Buffer.concat(chunks);
        const blob = await client.uploadBlob(
            { title: filename, filename, mimeType, size: buf.length, parentId },
            buf,
        );
        return json(res, 200, { blobId: blob.id, url: blob.url, filename, mimeType, size: buf.length });
    }

    return json(res, 404, { error: 'Not found' });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractBearer(req) {
    const auth = req.headers.authorization ?? '';
    const m = auth.match(/^Bearer (.+)$/);
    return m ? m[1] : null;
}

/**
 * Open a doc, re-initializing the file list once if the fileId is unknown.
 * This handles files created after the server started.
 */
async function openDoc(client, fileId) {
    if (!client.getFile(fileId)) await client.init();
    return client.openDoc(fileId);
}

function json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (!body.trim()) return {};
    return JSON.parse(body);
}
