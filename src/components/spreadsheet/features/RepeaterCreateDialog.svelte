<script>
    /**
     * RepeaterCreateDialog - Inline dialog for creating a repeater from selection
     *
     * Appears as a small overlay near the selection. User can configure:
     * - Repeater name
     * - Direction (vertical/horizontal)
     * - Count (number of repetitions)
     * - Gap between repetitions
     * - Mode (inline/viewport)
     */

    import {
        spreadsheetSession,
        selectionState,
    } from "../../../stores/spreadsheetStore.svelte.js";

    let { onClose = () => {} } = $props();

    // Get selection bounds
    let selection = $derived(selectionState.range);

    // Form state
    let repeaterName = $state("Repeater1");
    let direction = $state("vertical"); // 'vertical' | 'horizontal'
    let count = $state(3);
    let gap = $state(0);

    // Selection dimensions
    let templateRows = $derived(
        selection ? selection.endRow - selection.startRow + 1 : 0,
    );
    let templateCols = $derived(
        selection ? selection.endCol - selection.startCol + 1 : 0,
    );

    // Position the dialog near the selection with boundary detection
    let dialogStyle = $derived.by(() => {
        if (!selection) return "";

        const dialogWidth = 320;
        const dialogHeight = 380;
        const margin = 16;

        // Calculate initial position (below the selection)
        let top = (selection.endRow + 2) * 24 + 30;
        let left = selection.startCol * 80 + 50;

        // Clamp to viewport bounds
        const maxX = window.innerWidth - dialogWidth - margin;
        const maxY = window.innerHeight - dialogHeight - margin;

        // Check right edge
        if (left > maxX) {
            left = maxX;
        }
        // Check left edge
        if (left < margin) {
            left = margin;
        }
        // Check bottom edge - if would go off screen, position above selection instead
        if (top > maxY) {
            top = selection.startRow * 24 - dialogHeight - margin;
            // If still off screen, clamp to top
            if (top < margin) {
                top = margin;
            }
        }

        return `position: fixed; top: ${Math.round(top)}px; left: ${Math.round(left)}px; z-index: 1000;`;
    });

    // Generate repeater number
    let repeaterNumber = $derived.by(() => {
        const re = spreadsheetSession.repeaterEngine;
        if (!re) return 1;
        return re.storeList.length + 1;
    });

    // Initialize repeater name
    $effect(() => {
        repeaterName = `Repeater${repeaterNumber}`;
    });

    function handleCreate() {
        if (!selection || !spreadsheetSession.repeaterEngine) return;

        spreadsheetSession.repeaterEngine.createRepeater({
            name: repeaterName,
            templateStartRow: selection.startRow,
            templateEndRow: selection.endRow,
            templateStartCol: selection.startCol,
            templateEndCol: selection.endCol,
            direction: direction,
            count: count,
            gap: gap,
        });

        onClose();
    }

    function handleCancel() {
        onClose();
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            onClose();
        } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleCreate();
        }
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if selection}
    <div class="dialog-overlay" onclick={handleCancel}>
        <div
            class="dialog"
            style={dialogStyle}
            onclick={(e) => e.stopPropagation()}
        >
            <div class="dialog-header">
                <span class="dialog-title">Create Repeater</span>
            </div>

            <div class="dialog-body">
                <div class="form-row">
                    <label for="repeater-name">Name</label>
                    <input
                        id="repeater-name"
                        type="text"
                        bind:value={repeaterName}
                        placeholder="Repeater name"
                    />
                </div>

                <div class="form-row">
                    <label>Direction</label>
                    <div class="toggle-group">
                        <button
                            class="toggle-btn"
                            class:active={direction === "vertical"}
                            onclick={() => (direction = "vertical")}
                        >
                            ↓ Vertical
                        </button>
                        <button
                            class="toggle-btn"
                            class:active={direction === "horizontal"}
                            onclick={() => (direction = "horizontal")}
                        >
                            → Horizontal
                        </button>
                    </div>
                </div>

                <div class="form-row">
                    <label for="count">Repetitions</label>
                    <div class="number-input">
                        <button
                            class="num-btn"
                            onclick={() => (count = Math.max(1, count - 1))}
                        >
                            −
                        </button>
                        <input
                            id="count"
                            type="number"
                            bind:value={count}
                            min="1"
                            max="100"
                        />
                        <button
                            class="num-btn"
                            onclick={() => (count = Math.min(100, count + 1))}
                        >
                            +
                        </button>
                    </div>
                </div>

                <div class="form-row">
                    <label for="gap">Gap (rows/cols between)</label>
                    <div class="number-input">
                        <button
                            class="num-btn"
                            onclick={() => (gap = Math.max(0, gap - 1))}
                        >
                            −
                        </button>
                        <input
                            id="gap"
                            type="number"
                            bind:value={gap}
                            min="0"
                            max="50"
                        />
                        <button
                            class="num-btn"
                            onclick={() => (gap = Math.min(50, gap + 1))}
                        >
                            +
                        </button>
                    </div>
                </div>

                <div class="template-info">
                    <span class="info-label">Template:</span>
                    <span class="info-value"
                        >{templateRows}×{templateCols} cells</span
                    >
                </div>
            </div>

            <div class="dialog-footer">
                <button class="btn btn-secondary" onclick={handleCancel}>
                    Cancel
                </button>
                <button
                    class="btn btn-primary"
                    onclick={handleCreate}
                    disabled={!repeaterName.trim() || count < 1}
                >
                    Create
                </button>
            </div>
        </div>
    </div>
{/if}

<style>
    .dialog-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.1);
        z-index: 999;
    }

    .dialog {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        min-width: 280px;
        max-width: 320px;
    }

    .dialog-header {
        padding: 12px 16px;
        border-bottom: 1px solid var(--color-border);
    }

    .dialog-title {
        font-weight: 600;
        font-size: 0.875rem;
        color: var(--color-text);
    }

    .dialog-body {
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .form-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .form-row label {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        font-weight: 500;
    }

    .form-row input[type="text"] {
        height: 32px;
        padding: 0 8px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        font-size: 0.8125rem;
        background: var(--color-surface);
        color: var(--color-text);
    }

    .form-row input[type="text"]:focus {
        outline: none;
        border-color: var(--color-primary);
    }

    .toggle-group {
        display: flex;
        gap: 2px;
    }

    .toggle-btn {
        flex: 1;
        height: 28px;
        padding: 0 12px;
        border: 1px solid var(--color-border);
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 0.75rem;
        cursor: pointer;
        transition: all 0.15s;
    }

    .toggle-btn:first-child {
        border-radius: 4px 0 0 4px;
    }

    .toggle-btn:last-child {
        border-radius: 0 4px 4px 0;
    }

    .toggle-btn.active {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
    }

    .toggle-btn:hover:not(.active) {
        background: var(--color-fill);
    }

    .number-input {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .number-input input[type="number"] {
        flex: 1;
        height: 32px;
        padding: 0 8px;
        border: 1px solid var(--color-border);
        border-radius: 0;
        font-size: 0.8125rem;
        text-align: center;
        background: var(--color-surface);
        color: var(--color-text);
        -moz-appearance: textfield;
    }

    .number-input input[type="number"]::-webkit-inner-spin-button,
    .number-input input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }

    .num-btn {
        width: 32px;
        height: 32px;
        border: 1px solid var(--color-border);
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 1rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .num-btn:first-child {
        border-radius: 4px 0 0 4px;
    }

    .num-btn:last-child {
        border-radius: 0 4px 4px 0;
    }

    .num-btn:hover {
        background: var(--color-fill);
    }

    .template-info {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        background: var(--color-fill);
        border-radius: 4px;
        font-size: 0.75rem;
    }

    .info-label {
        color: var(--color-text-secondary);
    }

    .info-value {
        color: var(--color-text);
        font-weight: 500;
    }

    .dialog-footer {
        padding: 12px 16px;
        border-top: 1px solid var(--color-border);
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }

    .btn {
        height: 32px;
        padding: 0 16px;
        border: none;
        border-radius: 4px;
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
    }

    .btn-primary {
        background: var(--color-primary);
        color: white;
    }

    .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
    }

    .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .btn-secondary {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .btn-secondary:hover {
        background: var(--color-fill-hover);
    }
</style>
