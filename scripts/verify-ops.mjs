/**
 * verify-ops.mjs — Self-check for the shared spreadsheet operations layer.
 *
 * The ops layer under src/stores/spreadsheet/ops/ is imported by BOTH the
 * browser client and the Node API/MCP server, so a regression here breaks both
 * at once. This script exercises it against an in-memory Y.Doc — no network,
 * no server, no browser.
 *
 * Run:  npm run verify
 */

import * as Y from 'yjs';
import { initializeDocument } from '../src/stores/spreadsheet/schema.js';
import {
    parseA1Cell, parseA1Range, formatA1Cell, formatA1Range, splitSheetRef,
} from '../src/formulas/a1.js';
import * as cellOps from '../src/stores/spreadsheet/ops/cellOps.js';
import * as formatOps from '../src/stores/spreadsheet/ops/formatOps.js';
import * as sheetOps from '../src/stores/spreadsheet/ops/sheetOps.js';
import * as tableOps from '../src/stores/spreadsheet/ops/tableOps.js';
import * as docOps from '../src/stores/spreadsheet/ops/docOps.js';
import * as inspectOps from '../src/stores/spreadsheet/ops/inspectOps.js';
import { schemaStatus, prepareForWrite } from '../src/stores/spreadsheet/ops/context.js';

let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; failures.push(`${name}\n    expected ${e}\n    actual   ${a}`); }
}
function ok(name, cond, detail = '') {
    if (cond) { pass++; }
    else { fail++; failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t}`); }

// ── A1 notation ────────────────────────────────────────────────────────────
section('A1 notation');
check('parseA1Cell A1', parseA1Cell('A1'), { row: 0, col: 0 });
check('parseA1Cell B3', parseA1Cell('B3'), { row: 2, col: 1 });
check('parseA1Cell $AA$10 (absolute)', parseA1Cell('$AA$10'), { row: 9, col: 26 });
check('parseA1Range B3:D10', parseA1Range('B3:D10'), { startRow: 2, startCol: 1, endRow: 9, endCol: 3 });
check('parseA1Range reversed normalises', parseA1Range('D10:B3'), { startRow: 2, startCol: 1, endRow: 9, endCol: 3 });
check('parseA1Range single cell', parseA1Range('C5'), { startRow: 4, startCol: 2, endRow: 4, endCol: 2 });
check('parseA1Range column band', parseA1Range('B:C', { rowCount: 100 }), { startRow: 0, startCol: 1, endRow: 99, endCol: 2 });
check('parseA1Range row band', parseA1Range('2:4', { colCount: 26 }), { startRow: 1, startCol: 0, endRow: 3, endCol: 25 });
check('formatA1Range collapses 1x1', formatA1Range(0, 0, 0, 0), 'A1');
check('formatA1Range rect', formatA1Range(2, 1, 9, 3), 'B3:D10');
check('formatA1Cell AA10', formatA1Cell(9, 26), 'AA10');
check('splitSheetRef quoted', splitSheetRef("'Q3 Data'!A1:B2"), { sheetName: 'Q3 Data', ref: 'A1:B2' });
check('splitSheetRef bare', splitSheetRef('Sheet2!A1'), { sheetName: 'Sheet2', ref: 'A1' });
check('splitSheetRef none', splitSheetRef('A1:B2'), { sheetName: null, ref: 'A1:B2' });
ok('whole-column band without bounds throws', (() => {
    try { parseA1Range('A:A'); return false; } catch { return true; }
})());

// ── Document + schema guard ────────────────────────────────────────────────
section('Document + schema lockstep');
const ydoc = new Y.Doc();
initializeDocument(ydoc, { creator: 'verify' });
check('doc stamped at code schema version', schemaStatus(ydoc).status, 'match');
ok('prepareForWrite accepts current doc', (() => {
    try { prepareForWrite(ydoc); return true; } catch { return false; }
})());
ok('refuses a doc from the future', (() => {
    const future = new Y.Doc();
    initializeDocument(future, {});
    future.getMap('spreadsheet').get('metadata').set('schemaVersion', 999);
    try { prepareForWrite(future); return false; }
    catch (e) { return e.code === 'SCHEMA_TOO_NEW'; }
})());

// ── Style palette (the v9 correctness fix) ─────────────────────────────────
section('Style palette');
cellOps.setCell(ydoc, 'Sheet 1', 'A1', 'Revenue', { bold: true, backgroundColor: '#eee' });
const a1 = cellOps.getCell(ydoc, 'Sheet 1', 'A1');
check('value written', a1.value, 'Revenue');
check('style resolved, not a palette ref', a1.style, { bold: true, backgroundColor: '#eee' });
ok('no raw {s:sid} leaks to callers', !('s' in (a1.style ?? {})), JSON.stringify(a1.style));

const palette = ydoc.getMap('spreadsheet').get('stylePalette');
ok('palette received an entry', palette && palette.length > 0, `length=${palette?.length}`);
const paletteBefore = palette.length;
cellOps.setCell(ydoc, 'Sheet 1', 'B1', 'Cost', { bold: true, backgroundColor: '#eee' });
check('identical style is deduped', palette.length, paletteBefore);

cellOps.setCell(ydoc, 'Sheet 1', 'A1', undefined, { italic: true });
check('style merges rather than replaces', cellOps.getCell(ydoc, 'Sheet 1', 'A1').style,
    { bold: true, backgroundColor: '#eee', italic: true });
check('format-only write preserves value', cellOps.getCell(ydoc, 'Sheet 1', 'A1').value, 'Revenue');
cellOps.setCell(ydoc, 'Sheet 1', 'A1', undefined, { italic: null });
check('null clears one property only', cellOps.getCell(ydoc, 'Sheet 1', 'A1').style,
    { bold: true, backgroundColor: '#eee' });

// ── Formula evaluation ─────────────────────────────────────────────────────
section('Formula evaluation');
cellOps.setRange(ydoc, 'Sheet 1', 'A2', [[10], [20], [30]]);
cellOps.setCell(ydoc, 'Sheet 1', 'A5', '=SUM(A2:A4)');
const a5 = cellOps.getCell(ydoc, 'Sheet 1', 'A5');
check('formula evaluates on read', a5.value, 60);
check('formula text still available', a5.formula, '=SUM(A2:A4)');
check('evaluate:false returns raw text', cellOps.getCell(ydoc, 'Sheet 1', 'A5', { evaluate: false }).value, '=SUM(A2:A4)');
cellOps.setCell(ydoc, 'Sheet 1', 'D1', '=D2');
cellOps.setCell(ydoc, 'Sheet 1', 'D2', '=D1');
check('circular reference contained', cellOps.getCell(ydoc, 'Sheet 1', 'D1').value, '#CIRC!');

// ── Ranges ─────────────────────────────────────────────────────────────────
section('Range operations');
const rng = cellOps.getRange(ydoc, 'Sheet 1', 'A2:A5', { includeFormulas: true });
check('range values evaluated', rng.values, [[10], [20], [30], [60]]);
check('parallel formula grid', rng.formulas, [[null], [null], [null], ['=SUM(A2:A4)']]);
check('range label echoed', rng.range, 'A2:A5');
check('formatRange cell count', formatOps.formatRange(ydoc, 'Sheet 1', 'A2:A4', { numberFormat: '#,##0.00' }).cells, 3);
check('formatRange applied', cellOps.getCell(ydoc, 'Sheet 1', 'A3').style, { numberFormat: '#,##0.00' });
check('formatRange left value intact', cellOps.getCell(ydoc, 'Sheet 1', 'A3').value, 20);
check('sheet resolvable by id as well as name', cellOps.getCell(ydoc, 'sheet-1', 'A2').value, 10);
ok('used range detected', cellOps.getUsedRange(ydoc, 'Sheet 1').range !== null);
cellOps.clearRange(ydoc, 'Sheet 1', 'D1:D2');
check('clearRange removes contents', cellOps.getCell(ydoc, 'Sheet 1', 'D1').value, null);
ok('unknown sheet raises SHEET_NOT_FOUND', (() => {
    try { cellOps.getCell(ydoc, 'Nope', 'A1'); return false; }
    catch (e) { return e.code === 'SHEET_NOT_FOUND' && Array.isArray(e.details?.available); }
})());

// ── Design surface ─────────────────────────────────────────────────────────
section('Design surface');
formatOps.setColumnWidths(ydoc, 'Sheet 1', { A: 220, B: 90 });
check('column width stored', formatOps.getColumnWidth(ydoc, 'Sheet 1', 'A'), 220);
formatOps.setRowHeights(ydoc, 'Sheet 1', { 1: 40 });
check('row height stored', formatOps.getRowHeight(ydoc, 'Sheet 1', 1), 40);
formatOps.mergeCells(ydoc, 'Sheet 1', 'F1:H1');
check('merge recorded', formatOps.listMerges(ydoc, 'Sheet 1'), ['F1:H1']);
ok('overlapping merge rejected', (() => {
    try { formatOps.mergeCells(ydoc, 'Sheet 1', 'G1:I1'); return false; }
    catch (e) { return e.code === 'MERGE_OVERLAP'; }
})());
formatOps.unmergeCells(ydoc, 'Sheet 1', 'F1:H1');
check('unmerge removes it', formatOps.listMerges(ydoc, 'Sheet 1'), []);
formatOps.setBorders(ydoc, 'Sheet 1', 'A1:B2', { outline: { style: 'solid', width: 1, color: '#333' } });
ok('outline borders written', formatOps.listBorders(ydoc, 'Sheet 1').length > 0);
formatOps.setFrozenPanes(ydoc, 'Sheet 1', { rows: 1, columns: 0 });
check('freeze panes set', formatOps.getFrozenPanes(ydoc, 'Sheet 1'), { rows: 1, columns: 0 });
const cf = formatOps.addConditionalFormat(ydoc, 'Sheet 1', {
    range: 'A2:A4', condition: 'gt', threshold: 15,
    style: { backgroundColor: '#fee' },
});
ok('unknown condition rejected', (() => {
    try {
        formatOps.addConditionalFormat(ydoc, 'Sheet 1', {
            range: 'A2:A4', condition: 'greaterThan', threshold: 1, style: { bold: true },
        });
        return false;
    } catch (e) { return e.code === 'INVALID_CONDITION'; }
})());
ok('conditional format added', typeof cf.id === 'string');
check('conditional format listed', formatOps.listConditionalFormats(ydoc, 'Sheet 1').length, 1);
formatOps.removeConditionalFormat(ydoc, 'Sheet 1', cf.id);
check('conditional format removed', formatOps.listConditionalFormats(ydoc, 'Sheet 1').length, 0);

// ── Sheets, rows, columns ──────────────────────────────────────────────────
section('Sheets / rows / columns');
const created = sheetOps.createSheet(ydoc, 'Budget');
ok('sheet created', created.name === 'Budget');
check('sheet appears in list', sheetOps.listSheets(ydoc).map(s => s.name), ['Sheet 1', 'Budget']);
sheetOps.renameSheet(ydoc, 'Budget', 'Budget 2026');
check('sheet renamed', sheetOps.listSheets(ydoc).map(s => s.name), ['Sheet 1', 'Budget 2026']);

cellOps.setRange(ydoc, 'Budget 2026', 'A1', [['a'], ['b'], ['c']]);
sheetOps.insertRows(ydoc, 'Budget 2026', 2, 1);   // before row 2
check('insertRows shifts data down', cellOps.getRange(ydoc, 'Budget 2026', 'A1:A4').values,
    [['a'], [null], ['b'], ['c']]);
sheetOps.deleteRows(ydoc, 'Budget 2026', 2, 1);
check('deleteRows shifts data back', cellOps.getRange(ydoc, 'Budget 2026', 'A1:A3').values,
    [['a'], ['b'], ['c']]);

cellOps.setRange(ydoc, 'Budget 2026', 'A1', [['x', 'y', 'z']]);
sheetOps.insertColumns(ydoc, 'Budget 2026', 'B', 1);
check('insertColumns shifts data right', cellOps.getRange(ydoc, 'Budget 2026', 'A1:D1').values,
    [['x', null, 'y', 'z']]);

// formula reference adjustment on structural edits
cellOps.setCell(ydoc, 'Budget 2026', 'A10', 10);
cellOps.setCell(ydoc, 'Budget 2026', 'A11', '=A10*2');
sheetOps.insertRows(ydoc, 'Budget 2026', 1, 1);   // before row 1 → everything shifts down
check('formula refs adjusted on row insert',
    cellOps.getCell(ydoc, 'Budget 2026', 'A12', { evaluate: false }).formula, '=A11*2');
check('adjusted formula still computes', cellOps.getCell(ydoc, 'Budget 2026', 'A12').value, 20);

sheetOps.deleteSheet(ydoc, 'Budget 2026');
check('sheet deleted', sheetOps.listSheets(ydoc).map(s => s.name), ['Sheet 1']);
ok('cannot delete the last sheet', (() => {
    try { sheetOps.deleteSheet(ydoc, 'Sheet 1'); return false; }
    catch (e) { return e.code === 'LAST_SHEET'; }
})());

// ── Tables ─────────────────────────────────────────────────────────────────
section('Tables');
const tbl = tableOps.createTable(ydoc, {
    name: 'Expenses',
    sheet: 'Sheet 1',
    columns: [
        { name: 'Item', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Category', type: 'dropdown', typeConfig: { options: ['Ops', 'R&D'] } },
        { name: 'Doubled', isNonEntry: true, defaultFormula: '{Amount} * 2' },
    ],
});
ok('table created with an id', typeof tbl.id === 'string');
check('schema reports columns', tableOps.getTableSchema(ydoc, 'Expenses').columns.map(c => c.name),
    ['Item', 'Amount', 'Category', 'Doubled']);

tableOps.insertRow(ydoc, 'Expenses', { Item: 'Laptop', Amount: 1200, Category: 'Ops' });
tableOps.insertRow(ydoc, 'Expenses', { Item: 'Server', Amount: 800, Category: 'R&D' });
const rows = tableOps.getRows(ydoc, 'Expenses', { byName: true });
check('rows returned newest-first', rows.map(r => r.Item), ['Server', 'Laptop']);
check('computed column evaluated', rows.map(r => r.Doubled), [1600, 2400]);

ok('bad dropdown value rejected', (() => {
    try { tableOps.insertRow(ydoc, 'Expenses', { Item: 'X', Category: 'Nope' }); return false; }
    catch (e) { return e.code === 'VALIDATION_FAILED'; }
})());
ok('wrong type rejected', (() => {
    try { tableOps.insertRow(ydoc, 'Expenses', { Item: 'X', Amount: 'not-a-number' }); return false; }
    catch (e) { return e.code === 'VALIDATION_FAILED'; }
})());
ok('writing a computed column rejected', (() => {
    try { tableOps.insertRow(ydoc, 'Expenses', { Item: 'X', Doubled: 5 }); return false; }
    catch (e) { return e.code === 'VALIDATION_FAILED'; }
})());

const appended = tableOps.appendRows(ydoc, 'Expenses', [
    { Item: 'Desk', Amount: 300, Category: 'Ops' },
    { Item: 'Chair', Amount: 150, Category: 'Ops' },
]);
check('bulk append count', appended.inserted, 2);
check('table row count', tableOps.getRows(ydoc, 'Expenses').length, 4);

const found = tableOps.findRows(ydoc, 'Expenses', { Category: 'Ops' });
check('findRows filters', found.length, 3);
tableOps.updateRow(ydoc, 'Expenses', found[0].index, { Amount: 999 });
ok('updateRow applied', tableOps.getRows(ydoc, 'Expenses', { byName: true }).some(r => r.Amount === 999));
tableOps.deleteRow(ydoc, 'Expenses', found[0].index);
check('deleteRow applied', tableOps.getRows(ydoc, 'Expenses').length, 3);

// TABLE_* functions resolve from a sheet formula
cellOps.setCell(ydoc, 'Sheet 1', 'H10', "=TABLE_SUM('Expenses', 'Amount')");
const tableSum = cellOps.getCell(ydoc, 'Sheet 1', 'H10').value;
ok('TABLE_SUM resolves server-side', typeof tableSum === 'number' && tableSum > 0, `got ${tableSum}`);

// ── describe / batch / inspect ─────────────────────────────────────────────
section('Describe / batch / inspect');
const desc = docOps.describeDocument(ydoc);
ok('describe lists sheets', desc.sheets.length >= 1);
ok('describe includes used range', 'usedRange' in desc.sheets[0]);
ok('describe includes tables with schema', desc.tables.some(t => t.name === 'Expenses' && t.columns.length === 4));

const batch = docOps.applyBatch(ydoc, [
    { op: 'setCell', sheet: 'Sheet 1', ref: 'K1', value: 'batched' },
    { op: 'formatRange', sheet: 'Sheet 1', range: 'K1:K1', style: { bold: true } },
]);
check('batch reports success', batch.applied, 2);
check('batch write landed', cellOps.getCell(ydoc, 'Sheet 1', 'K1').value, 'batched');

const rolledBack = (() => {
    try {
        docOps.applyBatch(ydoc, [
            { op: 'setCell', sheet: 'Sheet 1', ref: 'K2', value: 'should-not-persist' },
            { op: 'setCell', sheet: 'Ghost Sheet', ref: 'A1', value: 'boom' },
        ]);
        return false;
    } catch { return true; }
})();
ok('failing batch throws', rolledBack);
check('failing batch rolled back entirely', cellOps.getCell(ydoc, 'Sheet 1', 'K2').value, null);

cellOps.setCell(ydoc, 'Sheet 1', 'M1', '=1/0');
cellOps.setCell(ydoc, 'Sheet 1', 'M2', '=NOSUCHFUNC(1)');
const report = inspectOps.inspectDocument(ydoc);
ok('inspect returns findings array', Array.isArray(report.findings));
ok('inspect flags error cells', report.findings.some(f => f.type === 'error-cell'),
    JSON.stringify(report.findings.map(f => f.type)));

// ── Summary ────────────────────────────────────────────────────────────────
if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
