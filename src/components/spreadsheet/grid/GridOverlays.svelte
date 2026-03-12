<script>
    /**
     * GridOverlays - Cell Editor Overlay (Canvas Architecture)
     *
     * Simplified for the canvas rendering architecture. Renders only:
     *   - The active cell editor (text input or picker)
     *   - Formula segment colorization overlay
     *   - FormulaValuePopup
     *
     * Selection fill is painted on canvas.
     * Selection / anchor borders are DOM <div>s managed by Grid.svelte.
     * Formula cell-reference highlights are painted on canvas.
     *
     * ## Positioning
     * editorBounds { top, left, width, height } are relative to the
     * grid container's top-left corner (i.e. already include header offsets).
     */

    import { segmentFormula } from "../../../formulas/reference-highlighter.js";
    import { editSessionState } from "../../../stores/spreadsheet/index.js";
    import { runsToHtml, htmlToRuns } from "../../../stores/spreadsheet/richText.js";
    import FormulaValuePopup from "../FormulaValuePopup.svelte";
    import PickerEditor from "../cellTypes/PickerEditor.svelte";

    let {
        /**
         * Pre-computed editor position.
         * { top, left, width, height } — all in CSS px, container-relative.
         * null when not editing.
         * @type {{ top: number, left: number, width: number, height: number } | null}
         */
        editorBounds = null,
        isEditing = false,
        editValue = "",
        onEditInput,
        onEditSelect,
        onCommitEdit,
        onCancelEdit,
        onCtrlEnter,
    } = $props();

    let cellEditInputEl = $state(null);
    let richEditEl = $state(null);

    let pickerMode = $derived(editSessionState.pickerMode);
    let isFormulaMode = $derived(isEditing && (typeof editValue === 'string') && editValue?.startsWith("="));
    // Use rich text editor when the session has a rich text value
    let isRichTextMode = $derived(isEditing && editSessionState.richTextValue != null);
    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue ?? "") : [],
    );

    // When switching to rich text mode, initialize contenteditable HTML and register format applier
    $effect(() => {
        if (isRichTextMode && richEditEl) {
            const html = runsToHtml(editSessionState.richTextValue);
            richEditEl.innerHTML = html;
            // Move cursor to end
            const range = document.createRange();
            range.selectNodeContents(richEditEl);
            range.collapse(false);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            // Register so toolbar can apply inline formatting
            editSessionState.richFormatApplier = applyRichFormat;
            return () => { editSessionState.richFormatApplier = null; };
        }
    });

    function handleEditBlur() {
        if (pickerMode) return;
        onCommitEdit?.(editValue);
    }

    function handleRichBlur() {
        if (!richEditEl) return;
        // Use a short delay so that clicks on the formatting toolbar (which temporarily
        // steal focus) can refocus the editor via applyRichFormat before we commit.
        setTimeout(() => {
            if (document.activeElement === richEditEl) return; // focus returned
            if (!richEditEl) return;
            const runs = htmlToRuns(richEditEl);
            onCommitEdit?.(runs);
        }, 150);
    }

    function handleEditKeydown(e) {
        if (e.key === "Enter") {
            e.stopPropagation();
            onCommitEdit?.(editValue);
        } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancelEdit?.();
        } else if (e.key === "Tab") {
            e.stopPropagation();
            onCommitEdit?.(editValue);
        }
    }

    /**
     * Keydown handler for the plain <input> editor.
     * Ctrl+Enter converts the current text to a rich-text run array so the
     * contenteditable editor takes over and the user can insert a line break.
     */
    function handleInputKeydown(e) {
        if (e.key === "Enter" && e.ctrlKey) {
            e.stopPropagation();
            e.preventDefault();
            // Convert current plain text to rich text and signal parent to save + reopen.
            const currentText = /** @type {HTMLInputElement} */ (e.target).value;
            onCtrlEnter?.(currentText);
        } else {
            handleEditKeydown(e);
        }
    }

    function handleRichKeydown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            onCancelEdit?.();
        } else if (e.key === "Tab") {
            e.stopPropagation();
            handleRichBlur();
        } else if (e.key === "Enter" && !e.ctrlKey) {
            // Plain Enter = commit
            e.stopPropagation();
            e.preventDefault();
            handleRichBlur();
        } else if (e.key === "Enter" && e.ctrlKey) {
            // Ctrl+Enter = insert line break
            e.stopPropagation();
            e.preventDefault();
            insertRichLineBreak();
        }
    }

    function handleRichInput() {
        if (!richEditEl) return;
        // Keep plain-text draft in sync for formula bar display
        const plain = richEditEl.innerText;
        onEditInput?.(plain, null, null);
    }

    function insertRichLineBreak() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = document.createElement('br');
        range.insertNode(br);
        // Insert a zero-width text node after <br> so cursor has somewhere to go
        const textNode = document.createTextNode('\u200B');
        br.after(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /**
     * Apply a format to the current selection in the rich text editor.
     * Called by FormattingToolbar when editing is active.
     * @param {string} prop  CSS property ('fontWeight', 'fontStyle', 'textDecoration', 'color', 'fontSize')
     * @param {string} value
     */
    export function applyRichFormat(prop, value) {
        if (!richEditEl) return;
        richEditEl.focus();
        document.execCommand('styleWithCSS', false, 'true');
        if (prop === 'fontWeight') document.execCommand('bold', false, null);
        else if (prop === 'fontStyle') document.execCommand('italic', false, null);
        else if (prop === 'underline') document.execCommand('underline', false, null);
        else if (prop === 'strikethrough') document.execCommand('strikeThrough', false, null);
        else if (prop === 'color') document.execCommand('foreColor', false, value);
        else if (prop === 'fontSize') {
            // execCommand fontSize only accepts 1-7; use inline style instead
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
                const range = sel.getRangeAt(0);
                const span = document.createElement('span');
                span.style.fontSize = value + 'px';
                range.surroundContents(span);
            }
        }
    }

    function handlePickerCommit(val) {
        onCommitEdit?.(val);
    }

    export function focusEditor() {
        setTimeout(() => {
            if (isRichTextMode) richEditEl?.focus();
            else cellEditInputEl?.focus();
        }, 0);
    }

    let editorStyle = $derived.by(() => {
        if (!editorBounds) return "display:none;";
        return (
            [
                `top:${editorBounds.top}px`,
                `left:${editorBounds.left}px`,
                `width:${editorBounds.width}px`,
                `height:${editorBounds.height}px`,
            ].join("; ") + ";"
        );
    });
</script>

<!-- Fullscreen container: pointer-events none so mouse events reach the event layer -->
<div class="overlays-root">
    {#if editorBounds && isEditing}
        <div class="cell-editor" style={editorStyle}>
            {#if pickerMode}
                <PickerEditor
                    type={pickerMode}
                    value={editValue}
                    on:change={(e) => onEditInput?.(e.detail)}
                    on:commit={(e) => handlePickerCommit(e.detail)}
                    on:cancel={onCancelEdit}
                    on:blur={handleEditBlur}
                />
            {:else if isRichTextMode}
                <div
                    class="cell-rich-edit"
                    contenteditable="true"
                    bind:this={richEditEl}
                    onblur={handleRichBlur}
                    onkeydown={handleRichKeydown}
                    oninput={handleRichInput}
                ></div>
            {:else}
                <input
                    type="text"
                    class="cell-edit-input"
                    bind:this={cellEditInputEl}
                    value={editValue}
                    oninput={(e) => {
                        const t = /** @type {HTMLInputElement} */ (e.target);
                        onEditInput?.(
                            t.value,
                            t.selectionStart,
                            t.selectionEnd,
                        );
                    }}
                    onselect={(e) => {
                        const t = /** @type {HTMLInputElement} */ (e.target);
                        onEditSelect?.(t.selectionStart, t.selectionEnd);
                    }}
                    onblur={handleEditBlur}
                    onkeydown={handleInputKeydown}
                />
            {/if}
            {#if isFormulaMode}
                <div class="formula-overlay" aria-hidden="true">
                    {#each formulaSegments as segment}
                        {#if segment.color}
                            <span
                                style="color:{segment.color}; font-weight:600;"
                                >{segment.text}</span
                            >
                        {:else if segment.type === "FUNCTION"}
                            <span class="formula-function">{segment.text}</span>
                        {:else}
                            <span>{segment.text}</span>
                        {/if}
                    {/each}
                </div>
                <FormulaValuePopup formula={editValue} visible={true} />
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
        font-size: 0.8125rem;
        outline: 2px solid var(--editor-outline, #3b82f6);
        background: var(--input-bg, #ffffff);
        color: var(--text-color, #1e293b);
        position: relative;
        z-index: 2;
        box-sizing: border-box;
    }

    .cell-rich-edit {
        width: 100%;
        height: 100%;
        min-height: 100%;
        border: none;
        padding: 2px 4px;
        font-size: 0.8125rem;
        font-family: var(--cell-font, system-ui, -apple-system, sans-serif);
        outline: 2px solid var(--editor-outline, #3b82f6);
        background: var(--input-bg, #ffffff);
        color: var(--text-color, #1e293b);
        position: relative;
        z-index: 2;
        box-sizing: border-box;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.5;
    }

    .cell-editor:has(.cell-edit-input) .cell-edit-input {
        font-family: monospace;
    }

    .cell-editor:has(.cell-edit-input) .formula-overlay {
        position: absolute;
        inset: 0;
        padding: 0 4px;
        font-size: 0.8125rem;
        line-height: normal;
        pointer-events: none;
        white-space: pre;
        overflow: hidden;
        font-family: monospace;
        z-index: 1;
        color: var(--text-color, #1e293b);
        background: var(--input-bg, #ffffff);
        outline: 2px solid var(--editor-outline, #3b82f6);
    }

    .formula-function {
        font-weight: 600;
        color: var(--function-color, #7c3aed);
    }

    .cell-editor:has(.formula-overlay) .cell-edit-input {
        color: transparent;
        background: transparent;
    }
</style>
