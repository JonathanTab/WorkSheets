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

    /**
     * The text format runs loaded from the cell when editing began.
     * null when the cell has no inline formatting.
     * @type {Array|null}
     */
    initialTfr = $state(null);

    /**
     * Live plain text from the contenteditable, kept in sync on every input.
     * Used by commit() so clickaway-triggered commits get the latest text.
     * @type {string|null}
     */
    livePlainText = $state(null);

    /**
     * Live tfr from the contenteditable, kept in sync after every format
     * operation and on commit. null when there is no inline formatting.
     * @type {Array|null}
     */
    liveTfr = $state(null);

    /**
     * Callback set by GridOverlays so the toolbar can apply inline formatting
     * to the current text selection.
     * Signature: (prop: string, value: any) => boolean
     * Returns true if formatting was applied to a selection.
     * @type {Function|null}
     */
    applyInlineFormat = null;

    /**
     * The sheet ID where this edit was initiated.
     * @type {string | null}
     */
    editingSheetId = $state(null);

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
        setTimeout(() => {
            const handle = this.#focusHandles.get(surface);
            handle?.();
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
        if (focus) this.requestFocus(surface);
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
     * @param {any} initialValue  plain text (or formula string)
     * @param {'grid' | 'formulaBar'} [surface]
     * @param {Object} [options]
     * @param {Array|null} [options.initialTfr]  text format runs for the cell
     */
    beginEdit(row, col, initialValue = '', surface = 'grid', options = {}) {
        const text = _toText(initialValue);

        this.phase          = 'editing';
        this.cell           = { row, col };
        this.draft          = text;
        this.initialTfr     = options.initialTfr ?? null;
        this.livePlainText  = null;
        this.liveTfr        = null;
        this.cursorStart    = text.length;
        this.cursorEnd      = text.length;
        this.surface        = surface;
        this.sessionId++;
        this.pickerMode     = options.pickerMode || null;
        this.editingSheetId = options.sheetId ?? null;

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

        const text = _toText(value);
        this.draft = text;

        const nextStart = cursorStart ?? text.length;
        const nextEnd   = cursorEnd   ?? nextStart;

        this.cursorStart = _clamp(nextStart, 0, text.length);
        this.cursorEnd   = _clamp(nextEnd,   0, text.length);

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
        this.cursorStart = _clamp(start, 0, textLength);
        this.cursorEnd   = _clamp(end,   0, textLength);
        formulaEditState.cursorPosition = this.cursorStart;
    }

    /**
     * Insert or replace a formula reference at the current cursor position.
     * @param {string} ref
     */
    insertReference(ref) {
        if (!this.isEditing || !this.isFormulaMode) return;

        const value = this.draft;
        const start = Math.min(this.cursorStart, this.cursorEnd);
        const end   = Math.max(this.cursorStart, this.cursorEnd);

        let replaceStart = start;
        let replaceEnd   = end;

        if (start === end) {
            const refPositions = _findReferencePositions(value);
            for (const pos of refPositions) {
                if (start >= pos.start && start <= pos.end) {
                    replaceStart = pos.start;
                    replaceEnd   = pos.end;
                    break;
                }
            }
        }

        const newValue  = value.substring(0, replaceStart) + ref + value.substring(replaceEnd);
        const newCursor = replaceStart + ref.length;

        this.updateDraft(newValue, newCursor, newCursor);
        this.requestFocus(this.surface);
    }

    /**
     * Append a formula reference after the current cursor position.
     * @param {string} ref
     */
    appendReference(ref) {
        if (!this.isEditing || !this.isFormulaMode) return;

        const value  = this.draft;
        const pos    = Math.max(this.cursorStart, this.cursorEnd);
        const before = value.substring(0, pos);
        const after  = value.substring(pos);

        const lastChar  = before.trimEnd().slice(-1);
        const needsComma = lastChar && !',;(+-*/='.includes(lastChar);
        const prefix    = needsComma ? ',' : '';

        const newValue  = before + prefix + ref + after;
        const newCursor = pos + prefix.length + ref.length;

        this.updateDraft(newValue, newCursor, newCursor);
        this.requestFocus(this.surface);
    }

    /**
     * Commit current edit and return payload to persist.
     * @returns {{ row: number, col: number, value: string, tfr: Array|null } | null}
     */
    commit() {
        if (!this.isEditing || !this.cell) return null;

        const payload = {
            row:   this.cell.row,
            col:   this.cell.col,
            value: this.livePlainText ?? this.draft,
            tfr:   this.liveTfr,
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
        this.phase          = 'idle';
        this.cell           = null;
        this.draft          = '';
        this.initialTfr     = null;
        this.livePlainText  = null;
        this.liveTfr        = null;
        this.applyInlineFormat = null;
        this.cursorStart    = 0;
        this.cursorEnd      = 0;
        this.surface        = 'grid';
        this.pickerMode     = null;
        this.editingSheetId = null;
        this.sessionId++;
        formulaEditState.stopEditing();
    }
}

// ─── Reference parsing (formula mode) ────────────────────────────────────────

function _findReferencePositions(formula) {
    const positions = [];
    if (!formula) return positions;

    const content = formula.startsWith('=') ? formula.slice(1) : formula;
    const offset  = formula.startsWith('=') ? 1 : 0;
    let match;

    const crossSheetRegex = /(?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]+\$?\d+(?::\$?[A-Za-z]+\$?\d+)?/g;
    const crossSheetPositions = [];
    while ((match = crossSheetRegex.exec(content)) !== null) {
        crossSheetPositions.push({ start: match.index, end: match.index + match[0].length });
        positions.push({ start: match.index + offset, end: match.index + match[0].length + offset });
    }

    function inCrossSheet(idx) {
        return crossSheetPositions.some(r => idx >= r.start && idx < r.end);
    }

    const rangeRegex = /\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+/g;
    const rangePositions = [];
    while ((match = rangeRegex.exec(content)) !== null) {
        if (!inCrossSheet(match.index)) {
            rangePositions.push({ start: match.index, end: match.index + match[0].length });
            positions.push({ start: match.index + offset, end: match.index + match[0].length + offset });
        }
    }

    const cellRegex = /\$?[A-Za-z]+\$?\d+/g;
    while ((match = cellRegex.exec(content)) !== null) {
        if (!inCrossSheet(match.index) &&
            !rangePositions.some(r => match.index >= r.start && match.index < r.end)) {
            positions.push({ start: match.index + offset, end: match.index + match[0].length + offset });
        }
    }

    return positions.sort((a, b) => a.start - b.start);
}

function _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function _toText(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

export const editSessionState = new EditSessionState();

export default EditSessionState;
