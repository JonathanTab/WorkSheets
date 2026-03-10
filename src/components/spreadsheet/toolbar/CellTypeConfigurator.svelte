<script>
    import { spreadsheetSession } from "../../../stores/spreadsheetStore.svelte.js";
    import { CellTypeRegistry } from "../../../stores/spreadsheet/cellTypes/index.js";

    let { selectionState } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let selection = $derived(selectionState.range);

    let currentType = $state("text");
    /** @type {any} */
    let options = $state({});

    $effect(() => {
        if (selection && sheetStore) {
            const config = sheetStore.getCellTypeConfig(
                selection.startRow,
                selection.startCol,
            );
            currentType = config?.type || "text";
            options = config ? { ...config } : {};
        }
    });

    function setType(type) {
        if (!selection || !sheetStore) return;

        const config = { type, ...options };
        if (type === "text") {
            // Special case to clear config if it's default text
            applyToSelection(null);
        } else {
            applyToSelection(config);
        }
    }

    function applyToSelection(config) {
        if (!selection || !sheetStore) return;

        spreadsheetSession.ydoc.transact(() => {
            for (let r = selection.startRow; r <= selection.endRow; r++) {
                for (let c = selection.startCol; c <= selection.endCol; c++) {
                    sheetStore.setCellTypeConfig(r, c, config);
                }
            }
        });
    }

    function updateOption(key, value) {
        options[key] = value;
        const config = { type: currentType, ...options };
        applyToSelection(config);
    }

    const types = [
        { id: "text", label: "Text", icon: "abc" },
        { id: "number", label: "Number", icon: "123" },
        { id: "currency", label: "Currency", icon: "$" },
        { id: "percent", label: "Percent", icon: "%" },
        { id: "date", label: "Date", icon: "📅" },
        { id: "checkbox", label: "Checkbox", icon: "☑" },
        { id: "rating", label: "Rating", icon: "⭐" },
        { id: "url", label: "Link", icon: "🔗" },
    ];
</script>

<div class="configurator">
    <div class="type-grid">
        {#each types as type}
            <button
                class="type-btn"
                class:active={currentType === type.id}
                onclick={() => setType(type.id)}
                title={type.label}
            >
                <span class="icon">{type.icon}</span>
                <span class="label">{type.label}</span>
            </button>
        {/each}
    </div>

    {#if currentType === "number" || currentType === "currency" || currentType === "percent"}
        <div class="options-panel">
            <div class="option-row">
                <label for="decimals">Decimals</label>
                <input
                    id="decimals"
                    type="number"
                    min="0"
                    max="10"
                    value={options.decimals ?? 2}
                    onchange={(e) => {
                        const target = /** @type {HTMLInputElement} */ (
                            e.target
                        );
                        updateOption("decimals", parseInt(target.value));
                    }}
                />
            </div>
        </div>
    {/if}

    {#if currentType === "currency"}
        <div class="options-panel">
            <div class="option-row">
                <label for="symbol">Symbol</label>
                <input
                    id="symbol"
                    type="text"
                    value={options.symbol ?? "$"}
                    onchange={(e) => {
                        const target = /** @type {HTMLInputElement} */ (
                            e.target
                        );
                        updateOption("symbol", target.value);
                    }}
                />
            </div>
        </div>
    {/if}
</div>

<style>
    .configurator {
        padding: 8px;
        min-width: 200px;
        background: white;
        border-radius: 4px;
    }

    .type-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 4px;
        margin-bottom: 8px;
    }

    .type-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border: 1px solid #e2e8f0;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
        text-align: left;
    }

    .type-btn:hover {
        background: #f8fafc;
    }

    .type-btn.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }

    .icon {
        font-weight: bold;
        width: 16px;
        display: inline-block;
        text-align: center;
    }

    .options-panel {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #e2e8f0;
    }

    .option-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.8125rem;
    }

    .option-row input {
        width: 60px;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 2px;
    }
</style>
