/**
 * Create "Bosco Ledger" spreadsheet matching Gleason's structure and polish.
 * Run with: SCRIPTORIUM_API_KEY=<jonathan's key> node scripts/create-bosco-ledger-v2.mjs
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
const ACCOUNTS = ['General Fund', 'Petty Cash', 'Grants Fund'];

async function main() {
    const client = new SpreadsheetClient({ apiKey });
    await client.init();

    // Delete old Bosco if it exists
    const oldFile = await client._api.fullSync();
    const boscoOld = oldFile.files.find(f => f.title === 'Bosco Ledger' && !f.deleted);
    if (boscoOld) {
        console.log('Deleting old Bosco document…');
        await client._api.deleteFile(boscoOld.id);
    }

    console.log('Creating Bosco Ledger file…');
    const file = await client._api.createFile({ title: 'Bosco Ledger', type: 'yjs', scope: 'drive' });
    console.log('Created file', file.id);
    await client.init();
    const ydoc = await client.openDoc(file.id);

    initializeDocument(ydoc, { creator: 'jonathan', description: 'Bosco trade school — teacher expense ledger' });
    sheetOps.renameSheet(ydoc, 'sheet-1', 'Ledger');

    // ─── Ledger table (columns C onwards) ────────────────────────────────────
    const table = tableOps.createTable(ydoc, {
        name: 'Ledger', sheet: 'Ledger', startRow: 0, startCol: 2,
        columns: [
            { name: 'RB', type: 'number', isNonEntry: true, defaultFormula: "RUNNINGIF(Amount,Account,'=',{Account})", hAlign: 'left' },
            { name: 'Account', type: 'dropdown', typeConfig: { source: 'list', options: ACCOUNTS, allowCustom: false } },
            { name: 'Date', type: 'date' },
            { name: 'Payee', type: 'text' },
            { name: 'Notes', type: 'text' },
            { name: 'Category', type: 'dropdown', typeConfig: { source: 'list', options: CATEGORIES, allowCustom: true } },
            { name: 'Amount', type: 'number' },
            { name: 'Image', type: 'file' },
            { name: 'Mobile', type: 'checkbox' },
            { name: 'Reconciled', type: 'checkbox' },
        ],
    });
    console.log('Ledger table:', table.id);

    // ─── Ledger sheet layout and formatting ──────────────────────────────────
    // Summary columns A-B
    formatOps.setColumnWidths(ydoc, 'Ledger', {
        A: 180, B: 130,
        C: 100, D: 150, E: 110, F: 170, G: 260, H: 120, I: 110, J: 90, K: 90, L: 95,
    });
    formatOps.setRowHeights(ydoc, 'Ledger', { 1: 32 });
    formatOps.setFrozenPanes(ydoc, 'Ledger', { rows: 1, columns: 2 });

    // Header row (A1:L1)
    cellOps.setRange(ydoc, 'Ledger', 'A1', [[
        'Account', 'Balance',
        'RB', 'Account', 'Date', 'Payee', 'Notes', 'Category', 'Amount', 'Image', 'Mobile', 'Reconciled',
    ]]);
    cellOps.formatRange(ydoc, 'Ledger', 'A1:L1', {
        bold: true, backgroundColor: NAVY, color: WHITE, horizontalAlign: 'center', verticalAlign: 'middle',
    });
    formatOps.setBorders(ydoc, 'Ledger', 'A1:L1', { bottom: { style: 'solid', width: 2, color: NAVY } });
    formatOps.setBorders(ydoc, 'Ledger', 'A1:L300', { outline: { style: 'solid', width: 1, color: '#cbd5e1' } });

    // Account summary rows (A2:B11)
    cellOps.setRange(ydoc, 'Ledger', 'A2', ACCOUNTS.map(a => [a, `=SUMIF(D:D,"${a}",H:H)`]));
    cellOps.formatRange(ydoc, 'Ledger', `A2:A${1 + ACCOUNTS.length}`, { bold: true, backgroundColor: NAVY_LIGHT });
    cellOps.formatRange(ydoc, 'Ledger', `B2:B${1 + ACCOUNTS.length}`, { numberFormat: CURRENCY_FMT, horizontalAlign: 'right' });

    // Ledger entry formatting
    cellOps.formatRange(ydoc, 'Ledger', 'E2:E300', { numberFormat: DATE_FMT });
    cellOps.formatRange(ydoc, 'Ledger', 'H2:H300', { numberFormat: CURRENCY_FMT, horizontalAlign: 'right' });
    cellOps.formatRange(ydoc, 'Ledger', 'C2:C300', { numberFormat: CURRENCY_FMT, horizontalAlign: 'right' });

    // Conditional formatting for amounts (red/green for negative/positive)
    formatOps.addConditionalFormat(ydoc, 'Ledger', { range: 'H2:H300', condition: 'lt', threshold: 0, style: { color: RED } });
    formatOps.addConditionalFormat(ydoc, 'Ledger', { range: 'H2:H300', condition: 'gt', threshold: 0, style: { color: GREEN } });
    formatOps.addConditionalFormat(ydoc, 'Ledger', { range: 'C2:C300', condition: 'lt', threshold: 0, style: { color: RED } });

    // ─── Summary sheet ──────────────────────────────────────────────────────────
    sheetOps.createSheet(ydoc, 'Summary', {});
    formatOps.setColumnWidths(ydoc, 'Summary', { A: 250, B: 140 });

    cellOps.setCell(ydoc, 'Summary', 'A1', 'Bosco Ledger — Summary');
    cellOps.formatRange(ydoc, 'Summary', 'A1', { bold: true, fontSize: 16, color: NAVY });

    cellOps.setCell(ydoc, 'Summary', 'A3', 'Account Balances');
    cellOps.formatRange(ydoc, 'Summary', 'A3:B3', { bold: true, backgroundColor: NAVY_LIGHT, color: NAVY });
    cellOps.setRange(ydoc, 'Summary', 'A4', ACCOUNTS.map(a => [a, `=TABLE_SUMIFS("Ledger","Amount","Account","=","${a}")`]));
    cellOps.formatRange(ydoc, 'Summary', `B4:B${3 + ACCOUNTS.length}`, { numberFormat: CURRENCY_FMT });

    const catStart = 6 + ACCOUNTS.length;
    cellOps.setCell(ydoc, 'Summary', `A${catStart}`, 'Spending by Category');
    cellOps.formatRange(ydoc, 'Summary', `A${catStart}:B${catStart}`, { bold: true, backgroundColor: NAVY_LIGHT, color: NAVY });
    cellOps.setRange(ydoc, 'Summary', `A${catStart + 1}`, CATEGORIES.map(c => [c, `=TABLE_SUMIFS("Ledger","Amount","Category","=","${c}")`]));
    cellOps.formatRange(ydoc, 'Summary', `B${catStart + 1}:B${catStart + CATEGORIES.length}`, { numberFormat: CURRENCY_FMT });

    console.log('Flushing…');
    await client.flush(1500);
    await client.close();
    console.log('✓ Bosco Ledger created');
    console.log('  File ID:', file.id);
    console.log('  Ledger table ID:', table.id);
    console.log('  Sheet: Ledger');
}

main().catch(err => { console.error(err); process.exit(1); });
