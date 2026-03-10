<script>
    /**
     * TableDataCell - Renders a single data cell in a table row
     *
     * Gets its value from tableManager.getCellDisplayValue(row, col).
     * Applies conditional formatting from the column definition.
     */
    import { CellTypeRegistry } from "../../../stores/spreadsheet/cellTypes/index.js";
    import CheckboxCell from "../cellTypes/CheckboxCell.svelte";
    import RatingCell from "../cellTypes/RatingCell.svelte";

    let { table, colIndex, dataIndex, width = 80, height = 24 } = $props();

    let col = $derived(table?.columns?.[colIndex] ?? null);
    let rawValue = $derived(
        col && dataIndex >= 0 ? table?.getValue(dataIndex, col.id) : null,
    );

    let ct = $derived(col?.ct);
    let descriptor = $derived(ct ? CellTypeRegistry.get(ct.type) : null);
    let displayComp = $derived(descriptor?.getDisplayComponent?.());

    let displayValue = $derived(() => {
        if (rawValue == null) return "";
        if (ct) {
            return CellTypeRegistry.formatValue(ct, rawValue);
        }
        return String(rawValue);
    });

    function handleValueChange(newValue) {
        if (col && dataIndex >= 0) {
            table.setValue(dataIndex, col.id, newValue);
        }
    }

    // Evaluate conditional formats for this cell
    let condStyle = $derived.by(() => {
        if (!col?.conditionalFormats?.length || rawValue == null) return "";
        const s = [];
        for (const fmt of col.conditionalFormats) {
            if (matchesCondition(rawValue, fmt.condition, fmt.value)) {
                if (fmt.style?.backgroundColor)
                    s.push(`background-color:${fmt.style.backgroundColor}`);
                if (fmt.style?.color) s.push(`color:${fmt.style.color}`);
                if (fmt.style?.bold) s.push("font-weight:bold");
                break; // first matching format wins
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
    {#if displayComp?.component === "CheckboxCell"}
        <CheckboxCell
            value={!!rawValue}
            on:change={(e) => handleValueChange(e.detail)}
        />
    {:else if displayComp?.component === "RatingCell"}
        <RatingCell
            value={Number(rawValue || 0)}
            max={ct?.max || 5}
            on:change={(e) => handleValueChange(e.detail)}
        />
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
</style>
