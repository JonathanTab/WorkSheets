#!/usr/bin/env node
/**
 * pt-sheet - plainTab spreadsheet CLI
 *
 * Authentication (in priority order):
 *   1. --token <tok>              Command-line flag
 *   2. PLAINTAB_API_KEY           API key from users.json
 *   3. PLAINTAB_SESSION           PHP session token (same 64-hex format)
 *
 * Both API keys and PHP session tokens are accepted interchangeably.
 * PHP scripts can obtain the session token from the user's cookie and pass it
 * via env var or --token flag.
 *
 * Global flags (work before any command):
 *   --json              Machine-readable JSON output; errors → stderr as JSON
 *   --token <tok>       Override auth token
 *   --base-url <url>    Override storage API URL
 *   --blob-url <url>    Override blob storage URL
 *   --ws-url <url>      Override WebSocket URL
 *
 * Commands:
 *   FILE DISCOVERY
 *     list                              List worksheet files
 *     list --all                        List all files (all apps/scopes)
 *     find <title>                      Find file by exact title → outputs ID
 *
 *   DOCUMENT STRUCTURE
 *     sheets <fileId>                   List sheets
 *     sheet-info <fileId> <sheetId>     Sheet metadata (name, row/col counts)
 *     tables <fileId> <sheetId>         List tables with columns
 *
 *   CELLS
 *     get-cell  <fileId> <sheetId> <r> <c>
 *     set-cell  <fileId> <sheetId> <r> <c> <value> [--props <json>]
 *     clear-cell <fileId> <sheetId> <r> <c>
 *     get-range  <fileId> <sheetId> <r1> <c1> <r2> <c2>
 *     set-range  <fileId> <sheetId> <r> <c> <json>   (2-D array [[v,...],...]
 *     clear-range <fileId> <sheetId> <r1> <c1> <r2> <c2>
 *
 *   TABLE ROWS  (column names or IDs accepted in JSON objects)
 *     get-rows   <fileId> <sheetId> <tableId>
 *     find-rows  <fileId> <sheetId> <tableId> <whereJson>
 *     add-row    <fileId> <sheetId> <tableId> <json>
 *     update-row <fileId> <sheetId> <tableId> <index> <json>
 *     upsert-row <fileId> <sheetId> <tableId> <whereJson> <rowJson>
 *     delete-row <fileId> <sheetId> <tableId> <index>
 *
 *   SHEET MANAGEMENT
 *     create-sheet <fileId> <name>
 *     rename-sheet <fileId> <sheetId> <newName>
 *     delete-sheet <fileId> <sheetId>
 */

import process from 'node:process';
import { SpreadsheetClient } from './SpreadsheetClient.js';

// ─── Argument parsing ──────────────────────────────────────────────────────

const flags  = { json: false, all: false };
const extras = {};   // --base-url, --blob-url, --ws-url, --token, --props
const positional = [];

{
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json')   { flags.json = true; continue; }
        if (a === '--all')    { flags.all  = true; continue; }
        if ((a === '--token' || a === '--base-url' || a === '--blob-url' ||
             a === '--ws-url' || a === '--props') && argv[i + 1]) {
            extras[a.slice(2)] = argv[++i];
            continue;
        }
        positional.push(a);
    }
}

const [cmd, ...args] = positional;

// ─── Auth ──────────────────────────────────────────────────────────────────

const apiKey = extras.token
    || process.env.PLAINTAB_API_KEY
    || process.env.PLAINTAB_SESSION;

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
}

if (!apiKey) {
    die('No auth token found.\n' +
        'Set PLAINTAB_API_KEY (or PLAINTAB_SESSION for PHP session tokens),\n' +
        'or pass --token <tok>.');
}

// ─── Entry ─────────────────────────────────────────────────────────────────

main().catch(err => {
    if (flags.json) {
        process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
    } else {
        process.stderr.write(`Error: ${err.message}\n`);
    }
    process.exit(1);
});

// ─── Main dispatcher ───────────────────────────────────────────────────────

async function main() {
    const clientOpts = { apiKey };
    if (extras['base-url']) clientOpts.baseUrl = extras['base-url'];
    if (extras['blob-url']) clientOpts.blobUrl = extras['blob-url'];
    if (extras['ws-url'])   clientOpts.wsUrl   = extras['ws-url'];

    const client = new SpreadsheetClient(clientOpts);

    try {
        switch (cmd) {
            // File discovery
            case 'list':         await cmdList(client, args); break;
            case 'find':         await cmdFind(client, args); break;

            // Document structure
            case 'sheets':       await cmdSheets(client, args); break;
            case 'sheet-info':   await cmdSheetInfo(client, args); break;
            case 'tables':       await cmdTables(client, args); break;

            // Cells
            case 'get-cell':     await cmdGetCell(client, args); break;
            case 'set-cell':     await cmdSetCell(client, args); break;
            case 'clear-cell':   await cmdClearCell(client, args); break;
            case 'get-range':    await cmdGetRange(client, args); break;
            case 'set-range':    await cmdSetRange(client, args); break;
            case 'clear-range':  await cmdClearRange(client, args); break;

            // Table rows
            case 'get-rows':     await cmdGetRows(client, args); break;
            case 'find-rows':    await cmdFindRows(client, args); break;
            case 'add-row':      await cmdAddRow(client, args); break;
            case 'update-row':   await cmdUpdateRow(client, args); break;
            case 'upsert-row':   await cmdUpsertRow(client, args); break;
            case 'delete-row':   await cmdDeleteRow(client, args); break;

            // Sheet management
            case 'create-sheet': await cmdCreateSheet(client, args); break;
            case 'rename-sheet': await cmdRenameSheet(client, args); break;
            case 'delete-sheet': await cmdDeleteSheet(client, args); break;

            default:
                process.stderr.write(`Unknown command: ${cmd}\n`);
                printHelp();
                process.exit(1);
        }
    } finally {
        await client.close();
    }
}

// ─── File discovery ────────────────────────────────────────────────────────

async function cmdList(client) {
    await client.init();
    const files = flags.all ? client.listAllFiles() : client.listFiles();
    if (flags.json) {
        out(files.map(f => ({ id: f.id, title: f.title, app: f.app, scope: f.scope, mtime: f.mtime })));
        return;
    }
    if (files.length === 0) { console.log('No files found.'); return; }
    console.log(`${'ID'.padEnd(36)}  ${'APP'.padEnd(12)}  TITLE`);
    console.log('-'.repeat(70));
    for (const f of files) {
        console.log(`${f.id.padEnd(36)}  ${(f.app ?? '').padEnd(12)}  ${f.title}`);
    }
}

async function cmdFind(client, [title]) {
    if (!title) die('Usage: find <title>');
    await client.init();
    const file = client.findFile(title);
    if (!file) die(`No file found with title: "${title}"`);
    if (flags.json) {
        out({ id: file.id, title: file.title, app: file.app, scope: file.scope, roomId: file.roomId });
    } else {
        console.log(file.id);
    }
}

// ─── Document structure ────────────────────────────────────────────────────

async function cmdSheets(client, [fileId]) {
    if (!fileId) die('Usage: sheets <fileId>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const sheets = client.listSheets(ydoc);
    if (flags.json) { out(sheets); return; }
    if (sheets.length === 0) { console.log('No sheets found.'); return; }
    console.log(`${'ID'.padEnd(36)}  NAME`);
    console.log('-'.repeat(55));
    for (const s of sheets) {
        console.log(`${s.id.padEnd(36)}  ${s.name}`);
    }
}

async function cmdSheetInfo(client, [fileId, sheetId]) {
    if (!fileId || !sheetId) die('Usage: sheet-info <fileId> <sheetId>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const meta = client.getSheetMeta(ydoc, sheetId);
    if (flags.json) { out(meta); return; }
    console.log(`Name:    ${meta.name}`);
    console.log(`ID:      ${meta.id}`);
    console.log(`Rows:    ${meta.rowCount}`);
    console.log(`Columns: ${meta.colCount}`);
    if (meta.frozenRows)    console.log(`Frozen rows:    ${meta.frozenRows}`);
    if (meta.frozenColumns) console.log(`Frozen columns: ${meta.frozenColumns}`);
}

async function cmdTables(client, [fileId, sheetId]) {
    if (!fileId || !sheetId) die('Usage: tables <fileId> <sheetId>');
    await client.init();
    const ydoc   = await client.openDoc(fileId);
    const tables = client.listTables(ydoc, sheetId);
    if (flags.json) { out(tables); return; }
    if (tables.length === 0) { console.log('No tables found.'); return; }
    for (const t of tables) {
        const cols = t.columns.map(c => `${c.name}(${c.id})`).join(', ');
        console.log(`${t.id}  "${t.name}"  [${t.mode}]`);
        console.log(`  columns: ${cols || '(none)'}`);
    }
}

// ─── Cells ─────────────────────────────────────────────────────────────────

async function cmdGetCell(client, [fileId, sheetId, rowStr, colStr]) {
    if (!fileId || !sheetId || rowStr == null || colStr == null)
        die('Usage: get-cell <fileId> <sheetId> <row> <col>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const cell = client.getCell(ydoc, sheetId, Number(rowStr), Number(colStr));
    if (flags.json) { out(cell ?? null); return; }
    if (!cell) { console.log('(empty)'); return; }
    console.log(JSON.stringify(cell, null, 2));
}

async function cmdSetCell(client, [fileId, sheetId, rowStr, colStr, value]) {
    if (!fileId || !sheetId || rowStr == null || colStr == null || value == null)
        die('Usage: set-cell <fileId> <sheetId> <row> <col> <value> [--props <json>]');
    await client.init();
    const ydoc   = await client.openDoc(fileId);
    const parsed = coerceValue(value);
    const props  = extras.props ? parseJSON(extras.props, '--props') : {};
    client.setCell(ydoc, sheetId, Number(rowStr), Number(colStr), parsed, props);
    await client.flush();
    if (flags.json) {
        out({ row: Number(rowStr), col: Number(colStr), value: parsed });
    } else {
        console.log(`Set (${rowStr},${colStr}) = ${JSON.stringify(parsed)}`);
    }
}

async function cmdClearCell(client, [fileId, sheetId, rowStr, colStr]) {
    if (!fileId || !sheetId || rowStr == null || colStr == null)
        die('Usage: clear-cell <fileId> <sheetId> <row> <col>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    client.clearCell(ydoc, sheetId, Number(rowStr), Number(colStr));
    await client.flush();
    if (flags.json) {
        out({ cleared: true, row: Number(rowStr), col: Number(colStr) });
    } else {
        console.log(`Cleared (${rowStr},${colStr})`);
    }
}

async function cmdGetRange(client, [fileId, sheetId, r1, c1, r2, c2]) {
    if (!fileId || !sheetId || r1 == null || c1 == null || r2 == null || c2 == null)
        die('Usage: get-range <fileId> <sheetId> <r1> <c1> <r2> <c2>');
    await client.init();
    const ydoc  = await client.openDoc(fileId);
    const grid  = client.getRange(ydoc, sheetId, Number(r1), Number(c1), Number(r2), Number(c2));
    if (flags.json) { out(grid); return; }
    console.log(JSON.stringify(grid, null, 2));
}

async function cmdSetRange(client, [fileId, sheetId, rowStr, colStr, jsonStr]) {
    if (!fileId || !sheetId || rowStr == null || colStr == null || !jsonStr)
        die('Usage: set-range <fileId> <sheetId> <startRow> <startCol> <json2dArray>');
    const values = parseJSON(jsonStr, 'range values');
    if (!Array.isArray(values)) die('set-range: JSON must be a 2-D array, e.g. [[1,2],[3,4]]');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    client.setRange(ydoc, sheetId, Number(rowStr), Number(colStr), values);
    await client.flush();
    const rows = values.length;
    const cols = values[0]?.length ?? 0;
    if (flags.json) {
        out({ written: true, startRow: Number(rowStr), startCol: Number(colStr), rows, cols });
    } else {
        console.log(`Wrote ${rows}×${cols} range starting at (${rowStr},${colStr})`);
    }
}

async function cmdClearRange(client, [fileId, sheetId, r1, c1, r2, c2]) {
    if (!fileId || !sheetId || r1 == null || c1 == null || r2 == null || c2 == null)
        die('Usage: clear-range <fileId> <sheetId> <r1> <c1> <r2> <c2>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    client.clearRange(ydoc, sheetId, Number(r1), Number(c1), Number(r2), Number(c2));
    await client.flush();
    if (flags.json) {
        out({ cleared: true, r1: Number(r1), c1: Number(c1), r2: Number(r2), c2: Number(c2) });
    } else {
        console.log(`Cleared range (${r1},${c1}):(${r2},${c2})`);
    }
}

// ─── Table rows ────────────────────────────────────────────────────────────

async function cmdGetRows(client, [fileId, sheetId, tableId]) {
    if (!fileId || !sheetId || !tableId) die('Usage: get-rows <fileId> <sheetId> <tableId>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const rows = client.getTableRows(ydoc, sheetId, tableId);
    if (flags.json) { out(rows); return; }
    if (rows.length === 0) { console.log('(no rows)'); return; }
    console.log(JSON.stringify(rows, null, 2));
}

async function cmdFindRows(client, [fileId, sheetId, tableId, whereStr]) {
    if (!fileId || !sheetId || !tableId || !whereStr)
        die('Usage: find-rows <fileId> <sheetId> <tableId> <whereJson>');
    const where   = parseJSON(whereStr, 'where');
    await client.init();
    const ydoc    = await client.openDoc(fileId);
    const resolved = client.resolveColumnNames(ydoc, sheetId, tableId, where);
    const results  = client.findTableRows(ydoc, sheetId, tableId, resolved);
    if (flags.json) { out(results); return; }
    if (results.length === 0) { console.log('(no matches)'); return; }
    console.log(JSON.stringify(results, null, 2));
}

async function cmdAddRow(client, [fileId, sheetId, tableId, jsonStr]) {
    if (!fileId || !sheetId || !tableId || !jsonStr)
        die('Usage: add-row <fileId> <sheetId> <tableId> <json>');
    const rowData = parseJSON(jsonStr, 'row data');
    await client.init();
    const ydoc     = await client.openDoc(fileId);
    const resolved = client.resolveColumnNames(ydoc, sheetId, tableId, rowData);
    client.insertTableRow(ydoc, sheetId, tableId, resolved);
    await client.flush();
    if (flags.json) {
        out({ inserted: true, row: resolved });
    } else {
        console.log(`Row inserted: ${JSON.stringify(resolved)}`);
    }
}

async function cmdUpdateRow(client, [fileId, sheetId, tableId, indexStr, jsonStr]) {
    if (!fileId || !sheetId || !tableId || indexStr == null || !jsonStr)
        die('Usage: update-row <fileId> <sheetId> <tableId> <index> <json>');
    const updates = parseJSON(jsonStr, 'updates');
    await client.init();
    const ydoc     = await client.openDoc(fileId);
    const resolved = client.resolveColumnNames(ydoc, sheetId, tableId, updates);
    client.updateTableRow(ydoc, sheetId, tableId, Number(indexStr), resolved);
    await client.flush();
    if (flags.json) {
        out({ updated: true, index: Number(indexStr), updates: resolved });
    } else {
        console.log(`Row ${indexStr} updated: ${JSON.stringify(resolved)}`);
    }
}

async function cmdUpsertRow(client, [fileId, sheetId, tableId, whereStr, rowStr]) {
    if (!fileId || !sheetId || !tableId || !whereStr || !rowStr)
        die('Usage: upsert-row <fileId> <sheetId> <tableId> <whereJson> <rowJson>');
    const where   = parseJSON(whereStr, 'where');
    const rowData = parseJSON(rowStr,   'row data');
    await client.init();
    const ydoc          = await client.openDoc(fileId);
    const resolvedWhere = client.resolveColumnNames(ydoc, sheetId, tableId, where);
    const resolvedRow   = client.resolveColumnNames(ydoc, sheetId, tableId, rowData);
    const result        = client.upsertTableRow(ydoc, sheetId, tableId, resolvedWhere, resolvedRow);
    await client.flush();
    if (flags.json) {
        out(result);
    } else {
        console.log(result.inserted
            ? `Row inserted at index ${result.index}`
            : `Row ${result.index} updated`);
    }
}

async function cmdDeleteRow(client, [fileId, sheetId, tableId, indexStr]) {
    if (!fileId || !sheetId || !tableId || indexStr == null)
        die('Usage: delete-row <fileId> <sheetId> <tableId> <index>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    client.deleteTableRow(ydoc, sheetId, tableId, Number(indexStr));
    await client.flush();
    if (flags.json) {
        out({ deleted: true, index: Number(indexStr) });
    } else {
        console.log(`Row ${indexStr} deleted`);
    }
}

// ─── Sheet management ──────────────────────────────────────────────────────

async function cmdCreateSheet(client, [fileId, name]) {
    if (!fileId || !name) die('Usage: create-sheet <fileId> <name>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const id   = client.createSheet(ydoc, name);
    await client.flush();
    if (flags.json) {
        out({ created: true, id, name });
    } else {
        console.log(`Sheet created: "${name}" (${id})`);
    }
}

async function cmdRenameSheet(client, [fileId, sheetId, newName]) {
    if (!fileId || !sheetId || !newName) die('Usage: rename-sheet <fileId> <sheetId> <newName>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    client.renameSheet(ydoc, sheetId, newName);
    await client.flush();
    if (flags.json) {
        out({ renamed: true, id: sheetId, name: newName });
    } else {
        console.log(`Sheet ${sheetId} renamed to "${newName}"`);
    }
}

async function cmdDeleteSheet(client, [fileId, sheetId]) {
    if (!fileId || !sheetId) die('Usage: delete-sheet <fileId> <sheetId>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    client.deleteSheet(ydoc, sheetId);
    await client.flush();
    if (flags.json) {
        out({ deleted: true, id: sheetId });
    } else {
        console.log(`Sheet ${sheetId} deleted`);
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function out(data) {
    console.log(JSON.stringify(data));
}

function die(msg) {
    if (flags.json) {
        process.stderr.write(JSON.stringify({ error: msg }) + '\n');
    } else {
        process.stderr.write(msg + '\n');
    }
    process.exit(1);
}

function parseJSON(str, label = 'JSON') {
    try {
        return JSON.parse(str);
    } catch {
        die(`Invalid ${label}: ${str}`);
    }
}

/** Coerce a CLI string value: numeric → number, "=formula" → string as-is, else string */
function coerceValue(str) {
    if (str.startsWith('=')) return str;
    const n = Number(str);
    return isNaN(n) ? str : n;
}

function printHelp() {
    console.log(`
pt-sheet  plainTab spreadsheet CLI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AUTH  (in priority order)
  --token <tok>              Bearer token (API key or PHP session token)
  PLAINTAB_API_KEY=<tok>     env var
  PLAINTAB_SESSION=<tok>     env var (PHP session token, same format)

GLOBAL FLAGS
  --json                     Machine-readable JSON output
  --base-url <url>           Override storage API URL
  --blob-url <url>           Override blob storage URL
  --ws-url <url>             Override WebSocket URL

FILE DISCOVERY
  list [--all]               List files (--all: all apps/scopes)
  find <title>               Find file by exact title → outputs ID

DOCUMENT STRUCTURE
  sheets <fileId>
  sheet-info <fileId> <sheetId>
  tables <fileId> <sheetId>

CELLS  (0-based row/col)
  get-cell   <f> <s> <r> <c>
  set-cell   <f> <s> <r> <c> <value> [--props <json>]
  clear-cell <f> <s> <r> <c>
  get-range  <f> <s> <r1> <c1> <r2> <c2>
  set-range  <f> <s> <r> <c> <json>          e.g. '[[1,2],[3,4]]'
  clear-range <f> <s> <r1> <c1> <r2> <c2>

TABLE ROWS  (column names or IDs accepted)
  get-rows   <f> <s> <tbl>
  find-rows  <f> <s> <tbl> <whereJson>        e.g. '{"status":"open"}'
  add-row    <f> <s> <tbl> <json>
  update-row <f> <s> <tbl> <index> <json>
  upsert-row <f> <s> <tbl> <whereJson> <rowJson>
  delete-row <f> <s> <tbl> <index>

SHEET MANAGEMENT
  create-sheet <fileId> <name>
  rename-sheet <fileId> <sheetId> <newName>
  delete-sheet <fileId> <sheetId>

EXAMPLES
  # List files
  PLAINTAB_API_KEY=abc123 node src/cli/index.js list --json

  # Resolve a file by name and add a row (shell)
  FILE=$(node src/cli/index.js find "Sales Tracker")
  node src/cli/index.js add-row "$FILE" sheet-1 tbl-x '{"Name":"Alice","Score":42}'

  # Upsert: update Alice's score if she exists, else insert
  node src/cli/index.js upsert-row "$FILE" sheet-1 tbl-x '{"Name":"Alice"}' '{"Score":99}'

  # PHP: call via shell_exec() passing session token
  # $out = shell_exec("PLAINTAB_SESSION={$token} node src/cli/index.js --json add-row ...");
  # $result = json_decode($out, true);
`.trim());
}
