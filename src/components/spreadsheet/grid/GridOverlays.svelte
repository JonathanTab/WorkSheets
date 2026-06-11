<script>
    /**
     * GridOverlays - Cell Editor Overlay (Canvas Architecture)
     *
     * Editor modes:
     *   formula  — FormulaInput (transparent input + colored overlay)
     *   text     — contenteditable for plain and rich text
     *   picker   — date/time/image/file pickers
     */

    import { untrack } from "svelte";
    import { editSessionState } from "../../../stores/spreadsheet/index.js";
    import { spreadsheetSession } from "../../../stores/spreadsheetStore.svelte.js";
    import {
        runsToHtml,
        htmlToTfr,
        applyFormatToRange,
        toggleFormatInRange,
        getFormatAtIndex,
        queryFormatInRange,
        queryLinkInRange,
        getCharOffset,
        restoreSelection,
    } from "../../../stores/spreadsheet/textFormatRuns.js";
    import FormulaInput from "../FormulaInput.svelte";
    import PickerEditor from "../cellTypes/PickerEditor.svelte";
    import DatePickerEditor from "../cellTypes/DatePickerEditor.svelte";
    import ImageEditor from "../cellTypes/ImageEditor.svelte";
    import FileEditor from "../cellTypes/FileEditor.svelte";
    import { ptToPx } from "../../../stores/spreadsheet/rendering/fontUnits.js";

    // Canvas default — kept in sync with CanvasRenderer DEFAULT_THEME.defaultFontSize.
    // The editor uses the same pt → integer-px conversion as the canvas so the visible
    // size and crispness match between the two render paths.
    const DEFAULT_FONT_SIZE_PT = 10;

    let {
        editorBounds = null,
        isEditing    = false,
        editValue    = '',
        onEditInput,
        onEditSelect,
        onCommitEdit,
        onCancelEdit,
        onTabCommit  = null,
        docId        = null,
    } = $props();

    let formulaInputComponent = $state(null);
    let richEditEl            = $state(null);
    let _suppressNextBlur     = false;

    // Saved selection offsets so toolbar focus-grabs (font-size input etc.) can
    // restore the selection before applying inline formatting.
    let savedSelStart = -1;
    let savedSelEnd   = -1;

    let pickerMode        = $derived(editSessionState.pickerMode);
    let isImagePickerMode = $derived(pickerMode === 'image-picker');
    let isFilePickerMode  = $derived(pickerMode === 'file-picker');
    let isFormulaMode     = $derived(isEditing && typeof editValue === 'string' && editValue.startsWith('='));
    let isTextMode        = $derived(
        isEditing && editSessionState.surface === 'grid' && !pickerMode && !isFormulaMode
    );

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

    let cellFormatting = $derived.by(() => {
        if (!editSessionState.isEditing || !editSessionState.cell) return null;
        const { row, col } = editSessionState.cell;
        const sheetStore = spreadsheetSession?.activeSheetStore;
        if (!sheetStore) return null;
        // Touch version counters so this re-runs whenever any formatting changes
        // (row/col meta and cell styles are not tracked through Map.get alone).
        const _r = sheetStore.rowMetaVersion;
        const _c = sheetStore.colMetaVersion;
        const _v = sheetStore.cellsVersion;
        return sheetStore.getEffectiveCellStyle(row, col) ?? null;
    });

    // Map cell vAlign → flex align-items / multi-line justify-content so the
    // editor's text sits at the same Y the canvas painted.
    function _vAlignToFlex(vAlign) {
        if (vAlign === 'top') return 'flex-start';
        if (vAlign === 'bottom') return 'flex-end';
        return 'center';
    }

    let richEditStyle = $derived.by(() => {
        const f = cellFormatting;
        if (!f) return null;
        const parts = [`font-size: ${ptToPx(f.fontSize || DEFAULT_FONT_SIZE_PT)}px`];
        // .cell-rich-edit is a flex column: justify-content controls the vertical
        // position of the text block (matches canvas vAlign), text-align the
        // horizontal (matches canvas hAlign).
        parts.push(`justify-content: ${_vAlignToFlex(f.verticalAlign)}`);
        parts.push(`text-align: ${f.horizontalAlign || 'left'}`);
        if (f.fontFamily)      parts.push(`font-family: ${f.fontFamily}, system-ui, -apple-system, sans-serif`);
        if (f.bold)            parts.push('font-weight: bold');
        if (f.italic)          parts.push('font-style: italic');
        if (f.color)           parts.push(`color: ${f.color}`);
        if (f.backgroundColor) parts.push(`background: ${f.backgroundColor}`);
        return parts.join('; ');
    });

    let plainEditStyle = $derived.by(() => {
        const f = cellFormatting;
        if (!f) return null;
        const parts = [`font-size: ${ptToPx(f.fontSize || DEFAULT_FONT_SIZE_PT)}px`];
        // .formula-cell-wrap is a flex row: align-items is the vertical (cross) axis.
        parts.push(`align-items: ${_vAlignToFlex(f.verticalAlign)}`);
        if (f.fontFamily) parts.push(`font-family: ${f.fontFamily}, system-ui, -apple-system, sans-serif`);
        if (f.bold)       parts.push('font-weight: bold');
        if (f.italic)     parts.push('font-style: italic');
        return parts.join('; ');
    });

    let editorStyle = $derived.by(() => {
        if (!editorBounds) return 'display:none;';
        return `top:${editorBounds.top}px; left:${editorBounds.left}px; width:${editorBounds.width}px; height:${editorBounds.height}px;`;
    });

    // ── Rich text init ────────────────────────────────────────────────────────

    $effect(() => {
        const _row = editSessionState.cell?.row;
        const _col = editSessionState.cell?.col;
        if (!isTextMode || !richEditEl) return;

        untrack(() => {
            richEditEl.innerHTML = runsToHtml(editSessionState.draft, editSessionState.initialTfr);

            const range = document.createRange();
            range.selectNodeContents(richEditEl);
            range.collapse(false);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);

            _syncLive();
            editSessionState.applyInlineFormat = _applyInlineFormat;
            savedSelStart = -1;
            savedSelEnd   = -1;
        });

        function onSelectionChange() {
            const sel = richEditEl && window.getSelection();
            if (!sel || !richEditEl.contains(sel.anchorNode)) return;
            const range = sel.getRangeAt(0);
            savedSelStart = getCharOffset(richEditEl, range.startContainer, range.startOffset);
            savedSelEnd   = getCharOffset(richEditEl, range.endContainer,   range.endOffset);
            _updateInlineSelFontSize();
        }
        document.addEventListener('selectionchange', onSelectionChange);

        return () => {
            editSessionState.applyInlineFormat = null;
            editSessionState.inlineSelFontSize = null;
            document.removeEventListener('selectionchange', onSelectionChange);
        };
    });

    // ── Live sync ─────────────────────────────────────────────────────────────

    function _syncLive() {
        if (!richEditEl) return;
        const { plainText, tfr } = htmlToTfr(richEditEl.innerHTML);
        editSessionState.livePlainText = plainText || richEditEl.innerText || '';
        editSessionState.liveTfr       = tfr;
        _updateInlineSelFontSize();
    }

    function _updateInlineSelFontSize() {
        const tfr       = editSessionState.liveTfr;
        const plainText = editSessionState.livePlainText ?? '';
        const textLen   = plainText.length;
        if (!tfr || textLen === 0 || savedSelStart < 0) {
            editSessionState.inlineSelFontSize = null;
            editSessionState.inlineSelLink     = null;
            return;
        }
        const start = Math.max(0, savedSelStart);
        const end   = savedSelEnd;
        let size;
        const clampedEnd = Math.min(end, textLen);
        if (end <= start) {
            size = getFormatAtIndex(tfr, Math.min(start, textLen - 1))?.fontSize ?? null;
        } else {
            if (start >= clampedEnd) {
                editSessionState.inlineSelFontSize = null;
                editSessionState.inlineSelLink     = null;
                return;
            }
            const val = queryFormatInRange(tfr, start, clampedEnd, textLen, 'fontSize');
            size = (val === undefined) ? null : val;
        }
        editSessionState.inlineSelFontSize = size ?? null;
        editSessionState.inlineSelLink     = queryLinkInRange(tfr, start, clampedEnd, textLen);
    }

    // ── Rich text commit helpers ──────────────────────────────────────────────

    function _commitRichFromElement() {
        if (!richEditEl) return;
        const { plainText, tfr } = htmlToTfr(richEditEl.innerHTML);
        onCommitEdit?.({ value: plainText || richEditEl.innerText || richEditEl.textContent || '', tfr: tfr ?? null });
    }

    function _commitRichFromCapture(html, innerText) {
        const { plainText, tfr } = htmlToTfr(html);
        onCommitEdit?.({ value: plainText || innerText || '', tfr: tfr ?? null });
    }

    // ── Blur / commit ─────────────────────────────────────────────────────────

    function handleEditBlur() {
        if (pickerMode) return;
        if (editSessionState.surface !== 'grid') return;
        onCommitEdit?.(editValue);
    }

    function handleRichBlur() {
        if (!richEditEl || _suppressNextBlur) { _suppressNextBlur = false; return; }
        const html      = richEditEl.innerHTML;
        const innerText = richEditEl.innerText;
        setTimeout(() => {
            if (document.activeElement === richEditEl) return;
            if (editSessionState.surface !== 'grid') return;
            if (document.querySelector('.formatting-toolbar')?.contains(document.activeElement)) return;
            _commitRichFromCapture(html, innerText);
        }, 150);
    }

    // ── Keyboard ──────────────────────────────────────────────────────────────

    function handleFormulaKeydown(e) {
        if (e.key === 'Enter') {
            e.stopPropagation(); e.preventDefault();
            onTabCommit ? onTabCommit(1) : onCommitEdit?.(editValue);
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            onCancelEdit?.();
        } else if (e.key === 'Tab') {
            e.stopPropagation(); e.preventDefault();
            onTabCommit ? onTabCommit(e.shiftKey ? -1 : 1, 'tab') : onCommitEdit?.(editValue);
        }
    }

    function handleRichKeydown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            _suppressNextBlur = true;
            onCancelEdit?.();
        } else if (e.key === 'Tab') {
            e.stopPropagation(); e.preventDefault();
            if (onTabCommit) { _suppressNextBlur = true; _commitRichFromElement(); onTabCommit(e.shiftKey ? -1 : 1, 'tab'); }
            else { handleRichBlur(); }
        } else if (e.key === 'Enter' && !e.ctrlKey) {
            e.stopPropagation(); e.preventDefault();
            _suppressNextBlur = true;
            _commitRichFromElement();
            if (onTabCommit) onTabCommit(1);
        } else if (e.key === 'Enter' && e.ctrlKey) {
            e.stopPropagation(); e.preventDefault();
            _insertLineBreak();
        }
    }

    // ── Rich text editing helpers ─────────────────────────────────────────────

    function _insertLineBreak() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br   = document.createElement('br');
        const zwsp = document.createTextNode('​');
        range.insertNode(br);
        br.after(zwsp);
        range.setStartAfter(zwsp);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        _syncLive();
    }

    /**
     * Apply inline formatting to the current rich-text selection.
     * Called by the toolbar. Returns true if a selection existed.
     * @param {string} prop
     * @param {any} value
     * @returns {boolean}
     */
    function _applyInlineFormat(prop, value) {
        if (!richEditEl) return false;
        _focusNoScroll(richEditEl);

        let sel = window.getSelection();
        let hasSelection = sel && !sel.isCollapsed && richEditEl.contains(sel.anchorNode);

        if (!hasSelection && savedSelStart >= 0 && savedSelEnd > savedSelStart) {
            restoreSelection(richEditEl, savedSelStart, savedSelEnd);
            sel = window.getSelection();
            hasSelection = sel && !sel.isCollapsed && richEditEl.contains(sel.anchorNode);
        }
        if (!hasSelection) return false;

        const range  = sel.getRangeAt(0);
        const start  = getCharOffset(richEditEl, range.startContainer, range.startOffset);
        const end    = getCharOffset(richEditEl, range.endContainer,   range.endOffset);
        if (start >= end) return false;

        const { plainText, tfr: currentTfr } = htmlToTfr(richEditEl.innerHTML);
        const textLen = plainText.length;

        const toggleProps = new Set(['bold', 'italic', 'underline', 'strikethrough']);
        let newTfr;
        if (toggleProps.has(prop) && value === undefined) {
            newTfr = toggleFormatInRange(currentTfr, start, end, prop, textLen);
        } else if (prop === 'link' && !value) {
            newTfr = applyFormatToRange(currentTfr, start, end, { link: null }, textLen);
        } else {
            newTfr = applyFormatToRange(currentTfr, start, end, { [prop]: value }, textLen);
        }

        richEditEl.innerHTML = runsToHtml(plainText, newTfr);
        restoreSelection(richEditEl, start, end);
        _syncLive();
        return true;
    }

    // ── Focus ─────────────────────────────────────────────────────────────────

    function _focusNoScroll(el) {
        if (!el) return;
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    }

    export function focusEditor() {
        setTimeout(() => _focusNoScroll(isTextMode ? richEditEl : formulaInputComponent?.el), 0);
    }
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
                        window?.dispatchEvent(new CustomEvent('image-fit-change', { detail: { fit } }));
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
                    oncommit={(val) => onCommitEdit?.(val)}
                    oncancel={onCancelEdit}
                />
            {:else if pickerMode}
                <PickerEditor
                    type={pickerMode}
                    value={editValue}
                    on:change={(e) => onEditInput?.(e.detail)}
                    on:commit={(e) => onCommitEdit?.(e.detail)}
                    on:cancel={onCancelEdit}
                    on:blur={handleEditBlur}
                />
            {:else if isTextMode}
                <div
                    role="textbox"
                    tabindex="-1"
                    class="cell-rich-edit"
                    style={richEditStyle}
                    contenteditable="true"
                    bind:this={richEditEl}
                    onblur={handleRichBlur}
                    onkeydown={handleRichKeydown}
                    oninput={() => {
                        _syncLive();
                        onEditInput?.(editSessionState.livePlainText ?? '', null, null);
                    }}
                ></div>
            {:else}
                <!-- Formula / plain-text input -->
                <div class="formula-cell-wrap" style={plainEditStyle}>
                    <FormulaInput
                        bind:this={formulaInputComponent}
                        value={editValue}
                        scrollable={false}
                        selStart={editSessionState.cursorStart}
                        selEnd={editSessionState.cursorEnd}
                        caretSync={editSessionState.caretSync}
                        onInput={(val, s, e) => onEditInput?.(val, s, e)}
                        onSelect={(s, e) => onEditSelect?.(s, e)}
                        onKeydown={handleFormulaKeydown}
                        onBlur={handleEditBlur}
                    />
                </div>
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

    /* Wrapper that passes cell-level font/size styles to FormulaInput.
       font-size matches CanvasRenderer's ptToPx(defaultFontSize=10pt) = 13px so the
       editor and the grid render the same text size when no cell formatting is set. */
    .formula-cell-wrap {
        width: 100%;
        height: 100%;
        position: relative;
        font-size: 13px;
        font-family: system-ui, -apple-system, sans-serif;
        padding: 0 4px;
        box-sizing: border-box;
        outline: 2px solid var(--editor-outline, #3b82f6);
        background: var(--input-bg, #ffffff);
        color: var(--text-color, #1e293b);
        display: flex;
        align-items: center;
    }

    .cell-rich-edit {
        width: 100%;
        height: auto;
        min-height: 100%;
        border: none;
        /* Padding mirrors the canvas painter: CELL_PAD=2 vertical, CELL_PAD_X=4
           horizontal, so text starts at the same offset whether painted or edited. */
        padding: 2px 4px;
        font-size: 13px;
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
        /* Flex column lets justify-content (set per-cell vAlign in richEditStyle)
           position the text block to match the canvas. The default 'center'
           covers the common middle-aligned case. */
        display: flex;
        flex-direction: column;
        justify-content: center;
        /* Matches the canvas line cadence ((ascent+descent)*1.2 ≈ 1.2em) so
           multi-line text doesn't drift relative to the painted version. */
        line-height: 1.2;
    }
</style>
