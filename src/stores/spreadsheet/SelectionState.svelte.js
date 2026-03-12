/**
 * SelectionState - Manages cell selection state
 *
 * Selection state is local UI state and NOT stored in Yjs.
 * Uses Svelte 5 runes for reactivity.
 *
 * ## Selection Modes
 *   'range'  - standard rectangular cell range (anchor + focus)
 *   'rows'   - whole row(s) selected via row-header click
 *   'cols'   - whole column(s) selected via col-header click
 *   'all'    - entire sheet selected (Ctrl+A or corner click)
 *
 * For 'range' mode the existing anchor/focus/range derived state work as
 * before.  For the other modes the range derived is null (preventing any
 * code that blindly loops over startRow..endRow × startCol..endCol from
 * hanging on MAX_SAFE_INTEGER-sized ranges).
 *
 * Use `effectiveRange(rowCount, colCount)` to get a bounded rectangle for
 * any mode, or `isSelected(row, col, rowCount, colCount)` for per-cell queries.
 */

/**
 * SelectionState class
 */
export class SelectionState {
    // ── Core anchor/focus (used for 'range' mode) ────────────────────────────

    /** @type {{row: number, col: number} | null} */
    anchor = $state(null);

    /** @type {{row: number, col: number} | null} */
    focus = $state(null);

    /** @type {boolean} */
    isSelecting = $state(false);

    // ── Selection mode ────────────────────────────────────────────────────────

    /** @type {'range'|'rows'|'cols'|'all'} */
    selectionMode = $state('range');

    /** @type {{start: number, end: number} | null}  row indices for 'rows' mode */
    selectedRows = $state(null);

    /** @type {{start: number, end: number} | null}  col indices for 'cols' mode */
    selectedCols = $state(null);

    // ── Computed range (only valid for 'range' mode) ─────────────────────────

    /**
     * Computed selection range — null when selectionMode !== 'range' or when
     * anchor/focus are not set.  Consumers that iterate this range are safe
     * because this is always null for whole-row/col/all selections.
     */
    range = $derived.by(() => {
        if (this.selectionMode !== 'range') return null;
        if (!this.anchor || !this.focus) return null;

        return {
            startRow: Math.min(this.anchor.row, this.focus.row),
            endRow: Math.max(this.anchor.row, this.focus.row),
            startCol: Math.min(this.anchor.col, this.focus.col),
            endCol: Math.max(this.anchor.col, this.focus.col),
        };
    });

    /** @type {boolean} */
    isSingleCell = $derived.by(() => {
        if (this.selectionMode !== 'range') return false;
        if (!this.anchor || !this.focus) return false;
        return this.anchor.row === this.focus.row && this.anchor.col === this.focus.col;
    });

    // ── Mutations ─────────────────────────────────────────────────────────────

    /**
     * Start a regular cell range selection.
     * @param {number} row
     * @param {number} col
     */
    startSelection(row, col) {
        this.selectionMode = 'range';
        this.selectedRows = null;
        this.selectedCols = null;
        this.anchor = { row, col };
        this.focus = { row, col };
        this.isSelecting = true;
    }

    /**
     * Extend selection to a cell (range mode only).
     * @param {number} row
     * @param {number} col
     */
    extendSelection(row, col) {
        if (this.isSelecting && this.selectionMode === 'range') {
            this.focus = { row, col };
        }
    }

    /** End selection drag. */
    endSelection() {
        this.isSelecting = false;
    }

    /**
     * Move selection by delta (arrow key navigation).
     * @param {number} dRow
     * @param {number} dCol
     * @param {boolean} extend  Shift held → extend selection
     * @param {number} [rowCount]  Sheet row count (to clamp)
     * @param {number} [colCount]  Sheet col count (to clamp)
     */
    moveSelection(dRow, dCol, extend = false, rowCount, colCount) {
        const maxRow = rowCount != null ? rowCount - 1 : Number.MAX_SAFE_INTEGER;
        const maxCol = colCount != null ? colCount - 1 : Number.MAX_SAFE_INTEGER;

        // If we're in a whole-axis mode, collapse to the anchor first.
        if (this.selectionMode !== 'range') {
            this.selectionMode = 'range';
            this.selectedRows = null;
            this.selectedCols = null;
            // anchor/focus already point to the cell that was clicked
        }

        if (!this.anchor) {
            this.anchor = { row: 0, col: 0 };
            this.focus = { row: 0, col: 0 };
            return;
        }

        if (extend) {
            if (this.focus) {
                this.focus = {
                    row: Math.max(0, Math.min(maxRow, this.focus.row + dRow)),
                    col: Math.max(0, Math.min(maxCol, this.focus.col + dCol)),
                };
            }
        } else {
            const current = this.focus || this.anchor;
            const newPos = {
                row: Math.max(0, Math.min(maxRow, current.row + dRow)),
                col: Math.max(0, Math.min(maxCol, current.col + dCol)),
            };
            this.anchor = newPos;
            this.focus = newPos;
        }
    }

    /**
     * Check if a cell is in the current selection (works for all modes).
     * @param {number} row
     * @param {number} col
     * @param {number} [rowCount]  Required for 'cols'/'all' mode
     * @param {number} [colCount]  Required for 'rows'/'all' mode
     * @returns {boolean}
     */
    isSelected(row, col, rowCount, colCount) {
        switch (this.selectionMode) {
            case 'all':
                return true;

            case 'rows': {
                if (!this.selectedRows) return false;
                return row >= this.selectedRows.start && row <= this.selectedRows.end;
            }

            case 'cols': {
                if (!this.selectedCols) return false;
                return col >= this.selectedCols.start && col <= this.selectedCols.end;
            }

            case 'range':
            default: {
                if (!this.range) return false;
                return (
                    row >= this.range.startRow &&
                    row <= this.range.endRow &&
                    col >= this.range.startCol &&
                    col <= this.range.endCol
                );
            }
        }
    }

    /**
     * Get a bounded rectangle representing the current selection.
     * Unlike `range`, this works for all selectionMode values and always
     * returns a finite rect (clamped to rowCount × colCount).
     *
     * @param {number} rowCount  Total sheet rows
     * @param {number} colCount  Total sheet cols
     * @returns {{ startRow:number, endRow:number, startCol:number, endCol:number } | null}
     */
    effectiveRange(rowCount, colCount) {
        switch (this.selectionMode) {
            case 'all':
                return {
                    startRow: 0, endRow: Math.max(0, rowCount - 1),
                    startCol: 0, endCol: Math.max(0, colCount - 1),
                };

            case 'rows': {
                if (!this.selectedRows) return null;
                return {
                    startRow: this.selectedRows.start,
                    endRow: this.selectedRows.end,
                    startCol: 0,
                    endCol: Math.max(0, colCount - 1),
                };
            }

            case 'cols': {
                if (!this.selectedCols) return null;
                return {
                    startRow: 0,
                    endRow: Math.max(0, rowCount - 1),
                    startCol: this.selectedCols.start,
                    endCol: this.selectedCols.end,
                };
            }

            case 'range':
            default:
                return this.range ?? null;
        }
    }

    /**
     * Check if a cell is the anchor.
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isAnchor(row, col) {
        return this.anchor?.row === row && this.anchor?.col === col;
    }

    /**
     * Clear selection.
     */
    clear() {
        this.anchor = null;
        this.focus = null;
        this.isSelecting = false;
        this.selectionMode = 'range';
        this.selectedRows = null;
        this.selectedCols = null;
    }

    /**
     * Select entire row(s).
     * @param {number} startRow
     * @param {number} [endRow]  Defaults to startRow
     */
    selectRow(startRow, endRow) {
        const end = endRow ?? startRow;
        this.selectionMode = 'rows';
        this.selectedRows = { start: Math.min(startRow, end), end: Math.max(startRow, end) };
        this.selectedCols = null;
        // Keep anchor/focus at col 0 so keyboard nav and the formula bar work.
        this.anchor = { row: startRow, col: 0 };
        this.focus = { row: end, col: 0 };
        this.isSelecting = false;
    }

    /**
     * Select entire column(s).
     * @param {number} startCol
     * @param {number} [endCol]  Defaults to startCol
     */
    selectColumn(startCol, endCol) {
        const end = endCol ?? startCol;
        this.selectionMode = 'cols';
        this.selectedCols = { start: Math.min(startCol, end), end: Math.max(startCol, end) };
        this.selectedRows = null;
        // Keep anchor/focus at row 0 so the formula bar works.
        this.anchor = { row: 0, col: startCol };
        this.focus = { row: 0, col: end };
        this.isSelecting = false;
    }

    /**
     * Select all cells.
     */
    selectAll() {
        this.selectionMode = 'all';
        this.selectedRows = null;
        this.selectedCols = null;
        this.anchor = { row: 0, col: 0 };
        this.focus = { row: 0, col: 0 };
        this.isSelecting = false;
    }

    // ── Helpers for header highlighting ──────────────────────────────────────

    /**
     * Is an entire column highlighted (col header should appear selected)?
     * @param {number} col
     * @returns {boolean}
     */
    isColHighlighted(col) {
        if (this.selectionMode === 'all') return true;
        if (this.selectionMode === 'cols') {
            return this.selectedCols
                ? col >= this.selectedCols.start && col <= this.selectedCols.end
                : false;
        }
        if (this.selectionMode === 'range' && this.range) {
            return col >= this.range.startCol && col <= this.range.endCol;
        }
        return false;
    }

    /**
     * Is an entire row highlighted (row header should appear selected)?
     * @param {number} row
     * @returns {boolean}
     */
    isRowHighlighted(row) {
        if (this.selectionMode === 'all') return true;
        if (this.selectionMode === 'rows') {
            return this.selectedRows
                ? row >= this.selectedRows.start && row <= this.selectedRows.end
                : false;
        }
        if (this.selectionMode === 'range' && this.range) {
            return row >= this.range.startRow && row <= this.range.endRow;
        }
        return false;
    }
}

export default SelectionState;
