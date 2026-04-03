<script>
    /**
     * TableFilterPopover - Filter control for a table column.
     *
     * Opens from the filter icon in the column header.
     * Clean, minimal UI that matches the spreadsheet aesthetic.
     */

    import { close } from "../../../lib/icons/index.js";
    import BottomSheet from "../../ui/BottomSheet.svelte";
    import { mobileState } from "../../../stores/mobileState.svelte.js";

    let { table, colId, onClose = () => {} } = $props();

    let col = $derived(table?.columns?.find((c) => c.id === colId) ?? null);
    let existingFilter = $derived(table?.filters?.[colId] ?? null);
    let colType = $derived(col?.type ?? "text");

    let operator = $state(existingFilter?.op ?? "contains");
    let filterValue = $state(existingFilter?.value ?? "");

    $effect(() => {
        if (existingFilter) {
            operator = existingFilter.op ?? "contains";
            filterValue = existingFilter.value ?? "";
        }
    });

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
                    { value: ">=", label: "≥ or equal" },
                    { value: "<=", label: "≤ or equal" },
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
            default:
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

    $effect(() => {
        if (!existingFilter) {
            if (colType === "checkbox" || colType === "date") operator = "=";
            else if (colType === "number" || colType === "currency" || colType === "percent") operator = "=";
            else operator = "contains";
        }
    });

    let hasFilter = $derived(!!existingFilter);
    let isNoValueOp = $derived(operator === "empty" || operator === "notempty");
    let isCheckboxOp = $derived(colType === "checkbox");

    let quickValues = $derived.by(() => {
        if (!table || !colId) return [];
        const vals = table.getColumn(colId).filter((v) => v != null && v !== "").map((v) => String(v));
        return [...new Set(vals)].slice(0, 5);
    });

    let inputType = $derived.by(() => {
        if (colType === "date") return "date";
        if (colType === "number" || colType === "currency" || colType === "percent") return "number";
        return "text";
    });

    $effect(() => {
        if (!table || !colId) return;
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

    function handleKeydown(e) {
        if (e.key === "Escape") { e.stopPropagation(); onClose(); }
        else if (e.key === "Enter") { e.preventDefault(); onClose(); }
    }

    function useQuickValue(val) {
        filterValue = val;
        operator = colType === "text" || colType === "url" ? "contains" : "=";
    }
</script>

{#snippet filterBody()}
    <div class="filter-body">
        <select bind:value={operator} class="operator-select">
            {#each operators as op}
                <option value={op.value}>{op.label}</option>
            {/each}
        </select>

        {#if !isNoValueOp && !isCheckboxOp}
            <input
                type={inputType}
                bind:value={filterValue}
                placeholder="Value…"
                class="value-input"
                autofocus
            />
        {/if}

        {#if quickValues.length > 0 && !isNoValueOp && !isCheckboxOp}
            <div class="quick-values">
                {#each quickValues as val}
                    <button
                        class="quick-chip"
                        class:active={filterValue === val}
                        onclick={() => useQuickValue(val)}
                        type="button"
                    >{val}</button>
                {/each}
            </div>
        {/if}
    </div>

    <div class="filter-footer">
        {#if hasFilter}
            <button class="btn btn-clear" onclick={handleClear} type="button">Clear</button>
        {/if}
        <button class="btn btn-done" onclick={onClose} type="button">Done</button>
    </div>
{/snippet}

{#if mobileState.isMobile}
    <BottomSheet open={true} onClose={onClose} title="Filter: {col?.name ?? colId}" maxHeight="60vh">
        {@render filterBody()}
    </BottomSheet>
{:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="filter-popover" onkeydown={handleKeydown} role="dialog">
        <div class="filter-header">
            <span class="filter-col-name">{col?.name ?? colId}</span>
            {#if hasFilter}<span class="active-dot" title="Filter active"></span>{/if}
            <button class="close-btn" onclick={() => onClose()} aria-label="Close">{@html close}</button>
        </div>
        {@render filterBody()}
    </div>
{/if}

<style>
    .filter-popover {
        background: var(--cell-bg, #fff);
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        min-width: 190px;
        max-width: 240px;
        z-index: 100;
        font-size: 12px;
        color: var(--text-color, #1e293b);
    }

    .filter-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px 10px;
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        background: var(--header-bg, #f8fafc);
        border-radius: 6px 6px 0 0;
    }

    .filter-col-name {
        flex: 1;
        font-weight: 600;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-color, #334155);
    }

    .active-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #475569;
        flex-shrink: 0;
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #94a3b8;
        padding: 2px;
        border-radius: 3px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
    }

    .close-btn:hover { background: #e2e8f0; color: #475569; }

    .filter-body {
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .operator-select {
        width: 100%;
        height: 26px;
        padding: 0 6px;
        font-size: 12px;
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 4px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
    }

    .operator-select:focus { border-color: #94a3b8; }

    .value-input {
        width: 100%;
        height: 26px;
        padding: 0 8px;
        font-size: 12px;
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 4px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
        box-sizing: border-box;
    }

    .value-input:focus { border-color: #94a3b8; }

    .quick-values {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
    }

    .quick-chip {
        font-size: 10px;
        padding: 2px 7px;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        background: #f8fafc;
        color: #64748b;
        cursor: pointer;
        max-width: 80px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: 1.4;
    }

    .quick-chip:hover { border-color: #94a3b8; color: #1e293b; background: #f1f5f9; }
    .quick-chip.active { background: #f1f5f9; border-color: #64748b; color: #1e293b; }

    .filter-footer {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        padding: 6px 10px;
        border-top: 1px solid var(--cell-border, #e2e8f0);
        background: var(--header-bg, #f8fafc);
        border-radius: 0 0 6px 6px;
    }

    .btn {
        height: 24px;
        padding: 0 10px;
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #475569);
    }

    .btn:hover { background: #f1f5f9; border-color: #94a3b8; }

    .btn-done {
        background: #1e293b;
        color: #fff;
        border-color: #1e293b;
    }

    .btn-done:hover { background: #334155; border-color: #334155; }

    /* Mobile: larger controls inside BottomSheet */
    @media (pointer: coarse), (max-width: 768px) {
        .filter-body { padding: 12px 16px; gap: 10px; }
        .operator-select { height: 40px; font-size: 14px; padding: 0 10px; }
        .value-input { height: 40px; font-size: 14px; padding: 0 12px; }
        .quick-chip { font-size: 13px; padding: 6px 12px; }
        .filter-footer { padding: 10px 16px; gap: 10px; }
        .btn { height: 40px; padding: 0 16px; font-size: 14px; }
    }
</style>
