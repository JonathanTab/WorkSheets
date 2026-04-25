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
    import { spreadsheetSession } from "../../../stores/spreadsheetStore.svelte.js";
    import { isRichText } from "../../../stores/spreadsheet/richText.js";
    import FormulaValuePopup from "../FormulaValuePopup.svelte";
    import PickerEditor from "../cellTypes/PickerEditor.svelte";
    import DatePickerEditor from "../cellTypes/DatePickerEditor.svelte";
    import ImageEditor from "../cellTypes/ImageEditor.svelte";
    import FileEditor from "../cellTypes/FileEditor.svelte";

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
        /** Called with direction (+1 right, -1 left) when Tab is pressed during editing. */
        onTabCommit = null,
        /** Document ID, passed to ImageEditor for blob parentId. */
        docId = null,
    } = $props();

    let cellEditInputEl = $state(null);
    let richEditEl = $state(null);
    let lastCommittedRichHtml = $state(null); // Track latest rich HTML to avoid duplicate commits

    let pickerMode = $derived(editSessionState.pickerMode);
    let isImagePickerMode = $derived(pickerMode === 'image-picker');
    let isFilePickerMode  = $derived(pickerMode === 'file-picker');
    let isFormulaMode = $derived(
        isEditing &&
            typeof editValue === "string" &&
            editValue?.startsWith("="),
    );
    // Current cell type config, used by FileEditor and DatePickerEditor
    let cellCtConfig = $derived.by(() => {
        if (!editSessionState.isEditing || !editSessionState.cell) return null;
        const { row, col } = editSessionState.cell;
        const sheetStore = spreadsheetSession?.activeSheetStore;
        if (!sheetStore) return null;
        return sheetStore.getCellTypeConfig(row, col);
    });

    let effectiveDateSubFormat = $derived.by(() => {
        if (cellCtConfig?.subFormat) return cellCtConfig.subFormat;
        if (pickerMode === "time") return "time";
        if (pickerMode === "datetime-local") return "datetime";
        return "date";
    });

    // Use contenteditable for all non-formula, non-picker, non-image, non-file text cells
    let isContentEditable = $derived(
        isEditing &&
            editSessionState.surface === "grid" &&
            !pickerMode &&
            !isFormulaMode,
    );
    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue ?? "") : [],
    );

    // Cell-level formatting for the current edit cell — applied to the editor as base styles
    let cellFormatting = $derived.by(() => {
        if (!editSessionState.isEditing || !editSessionState.cell) return null;
        const { row, col } = editSessionState.cell;
        const sheetStore = spreadsheetSession?.activeSheetStore;
        if (!sheetStore) return null;
        return sheetStore.getCell(row, col);
    });

    let richEditStyle = $derived.by(() => {
        const f = cellFormatting;
        const parts = [];
        if (f?.fontFamily) parts.push(`font-family: ${f.fontFamily}, system-ui, -apple-system, sans-serif`);
        if (f?.fontSize) parts.push(`font-size: ${f.fontSize}px`);
        if (f?.bold) parts.push('font-weight: bold');
        if (f?.italic) parts.push('font-style: italic');
        if (f?.color) parts.push(`color: ${f.color}`);
        return parts.length ? parts.join('; ') : null;
    });

    // Initialize contenteditable when it becomes active.
    // Track editSessionState.cell so this re-runs when the edited cell changes
    // (e.g. Tab navigation in table entry row keeps isContentEditable=true but moves to
    // a different cell — without the cell tracking the editor would show stale content).
    // Use untrack() for all inner reads so that changes to editValue or richTextValue
    // during the session don't re-run this effect and destroy formatting the user applied.
    $effect(() => {
        // Track cell identity so the effect re-runs on cell change
        const _cellRow = editSessionState.cell?.row;
        const _cellCol = editSessionState.cell?.col;
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
                const initText = richEditEl.innerText;
                const initHasContent = initText.trim() !== '';
                editSessionState.liveRichHtml = (isRichText(initHtml) && initHasContent)
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
        // Don't commit when the surface was switched to the formula bar — the blur
        // is caused by focus moving to the formula bar input, not a real dismiss.
        if (editSessionState.surface !== 'grid') return;
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
            if (editSessionState.surface !== 'grid') return;
            // Don't commit if focus moved to the formatting toolbar (user is changing font/size/color)
            const toolbar = document.querySelector('.formatting-toolbar');
            if (toolbar?.contains(document.activeElement)) return;
            commitRichValueWithContent(html, innerText, textContent);
        }, 150);
    }

    function commitRichValue() {
        if (!richEditEl) return;
        const html = richEditEl.innerHTML;
        const plain = richEditEl.innerText ?? richEditEl.textContent ?? "";
        // Commit as plain string when there's no markup or no visible content
        const value = (isRichText(html) && plain.trim() !== '')
            ? html
            : plain;
        onCommitEdit?.(value);
    }

    function commitRichValueWithContent(html, innerText, textContent) {
        // Use captured content if available, fallback to element if still mounted
        const htmlContent = html ?? richEditEl?.innerHTML ?? "";
        const plainContent = innerText ?? textContent ?? "";

        // Determine value to commit — treat as plain text when there's no visible
        // content (e.g. user deleted everything, leaving only a bare <br>)
        let valueToCommit;
        if (isRichText(htmlContent) && plainContent.trim() !== '') {
            // Rich text HTML should be committed (not the plain text version)
            valueToCommit = htmlContent;
        } else {
            // No rich text markup, or empty — use plain text
            valueToCommit = plainContent;
        }

        // Store the HTML we're committing to avoid duplicate commits
        lastCommittedRichHtml = htmlContent;
        onCommitEdit?.(valueToCommit);
    }

    function handleEditKeydown(e) {
        if (e.key === "Enter") {
            e.stopPropagation();
            e.preventDefault();
            if (onTabCommit) {
                onTabCommit(1); // Enter = move down
            } else {
                onCommitEdit?.(editValue);
            }
        } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancelEdit?.();
        } else if (e.key === "Tab") {
            e.stopPropagation();
            e.preventDefault();
            if (onTabCommit) {
                onTabCommit(e.shiftKey ? -1 : 1, 'tab');
            } else {
                onCommitEdit?.(editValue);
            }
        }
    }

    function handleRichKeydown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            onCancelEdit?.();
        } else if (e.key === "Tab") {
            e.stopPropagation();
            e.preventDefault();
            if (onTabCommit) {
                onTabCommit(e.shiftKey ? -1 : 1, 'tab');
            } else {
                handleRichBlur();
            }
        } else if (e.key === "Enter" && !e.ctrlKey) {
            // Plain Enter = commit and move down
            e.stopPropagation();
            e.preventDefault();
            if (onTabCommit) {
                commitRichValue(); // captures HTML first
                onTabCommit(1);
            } else {
                commitRichValue();
            }
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
        const plain = richEditEl.innerText;
        // Treat as empty (plain text) if there's no visible content — prevents
        // storing bare <br>/<div><br></div> as rich text in otherwise-empty cells.
        const hasContent = plain.trim() !== '';
        editSessionState.liveRichHtml = (isRichText(html) && hasContent) ? html : null;
        // Keep plain-text draft in sync for formula bar display
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
        focusNoScroll(richEditEl);
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
        else if (prop === "fontFamily") {
            if (sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                const span = document.createElement("span");
                span.style.fontFamily = value;
                try {
                    range.surroundContents(span);
                } catch {
                    // For complex selections spanning multiple elements
                    const fragment = range.extractContents();
                    span.appendChild(fragment);
                    range.insertNode(span);
                }
            }
        }
        // Sync live HTML after formatting so commit() has the latest value
        const newHtml = richEditEl.innerHTML;
        const newText = richEditEl.innerText;
        const newHasContent = newText.trim() !== '';
        editSessionState.liveRichHtml = (isRichText(newHtml) && newHasContent) ? newHtml : null;
        return true;
    }

    function handlePickerCommit(val) {
        onCommitEdit?.(val);
    }

    function focusNoScroll(el) {
        if (!el) return;
        try {
            el.focus({ preventScroll: true });
        } catch {
            el.focus();
        }
    }

    export function focusEditor() {
        setTimeout(() => {
            if (isContentEditable) focusNoScroll(richEditEl);
            else focusNoScroll(cellEditInputEl);
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
            {#if isImagePickerMode}
                <ImageEditor
                    value={editValue}
                    {docId}
                    onCommit={(blobId, fit) => {
                        // Commit blobId as the cell value; fit is stored separately via ct update
                        onCommitEdit?.(blobId ?? '');
                        // Signal fit change via a custom event so Grid can update ct
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
                    onCommit={(blobId) => {
                        onCommitEdit?.(blobId ?? '');
                    }}
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
                <div class="formula-overlay" aria-hidden="true"><span class="formula-overlay-text">{#each formulaSegments as segment}{#if segment.color}<span style="color:{segment.color}; font-weight:600;">{segment.text}</span>{:else if segment.type === "FUNCTION"}<span class="formula-function">{segment.text}</span>{:else}<span>{segment.text}</span>{/if}{/each}</span></div>
                <FormulaValuePopup formula={editValue} visible={true} />
            {:else}
                <div
                    class="cell-rich-edit"
                    style={richEditStyle}
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
        height: auto;
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
        overflow: visible;
        white-space: pre-wrap;
        overflow-wrap: break-word;
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
        pointer-events: none;
        overflow: hidden;
        font-family: monospace;
        z-index: 1;
        color: var(--text-color, #1e293b);
        background: var(--input-bg, #ffffff);
        outline: 2px solid var(--editor-outline, #3b82f6);
        /* Vertically center text to match <input type="text"> behavior */
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
