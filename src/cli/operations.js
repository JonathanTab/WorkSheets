/**
 * operations.js - Pure Yjs spreadsheet operations for CLI/scripting use.
 *
 * All functions take a loaded Y.Doc and operate directly on the Yjs data
 * structures — no Svelte, no browser APIs.
 *
 * Cell coordinates are 0-based (row 0, col 0 = top-left).
 */

import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { TableFormulaEvaluator } from '../stores/spreadsheet/features/tableFormulaEval.js';

// ─── Internal helpers ──────────────────────────────────────────────────────

function root(ydoc) {
    return ydoc.getMap('spreadsheet');
}

function sheetsMap(ydoc) {
    return root(ydoc).get('sheets');
}

function sheetById(ydoc, sheetId) {
    const s = sheetsMap(ydoc)?.get(sheetId);
    if (!s) throw new Error(`Sheet "${sheetId}" not found`);
    return s;
}

function _getTable(ydoc, sheetId, tableId) {
    const tables = sheetById(ydoc, sheetId).get('tables');
    const table = tables?.get(tableId);
    if (!table) throw new Error(`Table "${tableId}" not found in sheet "${sheetId}"`);
    return table;
}

/** Returns ordered column Y.Maps for a table, supporting both new and legacy layouts. */
function _getOrderedColMaps(table) {
    const defsMap = table.get('columnDefs');
    const orderArr = table.get('columnOrder');
    if (defsMap && orderArr) {
        return orderArr.toArray().map(id => defsMap.get(id)).filter(Boolean);
    }
    // Legacy: columns was a Y.Array<Y.Map>
    const old = table.get('columns');
    return old ? old.toArray() : [];
}

function _getFormulaCols(table) {
    // Pure computed columns: isNonEntry=true with a defaultFormula (never stored).
    // isNonEntry alone (no formula) is just a read-only flag — values are still stored.
    const formulaCols = new Set();
    for (const c of _getOrderedColMaps(table)) {
        if (c.get('isNonEntry') && (c.get('defaultFormula') || c.get('formula'))) {
            formulaCols.add(c.get('id'));
        }
    }
    return formulaCols;
}

// ─── Sheets ────────────────────────────────────────────────────────────────

/**
 * List all sheets in order.
 * @param {Y.Doc} ydoc
 * @returns {{ id: string, name: string }[]}
 */
export function listSheets(ydoc) {
    const r = root(ydoc);
    const sheets = r.get('sheets');
    const order = r.get('sheetOrder')?.toArray() ?? [];
    return order.map(id => {
        const s = sheets?.get(id);
        return { id, name: s?.get('name') ?? id };
    });
}

/**
 * Get metadata for a single sheet.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @returns {{ id, name, rowCount, colCount, frozenRows, frozenColumns }}
 */
export function getSheetMeta(ydoc, sheetId) {
    const sheet = sheetById(ydoc, sheetId);
    return {
        id:              sheetId,
        name:            sheet.get('name')            ?? sheetId,
        rowCount:        sheet.get('rowCount')        ?? 0,
        colCount:        sheet.get('colCount')        ?? 0,
        frozenRows:      sheet.get('frozenRows')      ?? 0,
        frozenColumns:   sheet.get('frozenColumns')   ?? 0,
    };
}

/**
 * Create a new sheet and append it to sheetOrder.
 * @param {Y.Doc} ydoc
 * @param {string} name
 * @param {{ id?: string, rowCount?: number, colCount?: number, insertAt?: number }} [opts]
 * @returns {string} The new sheet ID
 */
export function createSheet(ydoc, name, opts = {}) {
    const r = root(ydoc);
    const sheets = r.get('sheets');
    const sheetOrder = r.get('sheetOrder');
    if (!sheets || !sheetOrder) throw new Error('Document does not appear to be a spreadsheet');

    const id = opts.id ?? randomUUID();

    ydoc.transact(() => {
        const sheet = new Y.Map();
        sheet.set('id',            id);
        sheet.set('name',          name);
        sheet.set('rowCount',      opts.rowCount ?? 100);
        sheet.set('colCount',      opts.colCount ?? 26);
        sheet.set('frozenRows',    0);
        sheet.set('frozenColumns', 0);
        sheet.set('cells',              new Y.Map());
        sheet.set('rowMeta',            new Y.Map());
        sheet.set('colMeta',            new Y.Map());
        sheet.set('tables',             new Y.Map());
        sheet.set('borders',            new Y.Map());
        sheet.set('repeaters',          new Y.Map());
        sheet.set('merges',             new Y.Array());
        sheet.set('conditionalFormats', new Y.Array());
        sheet.set('dataValidations',    new Y.Array());
        sheet.set('printSettings',      new Y.Map());
        sheets.set(id, sheet);

        if (opts.insertAt != null) {
            sheetOrder.insert(opts.insertAt, [id]);
        } else {
            sheetOrder.push([id]);
        }
    });

    return id;
}

/**
 * Rename a sheet.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} name
 */
export function renameSheet(ydoc, sheetId, name) {
    const sheet = sheetById(ydoc, sheetId);
    ydoc.transact(() => { sheet.set('name', name); });
}

/**
 * Delete a sheet entirely (removes from sheets map and sheetOrder).
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 */
export function deleteSheet(ydoc, sheetId) {
    const r = root(ydoc);
    const sheets = r.get('sheets');
    const sheetOrder = r.get('sheetOrder');
    if (!sheets?.has(sheetId)) throw new Error(`Sheet "${sheetId}" not found`);

    ydoc.transact(() => {
        const arr = sheetOrder.toArray();
        const idx = arr.indexOf(sheetId);
        if (idx !== -1) sheetOrder.delete(idx, 1);
        sheets.delete(sheetId);
    });
}

// ─── Cells ─────────────────────────────────────────────────────────────────

/**
 * Read a single cell. Returns null if the cell is empty.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {number} row  0-based
 * @param {number} col  0-based
 * @returns {object|null}
 */
export function getCell(ydoc, sheetId, row, col) {
    const cells = sheetById(ydoc, sheetId).get('cells');
    const cell = cells?.get(`${row},${col}`);
    return cell ? cell.toJSON() : null;
}

/**
 * Set a cell value (or formula). Creates the cell entry if needed.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {number} row  0-based
 * @param {number} col  0-based
 * @param {any} value   Plain value or formula string starting with "="
 * @param {object} [props]  Extra cell properties (t, bold, color, etc.)
 */
export function setCell(ydoc, sheetId, row, col, value, props = {}) {
    const sheet = sheetById(ydoc, sheetId);
    const cells = sheet.get('cells');
    const key = `${row},${col}`;

    ydoc.transact(() => {
        let cell = cells.get(key);
        if (!cell) {
            cell = new Y.Map();
            cells.set(key, cell);
        }
        cell.set('v', value);
        for (const [k, v] of Object.entries(props)) {
            cell.set(k, v);
        }
    });
}

/**
 * Clear a cell entirely (removes its entry from the cells map).
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {number} row
 * @param {number} col
 */
export function clearCell(ydoc, sheetId, row, col) {
    const cells = sheetById(ydoc, sheetId).get('cells');
    ydoc.transact(() => { cells.delete(`${row},${col}`); });
}

/**
 * Read a rectangular range of cells.
 * Returns a 2-D array; empty cells are null.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {number} startRow
 * @param {number} startCol
 * @param {number} endRow   inclusive
 * @param {number} endCol   inclusive
 * @returns {(object|null)[][]}
 */
export function getRange(ydoc, sheetId, startRow, startCol, endRow, endCol) {
    const cells = sheetById(ydoc, sheetId).get('cells');
    const result = [];
    for (let r = startRow; r <= endRow; r++) {
        const row = [];
        for (let c = startCol; c <= endCol; c++) {
            const cell = cells?.get(`${r},${c}`);
            row.push(cell ? cell.toJSON() : null);
        }
        result.push(row);
    }
    return result;
}

/**
 * Write a 2-D array of values starting at (startRow, startCol).
 * null/undefined entries in the array are skipped (leave cell unchanged).
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {number} startRow
 * @param {number} startCol
 * @param {any[][]} values2d  2-D array of values/formulas
 * @param {object} [props]    Formatting props applied to every written cell
 */
export function setRange(ydoc, sheetId, startRow, startCol, values2d, props = {}) {
    const cells = sheetById(ydoc, sheetId).get('cells');
    const hasProps = Object.keys(props).length > 0;

    ydoc.transact(() => {
        for (let ri = 0; ri < values2d.length; ri++) {
            const rowArr = values2d[ri];
            if (!Array.isArray(rowArr)) continue;
            for (let ci = 0; ci < rowArr.length; ci++) {
                const value = rowArr[ci];
                if (value === null || value === undefined) continue;
                const key = `${startRow + ri},${startCol + ci}`;
                let cell = cells.get(key);
                if (!cell) {
                    cell = new Y.Map();
                    cells.set(key, cell);
                }
                cell.set('v', value);
                if (hasProps) {
                    for (const [k, v] of Object.entries(props)) cell.set(k, v);
                }
            }
        }
    });
}

/**
 * Clear all cells in a rectangular range.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {number} startRow
 * @param {number} startCol
 * @param {number} endRow   inclusive
 * @param {number} endCol   inclusive
 */
export function clearRange(ydoc, sheetId, startRow, startCol, endRow, endCol) {
    const cells = sheetById(ydoc, sheetId).get('cells');
    ydoc.transact(() => {
        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                cells.delete(`${r},${c}`);
            }
        }
    });
}

// ─── Tables ────────────────────────────────────────────────────────────────

/**
 * List all tables in a sheet.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @returns {{ id: string, name: string, mode: string, columns: object[] }[]}
 */
export function listTables(ydoc, sheetId) {
    const tables = sheetById(ydoc, sheetId).get('tables');
    if (!tables) return [];

    const result = [];
    tables.forEach((t, id) => {
        const columns = _getOrderedColMaps(t).map(c => c.toJSON ? c.toJSON() : { ...c });
        result.push({
            id,
            name:    t.get('name') ?? id,
            mode:    t.get('mode') ?? 'inline',
            columns,
        });
    });
    return result;
}

/**
 * Find a table by name (case-sensitive). Returns the table ID or null.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} name
 * @returns {string|null}
 */
export function findTableByName(ydoc, sheetId, name) {
    const tables = sheetById(ydoc, sheetId).get('tables');
    if (!tables) return null;
    for (const [id, t] of tables.entries()) {
        if (t.get('name') === name) return id;
    }
    return null;
}

/**
 * Resolve row data keyed by column names (or IDs) to keyed by column IDs.
 * Keys that don't match any column name pass through unchanged.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {object} data
 * @returns {object}
 */
export function resolveColumnNames(ydoc, sheetId, tableId, data) {
    const table = _getTable(ydoc, sheetId, tableId);
    const colMaps = _getOrderedColMaps(table);
    if (!colMaps.length) return data;

    const nameToId = new Map();
    for (const c of colMaps) {
        const id   = c.get('id');
        const name = c.get('name');
        if (id) nameToId.set(id, id);
        if (id && name) nameToId.set(name, id);
    }

    const result = {};
    for (const [k, v] of Object.entries(data)) {
        result[nameToId.get(k) ?? k] = v;
    }
    return result;
}

/**
 * Get all rows for a table (in raw insertion order, oldest first).
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @returns {object[]}
 */
export function getTableRows(ydoc, sheetId, tableId) {
    const table = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) return [];
    return rowArr.toArray().map(r => r.toJSON ? r.toJSON() : { ...r });
}

/**
 * Get all rows for a table with formula (computed) columns evaluated.
 * Unlike getTableRows(), this applies the table's sort config and evaluates
 * any isNonEntry/formula columns using TableFormulaEvaluator — the same logic
 * the browser uses — so the result is consistent between the app and the API.
 *
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @returns {object[]}  rows sorted newest-first (same default display order as the app)
 */
export function getTableRowsWithFormulas(ydoc, sheetId, tableId) {
    const table = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) return [];

    // Raw rows in insertion order
    const rawRows = rowArr.toArray().map(r => r.toJSON ? r.toJSON() : { ...r });

    // Column definitions
    const colMaps = _getOrderedColMaps(table);
    const columns = colMaps.map(c => {
        const raw = c.toJSON ? c.toJSON() : { ...c };
        let typeConfig = null;
        if (typeof raw.typeConfig === 'string') {
            try { typeConfig = JSON.parse(raw.typeConfig); } catch { typeConfig = null; }
        }
        return {
            id:         raw.id ?? '',
            name:       raw.name ?? '',
            type:       typeConfig?.type ?? raw.type ?? 'text',
            typeConfig,
            isNonEntry:     raw.isNonEntry ?? false,
            defaultFormula: raw.defaultFormula ?? raw.formula ?? null,
        };
    });

    // Apply sort (mirror TableStore.#rebuildView sort logic)
    const sortColId = table.get('sortColId') ?? null;
    const sortDir   = table.get('sortDir') ?? 'asc';
    let sortedRows = [...rawRows].reverse(); // default: newest-first
    if (sortColId) {
        const dir = sortDir === 'desc' ? -1 : 1;
        sortedRows = sortedRows.slice().sort((a, b) => {
            const av = a[sortColId], bv = b[sortColId];
            if (av == null && bv == null) return 0;
            if (av == null) return dir;
            if (bv == null) return -dir;
            if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
            return dir * String(av).localeCompare(String(bv));
        });
    }

    // Evaluate formula columns
    const cumReverse = sortColId === null || sortDir === 'desc';
    const evaluator = new TableFormulaEvaluator(sortedRows, columns, cumReverse);

    return sortedRows.map((_, i) => {
        const row = {};
        for (const col of columns) {
            row[col.id] = evaluator.getValue(i, col.id);
        }
        return row;
    });
}

/**
 * Filter table rows by a criteria object.
 * Values are compared with loose equality (==) so numbers and numeric strings match.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {object} where  { columnId: value, ... }
 * @returns {{ index: number, row: object }[]}
 */
export function findTableRows(ydoc, sheetId, tableId, where) {
    const table  = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) return [];

    const entries = Object.entries(where);
    const results = [];
    rowArr.toArray().forEach((r, index) => {
        const row = r.toJSON ? r.toJSON() : { ...r };
        // eslint-disable-next-line eqeqeq
        if (entries.every(([k, v]) => row[k] == v)) {
            results.push({ index, row });
        }
    });
    return results;
}

/**
 * Insert a row into a table.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {object} rowData  { columnId: value, ... }
 */
export function insertTableRow(ydoc, sheetId, tableId, rowData) {
    const table  = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) throw new Error(`Table "${tableId}" has no rows array`);

    const formulaCols = _getFormulaCols(table);

    ydoc.transact(() => {
        const yRow = new Y.Map();
        for (const [k, v] of Object.entries(rowData)) {
            if (!formulaCols.has(k)) yRow.set(k, v);
        }
        rowArr.push([yRow]);
    });
}

/**
 * Update an existing table row by its 0-based index.
 * Only the provided keys are changed; others are left as-is.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {number} rowIndex
 * @param {object} updates
 */
export function updateTableRow(ydoc, sheetId, tableId, rowIndex, updates) {
    const table  = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) throw new Error(`Table "${tableId}" has no rows array`);

    const yRow = rowArr.get(rowIndex);
    if (!yRow) throw new Error(`Row index ${rowIndex} out of bounds (length: ${rowArr.length})`);

    ydoc.transact(() => {
        for (const [k, v] of Object.entries(updates)) {
            yRow.set(k, v);
        }
    });
}

/**
 * Insert a new row or update the first existing row matching `where`.
 * The match check uses loose equality (==).
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {object} where    Criteria to find an existing row
 * @param {object} rowData  Fields to set (merged with where on insert)
 * @returns {{ inserted: boolean, index: number }}
 */
export function upsertTableRow(ydoc, sheetId, tableId, where, rowData) {
    const table  = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) throw new Error(`Table "${tableId}" has no rows array`);

    const formulaCols = _getFormulaCols(table);
    const entries = Object.entries(where);

    // Find first matching row
    let matchIndex = -1;
    rowArr.toArray().forEach((r, i) => {
        if (matchIndex >= 0) return;
        const row = r.toJSON ? r.toJSON() : { ...r };
        // eslint-disable-next-line eqeqeq
        if (entries.every(([k, v]) => row[k] == v)) matchIndex = i;
    });

    ydoc.transact(() => {
        if (matchIndex >= 0) {
            const yRow = rowArr.get(matchIndex);
            for (const [k, v] of Object.entries(rowData)) {
                if (!formulaCols.has(k)) yRow.set(k, v);
            }
        } else {
            const yRow = new Y.Map();
            const merged = { ...where, ...rowData };
            for (const [k, v] of Object.entries(merged)) {
                if (!formulaCols.has(k)) yRow.set(k, v);
            }
            rowArr.push([yRow]);
        }
    });

    return {
        inserted: matchIndex < 0,
        index:    matchIndex >= 0 ? matchIndex : rowArr.length - 1,
    };
}

/**
 * Delete a table row by its 0-based index.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {number} rowIndex
 */
export function deleteTableRow(ydoc, sheetId, tableId, rowIndex) {
    const table  = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) throw new Error(`Table "${tableId}" has no rows array`);

    ydoc.transact(() => { rowArr.delete(rowIndex, 1); });
}
