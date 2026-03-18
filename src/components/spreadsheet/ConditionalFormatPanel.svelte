<script>
    import { spreadsheetSession, selectionState } from '../../stores/spreadsheetStore.svelte.js';

    let { onclose } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);

    // Live reactive rules list (re-reads whenever cellsVersion changes as a proxy)
    let rules = $derived.by(() => {
        if (!sheetStore) return [];
        // Touch cellsVersion so we re-derive when any cell data changes
        const _v = sheetStore.cellsVersion;
        return sheetStore.getConditionalFormats?.() ?? [];
    });

    const CONDITIONS = [
        { value: 'gt',       label: 'Greater than' },
        { value: 'gte',      label: 'Greater than or equal' },
        { value: 'lt',       label: 'Less than' },
        { value: 'lte',      label: 'Less than or equal' },
        { value: 'eq',       label: 'Equal to' },
        { value: 'neq',      label: 'Not equal to' },
        { value: 'contains', label: 'Contains' },
    ];

    // New rule draft
    let draft = $state(makeDraft());

    function makeDraft() {
        const sel = selectionState.range;
        return {
            condition: 'gt',
            threshold: '',
            style: { backgroundColor: '#fef08a', color: '', bold: false, italic: false },
            startRow: sel?.startRow ?? 0,
            startCol: sel?.startCol ?? 0,
            endRow: sel?.endRow ?? 0,
            endCol: sel?.endCol ?? 0,
        };
    }

    function rangeLabel(rule) {
        const col = (n) => {
            let s = ''; n++;
            while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
            return s;
        };
        return `${col(rule.startCol)}${rule.startRow + 1}:${col(rule.endCol)}${rule.endRow + 1}`;
    }

    function addRule() {
        if (!sheetStore || draft.threshold === '') return;
        const id = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        sheetStore.addConditionalFormat({ id, ...draft });
        draft = makeDraft();
    }

    function removeRule(id) {
        sheetStore?.deleteConditionalFormat(id);
    }

    function useSelection() {
        const sel = selectionState.range;
        if (!sel) return;
        draft.startRow = sel.startRow;
        draft.startCol = sel.startCol;
        draft.endRow = sel.endRow;
        draft.endCol = sel.endCol;
    }
</script>

<div class="panel">
    <div class="panel-header">
        <span>Conditional Formatting</span>
        <button class="close-btn" onclick={onclose}>✕</button>
    </div>

    <!-- Existing rules -->
    {#if rules.length}
        <div class="rules-list">
            {#each rules as rule (rule.id)}
                <div class="rule-row">
                    <div class="rule-swatch" style="background:{rule.style?.backgroundColor || 'transparent'};border:1px solid #cbd5e1"></div>
                    <div class="rule-desc">
                        <span class="rule-range">{rangeLabel(rule)}</span>
                        <span class="rule-cond">{CONDITIONS.find(c => c.value === rule.condition)?.label ?? rule.condition} {rule.threshold}</span>
                    </div>
                    <button class="del-btn" onclick={() => removeRule(rule.id)}>✕</button>
                </div>
            {/each}
        </div>
    {:else}
        <p class="empty">No rules yet.</p>
    {/if}

    <div class="divider"></div>

    <!-- Add new rule -->
    <div class="add-section">
        <div class="row">
            <label>Range</label>
            <div class="range-row">
                <span class="range-label">{rangeLabel(draft)}</span>
                <button class="use-sel-btn" onclick={useSelection}>Use selection</button>
            </div>
        </div>

        <div class="row">
            <label>Condition</label>
            <select bind:value={draft.condition}>
                {#each CONDITIONS as c}
                    <option value={c.value}>{c.label}</option>
                {/each}
            </select>
        </div>

        <div class="row">
            <label>Value</label>
            <input type="text" bind:value={draft.threshold} placeholder="e.g. 100" />
        </div>

        <div class="row">
            <label>Background</label>
            <input type="color" bind:value={draft.style.backgroundColor} />
        </div>

        <div class="row">
            <label>Text color</label>
            <input type="color" bind:value={draft.style.color} />
        </div>

        <div class="row">
            <label>Bold</label>
            <input type="checkbox" bind:checked={draft.style.bold} />
        </div>

        <button class="add-btn" onclick={addRule}>Add Rule</button>
    </div>
</div>

<style>
    .panel {
        width: 300px;
        background: white;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        font-size: 0.8125rem;
        display: flex;
        flex-direction: column;
    }
    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: #f8fafc;
        border-bottom: 1px solid #e2e8f0;
        font-weight: 600;
        border-radius: 6px 6px 0 0;
    }
    .close-btn {
        background: none; border: none; cursor: pointer; padding: 2px 4px;
        color: #64748b; font-size: 1rem;
    }
    .rules-list { padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
    .rule-row {
        display: flex; align-items: center; gap: 8px;
        padding: 4px; border: 1px solid #e2e8f0; border-radius: 4px;
    }
    .rule-swatch { width: 20px; height: 20px; border-radius: 3px; flex-shrink: 0; }
    .rule-desc { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .rule-range { font-weight: 500; color: #374151; }
    .rule-cond { color: #6b7280; font-size: 0.75rem; }
    .del-btn { background: none; border: none; cursor: pointer; color: #ef4444; padding: 2px 4px; }
    .empty { color: #94a3b8; padding: 8px 12px; margin: 0; font-style: italic; }
    .divider { border-top: 1px solid #e2e8f0; margin: 0; }
    .add-section { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
    .row {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .row label { color: #374151; min-width: 80px; }
    .row select, .row input[type="text"] {
        flex: 1; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 3px;
        font-size: 0.8125rem;
    }
    .row input[type="color"] { width: 40px; height: 24px; border: 1px solid #cbd5e1; border-radius: 3px; cursor: pointer; }
    .row input[type="checkbox"] { width: 16px; height: 16px; }
    .range-row { display: flex; align-items: center; gap: 6px; flex: 1; }
    .range-label { font-family: monospace; color: #374151; }
    .use-sel-btn {
        font-size: 0.75rem; padding: 2px 6px; background: #f1f5f9;
        border: 1px solid #e2e8f0; border-radius: 3px; cursor: pointer; white-space: nowrap;
    }
    .add-btn {
        margin-top: 4px; padding: 6px 12px; background: #3b82f6; color: white;
        border: none; border-radius: 4px; cursor: pointer; font-size: 0.8125rem; font-weight: 500;
        align-self: flex-end;
    }
    .add-btn:hover { background: #2563eb; }
</style>
