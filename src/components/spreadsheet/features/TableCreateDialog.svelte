<script>
    /**
     * TableCreateDialog - Inline dialog for creating a new table from selection
     *
     * Appears as a small overlay near the selection. User can configure:
     * - Table name
     * - Mode (inline/viewport)
     * - Column names (auto-filled from selection)
     * - Whether first row is header
     */

    import {
        spreadsheetSession,
        selectionState,
    } from "../../../stores/spreadsheetStore.svelte.js";

    let { onClose = () => {} } = $props();

    // Get selection bounds
    let selection = $derived(selectionState.range);

    // Form state
    let tableName = $state("Table1");
    let hasHeaderRow = $state(true);

    // Column definitions derived from selection
    let columnCount = $derived(
        selection ? selection.endCol - selection.startCol + 1 : 0,
    );
    let rowCount = $derived(
        selection ? selection.endRow - selection.startRow + 1 : 0,
    );

    // Auto-generate column names (A, B, C... or from header row)
    let columnNames = $derived.by(() => {
        if (!selection) return [];
        const names = [];
        for (let i = 0; i < columnCount; i++) {
            if (hasHeaderRow && spreadsheetSession.activeSheetStore) {
                // Get value from first row as column name
                const cell = spreadsheetSession.activeSheetStore.getCell(
                    selection.startRow,
                    selection.startCol + i,
                );
                names.push(cell?.v || colLetter(i));
            } else {
                names.push(colLetter(i));
            }
        }
        return names;
    });

    function colLetter(index) {
        let letter = "";
        let i = index;
        while (i >= 0) {
            letter = String.fromCharCode(65 + (i % 26)) + letter;
            i = Math.floor(i / 26) - 1;
        }
        return letter;
    }

    // Position the dialog near the selection with boundary detection
    let dialogStyle = $derived.by(() => {
        if (!selection) return "";

        const dialogWidth = 320;
        const dialogHeight = 300;
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

    // Generate table number
    let tableNumber = $derived.by(() => {
        const tm = spreadsheetSession.tableManager;
        if (!tm) return 1;
        return tm.tableList.length + 1;
    });

    // Initialize table name
    $effect(() => {
        tableName = `Table${tableNumber}`;
    });

    function handleCreate() {
        if (!selection || !spreadsheetSession.tableManager) return;

        const columns = columnNames.map((name, i) => ({
            id: `col${i}`,
            name: name,
            type: "text",
            required: false,
        }));

        // For inline mode: header row is at selection start (or start+1 if has header data)
        // For viewport mode: the selection rect IS the table viewport
        const startRow = hasHeaderRow ? selection.startRow : selection.startRow;
        const startCol = selection.startCol;

        spreadsheetSession.tableManager.createTable({
            name: tableName,
            startRow: startRow,
            startCol: startCol,
            columns: columns,
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
                <span class="dialog-title">Create Table</span>
            </div>

            <div class="dialog-body">
                <div class="form-row">
                    <label for="table-name">Name</label>
                    <input
                        id="table-name"
                        type="text"
                        bind:value={tableName}
                        placeholder="Table name"
                    />
                </div>

                <div class="form-row">
                    <label class="checkbox-label">
                        <input
                            type="checkbox"
                            bind:checked={hasHeaderRow}
                            disabled={rowCount < 2}
                        />
                        First row is header
                    </label>
                </div>

                <div class="form-row columns-preview">
                    <label>Columns ({columnCount})</label>
                    <div class="columns-list">
                        {#each columnNames as name, i}
                            <span class="column-chip">{name}</span>
                        {/each}
                    </div>
                </div>
            </div>

            <div class="dialog-footer">
                <button class="btn btn-secondary" onclick={handleCancel}>
                    Cancel
                </button>
                <button
                    class="btn btn-primary"
                    onclick={handleCreate}
                    disabled={!tableName.trim() || columnCount < 1}
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

    .checkbox-label {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        font-size: 0.8125rem;
        color: var(--color-text);
    }

    .checkbox-label input[type="checkbox"] {
        width: 16px;
        height: 16px;
        cursor: pointer;
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

    .columns-preview {
        margin-top: 4px;
    }

    .columns-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
    }

    .column-chip {
        padding: 2px 8px;
        background: var(--color-fill);
        border-radius: 10px;
        font-size: 0.6875rem;
        color: var(--color-text-secondary);
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
