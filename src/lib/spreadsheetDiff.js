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

/** Fields considered "formatting" on a cell Y.Map. */
const FORMAT_FIELDS = [
    'bold', 'italic', 'underline', 'strikethrough',
    'color', 'backgroundColor',
    'fontSize', 'fontFamily',
    'align', 'valign', 'wrap',
    'numberFormat',
];

/**
 * Stable JSON serialization for a Y.Array — converts to plain array then stringifies.
 * Used to compare merges.
 */
function yArrayJson(yArr) {
    if (!yArr) return '[]';
    try { return JSON.stringify(yArr.toArray().map(v => (v && typeof v.toJSON === 'function' ? v.toJSON() : v))); }
    catch { return '[]'; }
}

/**
 * Compare two Y.Map values for a set of scalar keys.
 * Returns an array of { field, from, to } for any that differ.
 */
function diffMapFields(snapMap, liveMap, fields) {
    const changes = [];
    for (const field of fields) {
        const sv = snapMap?.get?.(field);
        const lv = liveMap?.get?.(field);
        if (sv !== lv) changes.push({ field, from: sv ?? null, to: lv ?? null });
    }
    return changes;
}

/**
 * Compute a rich cell-level diff between a snapshot Y.Doc and the live (or previous) Y.Doc.
 *
 * Covers:
 *   - Cell value changes (added, removed, changed)
 *   - Cell formatting changes (bold, color, align, etc.)
 *   - Structural changes per sheet (row/col counts, frozen, row/col sizes, merges, borders)
 *   - Table changes per sheet (added, removed, renamed, column changes)
 *   - Doc-level metadata (sheet renames, sheet order changes)
 *
 * @param {Y.Doc} snapDoc  — the "before" document
 * @param {Y.Doc} liveDoc  — the "after" document
 * @param {{ maxCellsPerSheet?: number }} [opts]
 * @returns {DiffResult | null}
 *
 * @typedef {{ ref: string, from: string, to: string, status: 'changed'|'added'|'removed' }} CellDiff
 * @typedef {{ ref: string, changes: Array<{ field: string, from: any, to: any }> }} FormatCellDiff
 * @typedef {{ field: string, from: string, to: string }} StructureDiff
 * @typedef {{ type: 'added'|'removed'|'renamed'|'columns', name: string, from?: string, to?: string, detail?: string }} TableDiff
 * @typedef {{
 *   name: string, isNew: boolean, isDeleted: boolean, renamed: {from:string,to:string}|null,
 *   totalChanged: number, totalAdded: number, totalRemoved: number, cells: CellDiff[],
 *   formatChanges: number, formatCells: FormatCellDiff[],
 *   structureChanges: StructureDiff[],
 *   tableChanges: TableDiff[],
 * }} SheetDiff
 * @typedef {{ sheets: SheetDiff[], meta: { renamedSheets: Array<{from:string,to:string}>, sheetOrderChanged: boolean } }} DiffResult
 */
export function computeSpreadsheetDiff(snapDoc, liveDoc, { maxCellsPerSheet = 40 } = {}) {
    try {
        const snapRoot = snapDoc.getMap('spreadsheet');
        const liveRoot = liveDoc.getMap('spreadsheet');
        const snapSheets = snapRoot.get('sheets');
        const liveSheets = liveRoot.get('sheets');
        if (!snapSheets || !liveSheets) return null;

        // ── Sheet order ─────────────────────────────────────────────────────────
        const snapOrderArr = snapRoot.get('sheetOrder');
        const liveOrderArr = liveRoot.get('sheetOrder');
        const snapOrder = snapOrderArr ? [...snapOrderArr.toArray()] : [...snapSheets.keys()];
        const liveOrder = liveOrderArr ? [...liveOrderArr.toArray()] : [...liveSheets.keys()];
        const sheetOrderChanged = JSON.stringify(snapOrder) !== JSON.stringify(liveOrder);

        // Iterate in live order, then append snap-only (deleted) sheets
        const allIds = new Set([...liveOrder, ...snapOrder]);

        // ── Sheet renames (doc-level) ────────────────────────────────────────────
        const renamedSheets = [];
        for (const id of allIds) {
            const sSheet = snapSheets.get(id);
            const lSheet = liveSheets.get(id);
            if (sSheet && lSheet) {
                const sName = sSheet.get?.('name') ?? id;
                const lName = lSheet.get?.('name') ?? id;
                if (sName !== lName) renamedSheets.push({ from: sName, to: lName });
            }
        }

        // ── Per-sheet diffs ──────────────────────────────────────────────────────
        const sheets = [];

        for (const sheetId of allIds) {
            const liveSheet = liveSheets.get(sheetId);
            const snapSheet = snapSheets.get(sheetId);

            if (!liveSheet && !snapSheet) continue;

            // New sheet (not in snap)
            if (!snapSheet) {
                const liveName = liveSheet.get?.('name') ?? sheetId;
                sheets.push({
                    name: liveName, isNew: true, isDeleted: false, renamed: null,
                    totalChanged: 0, totalAdded: 0, totalRemoved: 0, cells: [],
                    formatChanges: 0, formatCells: [],
                    structureChanges: [], tableChanges: [],
                });
                continue;
            }

            // Deleted sheet (not in live)
            if (!liveSheet) {
                const snapName = snapSheet.get?.('name') ?? sheetId;
                sheets.push({
                    name: snapName, isNew: false, isDeleted: true, renamed: null,
                    totalChanged: 0, totalAdded: 0, totalRemoved: 0, cells: [],
                    formatChanges: 0, formatCells: [],
                    structureChanges: [], tableChanges: [],
                });
                continue;
            }

            const snapName = snapSheet.get?.('name') ?? sheetId;
            const liveName = liveSheet.get?.('name') ?? sheetId;
            const sheetName = liveName;
            const renamed = snapName !== liveName ? { from: snapName, to: liveName } : null;

            // ── 1. Cell value + formatting diffs ──────────────────────────────
            const liveCells = liveSheet.get?.('cells');
            const snapCells = snapSheet.get?.('cells');

            const valueCells = [];
            let totalChanged = 0, totalAdded = 0, totalRemoved = 0;
            const formatCells = [];
            let formatChanges = 0;

            // Cells that existed in snap
            if (snapCells) {
                for (const [key, snapCell] of snapCells) {
                    const sv = snapCell.get?.('v');
                    const liveCell = liveCells?.get?.(key);

                    if (!liveCell) {
                        // Removed
                        totalRemoved++;
                        if (valueCells.length < maxCellsPerSheet) {
                            const pos = parseCellKey(key);
                            valueCells.push({ ref: pos ? toA1(pos.row, pos.col) : key, from: formatVal(sv), to: '(deleted)', status: 'removed' });
                        }
                    } else {
                        const lv = liveCell.get?.('v');
                        if (sv !== lv) {
                            totalChanged++;
                            if (valueCells.length < maxCellsPerSheet) {
                                const pos = parseCellKey(key);
                                valueCells.push({ ref: pos ? toA1(pos.row, pos.col) : key, from: formatVal(sv), to: formatVal(lv), status: 'changed' });
                            }
                        }
                        // Formatting diff (even if value same)
                        const fmtChanges = diffMapFields(snapCell, liveCell, FORMAT_FIELDS);
                        if (fmtChanges.length > 0) {
                            formatChanges++;
                            if (formatCells.length < maxCellsPerSheet) {
                                const pos = parseCellKey(key);
                                formatCells.push({ ref: pos ? toA1(pos.row, pos.col) : key, changes: fmtChanges });
                            }
                        }
                    }
                }
            }

            // Cells new in live
            if (liveCells) {
                for (const [key, liveCell] of liveCells) {
                    if (!snapCells?.get?.(key)) {
                        totalAdded++;
                        if (valueCells.length < maxCellsPerSheet) {
                            const pos = parseCellKey(key);
                            const lv = liveCell.get?.('v');
                            valueCells.push({ ref: pos ? toA1(pos.row, pos.col) : key, from: '(empty)', to: formatVal(lv), status: 'added' });
                        }
                        // New cells with formatting
                        const fmtChanges = FORMAT_FIELDS
                            .map(f => ({ field: f, from: null, to: liveCell.get?.(f) ?? null }))
                            .filter(c => c.to !== null && c.to !== undefined);
                        if (fmtChanges.length > 0) {
                            formatChanges++;
                            if (formatCells.length < maxCellsPerSheet) {
                                const pos = parseCellKey(key);
                                formatCells.push({ ref: pos ? toA1(pos.row, pos.col) : key, changes: fmtChanges });
                            }
                        }
                    }
                }
            }

            // Sort value cells by row then col
            valueCells.sort((a, b) => {
                const pa = a.ref.match(/^([A-Z]+)(\d+)$/);
                const pb = b.ref.match(/^([A-Z]+)(\d+)$/);
                if (pa && pb) {
                    const rowDiff = parseInt(pa[2]) - parseInt(pb[2]);
                    if (rowDiff !== 0) return rowDiff;
                    return pa[1].localeCompare(pb[1]);
                }
                return a.ref.localeCompare(b.ref);
            });

            // ── 2. Structural diffs ────────────────────────────────────────────
            const structureChanges = [];

            const SCALAR_SHEET_FIELDS = [
                ['rowCount', 'Rows'],
                ['colCount', 'Columns'],
                ['frozenRows', 'Frozen rows'],
                ['frozenCols', 'Frozen columns'],
            ];
            for (const [field, label] of SCALAR_SHEET_FIELDS) {
                const sv = snapSheet.get?.(field);
                const lv = liveSheet.get?.(field);
                if (sv !== lv && (sv !== undefined || lv !== undefined)) {
                    structureChanges.push({ field: label, from: String(sv ?? 0), to: String(lv ?? 0) });
                }
            }

            // Row sizes (rowMeta)
            const snapRowMeta = snapSheet.get?.('rowMeta');
            const liveRowMeta = liveSheet.get?.('rowMeta');
            if (snapRowMeta || liveRowMeta) {
                let rowSizeChanges = 0;
                const allRowKeys = new Set([
                    ...(snapRowMeta ? [...snapRowMeta.keys()] : []),
                    ...(liveRowMeta ? [...liveRowMeta.keys()] : []),
                ]);
                for (const k of allRowKeys) {
                    const sh = snapRowMeta?.get?.(k)?.get?.('height') ?? snapRowMeta?.get?.(k);
                    const lh = liveRowMeta?.get?.(k)?.get?.('height') ?? liveRowMeta?.get?.(k);
                    if (sh !== lh) rowSizeChanges++;
                }
                if (rowSizeChanges > 0) {
                    structureChanges.push({ field: 'Row heights', from: '', to: `${rowSizeChanges} row${rowSizeChanges !== 1 ? 's' : ''} resized` });
                }
            }

            // Column sizes (colMeta)
            const snapColMeta = snapSheet.get?.('colMeta');
            const liveColMeta = liveSheet.get?.('colMeta');
            if (snapColMeta || liveColMeta) {
                let colSizeChanges = 0;
                const allColKeys = new Set([
                    ...(snapColMeta ? [...snapColMeta.keys()] : []),
                    ...(liveColMeta ? [...liveColMeta.keys()] : []),
                ]);
                for (const k of allColKeys) {
                    const sw = snapColMeta?.get?.(k)?.get?.('width') ?? snapColMeta?.get?.(k);
                    const lw = liveColMeta?.get?.(k)?.get?.('width') ?? liveColMeta?.get?.(k);
                    if (sw !== lw) colSizeChanges++;
                }
                if (colSizeChanges > 0) {
                    structureChanges.push({ field: 'Column widths', from: '', to: `${colSizeChanges} column${colSizeChanges !== 1 ? 's' : ''} resized` });
                }
            }

            // Merges (Y.Array — compare serialized)
            const snapMerges = snapSheet.get?.('merges');
            const liveMerges = liveSheet.get?.('merges');
            if (snapMerges || liveMerges) {
                const sj = yArrayJson(snapMerges);
                const lj = yArrayJson(liveMerges);
                if (sj !== lj) {
                    const sc = snapMerges?.length ?? 0;
                    const lc = liveMerges?.length ?? 0;
                    const delta = lc - sc;
                    const label = delta > 0 ? `+${delta} added` : delta < 0 ? `${delta} removed` : 'changed';
                    structureChanges.push({ field: 'Merges', from: String(sc), to: `${lc} (${label})` });
                }
            }

            // Borders (Y.Map — count changed keys)
            const snapBorders = snapSheet.get?.('borders');
            const liveBorders = liveSheet.get?.('borders');
            if (snapBorders || liveBorders) {
                const allBorderKeys = new Set([
                    ...(snapBorders ? [...snapBorders.keys()] : []),
                    ...(liveBorders ? [...liveBorders.keys()] : []),
                ]);
                let borderChanges = 0;
                for (const k of allBorderKeys) {
                    const sv = JSON.stringify(snapBorders?.get?.(k) ?? null);
                    const lv = JSON.stringify(liveBorders?.get?.(k) ?? null);
                    if (sv !== lv) borderChanges++;
                }
                if (borderChanges > 0) {
                    structureChanges.push({ field: 'Borders', from: '', to: `${borderChanges} cell${borderChanges !== 1 ? 's' : ''} changed` });
                }
            }

            // ── 3. Table diffs ─────────────────────────────────────────────────
            const tableChanges = [];
            const snapTables = snapSheet.get?.('tables');
            const liveTables = liveSheet.get?.('tables');

            if (snapTables || liveTables) {
                const allTableIds = new Set([
                    ...(snapTables ? [...snapTables.keys()] : []),
                    ...(liveTables ? [...liveTables.keys()] : []),
                ]);
                for (const tid of allTableIds) {
                    const sTable = snapTables?.get?.(tid);
                    const lTable = liveTables?.get?.(tid);

                    if (!sTable && lTable) {
                        tableChanges.push({ type: 'added', name: lTable.get?.('name') ?? tid });
                    } else if (sTable && !lTable) {
                        tableChanges.push({ type: 'removed', name: sTable.get?.('name') ?? tid });
                    } else if (sTable && lTable) {
                        const sName = sTable.get?.('name') ?? tid;
                        const lName = lTable.get?.('name') ?? tid;
                        if (sName !== lName) {
                            tableChanges.push({ type: 'renamed', name: lName, from: sName, to: lName });
                        }
                        // Column changes — compare column names/count
                        const sCols = _getTableColNames(sTable);
                        const lCols = _getTableColNames(lTable);
                        if (JSON.stringify(sCols) !== JSON.stringify(lCols)) {
                            const delta = lCols.length - sCols.length;
                            const detail = delta > 0
                                ? `+${delta} column${delta !== 1 ? 's' : ''}`
                                : delta < 0
                                    ? `${delta} column${Math.abs(delta) !== 1 ? 's' : ''}`
                                    : 'columns reordered/renamed';
                            tableChanges.push({ type: 'columns', name: lName, detail });
                        }

                        // Row data changes — compare rows Y.Array
                        const rowDiff = _diffTableRows(sTable, lTable, lName);
                        if (rowDiff) tableChanges.push(rowDiff);
                    }
                }
            }

            // ── Emit sheet if anything changed ─────────────────────────────────
            const hasChanges = totalChanged + totalAdded + totalRemoved > 0
                || formatChanges > 0
                || structureChanges.length > 0
                || tableChanges.length > 0
                || renamed !== null;

            if (hasChanges) {
                sheets.push({
                    name: sheetName,
                    isNew: false,
                    isDeleted: false,
                    renamed,
                    totalChanged,
                    totalAdded,
                    totalRemoved,
                    cells: valueCells,
                    formatChanges,
                    formatCells,
                    structureChanges,
                    tableChanges,
                });
            }
        }

        return {
            sheets,
            meta: { renamedSheets, sheetOrderChanged },
        };
    } catch {
        return null;
    }
}

/**
 * Get an ordered list of column names from a table Y.Map.
 * @param {Y.Map} tableMap
 * @returns {string[]}
 */
function _getTableColNames(tableMap) {
    try {
        const colOrder = tableMap.get('colOrder');
        const cols = tableMap.get('cols') ?? tableMap.get('columns');
        if (colOrder && cols) {
            return colOrder.toArray().map(id => cols.get?.(id)?.get?.('name') ?? id);
        }
        if (cols) {
            const names = [];
            cols.forEach((c, id) => names.push(c.get?.('name') ?? id));
            return names;
        }
        return [];
    } catch {
        return [];
    }
}

/**
 * Diff row data between two versions of a table Y.Map.
 * Rows are stored in a Y.Array (no stable IDs), so we diff by:
 *   - count delta (rows added/removed)
 *   - value comparison at matching indices (cells mutated)
 * Returns a TableDiff entry of type 'rows', or null if no row changes.
 * @param {Y.Map} snapTable
 * @param {Y.Map} liveTable
 * @param {string} tableName
 * @returns {TableDiff|null}
 */
function _diffTableRows(snapTable, liveTable, tableName) {
    try {
        const sArr = snapTable.get('rows');
        const lArr = liveTable.get('rows');
        if (!sArr && !lArr) return null;

        const snapRows = sArr ? sArr.toArray() : [];
        const liveRows = lArr ? lArr.toArray() : [];
        const sLen = snapRows.length;
        const lLen = liveRows.length;

        const added   = Math.max(0, lLen - sLen);
        const removed = Math.max(0, sLen - lLen);

        // Count mutated rows among the rows that exist in both
        let mutated = 0;
        const minLen = Math.min(sLen, lLen);
        for (let i = 0; i < minLen; i++) {
            const sr = snapRows[i];
            const lr = liveRows[i];
            const sj = JSON.stringify(sr && typeof sr.toJSON === 'function' ? sr.toJSON() : sr);
            const lj = JSON.stringify(lr && typeof lr.toJSON === 'function' ? lr.toJSON() : lr);
            if (sj !== lj) mutated++;
        }

        if (added === 0 && removed === 0 && mutated === 0) return null;

        const parts = [];
        if (added > 0)   parts.push(`+${added} row${added !== 1 ? 's' : ''}`);
        if (removed > 0) parts.push(`−${removed} row${removed !== 1 ? 's' : ''}`);
        if (mutated > 0) parts.push(`${mutated} row${mutated !== 1 ? 's' : ''} edited`);

        return { type: 'rows', name: tableName, detail: parts.join(', ') };
    } catch {
        return null;
    }
}

/**
 * Compute the total number of changes across all categories in a DiffResult.
 * Useful for computing a summary badge count.
 * @param {DiffResult} result
 * @returns {number}
 */
export function diffTotalCount(result) {
    if (!result?.sheets) return 0;
    let n = 0;
    for (const sh of result.sheets) {
        if (sh.isNew || sh.isDeleted) { n++; continue; }
        n += sh.totalChanged + sh.totalAdded + sh.totalRemoved;
        n += sh.formatChanges;
        n += sh.structureChanges?.length ?? 0;
        n += sh.tableChanges?.length ?? 0;
        if (sh.renamed) n++;
    }
    if (result.meta?.renamedSheets?.length) n += result.meta.renamedSheets.length;
    if (result.meta?.sheetOrderChanged) n++;
    return n;
}
