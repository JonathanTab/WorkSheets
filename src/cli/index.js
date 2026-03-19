#!/usr/bin/env node
/**
 * pt-sheet - CLI for reading and writing plainTab spreadsheets.
 *
 * Authentication:
 *   Set PLAINTAB_API_KEY environment variable to your API key.
 *
 * Commands:
 *   list                                     List all worksheet files
 *   sheets    <fileId>                        List sheets in a document
 *   tables    <fileId> <sheetId>             List tables in a sheet
 *   get-cell  <fileId> <sheetId> <r> <c>    Read a cell (0-based)
 *   set-cell  <fileId> <sheetId> <r> <c> <value>   Write a cell
 *   get-rows  <fileId> <sheetId> <tableId>   Dump all rows of a table
 *   add-row   <fileId> <sheetId> <tableId> <json>  Append a row (JSON object)
 *
 * Examples:
 *   node src/cli/index.js list
 *   node src/cli/index.js sheets abc123
 *   node src/cli/index.js add-row abc123 sheet-1 tbl-x '{"name":"Alice","score":42}'
 */

import process from 'node:process';
import { SpreadsheetClient } from './SpreadsheetClient.js';

// ─── Entry ─────────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
}

const apiKey = process.env.PLAINTAB_API_KEY;
if (!apiKey) {
    die('PLAINTAB_API_KEY environment variable is not set.\nGet your key from the app settings.');
}

main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});

// ─── Main dispatcher ───────────────────────────────────────────────────────

async function main() {
    const client = new SpreadsheetClient({ apiKey });

    try {
        switch (cmd) {
            case 'list':     await cmdList(client, args); break;
            case 'sheets':   await cmdSheets(client, args); break;
            case 'tables':   await cmdTables(client, args); break;
            case 'get-cell': await cmdGetCell(client, args); break;
            case 'set-cell': await cmdSetCell(client, args); break;
            case 'get-rows': await cmdGetRows(client, args); break;
            case 'add-row':  await cmdAddRow(client, args); break;
            default:
                console.error(`Unknown command: ${cmd}`);
                printHelp();
                process.exit(1);
        }
    } finally {
        await client.close();
    }
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function cmdList(client) {
    await client.init();
    const files = client.listFiles();
    if (files.length === 0) {
        console.log('No worksheet files found.');
        return;
    }
    console.log(`${'ID'.padEnd(36)}  TITLE`);
    console.log('-'.repeat(60));
    for (const f of files) {
        console.log(`${f.id.padEnd(36)}  ${f.title}`);
    }
}

async function cmdSheets(client, [fileId]) {
    if (!fileId) die('Usage: sheets <fileId>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const sheets = client.listSheets(ydoc);
    if (sheets.length === 0) { console.log('No sheets found.'); return; }
    console.log(`${'ID'.padEnd(30)}  NAME`);
    console.log('-'.repeat(50));
    for (const s of sheets) {
        console.log(`${s.id.padEnd(30)}  ${s.name}`);
    }
}

async function cmdTables(client, [fileId, sheetId]) {
    if (!fileId || !sheetId) die('Usage: tables <fileId> <sheetId>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const tables = client.listTables(ydoc, sheetId);
    if (tables.length === 0) { console.log('No tables found.'); return; }
    for (const t of tables) {
        const cols = t.columns.map(c => `${c.name}(${c.id})`).join(', ');
        console.log(`${t.id}  "${t.name}"  [${t.mode}]  columns: ${cols}`);
    }
}

async function cmdGetCell(client, [fileId, sheetId, rowStr, colStr]) {
    if (!fileId || !sheetId || rowStr == null || colStr == null) {
        die('Usage: get-cell <fileId> <sheetId> <row> <col>');
    }
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const cell = client.getCell(ydoc, sheetId, Number(rowStr), Number(colStr));
    if (!cell) { console.log('(empty)'); return; }
    console.log(JSON.stringify(cell, null, 2));
}

async function cmdSetCell(client, [fileId, sheetId, rowStr, colStr, value]) {
    if (!fileId || !sheetId || rowStr == null || colStr == null || value == null) {
        die('Usage: set-cell <fileId> <sheetId> <row> <col> <value>');
    }
    await client.init();
    const ydoc = await client.openDoc(fileId);
    // Coerce numeric strings; leave formulas as strings
    const parsed = value.startsWith('=') ? value : (isNaN(value) ? value : Number(value));
    client.setCell(ydoc, sheetId, Number(rowStr), Number(colStr), parsed);
    await client.flush();
    console.log(`Cell (${rowStr},${colStr}) set to: ${JSON.stringify(parsed)}`);
}

async function cmdGetRows(client, [fileId, sheetId, tableId]) {
    if (!fileId || !sheetId || !tableId) die('Usage: get-rows <fileId> <sheetId> <tableId>');
    await client.init();
    const ydoc = await client.openDoc(fileId);
    const rows = client.getTableRows(ydoc, sheetId, tableId);
    if (rows.length === 0) { console.log('(no rows)'); return; }
    console.log(JSON.stringify(rows, null, 2));
}

async function cmdAddRow(client, [fileId, sheetId, tableId, jsonStr]) {
    if (!fileId || !sheetId || !tableId || !jsonStr) {
        die('Usage: add-row <fileId> <sheetId> <tableId> <json>');
    }
    let rowData;
    try { rowData = JSON.parse(jsonStr); } catch {
        die(`Invalid JSON: ${jsonStr}`);
    }
    await client.init();
    const ydoc = await client.openDoc(fileId);
    client.insertTableRow(ydoc, sheetId, tableId, rowData);
    await client.flush();
    console.log(`Row inserted: ${JSON.stringify(rowData)}`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function die(msg) {
    console.error(msg);
    process.exit(1);
}

function printHelp() {
    console.log(`
pt-sheet - plainTab spreadsheet CLI

  PLAINTAB_API_KEY=<key> node src/cli/index.js <command> [args]

Commands:
  list                                       List all worksheet files
  sheets    <fileId>                         List sheets in a document
  tables    <fileId> <sheetId>              List tables in a sheet
  get-cell  <fileId> <sheetId> <r> <c>     Read a cell (0-based coords)
  set-cell  <fileId> <sheetId> <r> <c> <v> Write a cell value or formula
  get-rows  <fileId> <sheetId> <tableId>    Dump all rows of a table (JSON)
  add-row   <fileId> <sheetId> <tableId> <json>
                                             Append a row (JSON object)

Example:
  node src/cli/index.js list
  node src/cli/index.js add-row abc123 sheet-1 tbl-x '{"name":"Alice","score":42}'
`.trim());
}
