/**
 * mcp-server.js — Model Context Protocol server for Scriptorium spreadsheets.
 *
 * Exposes the shared operations layer (src/stores/spreadsheet/ops/) as MCP
 * tools so an AI agent can read, author, format and repair spreadsheets
 * directly, instead of a human hand-wiring HTTP calls for each task.
 *
 * ## Why the protocol is implemented here rather than via @modelcontextprotocol/sdk
 * spreadsheet-api deliberately declares no dependencies and shares the parent
 * node_modules — a second copy of yjs breaks `instanceof Y.Array` checks in
 * schema.js and silently makes cell reads return null (see package.json). MCP's
 * stdio transport is newline-delimited JSON-RPC 2.0, which is small enough to
 * implement directly and keeps that guarantee intact.
 *
 * ## Transport
 * Reads JSON-RPC requests from stdin, writes responses to stdout, one JSON
 * object per line. NOTHING else may be written to stdout — diagnostics go to
 * stderr, or they corrupt the protocol stream.
 *
 * Run:  SCRIPTORIUM_API_KEY=... node spreadsheet-api/mcp-server.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { SpreadsheetClient } from './SpreadsheetClient.js';
import * as cellOps from '../src/stores/spreadsheet/ops/cellOps.js';
import * as formatOps from '../src/stores/spreadsheet/ops/formatOps.js';
import * as sheetOps from '../src/stores/spreadsheet/ops/sheetOps.js';
import * as tableOps from '../src/stores/spreadsheet/ops/tableOps.js';
import * as docOps from '../src/stores/spreadsheet/ops/docOps.js';
import * as inspectOps from '../src/stores/spreadsheet/ops/inspectOps.js';
import { OpError } from '../src/stores/spreadsheet/ops/context.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'scriptorium-spreadsheets', version: '1.0.0' };

// ─── Config ─────────────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url));
try {
    const envText = readFileSync(path.join(__dir, '.env'), 'utf8');
    for (const line of envText.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
} catch { /* .env is optional */ }

const API_KEY = process.env.SCRIPTORIUM_API_KEY ?? process.env.ANTHROPIC_SCRIPTORIUM_KEY;
const DOC_IDLE_MS = 30_000;

const log = (...args) => console.error('[mcp]', ...args);

// ─── Client / document lifecycle ────────────────────────────────────────────

/** @type {SpreadsheetClient|null} */
let client = null;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const docTimers = new Map();

async function getClient() {
    if (client) return client;
    if (!API_KEY) {
        throw new OpError('NO_API_KEY',
            'SCRIPTORIUM_API_KEY is not set. Export it before starting the MCP server.');
    }
    client = new SpreadsheetClient({ apiKey: API_KEY });
    await client.init();
    return client;
}

/**
 * Resolve a file by id or title and open its Yjs document.
 * Accepting a title matters: an agent that just called list_files has a
 * human-readable name in hand and shouldn't need a second lookup.
 */
async function openDoc(fileRef) {
    const c = await getClient();
    let file = c.getFile(fileRef) ?? c.findFile(fileRef);
    if (!file) {
        await c.init();  // the file may have been created after we last synced
        file = c.getFile(fileRef) ?? c.findFile(fileRef);
    }
    if (!file) {
        throw new OpError('FILE_NOT_FOUND', `No spreadsheet named or identified by "${fileRef}"`, {
            available: c.listFiles().map(f => f.title).slice(0, 50),
        });
    }

    const ydoc = await c.openDoc(file.id);
    clearTimeout(docTimers.get(file.id));
    docTimers.set(file.id, setTimeout(() => {
        docTimers.delete(file.id);
        c.closeDoc(file.id);
    }, DOC_IDLE_MS));
    return { ydoc, file };
}

/** Push pending Yjs updates so a write is durable before the tool returns. */
async function flush() {
    if (client) await client.flush(600);
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

/** Shared parameter fragments. */
const FILE = str('Spreadsheet file — its id or its exact title.');
const SHEET = str('Sheet name or id.');

/**
 * Each tool: { description, inputSchema, handler }.
 *
 * Descriptions state WHEN to reach for the tool, not just what it does —
 * that is what actually drives correct tool selection.
 */
const TOOLS = {
    // ── Discovery ──────────────────────────────────────────────────────────
    list_spreadsheets: {
        description: 'List every Scriptorium spreadsheet available to this account. Start here when the user names a spreadsheet you do not yet have an id for.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
            const c = await getClient();
            await c.init();
            return c.listFiles().map(f => ({ id: f.id, title: f.title }));
        },
    },

    describe_spreadsheet: {
        description: 'Get the full structure of a spreadsheet in one call: every sheet with its used range, frozen panes, merges and a preview of its data, plus every table with its column schema. Call this FIRST when working on an unfamiliar spreadsheet — it replaces a chain of list/inspect calls.',
        inputSchema: {
            type: 'object',
            properties: { file: FILE, sample: num('Rows of preview data per sheet (default 5, 0 to skip).') },
            required: ['file'],
        },
        handler: async ({ file, sample }) => {
            const { ydoc } = await openDoc(file);
            return docOps.describeDocument(ydoc, { sample });
        },
    },

    inspect_spreadsheet: {
        description: 'Scan a spreadsheet for defects and return a ranked list of findings: formula errors, circular references, formulas that break the pattern of their row, numbers stored as text, hardcoded constants inside formulas, and table rows violating their column schema. Use this when asked to review, audit, or "fix" a spreadsheet.',
        inputSchema: {
            type: 'object',
            properties: { file: FILE, sheet: str('Limit the scan to one sheet (optional).') },
            required: ['file'],
        },
        handler: async ({ file, sheet }) => {
            const { ydoc } = await openDoc(file);
            return inspectOps.inspectDocument(ydoc, { sheet });
        },
    },

    // ── Reading ────────────────────────────────────────────────────────────
    get_range: {
        description: 'Read a rectangular range in A1 notation. Formulas are evaluated by default, so you get the values a user sees; request formulas/styles to also see the underlying formula text and formatting.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET,
                range: str('A1 range, e.g. "A1:D20", "B:B" for a whole column, or "C5" for one cell.'),
                includeFormulas: bool('Also return the raw formula text for each cell.'),
                includeStyles: bool('Also return the resolved formatting for each cell.'),
                evaluate: bool('Set false to return raw stored values instead of evaluating formulas.'),
            },
            required: ['file', 'sheet', 'range'],
        },
        handler: async ({ file, sheet, range, ...opts }) => {
            const { ydoc } = await openDoc(file);
            return cellOps.getRange(ydoc, sheet, range, opts);
        },
    },

    get_used_range: {
        description: 'Find where the data on a sheet actually is. Sheets declare a large nominal size (often 1000x26), so use this instead of assuming bounds before reading.',
        inputSchema: {
            type: 'object',
            properties: { file: FILE, sheet: SHEET },
            required: ['file', 'sheet'],
        },
        handler: async ({ file, sheet }) => {
            const { ydoc } = await openDoc(file);
            return cellOps.getUsedRange(ydoc, sheet);
        },
    },

    // ── Writing values ─────────────────────────────────────────────────────
    set_cell: {
        description: 'Write one cell\'s value and/or formatting. A value starting with "=" is stored as a formula. Formatting props merge into whatever the cell already has; pass null for a prop to clear just that one. Returns the cell as persisted.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET,
                ref: str('A1 cell reference, e.g. "B3".'),
                value: { description: 'Value, or a formula string starting with "=". Omit to change formatting only.' },
                props: { type: 'object', description: 'Formatting: bold, italic, underline, color, backgroundColor, fontSize, fontFamily, numberFormat, horizontalAlign, verticalAlign, wrapText.' },
            },
            required: ['file', 'sheet', 'ref'],
        },
        handler: async ({ file, sheet, ref, value, props }) => {
            const { ydoc } = await openDoc(file);
            const r = cellOps.setCell(ydoc, sheet, ref, value, props ?? {});
            await flush();
            return r;
        },
    },

    set_range: {
        description: 'Write a 2-D block of values in one call, anchored at a top-left cell. Strongly prefer this over many set_cell calls when filling a table or pasting data. null entries leave the underlying cell untouched.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET,
                anchor: str('Top-left cell of the block, e.g. "A1".'),
                values: { type: 'array', description: 'Array of row arrays, e.g. [["Name","Qty"],["Bolt",4]].', items: { type: 'array' } },
                props: { type: 'object', description: 'Formatting applied to every written cell.' },
            },
            required: ['file', 'sheet', 'anchor', 'values'],
        },
        handler: async ({ file, sheet, anchor, values, props }) => {
            const { ydoc } = await openDoc(file);
            const r = cellOps.setRange(ydoc, sheet, anchor, values, props ?? {});
            await flush();
            return r;
        },
    },

    clear_range: {
        description: 'Erase cell contents and/or formatting across a range. Defaults to contents only — pass formats:true to also strip styling.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET, range: str('A1 range to clear.'),
                contents: bool('Clear values (default true).'),
                formats: bool('Also clear formatting (default false).'),
            },
            required: ['file', 'sheet', 'range'],
        },
        handler: async ({ file, sheet, range, contents, formats }) => {
            const { ydoc } = await openDoc(file);
            const r = cellOps.clearRange(ydoc, sheet, range, { contents, formats });
            await flush();
            return r;
        },
    },

    // ── Design surface ─────────────────────────────────────────────────────
    format_range: {
        description: 'Apply formatting to every cell in a range without touching values. This is the main tool for making a sheet look designed — use one call per visual region (header row, totals row, a data column) rather than formatting cell by cell.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET, range: str('A1 range to format.'),
                style: { type: 'object', description: 'bold, italic, underline, strikethrough, color, backgroundColor, fontSize, fontFamily, numberFormat (e.g. "#,##0.00", "$#,##0", "0%"), horizontalAlign (left|center|right), verticalAlign (top|middle|bottom), wrapText. null clears a property.' },
            },
            required: ['file', 'sheet', 'range', 'style'],
        },
        handler: async ({ file, sheet, range, style }) => {
            const { ydoc } = await openDoc(file);
            const r = formatOps.formatRange(ydoc, sheet, range, style);
            await flush();
            return r;
        },
    },

    set_layout: {
        description: 'Set column widths, row heights, and frozen header panes. Column widths are the single biggest lever on whether a sheet reads well — set them whenever you write content wider than the default 100px.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET,
                columnWidths: { type: 'object', description: 'Pixel widths keyed by column letter, e.g. {"A": 220, "B": 90}.' },
                rowHeights: { type: 'object', description: 'Pixel heights keyed by 1-based row number, e.g. {"1": 40}.' },
                freezeRows: num('Number of top rows to freeze.'),
                freezeColumns: num('Number of left columns to freeze.'),
            },
            required: ['file', 'sheet'],
        },
        handler: async ({ file, sheet, columnWidths, rowHeights, freezeRows, freezeColumns }) => {
            const { ydoc } = await openDoc(file);
            const out = {};
            if (columnWidths) out.columns = formatOps.setColumnWidths(ydoc, sheet, columnWidths);
            if (rowHeights) out.rows = formatOps.setRowHeights(ydoc, sheet, rowHeights);
            if (freezeRows != null || freezeColumns != null) {
                out.frozen = formatOps.setFrozenPanes(ydoc, sheet, { rows: freezeRows, columns: freezeColumns });
            }
            await flush();
            return out;
        },
    },

    set_borders: {
        description: 'Draw borders on a range — an outline around it, inner gridlines, or individual edges. Use for separating a totals row or boxing a summary block.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET, range: str('A1 range.'),
                outline: { type: 'object', description: '{style, width, color} around the range, or null to clear.' },
                inner: { type: 'object', description: '{style, width, color} for interior gridlines, or null to clear.' },
                top: { type: 'object' }, bottom: { type: 'object' },
                left: { type: 'object' }, right: { type: 'object' },
            },
            required: ['file', 'sheet', 'range'],
        },
        handler: async ({ file, sheet, range, ...spec }) => {
            const { ydoc } = await openDoc(file);
            const r = formatOps.setBorders(ydoc, sheet, range, spec);
            await flush();
            return r;
        },
    },

    merge_cells: {
        description: 'Merge a range into one cell, or unmerge it. Typically used for a title banner across the top of a report.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET, range: str('A1 range, e.g. "A1:F1".'),
                unmerge: bool('Set true to remove merges overlapping this range instead of creating one.'),
            },
            required: ['file', 'sheet', 'range'],
        },
        handler: async ({ file, sheet, range, unmerge }) => {
            const { ydoc } = await openDoc(file);
            const r = unmerge
                ? formatOps.unmergeCells(ydoc, sheet, range)
                : formatOps.mergeCells(ydoc, sheet, range);
            await flush();
            return r;
        },
    },

    add_conditional_format: {
        description: 'Add a rule that styles cells based on their value — e.g. highlight negatives red, or flag anything over a threshold. Conditions: gt, lt, gte, lte, eq, neq, contains, formula.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET, range: str('A1 range the rule covers.'),
                condition: str('One of: gt, lt, gte, lte, eq, neq, contains, formula.'),
                threshold: { description: 'Value to compare against.' },
                style: { type: 'object', description: 'Formatting to apply when the condition holds, e.g. {backgroundColor:"#fee", bold:true}.' },
            },
            required: ['file', 'sheet', 'range', 'condition', 'style'],
        },
        handler: async ({ file, sheet, range, condition, threshold, style }) => {
            const { ydoc } = await openDoc(file);
            const r = formatOps.addConditionalFormat(ydoc, sheet, { range, condition, threshold, style });
            await flush();
            return r;
        },
    },

    // ── Structure ──────────────────────────────────────────────────────────
    modify_structure: {
        description: 'Insert or delete whole rows or columns. Formulas elsewhere on the sheet are rewritten to keep pointing at the right cells, so prefer this over clearing and rewriting data by hand.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET,
                action: str('insertRows | deleteRows | insertColumns | deleteColumns'),
                at: str('For rows: 1-based row number. For columns: column letter. Insert happens BEFORE this position.'),
                count: num('How many rows/columns (default 1).'),
            },
            required: ['file', 'sheet', 'action', 'at'],
        },
        handler: async ({ file, sheet, action, at, count }) => {
            const { ydoc } = await openDoc(file);
            const fn = {
                insertRows: sheetOps.insertRows, deleteRows: sheetOps.deleteRows,
                insertColumns: sheetOps.insertColumns, deleteColumns: sheetOps.deleteColumns,
            }[action];
            if (!fn) {
                throw new OpError('UNKNOWN_ACTION', `Unknown action "${action}"`,
                    { allowed: ['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns'] });
            }
            const r = fn(ydoc, sheet, at, count ?? 1);
            await flush();
            return r;
        },
    },

    manage_sheets: {
        description: 'Create, rename, or delete a sheet within a spreadsheet.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE,
                action: str('create | rename | delete'),
                sheet: str('For rename/delete: the existing sheet. Ignored for create.'),
                name: str('New sheet name (for create and rename).'),
            },
            required: ['file', 'action'],
        },
        handler: async ({ file, action, sheet, name }) => {
            const { ydoc } = await openDoc(file);
            let r;
            if (action === 'create') r = sheetOps.createSheet(ydoc, name);
            else if (action === 'rename') r = sheetOps.renameSheet(ydoc, sheet, name);
            else if (action === 'delete') r = sheetOps.deleteSheet(ydoc, sheet);
            else throw new OpError('UNKNOWN_ACTION', `Unknown action "${action}"`,
                { allowed: ['create', 'rename', 'delete'] });
            await flush();
            return r;
        },
    },

    // ── Tables ─────────────────────────────────────────────────────────────
    create_table: {
        description: 'Create a structured table with typed columns. Prefer this over loose cells whenever the data is records-with-fields: typed columns, dropdown constraints and computed columns encode the intent and are validated on every later write.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, sheet: SHEET,
                name: str('Table name — referenced by TABLE_* formulas.'),
                columns: {
                    type: 'array',
                    description: 'Column definitions in display order.',
                    items: {
                        type: 'object',
                        properties: {
                            name: str('Column header.'),
                            type: str('text | number | currency | percent | date | checkbox | dropdown'),
                            required: bool('Reject rows that leave this empty.'),
                            typeConfig: { type: 'object', description: 'For dropdown: {options:["A","B"], allowCustom:false}.' },
                            isNonEntry: bool('True for a computed column (pair with defaultFormula).'),
                            defaultFormula: str('Table formula, e.g. "{Qty} * {Price}".'),
                        },
                        required: ['name'],
                    },
                },
                startRow: num('0-based grid row to place the table at.'),
                startCol: num('0-based grid column to place the table at.'),
            },
            required: ['file', 'sheet', 'name', 'columns'],
        },
        handler: async ({ file, sheet, ...opts }) => {
            const { ydoc } = await openDoc(file);
            const r = tableOps.createTable(ydoc, { sheet, ...opts });
            await flush();
            return r;
        },
    },

    get_table_schema: {
        description: 'Get a table\'s column definitions, including which columns are computed (rejected on write) and the permitted values for dropdown columns. Read this before writing rows to a table you did not just create.',
        inputSchema: {
            type: 'object',
            properties: { file: FILE, table: str('Table name or id.') },
            required: ['file', 'table'],
        },
        handler: async ({ file, table }) => {
            const { ydoc } = await openDoc(file);
            return tableOps.getTableSchema(ydoc, table);
        },
    },

    get_table_rows: {
        description: 'Read a table\'s rows with computed columns evaluated, in display order. Optionally filter to rows matching field values.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, table: str('Table name or id.'),
                where: { type: 'object', description: 'Optional filter, e.g. {"Category":"Ops"}. Returns rows with their storage index.' },
            },
            required: ['file', 'table'],
        },
        handler: async ({ file, table, where }) => {
            const { ydoc } = await openDoc(file);
            return where && Object.keys(where).length
                ? tableOps.findRows(ydoc, table, where, { byName: true })
                : tableOps.getRows(ydoc, table, { byName: true });
        },
    },

    append_table_rows: {
        description: 'Append one or more rows to a table, keyed by column name. Every row is validated against the table schema BEFORE anything is written, so a bad value fails the whole call with a per-column explanation rather than half-populating the table.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, table: str('Table name or id.'),
                rows: { type: 'array', description: 'Rows as objects keyed by column name, e.g. [{"Item":"Bolt","Qty":4}].', items: { type: 'object' } },
            },
            required: ['file', 'table', 'rows'],
        },
        handler: async ({ file, table, rows }) => {
            const { ydoc } = await openDoc(file);
            const r = tableOps.appendRows(ydoc, table, rows);
            await flush();
            return r;
        },
    },

    update_table_row: {
        description: 'Update fields on an existing table row, addressed by the storage index returned from get_table_rows with a filter.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, table: str('Table name or id.'),
                index: num('Row storage index from get_table_rows(where:...).'),
                values: { type: 'object', description: 'Fields to change, keyed by column name.' },
            },
            required: ['file', 'table', 'index', 'values'],
        },
        handler: async ({ file, table, index, values }) => {
            const { ydoc } = await openDoc(file);
            const r = tableOps.updateRow(ydoc, table, index, values);
            await flush();
            return r;
        },
    },

    delete_table_row: {
        description: 'Delete a table row by its storage index (from get_table_rows with a filter).',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE, table: str('Table name or id.'), index: num('Row storage index.'),
            },
            required: ['file', 'table', 'index'],
        },
        handler: async ({ file, table, index }) => {
            const { ydoc } = await openDoc(file);
            const r = tableOps.deleteRow(ydoc, table, index);
            await flush();
            return r;
        },
    },

    // ── Batch ──────────────────────────────────────────────────────────────
    apply_batch: {
        description: 'Run many operations in one call, rolling every one of them back if any fails. Use this for multi-step authoring — building a formatted report is a dozen writes, and a batch makes them one round trip and one undo step. Ops: ' + docOps.BATCH_OP_NAMES.join(', ') + '.',
        inputSchema: {
            type: 'object',
            properties: {
                file: FILE,
                operations: {
                    type: 'array',
                    description: 'Each entry is {op, ...args}, e.g. {"op":"setRange","sheet":"Sheet 1","ref":"A1","values":[["Q1",100]]} or {"op":"formatRange","sheet":"Sheet 1","range":"A1:B1","style":{"bold":true}}.',
                    items: { type: 'object' },
                },
            },
            required: ['file', 'operations'],
        },
        handler: async ({ file, operations }) => {
            const { ydoc } = await openDoc(file);
            const r = docOps.applyBatch(ydoc, operations);
            await flush();
            return r;
        },
    },
};

// ─── JSON-RPC plumbing ──────────────────────────────────────────────────────

function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

function respond(id, result) {
    send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message, data) {
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

/**
 * Format a tool result as MCP content.
 * Errors come back as content with isError rather than a protocol-level
 * failure, so the agent can read the message and correct itself.
 */
function toolContent(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(err) {
    const payload = err instanceof OpError
        ? { error: err.code, message: err.message, ...err.details }
        : { error: 'INTERNAL', message: String(err?.message ?? err) };
    return { ...toolContent(payload), isError: true };
}

async function handleRequest(msg) {
    const { id, method, params } = msg;

    switch (method) {
        case 'initialize':
            respond(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
            });
            return;

        case 'tools/list':
            respond(id, {
                tools: Object.entries(TOOLS).map(([name, t]) => ({
                    name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                })),
            });
            return;

        case 'tools/call': {
            const tool = TOOLS[params?.name];
            if (!tool) {
                respond(id, toolError(new OpError('UNKNOWN_TOOL',
                    `No tool named "${params?.name}"`, { available: Object.keys(TOOLS) })));
                return;
            }
            try {
                const result = await tool.handler(params.arguments ?? {});
                respond(id, toolContent(result));
            } catch (err) {
                log(`tool ${params.name} failed:`, err?.message);
                respond(id, toolError(err));
            }
            return;
        }

        case 'ping':
            respond(id, {});
            return;

        default:
            // Notifications (no id) need no reply; unknown requests do.
            if (id !== undefined) respondError(id, -32601, `Method not found: ${method}`);
    }
}

// ─── Main loop ──────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch {
        respondError(null, -32700, 'Parse error');
        return;
    }

    try {
        await handleRequest(msg);
    } catch (err) {
        log('unhandled:', err);
        if (msg?.id !== undefined) respondError(msg.id, -32603, String(err?.message ?? err));
    }
});

rl.on('close', async () => {
    try { if (client) await client.close(1000); } catch { /* shutting down */ }
    process.exit(0);
});

log(`ready — ${Object.keys(TOOLS).length} tools${API_KEY ? '' : ' (SCRIPTORIUM_API_KEY not set)'}`);
