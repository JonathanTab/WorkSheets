<script>
    /**
     * TableViewport - Self-contained viewport-mode table panel
     *
     * Renders a DB-style table inside a fixed-size cell-range anchor.
     * Has its own scroll container so its data rows scroll independently
     * from the main sheet grid.
     *
     * Layout:
     *   ┌────────────────────────┐
     *   │ Sticky Header Row      │  (TableHeaderCell × N cols)
     *   │ Entry Row              │  (TableEntryCell × N cols)
     *   ├────────────────────────┤
     *   │ Scrollable Data Area   │  (virtualized rows of TableDataCell)
     *   └────────────────────────┘
     */

    import TableHeaderCell from "./TableHeaderCell.svelte";
    import TableEntryCell from "./TableEntryCell.svelte";
    import TableDataCell from "./TableDataCell.svelte";

    let {
        table,
        /** Width of the panel in pixels (from GridVirtualizer.getCellRangeRect) */
        width = 300,
        /** Height of the panel in pixels */
        height = 200,
    } = $props();

    const ROW_HEIGHT = 24;

    let columns = $derived(table?.columns ?? []);
    let rows = $derived(table?.sortedFilteredRows ?? []);
    let colWidths = $derived.by(() => {
        if (!columns.length) return [];
        const baseW = Math.floor(width / columns.length);
        // Last column gets any remainder
        const widths = columns.map(() => baseW);
        widths[widths.length - 1] += width - baseW * columns.length;
        return widths;
    });

    let scrollTop = $state(0);
    let clientHeight = $state(0);

    const HEADER_H = ROW_HEIGHT;
    const ENTRY_H = ROW_HEIGHT;
    const DATA_AREA_H = $derived(Math.max(0, height - HEADER_H - ENTRY_H));

    // Virtual row range
    let visibleStart = $derived(Math.floor(scrollTop / ROW_HEIGHT));
    let visibleEnd = $derived(
        Math.min(
            rows.length - 1,
            visibleStart + Math.ceil(DATA_AREA_H / ROW_HEIGHT) + 1,
        ),
    );
    let totalDataH = $derived(rows.length * ROW_HEIGHT);

    function handleScroll(e) {
        scrollTop = e.target.scrollTop;
    }
</script>

<div class="table-viewport" style="width:{width}px; height:{height}px;">
    <!-- Sticky header -->
    <div class="header-row" style="height:{HEADER_H}px;">
        {#each columns as _col, i (i)}
            <TableHeaderCell
                {table}
                colIndex={i}
                width={colWidths[i]}
                height={HEADER_H}
            />
        {/each}
    </div>

    <!-- Entry row -->
    <div class="entry-row" style="height:{ENTRY_H}px;">
        {#each columns as _col, i (i)}
            <TableEntryCell
                {table}
                colIndex={i}
                width={colWidths[i]}
                height={ENTRY_H}
            />
        {/each}
    </div>

    <!-- Scrollable data area -->
    <div
        class="data-scroll"
        style="height:{DATA_AREA_H}px;"
        onscroll={handleScroll}
        bind:clientHeight
    >
        <!-- Spacer for virtual scroll -->
        <div
            class="data-inner"
            style="height:{totalDataH}px; position:relative;"
        >
            {#each { length: Math.max(0, visibleEnd - visibleStart + 1) } as _, idx}
                {@const rowIdx = visibleStart + idx}
                {#if rowIdx < rows.length}
                    <div
                        class="data-row"
                        style="position:absolute; top:{rowIdx *
                            ROW_HEIGHT}px; left:0; height:{ROW_HEIGHT}px; display:flex;"
                    >
                        {#each columns as _col, ci (ci)}
                            <TableDataCell
                                {table}
                                colIndex={ci}
                                dataIndex={rowIdx}
                                width={colWidths[ci]}
                                height={ROW_HEIGHT}
                            />
                        {/each}
                    </div>
                {/if}
            {/each}
        </div>
    </div>

    <!-- Empty state -->
    {#if rows.length === 0}
        <div class="empty-state">No data</div>
    {/if}
</div>

<style>
    .table-viewport {
        display: flex;
        flex-direction: column;
        background: var(--cell-bg, #ffffff);
        border: 1px solid var(--table-header-border, #94a3b8);
        box-sizing: border-box;
        overflow: hidden;
    }

    .header-row,
    .entry-row {
        display: flex;
        flex-shrink: 0;
    }

    .data-scroll {
        overflow-y: auto;
        overflow-x: hidden;
        flex-shrink: 0;
    }

    .data-inner {
        min-width: 100%;
    }

    .data-row {
        width: 100%;
    }

    .empty-state {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: var(--placeholder-color, #94a3b8);
        font-size: 12px;
        pointer-events: none;
    }
</style>
