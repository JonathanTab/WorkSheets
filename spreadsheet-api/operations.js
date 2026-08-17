/**
 * operations.js — Back-compatible façade over the shared operations layer.
 *
 * The real implementations now live in src/stores/spreadsheet/ops/, which the
 * browser client imports too. This file exists so existing callers
 * (SpreadsheetClient, server.js, scripts) keep their current signatures —
 * 0-based (row, col) integers and sheet IDs — while inheriting the fixes that
 * came with the move:
 *
 *   - cell styles resolve through the v9 palette instead of returning `{s: sid}`
 *   - style writes intern into the palette instead of duplicating inline
 *   - reads evaluate formulas instead of returning "=SUM(A1:A10)"
 *   - writes are gated on schema compatibility
 *
 * New code should prefer the ops layer (or the MCP server) directly: it speaks
 * A1 notation, validates against table schemas, and exposes the design surface.
 */

import { formatA1Cell, formatA1Range } from '../src/formulas/a1.js';
import * as cellOps from '../src/stores/spreadsheet/ops/cellOps.js';
import * as sheetOps from '../src/stores/spreadsheet/ops/sheetOps.js';
import * as tableOps from '../src/stores/spreadsheet/ops/tableOps.js';
import * as tableRead from '../src/stores/spreadsheet/ops/tableRead.js';
import { resolveSheet } from '../src/stores/spreadsheet/ops/context.js';

// Re-export the modern surface so callers can migrate incrementally.
export * as ops from '../src/stores/spreadsheet/ops/index.js';

// ─── Sheets ────────────────────────────────────────────────────────────────

export function listSheets(ydoc) {
    return sheetOps.listSheets(ydoc).map(({ id, name }) => ({ id, name }));
}

export function getSheetMeta(ydoc, sheetId) {
    const { id, sheet } = resolveSheet(ydoc, sheetId);
    return {
        id,
        name:          sheet.get('name') ?? id,
        rowCount:      sheet.get('rowCount') ?? 0,
        colCount:      sheet.get('colCount') ?? 0,
        frozenRows:    sheet.get('frozenRows') ?? 0,
        frozenColumns: sheet.get('frozenColumns') ?? 0,
    };
}

export function createSheet(ydoc, name, opts = {}) {
    return sheetOps.createSheet(ydoc, name, opts).id;
}

export const renameSheet = (ydoc, sheetId, name) => void sheetOps.renameSheet(ydoc, sheetId, name);
export const deleteSheet = (ydoc, sheetId) => void sheetOps.deleteSheet(ydoc, sheetId);

// ─── Cells ─────────────────────────────────────────────────────────────────

/**
 * Read a cell. Returns the merged value+style object callers expect, with the
 * style resolved from the palette and `v` holding the COMPUTED value.
 * The untouched formula text is available as `formula`.
 * @returns {object|null} null when the cell is empty
 */
export function getCell(ydoc, sheetId, row, col) {
    const cell = cellOps.getCell(ydoc, sheetId, formatA1Cell(row, col));
    if (cell.empty) return null;
    return {
        ...(cell.style ?? {}),
        v: cell.value,
        ...(cell.type != null ? { t: cell.type } : {}),
        ...(cell.formula ? { formula: cell.formula } : {}),
    };
}

export function setCell(ydoc, sheetId, row, col, value, props = {}) {
    return cellOps.setCell(ydoc, sheetId, formatA1Cell(row, col), value, props);
}

export function clearCell(ydoc, sheetId, row, col) {
    const ref = formatA1Cell(row, col);
    return cellOps.clearRange(ydoc, sheetId, ref, { contents: true, formats: true });
}

/** 2-D array of merged cell objects; empty cells are null. */
export function getRange(ydoc, sheetId, startRow, startCol, endRow, endCol) {
    const res = cellOps.getRange(ydoc, sheetId, formatA1Range(startRow, startCol, endRow, endCol), {
        includeStyles: true, includeFormulas: true,
    });
    return res.values.map((rowVals, ri) => rowVals.map((v, ci) => {
        const style = res.styles[ri][ci];
        const formula = res.formulas[ri][ci];
        if (v == null && style == null) return null;
        return { ...(style ?? {}), v, ...(formula ? { formula } : {}) };
    }));
}

export function setRange(ydoc, sheetId, startRow, startCol, values2d, props = {}) {
    return cellOps.setRange(ydoc, sheetId, formatA1Cell(startRow, startCol), values2d, props);
}

export function clearRange(ydoc, sheetId, startRow, startCol, endRow, endCol) {
    return cellOps.clearRange(ydoc, sheetId, formatA1Range(startRow, startCol, endRow, endCol),
        { contents: true, formats: true });
}

// ─── Tables ────────────────────────────────────────────────────────────────

/**
 * Source tables in the document.
 * `sheetId` is accepted for signature compatibility but not used to filter —
 * tables live document-wide in root.tableData.
 */
export function listTables(ydoc, _sheetId) {
    return tableOps.listTables(ydoc).map(t => {
        const { table } = tableRead.resolveTable(ydoc, t.id);
        return {
            id: t.id,
            name: t.name,
            mode: table.get('mode') ?? 'inline',
            columns: tableRead.readColumns(table),
        };
    });
}

export function findTableByName(ydoc, _sheetId, name) {
    return tableRead.findTableByName(ydoc, name)?.id ?? null;
}

/** Map column names (or ids) onto column ids. Unmatched keys pass through. */
export function resolveColumnNames(ydoc, _sheetId, tableId, data) {
    const { table } = tableRead.resolveTable(ydoc, tableId);
    const byKey = new Map();
    for (const c of tableRead.readColumns(table)) {
        byKey.set(c.id.toLowerCase(), c.id);
        byKey.set(c.name.toLowerCase(), c.id);
    }
    const out = {};
    for (const [k, v] of Object.entries(data ?? {})) {
        out[byKey.get(String(k).toLowerCase()) ?? k] = v;
    }
    return out;
}

/** Raw rows in stored insertion order (oldest first), formulas NOT evaluated. */
export function getTableRows(ydoc, _sheetId, tableId) {
    const { table } = tableRead.resolveTable(ydoc, tableId);
    return tableRead.rawRows(table);
}

/** Display order (newest-first, sorted) with computed columns evaluated. */
export function getTableRowsWithFormulas(ydoc, _sheetId, tableId) {
    return tableOps.getRows(ydoc, tableId);
}

export function findTableRows(ydoc, _sheetId, tableId, where) {
    return tableOps.findRows(ydoc, tableId, where);
}

export function insertTableRow(ydoc, _sheetId, tableId, rowData) {
    return tableOps.insertRow(ydoc, tableId, rowData);
}

export function updateTableRow(ydoc, _sheetId, tableId, rowIndex, updates) {
    return tableOps.updateRow(ydoc, tableId, rowIndex, updates);
}

export function upsertTableRow(ydoc, _sheetId, tableId, where, rowData) {
    const r = tableOps.upsertRow(ydoc, tableId, where, rowData);
    return { inserted: !!r.inserted, index: r.index ?? -1 };
}

export function deleteTableRow(ydoc, _sheetId, tableId, rowIndex) {
    return tableOps.deleteRow(ydoc, tableId, rowIndex);
}
