/**
 * ops/tableOps.js — Structured-table authoring and data entry.
 *
 * Tables are the highest-value primitive for an agent building a spreadsheet:
 * typed columns, dropdown constraints and computed columns encode intent that
 * loose cells cannot. Until now they could only be created from the UI.
 *
 * Every write validates against the table's own schema first and reports ALL
 * problems at once with a machine-readable code, so a caller can correct its
 * input in one step instead of discovering failures one at a time — or worse,
 * writing garbage that silently violates the schema the UI enforces.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import * as Y from 'yjs';
import { initPos, computeInsertPos } from '../features/tableRowHelpers.js';
import { createTableWithView, buildColumnDef, makeId } from '../features/tableCreate.js';
import { YJS_ORIGIN } from '../yjsOrigins.js';
import {
    root, resolveSheet, apiTransact, prepareForWrite, OpError,
} from './context.js';
import {
    resolveTable, readColumns, formulaColumnIds, rawRows, tableSnapshot, listTableNames,
} from './tableRead.js';

// ─── Creation ──────────────────────────────────────────────────────────────

/**
 * Create a table (source + on-sheet view).
 *
 * @param {import('yjs').Doc} ydoc
 * @param {{
 *   name: string,
 *   sheet: string,
 *   columns: Array<{ name: string, type?: string, required?: boolean,
 *                    isNonEntry?: boolean, defaultFormula?: string,
 *                    typeConfig?: object, hAlign?: string }>,
 *   startRow?: number, startCol?: number,
 * }} opts
 * @returns {{ id: string, viewId: string, name: string, columns: object[] }}
 */
export function createTable(ydoc, opts) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, opts.sheet);
    const name = String(opts.name ?? '').trim();
    if (!name) throw new OpError('INVALID_NAME', 'Table name cannot be empty');
    if (listTableNames(ydoc).some(n => n.toLowerCase() === name.toLowerCase())) {
        throw new OpError('DUPLICATE_TABLE', `A table named "${name}" already exists`, {
            existing: listTableNames(ydoc),
        });
    }
    if (!Array.isArray(opts.columns) || opts.columns.length === 0) {
        throw new OpError('NO_COLUMNS', 'A table needs at least one column');
    }

    // Assign stable ids up front; callers address columns by name afterwards.
    const columns = opts.columns.map(c => ({ ...c, id: c.id ?? makeId('col') }));

    const tableDataMap = root(ydoc).get('tableData');
    const viewsMap = sheet.get('tableViews');
    if (!tableDataMap || !viewsMap) {
        throw new OpError('NOT_A_SPREADSHEET', 'Document is missing table storage');
    }

    const { sourceId, viewId } = createTableWithView(ydoc, {
        tableDataMap, viewsMap, name, columns,
        startRow: opts.startRow ?? 0,
        startCol: opts.startCol ?? 0,
        origin: YJS_ORIGIN.API,
    });

    return { id: sourceId, viewId, name, columns: getTableSchema(ydoc, sourceId).columns };
}

/** Delete a table's source data and every view pointing at it. */
export function deleteTable(ydoc, tableRef) {
    prepareForWrite(ydoc);
    const { id } = resolveTable(ydoc, tableRef);
    apiTransact(ydoc, () => {
        root(ydoc).get('tableData')?.delete(id);
        const sheets = root(ydoc).get('sheets');
        sheets?.forEach(sheet => {
            const views = sheet.get('tableViews');
            if (!views) return;
            for (const [viewId, v] of [...views.entries()]) {
                if (v?.get?.('tableId') === id) views.delete(viewId);
            }
        });
    });
    return { deleted: id };
}

/**
 * Add a column to an existing table.
 * @param {import('yjs').Doc} ydoc
 * @param {string} tableRef
 * @param {object} column
 */
export function addColumn(ydoc, tableRef, column) {
    prepareForWrite(ydoc);
    const { table } = resolveTable(ydoc, tableRef);
    const name = String(column?.name ?? '').trim();
    if (!name) throw new OpError('INVALID_NAME', 'Column name cannot be empty');
    if (readColumns(table).some(c => c.name.toLowerCase() === name.toLowerCase())) {
        throw new OpError('DUPLICATE_COLUMN', `Column "${name}" already exists in this table`);
    }

    const id = column.id ?? makeId('col');
    apiTransact(ydoc, () => {
        table.get('columnDefs')?.set(id, buildColumnDef({ ...column, id, name }));
        table.get('columnOrder')?.push([id]);
    });
    return { id, name };
}

// ─── Schema ────────────────────────────────────────────────────────────────

/**
 * The table's schema, with dropdown options resolved.
 *
 * This is what an agent should read before writing rows: it states the exact
 * column names, types, which columns are computed (and therefore rejected on
 * write), and the permitted values for constrained columns.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} tableRef
 */
export function getTableSchema(ydoc, tableRef) {
    const { id, table } = resolveTable(ydoc, tableRef);
    const columns = readColumns(table).map(col => {
        const out = {
            id: col.id,
            name: col.name,
            type: col.type,
            required: col.required,
            computed: !!(col.isNonEntry && col.defaultFormula),
            readOnly: !!col.isNonEntry,
        };
        if (col.defaultFormula) out.formula = col.defaultFormula;
        const options = resolveColumnOptions(ydoc, col);
        if (options) {
            out.options = options;
            out.allowCustom = col.typeConfig?.allowCustom ?? false;
            if (col.typeConfig?.source === 'table' || col.typeConfig?.source === 'range') {
                out.optionsSource = col.typeConfig.source;
                if (col.typeConfig.tableName) out.optionsSourceTable = col.typeConfig.tableName;
                if (col.typeConfig.columnId) out.optionsSourceColumn = col.typeConfig.columnId;
                if (col.typeConfig.range) out.optionsSourceRange = col.typeConfig.range;
            }
        }
        return out;
    });

    return {
        id,
        name: table.get('name') ?? id,
        rowCount: table.get('rows')?.length ?? 0,
        columns,
    };
}

/**
 * Resolve the permitted values for a constrained column.
 * Supports inline option lists and table-backed sources; range-backed sources
 * are resolved by the caller that has sheet context (see docOps.describeDocument).
 * @returns {string[]|null}
 */
function resolveColumnOptions(ydoc, col) {
    const tc = col.typeConfig;
    if (!tc) return null;
    if (Array.isArray(tc.options)) return tc.options.map(String);
    if (tc.source === 'table' && tc.tableName && tc.columnId) {
        try {
            const { table } = resolveTable(ydoc, tc.tableName);
            const { rows } = tableSnapshot(table);
            const seen = new Set();
            const cols = readColumns(table);
            const target = cols.find(c =>
                c.id === tc.columnId || c.name.toLowerCase() === String(tc.columnId).toLowerCase());
            if (!target) return [];
            for (const r of rows) {
                const v = r[target.id];
                if (v == null || v === '') continue;
                seen.add(String(v));
            }
            return [...seen];
        } catch { return []; }
    }
    return null;
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Map user-supplied keys (column names OR ids) onto column ids, and validate
 * the values against the schema.
 *
 * Returns every problem found rather than throwing on the first, so a caller
 * gets one complete correction list.
 *
 * @returns {{ data: object, errors: Array<{ column: string, problem: string, allowed?: string[] }> }}
 */
export function validateRow(ydoc, tableRef, input, { partial = false } = {}) {
    const { table } = resolveTable(ydoc, tableRef);
    const columns = readColumns(table);
    const computed = formulaColumnIds(table);

    const byKey = new Map();
    for (const c of columns) {
        byKey.set(c.id.toLowerCase(), c);
        byKey.set(c.name.toLowerCase(), c);
    }

    const data = {};
    const errors = [];

    for (const [key, value] of Object.entries(input ?? {})) {
        const col = byKey.get(String(key).toLowerCase());
        if (!col) {
            errors.push({
                column: key,
                problem: 'no such column',
                allowed: columns.map(c => c.name),
            });
            continue;
        }
        if (computed.has(col.id)) {
            errors.push({
                column: col.name,
                problem: `computed column (${col.defaultFormula}) — its value is derived, not stored`,
            });
            continue;
        }
        if (value === null || value === undefined || value === '') {
            data[col.id] = value ?? null;
            continue;
        }

        const problem = checkValue(ydoc, col, value);
        if (problem) errors.push({ column: col.name, ...problem });
        else data[col.id] = coerceValue(col, value);
    }

    if (!partial) {
        for (const col of columns) {
            if (!col.required || computed.has(col.id)) continue;
            const v = data[col.id];
            if (v === undefined || v === null || v === '') {
                errors.push({ column: col.name, problem: 'required' });
            }
        }
    }

    return { data, errors };
}

/** @returns {{ problem: string, allowed?: string[] }|null} */
function checkValue(ydoc, col, value) {
    switch (col.type) {
        case 'number':
        case 'currency':
        case 'percent':
            if (typeof value === 'number') return null;
            if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) return null;
            return { problem: `expected a number, got ${JSON.stringify(value)}` };

        case 'checkbox':
        case 'boolean':
            if (typeof value === 'boolean') return null;
            if (['true', 'false', '1', '0'].includes(String(value).toLowerCase())) return null;
            return { problem: `expected a boolean, got ${JSON.stringify(value)}` };

        case 'dropdown':
        case 'select': {
            const options = resolveColumnOptions(ydoc, col);
            if (!options || options.length === 0) return null;
            if (col.typeConfig?.allowCustom) return null;
            if (options.some(o => String(o) === String(value))) return null;
            return { problem: `"${value}" is not an allowed value`, allowed: options };
        }

        default:
            return null;
    }
}

/** Normalise an accepted value to its stored representation. */
function coerceValue(col, value) {
    switch (col.type) {
        case 'number':
        case 'currency':
        case 'percent':
            return typeof value === 'number' ? value : Number(value);
        case 'checkbox':
        case 'boolean':
            return typeof value === 'boolean' ? value : ['true', '1'].includes(String(value).toLowerCase());
        default:
            return value;
    }
}

function assertValid(errors, context) {
    if (errors.length === 0) return;
    throw new OpError('VALIDATION_FAILED',
        `${context}: ${errors.map(e => `${e.column} — ${e.problem}`).join('; ')}`,
        { errors });
}

// ─── Row reads ─────────────────────────────────────────────────────────────

/**
 * All rows, in display order, with computed columns evaluated.
 * @param {{ byName?: boolean }} [opts]  Key rows by column NAME instead of id
 */
export function getRows(ydoc, tableRef, opts = {}) {
    const { table } = resolveTable(ydoc, tableRef);
    const { columns, rows } = tableSnapshot(table);
    if (!opts.byName) return rows;
    const idToName = new Map(columns.map(c => [c.id, c.name]));
    return rows.map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r)) out[idToName.get(k) ?? k] = v;
        return out;
    });
}

/**
 * Find rows matching a criteria object, keyed by column name or id.
 * Comparison is loose so "42" matches 42 — agents routinely send strings.
 * @returns {Array<{ index: number, row: object }>}  index is the RAW storage index
 */
export function findRows(ydoc, tableRef, where, opts = {}) {
    const { table } = resolveTable(ydoc, tableRef);
    const columns = readColumns(table);
    const byKey = new Map();
    for (const c of columns) {
        byKey.set(c.id.toLowerCase(), c.id);
        byKey.set(c.name.toLowerCase(), c.id);
    }

    const criteria = Object.entries(where ?? {}).map(([k, v]) => {
        const id = byKey.get(String(k).toLowerCase());
        if (!id) throw new OpError('UNKNOWN_COLUMN', `No column "${k}" in this table`, {
            allowed: columns.map(c => c.name),
        });
        return [id, v];
    });

    const idToName = new Map(columns.map(c => [c.id, c.name]));
    const out = [];
    rawRows(table).forEach((row, index) => {
        // Loose equality on purpose: agents routinely send "42" for a numeric column.
        if (!criteria.every(([id, v]) => row[id] == v)) return;
        if (opts.byName) {
            const named = {};
            for (const [k, v] of Object.entries(row)) named[idToName.get(k) ?? k] = v;
            out.push({ index, row: named });
        } else {
            out.push({ index, row });
        }
    });
    return out;
}

// ─── Row writes ────────────────────────────────────────────────────────────

/** Append one validated row. Returns the row as stored. */
export function insertRow(ydoc, tableRef, input) {
    prepareForWrite(ydoc);
    const { table } = resolveTable(ydoc, tableRef);
    const { data, errors } = validateRow(ydoc, tableRef, input);
    assertValid(errors, 'Cannot insert row');

    apiTransact(ydoc, () => pushRow(table, data));
    return { inserted: 1, row: data };
}

/**
 * Append many rows in ONE transaction.
 *
 * Validates every row before writing any, so a bad row in the middle of a batch
 * can't leave a half-populated table behind.
 * @returns {{ inserted: number }}
 */
export function appendRows(ydoc, tableRef, inputs) {
    prepareForWrite(ydoc);
    const { table } = resolveTable(ydoc, tableRef);
    if (!Array.isArray(inputs)) throw new OpError('INVALID_ROWS', 'appendRows expects an array');

    const validated = [];
    const allErrors = [];
    inputs.forEach((input, i) => {
        const { data, errors } = validateRow(ydoc, tableRef, input);
        if (errors.length) allErrors.push({ row: i, errors });
        else validated.push(data);
    });
    if (allErrors.length) {
        throw new OpError('VALIDATION_FAILED',
            `${allErrors.length} of ${inputs.length} rows failed validation; nothing was written`,
            { rows: allErrors });
    }

    apiTransact(ydoc, () => { for (const data of validated) pushRow(table, data); });
    return { inserted: validated.length };
}

/** Update an existing row by its raw storage index (as returned by findRows). */
export function updateRow(ydoc, tableRef, rowIndex, updates) {
    prepareForWrite(ydoc);
    const { table } = resolveTable(ydoc, tableRef);
    const arr = table.get('rows');
    const yRow = arr?.get(rowIndex);
    if (!yRow) {
        throw new OpError('ROW_NOT_FOUND',
            `Row index ${rowIndex} is out of bounds (table has ${arr?.length ?? 0} rows)`);
    }

    const { data, errors } = validateRow(ydoc, tableRef, updates, { partial: true });
    assertValid(errors, 'Cannot update row');

    apiTransact(ydoc, () => {
        for (const [k, v] of Object.entries(data)) yRow.set(k, v);
    });
    return { updated: 1, row: data };
}

/** Insert, or update the first row matching `where`. */
export function upsertRow(ydoc, tableRef, where, values) {
    prepareForWrite(ydoc);
    const matches = findRows(ydoc, tableRef, where);
    if (matches.length > 0) {
        const r = updateRow(ydoc, tableRef, matches[0].index, values);
        return { ...r, inserted: 0, index: matches[0].index };
    }
    const r = insertRow(ydoc, tableRef, { ...where, ...values });
    return { ...r, updated: 0 };
}

/** Delete a row by its raw storage index. */
export function deleteRow(ydoc, tableRef, rowIndex) {
    prepareForWrite(ydoc);
    const { table } = resolveTable(ydoc, tableRef);
    const arr = table.get('rows');
    if (!arr || rowIndex < 0 || rowIndex >= arr.length) {
        throw new OpError('ROW_NOT_FOUND',
            `Row index ${rowIndex} is out of bounds (table has ${arr?.length ?? 0} rows)`);
    }
    apiTransact(ydoc, () => arr.delete(rowIndex, 1));
    return { deleted: 1 };
}

/** Append a row Y.Map with the correct _pos, honouring the table's insert sort. */
function pushRow(table, data) {
    const arr = table.get('rows');
    if (!arr) throw new OpError('NO_ROWS', 'Table has no rows array');

    const yRow = new Y.Map();
    for (const [k, v] of Object.entries(data)) yRow.set(k, v);

    initPos(arr);
    const sortColId = table.get('insertSortColId') ?? null;
    const pos = sortColId
        ? computeInsertPos(arr, sortColId, table.get('insertSortDir') ?? 'asc', data[sortColId])
        : Math.max(0, ...arr.toArray().map(r => r?.get?.('_pos') ?? 0)) + 1000;
    yRow.set('_pos', pos);
    arr.push([yRow]);
}

// ─── Listing ───────────────────────────────────────────────────────────────

/** Every source table in the document, with its sheet placement. */
export function listTables(ydoc) {
    const tableData = root(ydoc).get('tableData');
    if (!tableData) return [];

    // Index views so each table can report where it is rendered.
    const placement = new Map();
    root(ydoc).get('sheets')?.forEach((sheet, sheetId) => {
        sheet.get('tableViews')?.forEach(v => {
            const tid = v?.get?.('tableId');
            if (tid && !placement.has(tid)) {
                placement.set(tid, { sheet: sheet.get('name') ?? sheetId, viewId: v.get('id') });
            }
        });
    });

    return [...tableData.entries()].map(([id, t]) => ({
        id,
        name: t.get('name') ?? id,
        rowCount: t.get('rows')?.length ?? 0,
        columnCount: t.get('columnOrder')?.length ?? 0,
        ...(placement.get(id) ?? {}),
    }));
}
