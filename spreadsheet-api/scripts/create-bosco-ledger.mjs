/**
 * One-off script: create the "Bosco Ledger" spreadsheet on the live server.
 * Run with:  SCRIPTORIUM_API_KEY=<jonathan's key> node scripts/create-bosco-ledger.mjs
 */
import { SpreadsheetClient } from '../SpreadsheetClient.js';
import { initializeDocument } from '../../src/stores/spreadsheet/schema.js';
import * as sheetOps from '../../src/stores/spreadsheet/ops/sheetOps.js';
import * as tableOps from '../../src/stores/spreadsheet/ops/tableOps.js';
import * as formatOps from '../../src/stores/spreadsheet/ops/formatOps.js';
import * as cellOps from '../../src/stores/spreadsheet/ops/cellOps.js';

const apiKey = process.env.SCRIPTORIUM_API_KEY;
if (!apiKey) { console.error('Set SCRIPTORIUM_API_KEY'); process.exit(1); }

const NAVY = '#1e3a5f';
const NAVY_LIGHT = '#e8eef5';
const WHITE = '#ffffff';
const RED = '#dc2626';
const GREEN = '#16a34a';
const CURRENCY_FMT = '"$"#,##0.00';
const DATE_FMT = 'mm/dd/yyyy';

const CATEGORIES = [
    'Instructional Materials', 'Tools & Equipment', 'Supplies',
    'Facility & Maintenance', 'Field Trips', 'Meals & Hospitality',
    'Software & Subscriptions', 'Reimbursement', 'Other',
];
const ACCOUNTS = ['General Fund', 'Petty Cash'];

async function main() {
    const client = new SpreadsheetClient({ apiKey });
    await client.init();

    console.log('Creating file…');
    const file = await client._api.createFile({ title: 'Bosco Ledger', type: 'yjs', scope: 'drive' });
    console.log('Created file', file.id, 'room', file.roomId);
    await client.init();
    const ydoc = await client.openDoc(file.id);

    initializeDocument(ydoc, {
        creator: 'jonathan',
        description: 'Bosco — expense ledger for teachers to track school expenses',
    });

    sheetOps.renameSheet(ydoc, 'sheet-1', 'Ledger');

    // ─── Ledger table ───────────────────────────────────────────────
    const table = tableOps.createTable(ydoc, {
        name: 'Ledger',
        sheet: 'Ledger',
        startRow: 0,
        startCol: 0,
        columns: [
            { name: 'Date', type: 'date' },
            { name: 'Account', type: 'dropdown', typeConfig: { source: 'list', options: ACCOUNTS, allowCustom: true } },
            { name: 'Category', type: 'dropdown', typeConfig: { source: 'list', options: CATEGORIES, allowCustom: true } },
            { name: 'From/To', type: 'text' },
            { name: 'Amount', type: 'number' },
            { name: 'RB', type: 'number', isNonEntry: true, defaultFormula: "RUNNINGIF(Amount,Account,'=',{Account})", hAlign: 'left' },
            { name: 'Notes', type: 'text' },
            { name: 'Image', type: 'file' },
            { name: 'Reconciled', type: 'checkbox' },
            { name: 'Mobile', type: 'checkbox' },
        ],
    });
    console.log('Table created:', table.id);

    // ─── Ledger sheet formatting ────────────────────────────────────
    formatOps.setFrozenPanes(ydoc, 'Ledger', { rows: 1, columns: 1 });
    formatOps.setColumnWidths(ydoc, 'Ledger', {
        A: 100, B: 150, C: 190, D: 170, E: 110, F: 110, G: 260, H: 90, I: 95, J: 85,
    });
    formatOps.setRowHeights(ydoc, 'Ledger', { 1: 32 });

    cellOps.formatRange(ydoc, 'Ledger', 'A1:J1', {
        bold: true, backgroundColor: NAVY, color: WHITE,
        horizontalAlign: 'center', verticalAlign: 'middle',
    });
    formatOps.setBorders(ydoc, 'Ledger', 'A1:J1', { bottom: { style: 'solid', width: 2, color: NAVY } });
    formatOps.setBorders(ydoc, 'Ledger', 'A1:J300', { outline: { style: 'solid', width: 1, color: '#cbd5e1' } });

    cellOps.formatRange(ydoc, 'Ledger', 'A2:A300', { numberFormat: DATE_FMT });
    cellOps.formatRange(ydoc, 'Ledger', 'E2:F300', { numberFormat: CURRENCY_FMT, horizontalAlign: 'right' });

    formatOps.addConditionalFormat(ydoc, 'Ledger', { range: 'E2:F300', condition: 'lt', threshold: 0, style: { color: RED } });
    formatOps.addConditionalFormat(ydoc, 'Ledger', { range: 'E2:F300', condition: 'gt', threshold: 0, style: { color: GREEN } });

    // ─── Summary sheet ──────────────────────────────────────────────
    sheetOps.createSheet(ydoc, 'Summary', {});
    formatOps.setColumnWidths(ydoc, 'Summary', { A: 220, B: 130 });

    cellOps.setRange(ydoc, 'Summary', 'A1', [['Bosco Ledger — Summary']]);
    cellOps.formatRange(ydoc, 'Summary', 'A1:B1', { bold: true, fontSize: 15, color: NAVY });

    cellOps.setRange(ydoc, 'Summary', 'A3', [['Account Balances', null]]);
    cellOps.formatRange(ydoc, 'Summary', 'A3:B3', { bold: true, backgroundColor: NAVY_LIGHT, color: NAVY });
    cellOps.setRange(ydoc, 'Summary', 'A4', ACCOUNTS.map(a => [
        a, `=TABLE_SUMIFS("Ledger","Amount","Account","=","${a}")`,
    ]));
    cellOps.formatRange(ydoc, 'Summary', `B4:B${3 + ACCOUNTS.length}`, { numberFormat: CURRENCY_FMT });

    const catStart = 6 + ACCOUNTS.length;
    cellOps.setRange(ydoc, 'Summary', `A${catStart}`, [['Spending by Category', null]]);
    cellOps.formatRange(ydoc, 'Summary', `A${catStart}:B${catStart}`, { bold: true, backgroundColor: NAVY_LIGHT, color: NAVY });
    cellOps.setRange(ydoc, 'Summary', `A${catStart + 1}`, CATEGORIES.map(c => [
        c, `=TABLE_SUMIFS("Ledger","Amount","Category","=","${c}")`,
    ]));
    cellOps.formatRange(
        ydoc, 'Summary',
        `B${catStart + 1}:B${catStart + CATEGORIES.length}`,
        { numberFormat: CURRENCY_FMT },
    );

    console.log('Flushing…');
    await client.flush(1500);
    await client.close();
    console.log('Done. File ID:', file.id, 'Ledger table ID:', table.id, 'Ledger sheet ID: Ledger');
}

main().catch(err => { console.error(err); process.exit(1); });
