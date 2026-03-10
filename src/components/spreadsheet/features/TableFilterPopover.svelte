<script>
    /**
     * TableFilterPopover - Filter dropdown for a table column
     *
     * Opens from a filter icon in the table header. Provides:
     * - Filter operator selection (=, >, <, contains, etc.)
     * - Filter value input
     * - Clear filter button
     */

    /**
     * @typedef {Object} Props
     * @property {import('../../../stores/spreadsheet/features/TableStore.svelte.js').TableStore} table
     * @property {string} colId
     * @property {function} [onClose]
     */

    /** @type {Props} */
    let { table, colId, onClose = () => {} } = $props();

    let col = $derived(table?.columns?.find((c) => c.id === colId) ?? null);
    let existingFilter = $derived(table?.filters?.[colId] ?? null);

    // Filter state
    let operator = $state(existingFilter?.op ?? "=");
    let filterValue = $state(existingFilter?.value ?? "");

    // Operator options based on column type
    let operators = $derived.by(() => {
        const type = col?.type ?? "text";
        if (type === "number") {
            return [
                { value: "=", label: "=" },
                { value: "<>", label: "≠" },
                { value: ">", label: ">" },
                { value: "<", label: "<" },
                { value: ">=", label: "≥" },
                { value: "<=", label: "≤" },
            ];
        }
        return [
            { value: "=", label: "Equals" },
            { value: "<>", label: "Not equals" },
            { value: "contains", label: "Contains" },
        ];
    });

    let hasFilter = $derived(!!existingFilter);

    function handleApply() {
        if (!table || !colId) return;
        if (filterValue.trim() === "") {
            table.clearFilter(colId);
        } else {
            table.setFilter(colId, operator, filterValue);
        }
        onClose();
    }

    function handleClear() {
        if (!table || !colId) return;
        table.clearFilter(colId);
        filterValue = "";
        operator = "=";
        onClose();
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            onClose();
        } else if (e.key === "Enter") {
            e.preventDefault();
            handleApply();
        }
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="filter-popover">
    <div class="filter-header">
        <span class="filter-title">Filter: {col?.name ?? colId}</span>
        {#if hasFilter}
            <span class="filter-badge" title="Filter active">●</span>
        {/if}
    </div>

    <div class="filter-body">
        <div class="filter-row">
            <select bind:value={operator} class="operator-select">
                {#each operators as op}
                    <option value={op.value}>{op.label}</option>
                {/each}
            </select>
        </div>

        <div class="filter-row">
            <input
                type="text"
                bind:value={filterValue}
                placeholder="Filter value..."
                class="value-input"
            />
        </div>
    </div>

    <div class="filter-footer">
        {#if hasFilter}
            <button class="btn btn-clear" onclick={handleClear} type="button">
                Clear
            </button>
        {/if}
        <button class="btn btn-apply" onclick={handleApply} type="button">
            Apply
        </button>
    </div>
</div>

<style>
    .filter-popover {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        min-width: 180px;
        z-index: 100;
    }

    .filter-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--color-border);
    }

    .filter-title {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text);
    }

    .filter-badge {
        color: var(--color-primary, #3b82f6);
        font-size: 8px;
    }

    .filter-body {
        padding: 8px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .filter-row {
        display: flex;
    }

    .operator-select {
        flex: 1;
        height: 28px;
        padding: 0 8px;
        font-size: 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
    }

    .operator-select:focus {
        outline: none;
        border-color: var(--color-primary);
    }

    .value-input {
        flex: 1;
        height: 28px;
        padding: 0 8px;
        font-size: 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
    }

    .value-input:focus {
        outline: none;
        border-color: var(--color-primary);
    }

    .filter-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 8px 12px;
        border-top: 1px solid var(--color-border);
    }

    .btn {
        height: 28px;
        padding: 0 12px;
        border: none;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
    }

    .btn-apply {
        background: var(--color-primary);
        color: white;
    }

    .btn-apply:hover {
        background: var(--color-primary-hover, #2563eb);
    }

    .btn-clear {
        background: transparent;
        color: var(--color-text-secondary);
        border: 1px solid var(--color-border);
    }

    .btn-clear:hover {
        background: var(--color-fill);
    }
</style>
