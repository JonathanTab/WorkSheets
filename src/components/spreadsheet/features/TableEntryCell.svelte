<script>
    /**
     * TableEntryCell - Input cell for the table's persistent entry row
     *
     * Renders a single column's input in the entry row. On Enter, calls
     * table.commitEntry() which validates and inserts the whole row.
     */

    let { table, colIndex, width = 80, height = 24 } = $props();

    let col = $derived(table?.columns?.[colIndex] ?? null);
    let value = $derived(col ? (table?.entryBuffer?.[col.id] ?? "") : "");
    let error = $derived(col ? (table?.entryErrors?.[col.id] ?? null) : null);

    function handleInput(e) {
        if (!col || !table) return;
        let val = e.target.value;
        if (col.ct?.type === "checkbox") {
            val = e.target.checked;
        }
        table.setEntryValue(col.id, val);
    }

    function handleKeydown(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            table?.commitEntry();
        } else if (e.key === "Escape") {
            table?.clearEntry();
        }
    }
</script>

<div
    class="table-entry-cell"
    class:has-error={!!error}
    style="width:{width}px; height:{height}px;"
    title={error ?? col?.name ?? ""}
>
    {#if col?.ct?.type === "checkbox"}
        <input
            type="checkbox"
            class="entry-checkbox"
            checked={!!value}
            onchange={handleInput}
            onkeydown={handleKeydown}
        />
    {:else if col?.ct?.type === "date"}
        <input
            type="date"
            class="entry-input"
            {value}
            oninput={handleInput}
            onkeydown={handleKeydown}
        />
    {:else if col?.ct?.type === "number" || col?.ct?.type === "currency" || col?.ct?.type === "percent"}
        <input
            type="number"
            class="entry-input"
            {value}
            oninput={handleInput}
            onkeydown={handleKeydown}
        />
    {:else}
        <input
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
        background: var(--table-entry-bg, #f8fafc);
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

    .entry-input {
        flex: 1;
        border: none;
        background: transparent;
        padding: 0 4px;
        font-size: 12px;
        height: 100%;
        outline: none;
        min-width: 0;
        color: var(--cell-text, #1e293b);
    }

    .entry-input::placeholder {
        color: var(--placeholder-color, #94a3b8);
        font-style: italic;
    }

    .entry-checkbox {
        margin: 0 auto;
    }

    .error-indicator {
        position: absolute;
        right: 2px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--required-color, #ef4444);
        font-size: 10px;
        font-weight: bold;
        pointer-events: none;
    }
</style>
