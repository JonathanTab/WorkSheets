<script>
    /**
     * TableEntryCell - Input cell for the table's persistent entry row
     *
     * Renders a single column's input in the entry row. On Enter, calls
     * table.commitEntry() which validates and inserts the whole row.
     *
     * Features:
     *   - Tab key moves to next editable column (via onTabNext/onTabPrev callbacks)
     *   - Formula/computed columns show a disabled fx placeholder
     *   - Shift+Tab moves to previous column
     *   - Enter commits the entry and returns to first field
     *   - Escape clears the entry
     *   - Styled to match regular spreadsheet cells
     */

    let {
        table,
        colIndex,
        width = 80,
        height = 24,
        /** Callback: request focus on the next entry cell */
        onTabNext = null,
        /** Callback: request focus on the previous entry cell */
        onTabPrev = null,
        /** Callback: called when Enter is pressed to commit the entry row */
        onCommit = null,
        /** Callback: called on any input change (e.g. to repaint canvas) */
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

    // Focus management
    let inputEl = $state(null);
    export function focus() {
        inputEl?.focus();
    }
</script>

<div
    class="table-entry-cell"
    class:has-error={!!error}
    class:is-formula={isFormula}
    class:is-first-col={colIndex === 0}
    style="width:{width}px; height:{height}px; --accent:{table?.accentColor ??
        '#3b82f6'};"
    title={error ?? (isFormula ? "Computed column" : (col?.name ?? ""))}
>
    {#if isFormula}
        <!-- Formula column: show a visual placeholder only, not interactive -->
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
        <input
            bind:this={inputEl}
            type="date"
            class="entry-input"
            class:has-value={!!value}
            {value}
            oninput={handleInput}
            onkeydown={handleKeydown}
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
        /* White background like regular cells */
        background: var(--cell-bg, #ffffff);
        border-right: 1px solid var(--cell-border, #e2e8f0);
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        box-sizing: border-box;
        overflow: hidden;
        flex-shrink: 0;
        position: relative;
        padding-left: 0;
    }

    .table-entry-cell.is-first-col {
        padding-left: 3px;
    }

    .table-entry-cell.is-first-col::before {
        content: "";
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: var(--accent, #3b82f6);
    }

    .table-entry-cell.has-error {
        background: var(--entry-error-bg, #fef2f2);
    }

    .table-entry-cell.is-formula {
        background: rgba(139, 92, 246, 0.04);
        cursor: not-allowed;
    }

    .entry-input {
        flex: 1;
        border: none;
        background: transparent;
        padding: 0 4px;
        font-size: 13px;
        font-family:
            system-ui,
            -apple-system,
            sans-serif;
        height: 100%;
        outline: none;
        min-width: 0;
        color: var(--cell-text, #1e293b);
    }

    .entry-input:focus {
        background: var(--input-bg, #ffffff);
        outline: 2px solid var(--accent, #3b82f6);
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

    /* Style date inputs to match text inputs */
    .entry-input[type="date"] {
        color-scheme: light;
    }

    .entry-input[type="date"]:not(.has-value) {
        color: var(--placeholder-color, #94a3b8);
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
        accent-color: var(--accent, #3b82f6);
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
        color: rgba(139, 92, 246, 0.4);
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
