/**
 * refs.js — Canonical spreadsheet cell-reference utilities.
 *
 * Single source of truth for:
 *   - Column letter ↔ 0-based number conversion
 *   - Formula reference adjustment (paste offset, row/col insert/delete)
 *
 * All adjusters protect double-quoted string literals so a formula like
 *   ="Cell A1 value"  is never corrupted.
 *
 * Consumers: SheetStore (row/col insert-delete), ClipboardManager (paste-adjust).
 */

// ── Column helpers ─────────────────────────────────────────────────────────────

/**
 * Convert column letters to a 0-based number.
 * "A" → 0, "B" → 1, "Z" → 25, "AA" → 26
 * @param {string} col
 * @returns {number}
 */
export function colToNum(col) {
    let num = 0;
    for (let i = 0; i < col.length; i++) {
        num = num * 26 + (col.charCodeAt(i) - 64);
    }
    return num - 1;
}

/**
 * Convert a 0-based column number to letters.
 * 0 → "A", 1 → "B", 25 → "Z", 26 → "AA"
 * @param {number} num
 * @returns {string}
 */
export function numToCol(num) {
    let col = '';
    num++;
    while (num > 0) {
        num--;
        col = String.fromCharCode(65 + (num % 26)) + col;
        num = Math.floor(num / 26);
    }
    return col;
}

// ── String-literal protection ──────────────────────────────────────────────────

/**
 * Run `fn` on a formula with all double-quoted string literals replaced by
 * NUL-delimited placeholders, then restore them in the result.
 * Handles escaped quotes inside strings (e.g. "say \"hi\"").
 * @param {string} formula
 * @param {(stripped: string) => string} fn
 * @returns {string}
 */
function withLiteralProtection(formula, fn) {
    const literals = [];
    const stripped = formula.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
        literals.push(m);
        return `\x00${literals.length - 1}\x00`;
    });
    const result = fn(stripped);
    if (literals.length === 0) return result;
    return result.replace(/\x00(\d+)\x00/g, (_p, i) => literals[+i]);
}

// ── Cell-ref regex ─────────────────────────────────────────────────────────────
// Matches A1-style refs: optional $ before col, 1+ uppercase letters, optional $ before row, 1+ digits.
const REF_RE = /(\$?)([A-Z]+)(\$?)(\d+)/g;

// ── Adjusters ──────────────────────────────────────────────────────────────────

/**
 * Adjust all relative references in a formula by (rowOffset, colOffset).
 * Absolute refs ($A$1) are not moved.
 *
 * @param {string} formula  - Formula string including leading "="
 * @param {number} rowOffset
 * @param {number} colOffset
 * @returns {string}
 */
export function adjustByOffset(formula, rowOffset, colOffset) {
    if (rowOffset === 0 && colOffset === 0) return formula;
    return withLiteralProtection(formula, (s) =>
        s.replace(REF_RE, (_m, colAbs, col, rowAbs, row) => {
            const newCol = colAbs ? col : numToCol(colToNum(col) + colOffset);
            const newRow = rowAbs ? row : String(parseInt(row, 10) + rowOffset);
            return `${colAbs}${newCol}${rowAbs}${newRow}`;
        })
    );
}

/**
 * Adjust formula refs when a row is inserted at `insertedRowIndex` (0-based).
 * Relative row refs ≥ insertedRowIndex+1 (1-based) shift up by 1.
 *
 * @param {string} formula
 * @param {number} insertedRowIndex - 0-based row index of the newly inserted row
 * @returns {string}
 */
export function adjustForRowInsert(formula, insertedRowIndex) {
    const threshold = insertedRowIndex + 1; // convert to 1-based formula row
    return withLiteralProtection(formula, (s) =>
        s.replace(REF_RE, (match, colAbs, col, rowAbs, row) => {
            const rowNum = parseInt(row, 10);
            if (!rowAbs && rowNum >= threshold) {
                return `${colAbs}${col}${rowAbs}${rowNum + 1}`;
            }
            return match;
        })
    );
}

/**
 * Adjust formula refs when a column is inserted at `insertedColIndex` (0-based).
 * Relative col refs ≥ insertedColIndex shift right by 1.
 *
 * @param {string} formula
 * @param {number} insertedColIndex - 0-based column index of the newly inserted column
 * @returns {string}
 */
export function adjustForColInsert(formula, insertedColIndex) {
    return withLiteralProtection(formula, (s) =>
        s.replace(REF_RE, (match, colAbs, col, rowAbs, row) => {
            if (!colAbs) {
                const colNum = colToNum(col);
                if (colNum >= insertedColIndex) {
                    return `${colAbs}${numToCol(colNum + 1)}${rowAbs}${row}`;
                }
            }
            return match;
        })
    );
}

/**
 * Adjust formula refs when a row is deleted at `deletedRowIndex` (0-based).
 * - Relative refs pointing at the deleted row become #REF!
 * - Relative refs strictly below the deleted row shift up by 1.
 *
 * @param {string} formula
 * @param {number} deletedRowIndex - 0-based row index of the deleted row
 * @returns {string}
 */
export function adjustForRowDelete(formula, deletedRowIndex) {
    const formulaRow = deletedRowIndex + 1; // 1-based
    return withLiteralProtection(formula, (s) =>
        s.replace(REF_RE, (match, colAbs, col, rowAbs, row) => {
            const rowNum = parseInt(row, 10);
            if (!rowAbs) {
                if (rowNum === formulaRow) return '#REF!';
                if (rowNum > formulaRow) return `${colAbs}${col}${rowAbs}${rowNum - 1}`;
            }
            return match;
        })
    );
}

/**
 * Adjust formula refs when a column is deleted at `deletedColIndex` (0-based).
 * - Relative refs pointing at the deleted column become #REF!
 * - Relative refs strictly right of the deleted column shift left by 1.
 *
 * @param {string} formula
 * @param {number} deletedColIndex - 0-based column index of the deleted column
 * @returns {string}
 */
export function adjustForColDelete(formula, deletedColIndex) {
    return withLiteralProtection(formula, (s) =>
        s.replace(REF_RE, (match, colAbs, col, rowAbs, row) => {
            if (!colAbs) {
                const colNum = colToNum(col);
                if (colNum === deletedColIndex) return '#REF!';
                if (colNum > deletedColIndex) return `${colAbs}${numToCol(colNum - 1)}${rowAbs}${row}`;
            }
            return match;
        })
    );
}
