<script>
    /**
     * GridOverlays - Cell Editor Overlay (Canvas Architecture)
     *
     * Renders the active cell editor, formula segment colorization, and FormulaValuePopup.
     *
     * Editor modes:
     *   - Formula: plain <input> with a colored overlay (formula starts with "=")
     *   - Picker:  date/time/datetime picker via PickerEditor.svelte
     *   - Text:    contenteditable <div> for all other text cells (plain or rich)
     *
     * Rich text is stored as an HTML string in the cell's v field. The contenteditable
     * is always used for text editing so formatting can be applied to selections at any time.
     * applyRichFormat() returns true if inline formatting was applied (selection existed),
     * false if not (caller should apply cell-level formatting instead).
     */

    import { untrack } from "svelte";
    import { segmentFormula } from "../../../formulas/reference-highlighter.js";
    import { editSessionState } from "../../../stores/spreadsheet/index.js";
    import { isRichText } from "../../../stores/spreadsheet/richText.js";
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
    } = $props();

    let cellEditInputEl = $state(null);
    let richEditEl = $state(null);
    let lastCommittedRichHtml = $state(null); // Track latest rich HTML to avoid duplicate commits

    let pickerMode = $derived(editSessionState.pickerMode);
    let isFormulaMode = $derived(
        isEditing &&
            typeof editValue === "string" &&
            editValue?.startsWith("="),
    );
    // Use contenteditable for all non-formula, non-picker text cells
    let isContentEditable = $derived(
        isEditing && !pickerMode && !isFormulaMode,
    );
    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue ?? "") : [],
    );

    // Initialize contenteditable when it becomes active.
    // Use untrack() for all inner reads so that changes to editValue or richTextValue
    // during the session don't re-run this effect and destroy formatting the user applied.
    $effect(() => {
        if (isContentEditable && richEditEl) {
            untrack(() => {
                const html = editSessionState.richTextValue;
                if (isRichText(html)) {
                    richEditEl.innerHTML = html;
                } else {
                    // Plain text — set as textContent to avoid XSS
                    richEditEl.textContent = editValue ?? "";
                }
                // Move cursor to end
                const range = document.createRange();
                range.selectNodeContents(richEditEl);
                range.collapse(false);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
                // Sync initial HTML so commit() works from the start
                const initHtml = richEditEl.innerHTML;
                editSessionState.liveRichHtml = isRichText(initHtml)
                    ? initHtml
                    : null;
                // Register so toolbar can apply inline formatting
                editSessionState.richFormatApplier = applyRichFormat;
            });
            return () => {
                editSessionState.richFormatApplier = null;
            };
        }
    });

    function handleEditBlur() {
        if (pickerMode) return;
        onCommitEdit?.(editValue);
    }

    function handleRichBlur() {
        if (!richEditEl) return;
        // Capture HTML and text immediately while element is still mounted
        // (Svelte might clear the binding during setTimeout)
        const html = richEditEl.innerHTML;
        const innerText = richEditEl.innerText;
        const textContent = richEditEl.textContent;

        // Short delay so toolbar clicks (which briefly steal focus) can refocus
        // the editor via applyRichFormat before we commit.
        setTimeout(() => {
            if (document.activeElement === richEditEl) return;
            commitRichValueWithContent(html, innerText, textContent);
        }, 150);
    }

    function commitRichValue() {
        if (!richEditEl) return;
        const html = richEditEl.innerHTML;
        // If no markup tags present, commit as plain string
        const value = isRichText(html)
            ? html
            : (richEditEl.innerText ?? richEditEl.textContent ?? "");
        onCommitEdit?.(value);
    }

    function commitRichValueWithContent(html, innerText, textContent) {
        // Use captured content if available, fallback to element if still mounted
        const htmlContent = html ?? richEditEl?.innerHTML ?? "";

        // Determine value to commit
        let valueToCommit;
        if (isRichText(htmlContent)) {
            // Rich text HTML should be committed (not the plain text version)
            valueToCommit = htmlContent;
        } else {
            // No rich text markup, use plain text
            valueToCommit = innerText ?? textContent ?? "";
        }

        // Store the HTML we're committing to avoid duplicate commits
        lastCommittedRichHtml = htmlContent;
        onCommitEdit?.(valueToCommit);
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
            commitRichValue();
        } else if (e.key === "Enter" && e.ctrlKey) {
            // Ctrl+Enter = insert line break
            e.stopPropagation();
            e.preventDefault();
            insertRichLineBreak();
        }
    }

    function handleRichInput() {
        if (!richEditEl) return;
        // Keep live HTML in sync so commitCurrentEdit() can commit rich text
        // even when triggered by a mousedown on another cell (before blur fires).
        const html = richEditEl.innerHTML;
        const isRich = isRichText(html);
        editSessionState.liveRichHtml = isRich ? html : null;
        // Keep plain-text draft in sync for formula bar display
        const plain = richEditEl.innerText;
        onEditInput?.(plain, null, null);
    }

    function insertRichLineBreak() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = document.createElement("br");
        range.insertNode(br);
        const textNode = document.createTextNode("\u200B");
        br.after(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /**
     * Apply inline formatting to the current selection in the rich text editor.
     * Returns true if formatting was applied to a selection, false if the cursor
     * was collapsed (caller should apply cell-level formatting instead).
     *
     * @param {string} prop  CSS property name ('fontWeight', 'fontStyle', 'underline', 'strikethrough', 'color', 'fontSize')
     * @param {string} value
     * @returns {boolean}
     */
    export function applyRichFormat(prop, value) {
        if (!richEditEl) return false;
        richEditEl.focus();
        const sel = window.getSelection();
        const hasSelection =
            sel && !sel.isCollapsed && richEditEl.contains(sel.anchorNode);
        if (!hasSelection) return false;

        document.execCommand("styleWithCSS", false, "true");
        if (prop === "fontWeight") document.execCommand("bold", false, null);
        else if (prop === "fontStyle")
            document.execCommand("italic", false, null);
        else if (prop === "underline")
            document.execCommand("underline", false, null);
        else if (prop === "strikethrough")
            document.execCommand("strikeThrough", false, null);
        else if (prop === "color")
            document.execCommand("foreColor", false, value);
        else if (prop === "fontSize") {
            if (sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                const span = document.createElement("span");
                span.style.fontSize = value + "px";
                range.surroundContents(span);
            }
        }
        // Sync live HTML after formatting so commit() has the latest value
        const newHtml = richEditEl.innerHTML;
        editSessionState.liveRichHtml = isRichText(newHtml) ? newHtml : null;
        return true;
    }

    function handlePickerCommit(val) {
        onCommitEdit?.(val);
    }

    export function focusEditor() {
        setTimeout(() => {
            if (isContentEditable) richEditEl?.focus();
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
    {#if editorBounds && isEditing && editSessionState.surface === "grid"}
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
            {:else if isFormulaMode}
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
                    onkeydown={handleEditKeydown}
                />
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
            {:else}
                <div
                    class="cell-rich-edit"
                    contenteditable="true"
                    bind:this={richEditEl}
                    onblur={handleRichBlur}
                    onkeydown={handleRichKeydown}
                    oninput={handleRichInput}
                ></div>
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

    .formula-overlay {
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
