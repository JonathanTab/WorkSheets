<script>
    /**
     * GridOverlays - Cell Editor Overlay (Canvas Architecture)
     *
     * Editor modes:
     *   - Formula:  plain <input> with colored formula-segment overlay
     *   - Picker:   date/time/datetime/image/file picker
     *   - Text:     contenteditable <div> for ALL text cells (plain or rich)
     *
     * Rich text is stored as TextFormatRuns (tfr) alongside the plain text
     * value. The contenteditable shows formatted HTML while editing; on commit
     * we parse back to { plainText, tfr } via htmlToTfr().
     *
     * applyInlineFormat() is registered on editSessionState so the toolbar can
     * apply formatting to the current selection at any time during editing.
     */

    import { untrack } from "svelte";
    import { segmentFormula } from "../../../formulas/reference-highlighter.js";
    import { editSessionState } from "../../../stores/spreadsheet/index.js";
    import { spreadsheetSession } from "../../../stores/spreadsheetStore.svelte.js";
    import {
        runsToHtml,
        htmlToTfr,
        applyFormatToRange,
        toggleFormatInRange,
        getFormatAtIndex,
        getCharOffset,
        restoreSelection,
        normalizeTfr,
    } from "../../../stores/spreadsheet/textFormatRuns.js";
    import FormulaValuePopup from "../FormulaValuePopup.svelte";
    import PickerEditor from "../cellTypes/PickerEditor.svelte";
    import DatePickerEditor from "../cellTypes/DatePickerEditor.svelte";
    import ImageEditor from "../cellTypes/ImageEditor.svelte";
    import FileEditor from "../cellTypes/FileEditor.svelte";

    let {
        editorBounds = null,
        isEditing = false,
        editValue = "",
        onEditInput,
        onEditSelect,
        onCommitEdit,
        onCancelEdit,
        onTabCommit = null,
        docId = null,
    } = $props();

    let cellEditInputEl = $state(null);
    let richEditEl      = $state(null);

    // Saved selection offsets — updated on every selectionchange while the rich
    // editor is focused, so toolbar interactions that move focus (font-size input,
    // font-family select) can restore the selection before applying inline format.
    let savedSelStart = -1;
    let savedSelEnd   = -1;

    let pickerMode         = $derived(editSessionState.pickerMode);
    let isImagePickerMode  = $derived(pickerMode === 'image-picker');
    let isFilePickerMode   = $derived(pickerMode === 'file-picker');
    let isFormulaMode      = $derived(
        isEditing && typeof editValue === 'string' && editValue?.startsWith('=')
    );

    // Text mode = everything that is not a formula and not a picker
    let isTextMode = $derived(
        isEditing &&
        editSessionState.surface === 'grid' &&
        !pickerMode &&
        !isFormulaMode
    );

    // Cell type config (for file / date pickers)
    let cellCtConfig = $derived.by(() => {
        if (!editSessionState.isEditing || !editSessionState.cell) return null;
        const { row, col } = editSessionState.cell;
        return spreadsheetSession?.activeSheetStore?.getCellTypeConfig(row, col) ?? null;
    });

    let effectiveDateSubFormat = $derived.by(() => {
        if (cellCtConfig?.subFormat) return cellCtConfig.subFormat;
        if (pickerMode === 'time') return 'time';
        if (pickerMode === 'datetime-local') return 'datetime';
        return 'date';
    });

    // Effective cell-level formatting (font, color, background)
    let cellFormatting = $derived.by(() => {
        if (!editSessionState.isEditing || !editSessionState.cell) return null;
        const { row, col } = editSessionState.cell;
        return spreadsheetSession?.activeSheetStore?.getEffectiveCellStyle(row, col) ?? null;
    });

    let richEditStyle = $derived.by(() => {
        const f = cellFormatting;
        if (!f) return null;
        const parts = [];
        if (f.fontFamily)       parts.push(`font-family: ${f.fontFamily}, system-ui, -apple-system, sans-serif`);
        if (f.fontSize)         parts.push(`font-size: ${f.fontSize}px`);
        if (f.bold)             parts.push('font-weight: bold');
        if (f.italic)           parts.push('font-style: italic');
        if (f.color)            parts.push(`color: ${f.color}`);
        if (f.backgroundColor)  parts.push(`background: ${f.backgroundColor}`);
        return parts.length ? parts.join('; ') : null;
    });

    let plainEditStyle = $derived.by(() => {
        const f = cellFormatting;
        if (!f) return null;
        const parts = [];
        if (f.fontFamily) parts.push(`font-family: ${f.fontFamily}, system-ui, -apple-system, sans-serif`);
        if (f.fontSize)   parts.push(`font-size: ${f.fontSize}px`);
        if (f.bold)       parts.push('font-weight: bold');
        if (f.italic)     parts.push('font-style: italic');
        return parts.length ? parts.join('; ') : null;
    });

    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue ?? '') : []
    );

    // ── Initialize contenteditable when text mode starts or cell changes ──────

    $effect(() => {
        const _row = editSessionState.cell?.row;
        const _col = editSessionState.cell?.col;
        if (isTextMode && richEditEl) {
            untrack(() => {
                const tfr  = editSessionState.initialTfr;
                const text = editSessionState.draft;
                richEditEl.innerHTML = runsToHtml(text, tfr);

                // Move cursor to end
                const range = document.createRange();
                range.selectNodeContents(richEditEl);
                range.collapse(false);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);

                // Sync live state so clickaway-commits have the initial value
                _syncLive();

                // Register format applier for toolbar
                editSessionState.applyInlineFormat = _applyInlineFormat;

                // Track selection so toolbar inputs that move focus (font-size, font-family)
                // can restore it before applying formatting.
                savedSelStart = -1;
                savedSelEnd   = -1;
            });

            function onSelectionChange() {
                const sel = richEditEl && window.getSelection();
                if (!sel || !richEditEl.contains(sel.anchorNode)) return;
                const range = sel.getRangeAt(0);
                savedSelStart = getCharOffset(richEditEl, range.startContainer, range.startOffset);
                savedSelEnd   = getCharOffset(richEditEl, range.endContainer,   range.endOffset);
            }
            document.addEventListener('selectionchange', onSelectionChange);

            return () => {
                editSessionState.applyInlineFormat = null;
                document.removeEventListener('selectionchange', onSelectionChange);
            };
        }
    });

    // ── Live sync helpers ─────────────────────────────────────────────────────

    function _syncLive() {
        if (!richEditEl) return;
        const { plainText, tfr } = htmlToTfr(richEditEl.innerHTML);
        editSessionState.livePlainText = plainText || richEditEl.innerText || '';
        editSessionState.liveTfr       = tfr;
    }

    // ── Commit helpers ────────────────────────────────────────────────────────

    function _commitRichFromElement() {
        if (!richEditEl) return;
        const { plainText, tfr } = htmlToTfr(richEditEl.innerHTML);
        const text = plainText || richEditEl.innerText || richEditEl.textContent || '';
        onCommitEdit?.({ value: text, tfr: tfr ?? null });
    }

    function _commitRichFromCapture(html, innerText) {
        const { plainText, tfr } = htmlToTfr(html);
        const text = plainText || innerText || '';
        onCommitEdit?.({ value: text, tfr: tfr ?? null });
    }

    // ── Blur / commit flow ────────────────────────────────────────────────────

    function handleEditBlur() {
        if (pickerMode) return;
        if (editSessionState.surface !== 'grid') return;
        onCommitEdit?.(editValue);
    }

    function handleRichBlur() {
        if (!richEditEl) return;
        const html      = richEditEl.innerHTML;
        const innerText = richEditEl.innerText;

        setTimeout(() => {
            if (document.activeElement === richEditEl) return;
            if (editSessionState.surface !== 'grid') return;
            const toolbar = document.querySelector('.formatting-toolbar');
            if (toolbar?.contains(document.activeElement)) return;
            _commitRichFromCapture(html, innerText);
        }, 150);
    }

    // ── Keyboard handlers ─────────────────────────────────────────────────────

    function handleEditKeydown(e) {
        if (e.key === 'Enter') {
            e.stopPropagation();
            e.preventDefault();
            onTabCommit ? onTabCommit(1) : onCommitEdit?.(editValue);
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            onCancelEdit?.();
        } else if (e.key === 'Tab') {
            e.stopPropagation();
            e.preventDefault();
            onTabCommit ? onTabCommit(e.shiftKey ? -1 : 1, 'tab') : onCommitEdit?.(editValue);
        }
    }

    function handleRichKeydown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            onCancelEdit?.();
        } else if (e.key === 'Tab') {
            e.stopPropagation();
            e.preventDefault();
            if (onTabCommit) {
                _commitRichFromElement();
                onTabCommit(e.shiftKey ? -1 : 1, 'tab');
            } else {
                handleRichBlur();
            }
        } else if (e.key === 'Enter' && !e.ctrlKey) {
            e.stopPropagation();
            e.preventDefault();
            if (onTabCommit) {
                _commitRichFromElement();
                onTabCommit(1);
            } else {
                _commitRichFromElement();
            }
        } else if (e.key === 'Enter' && e.ctrlKey) {
            e.stopPropagation();
            e.preventDefault();
            _insertLineBreak();
        }
    }

    function handleRichInput() {
        if (!richEditEl) return;
        // Full sync on every input so clickaway-commits always have accurate plain text + tfr.
        // Stale liveTfr would cause old formatting to reattach to newly typed text.
        _syncLive();
        onEditInput?.(editSessionState.livePlainText ?? '', null, null);
    }

    // ── Line break insertion ──────────────────────────────────────────────────

    function _insertLineBreak() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = document.createElement('br');
        range.insertNode(br);
        const zwsp = document.createTextNode('​');
        br.after(zwsp);
        range.setStartAfter(zwsp);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        _syncLive();
    }

    // ── Inline format application (called by toolbar) ─────────────────────────

    /**
     * Apply inline formatting to the current selection.
     * Returns true if a selection existed and formatting was applied,
     * false if cursor was collapsed (toolbar should apply cell-level format).
     *
     * @param {string} prop   TextFormat property name (e.g. 'bold', 'foregroundColor')
     * @param {any}    value  value to set, or undefined for toggle props
     * @returns {boolean}
     */
    function _applyInlineFormat(prop, value) {
        if (!richEditEl) return false;
        _focusNoScroll(richEditEl);

        let sel = window.getSelection();
        let hasSelection = sel && !sel.isCollapsed && richEditEl.contains(sel.anchorNode);

        // When focus moved to a toolbar input (font-size field, font-family select),
        // the browser may have cleared the selection. Restore from saved offsets.
        if (!hasSelection && savedSelStart >= 0 && savedSelEnd > savedSelStart) {
            restoreSelection(richEditEl, savedSelStart, savedSelEnd);
            sel = window.getSelection();
            hasSelection = sel && !sel.isCollapsed && richEditEl.contains(sel.anchorNode);
        }

        if (!hasSelection) return false;

        // Compute char offsets
        const range  = sel.getRangeAt(0);
        const start  = getCharOffset(richEditEl, range.startContainer, range.startOffset);
        const end    = getCharOffset(richEditEl, range.endContainer,   range.endOffset);
        if (start >= end) return false;

        // Parse current HTML to tfr
        const { plainText, tfr: currentTfr } = htmlToTfr(richEditEl.innerHTML);
        const textLen = plainText.length;

        // Compute new tfr
        let newTfr;
        const toggleProps = new Set(['bold', 'italic', 'underline', 'strikethrough']);
        if (toggleProps.has(prop) && value === undefined) {
            newTfr = toggleFormatInRange(currentTfr, start, end, prop, textLen);
        } else if (prop === 'link' && !value) {
            // Remove link
            newTfr = applyFormatToRange(currentTfr, start, end, { link: null }, textLen);
        } else {
            newTfr = applyFormatToRange(currentTfr, start, end, { [prop]: value }, textLen);
        }

        // Re-render HTML preserving content
        richEditEl.innerHTML = runsToHtml(plainText, newTfr);

        // Restore selection
        restoreSelection(richEditEl, start, end);

        _syncLive();
        return true;
    }

    // ── Focus helpers ─────────────────────────────────────────────────────────

    function _focusNoScroll(el) {
        if (!el) return;
        try { el.focus({ preventScroll: true }); }
        catch { el.focus(); }
    }

    export function focusEditor() {
        setTimeout(() => {
            if (isTextMode) _focusNoScroll(richEditEl);
            else _focusNoScroll(cellEditInputEl);
        }, 0);
    }

    // ── Picker commits ────────────────────────────────────────────────────────

    function handlePickerCommit(val) {
        onCommitEdit?.(val);
    }

    // ── Editor position style ─────────────────────────────────────────────────

    let editorStyle = $derived.by(() => {
        if (!editorBounds) return 'display:none;';
        return [
            `top:${editorBounds.top}px`,
            `left:${editorBounds.left}px`,
            `width:${editorBounds.width}px`,
            `height:${editorBounds.height}px`,
        ].join('; ') + ';';
    });
</script>

<div class="overlays-root">
    {#if editorBounds && isEditing && editSessionState.surface === 'grid'}
        <div class="cell-editor" style={editorStyle}>
            {#if isImagePickerMode}
                <ImageEditor
                    value={editValue}
                    {docId}
                    onCommit={(blobId, fit) => {
                        onCommitEdit?.(blobId ?? '');
                        if (typeof window !== 'undefined') {
                            window.dispatchEvent(new CustomEvent('image-fit-change', { detail: { fit } }));
                        }
                    }}
                    onCancel={onCancelEdit}
                />
            {:else if isFilePickerMode}
                <FileEditor
                    value={editValue}
                    {docId}
                    onCommit={(blobId) => onCommitEdit?.(blobId ?? '')}
                    onCancel={onCancelEdit}
                />
            {:else if pickerMode === 'date' || pickerMode === 'time' || pickerMode === 'datetime-local'}
                <DatePickerEditor
                    value={editValue}
                    subFormat={effectiveDateSubFormat}
                    onchange={(val) => onEditInput?.(val)}
                    oncommit={(val) => handlePickerCommit(val)}
                    oncancel={onCancelEdit}
                />
            {:else if pickerMode}
                <PickerEditor
                    type={pickerMode}
                    value={editValue}
                    on:change={(e) => onEditInput?.(e.detail)}
                    on:commit={(e) => handlePickerCommit(e.detail)}
                    on:cancel={onCancelEdit}
                    on:blur={handleEditBlur}
                />
            {:else if isTextMode}
                <!-- Unified contenteditable for all text cells (plain and rich) -->
                <div
                    role="textbox"
                    tabindex="-1"
                    class="cell-rich-edit"
                    style={richEditStyle}
                    contenteditable="true"
                    bind:this={richEditEl}
                    onblur={handleRichBlur}
                    onkeydown={handleRichKeydown}
                    oninput={handleRichInput}
                ></div>
            {:else}
                <!-- Formula mode: transparent input + colored overlay -->
                <input
                    type="text"
                    class="cell-edit-input"
                    style={plainEditStyle}
                    bind:this={cellEditInputEl}
                    value={editValue}
                    oninput={(e) => {
                        const t = /** @type {HTMLInputElement} */ (e.target);
                        onEditInput?.(t.value, t.selectionStart, t.selectionEnd);
                    }}
                    onselect={(e) => {
                        const t = /** @type {HTMLInputElement} */ (e.target);
                        onEditSelect?.(t.selectionStart, t.selectionEnd);
                    }}
                    onblur={handleEditBlur}
                    onkeydown={handleEditKeydown}
                />
                {#if isFormulaMode}
                    <div class="formula-overlay" aria-hidden="true">
                        <span class="formula-overlay-text">
                            {#each formulaSegments as segment}
                                {#if segment.color}
                                    <span style="color:{segment.color}; font-weight:600;">{segment.text}</span>
                                {:else if segment.type === 'FUNCTION'}
                                    <span class="formula-function">{segment.text}</span>
                                {:else}
                                    <span>{segment.text}</span>
                                {/if}
                            {/each}
                        </span>
                    </div>
                    <FormulaValuePopup formula={editValue} visible={true} />
                {/if}
            {/if}
        </div>
    {/if}
</div>

<style>
    .overlays-root {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 20;
        overflow: visible;
    }

    .cell-editor {
        position: absolute;
        pointer-events: auto;
        z-index: 110;
        overflow: visible;
    }

    .cell-edit-input {
        width: 100%;
        height: 100%;
        border: none;
        padding: 0 4px;
        font-size: 12px;
        font-family: system-ui, -apple-system, sans-serif;
        outline: 2px solid var(--editor-outline, #3b82f6);
        background: var(--input-bg, #ffffff);
        color: var(--text-color, #1e293b);
        position: relative;
        z-index: 2;
        box-sizing: border-box;
    }

    .cell-rich-edit {
        width: 100%;
        height: auto;
        min-height: 100%;
        border: none;
        padding: 2px 4px;
        font-size: 12px;
        font-family: system-ui, -apple-system, sans-serif;
        outline: 2px solid var(--editor-outline, #3b82f6);
        background: var(--input-bg, #ffffff);
        color: var(--text-color, #1e293b);
        position: relative;
        z-index: 2;
        box-sizing: border-box;
        overflow: visible;
        white-space: pre-wrap;
        overflow-wrap: break-word;
        word-break: break-word;
        line-height: 1.5;
    }

    .cell-editor:has(.formula-overlay) .cell-edit-input {
        font-family: monospace;
    }

    .formula-overlay {
        position: absolute;
        inset: 0;
        padding: 0 4px;
        font-size: 12px;
        pointer-events: none;
        overflow: hidden;
        font-family: monospace;
        z-index: 1;
        color: var(--text-color, #1e293b);
        background: var(--input-bg, #ffffff);
        outline: 2px solid var(--editor-outline, #3b82f6);
        display: flex;
        align-items: center;
    }

    .formula-overlay-text {
        white-space: pre;
        overflow: hidden;
        min-width: 0;
    }

    .formula-function {
        font-weight: 600;
        color: var(--function-color, #7c3aed);
    }

    .cell-editor:has(.formula-overlay) .cell-edit-input {
        color: transparent;
        background: transparent;
        caret-color: var(--text-color, #1e293b);
    }
</style>
