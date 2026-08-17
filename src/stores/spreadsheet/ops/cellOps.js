/**
 * ops/cellOps.js — Cell and range operations in A1 notation.
 *
 * The agent-facing read/write surface for the grid. Three things distinguish
 * these from raw Yjs access:
 *
 *   1. Styles go through the palette (cells/styleAccess.js), so reads return
 *      real formatting instead of a `{ s: <sid> }` ref and writes dedupe.
 *   2. Reads evaluate formulas by default, so a caller sees 42 rather than
 *      "=SUM(A1:A10)" — with the formula still available alongside.
 *   3. Writes echo back what was persisted, so a caller can confirm the result
 *      without a follow-up read.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import { parseA1Cell, parseA1Range, formatA1Cell, formatA1Range, rangeArea } from '../../../formulas/a1.js';
import { CELL_VALUE_KEY_SET } from '../cells/CellShape.js';
import { getStylePalette, readCellStyle, mergeCellStyle, writeCellStyle } from '../cells/styleAccess.js';
import {
    resolveSheet, sheetBounds, mkCellValuesKV, mkCellStylesKV,
    apiTransact, prepareForWrite, OpError,
} from './context.js';
import { createDocEvaluator } from './evalOps.js';

/** Guard rail: refuse range reads/writes large enough to blow up a response. */
const MAX_RANGE_CELLS = 50_000;

/**
 * Bundle the per-sheet accessors an op needs.
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef  sheet ID or name
 */
function sheetCtx(ydoc, sheetRef) {
    const { id, sheet } = resolveSheet(ydoc, sheetRef);
    return {
        id,
        sheet,
        values: mkCellValuesKV(sheet),
        styles: mkCellStylesKV(sheet),
        palette: getStylePalette(ydoc),
        bounds: sheetBounds(sheet),
    };
}

/** Split a props bag into value-store and style-store halves. */
function splitProps(props) {
    const value = {};
    const style = {};
    for (const [k, v] of Object.entries(props ?? {})) {
        if (CELL_VALUE_KEY_SET.has(k)) value[k] = v;
        else style[k] = v;
    }
    return { value, style };
}

function assertRangeSize(range, what) {
    const area = rangeArea(range);
    if (area > MAX_RANGE_CELLS) {
        throw new OpError('RANGE_TOO_LARGE',
            `${what} covers ${area} cells, over the ${MAX_RANGE_CELLS} limit. Work in smaller blocks.`,
            { cells: area, limit: MAX_RANGE_CELLS });
    }
    return area;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * Read one cell.
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {string} ref  A1 reference, e.g. "B3"
 * @param {{ evaluate?: boolean }} [opts]
 * @returns {{ ref, value, formula: string|null, style: object|null, type: string|null, empty: boolean }}
 */
export function getCell(ydoc, sheetRef, ref, opts = {}) {
    const ctx = sheetCtx(ydoc, sheetRef);
    const { row, col } = parseA1Cell(ref);
    const evaluator = opts.evaluate === false ? null : createDocEvaluator(ydoc);
    return readCellAt(ctx, row, col, evaluator);
}

/**
 * Read a rectangular range.
 *
 * Returns a `values` grid (what the user sees) plus, when requested, parallel
 * `formulas` and `styles` grids. Empty cells are null throughout.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {string} rangeRef  e.g. "A1:D20", "B:B", "Sheet2!A1:C3"
 * @param {{ evaluate?: boolean, includeStyles?: boolean, includeFormulas?: boolean }} [opts]
 */
export function getRange(ydoc, sheetRef, rangeRef, opts = {}) {
    const ctx = sheetCtx(ydoc, sheetRef);
    const range = parseA1Range(rangeRef, ctx.bounds);
    assertRangeSize(range, 'Range');

    const evaluator = opts.evaluate === false ? null : createDocEvaluator(ydoc);
    const values = [];
    const formulas = opts.includeFormulas ? [] : null;
    const styles = opts.includeStyles ? [] : null;

    for (let row = range.startRow; row <= range.endRow; row++) {
        const vRow = [], fRow = [], sRow = [];
        for (let col = range.startCol; col <= range.endCol; col++) {
            const cell = readCellAt(ctx, row, col, evaluator);
            vRow.push(cell.value);
            if (formulas) fRow.push(cell.formula);
            if (styles) sRow.push(cell.style);
        }
        values.push(vRow);
        if (formulas) formulas.push(fRow);
        if (styles) styles.push(sRow);
    }

    return {
        sheet: ctx.sheet.get('name') ?? ctx.id,
        range: formatA1Range(range.startRow, range.startCol, range.endRow, range.endCol),
        rows: values.length,
        cols: values[0]?.length ?? 0,
        values,
        ...(formulas ? { formulas } : {}),
        ...(styles ? { styles } : {}),
    };
}

/** Shared single-cell read used by getCell/getRange/echo. */
function readCellAt(ctx, row, col, evaluator) {
    const key = `${row},${col}`;
    const val = ctx.values?.get(key) ?? null;
    const style = readCellStyle(ctx.palette, ctx.styles, key);
    const raw = val?.v ?? null;
    const isFormula = typeof raw === 'string' && raw.startsWith('=');

    return {
        ref: formatA1Cell(row, col),
        value: isFormula && evaluator ? evaluator.getValue(ctx.id, row, col) : raw,
        formula: isFormula ? raw : null,
        style: style ?? null,
        type: val?.t ?? null,
        empty: val == null && style == null,
    };
}

// ─── Writes ────────────────────────────────────────────────────────────────

/**
 * Write a single cell's value and/or formatting.
 *
 * A value starting with "=" is stored as a formula. Style props are merged into
 * the cell's existing style, so setting `{ bold: true }` doesn't drop its
 * number format; pass null for a prop to clear just that one.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {string} ref
 * @param {any} value  Pass undefined to change formatting only
 * @param {object} [props]
 * @returns {object} The cell as persisted
 */
export function setCell(ydoc, sheetRef, ref, value, props = {}) {
    prepareForWrite(ydoc);
    const ctx = sheetCtx(ydoc, sheetRef);
    const { row, col } = parseA1Cell(ref);

    apiTransact(ydoc, () => writeCellAt(ctx, row, col, value, props));

    return readCellAt(ctx, row, col, createDocEvaluator(ydoc));
}

/**
 * Write a 2-D block of values anchored at a cell.
 *
 * `null` entries leave the target cell untouched (use clearRange to erase).
 * Rows may be ragged; each is written as far as it goes.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {string} anchorRef  Top-left cell, e.g. "A1"
 * @param {any[][]} values
 * @param {object} [props]  Formatting applied to every written cell
 * @returns {{ range: string, written: number }}
 */
export function setRange(ydoc, sheetRef, anchorRef, values, props = {}) {
    prepareForWrite(ydoc);
    const ctx = sheetCtx(ydoc, sheetRef);
    const { row: r0, col: c0 } = parseA1Cell(anchorRef);

    if (!Array.isArray(values) || !values.every(Array.isArray)) {
        throw new OpError('INVALID_VALUES', 'setRange expects a 2-D array of values');
    }
    const height = values.length;
    const width = values.reduce((m, r) => Math.max(m, r.length), 0);
    assertRangeSize({ startRow: r0, startCol: c0, endRow: r0 + height - 1, endCol: c0 + width - 1 }, 'Block');

    let written = 0;
    apiTransact(ydoc, () => {
        for (let ri = 0; ri < height; ri++) {
            const rowArr = values[ri];
            for (let ci = 0; ci < rowArr.length; ci++) {
                if (rowArr[ci] === null || rowArr[ci] === undefined) continue;
                writeCellAt(ctx, r0 + ri, c0 + ci, rowArr[ci], props);
                written++;
            }
        }
    });

    growSheetToFit(ydoc, ctx, r0 + height - 1, c0 + width - 1);

    return {
        range: formatA1Range(r0, c0, r0 + height - 1, c0 + Math.max(0, width - 1)),
        written,
    };
}

/**
 * Apply formatting to every cell in a range without touching values.
 * The workhorse for design work — one call instead of one per cell.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {string} rangeRef
 * @param {object} style  Style props; null values clear that property
 * @returns {{ range: string, cells: number }}
 */
export function formatRange(ydoc, sheetRef, rangeRef, style) {
    prepareForWrite(ydoc);
    const ctx = sheetCtx(ydoc, sheetRef);
    const range = parseA1Range(rangeRef, ctx.bounds);
    const area = assertRangeSize(range, 'Range');

    const { value: valueProps, style: styleProps } = splitProps(style);

    apiTransact(ydoc, () => {
        for (let row = range.startRow; row <= range.endRow; row++) {
            for (let col = range.startCol; col <= range.endCol; col++) {
                const key = `${row},${col}`;
                if (Object.keys(styleProps).length) {
                    mergeCellStyle(ctx.palette, ctx.styles, key, styleProps);
                }
                if (Object.keys(valueProps).length) {
                    ctx.values?.set(key, { ...(ctx.values.get(key) ?? {}), ...valueProps });
                }
            }
        }
    });

    return {
        range: formatA1Range(range.startRow, range.startCol, range.endRow, range.endCol),
        cells: area,
    };
}

/**
 * Clear cell contents and/or formatting across a range.
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @param {string} rangeRef
 * @param {{ contents?: boolean, formats?: boolean }} [opts]  Defaults to contents only
 * @returns {{ range: string, cleared: number }}
 */
export function clearRange(ydoc, sheetRef, rangeRef, opts = {}) {
    prepareForWrite(ydoc);
    const ctx = sheetCtx(ydoc, sheetRef);
    const range = parseA1Range(rangeRef, ctx.bounds);
    const area = assertRangeSize(range, 'Range');

    const contents = opts.contents !== false;
    const formats = opts.formats === true;

    apiTransact(ydoc, () => {
        for (let row = range.startRow; row <= range.endRow; row++) {
            for (let col = range.startCol; col <= range.endCol; col++) {
                const key = `${row},${col}`;
                if (contents) ctx.values?.delete(key);
                if (formats) writeCellStyle(ctx.palette, ctx.styles, key, null);
            }
        }
    });

    return {
        range: formatA1Range(range.startRow, range.startCol, range.endRow, range.endCol),
        cleared: area,
    };
}

/** Write one cell inside an existing transaction. */
function writeCellAt(ctx, row, col, value, props) {
    const key = `${row},${col}`;
    const { value: valueProps, style: styleProps } = splitProps(props);

    if (value !== undefined) valueProps.v = value;

    if (Object.keys(valueProps).length) {
        ctx.values?.set(key, { ...(ctx.values.get(key) ?? {}), ...valueProps });
    }
    if (Object.keys(styleProps).length) {
        mergeCellStyle(ctx.palette, ctx.styles, key, styleProps);
    }
}

/**
 * Extend a sheet's declared dimensions so written cells fall inside them.
 * Without this, a write past the edge is invisible in the UI.
 */
function growSheetToFit(ydoc, ctx, maxRow, maxCol) {
    const rowCount = ctx.sheet.get('rowCount') ?? 0;
    const colCount = ctx.sheet.get('colCount') ?? 0;
    if (maxRow < rowCount && maxCol < colCount) return;
    apiTransact(ydoc, () => {
        if (maxRow >= rowCount) ctx.sheet.set('rowCount', maxRow + 1);
        if (maxCol >= colCount) ctx.sheet.set('colCount', maxCol + 1);
    });
}

// ─── Introspection ─────────────────────────────────────────────────────────

/**
 * The bounding box of cells that actually hold data.
 *
 * Sheets declare generous rowCount/colCount (1000x26 by default), so an agent
 * that trusts those reads mostly emptiness. This reports where content really
 * is, and is the basis of describeFile's per-sheet summary.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} sheetRef
 * @returns {{ range: string|null, rows: number, cols: number, nonEmpty: number }}
 */
export function getUsedRange(ydoc, sheetRef) {
    const ctx = sheetCtx(ydoc, sheetRef);
    let minRow = Infinity, minCol = Infinity, maxRow = -1, maxCol = -1, nonEmpty = 0;

    const scan = (kv) => {
        if (!kv) return;
        for (const key of kv.map.keys()) {
            const [r, c] = key.split(',').map(Number);
            if (isNaN(r) || isNaN(c)) continue;
            if (r < minRow) minRow = r;
            if (c < minCol) minCol = c;
            if (r > maxRow) maxRow = r;
            if (c > maxCol) maxCol = c;
        }
    };
    scan(ctx.values);
    scan(ctx.styles);
    nonEmpty = ctx.values?.map.size ?? 0;

    if (maxRow < 0) return { range: null, rows: 0, cols: 0, nonEmpty: 0 };
    return {
        range: formatA1Range(minRow, minCol, maxRow, maxCol),
        rows: maxRow - minRow + 1,
        cols: maxCol - minCol + 1,
        nonEmpty,
    };
}
