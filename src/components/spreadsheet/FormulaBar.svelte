<script>
    import { spreadsheetSession } from "../../stores/spreadsheetStore.svelte.js";
    import { editSessionState } from "../../stores/spreadsheet/index.js";
    import { segmentFormula } from "../../formulas/reference-highlighter.js";
    import {
        isRichText,
        isRichTextArray,
        richTextToPlain,
    } from "../../stores/spreadsheet/richText.js";
    import { untrack } from "svelte";
    import FormulaValuePopup from "./FormulaValuePopup.svelte";
    import { close, check } from "../../lib/icons/index.js";

    let { selectedCell = null, onEdit } = $props();

    let previousCellKey = $state(null); // Track previous cell to detect actual cell changes
    let editInputEl = $state(null);

    // Cell reference (e.g., "A1", "B23")
    let cellRef = $derived(
        selectedCell
            ? `${String.fromCharCode(65 + selectedCell.col)}${selectedCell.row + 1}`
            : "",
    );

    // Current cell key for tracking
    let currentCellKey = $derived(
        selectedCell ? `${selectedCell.row},${selectedCell.col}` : null,
    );

    // Display value - show formula if present, plain text for rich text cells
    let displayValue = $derived(() => {
        if (!selectedCell) return "";
        const raw = spreadsheetSession.getCellEditValue(
            selectedCell.row,
            selectedCell.col,
        );
        // Convert rich text to plain text for display in the formula bar
        if (isRichText(raw) || isRichTextArray(raw))
            return richTextToPlain(raw);
        return raw;
    });

    // Edit value - show raw value (formula if present)
    let editStartValue = $derived(() => {
        if (!selectedCell) return "";
        // Get the raw value for editing (shows formula if present)
        return spreadsheetSession.getCellEditValue(
            selectedCell.row,
            selectedCell.col,
        );
    });

    let isEditing = $derived(editSessionState.isEditing);
    let editValue = $derived(editSessionState.draft);

    // Check if selected cell contains rich text (whether editing or not)
    let selectedCellHasRichText = $derived(() => {
        if (!selectedCell) return false;
        const rawVal = editStartValue();
        return isRichText(rawVal) || isRichTextArray(rawVal);
    });

    // During editing, also check active edit session state
    let hasRichText = $derived(
        editSessionState.richTextValue !== null || selectedCellHasRichText(),
    );

    // Check if we're editing a formula
    let isFormulaMode = $derived(isEditing && editValue?.startsWith("="));

    // Get colored segments for formula display
    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue) : [],
    );

    function startEdit() {
        if (!selectedCell) return;

        // Rich text cells must be edited in the cell editor, not the formula bar.
        // Check both the active session state AND the raw cell value (when not yet editing).
        const rawVal = editStartValue();
        if (hasRichText || isRichText(rawVal) || isRichTextArray(rawVal))
            return;

        // If already editing this cell (on grid), switch surface to formula bar
        if (
            editSessionState.isEditingCell(selectedCell.row, selectedCell.col)
        ) {
            editSessionState.switchSurface("formulaBar", { focus: true });
        } else {
            // Otherwise, start a new edit on formula bar
            editSessionState.beginEdit(
                selectedCell.row,
                selectedCell.col,
                rawVal,
                "formulaBar",
            );
        }
    }

    function commitEdit() {
        // Rich text sessions are always committed by the cell's contenteditable editor.
        // The formula bar must never commit the plain-text draft over a rich text value.
        if (hasRichText) {
            editSessionState.cancel();
            return;
        }

        const payload = editSessionState.commit();
        if (!payload) return;
        onEdit?.(payload.value, payload.row, payload.col);
    }

    function cancelEdit() {
        editSessionState.cancel();
    }

    function handleKeydown(e) {
        if (e.key === "Enter") {
            commitEdit();
            e.preventDefault();
        } else if (e.key === "Escape") {
            cancelEdit();
            e.preventDefault();
        }
    }

    function handleInput(e) {
        editSessionState.updateDraft(
            e.target.value,
            e.target.selectionStart,
            e.target.selectionEnd,
        );
    }

    function handleSelect(e) {
        editSessionState.setCursor(
            e.target.selectionStart,
            e.target.selectionEnd,
        );
    }

    $effect(() => {
        editSessionState.setFocusHandle("formulaBar", () =>
            editInputEl?.focus(),
        );
        return () => {
            editSessionState.clearFocusHandle("formulaBar");
        };
    });

    $effect(() => {
        if (isEditing && editSessionState.surface === "formulaBar") {
            editSessionState.requestFocus("formulaBar");
        }
    });

    // Reset edit value ONLY when the cell actually changes (not on every reactive update)
    $effect(() => {
        const newKey = currentCellKey;
        if (newKey !== previousCellKey) {
            // Cell selection changed - update the edit value
            untrack(() => {
                if (!isEditing && selectedCell) {
                    // keep local display in sync only when idle
                }
            });
            previousCellKey = newKey;
        }
    });
</script>

<div class="formula-bar">
    <div class="cell-reference">
        {cellRef || "-"}
    </div>
    <div class="divider"></div>
    <div class="edit-buttons">
        <button
            class="btn-cancel"
            onclick={cancelEdit}
            onmousedown={(e) => e.preventDefault()}
            disabled={!isEditing || hasRichText}
            title="Cancel (Escape)"
            aria-label="Cancel edit"
        >
            <span class="icon">{@html close}</span>
        </button>
        <button
            class="btn-accept"
            onclick={commitEdit}
            onmousedown={(e) => e.preventDefault()}
            disabled={!isEditing || hasRichText}
            title="Accept (Enter)"
            aria-label="Accept edit"
        >
            <span class="icon">{@html check}</span>
        </button>
    </div>
    <div class="divider"></div>
    <div class="formula-input">
        {#if selectedCellHasRichText()}
            <!-- Show rich text notice when rich text cell is selected (regardless of editing) -->
            <div class="edit-container rich-text-notice">
                <span class="notice-text">
                    Edit rich text formatting in the cell ⬇️
                </span>
            </div>
        {:else if isEditing}
            <div class="edit-container" class:has-formula={isFormulaMode}>
                <input
                    type="text"
                    bind:this={editInputEl}
                    value={editValue}
                    onmousedown={(e) => {
                        e.stopPropagation();
                        // Switch to formula bar surface BEFORE blur fires on grid cell
                        // This prevents the grid cell's blur handler from committing
                        if (editSessionState.isEditing) {
                            editSessionState.switchSurface("formulaBar", {
                                focus: false,
                            });
                        }
                    }}
                    onkeydown={handleKeydown}
                    oninput={handleInput}
                    onselect={handleSelect}
                    class="edit-input"
                />
                {#if isFormulaMode}
                    <!-- Color overlay for references -->
                    <div class="formula-overlay" aria-hidden="true">
                        {#each formulaSegments as segment}
                            {#if segment.color}
                                <span
                                    style="color: {segment.color}; font-weight: 600;"
                                    >{segment.text}</span
                                >
                            {:else if segment.type === "FUNCTION"}
                                <span class="formula-function"
                                    >{segment.text}</span
                                >
                            {:else}
                                <span>{segment.text}</span>
                            {/if}
                        {/each}
                    </div>
                    <!-- Real-time computed value popup -->
                    <FormulaValuePopup formula={editValue} visible={true} />
                {/if}
            </div>
        {:else}
            <div
                class="display-value"
                onclick={(e) => {
                    e.stopPropagation();
                    startEdit();
                }}
                role="button"
                tabindex="0"
                onkeydown={(e) => {
                    if (e.key === "Enter") {
                        e.stopPropagation();
                        startEdit();
                    }
                }}
            >
                {displayValue()}
            </div>
        {/if}
    </div>
</div>

<style>
    .formula-bar {
        display: flex;
        align-items: center;
        padding: 0.25rem 0.5rem;
        background: var(--formula-bar-bg, #ffffff);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        min-height: 36px;
    }

    .cell-reference {
        min-width: 60px;
        padding: 0.25rem 0.5rem;
        font-family: monospace;
        font-size: 0.875rem;
        text-align: center;
        background: var(--cell-ref-bg, #f1f5f9);
        border-radius: 4px;
        color: var(--text-color, #1e293b);
    }

    .divider {
        width: 1px;
        height: 24px;
        background: var(--border-color, #e2e8f0);
        margin: 0 0.5rem;
    }

    .edit-buttons {
        display: flex;
        gap: 0.25rem;
    }

    .edit-buttons button {
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        transition:
            opacity 0.15s,
            background-color 0.15s;
    }

    .btn-cancel {
        background-color: #fee2e2;
        color: #dc2626;
    }

    .btn-cancel:hover:not(:disabled) {
        background-color: #fecaca;
    }

    .btn-accept {
        background-color: #dcfce7;
        color: #16a34a;
    }

    .btn-accept:hover:not(:disabled) {
        background-color: #bbf7d0;
    }

    .edit-buttons button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .formula-input {
        flex: 1;
        min-width: 0;
        position: relative;
    }

    .display-value {
        padding: 0.25rem 0.5rem;
        font-size: 0.875rem;
        cursor: text;
        height: 28px;
        box-sizing: border-box;
        border-radius: 4px;
        border: 2px solid transparent;
        font-family: monospace;
        line-height: 20px;
    }

    .display-value:hover {
        background: var(--hover-bg, #f1f5f9);
    }

    .display-value:focus {
        outline: 2px solid var(--focus-color, #3b82f6);
        outline-offset: -2px;
    }

    .edit-container {
        position: relative;
    }

    .edit-container.rich-text-notice {
        display: flex;
        align-items: center;
        padding: 0.25rem 0.5rem;
        background: var(--info-bg, #eff6ff);
        border: 2px solid var(--info-border, #3b82f6);
        border-radius: 4px;
        height: 28px;
        box-sizing: border-box;
    }

    .notice-text {
        font-size: 0.875rem;
        color: var(--info-text, #1e40af);
        font-style: italic;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .edit-input {
        width: 100%;
        padding: 0.25rem 0.5rem;
        font-size: 0.875rem;
        border: 2px solid var(--focus-color, #3b82f6);
        border-radius: 4px;
        outline: none;
        background: var(--input-bg, #ffffff);
        color: var(--text-color, #1e293b);
        font-family: monospace;
        position: relative;
        z-index: 2;
        height: 28px;
        box-sizing: border-box;
        line-height: 20px;
    }

    /* When editing a formula, make input text transparent to show overlay */
    .edit-container.has-formula .edit-input {
        color: transparent;
        background: transparent;
        caret-color: var(--text-color, #1e293b);
    }

    .formula-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 0.25rem 0.5rem;
        font-size: 0.875rem;
        pointer-events: none;
        white-space: pre;
        overflow: hidden;
        font-family: monospace;
        z-index: 1;
        color: var(--text-color, #1e293b);
        /* Match the input styling */
        border: 2px solid var(--focus-color, #3b82f6);
        border-radius: 4px;
        background: var(--input-bg, #ffffff);
    }

    .formula-function {
        font-weight: 600;
        color: var(--function-color, #7c3aed);
    }
</style>
