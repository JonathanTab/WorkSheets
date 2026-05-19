import { REFERENCE_COLORS, extractRangeRefs, getCursorRefContext } from '../../formulas/formulaParser.js';

/**
 * EditSessionState - Canonical editing lifecycle for spreadsheet cells.
 *
 * Single source of truth for all edit state: draft text, cursor, surface,
 * formula ref highlights (for SelectionRenderer), and rich-text live sync.
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

    /** @type {Array|null} */
    initialTfr = $state(null);

    /** @type {string|null} */
    livePlainText = $state(null);

    /** @type {Array|null} */
    liveTfr = $state(null);

    /** @type {number | 'mixed' | null} */
    inlineSelFontSize = $state(null);

    /** @type {Function|null} */
    applyInlineFormat = null;

    /** @type {string | null} */
    editingSheetId = $state(null);

    /**
     * One colored rect per unique reference in the current formula.
     * Used by SelectionRenderer to draw ref-highlight outlines.
     * @type {Array<import('../../formulas/formulaParser.js').RefDescriptor & { color: string }>}
     */
    rangeHighlights = $state([]);

    /** @type {Map<string, Function>} */
    #focusHandles = new Map();

    get isEditing()     { return this.phase === 'editing'; }
    get isFormulaMode() { return this.isEditing && this.draft.startsWith('='); }

    setFocusHandle(surface, fn) { if (fn) this.#focusHandles.set(surface, fn); }
    clearFocusHandle(surface)   { this.#focusHandles.delete(surface); }

    requestFocus(surface = this.surface) {
        setTimeout(() => this.#focusHandles.get(surface)?.(), 0);
    }

    switchSurface(surface, { focus = true } = {}) {
        this.surface = surface;
        if (focus) this.requestFocus(surface);
    }

    isEditingCell(row, col) {
        return this.isEditing && this.cell?.row === row && this.cell?.col === col;
    }

    beginEdit(row, col, initialValue = '', surface = 'grid', options = {}) {
        const text = _str(initialValue);
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
        this.pickerMode     = options.pickerMode ?? null;
        this.editingSheetId = options.sheetId    ?? null;
        this.#updateHighlights(text);
        this.requestFocus(surface);
    }

    updateDraft(value, cursorStart = null, cursorEnd = null) {
        if (!this.isEditing) return;
        const text       = _str(value);
        this.draft       = text;
        const nextStart  = cursorStart ?? text.length;
        const nextEnd    = cursorEnd   ?? nextStart;
        this.cursorStart = _clamp(nextStart, 0, text.length);
        this.cursorEnd   = _clamp(nextEnd,   0, text.length);
        this.#updateHighlights(text);
    }

    setCursor(start, end = start) {
        if (!this.isEditing) return;
        this.cursorStart = _clamp(start, 0, this.draft.length);
        this.cursorEnd   = _clamp(end,   0, this.draft.length);
    }

    /**
     * Smart reference insertion:
     *   replace — cursor inside an existing ref token → replace it
     *   insert  — cursor after operator / open-paren / '=' → insert directly
     *   append  — cursor after a value or ')' → prepend ',' then insert
     * A non-collapsed selection is replaced unconditionally.
     * @param {string} ref
     */
    insertReference(ref) {
        if (!this.isEditing || !this.isFormulaMode) return;
        const selStart = Math.min(this.cursorStart, this.cursorEnd);
        const selEnd   = Math.max(this.cursorStart, this.cursorEnd);
        let rStart = selStart, rEnd = selEnd, prefix = '';

        if (selStart === selEnd) {
            const ctx = getCursorRefContext(this.draft, selStart);
            if (ctx.mode === 'replace') { rStart = ctx.replaceStart; rEnd = ctx.replaceEnd; }
            else if (ctx.mode === 'append') { prefix = ','; }
        }

        const next   = this.draft.slice(0, rStart) + prefix + ref + this.draft.slice(rEnd);
        const cursor = rStart + prefix.length + ref.length;
        this.updateDraft(next, cursor, cursor);
        this.requestFocus(this.surface);
    }

    /**
     * Append a ref after the cursor with an automatic comma separator.
     * Used for Ctrl+click multi-ref selection.
     * @param {string} ref
     */
    appendReference(ref) {
        if (!this.isEditing || !this.isFormulaMode) return;
        const pos    = Math.max(this.cursorStart, this.cursorEnd);
        const before = this.draft.slice(0, pos);
        const after  = this.draft.slice(pos);
        const last   = before.trimEnd().slice(-1);
        const prefix = (last && !',;(+-*/=<>^&:'.includes(last)) ? ',' : '';
        const next   = before + prefix + ref + after;
        const cursor = pos + prefix.length + ref.length;
        this.updateDraft(next, cursor, cursor);
        this.requestFocus(this.surface);
    }

    commit() {
        if (!this.isEditing || !this.cell) return null;
        const payload = { row: this.cell.row, col: this.cell.col,
                          value: this.livePlainText ?? this.draft, tfr: this.liveTfr };
        this.#stopEditing();
        return payload;
    }

    cancel() {
        if (!this.isEditing) return;
        this.#stopEditing();
    }

    #updateHighlights(text) {
        if (!text?.startsWith('=')) { this.rangeHighlights = []; return; }
        let i = 0;
        this.rangeHighlights = extractRangeRefs(text).map(ref => ({
            ...ref, color: REFERENCE_COLORS[i++ % REFERENCE_COLORS.length],
        }));
    }

    #stopEditing() {
        this.phase             = 'idle';
        this.cell              = null;
        this.draft             = '';
        this.initialTfr        = null;
        this.livePlainText     = null;
        this.liveTfr           = null;
        this.inlineSelFontSize = null;
        this.applyInlineFormat = null;
        this.cursorStart       = 0;
        this.cursorEnd         = 0;
        this.surface           = 'grid';
        this.pickerMode        = null;
        this.editingSheetId    = null;
        this.rangeHighlights   = [];
        this.sessionId++;
    }
}

function _clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function _str(v) { return (v === null || v === undefined) ? '' : String(v); }

export const editSessionState = new EditSessionState();
