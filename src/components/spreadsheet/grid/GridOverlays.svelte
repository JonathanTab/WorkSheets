<script>
    /**
     * GridOverlays - Selection and Editor Overlay Layer
     *
     * This component is rendered INSIDE VirtualPane's translated inner layer,
     * so all positions are relative to the pane's row/col range origins.
     */

    import { segmentFormula } from "../../../formulas/reference-highlighter.js";
    import { editSessionState } from "../../../stores/spreadsheet/index.js";
    import FormulaValuePopup from "../FormulaValuePopup.svelte";
    import PickerEditor from "../cellTypes/PickerEditor.svelte";

    let {
        virtualizer,
        selectionState,
        session,
        rowRange = { start: 0, end: -1, count: 0 },
        colRange = { start: 0, end: -1, count: 0 },
        isEditing = false,
        editRow = -1,
        editCol = -1,
        editValue = "",
        onEditInput,
        onEditSelect,
        onCommitEdit,
        onCancelEdit,
    } = $props();

    let cellEditInputEl = $state(null);

    let selection = $derived(selectionState?.range);
    let anchor = $derived(selectionState?.anchor);

    let rowBase = $derived(
        rowRange.count > 0 ? (virtualizer?.getRowTop(rowRange.start) ?? 0) : 0,
    );
    let colBase = $derived(
        colRange.count > 0 ? (virtualizer?.getColLeft(colRange.start) ?? 0) : 0,
    );

    function toLocalTop(row) {
        return virtualizer.getRowTop(row) - rowBase;
    }

    function toLocalLeft(col) {
        return virtualizer.getColLeft(col) - colBase;
    }

    function intersectsPane(sel) {
        if (!sel || rowRange.count <= 0 || colRange.count <= 0) return false;
        return !(
            sel.endRow < rowRange.start ||
            sel.startRow > rowRange.end ||
            sel.endCol < colRange.start ||
            sel.startCol > colRange.end
        );
    }

    let selectionBounds = $derived.by(() => {
        if (!selection || !virtualizer || !intersectsPane(selection))
            return null;

        const startRow = Math.max(selection.startRow, rowRange.start);
        const endRow = Math.min(selection.endRow, rowRange.end);
        const startCol = Math.max(selection.startCol, colRange.start);
        const endCol = Math.min(selection.endCol, colRange.end);

        const top = toLocalTop(startRow);
        const left = toLocalLeft(startCol);
        const bottom = toLocalTop(endRow) + virtualizer.getRowHeight(endRow);
        const right = toLocalLeft(endCol) + virtualizer.getColWidth(endCol);

        return {
            top,
            left,
            width: right - left,
            height: bottom - top,
        };
    });

    let anchorBounds = $derived.by(() => {
        if (!anchor || !virtualizer) return null;
        if (
            anchor.row < rowRange.start ||
            anchor.row > rowRange.end ||
            anchor.col < colRange.start ||
            anchor.col > colRange.end
        ) {
            return null;
        }

        return {
            top: toLocalTop(anchor.row),
            left: toLocalLeft(anchor.col),
            width: virtualizer.getColWidth(anchor.col),
            height: virtualizer.getRowHeight(anchor.row),
        };
    });

    let editorBounds = $derived.by(() => {
        if (!isEditing || editRow < 0 || editCol < 0 || !virtualizer)
            return null;
        if (
            editRow < rowRange.start ||
            editRow > rowRange.end ||
            editCol < colRange.start ||
            editCol > colRange.end
        ) {
            return null;
        }

        return {
            top: toLocalTop(editRow),
            left: toLocalLeft(editCol),
            width: virtualizer.getColWidth(editCol),
            height: virtualizer.getRowHeight(editRow),
        };
    });

    let pickerMode = $derived(editSessionState.pickerMode);
    let isFormulaMode = $derived(isEditing && editValue?.startsWith("="));
    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue ?? "") : [],
    );

    function handleEditBlur() {
        // Don't commit on blur if we're in picker mode, as pickers handle their own lifecycle
        if (pickerMode) return;
        onCommitEdit?.(editValue);
    }

    function handleEditKeydown(e) {
        if (e.key === "Enter") {
            e.stopPropagation();
            onCommitEdit?.(editValue);
            selectionState?.moveSelection(1, 0);
        } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancelEdit?.();
        } else if (e.key === "Tab") {
            e.stopPropagation();
            onCommitEdit?.(editValue);
            selectionState?.moveSelection(0, e.shiftKey ? -1 : 1);
        }
    }

    function handlePickerCommit(val) {
        onCommitEdit?.(val);
    }

    export function focusEditor() {
        setTimeout(() => cellEditInputEl?.focus(), 0);
    }
</script>

<div class="overlays-container">
    {#if selectionBounds && selection && (selection.startRow !== selection.endRow || selection.startCol !== selection.endCol)}
        <div
            class="selection-rect"
            style="top:{selectionBounds.top}px; left:{selectionBounds.left}px; width:{selectionBounds.width}px; height:{selectionBounds.height}px;"
        ></div>
    {/if}

    {#if anchorBounds && anchor}
        <div
            class="anchor-outline"
            style="top:{anchorBounds.top}px; left:{anchorBounds.left}px; width:{anchorBounds.width}px; height:{anchorBounds.height}px;"
        ></div>
    {/if}

    {#if editorBounds && isEditing}
        <div
            class="cell-editor"
            style="top:{editorBounds.top}px; left:{editorBounds.left}px; width:{editorBounds.width}px; height:{editorBounds.height}px;"
        >
            {#if pickerMode}
                <PickerEditor
                    type={pickerMode}
                    value={editValue}
                    on:change={(e) => onEditInput?.(e.detail)}
                    on:commit={(e) => handlePickerCommit(e.detail)}
                    on:cancel={onCancelEdit}
                    on:blur={handleEditBlur}
                />
            {:else}
                <input
                    type="text"
                    class="cell-edit-input"
                    bind:this={cellEditInputEl}
                    value={editValue}
                    oninput={(e) => {
                        const target = /** @type {HTMLInputElement} */ (
                            e.target
                        );
                        onEditInput?.(
                            target.value,
                            target.selectionStart,
                            target.selectionEnd,
                        );
                    }}
                    onselect={(e) => {
                        const target = /** @type {HTMLInputElement} */ (
                            e.target
                        );
                        onEditSelect?.(
                            target.selectionStart,
                            target.selectionEnd,
                        );
                    }}
                    onblur={handleEditBlur}
                    onkeydown={handleEditKeydown}
                />
            {/if}
            {#if isFormulaMode}
                <div class="formula-overlay" aria-hidden="true">
                    {#each formulaSegments as segment}
                        {#if segment.color}
                            <span
                                style="color: {segment.color}; font-weight: 600;"
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
    .overlays-container {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 100;
        overflow: hidden;
    }

    .selection-rect {
        position: absolute;
        background: color-mix(
            in srgb,
            var(--selection-bg, #3b82f6) 20%,
            transparent
        );
        border: 2px solid var(--selection-border, #3b82f6);
        pointer-events: none;
    }

    .anchor-outline {
        position: absolute;
        border: 2px solid var(--anchor-border, #3b82f6);
        background: transparent;
        pointer-events: none;
    }

    .cell-editor {
        position: absolute;
        pointer-events: auto;
        z-index: 110;
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

    .cell-editor:has(.cell-edit-input) {
        position: absolute;
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

    .cell-editor:has(.cell-edit-input) .formula-function {
        font-weight: 600;
        color: var(--function-color, #7c3aed);
    }

    .cell-editor:has(.cell-edit-input) .cell-edit-input {
        caret-color: var(--text-color, #1e293b);
    }

    .cell-editor:has(.formula-overlay) .cell-edit-input {
        color: transparent;
        background: transparent;
    }
</style>
