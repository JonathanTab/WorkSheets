<script>
    /**
     * HoramConfigPanel — configure the Horam time-import plugin for the active sheet.
     *
     * Persists: label, horam doc, anchor cell (button position),
     * start-date cell ref, end-date cell ref, output cell ref.
     * Date range and exclusions are chosen at import time in the modal.
     */
    import { onMount } from 'svelte';
    import { spreadsheetSession, selectionState } from '../../../../stores/spreadsheetStore.svelte.js';
    import { listHoramDocs } from '../../../../stores/spreadsheet/plugins/horam/HoramConnector.js';

    let { onclose } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);

    // ── Horam doc list ─────────────────────────────────────────────────────────
    let horamDocs   = $state([]);
    let docsLoading = $state(true);
    let docsError   = $state('');

    onMount(async () => {
        try {
            horamDocs = await listHoramDocs();
        } catch (e) {
            docsError = e.message ?? 'Failed to load horam documents';
        } finally {
            docsLoading = false;
        }
    });

    // ── Existing plugins ───────────────────────────────────────────────────────
    let existingPlugins = $derived.by(() => {
        const _pv = sheetStore?.pluginsVersion;
        const map = sheetStore?.getPluginsMap?.();
        if (!map) return [];
        const result = [];
        map.forEach((jsonStr, id) => {
            try {
                const config = JSON.parse(jsonStr);
                if (config.type === 'horam-time-import') result.push({ id, config });
            } catch { /* skip malformed */ }
        });
        return result;
    });

    // ── Cell ref helpers ───────────────────────────────────────────────────────
    function colLabel(n) {
        let s = ''; n++;
        while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
        return s;
    }
    function cellRef(row, col) { return `${colLabel(col)}${row + 1}`; }
    function parseRef(str) {
        const m = String(str ?? '').trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
        if (!m) return null;
        let col = 0;
        for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        return { row: parseInt(m[2]) - 1, col: col - 1 };
    }

    // ── Draft ──────────────────────────────────────────────────────────────────
    let editingId = $state(null);

    let draft = $state({
        docId:         '',
        label:         'Import hours',
        anchorRow:     selectionState.anchor?.row ?? 0,
        anchorCol:     selectionState.anchor?.col ?? 0,
        startDateCell: '',
        endDateCell:   '',
        outputCell:    '',
    });

    // Which field is currently being picked from the grid
    // null | 'anchor' | 'startDate' | 'endDate' | 'output'
    let pickingField = $state(null);

    $effect(() => {
        if (!pickingField) return;
        const sel = selectionState.anchor;
        if (!sel) return;
        const ref = cellRef(sel.row, sel.col);
        if      (pickingField === 'anchor')    { draft.anchorRow = sel.row; draft.anchorCol = sel.col; }
        else if (pickingField === 'startDate') draft.startDateCell = ref;
        else if (pickingField === 'endDate')   draft.endDateCell   = ref;
        else if (pickingField === 'output')    draft.outputCell    = ref;
    });

    function togglePick(field) {
        pickingField = pickingField === field ? null : field;
    }

    // ── Load / reset ───────────────────────────────────────────────────────────
    function startEdit(id, config) {
        editingId            = id;
        draft.docId          = config.docId          ?? '';
        draft.label          = config.label          ?? 'Import hours';
        draft.anchorRow      = config.anchorRow       ?? 0;
        draft.anchorCol      = config.anchorCol       ?? 0;
        draft.startDateCell  = config.startDateCell   ?? '';
        draft.endDateCell    = config.endDateCell     ?? '';
        draft.outputCell     = config.outputRow != null
            ? cellRef(config.outputRow, config.outputCol ?? 0)
            : '';
        pickingField = null;
    }

    function resetDraft() {
        editingId            = null;
        draft.docId          = '';
        draft.label          = 'Import hours';
        draft.anchorRow      = selectionState.anchor?.row ?? 0;
        draft.anchorCol      = selectionState.anchor?.col ?? 0;
        draft.startDateCell  = '';
        draft.endDateCell    = '';
        draft.outputCell     = '';
        pickingField         = null;
    }

    // ── Save / delete ──────────────────────────────────────────────────────────
    let saveError = $state('');

    function save() {
        if (!draft.docId) { saveError = 'Select a horam document.'; return; }
        saveError = '';
        const id = editingId ?? crypto.randomUUID().slice(0, 8);

        const parsedOutput = parseRef(draft.outputCell);

        sheetStore.setPlugin(id, {
            type:          'horam-time-import',
            label:         draft.label || 'Import hours',
            docId:         draft.docId,
            anchorRow:     draft.anchorRow,
            anchorCol:     draft.anchorCol,
            startDateCell: draft.startDateCell || undefined,
            endDateCell:   draft.endDateCell   || undefined,
            outputRow:     parsedOutput?.row,
            outputCol:     parsedOutput?.col,
        });
        resetDraft();
    }

    function removePlugin(id) {
        sheetStore.deletePlugin(id);
        if (editingId === id) resetDraft();
    }

    // ── Ref field component helper ─────────────────────────────────────────────
    const PICK_LABELS = {
        anchor:    'button',
        startDate: 'start-date',
        endDate:   'end-date',
        output:    'output',
    };
</script>

<div class="panel">
    <div class="panel-header">
        <span>Horam Time Import</span>
        <button class="close-btn" onclick={onclose}>✕</button>
    </div>

    <!-- Existing plugins -->
    {#if existingPlugins.length > 0}
        <div class="section">
            <div class="section-label">Active on this sheet</div>
            {#each existingPlugins as p (p.id)}
                <div class="plugin-row">
                    <div class="plugin-info">
                        <span class="plugin-name">{p.config.label ?? 'Import hours'}</span>
                        <span class="plugin-cell">button @ {cellRef(p.config.anchorRow, p.config.anchorCol)}</span>
                    </div>
                    <button class="edit-btn" onclick={() => startEdit(p.id, p.config)}>Edit</button>
                    <button class="del-btn" onclick={() => removePlugin(p.id)}>✕</button>
                </div>
            {/each}
        </div>
        <div class="divider"></div>
    {/if}

    <!-- Form -->
    <div class="section">
        <div class="section-label">{editingId ? 'Edit plugin' : 'Add plugin'}</div>

        <div class="row">
            <label>Label</label>
            <input type="text" bind:value={draft.label} placeholder="Import hours" />
        </div>

        <div class="row">
            <label>Horam doc</label>
            {#if docsLoading}
                <span class="hint">Loading…</span>
            {:else if docsError}
                <span class="hint error">{docsError}</span>
            {:else if horamDocs.length === 0}
                <span class="hint">No horam documents found</span>
            {:else}
                <select bind:value={draft.docId}>
                    <option value="">— select —</option>
                    {#each horamDocs as doc}
                        <option value={doc.id}>{doc.title}</option>
                    {/each}
                </select>
            {/if}
        </div>

        <div class="row">
            <label>Button cell</label>
            <div class="cell-row">
                <span class="cell-ref">{cellRef(draft.anchorRow, draft.anchorCol)}</span>
                <button class="pick-btn" class:active={pickingField === 'anchor'} onclick={() => togglePick('anchor')}>Pick</button>
            </div>
        </div>

        <div class="row">
            <label>Start date cell</label>
            <div class="cell-row">
                <input class="ref-input" type="text" bind:value={draft.startDateCell} placeholder="e.g. A1" />
                <button class="pick-btn" class:active={pickingField === 'startDate'} onclick={() => togglePick('startDate')}>Pick</button>
            </div>
        </div>

        <div class="row">
            <label>End date cell</label>
            <div class="cell-row">
                <input class="ref-input" type="text" bind:value={draft.endDateCell} placeholder="e.g. B1" />
                <button class="pick-btn" class:active={pickingField === 'endDate'} onclick={() => togglePick('endDate')}>Pick</button>
            </div>
        </div>

        <div class="row">
            <label>Output cell</label>
            <div class="cell-row">
                <input class="ref-input" type="text" bind:value={draft.outputCell} placeholder="e.g. A3" />
                <button class="pick-btn" class:active={pickingField === 'output'} onclick={() => togglePick('output')}>Pick</button>
            </div>
        </div>

        {#if pickingField}
            <div class="picking-hint">Click a cell on the grid to set the {PICK_LABELS[pickingField]} location</div>
        {/if}

        {#if saveError}
            <div class="save-error">{saveError}</div>
        {/if}

        <div class="form-footer">
            {#if editingId}
                <button class="cancel-btn" onclick={resetDraft}>Cancel</button>
            {/if}
            <button class="save-btn" onclick={save}>{editingId ? 'Update' : 'Add'}</button>
        </div>
    </div>

    <div class="help-text">
        Clicking the button opens the import wizard where you filter projects/tags
        and confirm writing totals to the output cell.
    </div>
</div>

<style>
    .panel {
        position: fixed; top: 80px; right: 16px; z-index: 500;
        width: 310px; background: white; border: 1px solid #e2e8f0;
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
    .row label { color: #374151; min-width: 90px; font-size: 0.8125rem; flex-shrink: 0; }
    .row select, .row input[type="text"] {
        flex: 1; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 3px; font-size: 0.8125rem;
    }
    .hint { color: #94a3b8; font-style: italic; font-size: 0.75rem; }
    .hint.error { color: #ef4444; }
    .cell-row { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
    .cell-ref { font-family: monospace; font-weight: 600; color: #374151; flex-shrink: 0; }
    .ref-input { flex: 1; min-width: 0; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 3px; font-size: 0.8125rem; font-family: monospace; }
    .pick-btn {
        font-size: 0.75rem; padding: 2px 6px; background: #eff6ff;
        border: 1px solid #bfdbfe; border-radius: 3px; cursor: pointer; color: #1d4ed8; flex-shrink: 0;
    }
    .pick-btn:hover, .pick-btn.active { background: #dbeafe; }
    .pick-btn.active { border-color: #3b82f6; }
    .picking-hint { font-size: 0.75rem; color: #3b82f6; padding: 2px 0; }
    .save-error { font-size: 0.75rem; color: #ef4444; }
    .form-footer { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
    .save-btn {
        padding: 5px 12px; background: #3b82f6; color: white;
        border: none; border-radius: 4px; cursor: pointer; font-size: 0.8125rem; font-weight: 500;
    }
    .save-btn:hover { background: #2563eb; }
    .cancel-btn {
        padding: 5px 12px; background: #f1f5f9; color: #374151;
        border: 1px solid #e2e8f0; border-radius: 4px; cursor: pointer; font-size: 0.8125rem;
    }
    .cancel-btn:hover { background: #e2e8f0; }
    .plugin-row { display: flex; align-items: center; gap: 6px; padding: 4px; border: 1px solid #e2e8f0; border-radius: 4px; }
    .plugin-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .plugin-name { font-weight: 500; color: #374151; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .plugin-cell { font-size: 0.75rem; color: #6b7280; font-family: monospace; }
    .edit-btn { font-size: 0.75rem; padding: 2px 6px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 3px; cursor: pointer; flex-shrink: 0; }
    .edit-btn:hover { background: #e2e8f0; }
    .del-btn { background: none; border: none; cursor: pointer; color: #ef4444; padding: 2px 4px; flex-shrink: 0; }
    .help-text { font-size: 0.75rem; color: #94a3b8; padding: 8px 12px; border-top: 1px solid #e2e8f0; line-height: 1.4; }
</style>
