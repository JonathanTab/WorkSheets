<script>
    import { spreadsheetSession, selectionState } from "../../../stores/spreadsheetStore.svelte.js";
    import { date, checkbox, star, link, imageIcon } from "../../../lib/icons/index.js";

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let selection = $derived(selectionState.range);

    let currentType = $state("text");
    /** @type {any} */
    let options = $state({});

    $effect(() => {
        // Synchronize state from sheet when selection changes or cell data changes.
        // Track rowMetaVersion and colMetaVersion so we re-read after row/col type changes.
        if (selection && sheetStore) {
            const _cellVer = sheetStore.cellsVersion;
            const _rowMetaVer = sheetStore.rowMetaVersion;
            const _colMetaVer = sheetStore.colMetaVersion;

            const config = sheetStore.getCellTypeConfig(
                selection.startRow,
                selection.startCol,
            );
            currentType = config?.type || "text";
            options = config
                ? Object.fromEntries(
                      Object.entries(config).filter(([key]) => key !== "type"),
                  )
                : {};
        }
    });

    function getDefaultOptionsForType(type) {
        const defaults = {
            automatic: {},
            text: {},
            number: { decimals: 2 },
            currency: { decimals: 2, symbol: "$" },
            percent: { decimals: 2 },
            date: {},
            rating: { max: 5 },
            checkbox: {},
            url: {},
            image: { fit: 'contain' },
            file: {},
            dropdown: { source: 'list', options: [], allowCustom: false, validation: 'none' },
        };
        return defaults[type] || {};
    }

    function setType(type) {
        if (!selection || !sheetStore) return;

        const newOptions = getDefaultOptionsForType(type);
        const config = { type, ...newOptions };

        currentType = type;
        options = newOptions;

        if (type === "text") {
            applyToSelection(null);
        } else {
            applyToSelection(config);
        }
    }

    function applyToSelection(config) {
        if (!selection || !sheetStore) return;
        // Delegate to the session-level handler (which respects row/col selection mode)
        // We call the toolbar handler via a synthetic event-like approach:
        // Actually, we apply directly here — the toolbar's handleCellTypeChange is separate.
        // CellTypeConfigurator applies to the cell range directly.
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

    // Dropdown options management
    let dropdownOptionInput = $state('');
    function addDropdownOption() {
        const val = dropdownOptionInput.trim();
        if (!val) return;
        const current = options.options || [];
        updateOption('options', [...current, val]);
        dropdownOptionInput = '';
    }
    function removeDropdownOption(idx) {
        const current = [...(options.options || [])];
        current.splice(idx, 1);
        updateOption('options', current);
    }

    function setDropdownSource(src) {
        options.source = src;
        const config = { type: currentType, ...options };
        applyToSelection(config);
    }

    function updateDropdownRange(rangeStr) {
        options.range = rangeStr;
        const config = { type: currentType, ...options };
        applyToSelection(config);
    }

    // Range picker: use current grid selection as the dropdown source range
    function useSelectionAsRange() {
        const sel = selectionState.range;
        if (!sel) return;
        const colLabel = (n) => {
            let s = ''; n++;
            while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
            return s;
        };
        const rangeStr = `${colLabel(sel.startCol)}${sel.startRow + 1}:${colLabel(sel.endCol)}${sel.endRow + 1}`;
        updateDropdownRange(rangeStr);
    }

    const types = [
        { id: "automatic", label: "Automatic", icon: "✦" },
        { id: "text",      label: "Text",      icon: "abc" },
        { id: "number",    label: "Number",    icon: "123" },
        { id: "currency",  label: "Currency",  icon: "$" },
        { id: "percent",   label: "Percent",   icon: "%" },
        { id: "date",      label: "Date",      icon: date, isSvg: true },
        { id: "checkbox",  label: "Checkbox",  icon: checkbox, isSvg: true },
        { id: "rating",    label: "Rating",    icon: star, isSvg: true },
        { id: "url",       label: "Link",      icon: link, isSvg: true },
        { id: "image",     label: "Image",     icon: imageIcon, isSvg: true },
        { id: "file",      label: "File",      icon: "📎" },
        { id: "dropdown",  label: "Dropdown",  icon: "▾" },
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
                <span class="icon"
                    >{#if type.isSvg}{@html type.icon}{:else}{type.icon}{/if}</span
                >
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
                        const target = /** @type {HTMLInputElement} */ (e.target);
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
                        const target = /** @type {HTMLInputElement} */ (e.target);
                        updateOption("symbol", target.value);
                    }}
                />
            </div>
        </div>
    {/if}

    {#if currentType === "dropdown"}
        <div class="options-panel">
            <!-- Source toggle: List vs Range -->
            <div class="option-row">
                <label>Source</label>
                <div class="source-toggle">
                    <button
                        class="source-btn"
                        class:active={!(options.source === 'range')}
                        onclick={() => setDropdownSource('list')}
                    >List</button>
                    <button
                        class="source-btn"
                        class:active={options.source === 'range'}
                        onclick={() => setDropdownSource('range')}
                    >Range</button>
                </div>
            </div>

            {#if options.source === 'range'}
                <div class="range-picker-section">
                    <div class="option-row">
                        <label>Range</label>
                        <input
                            type="text"
                            class="range-input"
                            value={options.range ?? ''}
                            placeholder="e.g. A1:A10"
                            onchange={(e) => {
                                const target = /** @type {HTMLInputElement} */ (e.target);
                                updateDropdownRange(target.value.trim());
                            }}
                        />
                    </div>
                    <div class="range-hint">
                        <span class="hint-text">Select cells on the sheet, then:</span>
                        <button class="use-sel-btn" onclick={useSelectionAsRange}>
                            Use selection
                        </button>
                    </div>
                </div>
            {:else}
                <div class="dropdown-list-label">Options</div>
                <div class="dropdown-options">
                    {#each (options.options || []) as opt, idx}
                        <div class="dropdown-option-row">
                            <span class="opt-label">{opt}</span>
                            <button class="opt-del" onclick={() => removeDropdownOption(idx)}>✕</button>
                        </div>
                    {/each}
                    {#if !(options.options?.length)}
                        <div class="opt-empty">No options yet.</div>
                    {/if}
                </div>
                <div class="dropdown-add-row">
                    <input
                        type="text"
                        bind:value={dropdownOptionInput}
                        placeholder="Add option..."
                        onkeydown={(e) => { if (e.key === 'Enter') { addDropdownOption(); e.preventDefault(); } }}
                    />
                    <button onclick={addDropdownOption}>+</button>
                </div>
            {/if}

            <!-- Allow custom entry -->
            <div class="option-row" style="margin-top:6px">
                <label>Allow custom</label>
                <input
                    type="checkbox"
                    checked={options.allowCustom ?? false}
                    onchange={(e) => {
                        const target = /** @type {HTMLInputElement} */ (e.target);
                        updateOption("allowCustom", target.checked);
                    }}
                />
            </div>

            <!-- Validation -->
            <div class="option-row">
                <label>Validation</label>
                <select
                    value={options.validation ?? 'none'}
                    onchange={(e) => {
                        const target = /** @type {HTMLSelectElement} */ (e.target);
                        updateOption('validation', target.value);
                    }}
                >
                    <option value="none">None</option>
                    <option value="soft">Warn</option>
                    <option value="hard">Reject</option>
                </select>
            </div>
        </div>
    {/if}
</div>

<style>
    .configurator {
        padding: 8px;
        min-width: 220px;
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

    .type-btn:hover { background: #f8fafc; }

    .type-btn.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }

    .icon {
        font-weight: bold;
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
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
        margin-bottom: 4px;
    }

    .option-row input[type="number"],
    .option-row input[type="text"] {
        width: 60px;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 2px;
    }

    .option-row input[type="checkbox"] { width: 16px; height: 16px; }

    .dropdown-list-label {
        font-size: 0.75rem;
        color: #64748b;
        margin: 6px 0 4px;
        font-weight: 500;
    }

    .dropdown-options {
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        max-height: 120px;
        overflow-y: auto;
        margin-bottom: 6px;
    }

    .dropdown-option-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 3px 6px;
        border-bottom: 1px solid #f1f5f9;
        font-size: 0.8125rem;
    }

    .dropdown-option-row:last-child { border-bottom: none; }

    .opt-label { flex: 1; color: #374151; }

    .opt-del {
        background: none; border: none; cursor: pointer;
        color: #ef4444; padding: 0 2px; font-size: 0.75rem;
    }

    .opt-empty {
        padding: 6px 8px;
        color: #94a3b8;
        font-size: 0.75rem;
        font-style: italic;
    }

    .dropdown-add-row {
        display: flex;
        gap: 4px;
    }

    .dropdown-add-row input {
        flex: 1;
        padding: 3px 6px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
    }

    .dropdown-add-row button {
        padding: 3px 8px;
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 1rem;
        line-height: 1;
    }

    .source-toggle {
        display: flex;
        gap: 2px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        overflow: hidden;
    }

    .source-btn {
        flex: 1;
        padding: 2px 8px;
        background: white;
        border: none;
        cursor: pointer;
        font-size: 0.8125rem;
        color: #64748b;
    }

    .source-btn.active {
        background: #eff6ff;
        color: #1d4ed8;
        font-weight: 500;
    }

    .option-row select {
        flex: 1;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
    }

    .range-input {
        flex: 1;
        padding: 2px 6px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
        font-family: monospace;
    }

    .range-picker-section {
        margin-bottom: 4px;
    }

    .range-hint {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 4px;
        margin-bottom: 6px;
        font-size: 0.75rem;
    }

    .hint-text {
        color: #94a3b8;
        flex: 1;
    }

    .use-sel-btn {
        padding: 2px 7px;
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        cursor: pointer;
        font-size: 0.75rem;
        color: #374151;
        white-space: nowrap;
    }

    .use-sel-btn:hover {
        background: #e2e8f0;
    }
</style>
