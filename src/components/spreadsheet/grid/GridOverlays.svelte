<script>
    /**
     * GridOverlays - Selection and Editor Overlay Layer
     *
     * This component is rendered INSIDE VirtualPane's translated inner layer,
     * so all positions are relative to the pane's row/col range origins.
     */

    let {
        virtualizer,
        selectionState,
        session,
        rowRange = { start: 0, end: -1, count: 0 },
        colRange = { start: 0, end: -1, count: 0 },
        isEditing = false,
        editRow = -1,
        editCol = -1,
        editValue = $bindable(""),
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

    function handleEditBlur() {
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
            <input
                type="text"
                class="cell-edit-input"
                bind:value={editValue}
                bind:this={cellEditInputEl}
                onblur={handleEditBlur}
                onkeydown={handleEditKeydown}
            />
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
    }
</style>
