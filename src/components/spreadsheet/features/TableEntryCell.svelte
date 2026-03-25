<script>
    /**
     * TableEntryCell - Input cell for the table's persistent entry row.
     *
     * Visually identical to a blank regular spreadsheet cell. Becomes an active
     * input when focused. Tab moves between columns, Enter commits the row.
     */

    import DatePickerEditor from "../cellTypes/DatePickerEditor.svelte";

    let {
        table,
        colIndex,
        width = 80,
        height = 24,
        onTabNext = null,
        onTabPrev = null,
        onCommit = null,
        onValueChange = null,
    } = $props();

    let col = $derived(table?.columns?.[colIndex] ?? null);
    let value = $derived(col ? (table?.entryBuffer?.[col.id] ?? "") : "");
    let error = $derived(col ? (table?.entryErrors?.[col.id] ?? null) : null);
    let isFormula = $derived(col?.isNonEntry ?? false);

    function handleInput(e) {
        if (!col || !table || isFormula) return;
        let val = e.currentTarget.value;
        if (col.type === "checkbox") {
            val = e.currentTarget.checked;
        }
        table.setEntryValue(col.id, val);
        onValueChange?.();
    }

    function handleKeydown(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (onCommit) {
                onCommit();
            } else {
                table?.commitEntry();
            }
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            table?.clearEntry();
        } else if (e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) {
                onTabPrev?.();
            } else {
                onTabNext?.();
            }
        }
    }

    let inputEl = $state(null);
    export function focus() {
        inputEl?.focus();
    }
</script>

<div
    class="table-entry-cell"
    class:has-error={!!error}
    class:is-formula={isFormula}
    style="width:{width}px; height:{height}px;"
    title={error ?? (isFormula ? "Computed column" : (col?.name ?? ""))}
>
    {#if isFormula}
        <div class="formula-placeholder">
            <span class="fx-icon">fx</span>
        </div>
    {:else if col?.type === "checkbox"}
        <div class="checkbox-wrapper">
            <input
                bind:this={inputEl}
                type="checkbox"
                class="entry-checkbox"
                checked={!!value}
                onchange={handleInput}
                onkeydown={handleKeydown}
            />
        </div>
    {:else if col?.type === "date"}
        <DatePickerEditor
            bind:this={inputEl}
            {value}
            subFormat={col.typeConfig?.subFormat ?? 'date'}
            autofocus={false}
            oncommit={(val) => {
                if (!col || !table || isFormula) return;
                table.setEntryValue(col.id, val);
                onValueChange?.();
            }}
            oncancel={() => table?.clearEntry()}
            ontabnext={onTabNext}
            ontabprev={onTabPrev}
            onrowcommit={() => {
                if (onCommit) {
                    onCommit();
                } else {
                    table?.commitEntry();
                }
            }}
        />
    {:else if col?.type === "number" || col?.type === "currency" || col?.type === "percent"}
        <input
            bind:this={inputEl}
            type="number"
            class="entry-input align-right"
            {value}
            oninput={handleInput}
            onkeydown={handleKeydown}
            step="any"
        />
    {:else}
        <input
            bind:this={inputEl}
            type="text"
            class="entry-input"
            {value}
            placeholder={col?.name ?? ""}
            oninput={handleInput}
            onkeydown={handleKeydown}
        />
    {/if}

    {#if error}
        <span class="error-indicator" title={error}>!</span>
    {/if}
</div>

<style>
    .table-entry-cell {
        display: flex;
        align-items: center;
        background: var(--cell-bg, #ffffff);
        border-right: 1px solid var(--cell-border, #e2e8f0);
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        box-sizing: border-box;
        overflow: hidden;
        flex-shrink: 0;
        position: relative;
    }

    .table-entry-cell.has-error {
        background: var(--entry-error-bg, #fef2f2);
    }

    .table-entry-cell.is-formula {
        background: rgba(0, 0, 0, 0.015);
        cursor: not-allowed;
    }

    .entry-input {
        flex: 1;
        border: none;
        background: transparent;
        padding: 0 4px;
        font-size: 13px;
        font-family: system-ui, -apple-system, sans-serif;
        height: 100%;
        outline: none;
        min-width: 0;
        color: var(--cell-text, #1e293b);
    }

    .entry-input:focus {
        background: var(--input-bg, #ffffff);
        outline: 2px solid var(--editor-outline, #3b82f6);
        outline-offset: -2px;
    }

    .entry-input.align-right {
        text-align: right;
    }

    .entry-input::placeholder {
        color: var(--placeholder-color, #94a3b8);
        font-style: italic;
        font-size: 12px;
    }

    .checkbox-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
    }

    .entry-checkbox {
        width: 14px;
        height: 14px;
        cursor: pointer;
    }

    .formula-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
    }

    .fx-icon {
        font-size: 10px;
        font-weight: 600;
        color: rgba(100, 116, 139, 0.4);
        font-family: monospace;
    }

    .error-indicator {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--required-color, #ef4444);
        font-size: 10px;
        font-weight: bold;
        pointer-events: none;
    }
</style>
