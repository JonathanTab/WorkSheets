<script>
    /**
     * DropdownConfigPanel — options panel for the dropdown cell type.
     */
    import { spreadsheetSession, selectionState } from '../../../../stores/spreadsheetStore.svelte.js';

    /** @type {{ options: Record<string,any>, onUpdate: (config: Record<string,any>) => void }} */
    let { options, onUpdate } = $props();

    let dropdownOptionInput = $state('');

    let availableTables = $derived(() => spreadsheetSession.getAllTableDescriptors());

    let selectedTableColumns = $derived(() => {
        const t = availableTables().find(t => t.tableName === options.tableName);
        return t ? t.columns : [];
    });

    function setSource(src) {
        onUpdate({ type: 'dropdown', ...options, source: src });
    }

    function updateRange(rangeStr) {
        onUpdate({ type: 'dropdown', ...options, range: rangeStr });
    }

    function updateTable(tableName, columnId) {
        onUpdate({ type: 'dropdown', ...options, tableName, columnId });
    }

    function addOption() {
        const val = dropdownOptionInput.trim();
        if (!val) return;
        onUpdate({ type: 'dropdown', ...options, options: [...(options.options || []), val] });
        dropdownOptionInput = '';
    }

    function removeOption(idx) {
        const list = [...(options.options || [])];
        list.splice(idx, 1);
        onUpdate({ type: 'dropdown', ...options, options: list });
    }

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
        updateRange(`${quotedName}!${cellPart}`);
    }
</script>

<div class="options-panel">
    <div class="option-row">
        <label>Source</label>
        <div class="source-toggle">
            <button class="source-btn" class:active={options.source === 'list' || !options.source}
                onclick={() => setSource('list')}>List</button>
            <button class="source-btn" class:active={options.source === 'range'}
                onclick={() => setSource('range')}>Range</button>
            <button class="source-btn" class:active={options.source === 'table'}
                onclick={() => setSource('table')}>Table</button>
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
                    onchange={(e) => updateRange(/** @type {HTMLInputElement} */(e.target).value.trim())}
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
                onchange={(e) => updateTable(/** @type {HTMLSelectElement} */(e.target).value, options.columnId ?? '')}
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
                onchange={(e) => updateTable(options.tableName ?? '', /** @type {HTMLSelectElement} */(e.target).value)}
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
                    <button class="opt-del" onclick={() => removeOption(idx)}>✕</button>
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
                onkeydown={(e) => { if (e.key === 'Enter') { addOption(); e.preventDefault(); } }}
            />
            <button onclick={addOption}>+</button>
        </div>
    {/if}

    <div class="option-row" style="margin-top:6px">
        <label>Allow custom</label>
        <input
            type="checkbox"
            checked={options.allowCustom ?? false}
            onchange={(e) => onUpdate({ type: 'dropdown', ...options, allowCustom: /** @type {HTMLInputElement} */(e.target).checked })}
        />
    </div>

    <div class="option-row">
        <label>Validation</label>
        <select
            value={options.validation ?? 'none'}
            onchange={(e) => onUpdate({ type: 'dropdown', ...options, validation: /** @type {HTMLSelectElement} */(e.target).value })}
        >
            <option value="none">None</option>
            <option value="soft">Warn</option>
            <option value="hard">Reject</option>
        </select>
    </div>
</div>

<style>
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

    .option-row label { color: #374151; white-space: nowrap; }

    .option-row select {
        flex: 1;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
    }

    .option-row input[type="checkbox"] { width: 14px; height: 14px; }

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

    .source-btn.active { background: #eff6ff; color: #1d4ed8; font-weight: 500; }

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
        background: none;
        border: none;
        cursor: pointer;
        color: #ef4444;
        padding: 0 2px;
        font-size: 0.75rem;
    }

    .opt-empty {
        padding: 6px 8px;
        color: #94a3b8;
        font-size: 0.75rem;
        font-style: italic;
    }

    .dropdown-add-row { display: flex; gap: 4px; }

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
</style>
