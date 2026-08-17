/**
 * ops/formatOps.js — The design surface: layout, structure and visual rules.
 *
 * Everything here was previously reachable only through the Svelte UI, which is
 * why a script or agent could enter data but not lay a sheet out. Storage
 * shapes mirror SheetStore exactly (rowMeta/colMeta entries, `h,r,c`/`v,r,c`
 * border edge keys, plain-object merges, `{condition, threshold}` rules), so
 * the browser renders API-authored formatting with no translation layer.
 *
 * Row and column arguments accept the notation an agent naturally writes:
 * columns as letters ("A") or 0-based indices, rows as 1-based numbers matching
 * the row headers a user sees.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import { parseA1Range, formatA1Range } from '../../../formulas/a1.js';
import { colToNum } from '../../../formulas/refs.js';
import { compactBorderStyle } from '../cells/styleNormalize.js';
import {
    resolveSheet, sheetBounds, mkSheetKV, apiTransact, prepareForWrite, OpError,
} from './context.js';

export { formatRange } from './cellOps.js';

/** Conditions understood by the renderer (see CellPaintData.matchesCondition). */
export const CF_CONDITIONS = ['gt', 'lt', 'gte', 'lte', 'eq', 'neq', 'contains', 'formula'];

const DEFAULT_ROW_HEIGHT = 24;
const DEFAULT_COL_WIDTH = 100;

/** Column letter or index → 0-based index. */
function toColIndex(key) {
    if (typeof key === 'number') return key;
    const s = String(key).trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (/^[A-Za-z]+$/.test(s)) return colToNum(s.toUpperCase());
    throw new OpError('INVALID_COLUMN', `Not a column reference: "${key}"`);
}

/** 1-based row number → 0-based index. */
function toRowIndex(key) {
    const n = typeof key === 'number' ? key : parseInt(String(key), 10);
    if (isNaN(n) || n < 1) throw new OpError('INVALID_ROW', `Row must be a number >= 1, got "${key}"`);
    return n - 1;
}

// ─── Column widths / row heights ───────────────────────────────────────────

/**
 * Set widths for one or more columns.
 *
 * Mirrors SheetStore.setColWidth: a width equal to the sheet default deletes
 * the entry rather than storing a no-op, which is what keeps colMeta from
 * accumulating one dead record per column an agent ever touches.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {Record<string, number>} widths  e.g. { A: 220, B: 90 } or { 0: 220 }
 * @returns {{ updated: number }}
 */
export function setColumnWidths(ydoc, sheetRef, widths) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const kv = mkSheetKV(sheet, 'colMeta');
    if (!kv) throw new OpError('NO_COL_META', 'Sheet has no colMeta store');
    const def = sheet.get('defaultColWidth') ?? DEFAULT_COL_WIDTH;

    let updated = 0;
    apiTransact(ydoc, () => {
        for (const [k, width] of Object.entries(widths)) {
            const key = String(toColIndex(k));
            const { width: _drop, ...rest } = kv.get(key) ?? {};
            if (width === def) {
                if (Object.keys(rest).length) kv.set(key, rest); else kv.delete(key);
            } else {
                kv.set(key, { ...rest, width });
            }
            updated++;
        }
    });
    return { updated };
}

/**
 * Set heights for one or more rows, keyed by 1-based row number.
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {Record<string, number>} heights  e.g. { 1: 40 }
 * @returns {{ updated: number }}
 */
export function setRowHeights(ydoc, sheetRef, heights) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const kv = mkSheetKV(sheet, 'rowMeta');
    if (!kv) throw new OpError('NO_ROW_META', 'Sheet has no rowMeta store');
    const def = sheet.get('defaultRowHeight') ?? DEFAULT_ROW_HEIGHT;

    let updated = 0;
    apiTransact(ydoc, () => {
        for (const [k, height] of Object.entries(heights)) {
            const key = String(toRowIndex(k));
            const { height: _drop, ...rest } = kv.get(key) ?? {};
            if (height === def) {
                if (Object.keys(rest).length) kv.set(key, rest); else kv.delete(key);
            } else {
                kv.set(key, { ...rest, height });
            }
            updated++;
        }
    });
    return { updated };
}

/** Effective width of a column (falls back to the sheet default). */
export function getColumnWidth(ydoc, sheetRef, column) {
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const kv = mkSheetKV(sheet, 'colMeta');
    const entry = kv?.get(String(toColIndex(column)));
    return entry?.width ?? sheet.get('defaultColWidth') ?? DEFAULT_COL_WIDTH;
}

/** Effective height of a row (1-based). */
export function getRowHeight(ydoc, sheetRef, row) {
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const kv = mkSheetKV(sheet, 'rowMeta');
    const entry = kv?.get(String(toRowIndex(row)));
    return entry?.height ?? sheet.get('defaultRowHeight') ?? DEFAULT_ROW_HEIGHT;
}

/**
 * Show or hide rows/columns.
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {'rows'|'columns'} axis
 * @param {Array<string|number>} keys
 * @param {boolean} hidden
 */
export function setHidden(ydoc, sheetRef, axis, keys, hidden) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const metaKey = axis === 'rows' ? 'rowMeta' : 'colMeta';
    const kv = mkSheetKV(sheet, metaKey);
    if (!kv) throw new OpError('NO_META', `Sheet has no ${metaKey} store`);
    const toIndex = axis === 'rows' ? toRowIndex : toColIndex;

    apiTransact(ydoc, () => {
        for (const k of keys) {
            const key = String(toIndex(k));
            const { hidden: _drop, ...rest } = kv.get(key) ?? {};
            if (hidden) kv.set(key, { ...rest, hidden: true });
            else if (Object.keys(rest).length) kv.set(key, rest);
            else kv.delete(key);
        }
    });
    return { updated: keys.length };
}

// ─── Frozen panes ──────────────────────────────────────────────────────────

/**
 * Freeze header rows/columns so they stay visible while scrolling.
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {{ rows?: number, columns?: number }} panes
 */
export function setFrozenPanes(ydoc, sheetRef, panes) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    apiTransact(ydoc, () => {
        if (panes.rows != null) sheet.set('frozenRows', Math.max(0, panes.rows | 0));
        if (panes.columns != null) sheet.set('frozenColumns', Math.max(0, panes.columns | 0));
    });
    return getFrozenPanes(ydoc, sheetRef);
}

/** @returns {{ rows: number, columns: number }} */
export function getFrozenPanes(ydoc, sheetRef) {
    const { sheet } = resolveSheet(ydoc, sheetRef);
    return {
        rows: sheet.get('frozenRows') ?? 0,
        columns: sheet.get('frozenColumns') ?? 0,
    };
}

// ─── Merges ────────────────────────────────────────────────────────────────

/** @returns {Array<{startRow,startCol,endRow,endCol}>} */
function readMerges(sheet) {
    const arr = sheet.get('merges');
    if (!arr) return [];
    return arr.toArray().filter(m =>
        m && typeof m.startRow === 'number' && typeof m.startCol === 'number' &&
        typeof m.endRow === 'number' && typeof m.endCol === 'number');
}

function overlaps(a, b) {
    return !(a.startRow > b.endRow || a.endRow < b.startRow ||
             a.startCol > b.endCol || a.endCol < b.startCol);
}

/** All merged regions on a sheet, as A1 range strings. */
export function listMerges(ydoc, sheetRef) {
    const { sheet } = resolveSheet(ydoc, sheetRef);
    return readMerges(sheet).map(m => formatA1Range(m.startRow, m.startCol, m.endRow, m.endCol));
}

/**
 * Merge a range into a single cell.
 *
 * Refuses to merge across an existing merge rather than silently replacing it —
 * an agent laying out a header row should hear about the collision, not
 * discover later that it destroyed someone's layout.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {string} rangeRef
 */
export function mergeCells(ydoc, sheetRef, rangeRef) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const range = parseA1Range(rangeRef, sheetBounds(sheet));
    if (range.startRow === range.endRow && range.startCol === range.endCol) {
        throw new OpError('MERGE_SINGLE_CELL', `"${rangeRef}" is a single cell; nothing to merge`);
    }

    const existing = readMerges(sheet);
    const clash = existing.find(m => overlaps(m, range));
    if (clash) {
        throw new OpError('MERGE_OVERLAP',
            `Range ${rangeRef} overlaps an existing merge at ` +
            `${formatA1Range(clash.startRow, clash.startCol, clash.endRow, clash.endCol)}. ` +
            `Unmerge it first.`,
            { existing: formatA1Range(clash.startRow, clash.startCol, clash.endRow, clash.endCol) });
    }

    apiTransact(ydoc, () => {
        let arr = sheet.get('merges');
        if (!arr) throw new OpError('NO_MERGES', 'Sheet has no merges store');
        arr.push([{ ...range }]);
    });
    return { range: formatA1Range(range.startRow, range.startCol, range.endRow, range.endCol) };
}

/**
 * Remove any merge overlapping the given range.
 * @returns {{ removed: number }}
 */
export function unmergeCells(ydoc, sheetRef, rangeRef) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const range = parseA1Range(rangeRef, sheetBounds(sheet));
    const arr = sheet.get('merges');
    if (!arr) return { removed: 0 };

    let removed = 0;
    apiTransact(ydoc, () => {
        // Walk backwards so indices stay valid as we delete.
        const all = arr.toArray();
        for (let i = all.length - 1; i >= 0; i--) {
            const m = all[i];
            if (m && overlaps(m, range)) { arr.delete(i, 1); removed++; }
        }
    });
    return { removed };
}

// ─── Borders ───────────────────────────────────────────────────────────────

/**
 * Apply borders to a range.
 *
 * Edge keys follow SheetStore's convention: `h,row,col` is the horizontal edge
 * BELOW (row,col) and `v,row,col` the vertical edge to its RIGHT, so a cell's
 * top edge is `h,row-1,col` and its left edge is `v,row,col-1`.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {string} rangeRef
 * @param {{
 *   outline?: object|null, inner?: object|null,
 *   top?: object|null, bottom?: object|null, left?: object|null, right?: object|null
 * }} spec  Each value is { style?, width?, color? }, or null to clear that edge
 * @returns {{ range: string, edges: number }}
 */
export function setBorders(ydoc, sheetRef, rangeRef, spec) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const range = parseA1Range(rangeRef, sheetBounds(sheet));
    const kv = mkSheetKV(sheet, 'borders');
    if (!kv) throw new OpError('NO_BORDERS', 'Sheet has no borders store');

    const { startRow, startCol, endRow, endCol } = range;
    let edges = 0;

    const put = (key, style) => {
        if (style === null) { kv.delete(key); }
        else { kv.set(key, compactBorderStyle(style)); }
        edges++;
    };

    apiTransact(ydoc, () => {
        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                const onTop = r === startRow, onBottom = r === endRow;
                const onLeft = c === startCol, onRight = c === endCol;

                if (spec.outline !== undefined) {
                    if (onTop)    put(`h,${r - 1},${c}`, spec.outline);
                    if (onBottom) put(`h,${r},${c}`,     spec.outline);
                    if (onLeft)   put(`v,${r},${c - 1}`, spec.outline);
                    if (onRight)  put(`v,${r},${c}`,     spec.outline);
                }
                if (spec.inner !== undefined) {
                    if (!onBottom) put(`h,${r},${c}`, spec.inner);
                    if (!onRight)  put(`v,${r},${c}`, spec.inner);
                }
                if (spec.top !== undefined && onTop)       put(`h,${r - 1},${c}`, spec.top);
                if (spec.bottom !== undefined && onBottom) put(`h,${r},${c}`,     spec.bottom);
                if (spec.left !== undefined && onLeft)     put(`v,${r},${c - 1}`, spec.left);
                if (spec.right !== undefined && onRight)   put(`v,${r},${c}`,     spec.right);
            }
        }
    });

    return { range: formatA1Range(startRow, startCol, endRow, endCol), edges };
}

/** Every stored border edge, as `{ edge, style }` records. */
export function listBorders(ydoc, sheetRef) {
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const kv = mkSheetKV(sheet, 'borders');
    if (!kv) return [];
    return [...kv.map.entries()].map(([edge, { val }]) => ({ edge, style: val }));
}

// ─── Conditional formatting ────────────────────────────────────────────────

/**
 * Add a conditional-format rule.
 *
 * Stored in the client's shape: { id, startRow, startCol, endRow, endCol,
 * condition, threshold, style }. `condition` must be one of CF_CONDITIONS.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {{ range: string, condition: string, threshold?: any, formula?: string, style: object }} rule
 * @returns {object} The stored rule, including its generated id
 */
export function addConditionalFormat(ydoc, sheetRef, rule) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);

    if (!CF_CONDITIONS.includes(rule.condition)) {
        throw new OpError('INVALID_CONDITION',
            `Unknown condition "${rule.condition}"`, { allowed: CF_CONDITIONS });
    }
    if (!rule.style || typeof rule.style !== 'object') {
        throw new OpError('INVALID_RULE', 'Conditional format needs a style object');
    }

    const range = parseA1Range(rule.range, sheetBounds(sheet));
    const stored = {
        id: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startRow: range.startRow, startCol: range.startCol,
        endRow: range.endRow, endCol: range.endCol,
        condition: rule.condition,
        threshold: rule.threshold ?? null,
        ...(rule.condition === 'formula' ? { formula: rule.formula ?? '' } : {}),
        style: rule.style,
    };

    apiTransact(ydoc, () => {
        const arr = sheet.get('conditionalFormats');
        if (!arr) throw new OpError('NO_CF', 'Sheet has no conditionalFormats store');
        arr.push([stored]);
    });
    return stored;
}

/** All conditional-format rules on a sheet, with their ranges as A1 strings. */
export function listConditionalFormats(ydoc, sheetRef) {
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const arr = sheet.get('conditionalFormats');
    if (!arr) return [];
    return arr.toArray().map(r => ({
        ...r,
        range: formatA1Range(r.startRow, r.startCol, r.endRow, r.endCol),
    }));
}

/** Remove a rule by id. @returns {{ removed: boolean }} */
export function removeConditionalFormat(ydoc, sheetRef, id) {
    prepareForWrite(ydoc);
    const { sheet } = resolveSheet(ydoc, sheetRef);
    const arr = sheet.get('conditionalFormats');
    if (!arr) return { removed: false };

    let removed = false;
    apiTransact(ydoc, () => {
        const idx = arr.toArray().findIndex(r => r?.id === id);
        if (idx !== -1) { arr.delete(idx, 1); removed = true; }
    });
    return { removed };
}
