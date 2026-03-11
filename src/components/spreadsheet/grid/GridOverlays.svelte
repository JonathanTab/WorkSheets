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

    let pickerMode = $derived(editSessionState.pickerMode);
    let isFormulaMode = $derived(isEditing && editValue?.startsWith("="));
    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue ?? "") : [],
    );

    function handleEditBlur() {
        if (pickerMode) return;
        onCommitEdit?.(editValue);
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

    function handlePickerCommit(val) {
        onCommitEdit?.(val);
    }

    export function focusEditor() {
        setTimeout(() => cellEditInputEl?.focus(), 0);
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
                    onkeydown={handleEditKeydown}
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
