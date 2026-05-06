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
 * ## Multi-Selection
 *   Ctrl+click/drag adds non-contiguous ranges to `extraRanges` (range mode),
 *   `extraRowRanges` (rows mode), or `extraColRanges` (cols mode).
 *   `anchor`/`focus`/`range` always describe the *active* (most recent) range.
 *   `isSelected()` and `isColHighlighted()` / `isRowHighlighted()` check all ranges.
 *
 * ## Primary Cell
 *   There is exactly one primary cell at all times: the Tab/Enter traversal
 *   cursor.  It defaults to `anchor` but is overridden by `primaryCell` when
 *   the user tabs through a multi-cell selection.
 */

/**
 * @typedef {{ startRow: number, endRow: number, startCol: number, endCol: number }} CellRange
 * @typedef {{ start: number, end: number }} AxisRange
 */

export class SelectionState {
    // ── Core anchor/focus (active range, 'range' mode) ───────────────────────

    /** @type {number|null} */
    #rowAnchor = null;
    /** @type {number|null} */
    #colAnchor = null;

    /** @type {{row: number, col: number} | null} */
    anchor = $state(null);

    /** @type {{row: number, col: number} | null} */
    focus = $state(null);

    /** @type {boolean} */
    isSelecting = $state(false);

    // ── Selection mode ────────────────────────────────────────────────────────

    /** @type {'range'|'rows'|'cols'|'all'} */
    selectionMode = $state('range');

    /** @type {AxisRange | null} active row range for 'rows' mode */
    selectedRows = $state(null);

    /** @type {AxisRange | null} active col range for 'cols' mode */
    selectedCols = $state(null);

    // ── Multi-selection extra ranges ──────────────────────────────────────────

    /** @type {CellRange[]} committed non-active cell ranges (range mode) */
    extraRanges = $state([]);

    /** @type {AxisRange[]} committed non-active row ranges (rows mode) */
    extraRowRanges = $state([]);

    /** @type {AxisRange[]} committed non-active col ranges (cols mode) */
    extraColRanges = $state([]);

    // ── Tab traversal cursor ──────────────────────────────────────────────────

    /**
     * Overrides `anchor` as the single primary cell for Tab/Enter traversal.
     * null means the primary cell is `anchor`.
     * @type {{row: number, col: number} | null}
     */
    primaryCell = $state(null);

    // ── Computed range (active range only, null when not 'range' mode) ────────

    /** @type {CellRange | null} */
    range = $derived.by(() => {
        if (this.selectionMode !== 'range') return null;
        if (!this.anchor || !this.focus) return null;
        return {
            startRow: Math.min(this.anchor.row, this.focus.row),
            endRow:   Math.max(this.anchor.row, this.focus.row),
            startCol: Math.min(this.anchor.col, this.focus.col),
            endCol:   Math.max(this.anchor.col, this.focus.col),
        };
    });

    /** @type {boolean} */
    isSingleCell = $derived.by(() => {
        if (this.selectionMode !== 'range') return false;
        if (!this.anchor || !this.focus) return false;
        return this.anchor.row === this.focus.row && this.anchor.col === this.focus.col;
    });

    // ── Multi-selection aggregates ────────────────────────────────────────────

    /**
     * All active cell ranges: [active, ...extras].  Only valid for 'range' mode.
     * @returns {CellRange[]}
     */
    get allRanges() {
        if (this.selectionMode !== 'range') return [];
        const active = this.range;
        return active ? [active, ...this.extraRanges] : [...this.extraRanges];
    }

    /**
     * All active row ranges: [active, ...extras].  Only valid for 'rows' mode.
     * @returns {AxisRange[]}
     */
    get allRowRanges() {
        if (this.selectionMode !== 'rows') return [];
        return this.selectedRows ? [this.selectedRows, ...this.extraRowRanges] : [...this.extraRowRanges];
    }

    /**
     * All active col ranges: [active, ...extras].  Only valid for 'cols' mode.
     * @returns {AxisRange[]}
     */
    get allColRanges() {
        if (this.selectionMode !== 'cols') return [];
        return this.selectedCols ? [this.selectedCols, ...this.extraColRanges] : [...this.extraColRanges];
    }

    /** True when there are committed extra ranges on top of the active one. */
    get hasMultipleSelections() {
        return this.extraRanges.length > 0 || this.extraRowRanges.length > 0 || this.extraColRanges.length > 0;
    }

    /**
     * True when Tab should cycle through the selection rather than move freely.
     * (Non-trivial selection in range mode.)
     */
    get hasTabSelection() {
        if (this.extraRanges.length > 0) return true;
        if (this.selectionMode !== 'range') return false;
        return !this.isSingleCell;
    }

    // ── Primary cell ──────────────────────────────────────────────────────────

    /**
     * Is this cell the single primary cell (Tab cursor / anchor)?
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isPrimaryCell(row, col) {
        const pc = this.primaryCell ?? this.anchor;
        return pc?.row === row && pc?.col === col;
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    /**
     * Start a fresh cell range selection (clears all extra ranges).
     * @param {number} row
     * @param {number} col
     */
    startSelection(row, col) {
        this.selectionMode = 'range';
        this.selectedRows = null;
        this.selectedCols = null;
        this.extraRanges = [];
        this.extraRowRanges = [];
        this.extraColRanges = [];
        this.primaryCell = null;
        this.anchor = { row, col };
        this.focus  = { row, col };
        this.isSelecting = true;
    }

    /**
     * Add a new range to the selection (Ctrl+click).  The current active
     * range is committed to extraRanges and a new active range begins.
     * Ctrl+clicking a cell already in an extra range removes it (toggle).
     * Ctrl+clicking the active single-cell range is a no-op (already active).
     * @param {number} row
     * @param {number} col
     */
    startAdditionalSelection(row, col) {
        if (this.selectionMode === 'range' && this.range) {
            // If the clicked cell is the active single-cell, stay put (no duplicate).
            if (this.isSingleCell && this.anchor.row === row && this.anchor.col === col) {
                this.isSelecting = true;
                return;
            }
            // Toggle: if the cell is already in an extra range, remove that range.
            const toggleIdx = this.extraRanges.findIndex(r =>
                row >= r.startRow && row <= r.endRow &&
                col >= r.startCol && col <= r.endCol
            );
            if (toggleIdx !== -1) {
                this.extraRanges = this.extraRanges.filter((_, i) => i !== toggleIdx);
                // Keep the current active range, just deselect the toggled extra.
                this.isSelecting = false;
                return;
            }
            this.extraRanges = [...this.extraRanges, { ...this.range }];
        } else {
            // Switching from rows/cols/all mode into range multi-select
            this.selectedRows = null;
            this.selectedCols = null;
            this.extraRowRanges = [];
            this.extraColRanges = [];
        }
        this.selectionMode = 'range';
        this.primaryCell = null;
        this.anchor = { row, col };
        this.focus  = { row, col };
        this.isSelecting = true;
    }

    /**
     * Extend the active range to include a cell (Shift+click or drag).
     * Does not require isSelecting — callers that want drag-only behavior must
     * guard on isSelecting themselves (see Grid mousemove handler).
     * @param {number} row
     * @param {number} col
     */
    extendSelection(row, col) {
        if (this.selectionMode === 'range') {
            this.focus = { row, col };
            this.primaryCell = null;
        }
    }

    /** End selection drag. */
    endSelection() {
        this.isSelecting = false;
    }

    /**
     * Move selection by delta (arrow key navigation).
     * Clears extra ranges unless `extend` is true.
     * @param {number} dRow
     * @param {number} dCol
     * @param {boolean} extend  Shift held → extend active range
     * @param {number} [rowCount]
     * @param {number} [colCount]
     */
    moveSelection(dRow, dCol, extend = false, rowCount, colCount) {
        const maxRow = rowCount != null ? rowCount - 1 : Number.MAX_SAFE_INTEGER;
        const maxCol = colCount != null ? colCount - 1 : Number.MAX_SAFE_INTEGER;

        if (this.selectionMode !== 'range') {
            this.selectionMode = 'range';
            this.selectedRows = null;
            this.selectedCols = null;
        }

        if (!extend) {
            // Collapsing: drop all extra ranges and the tab cursor
            this.extraRanges = [];
            this.extraRowRanges = [];
            this.extraColRanges = [];
            this.primaryCell = null;
        }

        if (!this.anchor) {
            this.anchor = { row: 0, col: 0 };
            this.focus  = { row: 0, col: 0 };
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
            this.focus  = newPos;
        }
    }

    // ── Tab traversal ─────────────────────────────────────────────────────────

    /**
     * Advance the primary cell to the next selected cell in reading order
     * (left→right, top→bottom, range by range sorted by position).
     */
    tabNext() {
        this.#advanceTab(1);
    }

    /**
     * Retreat the primary cell to the previous selected cell.
     */
    tabPrev() {
        this.#advanceTab(-1);
    }

    /** @param {number} direction  +1 or -1 */
    #advanceTab(direction) {
        if (this.selectionMode !== 'range') return;
        const sorted = this.#sortedRanges();
        if (sorted.length === 0) return;
        // Single-cell with no extras: caller handles normal nav
        if (sorted.length === 1) {
            const r = sorted[0];
            if (r.startRow === r.endRow && r.startCol === r.endCol) return;
        }
        const pc = this.primaryCell ?? this.anchor;
        const next = this.#nextTabCell(pc, sorted, direction);
        if (next) this.primaryCell = next;
    }

    /** Returns all cell ranges sorted top-left to bottom-right. */
    #sortedRanges() {
        return this.allRanges.slice().sort((a, b) =>
            a.startRow !== b.startRow ? a.startRow - b.startRow : a.startCol - b.startCol
        );
    }

    /**
     * @param {{row:number,col:number}|null} current
     * @param {CellRange[]} sorted
     * @param {number} direction
     * @returns {{row:number,col:number}|null}
     */
    #nextTabCell(current, sorted, direction) {
        const sizes = sorted.map(r => (r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1));
        const total = sizes.reduce((a, b) => a + b, 0);
        if (total === 0) return null;

        let globalIdx = -1;
        let offset = 0;
        if (current) {
            for (let ri = 0; ri < sorted.length; ri++) {
                const r = sorted[ri];
                const relRow = current.row - r.startRow;
                const relCol = current.col - r.startCol;
                const cols = r.endCol - r.startCol + 1;
                if (relRow >= 0 && relRow <= r.endRow - r.startRow &&
                    relCol >= 0 && relCol <= r.endCol - r.startCol) {
                    globalIdx = offset + relRow * cols + relCol;
                    break;
                }
                offset += sizes[ri];
            }
        }

        let nextGlobal;
        if (globalIdx === -1) {
            nextGlobal = direction > 0 ? 0 : total - 1;
        } else {
            nextGlobal = ((globalIdx + direction) % total + total) % total;
        }

        let remaining = nextGlobal;
        for (let ri = 0; ri < sorted.length; ri++) {
            if (remaining < sizes[ri]) {
                const r = sorted[ri];
                const cols = r.endCol - r.startCol + 1;
                return {
                    row: r.startRow + Math.floor(remaining / cols),
                    col: r.startCol + (remaining % cols),
                };
            }
            remaining -= sizes[ri];
        }
        return null;
    }

    // ── Row / Col selection ───────────────────────────────────────────────────

    /**
     * Select entire row(s) (clears all extra ranges).
     * @param {number} startRow
     * @param {number} [endRow]
     */
    selectRow(startRow, endRow) {
        const end = endRow ?? startRow;
        this.selectionMode = 'rows';
        this.selectedRows = { start: Math.min(startRow, end), end: Math.max(startRow, end) };
        this.selectedCols = null;
        this.extraRanges = [];
        this.extraRowRanges = [];
        this.extraColRanges = [];
        this.primaryCell = null;
        this.#rowAnchor = startRow;
        this.anchor = { row: startRow, col: 0 };
        this.focus  = { row: end,      col: 0 };
        this.isSelecting = false;
    }

    /**
     * Add another row to the multi-selection (Ctrl+click row header).
     * Ctrl+clicking an already-selected row toggles it off.
     * @param {number} row
     */
    addRowSelection(row) {
        if (this.selectionMode !== 'rows') {
            this.selectRow(row);
            return;
        }
        // Toggle: if the row is already in an extra range, remove it.
        const toggleIdx = this.extraRowRanges.findIndex(r => row >= r.start && row <= r.end);
        if (toggleIdx !== -1) {
            this.extraRowRanges = this.extraRowRanges.filter((_, i) => i !== toggleIdx);
            this.isSelecting = false;
            return;
        }
        // If clicking the currently active row range, it's already active — no duplicate.
        if (this.selectedRows && row >= this.selectedRows.start && row <= this.selectedRows.end) {
            this.isSelecting = true;
            return;
        }
        if (this.selectedRows) {
            this.extraRowRanges = [...this.extraRowRanges, { ...this.selectedRows }];
        }
        this.selectedRows = { start: row, end: row };
        this.#rowAnchor = row;
        this.primaryCell = null;
        this.anchor = { row, col: 0 };
        this.focus  = { row, col: 0 };
        this.isSelecting = true;
    }

    /**
     * Extend row selection from the existing anchor.
     * @param {number} row
     */
    extendRowSelection(row) {
        if (this.selectionMode !== 'rows' || this.#rowAnchor == null) {
            this.selectRow(row);
            return;
        }
        const start = Math.min(this.#rowAnchor, row);
        const end   = Math.max(this.#rowAnchor, row);
        this.selectedRows = { start, end };
        this.focus = { row, col: 0 };
    }

    /** Begin dragging row selection. @param {number} row */
    startRowDrag(row) {
        this.selectRow(row);
        this.isSelecting = true;
    }

    /**
     * Select entire column(s) (clears all extra ranges).
     * @param {number} startCol
     * @param {number} [endCol]
     */
    selectColumn(startCol, endCol) {
        const end = endCol ?? startCol;
        this.selectionMode = 'cols';
        this.selectedCols = { start: Math.min(startCol, end), end: Math.max(startCol, end) };
        this.selectedRows = null;
        this.extraRanges = [];
        this.extraRowRanges = [];
        this.extraColRanges = [];
        this.primaryCell = null;
        this.#colAnchor = startCol;
        this.anchor = { row: 0, col: startCol };
        this.focus  = { row: 0, col: end };
        this.isSelecting = false;
    }

    /**
     * Add another column to the multi-selection (Ctrl+click col header).
     * Ctrl+clicking an already-selected column toggles it off.
     * @param {number} col
     */
    addColSelection(col) {
        if (this.selectionMode !== 'cols') {
            this.selectColumn(col);
            return;
        }
        // Toggle: if the col is already in an extra range, remove it.
        const toggleIdx = this.extraColRanges.findIndex(r => col >= r.start && col <= r.end);
        if (toggleIdx !== -1) {
            this.extraColRanges = this.extraColRanges.filter((_, i) => i !== toggleIdx);
            this.isSelecting = false;
            return;
        }
        // If clicking the currently active col range, it's already active — no duplicate.
        if (this.selectedCols && col >= this.selectedCols.start && col <= this.selectedCols.end) {
            this.isSelecting = true;
            return;
        }
        if (this.selectedCols) {
            this.extraColRanges = [...this.extraColRanges, { ...this.selectedCols }];
        }
        this.selectedCols = { start: col, end: col };
        this.#colAnchor = col;
        this.primaryCell = null;
        this.anchor = { row: 0, col };
        this.focus  = { row: 0, col };
        this.isSelecting = true;
    }

    /**
     * Extend column selection from the existing anchor.
     * @param {number} col
     */
    extendColSelection(col) {
        if (this.selectionMode !== 'cols' || this.#colAnchor == null) {
            this.selectColumn(col);
            return;
        }
        const start = Math.min(this.#colAnchor, col);
        const end   = Math.max(this.#colAnchor, col);
        this.selectedCols = { start, end };
        this.focus = { row: 0, col };
    }

    /** Begin dragging column selection. @param {number} col */
    startColDrag(col) {
        this.selectColumn(col);
        this.isSelecting = true;
    }

    /** Select all cells. */
    selectAll() {
        this.selectionMode = 'all';
        this.selectedRows = null;
        this.selectedCols = null;
        this.extraRanges = [];
        this.extraRowRanges = [];
        this.extraColRanges = [];
        this.primaryCell = null;
        this.anchor = { row: 0, col: 0 };
        this.focus  = { row: 0, col: 0 };
        this.isSelecting = false;
    }

    /** Clear all selection state. */
    clear() {
        this.anchor = null;
        this.focus  = null;
        this.isSelecting = false;
        this.selectionMode = 'range';
        this.selectedRows = null;
        this.selectedCols = null;
        this.extraRanges = [];
        this.extraRowRanges = [];
        this.extraColRanges = [];
        this.primaryCell = null;
        this.#rowAnchor = null;
        this.#colAnchor = null;
    }

    // ── Per-cell query ────────────────────────────────────────────────────────

    /**
     * Check if a cell is in ANY range of the current selection.
     * @param {number} row
     * @param {number} col
     * @param {number} [_rowCount]
     * @param {number} [_colCount]
     * @returns {boolean}
     */
    isSelected(row, col, _rowCount, _colCount) {
        switch (this.selectionMode) {
            case 'all':
                return true;

            case 'rows': {
                if (this.selectedRows && row >= this.selectedRows.start && row <= this.selectedRows.end) return true;
                for (const r of this.extraRowRanges) {
                    if (row >= r.start && row <= r.end) return true;
                }
                return false;
            }

            case 'cols': {
                if (this.selectedCols && col >= this.selectedCols.start && col <= this.selectedCols.end) return true;
                for (const r of this.extraColRanges) {
                    if (col >= r.start && col <= r.end) return true;
                }
                return false;
            }

            case 'range':
            default: {
                const active = this.range;
                if (active &&
                    row >= active.startRow && row <= active.endRow &&
                    col >= active.startCol && col <= active.endCol) return true;
                for (const r of this.extraRanges) {
                    if (row >= r.startRow && row <= r.endRow &&
                        col >= r.startCol && col <= r.endCol) return true;
                }
                return false;
            }
        }
    }

    /**
     * All bounded ranges for the current selection mode (multi-select aware).
     * Use instead of effectiveRange() when an operation must cover every selected cell.
     * @param {number} rowCount
     * @param {number} colCount
     * @returns {CellRange[]}
     */
    allEffectiveRanges(rowCount, colCount) {
        const maxRow = Math.max(0, rowCount - 1);
        const maxCol = Math.max(0, colCount - 1);
        switch (this.selectionMode) {
            case 'all':
                return [{ startRow: 0, endRow: maxRow, startCol: 0, endCol: maxCol }];
            case 'rows':
                return this.allRowRanges.map(r => ({
                    startRow: r.start, endRow: r.end, startCol: 0, endCol: maxCol,
                }));
            case 'cols':
                return this.allColRanges.map(c => ({
                    startRow: 0, endRow: maxRow, startCol: c.start, endCol: c.end,
                }));
            case 'range':
            default:
                return this.allRanges;
        }
    }

    /**
     * Get a bounded rectangle for the ACTIVE selection (backward compat).
     * For multi-selection use allEffectiveRanges() or allRanges directly.
     * @param {number} rowCount
     * @param {number} colCount
     * @returns {CellRange | null}
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
                    startRow: this.selectedRows.start, endRow: this.selectedRows.end,
                    startCol: 0, endCol: Math.max(0, colCount - 1),
                };
            }
            case 'cols': {
                if (!this.selectedCols) return null;
                return {
                    startRow: 0, endRow: Math.max(0, rowCount - 1),
                    startCol: this.selectedCols.start, endCol: this.selectedCols.end,
                };
            }
            case 'range':
            default:
                return this.range ?? null;
        }
    }

    /**
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isAnchor(row, col) {
        return this.anchor?.row === row && this.anchor?.col === col;
    }

    // ── Header highlighting ───────────────────────────────────────────────────

    /**
     * Should this column header appear selected?
     * @param {number} col
     * @returns {boolean}
     */
    isColHighlighted(col) {
        if (this.selectionMode === 'all') return true;
        if (this.selectionMode === 'cols') {
            if (this.selectedCols && col >= this.selectedCols.start && col <= this.selectedCols.end) return true;
            for (const r of this.extraColRanges) {
                if (col >= r.start && col <= r.end) return true;
            }
            return false;
        }
        if (this.selectionMode === 'range') {
            const active = this.range;
            if (active && col >= active.startCol && col <= active.endCol) return true;
            for (const r of this.extraRanges) {
                if (col >= r.startCol && col <= r.endCol) return true;
            }
            return false;
        }
        return false;
    }

    /**
     * Should this row header appear selected?
     * @param {number} row
     * @returns {boolean}
     */
    isRowHighlighted(row) {
        if (this.selectionMode === 'all') return true;
        if (this.selectionMode === 'rows') {
            if (this.selectedRows && row >= this.selectedRows.start && row <= this.selectedRows.end) return true;
            for (const r of this.extraRowRanges) {
                if (row >= r.start && row <= r.end) return true;
            }
            return false;
        }
        if (this.selectionMode === 'range') {
            const active = this.range;
            if (active && row >= active.startRow && row <= active.endRow) return true;
            for (const r of this.extraRanges) {
                if (row >= r.startRow && row <= r.endRow) return true;
            }
            return false;
        }
        return false;
    }
}

export default SelectionState;
