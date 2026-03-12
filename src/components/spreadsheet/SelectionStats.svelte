<script>
    import {
        selectionState,
        spreadsheetSession,
    } from "../../stores/spreadsheetStore.svelte.js";

    // Dropdown state
    let isOpen = $state(false);
    let selectedStat = $state("sum"); // 'sum', 'average', 'min', 'max', 'count'

    // Get current selection - use effectiveRange to support all selection modes
    // (range, rows, cols, all) instead of just 'range' mode
    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let selection = $derived.by(() => {
        const rowCount = sheetStore?.rowCount;
        const colCount = sheetStore?.colCount;
        if (!rowCount || !colCount) return null;

        // IMPORTANT: Explicitly read reactive state to establish dependency tracking.
        // effectiveRange() is a regular method, so Svelte won't auto-track its internal reads.
        const mode = selectionState.selectionMode;
        const anchor = selectionState.anchor;
        const focus = selectionState.focus;
        const range = selectionState.range;
        const selectedRows = selectionState.selectedRows;
        const selectedCols = selectionState.selectedCols;

        // Now call effectiveRange - dependencies are tracked above
        return selectionState.effectiveRange(rowCount, colCount);
    });

    // Calculate stats from selection
    let stats = $derived.by(() => {
        if (!selection || !sheetStore) {
            return null;
        }

        // Read cellsVersion to establish dependency on cell changes
        sheetStore.cellsVersion;

        const { startRow, endRow, startCol, endCol } = selection;
        const numbers = [];

        // Collect all numeric values from selection
        for (let row = startRow; row <= endRow; row++) {
            for (let col = startCol; col <= endCol; col++) {
                const value = spreadsheetSession.renderContext?.getDisplayValue(
                    row,
                    col,
                );
                // Handle both numbers and numeric strings
                let numValue;
                if (typeof value === "number") {
                    numValue = value;
                } else if (typeof value === "string" && value.trim() !== "") {
                    numValue = parseFloat(value);
                } else {
                    numValue = NaN;
                }
                if (!isNaN(numValue)) {
                    numbers.push(numValue);
                }
            }
        }

        if (numbers.length === 0) {
            return {
                sum: 0,
                average: 0,
                min: 0,
                max: 0,
                count: 0,
                hasNumbers: false,
            };
        }

        const sum = numbers.reduce((a, b) => a + b, 0);
        const count = numbers.length;
        const average = sum / count;
        const min = Math.min(...numbers);
        const max = Math.max(...numbers);

        return { sum, average, min, max, count, hasNumbers: true };
    });

    // Has active selection
    let hasSelection = $derived(selection !== null);

    // Format number for display
    function formatNumber(num) {
        if (num === null || num === undefined) return "-";
        if (Math.abs(num) >= 1000000) {
            return (num / 1000000).toFixed(2) + "M";
        }
        if (Math.abs(num) >= 1000) {
            return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
        }
        // Show up to 2 decimal places for smaller numbers
        return Number.isInteger(num) ? String(num) : num.toFixed(2);
    }

    // Get display label for stat type
    function getStatLabel(type) {
        switch (type) {
            case "sum":
                return "Sum";
            case "average":
                return "Average";
            case "min":
                return "Min";
            case "max":
                return "Max";
            case "count":
                return "Count";
            default:
                return type;
        }
    }

    // Get icon for stat type
    function getStatIcon(type) {
        switch (type) {
            case "sum":
                return "Σ";
            case "average":
                return "μ";
            case "min":
                return "↓";
            case "max":
                return "↑";
            case "count":
                return "#";
            default:
                return "";
        }
    }

    // Get current display value
    let displayValue = $derived(
        stats ? formatNumber(stats[selectedStat]) : "-",
    );
    let displayIcon = $derived(getStatIcon(selectedStat));

    // Toggle dropdown
    function toggleDropdown() {
        if (hasSelection && stats?.hasNumbers) {
            isOpen = !isOpen;
        }
    }

    // Select a stat
    function selectStat(type) {
        selectedStat = type;
        isOpen = false;
    }

    // Close dropdown when clicking outside
    function handleClickOutside(e) {
        if (!e.target.closest(".selection-stats")) {
            isOpen = false;
        }
    }
</script>

<svelte:window onclick={handleClickOutside} />

<div
    class="selection-stats"
    class:active={hasSelection && stats?.hasNumbers}
    class:open={isOpen}
>
    <button
        class="stats-trigger"
        onclick={toggleDropdown}
        disabled={!hasSelection || !stats?.hasNumbers}
        title={hasSelection
            ? "Click to see more statistics"
            : "Select cells to see statistics"}
    >
        <span class="stats-icon">{displayIcon}</span>
        <span class="stats-value">{displayValue}</span>
        {#if hasSelection && stats?.hasNumbers}
            <span class="dropdown-arrow" class:rotated={isOpen}>▼</span>
        {/if}
    </button>

    {#if isOpen && stats}
        <div class="stats-dropdown">
            {#each ["sum", "average", "min", "max", "count"] as type}
                <button
                    class="stats-option"
                    class:selected={selectedStat === type}
                    onclick={() => selectStat(type)}
                >
                    <span class="option-icon">{getStatIcon(type)}</span>
                    <span class="option-label">{getStatLabel(type)}:</span>
                    <span class="option-value">{formatNumber(stats[type])}</span
                    >
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .selection-stats {
        position: relative;
        display: flex;
        align-items: center;
    }

    .stats-trigger {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.25rem 0.5rem;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: default;
        font-size: 0.8125rem;
        color: var(--text-muted, #94a3b8);
        transition: all 0.15s;
    }

    .selection-stats.active .stats-trigger {
        cursor: pointer;
        color: var(--text-color, #1e293b);
    }

    .selection-stats.active .stats-trigger:hover {
        background: var(--hover-bg, #e2e8f0);
    }

    .stats-trigger:disabled {
        opacity: 0.5;
    }

    .stats-icon {
        font-weight: 600;
        color: var(--primary-color, #3b82f6);
    }

    .stats-value {
        font-family: monospace;
        min-width: 3ch;
    }

    .dropdown-arrow {
        font-size: 0.625rem;
        transition: transform 0.15s;
    }

    .dropdown-arrow.rotated {
        transform: rotate(180deg);
    }

    .stats-dropdown {
        position: absolute;
        bottom: 100%;
        right: 0;
        margin-bottom: 4px;
        background: var(--dropdown-bg, #ffffff);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        min-width: 160px;
        z-index: 100;
        overflow: hidden;
    }

    .stats-option {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.75rem;
        background: transparent;
        border: none;
        font-size: 0.8125rem;
        color: var(--text-color, #1e293b);
        cursor: pointer;
        text-align: left;
        transition: background 0.1s;
    }

    .stats-option:hover {
        background: var(--hover-bg, #f1f5f9);
    }

    .stats-option.selected {
        background: var(--selected-bg, #eff6ff);
        color: var(--primary-color, #3b82f6);
    }

    .option-icon {
        width: 1rem;
        text-align: center;
        font-weight: 600;
    }

    .option-label {
        flex: 1;
    }

    .option-value {
        font-family: monospace;
        font-weight: 500;
    }
</style>
