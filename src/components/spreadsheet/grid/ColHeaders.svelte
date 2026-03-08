<script>
    import { HEADER_HEIGHT } from "../../../stores/spreadsheet/constants.js";

    let {
        virtualizer,
        bodyColRange = { start: 0, end: -1, count: 0 },
        isColSelected,
        colHeader,
        onColHeaderMouseDown,
        onStartColResize,
    } = $props();

    let frozenCols = $derived(virtualizer?.frozenCols ?? 0);
    let frozenWidth = $derived(virtualizer?.frozenWidth ?? 0);
    let scrollLeft = $derived(virtualizer?.scrollLeft ?? 0);

    let frozenColIndices = $derived.by(() => {
        const list = [];
        for (let c = 0; c < frozenCols; c++) list.push(c);
        return list;
    });

    let bodyColIndices = $derived.by(() => {
        const list = [];
        for (let c = bodyColRange.start; c <= bodyColRange.end; c++) {
            if (c >= frozenCols) list.push(c);
        }
        return list;
    });
</script>

<div class="col-headers-root" style="height:{HEADER_HEIGHT}px;">
    {#if frozenCols > 0}
        <div class="frozen-cols" style="width:{frozenWidth}px;">
            {#each frozenColIndices as col (col)}
                {@const width = virtualizer.getColWidth(col)}
                <div
                    class="col-header"
                    class:selected={isColSelected?.(col)}
                    style="width:{width}px;"
                    onmousedown={() => onColHeaderMouseDown?.(col)}
                    role="button"
                    tabindex="-1"
                >
                    <span>{colHeader?.(col)}</span>
                    <div
                        class="resize-handle col-resize"
                        onmousedown={(e) => onStartColResize?.(col, e)}
                        role="separator"
                        aria-orientation="vertical"
                    ></div>
                </div>
            {/each}
        </div>
    {/if}

    <div class="scrollable-cols" style="left:{frozenWidth}px;">
        <div
            class="scrollable-inner"
            style="transform:translateX({-scrollLeft}px);"
        >
            {#each bodyColIndices as col (col)}
                {@const width = virtualizer.getColWidth(col)}
                <div
                    class="col-header"
                    class:selected={isColSelected?.(col)}
                    style="width:{width}px;"
                    onmousedown={() => onColHeaderMouseDown?.(col)}
                    role="button"
                    tabindex="-1"
                >
                    <span>{colHeader?.(col)}</span>
                    <div
                        class="resize-handle col-resize"
                        onmousedown={(e) => onStartColResize?.(col, e)}
                        role="separator"
                        aria-orientation="vertical"
                    ></div>
                </div>
            {/each}
        </div>
    </div>
</div>

<style>
    .col-headers-root {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        background: var(--header-bg, #f1f5f9);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        overflow: hidden;
        z-index: 30;
    }

    .frozen-cols {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        display: flex;
        overflow: hidden;
    }

    .scrollable-cols {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        overflow: hidden;
    }

    .scrollable-inner {
        display: flex;
        height: 100%;
        will-change: transform;
    }

    .col-header {
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--header-text, #64748b);
        border-right: 1px solid var(--border-color, #e2e8f0);
        position: relative;
        flex-shrink: 0;
        cursor: pointer;
    }

    .col-header:hover {
        background: var(--header-hover, #e2e8f0);
    }

    .col-header.selected {
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

    .col-resize {
        top: 0;
        right: 0;
        width: 4px;
        height: 100%;
        cursor: col-resize;
    }
</style>
