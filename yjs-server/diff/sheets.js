import * as Y from 'yjs';

/**
 * Schema-aware diff for spreadsheet (sheets) Yjs documents.
 *
 * Reads the current schema: cellValues + cellStyles as YKeyValue-backed Y.Arrays,
 * rowMeta / colMeta, borders, merges, tableData (root-level source tables),
 * tableViews (per-sheet view entries), and sheetOrder.
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
 * Read a YKeyValue Y.Array into a plain Map<string, value>.
 * y-utility/y-keyvalue stores items as plain { key, val } objects (yarray.push([{key,val}])).
 * Also handles Y.Map shape defensively for any future schema variation.
 * Keys are normalised to strings so that numeric keys (e.g. 3) and string keys ("3")
 * are treated as the same entry — application code may use either form.
 * Later duplicates overwrite earlier ones (matching YKeyValue semantics).
 * @param {Y.Array|null|undefined} arr
 * @returns {Map<string, any>}
 */
function readYKeyValue(arr) {
    const map = new Map();
    if (!arr || !(arr instanceof Y.Array)) return map;
    arr.forEach(item => {
        if (!item) return;
        let k, v;
        if (item instanceof Y.Map) {
            k = item.get('key');
            v = item.get('val');
        } else if (typeof item === 'object') {
            k = item.key;
            v = item.val;
        }
        // Normalise key to string to prevent number/string key mismatches
        if (k !== undefined && k !== null) map.set(String(k), v);
    });
    return map;
}

/**
 * Resolve v9 style palette references in a cellStyles map.
 * Each entry is either `{ s: sid }` (→ look up the style object in `palette`)
 * or a legacy inline style object (→ passed through unchanged). Dangling refs
 * resolve to null so the diff treats them as "no style".
 * @param {Map<string, any>} styleMap   key → cellStyles entry
 * @param {Map<string, any>} palette    sid → style object
 * @returns {Map<string, any>}
 */
function resolveStyleMap(styleMap, palette) {
    let hasRef = false;
    for (const v of styleMap.values()) {
        if (v && typeof v === 'object' && 's' in v && Object.keys(v).length === 1) { hasRef = true; break; }
    }
    if (!hasRef) return styleMap; // legacy doc — nothing to resolve
    const out = new Map();
    for (const [k, v] of styleMap) {
        if (v && typeof v === 'object' && 's' in v && Object.keys(v).length === 1) {
            out.set(k, palette.get(String(v.s)) ?? null);
        } else {
            out.set(k, v);
        }
    }
    return out;
}

/**
 * Safely extract a numeric dimension (width or height) from a rowMeta/colMeta entry.
 * The entry can be:
 *   - an object like { width: 120 } (current v4 format)
 *   - a plain number (legacy format)
 *   - undefined/null (column/row using default size → treated as null)
 * Returns null when the entry is absent or the field is missing/non-numeric.
 * NEVER falls back to the full object — avoids spurious change detection from
 * reference inequality on otherwise identical objects.
 * @param {any} entry
 * @param {'width'|'height'} field
 * @returns {number|null}
 */
function _extractDimension(entry, field) {
    if (entry === undefined || entry === null) return null;
    if (typeof entry === 'number') return entry;
    if (typeof entry === 'object') {
        const v = entry[field];
        return typeof v === 'number' ? v : null;
    }
    return null;
}

/**
 * Safely extract the cell value from a cellValues entry.
 * Entries are { v, t } objects or occasionally plain primitives.
 * Returns undefined when the entry is absent (key not in map).
 * NEVER returns the full object — avoids reference-inequality false positives.
 * @param {any} entry
 * @returns {any}
 */
function _extractCellValue(entry) {
    if (entry === undefined || entry === null) return null;
    if (typeof entry === 'object') return entry.v ?? null;
    return entry; // plain primitive stored directly
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

/**
 * Get ordered column names from a source table Y.Map (columnDefs + columnOrder).
 */
function getTableColNames(tableMap) {
    try {
        const colDefs  = tableMap.get('columnDefs');
        const colOrder = tableMap.get('columnOrder');
        if (!colDefs || !colOrder) return [];
        return colOrder.toArray().map(id => colDefs.get?.(id)?.get?.('name') ?? id);
    } catch { return []; }
}

/**
 * Diff two table row Y.Arrays.
 * Rows are Y.Maps sorted by their `_pos` field (insertion-order float).
 * Returns a table diff entry (type:'rows') or null if no row changes.
 * The internal _rowAdded/_rowRemoved/_rowEdited fields let the caller
 * fold row changes into the totals.cells counter so empty-snapshot guards fire.
 * @param {Y.Array|null} pArr
 * @param {Y.Array|null} nArr
 * @param {string} tableName
 * @returns {object|null}
 */
function _diffTableRows(pArr, nArr, tableName) {
    try {
        // Flatten rows to plain objects, sorting by _pos for stable ordering
        const toSortedRows = (arr) => {
            if (!arr || !(arr instanceof Y.Array)) return [];
            return arr.toArray()
                .map(r => (r && typeof r.toJSON === 'function') ? r.toJSON() : (r ?? {}))
                .sort((a, b) => (a._pos ?? 0) - (b._pos ?? 0));
        };

        const pRows = toSortedRows(pArr);
        const nRows = toSortedRows(nArr);
        const pLen  = pRows.length;
        const nLen  = nRows.length;

        // Row fingerprint: JSON of all fields except _pos (which changes with sort arithmetic)
        const fingerprint = (row) => {
            const { _pos, ...rest } = row;
            return JSON.stringify(rest);
        };

        // Build fingerprint sets for identity-free change detection
        const pPrints = pRows.map(fingerprint);
        const nPrints = nRows.map(fingerprint);

        const pSet = new Map();
        for (const fp of pPrints) pSet.set(fp, (pSet.get(fp) ?? 0) + 1);
        const nSet = new Map();
        for (const fp of nPrints) nSet.set(fp, (nSet.get(fp) ?? 0) + 1);

        // Rows in prev but not new: removed or edited
        let rowRemoved = 0;
        for (const [fp, pCount] of pSet) {
            const nCount = nSet.get(fp) ?? 0;
            if (pCount > nCount) rowRemoved += pCount - nCount;
        }
        // Rows in new but not prev: added or result of edit
        let rowAdded = 0;
        for (const [fp, nCount] of nSet) {
            const pCount = pSet.get(fp) ?? 0;
            if (nCount > pCount) rowAdded += nCount - pCount;
        }

        // Edits = matched pairs of add+remove (minimum of both)
        const rowEdited = Math.min(rowAdded, rowRemoved);
        const actualAdded   = rowAdded   - rowEdited;
        const actualRemoved = rowRemoved - rowEdited;

        if (actualAdded === 0 && actualRemoved === 0 && rowEdited === 0) return null;

        const parts = [];
        if (actualAdded   > 0) parts.push(`+${actualAdded} row${actualAdded !== 1 ? 's' : ''}`);
        if (actualRemoved > 0) parts.push(`−${actualRemoved} row${actualRemoved !== 1 ? 's' : ''}`);
        if (rowEdited     > 0) parts.push(`${rowEdited} row${rowEdited !== 1 ? 's' : ''} edited`);

        return {
            id: tableName, type: 'rows', name: tableName, detail: parts.join(', '),
            _rowAdded: actualAdded, _rowRemoved: actualRemoved, _rowEdited: rowEdited,
        };
    } catch { return null; }
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

        // v9: cell styles are interned into a doc-level palette; cellStyles entries
        // are `{ s: sid }` refs. Read each doc's palette so we can resolve refs back
        // to the real style objects before diffing (legacy inline styles pass through).
        const prevPalette = readYKeyValue(prevRoot.get('stylePalette'));
        const newPalette  = readYKeyValue(newRoot.get('stylePalette'));

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

            // Hoist style maps — used both in the value loop (for ct) and in the format loop.
            // Resolve v9 `{ s: sid }` palette refs to the underlying style objects.
            const prevStyleMap = resolveStyleMap(readYKeyValue(prevSheet.get('cellStyles')), prevPalette);
            const newStyleMap  = resolveStyleMap(readYKeyValue(newSheet.get('cellStyles')), newPalette);

            const allCellKeys = new Set([...prevValMap.keys(), ...newValMap.keys()]);
            for (const key of allCellKeys) {
                const pos = parseCellKey(key);
                if (!pos) continue;

                const pVal = prevValMap.get(key);
                const nVal = newValMap.get(key);
                // Extract .v (cell value) safely — never fall back to object reference
                const pV = _extractCellValue(pVal);
                const nV = _extractCellValue(nVal);
                const pT = (pVal && typeof pVal === 'object') ? (pVal.t ?? null) : null;
                const nT = (nVal && typeof nVal === 'object') ? (nVal.t ?? null) : null;

                if (pV === nV && pT === nT) continue; // unchanged

                let status;
                if (!prevValMap.has(key))     status = 'added';
                else if (!newValMap.has(key)) status = 'removed';
                else                          status = 'changed';

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
            // prevStyleMap / newStyleMap already computed above

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
                    const ph = _extractDimension(prevRowMeta.get(k), 'height');
                    const nh = _extractDimension(newRowMeta.get(k),  'height');
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
                    const pw = _extractDimension(prevColMeta.get(k), 'width');
                    const nw = _extractDimension(newColMeta.get(k),  'width');
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

            // ── 4. Tables ─────────────────────────────────────────────────────
            // Source tables live in root.tableData; views in sheet.tableViews.
            // We diff source tables directly (rows, columns, name).
            const tables = [];
            {
                const prevGlobal = prevDoc.getMap('spreadsheet').get('tableData');
                const newGlobal  = newDoc.getMap('spreadsheet').get('tableData');

                // Collect all source table IDs from root.tableData
                const allSourceIds = new Set();
                if (prevGlobal) for (const id of prevGlobal.keys()) allSourceIds.add(id);
                if (newGlobal)  for (const id of newGlobal.keys())  allSourceIds.add(id);

                for (const tid of allSourceIds) {
                    const pTable = prevGlobal?.get(tid) ?? null;
                    const nTable = newGlobal?.get(tid)  ?? null;

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
                        // Column schema changes
                        const pCols = getTableColNames(pTable);
                        const nCols = getTableColNames(nTable);
                        if (JSON.stringify(pCols) !== JSON.stringify(nCols)) {
                            const delta = nCols.length - pCols.length;
                            const detail = delta > 0
                                ? `+${delta} column${delta !== 1 ? 's' : ''}`
                                : delta < 0
                                    ? `${delta} column${Math.abs(delta) !== 1 ? 's' : ''}`
                                    : 'columns reordered/renamed';
                            tables.push({ id: tid, type: 'columns', name: nName, detail });
                            totals.tables++;
                        }
                        // Row data — compare the rows Y.Array
                        const pArr = pTable.get('rows');
                        const nArr = nTable.get('rows');
                        if (pArr instanceof Y.Array || nArr instanceof Y.Array) {
                            const rowDiff = _diffTableRows(pArr ?? null, nArr ?? null, nName);
                            if (rowDiff) {
                                tables.push(rowDiff);
                                totals.tables++;
                                // Also roll added/removed rows into the cells total
                                // so the snapshot "has real changes" guard fires correctly.
                                totals.cells += rowDiff._rowAdded + rowDiff._rowRemoved + rowDiff._rowEdited;
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
