<script>
    import {
        selectionState,
        spreadsheetSession,
    } from "../../stores/spreadsheetStore.svelte.js";

    /** compact — inline badge mode for mobile toolbar (no dropdown, just icon+value) */
    let { compact = false } = $props();

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

        // Read cellsVersion to establish dependency on cell changes (regular cells)
        sheetStore.cellsVersion;
        // Read tableVersion to establish dependency on table data changes
        spreadsheetSession.tableManager?.tableVersion;

        const { startRow, endRow, startCol, endCol } = selection;
        const numbers = [];

        // Collect all numeric values from selection
        for (let row = startRow; row <= endRow; row++) {
            for (let col = startCol; col <= endCol; col++) {
                const value = spreadsheetSession.renderContext?.getDisplayValue(
                    row,
                    col,
                );
                const numValue = parseDisplayValue(value);
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

    /**
     * Parse a display value (possibly formatted string) into a number.
     * Handles: plain numbers, currency symbols, thousands separators (comma/dot/space),
     * EU decimal comma, percent suffix, parenthesized negatives, scientific notation.
     */
    /** @param {any} value */
    function parseDisplayValue(value) {
        if (typeof value === "number") return isFinite(value) ? value : NaN;
        if (value == null) return NaN;

        let s = String(value).trim();
        if (s === "") return NaN;

        // Quick path: already a plain number
        const quick = Number(s);
        if (!isNaN(quick)) return quick;

        // Parenthesized negative: (1,234.56) or ($ 1,234.56)
        let negative = false;
        const parenMatch = s.match(/^\((.+?)\)\s*$/);
        if (parenMatch) {
            negative = true;
            s = parenMatch[1].trim();
        } else if (s.startsWith("-")) {
            negative = true;
            s = s.slice(1).trim();
        }

        // Strip percent suffix
        if (s.endsWith("%")) s = s.slice(0, -1).trim();

        // Strip everything except digits, . , E e + - (removes currency symbols, spaces, etc.)
        s = s.replace(/[^\d.,Ee\-+]/g, "");
        if (s === "") return NaN;

        // Normalize decimal vs thousands separators
        const lastDot = s.lastIndexOf(".");
        const lastComma = s.lastIndexOf(",");
        let normalized;
        if (lastDot >= 0 && lastComma >= 0) {
            // Both present: whichever comes last is the decimal separator
            if (lastDot > lastComma) {
                normalized = s.replace(/,/g, "");
            } else {
                normalized = s.replace(/\./g, "").replace(",", ".");
            }
        } else if (lastComma >= 0) {
            // Only commas: if exactly 3 digits follow the last comma it's a thousands sep
            const afterComma = s.slice(lastComma + 1);
            normalized = /^\d{3}$/.test(afterComma)
                ? s.replace(/,/g, "")
                : s.replace(",", ".");
        } else {
            normalized = s;
        }

        const num = parseFloat(normalized);
        if (isNaN(num)) return NaN;
        return negative ? -num : num;
    }

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

{#if compact}
    <!-- Compact badge for mobile toolbar -->
    {#if hasSelection && stats?.hasNumbers}
        <button
            class="stats-compact"
            onclick={toggleDropdown}
            title="Selection stats"
        >
            <span class="stats-icon">{displayIcon}</span>
            <span class="stats-value">{displayValue}</span>
        </button>
        {#if isOpen && stats}
            <div class="stats-dropdown stats-dropdown-compact">
                {#each ["sum", "average", "min", "max", "count"] as type}
                    <button
                        class="stats-option"
                        class:selected={selectedStat === type}
                        onclick={() => selectStat(type)}
                    >
                        <span class="option-icon">{getStatIcon(type)}</span>
                        <span class="option-label">{getStatLabel(type)}:</span>
                        <span class="option-value">{formatNumber(stats[type])}</span>
                    </button>
                {/each}
            </div>
        {/if}
    {/if}
{:else}

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

{/if}

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

    /* Compact mode for mobile toolbar */
    .stats-compact {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        padding: 4px 8px;
        height: 32px;
        background: var(--color-fill, #f1f5f9);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.8125rem;
        color: var(--color-text, #1e293b);
        position: relative;
    }

    .stats-compact:active {
        background: var(--color-border, #e2e8f0);
    }

    .stats-dropdown-compact {
        position: fixed;
        top: auto;
        bottom: auto;
        right: 8px;
        /* Positioned via JS would be better; for now anchor to top of viewport */
        top: 88px;
        z-index: 350;
    }
</style>
