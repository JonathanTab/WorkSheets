<script>
    /**
     * TableFilterPopover - Enhanced filter dropdown for a table column
     *
     * Opens from a filter icon in the table header. Provides:
     * - Type-aware filter operator selection
     * - Type-appropriate input (date, number, text, checkbox)
     * - Quick value chips (top unique values in the column)
     * - Clear filter button
     */

    import { COLUMN_TYPE_ICONS } from "../../../stores/spreadsheet/features/TableStore.svelte.js";

    let { table, colId, onClose = () => {} } = $props();

    let col = $derived(table?.columns?.find((c) => c.id === colId) ?? null);
    let existingFilter = $derived(table?.filters?.[colId] ?? null);
    let colType = $derived(col?.type ?? "text");

    // Filter state
    let operator = $state(existingFilter?.op ?? "contains");
    let filterValue = $state(existingFilter?.value ?? "");

    // Initialize from existing filter
    $effect(() => {
        if (existingFilter) {
            operator = existingFilter.op ?? "contains";
            filterValue = existingFilter.value ?? "";
        }
    });

    // Type-aware operators
    let operators = $derived.by(() => {
        switch (colType) {
            case "number":
            case "currency":
            case "percent":
                return [
                    { value: "=", label: "= Equals" },
                    { value: "<>", label: "≠ Not equals" },
                    { value: ">", label: "> Greater than" },
                    { value: "<", label: "< Less than" },
                    { value: ">=", label: "≥ ≥" },
                    { value: "<=", label: "≤ ≤" },
                    { value: "empty", label: "Is empty" },
                    { value: "notempty", label: "Is not empty" },
                ];
            case "date":
                return [
                    { value: "=", label: "On date" },
                    { value: "<>", label: "Not on date" },
                    { value: ">", label: "After" },
                    { value: "<", label: "Before" },
                    { value: ">=", label: "On or after" },
                    { value: "<=", label: "On or before" },
                    { value: "empty", label: "Is empty" },
                    { value: "notempty", label: "Is not empty" },
                ];
            case "checkbox":
                return [
                    { value: "=", label: "Is checked" },
                    { value: "<>", label: "Is unchecked" },
                ];
            default: // text, url, rating
                return [
                    { value: "contains", label: "Contains" },
                    { value: "notcontains", label: "Does not contain" },
                    { value: "=", label: "Equals" },
                    { value: "<>", label: "Not equals" },
                    { value: "startswith", label: "Starts with" },
                    { value: "empty", label: "Is empty" },
                    { value: "notempty", label: "Is not empty" },
                ];
        }
    });

    // Set default operator when column type changes
    $effect(() => {
        if (!existingFilter) {
            if (colType === "checkbox") operator = "=";
            else if (
                colType === "number" ||
                colType === "currency" ||
                colType === "percent"
            )
                operator = "=";
            else if (colType === "date") operator = "=";
            else operator = "contains";
        }
    });

    let hasFilter = $derived(!!existingFilter);
    let isNoValueOp = $derived(operator === "empty" || operator === "notempty");
    let isCheckboxOp = $derived(colType === "checkbox");

    // Quick value suggestions (top 5 unique non-null values from column)
    let quickValues = $derived.by(() => {
        if (!table || !colId) return [];
        const vals = table
            .getColumn(colId)
            .filter((v) => v != null && v !== "")
            .map((v) => String(v));
        const unique = [...new Set(vals)].slice(0, 5);
        return unique;
    });

    let inputType = $derived.by(() => {
        if (colType === "date") return "date";
        if (
            colType === "number" ||
            colType === "currency" ||
            colType === "percent"
        )
            return "number";
        return "text";
    });

    // Apply filter in real time whenever operator or value changes
    $effect(() => {
        if (!table || !colId) return;
        // Debounce slightly using a microtask
        const op = operator;
        const val = filterValue;
        const noVal = op === "empty" || op === "notempty";
        const chkOp = colType === "checkbox";
        if (noVal) {
            table.setFilter(colId, op, "");
        } else if (chkOp) {
            table.setFilter(colId, op, op === "=" ? true : false);
        } else if (String(val).trim() === "") {
            table.clearFilter(colId);
        } else {
            table.setFilter(colId, op, val);
        }
    });

    function handleClear() {
        if (!table || !colId) return;
        table.clearFilter(colId);
        filterValue = "";
    }

    function handleDone() {
        onClose();
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
        } else if (e.key === "Enter") {
            e.preventDefault();
            onClose();
        }
    }

    function useQuickValue(val) {
        filterValue = val;
        operator = colType === "text" || colType === "url" ? "contains" : "=";
    }

    let typeIcon = $derived(COLUMN_TYPE_ICONS[colType] ?? "A");
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="filter-popover" onkeydown={handleKeydown} role="dialog">
    <!-- Header -->
    <div class="filter-header">
        <span class="type-chip">{typeIcon}</span>
        <span class="filter-title">{col?.name ?? colId}</span>
        {#if hasFilter}
            <span class="active-badge" title="Filter active">●</span>
        {/if}
        <button class="close-btn" onclick={() => onClose()} aria-label="Close"
            >✕</button
        >
    </div>

    <div class="filter-body">
        <!-- Operator -->
        <select bind:value={operator} class="operator-select">
            {#each operators as op}
                <option value={op.value}>{op.label}</option>
            {/each}
        </select>

        <!-- Value input (hidden for no-value ops and checkbox) -->
        {#if !isNoValueOp && !isCheckboxOp}
            <input
                type={inputType}
                bind:value={filterValue}
                placeholder="Value…"
                class="value-input"
                autofocus
            />
        {/if}

        <!-- Quick value chips -->
        {#if quickValues.length > 0 && !isNoValueOp && !isCheckboxOp}
            <div class="quick-values">
                <span class="quick-label">Quick:</span>
                {#each quickValues as val}
                    <button
                        class="quick-chip"
                        class:active={filterValue === val}
                        onclick={() => useQuickValue(val)}
                        type="button">{val}</button
                    >
                {/each}
            </div>
        {/if}
    </div>

    <!-- Footer -->
    <div class="filter-footer">
        {#if hasFilter}
            <button class="btn btn-clear" onclick={handleClear} type="button">
                Clear
            </button>
        {/if}
        <button class="btn btn-done" onclick={handleDone} type="button">
            Done
        </button>
    </div>
</div>

<style>
    .filter-popover {
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
        min-width: 200px;
        max-width: 260px;
        z-index: 100;
        font-size: 12px;
        color: var(--color-text, #1e293b);
    }

    .filter-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        background: var(--color-fill, #f8fafc);
        border-radius: 8px 8px 0 0;
    }

    .type-chip {
        font-size: 11px;
        background: #e0e7ff;
        color: #4338ca;
        padding: 1px 5px;
        border-radius: 3px;
        font-weight: 500;
        flex-shrink: 0;
    }

    .filter-title {
        flex: 1;
        font-weight: 600;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .active-badge {
        color: #3b82f6;
        font-size: 8px;
        flex-shrink: 0;
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #94a3b8;
        font-size: 11px;
        padding: 1px 3px;
        border-radius: 3px;
        flex-shrink: 0;
        line-height: 1;
    }

    .close-btn:hover {
        background: #e2e8f0;
        color: #475569;
    }

    .filter-body {
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .operator-select {
        width: 100%;
        height: 28px;
        padding: 0 6px;
        font-size: 12px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        outline: none;
    }

    .operator-select:focus {
        border-color: #3b82f6;
    }

    .value-input {
        width: 100%;
        height: 28px;
        padding: 0 8px;
        font-size: 12px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        outline: none;
        box-sizing: border-box;
    }

    .value-input:focus {
        border-color: #3b82f6;
    }

    /* Quick value chips */
    .quick-values {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
    }

    .quick-label {
        font-size: 10px;
        color: #94a3b8;
        flex-shrink: 0;
    }

    .quick-chip {
        font-size: 10px;
        padding: 2px 6px;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        background: #f8fafc;
        color: #475569;
        cursor: pointer;
        transition: all 0.1s;
        max-width: 80px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: 1.4;
    }

    .quick-chip:hover {
        border-color: #3b82f6;
        color: #1d4ed8;
        background: #eff6ff;
    }

    .quick-chip.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }

    /* Footer */
    .filter-footer {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        padding: 8px 10px;
        border-top: 1px solid var(--color-border, #e2e8f0);
        background: var(--color-fill, #f8fafc);
        border-radius: 0 0 8px 8px;
    }

    .btn {
        height: 26px;
        padding: 0 12px;
        border: none;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.1s;
    }

    .btn-done {
        background: #3b82f6;
        color: white;
    }

    .btn-done:hover {
        background: #2563eb;
    }

    .btn-clear {
        background: transparent;
        color: #64748b;
        border: 1px solid #e2e8f0;
    }

    .btn-clear:hover {
        background: #f1f5f9;
        border-color: #94a3b8;
    }
</style>
