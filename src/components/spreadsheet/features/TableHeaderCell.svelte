<script>
    /**
     * TableHeaderCell - Column header for a viewport-mode table.
     *
     * Looks like a regular spreadsheet column header: bold name, subtle bg,
     * heavy bottom border. Filter button is shown only when active or on hover.
     * Renaming is handled by double-clicking the cell (via parent).
     * Clicking cycles the sort: none → desc (newest first) → asc → none.
     */

    import TableFilterPopover from "./TableFilterPopover.svelte";
    import { filter } from "../../../lib/icons/index.js";

    let { table, colIndex, width = 80, height = 24 } = $props();

    let col = $derived(table?.columns?.[colIndex] ?? null);
    let hasFilter = $derived(col?.id && table?.filters?.[col.id]);
    let isSorted = $derived(col?.id && table?.sortColId === col?.id);
    let sortArrow = $derived(isSorted ? (table?.sortDir === "asc" ? "▲" : "▼") : null);
    let headerTitle = $derived(
        isSorted
            ? table?.sortDir === "desc"
                ? `${col?.name}: descending — click for ascending`
                : `${col?.name}: ascending — click to clear sort`
            : `${col?.name} — click to sort descending`
    );

    let showFilterPopover = $state(false);

    function handleFilterClick(e) {
        e.stopPropagation();
        showFilterPopover = !showFilterPopover;
    }

    function closeFilterPopover() {
        showFilterPopover = false;
    }

    function handleHeaderClick(e) {
        if (!col?.id || !table) return;
        if (!isSorted) {
            // First click: sort desc (newest/largest at top — matches default insert order)
            table.setSort(col.id, "desc");
        } else if (table.sortDir === "desc") {
            // Second click: flip to asc
            table.setSort(col.id, "asc");
        } else {
            // Third click: clear sort (back to default insert-order newest-first)
            table.clearSort();
        }
    }
</script>

<div
    class="table-header-cell"
    style="width:{width}px; height:{height}px;"
    title={headerTitle}
    onclick={handleHeaderClick}
    role="button"
    tabindex="0"
    onkeydown={(e) => e.key === "Enter" && handleHeaderClick(e)}
>
    <span class="col-name">{col?.name ?? ""}</span>
    {#if sortArrow}
        <span class="sort-arrow">{sortArrow}</span>
    {/if}
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
        cursor: pointer;
        user-select: none;
    }

    .table-header-cell:hover {
        background: var(--table-header-bg-hover, #e2e8f0);
    }

    .sort-arrow {
        font-size: 9px;
        color: var(--color-accent, #3b82f6);
        flex-shrink: 0;
        line-height: 1;
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

    /* Mobile: bigger filter button */
    @media (pointer: coarse), (max-width: 768px) {
        .filter-btn {
            width: 36px;
            height: 36px;
            opacity: 0.6;
        }
    }
</style>
