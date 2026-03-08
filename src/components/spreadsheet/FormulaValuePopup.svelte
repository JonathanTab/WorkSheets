<script>
    import { spreadsheetSession } from "../../stores/spreadsheetStore.svelte.js";
    import { isError, FormulaError } from "../../formulas/functions.js";
    import { parseFormula } from "../../formulas/parser.js";
    import { evaluate } from "../../formulas/evaluator.js";

    let {
        formula = $bindable(""),
        visible = false,
        position = "below", // "below" or "above"
    } = $props();

    // Computed value from the formula
    let computedValue = $derived.by(() => {
        if (!formula || !formula.startsWith("=") || !visible) {
            return null;
        }

        try {
            // Use the formula engine to evaluate
            const engine = spreadsheetSession.formulaEngine;
            if (!engine) return null;

            // Create a getter that uses computed values for formula cells
            const getCellValue = (row, col) => {
                // First check if there's a computed value
                const computed = engine.getComputedValue(row, col);
                if (computed !== undefined) {
                    return computed;
                }
                // Fall back to cell display value
                return spreadsheetSession.getCellDisplayValue(row, col);
            };

            const ast = parseFormula(formula);
            if (!ast) return null;

            return evaluate(ast, getCellValue);
        } catch (err) {
            return FormulaError.ERROR;
        }
    });

    // Format the computed value for display
    let displayValue = $derived.by(() => {
        const value = computedValue;
        if (value === null || value === undefined) return "";

        if (isError(value)) {
            return value; // Return error as-is (#ERROR!, #REF!, etc.)
        }

        if (typeof value === "boolean") {
            return value ? "TRUE" : "FALSE";
        }

        if (typeof value === "number") {
            // Format numbers nicely
            if (Number.isInteger(value)) {
                return value.toString();
            }
            // Limit decimal places for display
            return value.toFixed(8).replace(/\.?0+$/, "");
        }

        if (Array.isArray(value)) {
            // Range result - show dimensions
            return `{${value.length}x${value[0]?.length || 0} array}`;
        }

        return String(value);
    });

    // Check if the value is an error
    let isErrorValue = $derived(isError(computedValue));

    // Check if we have a valid formula to evaluate
    let hasValidFormula = $derived(
        visible && formula && formula.startsWith("=") && formula.length > 1,
    );
</script>

{#if hasValidFormula}
    <div
        class="formula-value-popup"
        class:above={position === "above"}
        class:error={isErrorValue}
    >
        <span class="popup-label">Result:</span>
        <span class="popup-value">{displayValue}</span>
    </div>
{/if}

<style>
    .formula-value-popup {
        position: absolute;
        left: 0;
        top: 100%;
        margin-top: 4px;
        padding: 4px 8px;
        background: var(--popup-bg, #1e293b);
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        font-size: 0.75rem;
        color: var(--popup-text, #f1f5f9);
        white-space: nowrap;
        z-index: 100;
        display: flex;
        gap: 8px;
        align-items: center;
    }

    .formula-value-popup.above {
        top: auto;
        bottom: 100%;
        margin-top: 0;
        margin-bottom: 4px;
    }

    .popup-label {
        opacity: 0.7;
        font-weight: 500;
    }

    .popup-value {
        font-family: monospace;
        font-weight: 600;
    }

    .formula-value-popup.error .popup-value {
        color: #fca5a5;
    }
</style>
