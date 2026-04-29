<script>
    import { HEADER_HEIGHT } from "../../../stores/spreadsheet/constants.js";
    import { mobileState } from "../../../stores/mobileState.svelte.js";

    let {
        virtualizer,
        bodyColRange = { start: 0, end: -1, count: 0 },
        isColSelected,
        colHeader,
        onColHeaderMouseDown,
        onColHeaderContextMenu,
        onStartColResize,
        onStartColResizeTouch,
        onStartFreezeColDrag,
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

    let bodyStartLeft = $derived.by(() => {
        if (!virtualizer) return 0;
        const start = Math.max(frozenCols, bodyColRange.start ?? 0);
        return virtualizer.getColLeft(start);
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
                    onmousedown={(e) => onColHeaderMouseDown?.(col, e)}
                    oncontextmenu={(e) => onColHeaderContextMenu?.(col, e)}
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
                    {#if mobileState.isMobile}
                        <div
                            class="resize-handle-touch col-resize-touch"
                            ontouchstart={(e) => { e.preventDefault(); e.stopPropagation(); onStartColResizeTouch?.(col, e); }}
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize column"
                        >
                            <div class="resize-pill"></div>
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}

    <!-- Freeze handle: draggable line at the frozen/non-frozen column boundary -->
    {#if frozenCols > 0}
        <div
            class="freeze-handle"
            style="left:{frozenWidth}px;"
            onmousedown={(e) => onStartFreezeColDrag?.(e)}
            role="separator"
            aria-orientation="vertical"
            title="Drag to adjust frozen columns"
        ></div>
    {/if}

    <div class="scrollable-cols" style="left:{frozenWidth}px;">
        <div
            class="scrollable-inner"
            style="transform:translateX({Math.round(bodyStartLeft - scrollLeft)}px);"
        >
            {#each bodyColIndices as col (col)}
                {@const width = virtualizer.getColWidth(col)}
                <div
                    class="col-header"
                    class:selected={isColSelected?.(col)}
                    style="width:{width}px;"
                    onmousedown={(e) => onColHeaderMouseDown?.(col, e)}
                    oncontextmenu={(e) => onColHeaderContextMenu?.(col, e)}
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
                    {#if mobileState.isMobile}
                        <div
                            class="resize-handle-touch col-resize-touch"
                            ontouchstart={(e) => { e.preventDefault(); e.stopPropagation(); onStartColResizeTouch?.(col, e); }}
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize column"
                        >
                            <div class="resize-pill"></div>
                        </div>
                    {/if}
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

    /* Mobile: wide touch target for column resize */
    .resize-handle-touch {
        position: absolute;
        z-index: 31;
        top: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        touch-action: none;
        cursor: col-resize;
    }

    .col-resize-touch {
        right: 0;
        width: 16px;
    }

    .resize-pill {
        width: 2px;
        height: 60%;
        border-radius: 1px;
        background: var(--color-primary, #3b82f6);
        opacity: 0.4;
        pointer-events: none;
    }

    .col-resize-touch:active .resize-pill {
        opacity: 0.9;
    }

    /* ── Freeze handle ── */
    .freeze-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 6px;
        transform: translateX(-3px);
        cursor: col-resize;
        z-index: 40;
        pointer-events: auto;
        background: transparent;
        border-left: 2px solid rgba(100, 116, 139, 0.5);
    }
    .freeze-handle:hover,
    .freeze-handle:active {
        border-left-color: var(--color-primary, #3b82f6);
        background: rgba(59, 130, 246, 0.08);
    }
</style>
