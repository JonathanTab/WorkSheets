/**
 * refCoords - Cell coordinate ↔ reference string utilities.
 *
 * Pure functions with no dependencies. Used by formula parsing, rendering,
 * and anywhere a cell address needs to be converted to/from "A1" notation.
 */

/**
 * Parse a cell reference string (e.g. "A1", "$B$2") → {row, col} (0-indexed).
 * Returns null for invalid input.
 * @param {string} ref
 * @returns {{ row: number, col: number } | null}
 */
export function parseCellRef(ref) {
    const clean = ref.replace(/\$/g, '');
    const match = clean.match(/^([A-Za-z]+)(\d+)$/);
    if (!match) return null;
    const colStr = match[1].toUpperCase();
    let col = 0;
    for (let i = 0; i < colStr.length; i++) col = col * 26 + (colStr.charCodeAt(i) - 64);
    return { row: parseInt(match[2], 10) - 1, col: col - 1 };
}

/**
 * Convert 0-indexed (row, col) → cell reference string (e.g. "A1").
 * @param {number} row
 * @param {number} col
 * @returns {string}
 */
export function toCellRef(row, col) {
    let colStr = '';
    let c = col;
    do {
        colStr = String.fromCharCode(65 + (c % 26)) + colStr;
        c = Math.floor(c / 26) - 1;
    } while (c >= 0);
    return colStr + (row + 1);
}

/**
 * Convert a rectangular range → reference string (e.g. "A1:B5").
 * Collapses to a single cell ref when the range is 1×1.
 * @param {number} startRow
 * @param {number} startCol
 * @param {number} endRow
 * @param {number} endCol
 * @returns {string}
 */
export function toRangeRef(startRow, startCol, endRow, endCol) {
    if (startRow === endRow && startCol === endCol) return toCellRef(startRow, startCol);
    return `${toCellRef(startRow, startCol)}:${toCellRef(endRow, endCol)}`;
}
