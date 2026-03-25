<script>
    /**
     * TableHeaderCell - Column header for a viewport-mode table.
     *
     * Looks like a regular spreadsheet column header: bold name, subtle bg,
     * heavy bottom border. Filter button is shown only when active or on hover.
     * Renaming is handled by double-clicking the cell (via parent).
     */

    import TableFilterPopover from "./TableFilterPopover.svelte";
    import { filter } from "../../../lib/icons/index.js";

    let { table, colIndex, width = 80, height = 24 } = $props();

    let col = $derived(table?.columns?.[colIndex] ?? null);
    let hasFilter = $derived(col?.id && table?.filters?.[col.id]);

    let showFilterPopover = $state(false);

    function handleFilterClick(e) {
        e.stopPropagation();
        showFilterPopover = !showFilterPopover;
    }

    function closeFilterPopover() {
        showFilterPopover = false;
    }
</script>

<div
    class="table-header-cell"
    style="width:{width}px; height:{height}px;"
    title={col?.name ?? ""}
>
    <span class="col-name">{col?.name ?? ""}</span>
    <button
        class="filter-btn"
        class:active={hasFilter}
        onclick={handleFilterClick}
        title={hasFilter ? "Filter active" : "Filter"}
        type="button"
    >
        {@html filter}
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
        border-bottom: 1.5px solid var(--table-header-border, #94a3b8);
        box-sizing: border-box;
        overflow: visible;
        flex-shrink: 0;
        position: relative;
        padding: 0 2px 0 4px;
        gap: 2px;
    }

    .col-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 600;
        color: var(--table-header-text, #334155);
    }

    .filter-btn {
        width: 18px;
        height: 18px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        color: var(--color-text-secondary, #94a3b8);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        opacity: 0.3;
    }

    .filter-btn:hover {
        opacity: 1;
        background: var(--color-fill, #e2e8f0);
    }

    .filter-btn.active {
        opacity: 1;
        color: var(--color-text, #475569);
    }

    .filter-popover-wrapper {
        position: absolute;
        top: 100%;
        right: 0;
        z-index: 50;
    }
</style>
