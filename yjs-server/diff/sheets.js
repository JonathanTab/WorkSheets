import * as Y from 'yjs';

/**
 * Schema-aware diff for spreadsheet (sheets) Yjs documents.
 *
 * Reads the v4 schema: cellValues + cellStyles as YKeyValue-backed Y.Arrays,
 * rowMeta / colMeta, borders, merges, tables, and sheetOrder.
 *
 * Output shape (v: 2):
 * {
 *   v: 2, appType: 'sheets', isInitial?: true,
 *   totals: { cells, formatting, structure, tables, sheetsAdded, sheetsRemoved },
 *   sheetsRenamed: [{ id, from, to }],
 *   sheetOrder: { from, to } | null,
 *   sheets: [{
 *     id, name, isNew, isDeleted, renamed: { from, to } | null,
 *     cells: [{ ref, row, col, status, from: {v,t,ct}, to: {v,t,ct} }],
 *     cellsTruncated: n,
 *     formatCells: [{ ref, row, col, changes: [{field, from, to}] }],
 *     structure: [{ field, from, to }],
 *     tables: [{ id, type, name, from?, to?, detail? }],
 *   }]
 * }
 */

const MAX_CELLS_PER_SHEET = 2000;

const FORMAT_FIELDS = [
    'bold', 'italic', 'underline', 'strikethrough',
    'color', 'backgroundColor',
    'fontSize', 'fontFamily',
    'align', 'valign', 'wrap',
    'numberFormat',
];
export { FORMAT_FIELDS };

// ─── YKeyValue reader ────────────────────────────────────────────────────────
// Y.Array backing for YKeyValue stores items as Y.Map({ key, val }) OR as
// plain objects. We replicate the y-utility/y-keyvalue read logic here to
// avoid a Node-side dependency on the browser library.

/**
 * Read a YKeyValue Y.Array into a plain Map<key, value>.
 * Each element in the array is a Y.Map with 'key' and 'val' entries.
 * Later duplicates overwrite earlier ones (matching YKeyValue semantics).
 * @param {Y.Array|null|undefined} arr
 * @returns {Map<string, any>}
 */
function readYKeyValue(arr) {
    const map = new Map();
    if (!arr || !(arr instanceof Y.Array)) return map;
    arr.forEach(item => {
        if (item instanceof Y.Map) {
            const k = item.get('key');
            const v = item.get('val');
            if (k !== undefined) map.set(k, v);
        }
    });
    return map;
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────

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

function toA1(row, col) { return `${colToLetter(col)}${row + 1}`; }

function parseCellKey(key) {
    const parts = key.split(',');
    if (parts.length !== 2) return null;
    const row = parseInt(parts[0], 10);
    const col = parseInt(parts[1], 10);
    if (isNaN(row) || isNaN(col)) return null;
    return { row, col };
}

// ─── Table helpers ────────────────────────────────────────────────────────────

function getTableColNames(tableMap) {
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
    } catch { return []; }
}

function yArrayJson(yArr) {
    if (!yArr) return '[]';
    try { return JSON.stringify(yArr.toArray().map(v => (v && typeof v.toJSON === 'function' ? v.toJSON() : v))); }
    catch { return '[]'; }
}

// ─── Main diff function ───────────────────────────────────────────────────────

/**
 * Compute a rich, schema-aware diff between two spreadsheet Y.Docs.
 * @param {Y.Doc} prevDoc
 * @param {Y.Doc} newDoc
 * @returns {object} diff JSON (v2)
 */
export function computeSheetsDiff(prevDoc, newDoc) {
    try {
        const prevRoot = prevDoc.getMap('spreadsheet');
        const newRoot  = newDoc.getMap('spreadsheet');

        const prevSheets = prevRoot.get('sheets');
        const newSheets  = newRoot.get('sheets');

        // Handle initial snapshot (prevDoc is empty)
        const isInitial = !prevSheets || prevSheets.size === 0;

        const totals = { cells: 0, formatting: 0, structure: 0, tables: 0, sheetsAdded: 0, sheetsRemoved: 0 };

        // ── Sheet order ────────────────────────────────────────────────────────
        const prevOrderArr = prevRoot.get('sheetOrder');
        const newOrderArr  = newRoot.get('sheetOrder');
        const prevOrder = prevOrderArr ? [...prevOrderArr.toArray()] : (prevSheets ? [...prevSheets.keys()] : []);
        const newOrder  = newOrderArr  ? [...newOrderArr.toArray()]  : (newSheets  ? [...newSheets.keys()]  : []);
        const sheetOrderChanged = JSON.stringify(prevOrder) !== JSON.stringify(newOrder);
        const sheetOrder = sheetOrderChanged ? { from: prevOrder, to: newOrder } : null;

        // ── Sheet renames ──────────────────────────────────────────────────────
        const allSheetIds = new Set([...newOrder, ...prevOrder]);
        const sheetsRenamed = [];
        for (const id of allSheetIds) {
            const p = prevSheets?.get(id);
            const n = newSheets?.get(id);
            if (p && n) {
                const pName = p.get?.('name') ?? id;
                const nName = n.get?.('name') ?? id;
                if (pName !== nName) sheetsRenamed.push({ id, from: pName, to: nName });
            }
        }

        // ── Per-sheet diffs ────────────────────────────────────────────────────
        const sheetDiffs = [];

        for (const sheetId of allSheetIds) {
            const prevSheet = prevSheets?.get(sheetId) ?? null;
            const newSheet  = newSheets?.get(sheetId)  ?? null;

            if (!prevSheet && !newSheet) continue;

            if (!prevSheet) {
                // New sheet
                const name = newSheet.get?.('name') ?? sheetId;
                sheetDiffs.push({ id: sheetId, name, isNew: true, isDeleted: false, renamed: null, cells: [], cellsTruncated: 0, formatCells: [], structure: [], tables: [] });
                totals.sheetsAdded++;
                continue;
            }
            if (!newSheet) {
                // Deleted sheet
                const name = prevSheet.get?.('name') ?? sheetId;
                sheetDiffs.push({ id: sheetId, name, isNew: false, isDeleted: true, renamed: null, cells: [], cellsTruncated: 0, formatCells: [], structure: [], tables: [] });
                totals.sheetsRemoved++;
                continue;
            }

            const prevName = prevSheet.get?.('name') ?? sheetId;
            const newName  = newSheet.get?.('name')  ?? sheetId;
            const renamed  = prevName !== newName ? { from: prevName, to: newName } : null;

            // ── 1. Cell values (cellValues Y.Array / YKeyValue) ──────────────
            const prevValMap = readYKeyValue(prevSheet.get('cellValues'));
            const newValMap  = readYKeyValue(newSheet.get('cellValues'));

            const cells = [];
            let cellsTruncated = 0;

            const allCellKeys = new Set([...prevValMap.keys(), ...newValMap.keys()]);
            for (const key of allCellKeys) {
                const pos = parseCellKey(key);
                if (!pos) continue;

                const pVal = prevValMap.get(key);
                const nVal = newValMap.get(key);
                const pV   = pVal?.v ?? pVal;
                const nV   = nVal?.v ?? nVal;
                const pT   = pVal?.t ?? null;
                const nT   = nVal?.t ?? null;

                if (pV === nV && pT === nT) continue; // unchanged

                let status;
                if (!prevValMap.has(key))     status = 'added';
                else if (!newValMap.has(key)) status = 'removed';
                else                          status = 'changed';

                // Combine with style type ct for display
                const prevStyleMap = readYKeyValue(prevSheet.get('cellStyles'));
                const newStyleMap  = readYKeyValue(newSheet.get('cellStyles'));
                const pCt = prevStyleMap.get(key)?.ct ?? null;
                const nCt = newStyleMap.get(key)?.ct  ?? null;

                if (cells.length < MAX_CELLS_PER_SHEET) {
                    cells.push({
                        ref: toA1(pos.row, pos.col),
                        row: pos.row, col: pos.col,
                        status,
                        from: { v: pV ?? null, t: pT, ct: pCt },
                        to:   { v: nV ?? null, t: nT, ct: nCt },
                    });
                } else {
                    cellsTruncated++;
                }
                totals.cells++;
            }

            // Sort by row then col
            cells.sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);

            // ── 2. Cell formatting (cellStyles Y.Array / YKeyValue) ──────────
            const prevStyleMap = readYKeyValue(prevSheet.get('cellStyles'));
            const newStyleMap  = readYKeyValue(newSheet.get('cellStyles'));

            const formatCells = [];
            const allStyleKeys = new Set([...prevStyleMap.keys(), ...newStyleMap.keys()]);

            for (const key of allStyleKeys) {
                const pos = parseCellKey(key);
                if (!pos) continue;

                const pStyle = prevStyleMap.get(key);
                const nStyle = newStyleMap.get(key);

                const changes = [];
                for (const field of FORMAT_FIELDS) {
                    const pf = pStyle?.[field] ?? null;
                    const nf = nStyle?.[field] ?? null;
                    if (pf !== nf) changes.push({ field, from: pf, to: nf });
                }
                if (changes.length > 0) {
                    formatCells.push({ ref: toA1(pos.row, pos.col), row: pos.row, col: pos.col, changes });
                    totals.formatting++;
                }
            }

            // ── 3. Structure ──────────────────────────────────────────────────
            const structure = [];

            const SCALAR_FIELDS = [
                ['rowCount', 'Rows'],
                ['colCount', 'Columns'],
                ['frozenRows', 'Frozen rows'],
                ['frozenColumns', 'Frozen columns'],
            ];
            for (const [field, label] of SCALAR_FIELDS) {
                const pv = prevSheet.get?.(field);
                const nv = newSheet.get?.(field);
                if (pv !== nv) {
                    structure.push({ field: label, from: String(pv ?? 0), to: String(nv ?? 0) });
                    totals.structure++;
                }
            }

            // Row heights (rowMeta YKeyValue)
            const prevRowMeta = readYKeyValue(prevSheet.get('rowMeta'));
            const newRowMeta  = readYKeyValue(newSheet.get('rowMeta'));
            {
                let n = 0;
                const keys = new Set([...prevRowMeta.keys(), ...newRowMeta.keys()]);
                for (const k of keys) {
                    const ph = prevRowMeta.get(k)?.height ?? prevRowMeta.get(k);
                    const nh = newRowMeta.get(k)?.height  ?? newRowMeta.get(k);
                    if (ph !== nh) n++;
                }
                if (n > 0) { structure.push({ field: 'Row heights', from: '', to: `${n} row${n !== 1 ? 's' : ''} resized` }); totals.structure++; }
            }

            // Column widths (colMeta YKeyValue)
            const prevColMeta = readYKeyValue(prevSheet.get('colMeta'));
            const newColMeta  = readYKeyValue(newSheet.get('colMeta'));
            {
                let n = 0;
                const keys = new Set([...prevColMeta.keys(), ...newColMeta.keys()]);
                for (const k of keys) {
                    const pw = prevColMeta.get(k)?.width ?? prevColMeta.get(k);
                    const nw = newColMeta.get(k)?.width  ?? newColMeta.get(k);
                    if (pw !== nw) n++;
                }
                if (n > 0) { structure.push({ field: 'Column widths', from: '', to: `${n} col${n !== 1 ? 's' : ''} resized` }); totals.structure++; }
            }

            // Merges (Y.Array)
            {
                const pj = yArrayJson(prevSheet.get('merges'));
                const nj = yArrayJson(newSheet.get('merges'));
                if (pj !== nj) {
                    const sc = prevSheet.get('merges')?.length ?? 0;
                    const nc = newSheet.get('merges')?.length  ?? 0;
                    const delta = nc - sc;
                    const label = delta > 0 ? `+${delta} added` : delta < 0 ? `${delta} removed` : 'changed';
                    structure.push({ field: 'Merges', from: String(sc), to: `${nc} (${label})` });
                    totals.structure++;
                }
            }

            // Borders (Y.Array / YKeyValue)
            {
                const prevBorders = readYKeyValue(prevSheet.get('borders'));
                const newBorders  = readYKeyValue(newSheet.get('borders'));
                const allBorderKeys = new Set([...prevBorders.keys(), ...newBorders.keys()]);
                let n = 0;
                for (const k of allBorderKeys) {
                    if (JSON.stringify(prevBorders.get(k) ?? null) !== JSON.stringify(newBorders.get(k) ?? null)) n++;
                }
                if (n > 0) { structure.push({ field: 'Borders', from: '', to: `${n} cell${n !== 1 ? 's' : ''} changed` }); totals.structure++; }
            }

            // ── 4. Tables ────────────────────────────────────────────────────
            const tables = [];
            const prevTables = prevSheet.get?.('tables');
            const newTables  = newSheet.get?.('tables');

            if (prevTables || newTables) {
                const allTableIds = new Set([
                    ...(prevTables ? [...prevTables.keys()] : []),
                    ...(newTables  ? [...newTables.keys()]  : []),
                ]);
                for (const tid of allTableIds) {
                    const pTable = prevTables?.get?.(tid);
                    const nTable = newTables?.get?.(tid);

                    if (!pTable && nTable) {
                        tables.push({ id: tid, type: 'added', name: nTable.get?.('name') ?? tid });
                        totals.tables++;
                    } else if (pTable && !nTable) {
                        tables.push({ id: tid, type: 'removed', name: pTable.get?.('name') ?? tid });
                        totals.tables++;
                    } else if (pTable && nTable) {
                        const pName = pTable.get?.('name') ?? tid;
                        const nName = nTable.get?.('name') ?? tid;
                        if (pName !== nName) {
                            tables.push({ id: tid, type: 'renamed', name: nName, from: pName, to: nName });
                            totals.tables++;
                        }
                        const pCols = getTableColNames(pTable);
                        const nCols = getTableColNames(nTable);
                        if (JSON.stringify(pCols) !== JSON.stringify(nCols)) {
                            const delta = nCols.length - pCols.length;
                            const detail = delta > 0 ? `+${delta} column${delta !== 1 ? 's' : ''}` : delta < 0 ? `${delta} column${Math.abs(delta) !== 1 ? 's' : ''}` : 'columns reordered/renamed';
                            tables.push({ id: tid, type: 'columns', name: nName, detail });
                            totals.tables++;
                        }
                        // Row data
                        const sArr = pTable.get('rows');
                        const lArr = nTable.get('rows');
                        if (sArr || lArr) {
                            const sLen = sArr?.length ?? 0;
                            const lLen = lArr?.length ?? 0;
                            const added   = Math.max(0, lLen - sLen);
                            const removed = Math.max(0, sLen - lLen);
                            let mutated = 0;
                            const minLen = Math.min(sLen, lLen);
                            for (let i = 0; i < minLen; i++) {
                                const sr = sArr?.get?.(i);
                                const lr = lArr?.get?.(i);
                                const sj = JSON.stringify(sr && typeof sr.toJSON === 'function' ? sr.toJSON() : sr);
                                const lj = JSON.stringify(lr && typeof lr.toJSON === 'function' ? lr.toJSON() : lr);
                                if (sj !== lj) mutated++;
                            }
                            if (added > 0 || removed > 0 || mutated > 0) {
                                const parts = [];
                                if (added   > 0) parts.push(`+${added} row${added !== 1 ? 's' : ''}`);
                                if (removed > 0) parts.push(`−${removed} row${removed !== 1 ? 's' : ''}`);
                                if (mutated > 0) parts.push(`${mutated} row${mutated !== 1 ? 's' : ''} edited`);
                                tables.push({ id: tid, type: 'rows', name: nName, detail: parts.join(', ') });
                                totals.tables++;
                            }
                        }
                    }
                }
            }

            // ── Emit if anything changed ──────────────────────────────────────
            const hasChanges = totals.cells > 0 || totals.formatting > 0 || totals.structure > 0 || totals.tables > 0
                || cells.length > 0 || formatCells.length > 0 || structure.length > 0 || tables.length > 0
                || renamed !== null;

            if (hasChanges || isInitial) {
                sheetDiffs.push({
                    id: sheetId,
                    name: newName,
                    isNew: false,
                    isDeleted: false,
                    renamed,
                    cells,
                    cellsTruncated,
                    formatCells,
                    structure,
                    tables,
                });
            }
        }

        const result = {
            v: 2,
            appType: 'sheets',
            totals,
            sheetsRenamed,
            sheetOrder,
            sheets: sheetDiffs,
        };
        if (isInitial) result.isInitial = true;
        return result;
    } catch (err) {
        console.error('[diff/sheets] Error computing diff:', err.message);
        return { v: 2, appType: 'sheets', totals: { cells: 0, formatting: 0, structure: 0, tables: 0, sheetsAdded: 0, sheetsRemoved: 0 }, sheetsRenamed: [], sheetOrder: null, sheets: [], error: err.message };
    }
}

/**
 * Sum up all meaningful changes from a v2 sheets diff.
 * @param {object} diff
 * @returns {number}
 */
export function countSheetsDiffChanges(diff) {
    if (!diff?.totals) return 0;
    const t = diff.totals;
    return (t.cells ?? 0) + (t.formatting ?? 0) + (t.structure ?? 0) + (t.tables ?? 0) + (t.sheetsAdded ?? 0) + (t.sheetsRemoved ?? 0);
}
