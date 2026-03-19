/**
 * operations.js - Pure Yjs spreadsheet operations for CLI/scripting use.
 *
 * All functions take a loaded Y.Doc and operate directly on the Yjs data
 * structures defined in schema.js — no Svelte, no browser APIs.
 *
 * Cell coordinates are 0-based (row 0, col 0 = top-left).
 */

import * as Y from 'yjs';

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

// ─── Cells ─────────────────────────────────────────────────────────────────

/**
 * Read a single cell. Returns null if the cell is empty.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {number} row  0-based
 * @param {number} col  0-based
 * @returns {object|null}  Cell properties (v, t, bold, etc.) or null
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
 * @param {object} [props]  Extra cell properties (t, bold, etc.)
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
    ydoc.transact(() => {
        cells.delete(`${row},${col}`);
    });
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
        const colsArr = t.get('columns');
        const columns = colsArr
            ? colsArr.toArray().map(c => c.toJSON ? c.toJSON() : { ...c })
            : [];
        result.push({
            id,
            name: t.get('name') ?? id,
            mode: t.get('mode') ?? 'inline',
            columns,
        });
    });
    return result;
}

/**
 * Get all rows for a table (in raw insertion order, newest last).
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
 * Insert a row into a table.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {object} rowData  Plain object mapping columnId → value
 */
export function insertTableRow(ydoc, sheetId, tableId, rowData) {
    const table = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) throw new Error(`Table "${tableId}" has no rows array`);

    // Collect formula/computed column IDs to skip them
    const formulaCols = new Set();
    const colsArr = table.get('columns');
    if (colsArr) {
        colsArr.forEach(c => {
            if (c.get('isNonEntry')) formulaCols.add(c.get('id'));
        });
    }

    ydoc.transact(() => {
        const yRow = new Y.Map();
        for (const [k, v] of Object.entries(rowData)) {
            if (!formulaCols.has(k)) yRow.set(k, v);
        }
        rowArr.push([yRow]);
    });
}

/**
 * Update an existing table row by its index (0 = oldest).
 * Only the provided keys are changed; others are left as-is.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {number} rowIndex  0-based index into raw row array
 * @param {object} updates
 */
export function updateTableRow(ydoc, sheetId, tableId, rowIndex, updates) {
    const table = _getTable(ydoc, sheetId, tableId);
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
 * Delete a table row by its index.
 * @param {Y.Doc} ydoc
 * @param {string} sheetId
 * @param {string} tableId
 * @param {number} rowIndex  0-based index into raw row array
 */
export function deleteTableRow(ydoc, sheetId, tableId, rowIndex) {
    const table = _getTable(ydoc, sheetId, tableId);
    const rowArr = table.get('rows');
    if (!rowArr) throw new Error(`Table "${tableId}" has no rows array`);

    ydoc.transact(() => {
        rowArr.delete(rowIndex, 1);
    });
}

// ─── Internal ──────────────────────────────────────────────────────────────

function _getTable(ydoc, sheetId, tableId) {
    const tables = sheetById(ydoc, sheetId).get('tables');
    const table = tables?.get(tableId);
    if (!table) throw new Error(`Table "${tableId}" not found in sheet "${sheetId}"`);
    return table;
}
