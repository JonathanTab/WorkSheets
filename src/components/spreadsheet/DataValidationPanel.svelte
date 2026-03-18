<script>
    import { spreadsheetSession, selectionState } from '../../stores/spreadsheetStore.svelte.js';

    let { onclose } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);

    let rules = $derived.by(() => {
        if (!sheetStore) return [];
        const _v = sheetStore.cellsVersion;
        return sheetStore.getDataValidations?.() ?? [];
    });

    const TYPES = [
        { value: 'list',    label: 'List of values' },
        { value: 'number',  label: 'Number' },
        { value: 'date',    label: 'Date' },
        { value: 'text',    label: 'Text length' },
    ];

    const NUMBER_CONDITIONS = [
        { value: 'between',    label: 'between' },
        { value: 'gt',         label: 'greater than' },
        { value: 'gte',        label: 'greater than or equal' },
        { value: 'lt',         label: 'less than' },
        { value: 'lte',        label: 'less than or equal' },
        { value: 'eq',         label: 'equal to' },
        { value: 'neq',        label: 'not equal to' },
    ];

    let draft = $state(makeDraft());
    /** Whether the user is in range-picking mode (click on grid to set range) */
    let pickingRange = $state(false);

    function makeDraft() {
        const sel = selectionState.range;
        return {
            type: 'list',
            options: '',
            condition: 'between',
            min: '',
            max: '',
            message: '',
            strict: true,
            startRow: sel?.startRow ?? 0,
            startCol: sel?.startCol ?? 0,
            endRow: sel?.endRow ?? 0,
            endCol: sel?.endCol ?? 0,
        };
    }

    const colLabel = (n) => {
        let s = ''; n++;
        while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
        return s;
    };

    function rangeLabel(rule) {
        return `${colLabel(rule.startCol)}${rule.startRow + 1}:${colLabel(rule.endCol)}${rule.endRow + 1}`;
    }

    let draftRangeLabel = $derived(rangeLabel(draft));

    // While in picking mode, track selection changes and mirror them into draft
    $effect(() => {
        if (!pickingRange) return;
        const sel = selectionState.range;
        if (sel) {
            draft.startRow = sel.startRow;
            draft.startCol = sel.startCol;
            draft.endRow = sel.endRow;
            draft.endCol = sel.endCol;
        }
    });

    function typeLabel(rule) {
        const t = TYPES.find(t => t.value === rule.type);
        if (rule.type === 'list') return `List: ${(rule.options || []).join(', ')}`;
        return t?.label ?? rule.type;
    }

    function startPickingRange() {
        pickingRange = true;
    }

    function confirmPickedRange() {
        pickingRange = false;
    }

    function useSelection() {
        const sel = selectionState.range;
        if (!sel) return;
        draft.startRow = sel.startRow;
        draft.startCol = sel.startCol;
        draft.endRow = sel.endRow;
        draft.endCol = sel.endCol;
    }

    function addRule() {
        if (!sheetStore) return;
        const id = `dv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const rule = {
            id,
            type: draft.type,
            startRow: draft.startRow,
            startCol: draft.startCol,
            endRow: draft.endRow,
            endCol: draft.endCol,
            message: draft.message || '',
            strict: draft.strict,
        };
        if (draft.type === 'list') {
            rule.options = draft.options.split(',').map(s => s.trim()).filter(Boolean);
        } else {
            rule.condition = draft.condition;
            rule.min = draft.min;
            rule.max = draft.max;
        }
        sheetStore.addDataValidation(rule);
        draft = makeDraft();
    }

    function removeRule(id) {
        sheetStore?.deleteDataValidation(id);
    }
</script>

{#if pickingRange}
    <!-- Compact range-picking indicator — stays out of the way while user drags on grid -->
    <div class="picking-overlay">
        <div class="picking-content">
            <span class="picking-icon">⊡</span>
            <div class="picking-info">
                <div class="picking-label">Click and drag to select range</div>
                <div class="picking-range">{draftRangeLabel}</div>
            </div>
            <button class="picking-done" onclick={confirmPickedRange}>Done</button>
        </div>
    </div>
{:else}
    <div class="panel">
        <div class="panel-header">
            <span>Data Validation</span>
            <button class="close-btn" onclick={onclose}>✕</button>
        </div>

        {#if rules.length}
            <div class="rules-list">
                {#each rules as rule (rule.id)}
                    <div class="rule-row">
                        <div class="rule-desc">
                            <span class="rule-range">{rangeLabel(rule)}</span>
                            <span class="rule-cond">{typeLabel(rule)}</span>
                        </div>
                        <button class="del-btn" onclick={() => removeRule(rule.id)}>✕</button>
                    </div>
                {/each}
            </div>
        {:else}
            <p class="empty">No rules yet.</p>
        {/if}

        <div class="divider"></div>

        <div class="add-section">
            <div class="row">
                <label>Range</label>
                <div class="range-row">
                    <span class="range-label">{draftRangeLabel}</span>
                    <button class="pick-btn" onclick={startPickingRange} title="Pick range on grid">⊡ Pick</button>
                    <button class="use-sel-btn" onclick={useSelection}>Use sel.</button>
                </div>
            </div>

            <div class="row">
                <label>Type</label>
                <select bind:value={draft.type}>
                    {#each TYPES as t}
                        <option value={t.value}>{t.label}</option>
                    {/each}
                </select>
            </div>

            {#if draft.type === 'list'}
                <div class="row">
                    <label>Options</label>
                    <input type="text" bind:value={draft.options} placeholder="A, B, C (comma-separated)" />
                </div>
            {:else}
                <div class="row">
                    <label>Condition</label>
                    <select bind:value={draft.condition}>
                        {#each NUMBER_CONDITIONS as c}
                            <option value={c.value}>{c.label}</option>
                        {/each}
                    </select>
                </div>
                <div class="row">
                    <label>{draft.condition === 'between' ? 'Min' : 'Value'}</label>
                    <input type="text" bind:value={draft.min} />
                </div>
                {#if draft.condition === 'between'}
                    <div class="row">
                        <label>Max</label>
                        <input type="text" bind:value={draft.max} />
                    </div>
                {/if}
            {/if}

            <div class="row">
                <label>Message</label>
                <input type="text" bind:value={draft.message} placeholder="Error hint (optional)" />
            </div>

            <div class="row">
                <label>Reject invalid</label>
                <input type="checkbox" bind:checked={draft.strict} />
            </div>

            <button class="add-btn" onclick={addRule}>Add Rule</button>
        </div>
    </div>
{/if}

<style>
    .panel {
        width: 320px;
        background: white;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        font-size: 0.8125rem;
        display: flex;
        flex-direction: column;
    }
    .panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px; background: #f8fafc; border-bottom: 1px solid #e2e8f0;
        font-weight: 600; border-radius: 6px 6px 0 0;
    }
    .close-btn { background: none; border: none; cursor: pointer; padding: 2px 4px; color: #64748b; font-size: 1rem; }
    .rules-list { padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
    .rule-row { display: flex; align-items: center; gap: 8px; padding: 4px; border: 1px solid #e2e8f0; border-radius: 4px; }
    .rule-desc { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .rule-range { font-weight: 500; color: #374151; }
    .rule-cond { color: #6b7280; font-size: 0.75rem; }
    .del-btn { background: none; border: none; cursor: pointer; color: #ef4444; padding: 2px 4px; }
    .empty { color: #94a3b8; padding: 8px 12px; margin: 0; font-style: italic; }
    .divider { border-top: 1px solid #e2e8f0; margin: 0; }
    .add-section { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .row label { color: #374151; min-width: 70px; font-size: 0.8125rem; flex-shrink: 0; }
    .row select, .row input[type="text"] {
        flex: 1; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 3px; font-size: 0.8125rem;
    }
    .row input[type="checkbox"] { width: 16px; height: 16px; }
    .range-row { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
    .range-label {
        font-family: monospace; color: #374151; flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .pick-btn {
        font-size: 0.75rem; padding: 2px 6px; background: #eff6ff;
        border: 1px solid #bfdbfe; border-radius: 3px; cursor: pointer;
        white-space: nowrap; color: #1d4ed8; flex-shrink: 0;
    }
    .pick-btn:hover { background: #dbeafe; }
    .use-sel-btn {
        font-size: 0.75rem; padding: 2px 6px; background: #f1f5f9;
        border: 1px solid #e2e8f0; border-radius: 3px; cursor: pointer;
        white-space: nowrap; flex-shrink: 0;
    }
    .add-btn {
        margin-top: 4px; padding: 6px 12px; background: #3b82f6; color: white;
        border: none; border-radius: 4px; cursor: pointer; font-size: 0.8125rem; font-weight: 500;
        align-self: flex-end;
    }
    .add-btn:hover { background: #2563eb; }

    /* Picking overlay — compact indicator while user selects range on grid */
    .picking-overlay {
        background: white;
        border: 2px solid #3b82f6;
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        padding: 10px 12px;
        min-width: 240px;
    }
    .picking-content {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .picking-icon {
        font-size: 20px;
        color: #3b82f6;
        flex-shrink: 0;
    }
    .picking-info { flex: 1; }
    .picking-label {
        font-size: 0.75rem;
        color: #64748b;
        margin-bottom: 2px;
    }
    .picking-range {
        font-family: monospace;
        font-size: 0.875rem;
        font-weight: 600;
        color: #1d4ed8;
    }
    .picking-done {
        padding: 4px 12px;
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.8125rem;
        font-weight: 500;
        flex-shrink: 0;
    }
    .picking-done:hover { background: #2563eb; }
</style>
