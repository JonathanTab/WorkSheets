<script>
    import { HEADER_WIDTH } from "../../../stores/spreadsheet/constants.js";

    let {
        virtualizer,
        bodyRowRange = { start: 0, end: -1, count: 0 },
        isRowSelected,
        onRowHeaderMouseDown,
        onStartRowResize,
    } = $props();

    let frozenRows = $derived(virtualizer?.frozenRows ?? 0);
    let frozenHeight = $derived(virtualizer?.frozenHeight ?? 0);
    let scrollTop = $derived(virtualizer?.scrollTop ?? 0);

    let frozenRowIndices = $derived.by(() => {
        const list = [];
        for (let r = 0; r < frozenRows; r++) list.push(r);
        return list;
    });

    let bodyRowIndices = $derived.by(() => {
        const list = [];
        for (let r = bodyRowRange.start; r <= bodyRowRange.end; r++) {
            if (r >= frozenRows) list.push(r);
        }
        return list;
    });

    function frozenTop(row) {
        return virtualizer.getRowTop(row);
    }

    function bodyTop(row) {
        return virtualizer.getRowTop(row) - frozenHeight;
    }
</script>

<div class="row-headers-root" style="width:{HEADER_WIDTH}px;">
    {#if frozenRows > 0}
        <div class="frozen-rows" style="height:{frozenHeight}px;">
            {#each frozenRowIndices as row (row)}
                {@const height = virtualizer.getRowHeight(row)}
                <div
                    class="row-header"
                    class:selected={isRowSelected?.(row)}
                    style="height:{height}px; top:{frozenTop(row)}px;"
                    onmousedown={() => onRowHeaderMouseDown?.(row)}
                    role="button"
                    tabindex="-1"
                >
                    <span>{row + 1}</span>
                    <div
                        class="resize-handle row-resize"
                        onmousedown={(e) => onStartRowResize?.(row, e)}
                        role="separator"
                        aria-orientation="horizontal"
                    ></div>
                </div>
            {/each}
        </div>
    {/if}

    <div class="scrollable-rows" style="top:{frozenHeight}px;">
        <div
            class="scrollable-inner"
            style="transform:translateY({-scrollTop}px);"
        >
            {#each bodyRowIndices as row (row)}
                {@const height = virtualizer.getRowHeight(row)}
                <div
                    class="row-header"
                    class:selected={isRowSelected?.(row)}
                    style="height:{height}px; top:{bodyTop(row)}px;"
                    onmousedown={() => onRowHeaderMouseDown?.(row)}
                    role="button"
                    tabindex="-1"
                >
                    <span>{row + 1}</span>
                    <div
                        class="resize-handle row-resize"
                        onmousedown={(e) => onStartRowResize?.(row, e)}
                        role="separator"
                        aria-orientation="horizontal"
                    ></div>
                </div>
            {/each}
        </div>
    </div>
</div>

<style>
    .row-headers-root {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        background: var(--header-bg, #f1f5f9);
        border-right: 1px solid var(--border-color, #e2e8f0);
        overflow: hidden;
        z-index: 30;
    }

    .frozen-rows {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        overflow: hidden;
    }

    .scrollable-rows {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        overflow: hidden;
    }

    .scrollable-inner {
        position: relative;
        will-change: transform;
    }

    .row-header {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--header-text, #64748b);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        cursor: pointer;
    }

    .row-header:hover {
        background: var(--header-hover, #e2e8f0);
    }

    .row-header.selected {
        background: var(--header-selected, #dbeafe);
        color: var(--header-selected-text, #1e40af);
    }

    .resize-handle {
        position: absolute;
        z-index: 30;
        background: transparent;
        transition: background 0.1s;
    }

    .resize-handle:hover {
        background: var(--color-primary);
        opacity: 0.5;
    }

    .row-resize {
        bottom: 0;
        left: 0;
        width: 100%;
        height: 4px;
        cursor: row-resize;
    }
</style>
