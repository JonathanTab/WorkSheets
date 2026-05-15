/**
 * Spreadsheet diff interpreter.
 * Reads generic server diff entries (path + counts) and produces a summary.
 *
 * Only cells and tables are surfaced in the badge/summary.
 * Structural sub-maps (rows, cols, formatting, frozen, etc.) are intentionally
 * excluded — they generate too much noise for single-cell edits and are handled
 * properly by the full-screen viewer which uses computeSpreadsheetDiff directly.
 */

import { registerDiffInterpreter } from '../diffInterpreters.js';

// Sub-map keys that hold actual content worth reporting
const CELL_KEY  = 'cells';
const TABLE_KEY = 'tables';
// All other sheet sub-map keys (rows, cols, formatting, frozen, merges, etc.)
// are structural — we skip them in the summary.

registerDiffInterpreter('sheets', (diff) => {
    const entries = diff.entries ?? [];

    let cellsAdded = 0, cellsRemoved = 0, cellsModified = 0;
    let tablesAdded = 0, tablesRemoved = 0, tablesModified = 0;
    let sheetsAdded = 0, sheetsRemoved = 0;
    const affectedSheetIds = new Set();

    for (const e of entries) {
        const { path } = e;
        if (!path?.length) continue;
        if (path[0] !== 'spreadsheet') continue;

        // Sheet additions / removals: ['spreadsheet', 'sheets']
        if (path[1] === 'sheets' && path.length === 2) {
            sheetsAdded   += e.added   ?? 0;
            sheetsRemoved += e.removed ?? 0;
        }

        // Per-sheet cell/table content: ['spreadsheet', 'sheets', sheetId, 'cells'|'tables']
        if (path[1] === 'sheets' && path.length === 4) {
            const subKey = path[3];
            const a = e.added ?? 0, r = e.removed ?? 0, m = e.modified ?? 0;
            const total = a + r + m + Math.abs(e.delta ?? 0);

            if (subKey === CELL_KEY) {
                if (total > 0) affectedSheetIds.add(path[2]);
                cellsAdded    += a;
                cellsRemoved  += r;
                cellsModified += m;
            } else if (subKey === TABLE_KEY) {
                if (total > 0) affectedSheetIds.add(path[2]);
                tablesAdded    += a;
                tablesRemoved  += r;
                tablesModified += m;
            }
            // All other sub-keys (rows, cols, formatting, frozen, merges…) are skipped.
            // They appear as side-effects of cell edits but don't represent distinct
            // user-visible changes in the summary.
        }
    }

    const parts = [];

    const totalCells = cellsAdded + cellsRemoved + cellsModified;
    if (totalCells > 0) {
        const detail = [
            cellsModified > 0 && `${cellsModified} changed`,
            cellsAdded    > 0 && `${cellsAdded} added`,
            cellsRemoved  > 0 && `${cellsRemoved} removed`,
        ].filter(Boolean).join(', ');
        parts.push(`${totalCells} cell${totalCells !== 1 ? 's' : ''} (${detail})`);
    }

    const totalTables = tablesAdded + tablesRemoved + tablesModified;
    if (totalTables > 0) {
        const detail = [
            tablesAdded    > 0 && `${tablesAdded} added`,
            tablesRemoved  > 0 && `${tablesRemoved} removed`,
            tablesModified > 0 && `${tablesModified} modified`,
        ].filter(Boolean).join(', ');
        parts.push(`${totalTables} table${totalTables !== 1 ? 's' : ''} (${detail})`);
    }

    if (sheetsAdded   > 0) parts.push(`${sheetsAdded} sheet${sheetsAdded !== 1 ? 's' : ''} added`);
    if (sheetsRemoved > 0) parts.push(`${sheetsRemoved} sheet${sheetsRemoved !== 1 ? 's' : ''} removed`);

    const sheetCount = affectedSheetIds.size;
    const prefix  = sheetCount > 1 ? `${sheetCount} sheets: ` : '';
    const summary = parts.length ? prefix + parts.join(', ') : 'No changes';
    const changeCount = totalCells + totalTables + sheetsAdded + sheetsRemoved;

    return { summary, changeCount };
});
