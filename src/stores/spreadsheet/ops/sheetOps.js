/**
 * ops/sheetOps.js — Sheet lifecycle and structural row/column edits.
 *
 * Structural edits are the part most easily got wrong: inserting a row has to
 * move cell values, styles, row metadata, border edges and merges, and rewrite
 * every formula that referenced a shifted cell. Skipping the last step is what
 * turns "insert a row" into "silently corrupt every total on the sheet", so the
 * reference rewrite uses the same adjusters (formulas/refs.js) the browser uses.
 *
 * Rows are addressed by 1-based number and columns by letter or 0-based index,
 * matching what a user sees in the headers.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import * as Y from 'yjs';
import { colToNum, numToCol, adjustForRowInsert, adjustForColInsert, adjustForRowDelete, adjustForColDelete } from '../../../formulas/refs.js';
import { createSheetYMap } from '../schema.js';
import { DEFAULT_ROW_COUNT, DEFAULT_COL_COUNT } from '../constants.js';
import {
    root, sheetsMap, resolveSheet, mkCellValuesKV, mkCellStylesKV, mkSheetKV,
    apiTransact, prepareForWrite, OpError,
} from './context.js';

/** Column letter or index → 0-based index. */
function toColIndex(key) {
    if (typeof key === 'number') return key;
    const s = String(key).trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (/^[A-Za-z]+$/.test(s)) return colToNum(s.toUpperCase());
    throw new OpError('INVALID_COLUMN', `Not a column reference: "${key}"`);
}

/** 1-based row number → 0-based index. */
function toRowIndex(n) {
    const v = typeof n === 'number' ? n : parseInt(String(n), 10);
    if (isNaN(v) || v < 1) throw new OpError('INVALID_ROW', `Row must be >= 1, got "${n}"`);
    return v - 1;
}

// ─── Sheet lifecycle ───────────────────────────────────────────────────────

/** @returns {Array<{ id: string, name: string, index: number }>} */
export function listSheets(ydoc) {
    const sheets = sheetsMap(ydoc);
    const order = root(ydoc).get('sheetOrder')?.toArray() ?? [];
    return order.map((id, index) => ({
        id,
        name: sheets?.get(id)?.get('name') ?? id,
        index,
    }));
}

/**
 * Create a sheet and append it to the sheet order.
 * @param {import('yjs').Doc} ydoc
 * @param {string} name
 * @param {{ rowCount?: number, colCount?: number, insertAt?: number }} [opts]
 * @returns {{ id: string, name: string }}
 */
export function createSheet(ydoc, name, opts = {}) {
    prepareForWrite(ydoc);
    const sheets = sheetsMap(ydoc);
    const order = root(ydoc).get('sheetOrder');
    if (!sheets || !order) throw new OpError('NOT_A_SPREADSHEET', 'Document has no sheet collection');

    const wanted = String(name ?? '').trim();
    if (!wanted) throw new OpError('INVALID_NAME', 'Sheet name cannot be empty');
    if (listSheets(ydoc).some(s => s.name.toLowerCase() === wanted.toLowerCase())) {
        throw new OpError('DUPLICATE_SHEET', `A sheet named "${wanted}" already exists`);
    }

    const id = `sheet-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    apiTransact(ydoc, () => {
        sheets.set(id, createSheetYMap(ydoc, id, wanted, {
            rowCount: opts.rowCount ?? DEFAULT_ROW_COUNT,
            colCount: opts.colCount ?? DEFAULT_COL_COUNT,
        }));
        if (opts.insertAt != null) order.insert(Math.max(0, opts.insertAt), [id]);
        else order.push([id]);
    });
    return { id, name: wanted };
}

/** Rename a sheet. */
export function renameSheet(ydoc, sheetRef, newName) {
    prepareForWrite(ydoc);
    const { id, sheet } = resolveSheet(ydoc, sheetRef);
    const wanted = String(newName ?? '').trim();
    if (!wanted) throw new OpError('INVALID_NAME', 'Sheet name cannot be empty');
    if (listSheets(ydoc).some(s => s.id !== id && s.name.toLowerCase() === wanted.toLowerCase())) {
        throw new OpError('DUPLICATE_SHEET', `A sheet named "${wanted}" already exists`);
    }
    apiTransact(ydoc, () => sheet.set('name', wanted));
    return { id, name: wanted };
}

/**
 * Delete a sheet.
 * Refuses to remove the last one — a spreadsheet with no sheets renders as a
 * broken document rather than an empty one.
 */
export function deleteSheet(ydoc, sheetRef) {
    prepareForWrite(ydoc);
    const { id } = resolveSheet(ydoc, sheetRef);
    const sheets = sheetsMap(ydoc);
    const order = root(ydoc).get('sheetOrder');

    if ((order?.length ?? 0) <= 1) {
        throw new OpError('LAST_SHEET', 'Cannot delete the only sheet in the document');
    }

    apiTransact(ydoc, () => {
        const idx = order.toArray().indexOf(id);
        if (idx !== -1) order.delete(idx, 1);
        sheets.delete(id);
    });
    return { deleted: id };
}

/** Move a sheet to a new position in the tab order. */
export function moveSheet(ydoc, sheetRef, toIndex) {
    prepareForWrite(ydoc);
    const { id } = resolveSheet(ydoc, sheetRef);
    const order = root(ydoc).get('sheetOrder');
    apiTransact(ydoc, () => {
        const arr = order.toArray();
        const from = arr.indexOf(id);
        if (from === -1) return;
        order.delete(from, 1);
        order.insert(Math.max(0, Math.min(toIndex, order.length)), [id]);
    });
    return { id, index: toIndex };
}

// ─── Structural edits ──────────────────────────────────────────────────────

/**
 * Shift "row,col"-keyed entries along one axis AND rewrite their formulas, in a
 * single read → compute → write pass.
 *
 * This has to be one pass. YKeyValue maintains its lookup map from a Y.Array
 * observer, and Yjs fires observers at transaction cleanup — so writes made
 * earlier in a transaction are NOT visible to reads later in that same
 * transaction. Shifting first and adjusting formulas second would therefore
 * read pre-shift state and write the adjusted formula back to the vacated key,
 * leaving the moved cell unadjusted. Everything is read up front instead.
 *
 * @param {import('y-utility/y-keyvalue').YKeyValue|null} kv
 * @param {'row'|'col'} axis
 * @param {number} at      0-based index at/after which entries move
 * @param {number} delta   +n to insert, -n to delete
 * @param {((formula: string, index: number) => string)|null} adjuster
 */
function shiftCellKeys(kv, axis, at, delta, adjuster = null) {
    if (!kv || delta === 0) return;

    const entries = [...kv.map.entries()].map(([key, { val }]) => ({ key, val }));
    const deletes = new Set();
    const writes = [];
    const count = Math.abs(delta);

    for (const { key, val } of entries) {
        const [r, c] = key.split(',').map(Number);
        if (isNaN(r) || isNaN(c)) continue;
        const pos = axis === 'row' ? r : c;

        // Entries inside a deleted band disappear with it.
        if (delta < 0 && pos >= at && pos < at - delta) { deletes.add(key); continue; }

        const moved = pos >= at;
        const nr = axis === 'row' && moved ? r + delta : r;
        const nc = axis === 'col' && moved ? c + delta : c;
        const newKey = `${nr},${nc}`;

        // Formulas are rewritten wherever they live — a formula that doesn't
        // move can still point at a cell that did.
        let newVal = val;
        const v = val?.v;
        if (adjuster && typeof v === 'string' && v.startsWith('=')) {
            let next = v;
            for (let i = 0; i < count; i++) next = adjuster(next, at);
            if (next !== v) newVal = { ...val, v: next };
        }

        if (newKey !== key) {
            deletes.add(key);
            writes.push({ key: newKey, val: newVal });
        } else if (newVal !== val) {
            writes.push({ key, val: newVal });
        }
    }

    for (const key of deletes) kv.delete(key);
    for (const w of writes) {
        // Explicit delete first: YKeyValue.set dedupes against its stale map, so
        // without this a key written twice in one transaction gets two entries.
        kv.delete(w.key);
        kv.set(w.key, w.val);
    }
}

/** Shift single-index-keyed metadata (rowMeta/colMeta). */
function shiftMetaKeys(kv, at, delta) {
    if (!kv || delta === 0) return;
    const moves = [];
    const removals = [];
    for (const [key, { val }] of kv.map) {
        const i = Number(key);
        if (isNaN(i) || i < at) continue;
        if (delta < 0 && i < at - delta) { removals.push(key); continue; }
        moves.push({ from: key, to: String(i + delta), val, pos: i });
    }
    for (const key of removals) kv.delete(key);
    moves.sort((a, b) => delta > 0 ? b.pos - a.pos : a.pos - b.pos);
    for (const m of moves) { kv.delete(m.from); kv.set(m.to, m.val); }
}

/** Shift border edge keys ("h,r,c" / "v,r,c") along one axis. */
function shiftBorderKeys(kv, axis, at, delta) {
    if (!kv || delta === 0) return;
    const moves = [];
    const removals = [];
    for (const [key, { val }] of kv.map) {
        const [type, rs, cs] = key.split(',');
        const r = Number(rs), c = Number(cs);
        if (isNaN(r) || isNaN(c)) continue;
        const pos = axis === 'row' ? r : c;
        if (pos < at) continue;
        if (delta < 0 && pos < at - delta) { removals.push(key); continue; }
        const nr = axis === 'row' ? r + delta : r;
        const nc = axis === 'col' ? c + delta : c;
        moves.push({ from: key, to: `${type},${nr},${nc}`, val, pos });
    }
    for (const key of removals) kv.delete(key);
    moves.sort((a, b) => delta > 0 ? b.pos - a.pos : a.pos - b.pos);
    for (const m of moves) { kv.delete(m.from); kv.set(m.to, m.val); }
}

/** Shift merge rectangles that sit at or past the edit point. */
function shiftMerges(sheet, axis, at, delta) {
    const arr = sheet.get('merges');
    if (!arr || delta === 0) return;
    const all = arr.toArray();
    const kept = [];
    for (const m of all) {
        if (!m) continue;
        const start = axis === 'row' ? m.startRow : m.startCol;
        const end = axis === 'row' ? m.endRow : m.endCol;
        if (end < at) { kept.push(m); continue; }
        // A merge fully inside a deleted band goes away with it.
        if (delta < 0 && start >= at && end < at - delta) continue;
        const next = { ...m };
        if (axis === 'row') {
            if (m.startRow >= at) next.startRow = m.startRow + delta;
            next.endRow = m.endRow + delta;
        } else {
            if (m.startCol >= at) next.startCol = m.startCol + delta;
            next.endCol = m.endCol + delta;
        }
        if (next.endRow >= next.startRow && next.endCol >= next.startCol) kept.push(next);
    }
    arr.delete(0, arr.length);
    if (kept.length) arr.insert(0, kept);
}

/**
 * Insert blank rows before a given 1-based row number.
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {number} beforeRow  1-based
 * @param {number} [count=1]
 */
export function insertRows(ydoc, sheetRef, beforeRow, count = 1) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const at = toRowIndex(beforeRow);
    const n = Math.max(1, count | 0);

    apiTransact(ydoc, () => {
        shiftCellKeys(mkCellValuesKV(sheet), 'row', at, n, adjustForRowInsert);
        shiftCellKeys(mkCellStylesKV(sheet), 'row', at, n);
        shiftMetaKeys(mkSheetKV(sheet, 'rowMeta'), at, n);
        shiftBorderKeys(mkSheetKV(sheet, 'borders'), 'row', at, n);
        shiftMerges(sheet, 'row', at, n);
        sheet.set('rowCount', (sheet.get('rowCount') ?? 0) + n);
    });
    return { inserted: n, at: beforeRow };
}

/**
 * Delete rows starting at a 1-based row number.
 */
export function deleteRows(ydoc, sheetRef, fromRow, count = 1) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const at = toRowIndex(fromRow);
    const n = Math.max(1, count | 0);

    apiTransact(ydoc, () => {
        shiftCellKeys(mkCellValuesKV(sheet), 'row', at, -n, adjustForRowDelete);
        shiftCellKeys(mkCellStylesKV(sheet), 'row', at, -n);
        shiftMetaKeys(mkSheetKV(sheet, 'rowMeta'), at, -n);
        shiftBorderKeys(mkSheetKV(sheet, 'borders'), 'row', at, -n);
        shiftMerges(sheet, 'row', at, -n);
        sheet.set('rowCount', Math.max(1, (sheet.get('rowCount') ?? 0) - n));
    });
    return { deleted: n, at: fromRow };
}

/**
 * Insert blank columns before a given column (letter or 0-based index).
 */
export function insertColumns(ydoc, sheetRef, beforeColumn, count = 1) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const at = toColIndex(beforeColumn);
    const n = Math.max(1, count | 0);

    apiTransact(ydoc, () => {
        shiftCellKeys(mkCellValuesKV(sheet), 'col', at, n, adjustForColInsert);
        shiftCellKeys(mkCellStylesKV(sheet), 'col', at, n);
        shiftMetaKeys(mkSheetKV(sheet, 'colMeta'), at, n);
        shiftBorderKeys(mkSheetKV(sheet, 'borders'), 'col', at, n);
        shiftMerges(sheet, 'col', at, n);
        sheet.set('colCount', (sheet.get('colCount') ?? 0) + n);
    });
    return { inserted: n, at: numToCol(at) };
}

/**
 * Delete columns starting at a given column (letter or 0-based index).
 */
export function deleteColumns(ydoc, sheetRef, fromColumn, count = 1) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const at = toColIndex(fromColumn);
    const n = Math.max(1, count | 0);

    apiTransact(ydoc, () => {
        shiftCellKeys(mkCellValuesKV(sheet), 'col', at, -n, adjustForColDelete);
        shiftCellKeys(mkCellStylesKV(sheet), 'col', at, -n);
        shiftMetaKeys(mkSheetKV(sheet, 'colMeta'), at, -n);
        shiftBorderKeys(mkSheetKV(sheet, 'borders'), 'col', at, -n);
        shiftMerges(sheet, 'col', at, -n);
        sheet.set('colCount', Math.max(1, (sheet.get('colCount') ?? 0) - n));
    });
    return { deleted: n, at: numToCol(at) };
}
