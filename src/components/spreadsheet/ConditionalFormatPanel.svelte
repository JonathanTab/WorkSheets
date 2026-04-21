<script>
    import { spreadsheetSession, selectionState } from '../../stores/spreadsheetStore.svelte.js';

    let { onclose } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);

    // Reactivity: re-derive whenever cfVersion changes
    /** @type {Array<{id:string,startRow:number,startCol:number,endRow:number,endCol:number,condition:string,threshold:string,style:Record<string,any>}>} */
    let rules = $derived.by(() => {
        if (!sheetStore) return [];
        const _v = sheetStore.cfVersion;
        return /** @type {any[]} */ (sheetStore.getConditionalFormats?.() ?? []);
    });

    const CONDITIONS = [
        { value: 'gt',       label: 'Greater than' },
        { value: 'gte',      label: '≥ Greater than or equal' },
        { value: 'lt',       label: 'Less than' },
        { value: 'lte',      label: '≤ Less than or equal' },
        { value: 'eq',       label: '= Equal to' },
        { value: 'neq',      label: '≠ Not equal to' },
        { value: 'contains', label: 'Contains' },
    ];

    // ── Drag-to-move ────────────────────────────────────────────────────────────
    let panelX = $state(window.innerWidth - 332);
    let panelY = $state(80);
    let dragging = $state(false);
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    function onHeaderPointerDown(e) {
        if (e.button !== 0) return;
        dragging = true;
        dragOffsetX = e.clientX - panelX;
        dragOffsetY = e.clientY - panelY;
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        e.preventDefault();
    }

    function onPointerMove(e) {
        panelX = Math.max(0, Math.min(window.innerWidth - 320, e.clientX - dragOffsetX));
        panelY = Math.max(0, Math.min(window.innerHeight - 100, e.clientY - dragOffsetY));
    }

    function onPointerUp() {
        dragging = false;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
    }

    // ── Range input helpers ──────────────────────────────────────────────────────
    const colLabel = (n) => {
        let s = ''; n++;
        while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
        return s;
    };

    function rangeToStr(r) {
        return `${colLabel(r.startCol)}${r.startRow + 1}:${colLabel(r.endCol)}${r.endRow + 1}`;
    }

    /** Parse "A1:B3" → { startRow, startCol, endRow, endCol } or null */
    function parseRange(str) {
        const m = str.trim().toUpperCase().match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        if (!m) return null;
        const colFromStr = (s) => s.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0) - 1;
        return {
            startCol: colFromStr(m[1]),
            startRow: parseInt(m[2], 10) - 1,
            endCol: colFromStr(m[3]),
            endRow: parseInt(m[4], 10) - 1,
        };
    }

    // ── Draft ───────────────────────────────────────────────────────────────────
    let draft = $state(makeDraft());
    let rangeInput = $state('');
    let rangeInputError = $state(false);
    let pickingRange = $state(false);

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

    // Keep rangeInput in sync with draft coords (but don't overwrite while user is typing)
    let rangeInputFocused = $state(false);
    $effect(() => {
        if (!rangeInputFocused) {
            rangeInput = rangeToStr(draft);
        }
    });

    // While picking, mirror selection into draft
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

    function onRangeInputBlur() {
        rangeInputFocused = false;
        const parsed = parseRange(rangeInput);
        if (parsed) {
            draft.startRow = parsed.startRow;
            draft.startCol = parsed.startCol;
            draft.endRow = parsed.endRow;
            draft.endCol = parsed.endCol;
            rangeInputError = false;
        } else {
            rangeInputError = true;
        }
    }

    function onRangeInputKeyDown(e) {
        if (e.key === 'Enter') e.currentTarget.blur();
    }

    function useSelection() {
        const sel = selectionState.range;
        if (!sel) return;
        draft.startRow = sel.startRow;
        draft.startCol = sel.startCol;
        draft.endRow = sel.endRow;
        draft.endCol = sel.endCol;
        rangeInputError = false;
    }

    function startPickingRange() {
        pickingRange = true;
    }

    function confirmPickedRange() {
        pickingRange = false;
    }

    let draftRangeLabel = $derived(rangeToStr(draft));

    function addRule() {
        if (!sheetStore || draft.threshold === '') return;
        const id = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        sheetStore.addConditionalFormat({ id, ...draft });
        draft = makeDraft();
        rangeInputError = false;
    }

    function removeRule(id) {
        sheetStore?.deleteConditionalFormat(id);
    }
</script>

{#if pickingRange}
    <div
        class="picking-overlay"
        style="left:{panelX}px;top:{panelY}px"
    >
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
    <div
        class="panel"
        class:dragging
        style="left:{panelX}px;top:{panelY}px"
    >
        <div
            class="panel-header"
            role="toolbar"
            aria-label="Drag to move panel"
            onpointerdown={onHeaderPointerDown}
        >
            <span>Conditional Formatting</span>
            <button class="close-btn" onclick={onclose}>✕</button>
        </div>

        <!-- Existing rules -->
        {#if rules.length}
            <div class="rules-list">
                {#each rules as rule (rule.id)}
                    <div class="rule-row">
                        <div
                            class="rule-swatch"
                            style="background:{rule.style?.backgroundColor || 'transparent'};border:1px solid #cbd5e1"
                        ></div>
                        <div class="rule-desc">
                            <span class="rule-range">{rangeToStr(rule)}</span>
                            <span class="rule-cond">
                                {CONDITIONS.find(c => c.value === rule.condition)?.label ?? rule.condition}
                                {rule.threshold}
                            </span>
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
                <label for="cf-range">Range</label>
                <div class="range-row">
                    <input
                        id="cf-range"
                        class="range-input"
                        class:error={rangeInputError}
                        type="text"
                        bind:value={rangeInput}
                        onfocus={() => { rangeInputFocused = true; }}
                        onblur={onRangeInputBlur}
                        onkeydown={onRangeInputKeyDown}
                        placeholder="A1:B10"
                        spellcheck="false"
                    />
                    <button class="pick-btn" onclick={startPickingRange} title="Pick range on grid">⊡</button>
                    <button class="use-sel-btn" onclick={useSelection} title="Use current selection">⌖</button>
                </div>
            </div>

            <div class="row">
                <label for="cf-condition">Condition</label>
                <select id="cf-condition" bind:value={draft.condition}>
                    {#each CONDITIONS as c}
                        <option value={c.value}>{c.label}</option>
                    {/each}
                </select>
            </div>

            <div class="row">
                <label for="cf-threshold">Value</label>
                <input id="cf-threshold" type="text" bind:value={draft.threshold} placeholder="e.g. 100" />
            </div>

            <div class="row">
                <label for="cf-bg">Background</label>
                <input id="cf-bg" type="color" bind:value={draft.style.backgroundColor} />
            </div>

            <div class="row">
                <label for="cf-color">Text color</label>
                <input id="cf-color" type="color" bind:value={draft.style.color} />
            </div>

            <div class="row">
                <label for="cf-bold">Bold</label>
                <input id="cf-bold" type="checkbox" bind:checked={draft.style.bold} />
            </div>

            <button class="add-btn" onclick={addRule} disabled={draft.threshold === ''}>Add Rule</button>
        </div>
    </div>
{/if}

<style>
    .panel {
        position: fixed;
        z-index: 500;
        width: 300px;
        background: var(--color-surface, white);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 6px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.14);
        font-size: 0.8125rem;
        display: flex;
        flex-direction: column;
        max-height: calc(100vh - 96px);
        overflow-y: auto;
        user-select: none;
    }
    .panel.dragging {
        box-shadow: 0 8px 32px rgba(0,0,0,0.22);
        opacity: 0.97;
    }
    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: var(--color-bg-secondary, #f8fafc);
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        font-weight: 600;
        border-radius: 6px 6px 0 0;
        cursor: grab;
    }
    .panel-header:active { cursor: grabbing; }
    .close-btn {
        background: none; border: none; cursor: pointer; padding: 2px 4px;
        color: #64748b; font-size: 1rem;
    }
    .rules-list { padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
    .rule-row {
        display: flex; align-items: center; gap: 8px;
        padding: 4px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 4px;
    }
    .rule-swatch { width: 20px; height: 20px; border-radius: 3px; flex-shrink: 0; }
    .rule-desc { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
    .rule-range { font-weight: 500; color: #374151; font-family: monospace; font-size: 0.75rem; }
    .rule-cond { color: #6b7280; font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .del-btn { background: none; border: none; cursor: pointer; color: #ef4444; padding: 2px 6px; flex-shrink: 0; }
    .empty { color: #94a3b8; padding: 8px 12px; margin: 0; font-style: italic; }
    .divider { border-top: 1px solid var(--color-border, #e2e8f0); margin: 0; }
    .add-section { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; user-select: auto; }
    .row {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .row label { color: #374151; min-width: 72px; flex-shrink: 0; }
    .row select, .row input[type="text"] {
        flex: 1; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 3px;
        font-size: 0.8125rem; background: var(--color-surface, white); color: var(--color-text, #111);
    }
    .row input[type="color"] { width: 40px; height: 24px; border: 1px solid #cbd5e1; border-radius: 3px; cursor: pointer; }
    .row input[type="checkbox"] { width: 16px; height: 16px; }

    /* Range row */
    .range-row { display: flex; align-items: center; gap: 3px; flex: 1; min-width: 0; }
    .range-input {
        flex: 1; min-width: 0; padding: 3px 6px;
        border: 1px solid #cbd5e1; border-radius: 3px;
        font-size: 0.8125rem; font-family: monospace;
        background: var(--color-surface, white); color: var(--color-text, #111);
    }
    .range-input.error { border-color: #ef4444; background: #fef2f2; }
    .pick-btn {
        font-size: 1rem; padding: 2px 5px; background: #eff6ff;
        border: 1px solid #bfdbfe; border-radius: 3px; cursor: pointer;
        color: #1d4ed8; flex-shrink: 0; line-height: 1;
    }
    .pick-btn:hover { background: #dbeafe; }
    .use-sel-btn {
        font-size: 1rem; padding: 2px 5px; background: #f1f5f9;
        border: 1px solid #e2e8f0; border-radius: 3px; cursor: pointer;
        flex-shrink: 0; line-height: 1;
    }
    .use-sel-btn:hover { background: #e2e8f0; }
    .add-btn {
        margin-top: 4px; padding: 6px 12px; background: #3b82f6; color: white;
        border: none; border-radius: 4px; cursor: pointer; font-size: 0.8125rem; font-weight: 500;
        align-self: flex-end;
    }
    .add-btn:hover:not(:disabled) { background: #2563eb; }
    .add-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    /* Picking overlay */
    .picking-overlay {
        position: fixed;
        z-index: 500;
        background: var(--color-surface, white);
        border: 2px solid #3b82f6;
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        padding: 10px 12px;
        min-width: 240px;
    }
    .picking-content { display: flex; align-items: center; gap: 10px; }
    .picking-icon { font-size: 20px; color: #3b82f6; flex-shrink: 0; }
    .picking-info { flex: 1; }
    .picking-label { font-size: 0.75rem; color: #64748b; margin-bottom: 2px; }
    .picking-range { font-family: monospace; font-size: 0.875rem; font-weight: 600; color: #1d4ed8; }
    .picking-done {
        padding: 4px 12px; background: #3b82f6; color: white;
        border: none; border-radius: 4px; cursor: pointer;
        font-size: 0.8125rem; font-weight: 500; flex-shrink: 0;
    }
    .picking-done:hover { background: #2563eb; }
</style>
