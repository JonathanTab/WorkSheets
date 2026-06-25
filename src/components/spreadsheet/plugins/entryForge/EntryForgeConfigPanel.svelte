<script>
    /**
     * EntryForgeConfigPanel — configure the Entry Forge plugin for one table.
     *
     * Opened from the table's grid context menu (via entryForgeUi.configTableId,
     * which holds the source table id). Lets the user map the table's columns
     * (account / from-to / amount / date / notes), set the range listing the
     * document's real account names (used to detect transfers), and enable the
     * Mirror and Split actions.
     */
    import { spreadsheetSession, selectionState } from '../../../../stores/spreadsheetStore.svelte.js';
    import { getConfig, setConfig, deleteConfig, defaultConfig } from '../../../../stores/spreadsheet/plugins/entryForge/entryForgeConfig.js';

    let { tableId = null, onclose } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let tableManager = $derived(spreadsheetSession.tableManager);

    // Distinct source tables on the active sheet, for the picker.
    let tableOptions = $derived.by(() => {
        const mgr = tableManager;
        if (!mgr) return [];
        const seen = new Map();
        for (const id of mgr.tableList) {
            const store = mgr.stores.get(id);
            if (!store) continue;
            const srcId = store.sourceTableId;
            if (!seen.has(srcId)) seen.set(srcId, { id: srcId, name: store.name });
        }
        return [...seen.values()];
    });

    // Which table is being configured. Defaults to the prop, else the first table.
    let selectedTableId = $state(tableId);
    $effect(() => {
        if (!selectedTableId && tableOptions.length > 0) selectedTableId = tableOptions[0].id;
    });

    let table = $derived(selectedTableId ? (spreadsheetSession.tableRegistry?.getById(selectedTableId) ?? null) : null);
    let columns = $derived(table?.columns ?? []);

    // ── Draft state ──────────────────────────────────────────────────────────
    let draft = $state(defaultConfig(selectedTableId ?? ''));

    // (Re)load the draft whenever the selected table changes.
    let loadedFor = null;
    $effect(() => {
        const tid = selectedTableId;
        if (!tid || loadedFor === tid) return;
        loadedFor = tid;
        const existing = getConfig(sheetStore, tid);
        const base = defaultConfig(tid);
        draft = existing
            ? {
                ...base, ...existing,
                mapping: { ...base.mapping, ...(existing.mapping ?? {}) },
                actions: {
                    mirror: { ...base.actions.mirror, ...(existing.actions?.mirror ?? {}) },
                    split: { ...base.actions.split, ...(existing.actions?.split ?? {}) },
                },
              }
            : base;
    });

    // ── Accounts range "use selection" (same pattern as DropdownConfigPanel) ───
    function colLabel(n) {
        let s = ''; n++;
        while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
        return s;
    }
    function useSelectionAsRange() {
        const sel = selectionState.range;
        if (!sel) return;
        const cellPart = `${colLabel(sel.startCol)}${sel.startRow + 1}:${colLabel(sel.endCol)}${sel.endRow + 1}`;
        const sheetName = spreadsheetSession.getSheetName(spreadsheetSession.activeSheetId);
        const needsQuotes = /[\s!']/.test(sheetName);
        const quotedName = needsQuotes ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
        draft.accountsRange = `${quotedName}!${cellPart}`;
    }

    // ── Save / delete ──────────────────────────────────────────────────────────
    let error = $state('');

    function save() {
        if (!draft.mapping.account || !draft.mapping.fromTo || !draft.mapping.amount) {
            error = 'Map the Account, From/To, and Amount columns.';
            return;
        }
        if (draft.actions.mirror.enabled && !draft.accountsRange.trim()) {
            error = 'Mirror needs an accounts range to detect transfers.';
            return;
        }
        error = '';
        setConfig(sheetStore, selectedTableId, { ...draft, label: draft.label?.trim() || 'Entry Forge' });
        onclose?.();
    }

    function remove() {
        deleteConfig(sheetStore, selectedTableId);
        onclose?.();
    }

    const MAP_FIELDS = [
        { key: 'account', label: 'Account', required: true },
        { key: 'fromTo', label: 'From / To', required: true },
        { key: 'amount', label: 'Amount', required: true },
        { key: 'date', label: 'Date', required: false },
        { key: 'notes', label: 'Notes', required: false },
    ];
</script>

<div class="panel">
    <div class="panel-header">
        <span>Entry Forge</span>
        <button class="close-btn" onclick={onclose}>✕</button>
    </div>

    {#if tableOptions.length === 0}
        <div class="section"><span class="hint">No tables on this sheet to configure.</span></div>
    {:else}
        <div class="section">
            <div class="row">
                <label for="ef-table">Table</label>
                <select id="ef-table" bind:value={selectedTableId}>
                    {#each tableOptions as t}
                        <option value={t.id}>{t.name}</option>
                    {/each}
                </select>
            </div>
        </div>
        <div class="divider"></div>

        <div class="section">
            <div class="row">
                <label for="ef-label">Label</label>
                <input id="ef-label" type="text" bind:value={draft.label} placeholder="Entry Forge" />
            </div>
        </div>

        <div class="divider"></div>

        <div class="section">
            <div class="section-label">Column mapping</div>
            {#each MAP_FIELDS as f}
                <div class="row">
                    <label for="ef-map-{f.key}">{f.label}{f.required ? ' *' : ''}</label>
                    <select id="ef-map-{f.key}" bind:value={draft.mapping[f.key]}>
                        <option value={null}>— none —</option>
                        {#each columns as col}
                            <option value={col.id}>{col.name}</option>
                        {/each}
                    </select>
                </div>
            {/each}
        </div>

        <div class="divider"></div>

        <div class="section">
            <div class="section-label">Real accounts range</div>
            <div class="row">
                <input class="range-input" type="text" bind:value={draft.accountsRange}
                    placeholder="e.g. Accounts!A2:A20" />
            </div>
            <div class="range-hint">
                <span class="hint">Used to tell a transfer from an ordinary payee.</span>
                <button class="use-sel-btn" onclick={useSelectionAsRange}>Use selection</button>
            </div>
        </div>

        <div class="divider"></div>

        <div class="section">
            <div class="section-label">Actions</div>
            <label class="check-row">
                <input type="checkbox" bind:checked={draft.actions.mirror.enabled} />
                <span><strong>Mirror</strong> — offer a complementary transfer entry on matching rows</span>
            </label>
            <label class="check-row">
                <input type="checkbox" bind:checked={draft.actions.split.enabled} />
                <span><strong>Split</strong> — divide a transaction into multiple entries</span>
            </label>
        </div>

        {#if error}<div class="section"><span class="hint error">{error}</span></div>{/if}

        <div class="form-footer">
            <button class="del-btn" onclick={remove}>Remove</button>
            <button class="save-btn" onclick={save}>Save</button>
        </div>
    {/if}
</div>

<style>
    .panel {
        position: fixed; top: 80px; right: 16px; z-index: 500;
        width: 320px; background: white; border: 1px solid #e2e8f0;
        border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        font-size: 0.8125rem; display: flex; flex-direction: column;
        max-height: calc(100vh - 96px); overflow-y: auto;
    }
    .panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px; background: #f8fafc; border-bottom: 1px solid #e2e8f0;
        font-weight: 600; border-radius: 6px 6px 0 0; flex-shrink: 0;
    }
    .close-btn { background: none; border: none; cursor: pointer; padding: 2px 4px; color: #64748b; font-size: 1rem; }
    .section { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
    .section-label { font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
    .divider { border-top: 1px solid #e2e8f0; }
    .row { display: flex; align-items: center; gap: 8px; }
    .row label { color: #374151; min-width: 78px; font-size: 0.8125rem; flex-shrink: 0; }
    .row select, .row input[type="text"] {
        flex: 1; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 3px; font-size: 0.8125rem;
    }
    .range-input { font-family: monospace; }
    .range-hint { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
    .hint { color: #94a3b8; font-size: 0.75rem; flex: 1; }
    .hint.error { color: #ef4444; }
    .use-sel-btn {
        padding: 2px 7px; background: #f1f5f9; border: 1px solid #e2e8f0;
        border-radius: 3px; cursor: pointer; font-size: 0.75rem; color: #374151; white-space: nowrap;
    }
    .use-sel-btn:hover { background: #e2e8f0; }
    .check-row { display: flex; align-items: flex-start; gap: 8px; color: #374151; line-height: 1.35; cursor: pointer; }
    .check-row input { margin-top: 2px; flex-shrink: 0; }
    .form-footer { display: flex; justify-content: space-between; gap: 6px; padding: 10px 12px; border-top: 1px solid #e2e8f0; }
    .save-btn { padding: 5px 14px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500; }
    .save-btn:hover { background: #2563eb; }
    .del-btn { padding: 5px 12px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 4px; cursor: pointer; }
    .del-btn:hover { background: #fee2e2; }
</style>
