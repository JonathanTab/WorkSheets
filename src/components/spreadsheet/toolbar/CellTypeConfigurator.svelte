<script>
    import { spreadsheetSession, selectionState } from "../../../stores/spreadsheetStore.svelte.js";
    import { date, checkbox, star, link, imageIcon } from "../../../lib/icons/index.js";
    import { DATE_PRESETS, TIME_PRESETS } from "../../../stores/spreadsheet/cellTypes/types/date.js";

    /**
     * Controlled mode: when both props are provided the component reads/writes
     * through these instead of the spreadsheet store.
     * @type {{ controlledConfig?: ({ type: string, [key: string]: any } | null), onControlledChange?: (((config: { type: string, [key: string]: any } | null) => void) | null) }}
     */
    let { controlledConfig = null, onControlledChange = null } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let selection = $derived(selectionState.range);

    let currentType = $state("text");
    /** @type {any} */
    let options = $state({});

    // Whether the current type is in the number family (number, currency, percent — legacy)
    let isNumberFamily = $derived(
        currentType === 'number' || currentType === 'currency' || currentType === 'percent'
    );

    // Effective sub-format considering legacy type IDs
    let subFormat = $derived(() => {
        if (options.subFormat) return options.subFormat;
        if (currentType === 'currency') return 'currency';
        if (currentType === 'percent') return 'percent';
        return 'default';
    });

    $effect(() => {
        // Controlled mode: read from external config prop (use onControlledChange presence as indicator,
        // since controlledConfig may legitimately be null for plain-text columns)
        if (onControlledChange !== null) {
            currentType = controlledConfig?.type || "text";
            options = controlledConfig
                ? Object.fromEntries(Object.entries(controlledConfig).filter(([key]) => key !== "type"))
                : {};
            return;
        }
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
            number: { subFormat: 'default', decimals: 2, thousandsSep: true, negativeStyle: 'minus' },
            date: { subFormat: 'date', datePreset: 'MM/DD/YYYY', timePreset: 'h:mm A' },
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
        // Controlled mode: delegate to parent
        if (onControlledChange) {
            onControlledChange(config);
            return;
        }
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

    // ── Number sub-format helpers ─────────────────────────────────────────────

    const SUB_FORMATS = [
        { id: 'default',    label: '123',   title: 'Number' },
        { id: 'currency',   label: '$',     title: 'Currency' },
        { id: 'accounting', label: '$()',   title: 'Accounting' },
        { id: 'financial',  label: '()',    title: 'Financial' },
        { id: 'percent',    label: '%',     title: 'Percent' },
        { id: 'scientific', label: '1ᴱ',   title: 'Scientific' },
    ];

    /** Switch number sub-format, migrating legacy currency/percent type IDs → number */
    function setSubFormat(sf) {
        if (!selection || !sheetStore) return;

        // Normalise to type:'number' — wipes legacy currency/percent type IDs
        const sym = options.symbol ?? '$';
        const decimals = options.decimals ?? 2;
        const thousandsSep = options.thousandsSep ?? (sf !== 'percent' && sf !== 'scientific');
        const negativeStyle = (sf === 'accounting' || sf === 'financial') ? 'parens' : (options.negativeStyle ?? 'minus');

        currentType = 'number';
        options = { subFormat: sf, decimals, thousandsSep, negativeStyle, symbol: sym, symbolAfter: options.symbolAfter ?? false };
        applyToSelection({ type: 'number', ...options });
    }

    function incrementDecimals() {
        const d = Math.min(10, (options.decimals ?? 2) + 1);
        updateOption('decimals', d);
        // Normalise type to number
        if (currentType !== 'number') { currentType = 'number'; }
        applyToSelection({ type: 'number', ...options });
    }

    function decrementDecimals() {
        const d = Math.max(0, (options.decimals ?? 2) - 1);
        updateOption('decimals', d);
        if (currentType !== 'number') { currentType = 'number'; }
        applyToSelection({ type: 'number', ...options });
    }

    function toggleThousands() {
        const next = !(options.thousandsSep ?? true);
        options.thousandsSep = next;
        if (currentType !== 'number') { currentType = 'number'; }
        applyToSelection({ type: 'number', ...options });
    }

    // ── Date/Time helpers ─────────────────────────────────────────────────────

    let isDateFamily = $derived(currentType === 'date');
    let dateSubFormat = $derived(/** @type {string} */ (options.subFormat || 'date'));

    /** Switch date sub-format, initialising missing presets with sensible defaults. */
    function setDateSubFormat(sf) {
        if (!selection || !sheetStore) return;
        const newOpts = {
            subFormat:   sf,
            datePreset:  options.datePreset  ?? 'MM/DD/YYYY',
            timePreset:  options.timePreset  ?? 'h:mm A',
        };
        options = newOpts;
        applyToSelection({ type: 'date', ...newOpts });
    }

    // ── Dropdown options management ───────────────────────────────────────────

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

    function updateDropdownTable(tableName, columnId) {
        options.tableName = tableName;
        options.columnId = columnId;
        const config = { type: currentType, ...options };
        applyToSelection(config);
    }

    let availableTables = $derived(() => spreadsheetSession.getAllTableDescriptors());

    let selectedTableColumns = $derived(() => {
        const t = availableTables().find(t => t.tableName === options.tableName);
        return t ? t.columns : [];
    });

    function useSelectionAsRange() {
        const sel = selectionState.range;
        if (!sel) return;
        const colLabel = (n) => {
            let s = ''; n++;
            while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
            return s;
        };
        const cellPart = `${colLabel(sel.startCol)}${sel.startRow + 1}:${colLabel(sel.endCol)}${sel.endRow + 1}`;
        const sheetName = spreadsheetSession.getSheetName(spreadsheetSession.activeSheetId);
        const needsQuotes = /[\s!']/.test(sheetName);
        const quotedName = needsQuotes ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
        updateDropdownRange(`${quotedName}!${cellPart}`);
    }

    const types = [
        { id: "automatic", label: "Automatic", icon: "✦" },
        { id: "text",      label: "Text",      icon: "abc" },
        { id: "number",    label: "Number",    icon: "123" },
        { id: "date",      label: "Date",      icon: date, isSvg: true },
        { id: "checkbox",  label: "Checkbox",  icon: checkbox, isSvg: true },
        { id: "rating",    label: "Rating",    icon: star, isSvg: true },
        { id: "url",       label: "Link",      icon: link, isSvg: true },
        { id: "image",     label: "Image",     icon: imageIcon, isSvg: true },
        { id: "file",      label: "File",      icon: "📎" },
        { id: "dropdown",  label: "Dropdown",  icon: "▾" },
    ];

    // Active type button — number family all map to 'number'
    let activeTypeId = $derived(isNumberFamily ? 'number' : currentType);
</script>

<div class="configurator">
    <div class="type-grid">
        {#each types as type}
            <button
                class="type-btn"
                class:active={activeTypeId === type.id}
                onclick={() => setType(type.id)}
                title={type.label}
            >
                <span class="icon">{#if type.isSvg}{@html type.icon}{:else}{type.icon}{/if}</span>
                <span class="label">{type.label}</span>
            </button>
        {/each}
    </div>

    <!-- ── Number options ──────────────────────────────────────────────────── -->
    {#if isNumberFamily}
        <div class="options-panel">

            <!-- Sub-format presets -->
            <div class="subformat-row">
                {#each SUB_FORMATS as sf}
                    <button
                        class="sf-btn"
                        class:active={subFormat() === sf.id}
                        onclick={() => setSubFormat(sf.id)}
                        title={sf.title}
                    >{sf.label}</button>
                {/each}
            </div>

            <!-- Decimals +/- and thousands toggle -->
            <div class="num-controls-row">
                <div class="decimals-group" title="Decimal places">
                    <button class="dec-btn" onclick={decrementDecimals} title="Fewer decimals">.0</button>
                    <span class="dec-value">{options.decimals ?? 2}</span>
                    <button class="dec-btn" onclick={incrementDecimals} title="More decimals">.00</button>
                </div>
                <button
                    class="toggle-btn"
                    class:active={options.thousandsSep ?? (subFormat() !== 'percent' && subFormat() !== 'scientific')}
                    onclick={toggleThousands}
                    title="Thousands separator"
                >,</button>
            </div>

            <!-- More options (less common) -->
            <details class="more-options">
                <summary>More options</summary>
                <div class="more-body">

                    {#if subFormat() === 'currency' || subFormat() === 'accounting'}
                        <div class="option-row">
                            <label>Symbol</label>
                            <div class="symbol-row">
                                <input
                                    type="text"
                                    class="symbol-input"
                                    value={options.symbol ?? '$'}
                                    onchange={(e) => updateOption('symbol', /** @type {HTMLInputElement} */(e.target).value)}
                                />
                                <label class="inline-label">
                                    <input
                                        type="checkbox"
                                        checked={options.symbolAfter ?? false}
                                        onchange={(e) => updateOption('symbolAfter', /** @type {HTMLInputElement} */(e.target).checked)}
                                    />
                                    After
                                </label>
                            </div>
                        </div>
                    {/if}

                    <div class="option-row">
                        <label>Negatives</label>
                        <select
                            value={options.negativeStyle ?? ((subFormat() === 'accounting' || subFormat() === 'financial') ? 'parens' : 'minus')}
                            onchange={(e) => updateOption('negativeStyle', /** @type {HTMLSelectElement} */(e.target).value)}
                        >
                            <option value="minus">−1,234</option>
                            <option value="parens">(1,234)</option>
                            <option value="red">Red −1,234</option>
                            <option value="redParens">Red (1,234)</option>
                        </select>
                    </div>
                </div>
            </details>
        </div>
    {/if}

    <!-- ── Date / Time options ───────────────────────────────────────────── -->
    {#if isDateFamily}
        <div class="options-panel">

            <!-- Sub-format tabs -->
            <div class="subformat-row">
                <button class="sf-btn" class:active={dateSubFormat === 'date'}
                    onclick={() => setDateSubFormat('date')} title="Date only">Date</button>
                <button class="sf-btn" class:active={dateSubFormat === 'time'}
                    onclick={() => setDateSubFormat('time')} title="Time only">Time</button>
                <button class="sf-btn" class:active={dateSubFormat === 'datetime'}
                    onclick={() => setDateSubFormat('datetime')} title="Date and time">Date+Time</button>
            </div>

            {#if dateSubFormat !== 'time'}
                <div class="preset-section-label">Date format</div>
                <div class="preset-grid">
                    {#each DATE_PRESETS as preset}
                        <button
                            class="preset-btn"
                            class:active={(options.datePreset ?? options.format ?? 'MM/DD/YYYY') === preset.id}
                            onclick={() => updateOption('datePreset', preset.id)}
                            title={preset.id}
                        >{preset.example}</button>
                    {/each}
                </div>
            {/if}

            {#if dateSubFormat !== 'date'}
                <div class="preset-section-label">Time format</div>
                <div class="preset-grid">
                    {#each TIME_PRESETS as preset}
                        <button
                            class="preset-btn"
                            class:active={(options.timePreset ?? 'h:mm A') === preset.id}
                            onclick={() => updateOption('timePreset', preset.id)}
                            title={preset.id}
                        >{preset.example}</button>
                    {/each}
                </div>
            {/if}

        </div>
    {/if}

    <!-- ── Dropdown options ──────────────────────────────────────────────── -->
    {#if currentType === "dropdown"}
        <div class="options-panel">
            <div class="option-row">
                <label>Source</label>
                <div class="source-toggle">
                    <button
                        class="source-btn"
                        class:active={options.source === 'list' || !options.source}
                        onclick={() => setDropdownSource('list')}
                    >List</button>
                    <button
                        class="source-btn"
                        class:active={options.source === 'range'}
                        onclick={() => setDropdownSource('range')}
                    >Range</button>
                    <button
                        class="source-btn"
                        class:active={options.source === 'table'}
                        onclick={() => setDropdownSource('table')}
                    >Table</button>
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
                            placeholder="e.g. A1:A10 or Sheet2!A1:A10"
                            onchange={(e) => updateDropdownRange(/** @type {HTMLInputElement} */(e.target).value.trim())}
                        />
                    </div>
                    <div class="range-hint">
                        <span class="hint-text">Select cells on the sheet, then:</span>
                        <button class="use-sel-btn" onclick={useSelectionAsRange}>Use selection</button>
                    </div>
                </div>
            {:else if options.source === 'table'}
                <div class="option-row">
                    <label for="dd-table-name">Table</label>
                    <select
                        id="dd-table-name"
                        value={options.tableName ?? ''}
                        onchange={(e) => updateDropdownTable(/** @type {HTMLSelectElement} */(e.target).value, options.columnId ?? '')}
                    >
                        <option value="">— select —</option>
                        {#each availableTables() as t}
                            <option value={t.tableName}>{t.tableName}{t.sheetName ? ` (${t.sheetName})` : ''}</option>
                        {/each}
                    </select>
                </div>
                <div class="option-row">
                    <label for="dd-table-col">Column</label>
                    <select
                        id="dd-table-col"
                        value={options.columnId ?? ''}
                        onchange={(e) => updateDropdownTable(options.tableName ?? '', /** @type {HTMLSelectElement} */(e.target).value)}
                    >
                        <option value="">— select —</option>
                        {#each selectedTableColumns() as col}
                            <option value={col.name}>{col.name}</option>
                        {/each}
                    </select>
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

            <div class="option-row" style="margin-top:6px">
                <label>Allow custom</label>
                <input
                    type="checkbox"
                    checked={options.allowCustom ?? false}
                    onchange={(e) => updateOption("allowCustom", /** @type {HTMLInputElement} */(e.target).checked)}
                />
            </div>

            <div class="option-row">
                <label>Validation</label>
                <select
                    value={options.validation ?? 'none'}
                    onchange={(e) => updateOption('validation', /** @type {HTMLSelectElement} */(e.target).value)}
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

    /* Sub-format preset row */
    .subformat-row {
        display: flex;
        gap: 3px;
        margin-bottom: 8px;
    }

    .sf-btn {
        flex: 1;
        padding: 4px 2px;
        border: 1px solid #e2e8f0;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.8rem;
        font-weight: 500;
        color: #374151;
        text-align: center;
        line-height: 1.2;
        min-width: 0;
    }

    .sf-btn:hover { background: #f8fafc; }

    .sf-btn.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }

    /* Decimals + thousands row */
    .num-controls-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }

    .decimals-group {
        display: flex;
        align-items: center;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        overflow: hidden;
    }

    .dec-btn {
        padding: 3px 8px;
        background: white;
        border: none;
        cursor: pointer;
        font-size: 0.8rem;
        color: #374151;
        font-family: monospace;
    }

    .dec-btn:hover { background: #f1f5f9; }

    .dec-value {
        padding: 3px 6px;
        font-size: 0.8rem;
        font-weight: 600;
        color: #1e293b;
        border-left: 1px solid #e2e8f0;
        border-right: 1px solid #e2e8f0;
        min-width: 22px;
        text-align: center;
    }

    .toggle-btn {
        padding: 3px 10px;
        border: 1px solid #e2e8f0;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9rem;
        font-weight: 600;
        color: #94a3b8;
    }

    .toggle-btn:hover { background: #f8fafc; }

    .toggle-btn.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }

    /* More options */
    .more-options {
        margin-top: 4px;
    }

    .more-options summary {
        font-size: 0.75rem;
        color: #64748b;
        cursor: pointer;
        user-select: none;
        padding: 2px 0;
        list-style: none;
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .more-options summary::before {
        content: '▸';
        font-size: 0.65rem;
        transition: transform 0.15s;
    }

    .more-options[open] summary::before {
        transform: rotate(90deg);
    }

    .more-body {
        margin-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .option-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.8125rem;
    }

    .option-row label {
        color: #374151;
        white-space: nowrap;
    }

    .option-row select {
        flex: 1;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
    }

    .option-row input[type="checkbox"] { width: 14px; height: 14px; }

    .symbol-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .symbol-input {
        width: 36px;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
        text-align: center;
    }

    .inline-label {
        display: flex;
        align-items: center;
        gap: 3px;
        font-size: 0.8125rem;
        color: #64748b;
        white-space: nowrap;
        cursor: pointer;
    }

    /* Dropdown options */
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

    .range-input {
        flex: 1;
        padding: 2px 6px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
        font-family: monospace;
    }

    .range-picker-section { margin-bottom: 4px; }

    .range-hint {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 4px;
        margin-bottom: 6px;
        font-size: 0.75rem;
    }

    .hint-text { color: #94a3b8; flex: 1; }

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

    .use-sel-btn:hover { background: #e2e8f0; }

    /* Date / time preset grid */
    .preset-section-label {
        font-size: 0.72rem;
        font-weight: 600;
        color: #94a3b8;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        margin: 6px 0 3px;
    }

    .preset-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 3px;
        margin-bottom: 4px;
        max-height: 180px;
        overflow-y: auto;
    }

    .preset-btn {
        padding: 4px 6px;
        border: 1px solid #e2e8f0;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.78rem;
        color: #374151;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
    }

    .preset-btn:hover { background: #f8fafc; }

    .preset-btn.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }
</style>
