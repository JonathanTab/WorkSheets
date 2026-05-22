#!/usr/bin/env node
/**
 * migrate-table-keys.js
 *
 * One-time migration for test documents created before the table key rename:
 *   root.tables         → root.tableData
 *   sheet.tables        → sheet.tableViews
 *   view.sourceTableId  → view.tableId
 *   source.isSourceOnly  (removed)
 *
 * Run once while the yjs-server is running:
 *   SCRIPTORIUM_API_KEY=<key> node src/cli/migrate-table-keys.js
 */

import { SpreadsheetClient } from './SpreadsheetClient.js';

const apiKey = process.env.SCRIPTORIUM_API_KEY;
if (!apiKey) { console.error('SCRIPTORIUM_API_KEY not set'); process.exit(1); }

const client = new SpreadsheetClient({ apiKey });
await client.init();

const files = client.listFiles();
console.log(`Found ${files.length} spreadsheet document(s)`);

let migrated = 0;
for (const file of files) {
    const ydoc = await client.openDoc(file.id);
    const root = ydoc.getMap('spreadsheet');

    let dirty = false;

    ydoc.transact(() => {
        // 1. root.tables → root.tableData
        const oldTableData = root.get('tables');
        if (oldTableData && !root.has('tableData')) {
            root.set('tableData', oldTableData);
            root.delete('tables');
            dirty = true;
            // Remove isSourceOnly flag from source table entries
            oldTableData.forEach((tbl) => {
                if (tbl?.delete && tbl.has?.('isSourceOnly')) {
                    tbl.delete('isSourceOnly');
                }
            });
        }

        // 2. Per-sheet: sheet.tables → sheet.tableViews + sourceTableId → tableId
        const sheets = root.get('sheets');
        sheets?.forEach((sheet, sheetId) => {
            const oldViews = sheet.get('tables');
            if (oldViews && !sheet.has('tableViews')) {
                sheet.set('tableViews', oldViews);
                sheet.delete('tables');
                dirty = true;
                // Rename sourceTableId → tableId in each view entry
                oldViews.forEach((entry) => {
                    const srcId = entry?.get?.('sourceTableId');
                    if (srcId !== undefined && !entry.has('tableId')) {
                        entry.set('tableId', srcId);
                        entry.delete('sourceTableId');
                    }
                    if (entry?.has?.('isSourceOnly')) entry.delete('isSourceOnly');
                });
            }
        });
    });

    if (dirty) {
        console.log(`  ✓ migrated: ${file.title}`);
        migrated++;
    } else {
        console.log(`  — already current: ${file.title}`);
    }
}

await client.flush(2000);
await client.close();
console.log(`\nDone. ${migrated} document(s) migrated.`);
