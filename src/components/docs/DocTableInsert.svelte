<script>
    /**
     * DocTableInsert — hover grid picker for inserting a table (like Google Docs).
     * Emits oninsert(rows, cols) when the user clicks a grid cell.
     */
    let {
        oninsert = undefined,
        onclose = undefined,
        maxRows = 8,
        maxCols = 10,
    } = $props();

    let hoverRow = $state(0);
    let hoverCol = $state(0);

    function handleMouseEnter(r, c) {
        hoverRow = r;
        hoverCol = c;
    }

    function handleClick(r, c) {
        oninsert?.(r, c);
        onclose?.();
    }

    function handleKeydown(e) {
        if (e.key === 'Escape') onclose?.();
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="table-picker" role="grid" aria-label="Table size picker" onkeydown={handleKeydown}>
    <div class="grid">
        {#each Array(maxRows) as _, r}
            <div class="grid-row">
                {#each Array(maxCols) as _, c}
                    <button
                        class="cell"
                        class:highlighted={r < hoverRow && c < hoverCol}
                        onmouseenter={() => handleMouseEnter(r + 1, c + 1)}
                        onclick={() => handleClick(r + 1, c + 1)}
                        aria-label="{r + 1}×{c + 1} table"
                        tabindex="-1"
                    ></button>
                {/each}
            </div>
        {/each}
    </div>
    <div class="label">
        {#if hoverRow > 0 && hoverCol > 0}
            {hoverRow} × {hoverCol}
        {:else}
            Insert table
        {/if}
    </div>
</div>

<style>
    .table-picker {
        padding: 8px;
        user-select: none;
        min-width: 160px;
    }

    .grid {
        display: flex;
        flex-direction: column;
        gap: 3px;
    }

    .grid-row {
        display: flex;
        gap: 3px;
    }

    .cell {
        width: 14px;
        height: 14px;
        border: 1px solid var(--color-border, #c6c6c8);
        border-radius: 2px;
        background: var(--color-surface, #fff);
        cursor: pointer;
        padding: 0;
        transition: background 0.05s, border-color 0.05s;
    }

    .cell.highlighted {
        background: var(--color-primary-soft, #dbeafe);
        border-color: var(--color-primary, #007AFF);
    }

    .cell:hover {
        border-color: var(--color-primary, #007AFF);
    }

    .label {
        margin-top: 6px;
        text-align: center;
        font-size: 11px;
        color: var(--color-text-secondary, #3c3c43);
        font-weight: 500;
    }
</style>
