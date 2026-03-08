/**
 * FormulaEditState - Manages formula editing state
 *
 * Coordinates formula editing between FormulaBar and Grid components.
 * Tracks editing state, referenced cells, and provides color coding.
 */

// Color palette for cell references (distinct, accessible colors)
const REFERENCE_COLORS = [
    '#3b82f6', // blue
    '#ef4444', // red
    '#22c55e', // green
    '#f59e0b', // amber
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#06b6d4', // cyan
    '#f97316', // orange
    '#14b8a6', // teal
    '#a855f7', // purple
];

/**
 * FormulaEditState class
 *
 * Manages the state of formula editing across components.
 */
export class FormulaEditState {
    /** @type {boolean} */
    isEditing = $state(false);

    /** @type {boolean} */
    isFormulaMode = $state(false);

    /** @type {string} */
    currentValue = $state('');

    /** @type {number} */
    cursorPosition = $state(0);

    /** @type {{row: number, col: number} | null} */
    editingCell = $state(null);

    /** @type {Array<{row: number, col: number, color: string, ref: string}>} */
    referencedCells = $state([]);

    /** @type {Function | null} */
    #insertRefCallback = null;

    /** @type {Function | null} */
    #focusCallback = null;

    /**
     * Start editing a cell
     * @param {number} row
     * @param {number} col
     * @param {string} initialValue
     */
    startEditing(row, col, initialValue = '') {
        this.isEditing = true;
        this.editingCell = { row, col };
        this.currentValue = initialValue;
        this.cursorPosition = initialValue.length;
        this.isFormulaMode = initialValue.startsWith('=');
        this.updateReferencedCells();
    }

    /**
     * Update the current value
     * @param {string} value
     * @param {number} cursorPos
     */
    updateValue(value, cursorPos = null) {
        this.currentValue = value;
        this.cursorPosition = cursorPos !== null ? cursorPos : value.length;
        this.isFormulaMode = value.startsWith('=');
        this.updateReferencedCells();
    }

    /**
     * Stop editing
     */
    stopEditing() {
        this.isEditing = false;
        this.isFormulaMode = false;
        this.currentValue = '';
        this.cursorPosition = 0;
        this.editingCell = null;
        this.referencedCells = [];
        this.#insertRefCallback = null;
        this.#focusCallback = null;
    }

    /**
     * Set callback for inserting references
     * @param {Function} callback
     */
    setInsertRefCallback(callback) {
        this.#insertRefCallback = callback;
    }

    /**
     * Set callback for focusing the input
     * @param {Function} callback
     */
    setFocusCallback(callback) {
        this.#focusCallback = callback;
    }

    /**
     * Insert a cell reference at current cursor position
     * @param {string} ref - Cell reference (e.g., "A1" or "A1:B5")
     */
    insertReference(ref) {
        if (!this.isEditing || !this.isFormulaMode) return;

        if (this.#insertRefCallback) {
            this.#insertRefCallback(ref);
        }

        if (this.#focusCallback) {
            this.#focusCallback();
        }
    }

    /**
     * Parse the current formula and extract referenced cells
     */
    updateReferencedCells() {
        if (!this.isFormulaMode || !this.currentValue) {
            this.referencedCells = [];
            return;
        }

        const refs = extractReferences(this.currentValue);

        // Assign colors to unique references
        const colorMap = new Map();
        let colorIndex = 0;

        this.referencedCells = refs.map(ref => {
            const key = ref.ref;
            if (!colorMap.has(key)) {
                colorMap.set(key, REFERENCE_COLORS[colorIndex % REFERENCE_COLORS.length]);
                colorIndex++;
            }
            return {
                ...ref,
                color: colorMap.get(key)
            };
        });
    }

    /**
     * Get color for a specific cell reference
     * @param {number} row
     * @param {number} col
     * @returns {string | null}
     */
    getCellHighlightColor(row, col) {
        if (!this.isFormulaMode) return null;

        for (const ref of this.referencedCells) {
            if (ref.row === row && ref.col === col) {
                return ref.color;
            }
        }
        return null;
    }

    /**
     * Check if a cell is being referenced in the current formula
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isCellReferenced(row, col) {
        return this.referencedCells.some(ref => ref.row === row && ref.col === col);
    }

    /**
     * Get all unique reference strings with their colors
     * @returns {Array<{ref: string, color: string}>}
     */
    getReferenceColors() {
        const seen = new Set();
        const result = [];

        for (const ref of this.referencedCells) {
            if (!seen.has(ref.ref)) {
                seen.add(ref.ref);
                result.push({ ref: ref.ref, color: ref.color });
            }
        }

        return result;
    }
}

/**
 * Extract cell references from a formula string
 * @param {string} formula
 * @returns {Array<{row: number, col: number, ref: string}>}
 */
export function extractReferences(formula) {
    const refs = [];

    // Remove the leading = if present
    const content = formula.startsWith('=') ? formula.slice(1) : formula;

    // Regex to match cell references (with optional $ for absolute refs)
    // Also matches ranges (A1:B5)
    const rangeRegex = /\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+/g;
    const cellRegex = /\$?[A-Za-z]+\$?\d+/g;

    // First, find and remove ranges
    const ranges = content.match(rangeRegex) || [];
    let contentWithoutRanges = content;

    for (const range of ranges) {
        contentWithoutRanges = contentWithoutRanges.replace(range, '');

        // Parse the range
        const parts = range.split(':');
        if (parts.length === 2) {
            const start = parseCellRef(parts[0]);
            const end = parseCellRef(parts[1]);

            if (start && end) {
                // Add all cells in the range
                for (let r = start.row; r <= end.row; r++) {
                    for (let c = start.col; c <= end.col; c++) {
                        refs.push({
                            row: r,
                            col: c,
                            ref: range
                        });
                    }
                }
            }
        }
    }

    // Then find individual cell references
    const cells = contentWithoutRanges.match(cellRegex) || [];

    for (const cellRef of cells) {
        // Make sure it's not part of a function name or already in a range
        const parsed = parseCellRef(cellRef);
        if (parsed) {
            refs.push({
                row: parsed.row,
                col: parsed.col,
                ref: cellRef.toUpperCase()
            });
        }
    }

    return refs;
}

/**
 * Parse a cell reference string
 * @param {string} ref - Cell reference (e.g., "A1", "$B$2")
 * @returns {{row: number, col: number} | null}
 */
export function parseCellRef(ref) {
    // Remove $ signs for parsing
    const clean = ref.replace(/\$/g, '');

    // Match column letters and row number
    const match = clean.match(/^([A-Za-z]+)(\d+)$/);
    if (!match) return null;

    const colStr = match[1].toUpperCase();
    const rowNum = parseInt(match[2], 10);

    // Convert column letters to 0-indexed number
    let col = 0;
    for (let i = 0; i < colStr.length; i++) {
        col = col * 26 + (colStr.charCodeAt(i) - 64);
    }
    col--; // Convert to 0-indexed

    return {
        row: rowNum - 1, // Convert to 0-indexed
        col: col
    };
}

/**
 * Convert row, col to cell reference string
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
 * Convert a range to reference string
 * @param {number} startRow
 * @param {number} startCol
 * @param {number} endRow
 * @param {number} endCol
 * @returns {string}
 */
export function toRangeRef(startRow, startCol, endRow, endCol) {
    if (startRow === endRow && startCol === endCol) {
        return toCellRef(startRow, startCol);
    }
    return `${toCellRef(startRow, startCol)}:${toCellRef(endRow, endCol)}`;
}

// Singleton instance
export const formulaEditState = new FormulaEditState();

export default FormulaEditState;
