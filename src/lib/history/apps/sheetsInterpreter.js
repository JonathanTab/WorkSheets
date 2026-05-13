/**
 * Spreadsheet diff interpreter.
 * Reads generic server diff entries (path + counts) and produces a summary.
 *
 * Spreadsheet Y.Doc structure:
 *   doc.getMap('spreadsheet')             root Y.Map
 *     .get('sheets')                      Y.Map of sheets, keyed by sheet ID
 *       .get(sheetId)                     sheet Y.Map
 *         .get('cells')                   Y.Map of cells
 *         .get('tables')                  Y.Map of tables
 *         .get('name')                    string (sheet display name)
 *
 * Expected diff entries at depth=4:
 *   { path: ['spreadsheet', 'sheets', '{id}', 'cells'],    type:'map', added, removed, modified }
 *   { path: ['spreadsheet', 'sheets', '{id}', 'tables'],   type:'map', added, removed, modified }
 *   { path: ['spreadsheet', 'sheets', '{id}', 'rows'],     type:'map', ... }
 *   { path: ['spreadsheet', 'sheets'],                     type:'map', added, removed, modified }
 */

import { registerDiffInterpreter } from '../diffInterpreters.js';

registerDiffInterpreter('sheets', (diff) => {
    const entries = diff.entries ?? [];

    let cellsAdded = 0, cellsRemoved = 0, cellsModified = 0;
    let tablesAdded = 0, tablesRemoved = 0, tablesModified = 0;
    let sheetsAdded = 0, sheetsRemoved = 0;
    let otherChanges = 0;
    const affectedSheetIds = new Set();

    for (const e of entries) {
        const { path, type } = e;
        if (!path?.length) continue;

        // Top-level sheet additions/removals
        if (path[0] === 'spreadsheet' && path[1] === 'sheets' && path.length === 2) {
            sheetsAdded += e.added ?? 0;
            sheetsRemoved += e.removed ?? 0;
        }

        // Per-sheet sub-map changes: ['spreadsheet','sheets','{id}','{key}']
        if (path[0] === 'spreadsheet' && path[1] === 'sheets' && path.length === 4) {
            const sheetId = path[2];
            const subKey = path[3];
            const a = e.added ?? 0, r = e.removed ?? 0, m = e.modified ?? 0;
            const total = a + r + m + Math.abs(e.delta ?? 0);
            if (total > 0) affectedSheetIds.add(sheetId);

            if (subKey === 'cells') {
                cellsAdded += a;
                cellsRemoved += r;
                cellsModified += m;
            } else if (subKey === 'tables') {
                tablesAdded += a;
                tablesRemoved += r;
                tablesModified += m;
            } else if (subKey !== 'name') {
                otherChanges += total;
            }
        }
    }

    const parts = [];
    const totalCells = cellsAdded + cellsRemoved + cellsModified;
    if (totalCells > 0) {
        const cellParts = [];
        if (cellsModified > 0) cellParts.push(`${cellsModified} changed`);
        if (cellsAdded > 0)    cellParts.push(`${cellsAdded} added`);
        if (cellsRemoved > 0)  cellParts.push(`${cellsRemoved} removed`);
        parts.push(`${totalCells} cell${totalCells !== 1 ? 's' : ''} (${cellParts.join(', ')})`);
    }

    const totalTables = tablesAdded + tablesRemoved + tablesModified;
    if (totalTables > 0) {
        const tp = [];
        if (tablesAdded > 0)    tp.push(`${tablesAdded} added`);
        if (tablesRemoved > 0)  tp.push(`${tablesRemoved} removed`);
        if (tablesModified > 0) tp.push(`${tablesModified} modified`);
        parts.push(`${totalTables} table${totalTables !== 1 ? 's' : ''} (${tp.join(', ')})`);
    }

    if (sheetsAdded > 0)   parts.push(`${sheetsAdded} sheet${sheetsAdded !== 1 ? 's' : ''} added`);
    if (sheetsRemoved > 0) parts.push(`${sheetsRemoved} sheet${sheetsRemoved !== 1 ? 's' : ''} removed`);
    if (otherChanges > 0)  parts.push(`${otherChanges} other change${otherChanges !== 1 ? 's' : ''}`);

    const sheetCount = affectedSheetIds.size;
    const prefix = sheetCount > 1 ? `${sheetCount} sheets: ` : '';
    const summary = parts.length ? prefix + parts.join(', ') : 'No changes';
    const changeCount = totalCells + totalTables + sheetsAdded + sheetsRemoved + otherChanges;

    return { summary, changeCount };
});
