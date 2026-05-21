/**
 * CellShape.js — Declarative cell-property table.
 *
 * Single source of truth for which properties a cell can have and where
 * they live in Yjs storage (cellValues vs cellStyles YKeyValue).
 *
 * Usage:
 *   import { CELL_SHAPE, CELL_VALUE_KEY_SET, CELL_STYLE_KEY_SET } from './CellShape.js';
 *
 *   // Build a render object for any cell:
 *   const render = {};
 *   for (const { key, default: def } of CELL_SHAPE) render[key] = cell[key] ?? def;
 *
 *   // Route a write to the right Yjs store:
 *   const dest = CELL_SHAPE_BY_KEY.get(key)?.dest; // 'value' | 'style'
 *
 * Adding a new property like textRotation is a single-line change here;
 * all consumers that iterate the shape automatically pick it up.
 */

/** @typedef {{ key: string, dest: 'value'|'style', default: any }} CellProp */

/** @type {CellProp[]} */
export const CELL_SHAPE = [
    // ── Value store (cellValues YKeyValue) ─────────────────────────────────────
    // Computational data — drives formula evaluation and type coercion.
    { key: 'v',               dest: 'value', default: undefined },
    { key: 't',               dest: 'value', default: undefined },
    { key: 'tfr',             dest: 'value', default: null },

    // ── Style store (cellStyles YKeyValue) ─────────────────────────────────────
    // Display/config data — drives rendering, not computation.
    { key: 'ct',              dest: 'style', default: null },
    { key: 'protected',       dest: 'style', default: undefined },
    { key: 'fontFamily',      dest: 'style', default: null },
    { key: 'fontSize',        dest: 'style', default: null },
    { key: 'bold',            dest: 'style', default: null },
    { key: 'italic',          dest: 'style', default: null },
    { key: 'underline',       dest: 'style', default: null },
    { key: 'strikethrough',   dest: 'style', default: null },
    { key: 'color',           dest: 'style', default: null },
    { key: 'backgroundColor', dest: 'style', default: null },
    { key: 'border',          dest: 'style', default: null },
    { key: 'horizontalAlign', dest: 'style', default: null },
    { key: 'verticalAlign',   dest: 'style', default: null },
    { key: 'wrapText',        dest: 'style', default: null },
    { key: 'numberFormat',    dest: 'style', default: null },
];

/** Fast lookup: key → CellProp */
export const CELL_SHAPE_BY_KEY = new Map(CELL_SHAPE.map(p => [p.key, p]));

/** Keys that live in cellValues (used to route writes and reads). */
export const CELL_VALUE_KEY_SET = new Set(
    CELL_SHAPE.filter(p => p.dest === 'value').map(p => p.key)
);

/** Keys that live in cellStyles (used to route writes and reads). */
export const CELL_STYLE_KEY_SET = new Set(
    CELL_SHAPE.filter(p => p.dest === 'style').map(p => p.key)
);

/**
 * Build a full render-ready cell object from raw value and style records.
 * Returns an object with all shape keys populated (undefined for missing).
 * @param {object|null} val  - cellValues record for this cell
 * @param {object|null} sty  - cellStyles record for this cell
 * @returns {object}
 */
export function buildCellRenderObject(val, sty) {
    const out = { exists: !!(val || sty) };
    for (const { key, dest, default: def } of CELL_SHAPE) {
        const src = dest === 'value' ? val : sty;
        out[key] = src != null && key in src ? src[key] : def;
    }
    return out;
}
