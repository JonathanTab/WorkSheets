<script>
    import { spreadsheetSession } from "../../stores/spreadsheetStore.svelte.js";
    import { formulaEditState } from "../../stores/spreadsheet/FormulaEditState.svelte.js";
    import { segmentFormula } from "../../formulas/reference-highlighter.js";
    import { untrack } from "svelte";
    import FormulaValuePopup from "./FormulaValuePopup.svelte";

    let { selectedCell = null, onEdit } = $props();

    let isEditing = $state(false);
    let editValue = $state("");
    let previousCellKey = $state(null); // Track previous cell to detect actual cell changes
    let editInputEl = $state(null);
    let containerEl = $state(null);
    let editingCell = $state(null); // Track which cell we're editing (row, col)

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

    // Display value - always show raw value (formula if present)
    let displayValue = $derived(() => {
        if (!selectedCell) return "";
        // Always show the raw value (formula string if it's a formula)
        return spreadsheetSession.getCellEditValue(
            selectedCell.row,
            selectedCell.col,
        );
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

    // Check if we're editing a formula
    let isFormulaMode = $derived(isEditing && editValue.startsWith("="));

    // Get colored segments for formula display
    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue) : [],
    );

    // Get reference colors for highlighting in grid
    let referenceColors = $derived(formulaEditState.getReferenceColors());

    function startEdit() {
        // When starting to edit, show the raw value (formula if present)
        editValue = editStartValue();
        isEditing = true;

        // Track which cell we're editing
        if (selectedCell) {
            editingCell = { row: selectedCell.row, col: selectedCell.col };

            // Update the global formula edit state
            formulaEditState.startEditing(
                selectedCell.row,
                selectedCell.col,
                editValue,
            );
        }

        // Set up callbacks for cell reference insertion
        formulaEditState.setInsertRefCallback(insertReference);
        formulaEditState.setFocusCallback(() => editInputEl?.focus());

        // Focus the input after it renders
        setTimeout(() => editInputEl?.focus(), 0);
    }

    function commitEdit() {
        // Don't compare to originalValue - just commit what's in the input
        // This avoids issues with the value being recomputed during edit
        if (editValue !== undefined && editValue !== null && editingCell) {
            // Pass the cell we were editing, not the current selection
            onEdit(editValue, editingCell.row, editingCell.col);
        }
        isEditing = false;
        editingCell = null;
        formulaEditState.stopEditing();
    }

    function cancelEdit() {
        editValue = displayValue();
        isEditing = false;
        editingCell = null;
        formulaEditState.stopEditing();
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
        editValue = e.target.value;
        formulaEditState.updateValue(editValue, e.target.selectionStart);
    }

    function handleSelect(e) {
        formulaEditState.cursorPosition = e.target.selectionStart;
    }

    // Find all reference positions in a formula string
    function findReferencePositions(formula) {
        const positions = [];
        if (!formula) return positions;

        const content = formula.startsWith("=") ? formula.slice(1) : formula;
        const offset = formula.startsWith("=") ? 1 : 0;

        // Match ranges first (A1:B5)
        const rangeRegex = /\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+/g;
        let match;

        // Find ranges and mark their positions
        const rangePositions = [];
        while ((match = rangeRegex.exec(content)) !== null) {
            rangePositions.push({
                start: match.index,
                end: match.index + match[0].length,
            });
            positions.push({
                start: match.index + offset,
                end: match.index + match[0].length + offset,
                text: match[0],
            });
        }

        // Match individual cell refs (A1) that aren't part of ranges
        const cellRegex = /\$?[A-Za-z]+\$?\d+/g;
        while ((match = cellRegex.exec(content)) !== null) {
            const isInRange = rangePositions.some(
                (r) => match.index >= r.start && match.index < r.end,
            );
            if (!isInRange) {
                positions.push({
                    start: match.index + offset,
                    end: match.index + match[0].length + offset,
                    text: match[0],
                });
            }
        }

        return positions.sort((a, b) => a.start - b.start);
    }

    // Insert a cell reference at current cursor position, replacing existing reference if cursor is within one
    function insertReference(ref) {
        if (!editInputEl) return;

        const cursorPos = editInputEl.selectionStart;
        const value = editValue;

        // Find all references in the formula
        const refPositions = findReferencePositions(value);

        // Check if cursor is within or at the end of an existing reference
        let existingRef = null;
        for (const pos of refPositions) {
            // Cursor is within this reference or at its end
            if (cursorPos >= pos.start && cursorPos <= pos.end) {
                existingRef = pos;
                break;
            }
        }

        let newValue;
        let newCursorPos;

        if (existingRef) {
            // Replace the existing reference
            newValue =
                value.substring(0, existingRef.start) +
                ref +
                value.substring(existingRef.end);
            newCursorPos = existingRef.start + ref.length;
        } else {
            // Insert at cursor position (existing behavior)
            const end = editInputEl.selectionEnd;
            newValue =
                value.substring(0, cursorPos) + ref + value.substring(end);
            newCursorPos = cursorPos + ref.length;
        }

        editValue = newValue;

        // Update the edit input value and cursor
        editInputEl.value = newValue;
        editInputEl.setSelectionRange(newCursorPos, newCursorPos);

        // Update the formula edit state
        formulaEditState.updateValue(newValue, newCursorPos);
    }

    // Reset edit value ONLY when the cell actually changes (not on every reactive update)
    $effect(() => {
        const newKey = currentCellKey;
        if (newKey !== previousCellKey) {
            // Cell selection changed - update the edit value
            untrack(() => {
                if (!isEditing) {
                    editValue = editStartValue();
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
            disabled={!isEditing}
            title="Cancel (Escape)"
            aria-label="Cancel edit"
        >
            ✕
        </button>
        <button
            class="btn-accept"
            onclick={commitEdit}
            disabled={!isEditing}
            title="Accept (Enter)"
            aria-label="Accept edit"
        >
            ✓
        </button>
    </div>
    <div class="divider"></div>
    <div class="formula-input" bind:this={containerEl}>
        {#if isEditing}
            <div class="edit-container" class:has-formula={isFormulaMode}>
                <input
                    type="text"
                    bind:value={editValue}
                    bind:this={editInputEl}
                    onkeydown={handleKeydown}
                    onblur={commitEdit}
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
                onclick={startEdit}
                role="button"
                tabindex="0"
                onkeydown={(e) => e.key === "Enter" && startEdit()}
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
