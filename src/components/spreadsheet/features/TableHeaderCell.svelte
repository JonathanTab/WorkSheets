<script>
    /**
     * TableHeaderCell - Column header for an inline or sticky table header
     *
     * Renders the column name, sort indicator (▲/▼ when this column is sorted),
     * and a filter toggle button.
     */

    import TableFilterPopover from "./TableFilterPopover.svelte";

    let { table, colIndex, width = 80, height = 24 } = $props();

    let col = $derived(table?.columns?.[colIndex] ?? null);
    let isSorted = $derived(table?.sortColId === col?.id);
    let sortDir = $derived(table?.sortDir ?? "asc");
    let hasFilter = $derived(col?.id && table?.filters?.[col.id]);

    // Filter popover state
    let showFilterPopover = $state(false);

    function handleFilterClick(e) {
        e.stopPropagation();
        showFilterPopover = !showFilterPopover;
    }

    function closeFilterPopover() {
        showFilterPopover = false;
    }

    let sortIcon = $derived(isSorted ? (sortDir === "asc" ? "▲" : "▼") : "");
</script>

<div
    class="table-header-cell"
    style="width:{width}px; height:{height}px;"
    title={col?.name ?? ""}
>
    <button class="sort-area" type="button">
        <span class="col-name">{col?.name ?? ""}</span>
        {#if sortIcon}
            <span class="sort-icon">{sortIcon}</span>
        {/if}
    </button>
    {#if col?.required}
        <span class="required-badge" title="Required">*</span>
    {/if}
    <button
        class="filter-btn"
        class:active={hasFilter}
        onclick={handleFilterClick}
        title={hasFilter ? "Filter active" : "Add filter"}
        type="button"
    >
        ☰
    </button>
    {#if showFilterPopover}
        <div class="filter-popover-wrapper">
            <TableFilterPopover
                {table}
                colId={col?.id}
                onClose={closeFilterPopover}
            />
        </div>
    {/if}
</div>

<style>
    .table-header-cell {
        display: flex;
        align-items: center;
        background: var(--table-header-bg, #f1f5f9);
        border-right: 1px solid var(--cell-border, #e2e8f0);
        border-bottom: 2px solid var(--table-header-border, #94a3b8);
        box-sizing: border-box;
        overflow: visible;
        flex-shrink: 0;
        position: relative;
    }

    .sort-area {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 0 4px;
        background: none;
        border: none;
        font-size: 12px;
        font-weight: 600;
        color: var(--table-header-text, #334155);
        min-width: 0;
        height: 100%;
    }

    .col-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        text-align: left;
    }

    .sort-icon {
        font-size: 9px;
        color: var(--table-sort-color, #3b82f6);
        flex-shrink: 0;
    }

    .required-badge {
        color: var(--required-color, #ef4444);
        font-size: 10px;
        padding: 0 2px;
        flex-shrink: 0;
    }

    .filter-btn {
        width: 18px;
        height: 18px;
        padding: 0;
        margin-right: 2px;
        background: transparent;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 10px;
        color: var(--color-text-secondary, #94a3b8);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        opacity: 0.5;
    }

    .filter-btn:hover {
        background: var(--table-header-hover, #e2e8f0);
        opacity: 1;
    }

    .filter-btn.active {
        color: var(--color-primary, #3b82f6);
        opacity: 1;
    }

    .filter-popover-wrapper {
        position: absolute;
        top: 100%;
        right: 0;
        z-index: 50;
    }
</style>
