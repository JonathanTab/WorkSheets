/**
 * ops/tableRead.js — Pure read helpers for source tables.
 *
 * Shared by the mutation ops (tableOps.js), the formula evaluator (evalOps.js)
 * and the diagnostics pass (inspectOps.js). Read-only: nothing here writes.
 *
 * The canonical display order for a table is newest-first (raw insertion order
 * reversed), optionally re-sorted by `sortColId`. Column formulas MUST be
 * evaluated against that order because cumulative functions (RUNNINGIF, PREV,
 * WINDOW) accumulate from the bottom upward — evaluating raw order silently
 * produces different numbers than the browser shows.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import { TableFormulaEvaluator } from '../features/tableFormulaEval.js';
import { root, OpError } from './context.js';

/**
 * Resolve a table by ID, following a sheet's tableView reference to the source
 * when the ID names a view rather than the underlying table.
 * @param {import('yjs').Doc} ydoc
 * @param {string} tableId
 * @returns {import('yjs').Map<any>|null}
 */
export function getTableYMap(ydoc, tableId) {
    const tableData = root(ydoc).get('tableData');
    const direct = tableData?.get(tableId);
    if (direct) return direct;

    // Might be a view ID — scan sheets for a view pointing at a source table.
    const sheets = root(ydoc).get('sheets');
    if (!sheets) return null;
    for (const sheet of sheets.values()) {
        const entry = sheet.get('tableViews')?.get(tableId);
        if (!entry) continue;
        const sourceId = entry.get('tableId');
        const src = sourceId ? tableData?.get(sourceId) : null;
        return src ?? entry;
    }
    return null;
}

/**
 * Find a source table by name (case-insensitive).
 * @param {import('yjs').Doc} ydoc
 * @param {string} name
 * @returns {{ id: string, table: import('yjs').Map<any> }|null}
 */
export function findTableByName(ydoc, name) {
    const tableData = root(ydoc).get('tableData');
    if (!tableData) return null;
    const wanted = String(name ?? '').trim().toLowerCase();
    for (const [id, t] of tableData.entries()) {
        if (String(t.get('name') ?? '').trim().toLowerCase() === wanted) return { id, table: t };
    }
    return null;
}

/**
 * Resolve a table by ID or name, throwing a structured error listing what IS
 * available — agents recover from that without a second discovery call.
 * @param {import('yjs').Doc} ydoc
 * @param {string} idOrName
 * @returns {{ id: string, table: import('yjs').Map<any> }}
 */
export function resolveTable(ydoc, idOrName) {
    const direct = getTableYMap(ydoc, idOrName);
    if (direct) return { id: direct.get('id') ?? idOrName, table: direct };
    const byName = findTableByName(ydoc, idOrName);
    if (byName) return byName;
    throw new OpError('TABLE_NOT_FOUND', `Table "${idOrName}" not found`, {
        available: listTableNames(ydoc),
    });
}

/** @param {import('yjs').Doc} ydoc @returns {string[]} */
export function listTableNames(ydoc) {
    const tableData = root(ydoc).get('tableData');
    if (!tableData) return [];
    return [...tableData.values()].map(t => t.get('name')).filter(Boolean);
}

/** Ordered column Y.Maps for a source table. */
export function orderedColumnMaps(table) {
    const defsMap = table.get('columnDefs');
    const orderArr = table.get('columnOrder');
    if (!defsMap || !orderArr) return [];
    return orderArr.toArray().map(id => defsMap.get(id)).filter(Boolean);
}

/**
 * Normalised column definitions, with `typeConfig` parsed from its stored JSON.
 * @param {import('yjs').Map<any>} table
 * @returns {Array<{id:string,name:string,type:string,typeConfig:object|null,isNonEntry:boolean,defaultFormula:string|null,required:boolean,hAlign:string|null}>}
 */
export function readColumns(table) {
    return orderedColumnMaps(table).map(c => {
        const raw = c.toJSON ? c.toJSON() : { ...c };
        let typeConfig = null;
        if (typeof raw.typeConfig === 'string') {
            try { typeConfig = JSON.parse(raw.typeConfig); } catch { typeConfig = null; }
        } else if (raw.typeConfig && typeof raw.typeConfig === 'object') {
            typeConfig = raw.typeConfig;
        }
        return {
            id:             raw.id ?? '',
            name:           raw.name ?? '',
            type:           typeConfig?.type ?? raw.type ?? 'text',
            typeConfig,
            isNonEntry:     raw.isNonEntry ?? false,
            defaultFormula: raw.defaultFormula ?? raw.formula ?? null,
            required:       raw.required ?? false,
            hAlign:         raw.hAlign ?? null,
        };
    });
}

/**
 * Columns that are purely computed — `isNonEntry` AND carrying a formula.
 * `isNonEntry` alone is only a read-only flag; those values are still stored,
 * so writing them must not be silently dropped.
 * @param {import('yjs').Map<any>} table
 * @returns {Set<string>}
 */
export function formulaColumnIds(table) {
    const out = new Set();
    for (const col of readColumns(table)) {
        if (col.isNonEntry && col.defaultFormula) out.add(col.id);
    }
    return out;
}

/** Raw rows as plain objects, in stored insertion order (oldest first). */
export function rawRows(table) {
    const arr = table.get('rows');
    if (!arr) return [];
    return arr.toArray().map(r => (r.toJSON ? r.toJSON() : { ...r }));
}

/**
 * Rows in canonical display order: newest-first, then the table's sort applied.
 * Mirrors TableStore's view rebuild so server results match the browser.
 * @param {import('yjs').Map<any>} table
 * @returns {object[]}
 */
export function displayOrderedRows(table) {
    const rows = [...rawRows(table)].reverse();
    const sortColId = table.get('sortColId') ?? null;
    if (!sortColId) return rows;

    const dir = (table.get('sortDir') ?? 'asc') === 'desc' ? -1 : 1;
    return rows.slice().sort((a, b) => {
        const av = a[sortColId], bv = b[sortColId];
        if (av == null && bv == null) return 0;
        if (av == null) return dir;
        if (bv == null) return -dir;
        if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
        return dir * String(av).localeCompare(String(bv));
    });
}

/**
 * Fully-evaluated table snapshot: display order with computed columns resolved.
 * @param {import('yjs').Map<any>} table
 * @returns {{ columns: object[], rows: object[] }}
 */
export function tableSnapshot(table) {
    const columns = readColumns(table);
    const ordered = displayOrderedRows(table);
    const evaluator = new TableFormulaEvaluator(ordered, columns, true);
    const rows = ordered.map((_, i) => {
        const out = {};
        for (const col of columns) out[col.id] = evaluator.getValue(i, col.id);
        return out;
    });
    return { columns, rows };
}

/**
 * Build a TableStore-shaped façade over a Yjs table so `buildTableFunctions()`
 * (which was written against the browser TableStore) works unchanged on the
 * server — this is what lets TABLE_* functions resolve in cell formulas here.
 *
 * NOTE: the server has no view state, so the "filtered" variants intentionally
 * return the same data as the full variants. A TABLE_* call that explicitly
 * asks for filtered results will therefore match the browser only when no view
 * filter is active.
 *
 * @param {import('yjs').Map<any>} table
 * @returns {object}
 */
export function buildTableAdapter(table) {
    const { columns, rows } = tableSnapshot(table);
    const colIds = new Set(columns.map(c => c.id));
    const byName = new Map(columns.map(c => [String(c.name).toLowerCase(), c.id]));

    const resolveCol = (colId) => {
        if (colIds.has(colId)) return colId;
        return byName.get(String(colId ?? '').toLowerCase()) ?? colId;
    };
    const valueAt = (idx, colId) => rows[idx]?.[resolveCol(colId)] ?? null;
    const column = (colId) => { const id = resolveCol(colId); return rows.map(r => r[id] ?? null); };

    return {
        name: table.get('name') ?? '',
        columns,
        // TABLE_* functions call resolveColId to accept either a column id or a
        // human-facing column name as their argument.
        resolveColId:    (colId) => resolveCol(colId),
        getRowCount:     () => rows.length,
        getFullRowCount: () => rows.length,
        getValue:        (idx, colId) => valueAt(idx, colId),
        getFullValue:    (idx, colId) => valueAt(idx, colId),
        getColumn:       (colId) => column(colId),
        getFullColumn:   (colId) => column(colId),
        getCumulativeSum: (colId, upToIndex) => {
            const vals = column(colId);
            let sum = 0;
            for (let i = 0; i <= Math.min(upToIndex, vals.length - 1); i++) {
                const n = Number(vals[i]);
                if (!isNaN(n)) sum += n;
            }
            return sum;
        },
    };
}
