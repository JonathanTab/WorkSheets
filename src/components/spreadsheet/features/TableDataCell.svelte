<script>
    /**
     * TableDataCell - Renders a single data cell in a viewport-mode table row.
     *
     * Used only by TableViewport (viewport-mode tables rendered as DOM overlays).
     * Inline table data cells are now rendered on canvas by CanvasRenderer.
     *
     * Checkbox and rating cells are rendered inline via Svelte markup now that
     * the old Svelte component files are removed.
     */
    import { CellTypeRegistry } from "../../../stores/spreadsheet/cellTypes/index.js";
    import { star, starEmpty } from "../../../lib/icons/index.js";

    let { table, colIndex, dataIndex, width = 80, height = 24 } = $props();

    let col = $derived(table?.columns?.[colIndex] ?? null);
    let rawValue = $derived(
        col && dataIndex >= 0 ? table?.getValue(dataIndex, col.id) : null,
    );

    let ct = $derived(col?.ct);
    let descriptor = $derived(ct ? CellTypeRegistry.get(ct.type) : null);

    let isCheckbox = $derived(ct?.type === "checkbox");
    let isRating = $derived(ct?.type === "rating");
    let ratingMax = $derived(ct?.max ?? 5);
    let ratingValue = $derived(Number(rawValue) || 0);

    let displayValue = $derived(() => {
        if (rawValue == null) return "";
        if (ct) return CellTypeRegistry.formatValue(ct, rawValue);
        return String(rawValue);
    });

    function handleValueChange(newValue) {
        if (col && dataIndex >= 0) {
            table.updateCell(dataIndex, col.id, newValue);
        }
    }

    function handleCheckboxClick(e) {
        e.stopPropagation();
        e.preventDefault();
        handleValueChange(!rawValue);
    }

    function handleStarClick(e, starIndex) {
        e.stopPropagation();
        e.preventDefault();
        handleValueChange(starIndex + 1);
    }

    // Conditional formatting
    let condStyle = $derived.by(() => {
        if (!col?.conditionalFormats?.length || rawValue == null) return "";
        const s = [];
        for (const fmt of col.conditionalFormats) {
            if (matchesCondition(rawValue, fmt.condition, fmt.value)) {
                if (fmt.style?.backgroundColor)
                    s.push(`background-color:${fmt.style.backgroundColor}`);
                if (fmt.style?.color) s.push(`color:${fmt.style.color}`);
                if (fmt.style?.bold) s.push("font-weight:bold");
                break;
            }
        }
        return s.join(";");
    });

    function matchesCondition(v, cond, threshold) {
        const n = Number(v);
        const t = Number(threshold);
        switch (cond) {
            case "gt":
                return n > t;
            case "lt":
                return n < t;
            case "gte":
                return n >= t;
            case "lte":
                return n <= t;
            case "eq":
                return v == threshold;
            case "neq":
                return v != threshold;
            case "contains":
                return String(v)
                    .toLowerCase()
                    .includes(String(threshold).toLowerCase());
            default:
                return false;
        }
    }
</script>

<div
    class="table-data-cell"
    style="width:{width}px; height:{height}px; {condStyle}"
    title={String(rawValue ?? "")}
>
    {#if isCheckbox}
        <div
            class="checkbox-wrapper"
            onmousedown={handleCheckboxClick}
            role="checkbox"
            aria-checked={!!rawValue}
            tabindex="-1"
        >
            <div class="checkbox" class:checked={!!rawValue}>
                {#if rawValue}
                    <svg
                        viewBox="0 0 24 24"
                        width="12"
                        height="12"
                        stroke="currentColor"
                        stroke-width="3"
                        fill="none"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                {/if}
            </div>
        </div>
    {:else if isRating}
        <div class="rating-wrapper">
            {#each Array(ratingMax) as _, i}
                <span
                    class="star"
                    class:active={i < ratingValue}
                    onmousedown={(e) => handleStarClick(e, i)}
                    role="button"
                    tabindex="-1"
                >
                    {@html i < ratingValue ? star : starEmpty}
                </span>
            {/each}
        </div>
    {:else}
        <span class="cell-text">{displayValue()}</span>
    {/if}
</div>

<style>
    .table-data-cell {
        display: flex;
        align-items: center;
        background: var(--cell-bg, #ffffff);
        border-right: 1px solid var(--cell-border, #e2e8f0);
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        box-sizing: border-box;
        overflow: hidden;
        flex-shrink: 0;
        padding: 0 4px;
        font-size: 12px;
        color: var(--cell-text, #1e293b);
    }

    .table-data-cell:hover {
        background: var(--cell-hover, #f8fafc);
    }

    .cell-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* ── Inline checkbox ── */
    .checkbox-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        cursor: pointer;
    }

    .checkbox {
        width: 15px;
        height: 15px;
        border: 1px solid #ccc;
        border-radius: 2px;
        background: white;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
    }

    .checkbox.checked {
        background: #1a73e8;
        border-color: #1a73e8;
    }

    /* ── Inline rating ── */
    .rating-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 2px;
        cursor: pointer;
        width: 100%;
    }

    .star {
        font-size: 14px;
        color: #d1d5db;
        line-height: 1;
    }

    .star.active {
        color: #fbbc04;
    }
</style>
