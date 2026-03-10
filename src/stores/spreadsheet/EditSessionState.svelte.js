import { formulaEditState } from './FormulaEditState.svelte.js';

/**
 * EditSessionState - Canonical editing lifecycle for spreadsheet cells.
 *
 * Coordinates editing across grid cell editor and formula bar, while keeping
 * a single draft, active cell, and commit/cancel flow.
 */
export class EditSessionState {
    /** @type {'idle' | 'editing'} */
    phase = $state('idle');

    /** @type {{ row: number, col: number } | null} */
    cell = $state(null);

    /** @type {string} */
    draft = $state('');

    /** @type {number} */
    cursorStart = $state(0);

    /** @type {number} */
    cursorEnd = $state(0);

    /** @type {'grid' | 'formulaBar'} */
    surface = $state('grid');

    /** @type {number} */
    sessionId = $state(0);

    /** @type {'date' | 'time' | 'datetime-local' | null} */
    pickerMode = $state(null);

    /** @type {Map<string, Function>} */
    #focusHandles = new Map();

    get isEditing() {
        return this.phase === 'editing';
    }

    get isFormulaMode() {
        return this.isEditing && this.draft.startsWith('=');
    }

    /**
     * Register a focus callback for a surface.
     * @param {'grid' | 'formulaBar'} surface
     * @param {Function} focusHandle
     */
    setFocusHandle(surface, focusHandle) {
        if (!focusHandle) return;
        this.#focusHandles.set(surface, focusHandle);
    }

    /**
     * Remove a focus callback for a surface.
     * @param {'grid' | 'formulaBar'} surface
     */
    clearFocusHandle(surface) {
        this.#focusHandles.delete(surface);
    }

    /**
     * Request focus on a specific surface.
     * @param {'grid' | 'formulaBar'} [surface]
     */
    requestFocus(surface = this.surface) {
        const handle = this.#focusHandles.get(surface);
        if (!handle) return;

        // Next tick ensures DOM is mounted before focusing.
        setTimeout(() => {
            const active = this.#focusHandles.get(surface);
            active?.();
        }, 0);
    }

    /**
     * Switch active editing surface while keeping same session.
     * @param {'grid' | 'formulaBar'} surface
     * @param {{ focus?: boolean }} [opts]
     */
    switchSurface(surface, opts = {}) {
        const { focus = true } = opts;
        this.surface = surface;
        if (focus) {
            this.requestFocus(surface);
        }
    }

    /**
     * Check if the current session is editing a specific cell.
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isEditingCell(row, col) {
        return this.isEditing && this.cell?.row === row && this.cell?.col === col;
    }

    /**
     * Begin editing a cell.
     * @param {number} row
     * @param {number} col
     * @param {any} initialValue
     * @param {'grid' | 'formulaBar'} [surface]
     * @param {Object} [options]
     */
    beginEdit(row, col, initialValue = '', surface = 'grid', options = {}) {
        const text = toText(initialValue);

        this.phase = 'editing';
        this.cell = { row, col };
        this.draft = text;
        this.cursorStart = text.length;
        this.cursorEnd = text.length;
        this.surface = surface;
        this.sessionId++;
        this.pickerMode = options.pickerMode || null;

        formulaEditState.startEditing(row, col, text);
        formulaEditState.updateValue(text, this.cursorStart);

        this.requestFocus(surface);
    }

    /**
     * Update current draft text and cursor range.
     * @param {any} value
     * @param {number | null} [cursorStart]
     * @param {number | null} [cursorEnd]
     */
    updateDraft(value, cursorStart = null, cursorEnd = null) {
        if (!this.isEditing) return;

        const text = toText(value);
        this.draft = text;

        const nextStart = cursorStart ?? text.length;
        const nextEnd = cursorEnd ?? nextStart;

        this.cursorStart = clamp(nextStart, 0, text.length);
        this.cursorEnd = clamp(nextEnd, 0, text.length);

        formulaEditState.updateValue(text, this.cursorStart);
    }

    /**
     * Update cursor range.
     * @param {number} start
     * @param {number} [end]
     */
    setCursor(start, end = start) {
        if (!this.isEditing) return;
        const textLength = this.draft.length;
        this.cursorStart = clamp(start, 0, textLength);
        this.cursorEnd = clamp(end, 0, textLength);
        formulaEditState.cursorPosition = this.cursorStart;
    }

    /**
     * Insert or replace a formula reference at current cursor position.
     * If cursor is within an existing reference token, replace that token.
     * @param {string} ref
     */
    insertReference(ref) {
        if (!this.isEditing || !this.isFormulaMode) return;

        const value = this.draft;
        const start = Math.min(this.cursorStart, this.cursorEnd);
        const end = Math.max(this.cursorStart, this.cursorEnd);

        let replaceStart = start;
        let replaceEnd = end;

        // If there is no active selection, replace the token under cursor.
        if (start === end) {
            const refPositions = findReferencePositions(value);
            for (const pos of refPositions) {
                if (start >= pos.start && start <= pos.end) {
                    replaceStart = pos.start;
                    replaceEnd = pos.end;
                    break;
                }
            }
        }

        const newValue =
            value.substring(0, replaceStart) + ref + value.substring(replaceEnd);
        const newCursor = replaceStart + ref.length;

        this.updateDraft(newValue, newCursor, newCursor);
        this.requestFocus(this.surface);
    }

    /**
     * Commit current edit and return payload to persist.
     * @returns {{ row: number, col: number, value: string } | null}
     */
    commit() {
        if (!this.isEditing || !this.cell) return null;

        const payload = {
            row: this.cell.row,
            col: this.cell.col,
            value: this.draft
        };

        this.#stopEditing();
        return payload;
    }

    /**
     * Cancel current edit.
     */
    cancel() {
        if (!this.isEditing) return;
        this.#stopEditing();
    }

    #stopEditing() {
        this.phase = 'idle';
        this.cell = null;
        this.draft = '';
        this.cursorStart = 0;
        this.cursorEnd = 0;
        this.surface = 'grid';
        this.pickerMode = null;
        this.sessionId++;
        formulaEditState.stopEditing();
    }
}

/**
 * Find all reference token ranges in a formula.
 * @param {string} formula
 * @returns {Array<{start: number, end: number}>}
 */
function findReferencePositions(formula) {
    const positions = [];
    if (!formula) return positions;

    const content = formula.startsWith('=') ? formula.slice(1) : formula;
    const offset = formula.startsWith('=') ? 1 : 0;

    // Match ranges first (A1:B5)
    const rangeRegex = /\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+/g;
    let match;

    const rangePositions = [];
    while ((match = rangeRegex.exec(content)) !== null) {
        rangePositions.push({
            start: match.index,
            end: match.index + match[0].length
        });
        positions.push({
            start: match.index + offset,
            end: match.index + match[0].length + offset
        });
    }

    // Match individual refs not inside ranges.
    const cellRegex = /\$?[A-Za-z]+\$?\d+/g;
    while ((match = cellRegex.exec(content)) !== null) {
        const inRange = rangePositions.some(
            (r) => match.index >= r.start && match.index < r.end
        );
        if (!inRange) {
            positions.push({
                start: match.index + offset,
                end: match.index + match[0].length + offset
            });
        }
    }

    return positions.sort((a, b) => a.start - b.start);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function toText(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

export const editSessionState = new EditSessionState();

export default EditSessionState;
