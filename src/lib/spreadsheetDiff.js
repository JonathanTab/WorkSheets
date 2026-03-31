import * as Y from 'yjs';

/**
 * Convert a 0-based column index to a spreadsheet column letter (0=A, 25=Z, 26=AA, …).
 * @param {number} col
 * @returns {string}
 */
function colToLetter(col) {
    let s = '';
    let n = col + 1;
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/**
 * Convert 0-based row/col to A1 notation.
 * @param {number} row
 * @param {number} col
 * @returns {string}
 */
function toA1(row, col) {
    return `${colToLetter(col)}${row + 1}`;
}

/**
 * Parse a cell key of the form "row,col" into { row, col }.
 * @param {string} key
 * @returns {{ row: number, col: number }|null}
 */
function parseCellKey(key) {
    const parts = key.split(',');
    if (parts.length !== 2) return null;
    const row = parseInt(parts[0], 10);
    const col = parseInt(parts[1], 10);
    if (isNaN(row) || isNaN(col)) return null;
    return { row, col };
}

/**
 * Format a raw cell value for display.
 * @param {*} v
 * @returns {string}
 */
function formatVal(v) {
    if (v === undefined || v === null || v === '') return '(empty)';
    if (typeof v === 'string' && v.length > 60) return v.slice(0, 57) + '…';
    return String(v);
}

/**
 * Compute a rich cell-level diff between a snapshot Y.Doc and the live Y.Doc.
 *
 * Returns an array of sheet diffs, each with a list of changed cells in A1 notation.
 * Limits to MAX_CELLS_PER_SHEET changed cells per sheet to keep the UI manageable.
 *
 * @param {Y.Doc} snapDoc
 * @param {Y.Doc} liveDoc
 * @param {{ maxCellsPerSheet?: number }} [opts]
 * @returns {{ sheets: Array<SheetDiff> } | null}
 *
 * @typedef {{ ref: string, from: string, to: string, status: 'changed'|'added'|'removed' }} CellDiff
 * @typedef {{ name: string, cells: CellDiff[], totalChanged: number, totalAdded: number, totalRemoved: number, isNew: boolean, isDeleted: boolean }} SheetDiff
 */
export function computeSpreadsheetDiff(snapDoc, liveDoc, { maxCellsPerSheet = 40 } = {}) {
    try {
        const snapRoot = snapDoc.getMap('spreadsheet');
        const liveRoot = liveDoc.getMap('spreadsheet');
        const snapSheets = snapRoot.get('sheets');
        const liveSheets = liveRoot.get('sheets');
        if (!snapSheets || !liveSheets) return null;

        // Respect sheet order from the live doc where possible
        const liveOrderArr = liveRoot.get('sheetOrder');
        const orderedIds = liveOrderArr
            ? [...liveOrderArr.toArray()]
            : [...liveSheets.keys()];

        // Also include sheets that exist only in the snap (deleted)
        const allIds = new Set([...orderedIds, ...snapSheets.keys()]);

        const sheets = [];

        for (const sheetId of allIds) {
            const liveSheet = liveSheets.get(sheetId);
            const snapSheet = snapSheets.get(sheetId);

            if (!liveSheet && !snapSheet) continue;

            // Sheet added in live (not in snap)
            if (!snapSheet) {
                const liveName = liveSheet.get?.('name') ?? sheetId;
                sheets.push({ name: liveName, cells: [], totalChanged: 0, totalAdded: 0, totalRemoved: 0, isNew: true, isDeleted: false });
                continue;
            }

            // Sheet deleted from live (was in snap)
            if (!liveSheet) {
                const snapName = snapSheet.get?.('name') ?? sheetId;
                sheets.push({ name: snapName, cells: [], totalChanged: 0, totalAdded: 0, totalRemoved: 0, isNew: false, isDeleted: true });
                continue;
            }

            const sheetName = liveSheet.get?.('name') ?? snapSheet.get?.('name') ?? sheetId;
            const liveCells = liveSheet.get?.('cells');
            const snapCells = snapSheet.get?.('cells');

            if (!liveCells && !snapCells) continue;

            const cells = [];
            let totalChanged = 0, totalAdded = 0, totalRemoved = 0;

            // Cells in snap — check if changed or removed in live
            if (snapCells) {
                for (const [key, snapCell] of snapCells) {
                    const sv = snapCell.get?.('v');
                    const liveCell = liveCells?.get?.(key);

                    if (!liveCell) {
                        totalRemoved++;
                        if (cells.length < maxCellsPerSheet) {
                            const pos = parseCellKey(key);
                            cells.push({ ref: pos ? toA1(pos.row, pos.col) : key, from: formatVal(sv), to: '(deleted)', status: 'removed' });
                        }
                    } else {
                        const lv = liveCell.get?.('v');
                        if (sv !== lv) {
                            totalChanged++;
                            if (cells.length < maxCellsPerSheet) {
                                const pos = parseCellKey(key);
                                cells.push({ ref: pos ? toA1(pos.row, pos.col) : key, from: formatVal(sv), to: formatVal(lv), status: 'changed' });
                            }
                        }
                    }
                }
            }

            // Cells in live that didn't exist in snap
            if (liveCells) {
                for (const [key, liveCell] of liveCells) {
                    if (!snapCells?.get?.(key)) {
                        totalAdded++;
                        if (cells.length < maxCellsPerSheet) {
                            const pos = parseCellKey(key);
                            const lv = liveCell.get?.('v');
                            cells.push({ ref: pos ? toA1(pos.row, pos.col) : key, from: '(empty)', to: formatVal(lv), status: 'added' });
                        }
                    }
                }
            }

            // Sort cells by row then col for readability
            cells.sort((a, b) => {
                const pa = a.ref.match(/^([A-Z]+)(\d+)$/);
                const pb = b.ref.match(/^([A-Z]+)(\d+)$/);
                if (pa && pb) {
                    const rowDiff = parseInt(pa[2]) - parseInt(pb[2]);
                    if (rowDiff !== 0) return rowDiff;
                    return pa[1].localeCompare(pb[1]);
                }
                return a.ref.localeCompare(b.ref);
            });

            if (totalChanged + totalAdded + totalRemoved > 0) {
                sheets.push({ name: sheetName, cells, totalChanged, totalAdded, totalRemoved, isNew: false, isDeleted: false });
            }
        }

        return { sheets };
    } catch {
        return null;
    }
}
