/**
 * SelectionState - Manages cell selection state
 *
 * Selection state is local UI state and NOT stored in Yjs.
 * Uses Svelte 5 runes for reactivity.
 */

/**
 * SelectionState class
 *
 * Manages cell selection state with support for:
 * - Single cell selection
 * - Range selection (drag or shift+click)
 * - Keyboard navigation
 */
export class SelectionState {
    /** @type {{row: number, col: number} | null} */
    anchor = $state(null);

    /** @type {{row: number, col: number} | null} */
    focus = $state(null);

    /** @type {boolean} */
    isSelecting = $state(false);

    // Computed selection range
    range = $derived.by(() => {
        if (!this.anchor || !this.focus) return null;

        return {
            startRow: Math.min(this.anchor.row, this.focus.row),
            endRow: Math.max(this.anchor.row, this.focus.row),
            startCol: Math.min(this.anchor.col, this.focus.col),
            endCol: Math.max(this.anchor.col, this.focus.col)
        };
    });

    /** @type {boolean} */
    isSingleCell = $derived.by(() => {
        if (!this.anchor || !this.focus) return false;
        return this.anchor.row === this.focus.row && this.anchor.col === this.focus.col;
    });

    /**
     * Start a selection
     * @param {number} row
     * @param {number} col
     */
    startSelection(row, col) {
        this.anchor = { row, col };
        this.focus = { row, col };
        this.isSelecting = true;
    }

    /**
     * Extend selection to a cell
     * @param {number} row
     * @param {number} col
     */
    extendSelection(row, col) {
        if (this.isSelecting) {
            this.focus = { row, col };
        }
    }

    /**
     * End selection
     */
    endSelection() {
        this.isSelecting = false;
    }

    /**
     * Move selection by delta
     * @param {number} dRow
     * @param {number} dCol
     * @param {boolean} extend
     */
    moveSelection(dRow, dCol, extend = false) {
        if (!this.anchor) {
            this.anchor = { row: 0, col: 0 };
            this.focus = { row: 0, col: 0 };
            return;
        }

        if (extend) {
            if (this.focus) {
                const newFocus = {
                    row: Math.max(0, this.focus.row + dRow),
                    col: Math.max(0, this.focus.col + dCol)
                };
                this.focus = newFocus;
            }
        } else {
            const current = this.focus || this.anchor;
            const newPos = {
                row: Math.max(0, current.row + dRow),
                col: Math.max(0, current.col + dCol)
            };
            this.anchor = newPos;
            this.focus = newPos;
        }
    }

    /**
     * Check if a cell is in the selection
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isSelected(row, col) {
        if (!this.range) return false;

        return (
            row >= this.range.startRow &&
            row <= this.range.endRow &&
            col >= this.range.startCol &&
            col <= this.range.endCol
        );
    }

    /**
     * Check if a cell is the anchor
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isAnchor(row, col) {
        return this.anchor?.row === row && this.anchor?.col === col;
    }

    /**
     * Clear selection
     */
    clear() {
        this.anchor = null;
        this.focus = null;
        this.isSelecting = false;
    }

    /**
     * Select an entire row
     * @param {number} row
     */
    selectRow(row) {
        this.anchor = { row, col: 0 };
        this.focus = { row, col: Number.MAX_SAFE_INTEGER };
    }

    /**
     * Select an entire column
     * @param {number} col
     */
    selectColumn(col) {
        this.anchor = { row: 0, col };
        this.focus = { row: Number.MAX_SAFE_INTEGER, col };
    }

    /**
     * Select all cells
     */
    selectAll() {
        this.anchor = { row: 0, col: 0 };
        this.focus = { row: Number.MAX_SAFE_INTEGER, col: Number.MAX_SAFE_INTEGER };
    }
}

export default SelectionState;
