/**
 * a1.js — A1-notation parsing and formatting.
 *
 * Single source of truth for turning human/agent-facing range strings
 * ("B2", "B2:D10", "'My Sheet'!A1:C5") into 0-based coordinates and back.
 *
 * Built on refs.js colToNum/numToCol so column-letter maths lives in exactly
 * one place. Pure JS — no Svelte, no browser APIs, no Node-only modules — so
 * the browser client, the REST API and the MCP server all share it.
 *
 * Coordinates are always 0-based internally ({ row: 0, col: 0 } === "A1"),
 * matching the cell-key convention used throughout the Yjs schema.
 */

import { colToNum, numToCol } from './refs.js';

/** @typedef {{ row: number, col: number }} CellCoord */
/** @typedef {{ startRow: number, startCol: number, endRow: number, endCol: number }} RangeCoord */

// Single cell, with optional $ anchors: A1, $A$1, BC42
const CELL_RE = /^\$?([A-Z]+)\$?(\d+)$/;
// Whole-column band: A:A, $B:$D
const COL_BAND_RE = /^\$?([A-Z]+):\$?([A-Z]+)$/;
// Whole-row band: 1:1, 3:20
const ROW_BAND_RE = /^\$?(\d+):\$?(\d+)$/;

/**
 * Split an optional sheet qualifier off a reference.
 * Handles quoted names with escaped quotes: 'Bob''s Sheet'!A1
 *
 * @param {string} ref
 * @returns {{ sheetName: string|null, ref: string }}
 */
export function splitSheetRef(ref) {
    const s = String(ref).trim();
    const m = s.match(/^(?:'((?:[^']|'')*)'|([^'!][^!]*?))!(.+)$/);
    if (!m) return { sheetName: null, ref: s };
    const sheetName = (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]).trim();
    return { sheetName, ref: m[3].trim() };
}

/**
 * Parse a single A1 cell reference to 0-based coordinates.
 * @param {string} ref  e.g. "B3" or "$B$3"
 * @returns {CellCoord}
 * @throws {Error} when the reference is not a valid single cell
 */
export function parseA1Cell(ref) {
    const m = String(ref).trim().toUpperCase().match(CELL_RE);
    if (!m) throw new Error(`Invalid A1 cell reference: "${ref}"`);
    const row = parseInt(m[2], 10) - 1;
    if (row < 0) throw new Error(`Row number must be >= 1 in "${ref}"`);
    return { row, col: colToNum(m[1]) };
}

/**
 * Parse an A1 range to 0-based inclusive coordinates.
 *
 * Accepts:
 *   "B3"       → single cell as a 1x1 range
 *   "B3:D10"   → rectangle (normalised so start <= end)
 *   "A:C"      → whole columns; endRow is filled from `bounds.rowCount - 1`
 *   "2:5"      → whole rows; endCol is filled from `bounds.colCount - 1`
 *
 * Band forms need `bounds` to resolve their open dimension; without it they
 * throw, so callers can't silently read a zero-height range.
 *
 * @param {string} ref
 * @param {{ rowCount?: number, colCount?: number }} [bounds]
 * @returns {RangeCoord}
 */
export function parseA1Range(ref, bounds = {}) {
    const raw = String(ref).trim().toUpperCase();

    const colBand = raw.match(COL_BAND_RE);
    if (colBand) {
        if (bounds.rowCount == null) {
            throw new Error(`Whole-column range "${ref}" needs sheet bounds to resolve`);
        }
        const c1 = colToNum(colBand[1]);
        const c2 = colToNum(colBand[2]);
        return normaliseRange(0, Math.min(c1, c2), bounds.rowCount - 1, Math.max(c1, c2));
    }

    const rowBand = raw.match(ROW_BAND_RE);
    if (rowBand) {
        if (bounds.colCount == null) {
            throw new Error(`Whole-row range "${ref}" needs sheet bounds to resolve`);
        }
        const r1 = parseInt(rowBand[1], 10) - 1;
        const r2 = parseInt(rowBand[2], 10) - 1;
        return normaliseRange(Math.min(r1, r2), 0, Math.max(r1, r2), bounds.colCount - 1);
    }

    const parts = raw.split(':');
    if (parts.length > 2) throw new Error(`Invalid A1 range: "${ref}"`);
    const start = parseA1Cell(parts[0]);
    const end = parts[1] ? parseA1Cell(parts[1]) : start;
    return normaliseRange(start.row, start.col, end.row, end.col);
}

/**
 * Parse a possibly sheet-qualified range in one step.
 * @param {string} ref  e.g. "'Q3 Data'!B2:D10"
 * @param {{ rowCount?: number, colCount?: number }} [bounds]
 * @returns {RangeCoord & { sheetName: string|null }}
 */
export function parseA1(ref, bounds = {}) {
    const { sheetName, ref: bare } = splitSheetRef(ref);
    return { sheetName, ...parseA1Range(bare, bounds) };
}

/** Order a rectangle so start <= end on both axes, and clamp negatives to 0. */
function normaliseRange(r1, c1, r2, c2) {
    return {
        startRow: Math.max(0, Math.min(r1, r2)),
        startCol: Math.max(0, Math.min(c1, c2)),
        endRow:   Math.max(0, Math.max(r1, r2)),
        endCol:   Math.max(0, Math.max(c1, c2)),
    };
}

/**
 * Format 0-based coordinates as an A1 cell reference.
 * @param {number} row
 * @param {number} col
 * @returns {string}
 */
export function formatA1Cell(row, col) {
    return `${numToCol(col)}${row + 1}`;
}

/**
 * Format a 0-based inclusive rectangle as an A1 range.
 * Collapses to a single cell reference when the rectangle is 1x1.
 * @param {number} startRow
 * @param {number} startCol
 * @param {number} endRow
 * @param {number} endCol
 * @returns {string}
 */
export function formatA1Range(startRow, startCol, endRow, endCol) {
    if (startRow === endRow && startCol === endCol) return formatA1Cell(startRow, startCol);
    return `${formatA1Cell(startRow, startCol)}:${formatA1Cell(endRow, endCol)}`;
}

/**
 * Quote a sheet name for use in a qualified reference, if it needs quoting.
 * @param {string} name
 * @returns {string}
 */
export function quoteSheetName(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
        ? name
        : `'${String(name).replace(/'/g, "''")}'`;
}

/**
 * Build a fully-qualified A1 range string.
 * @param {string|null} sheetName
 * @param {number} startRow
 * @param {number} startCol
 * @param {number} endRow
 * @param {number} endCol
 * @returns {string}
 */
export function formatQualifiedRange(sheetName, startRow, startCol, endRow, endCol) {
    const r = formatA1Range(startRow, startCol, endRow, endCol);
    return sheetName ? `${quoteSheetName(sheetName)}!${r}` : r;
}

/** Number of cells a range covers. */
export function rangeArea(range) {
    return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
}

/**
 * Iterate every coordinate in a range, row-major.
 * @param {RangeCoord} range
 * @yields {CellCoord}
 */
export function* iterRange(range) {
    for (let row = range.startRow; row <= range.endRow; row++) {
        for (let col = range.startCol; col <= range.endCol; col++) {
            yield { row, col };
        }
    }
}
