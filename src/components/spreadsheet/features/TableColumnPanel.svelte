<script>
    /**
     * TableColumnPanel - Column configuration panel.
     *
     * Covers table-specific column settings:
     *   - Default formula: evaluated at insert time; result stored. User can override.
     *   - Read-only toggle (isNonEntry): prevents editing regardless of formula.
     *   - Delete column
     *
     * When both defaultFormula and isNonEntry are set, the column acts as a pure
     * computed column (always derived, never stored).
     */

    import {
        close,
        trash,
    } from "../../../lib/icons/index.js";
    import { onMount } from "svelte";
    import BottomSheet from "../../ui/BottomSheet.svelte";
    import { mobileState } from "../../../stores/mobileState.svelte.js";

    let {
        table,
        colId,
        onClose,
        inline = false,
    } = $props();
    let panelEl = $state(null);

    let col = $derived(table?.columns?.find((c) => c.id === colId) ?? null);

    let localFormula = $state("");
    let localIsNonEntry = $state(false);
    let formulaInputEl = $state(null);
    let showRef = $state(false);

    $effect(() => {
        if (col) {
            localFormula = col.defaultFormula ?? "";
            localIsNonEntry = col.isNonEntry ?? false;
        }
    });

    function applyFormula() {
        if (!table || !colId) return;
        table.setColumnDefaultFormula(colId, localFormula.trim() || null);
    }

    function clearFormula() {
        localFormula = "";
        table?.setColumnDefaultFormula(colId, null);
    }

    function handleIsNonEntryChange() {
        if (!table || !colId) return;
        table.setColumnIsNonEntry(colId, localIsNonEntry);
    }

    function handleDelete() {
        if (!table || !colId) return;
        if (table.columns.length <= 1) return;
        table.deleteColumn(colId);
        onClose?.();
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            onClose?.();
        }
    }

    function insertAtCursor(text) {
        if (!formulaInputEl) {
            localFormula += text;
            return;
        }
        const start = formulaInputEl.selectionStart ?? localFormula.length;
        const end = formulaInputEl.selectionEnd ?? localFormula.length;
        localFormula = localFormula.slice(0, start) + text + localFormula.slice(end);
        setTimeout(() => {
            formulaInputEl?.focus();
            formulaInputEl?.setSelectionRange(start + text.length, start + text.length);
        }, 0);
    }

    /** All columns except this one (for chip insertion) */
    let otherCols = $derived(
        (table?.columns ?? []).filter(c => c.id !== colId)
    );

    /** Live preview: compute formula for first 3 rows */
    let previewRows = $derived.by(() => {
        if (!localFormula.trim() || !table) return [];
        const count = Math.min(3, table.sortedFilteredRows.length);
        const results = [];
        const labelCol = otherCols[0];
        for (let i = 0; i < count; i++) {
            try {
                const val = table.evaluateFormula(localFormula.trim(), i);
                const row = table.sortedFilteredRows[i];
                const label = labelCol ? String(row?.[labelCol.id] ?? '').slice(0, 20) : `Row ${i + 1}`;
                results.push({ label, value: val });
            } catch {
                results.push({ label: `Row ${i + 1}`, value: null });
            }
        }
        return results;
    });

    let hasFormula = $derived(!!localFormula.trim());
    let canDelete = $derived(table ? table.columns.length > 1 : false);

    const REF_SECTIONS = [
        {
            title: "Current row values",
            items: [
                { syntax: "{colName}", desc: "Value from this row's column" },
                { syntax: "ROW", desc: "0-based row index" },
                { syntax: "ROW1", desc: "1-based row index" },
                { syntax: "COUNT", desc: "Total row count" },
            ]
        },
        {
            title: "Row reference helpers",
            items: [
                { syntax: "PREV(col)", desc: "Computed value in previous row (0 if none)" },
                { syntax: "PREV(col, default)", desc: "Computed value in previous row with fallback" },
                { syntax: "NEXT(col)", desc: "Computed value in next row (null if none)" },
                { syntax: "ROWVAL(col, n)", desc: "Computed value of col at row index n" },
                { syntax: "WINDOW(col, before)", desc: "Array of col values [ROW-before…ROW]" },
                { syntax: "WINDOW(col, before, after)", desc: "Array of col values [ROW-before…ROW+after]" },
            ]
        },
        {
            title: "Running aggregates (up to this row)",
            items: [
                { syntax: 'RUNNINGIF(sum, filter, "op", val)', desc: "Running sum where condition met" },
                { syntax: 'RUNNINGIFS(sum, col1,"op1",val1, ...)', desc: "Running sum, multiple conditions" },
            ]
        },
        {
            title: "Whole-column aggregates",
            items: [
                { syntax: "SUM(col), AVG(col), MIN(col), MAX(col)", desc: "Total / average / min / max" },
                { syntax: 'SUMIF(sum, filter, "op", val)', desc: "Sum where condition met" },
                { syntax: 'SUMIFS(sum, col1,"op1",val1, ...)', desc: "Sum, multiple conditions" },
                { syntax: 'COUNTIF(filter, "op", val)', desc: "Count where condition met" },
                { syntax: 'AVGIF(sum, filter, "op", val)', desc: "Average where condition met" },
            ]
        },
        {
            title: "Logic & arithmetic",
            items: [
                { syntax: "{price} * {qty}", desc: "Arithmetic over columns" },
                { syntax: 'IF({status} = "done", 1, 0)', desc: "Conditional value" },
                { syntax: 'IF({type}="income", {amount}, -{amount})', desc: "Signed amount" },
            ]
        },
        {
            title: "Operators for op argument",
            items: [
                { syntax: '"="  "<>"  ">"  "<"  ">="  "<="', desc: "Numeric / string compare" },
                { syntax: '"contains"  "startswith"  "notcontains"', desc: "Text match" },
            ]
        }
    ];

    onMount(() => {
        if (!(mobileState.isMobile && !inline)) panelEl?.focus();
    });
</script>

{#snippet colPanelContent()}
    <div class="panel-body">
        <!-- Default formula section -->
        <section class="section">
            <div class="section-label">Default Formula</div>
            <div class="section-sublabel" style="margin-bottom:6px;">
                Evaluated when a row is inserted. Value is stored — can be overridden by editing.
            </div>

            <div class="formula-input-row">
                <span class="fx-badge">fx</span>
                <input
                    bind:this={formulaInputEl}
                    class="formula-input"
                    type="text"
                    bind:value={localFormula}
                    placeholder="e.g. {'{amount}'} + PREV(balance, 0)"
                    onblur={applyFormula}
                    onkeydown={(e) => {
                        if (e.key === "Enter") { e.stopPropagation(); applyFormula(); }
                    }}
                />
                {#if hasFormula}
                    <button class="clear-formula-btn" onclick={clearFormula} title="Clear formula">×</button>
                {/if}
            </div>

            {#if hasFormula}
                <div class="formula-quick-hint">
                    Use <code>{'{'}colName{'}'}</code> · <code>PREV(col)</code> prior row · <code>WINDOW(col, n)</code> sliding range
                </div>

                <!-- Column chips -->
                {#if otherCols.length > 0}
                    <div class="chips-label">Insert column reference:</div>
                    <div class="chips-row">
                        {#each otherCols as c}
                            <button
                                class="col-chip"
                                onclick={() => insertAtCursor(`{${c.name}}`)}
                                title="Insert {c.name}"
                            >{c.name}</button>
                        {/each}
                    </div>
                {/if}

                <!-- Live preview -->
                {#if previewRows.length > 0}
                    <div class="preview-label">Preview:</div>
                    <div class="preview-table">
                        {#each previewRows as row}
                            <div class="preview-row">
                                <span class="preview-key">{row.label}</span>
                                <span class="preview-val" class:preview-null={row.value === null}>
                                    {row.value === null ? '—' : String(row.value)}
                                </span>
                            </div>
                        {/each}
                    </div>
                {/if}

                <!-- Formula reference -->
                <div class="ref-toggle">
                    <button class="ref-toggle-btn" onclick={() => showRef = !showRef}>
                        {showRef ? '▾' : '▸'} Formula reference
                    </button>
                </div>

                {#if showRef}
                    <div class="ref-panel">
                        {#each REF_SECTIONS as section}
                            <div class="ref-section">
                                <div class="ref-section-title">{section.title}</div>
                                {#each section.items as item}
                                    <div class="ref-item">
                                        <code class="ref-syntax">{item.syntax}</code>
                                        <span class="ref-desc">{item.desc}</span>
                                    </div>
                                {/each}
                            </div>
                        {/each}
                        <div class="ref-examples">
                            <div class="ref-section-title">Examples</div>
                            <div class="ref-example">
                                <code>{'{amount}'} + PREV(balance, 0)</code>
                                <span class="ref-desc">Running balance (cumulative sum)</span>
                            </div>
                            <div class="ref-example">
                                <code>AVERAGE(WINDOW(amount, 2))</code>
                                <span class="ref-desc">3-row sliding average</span>
                            </div>
                            <div class="ref-example">
                                <code>RUNNINGIF(amount, account, "=", {"{account}"})</code>
                                <span class="ref-desc">Running balance per account</span>
                            </div>
                            <div class="ref-example">
                                <code>IF({"{type}"} = "income", {"{amount}"}, -{"{amount}"})</code>
                                <span class="ref-desc">Signed transaction amount</span>
                            </div>
                        </div>
                    </div>
                {/if}
            {/if}
        </section>

        <!-- Read-only toggle -->
        <section class="section">
            <label class="toggle-label">
                <div>
                    <div class="section-label" style="margin:0;">Read-only</div>
                    <div class="section-sublabel">Prevent direct editing of this column</div>
                </div>
                <div class="toggle-wrapper">
                    <input
                        type="checkbox"
                        class="toggle-input"
                        bind:checked={localIsNonEntry}
                        onchange={handleIsNonEntryChange}
                    />
                    <div class="toggle-track" class:on={localIsNonEntry}></div>
                </div>
            </label>
            {#if localIsNonEntry && hasFormula}
                <div class="computed-note">
                    With both default formula and read-only set, this column is always computed and never stored.
                </div>
            {/if}
        </section>
    </div>

    <div class="panel-footer">
        <button
            class="delete-btn"
            onclick={handleDelete}
            disabled={!canDelete}
            title={canDelete ? "Delete this column" : "Cannot delete the only column"}
        >
            {@html trash} Delete Column
        </button>
    </div>
{/snippet}

{#if mobileState.isMobile && !inline}
    <BottomSheet open={true} onClose={onClose} title="Column Settings" maxHeight="85vh">
        {@render colPanelContent()}
    </BottomSheet>
{:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div bind:this={panelEl} class="col-panel" onkeydown={handleKeydown} role="dialog" aria-label="Column settings" tabindex="-1">
        <div class="panel-header">
            <span class="panel-title">Column</span>
            <button class="close-btn" onclick={() => onClose?.()} aria-label="Close">{@html close}</button>
        </div>
        {@render colPanelContent()}
    </div>
{/if}

<style>
    .col-panel {
        background: var(--cell-bg, #fff);
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.16);
        width: 280px;
        font-size: 12px;
        color: var(--text-color, #1e293b);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: min(78vh, 660px);
    }

    .panel-header {
        display: flex;
        align-items: center;
        padding: 8px 10px;
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        background: var(--table-header-bg, #f8fafc);
    }

    .panel-title {
        flex: 1;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-color, #1e293b);
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #94a3b8;
        padding: 2px;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
    }

    .close-btn:hover { background: #e2e8f0; color: #475569; }

    .panel-body {
        padding: 4px 0;
        overflow-y: auto;
        flex: 1;
    }

    .section {
        padding: 8px 12px;
        border-bottom: 1px solid var(--border-color, #f1f5f9);
    }
    .section:last-child { border-bottom: none; }

    .section-label {
        font-size: 10px;
        font-weight: 600;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 4px;
    }

    .section-sublabel {
        font-size: 10px;
        color: #94a3b8;
        margin-top: 1px;
    }

    .computed-note {
        font-size: 9px;
        color: #7c3aed;
        background: #f5f3ff;
        border-radius: 3px;
        padding: 3px 6px;
        margin-top: 6px;
        line-height: 1.4;
    }

    .toggle-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        cursor: pointer;
        gap: 8px;
    }

    .toggle-wrapper { position: relative; flex-shrink: 0; }
    .toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }

    .toggle-track {
        width: 28px;
        height: 16px;
        background: #cbd5e1;
        border-radius: 8px;
        position: relative;
        transition: background 0.15s;
    }

    .toggle-track::after {
        content: "";
        position: absolute;
        left: 2px;
        top: 2px;
        width: 12px;
        height: 12px;
        background: white;
        border-radius: 50%;
        transition: transform 0.15s;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }

    .toggle-track.on { background: #475569; }
    .toggle-track.on::after { transform: translateX(12px); }

    .formula-input-row {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 6px;
    }

    .fx-badge {
        font-size: 10px;
        font-weight: 600;
        color: #64748b;
        background: #f1f5f9;
        padding: 1px 5px;
        border-radius: 3px;
        flex-shrink: 0;
        font-family: monospace;
    }

    .formula-input {
        flex: 1;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        padding: 4px 6px;
        font-size: 11px;
        font-family: monospace;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
        min-width: 0;
    }

    .formula-input:focus { border-color: #94a3b8; }

    .clear-formula-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #94a3b8;
        font-size: 14px;
        padding: 0 2px;
        flex-shrink: 0;
        line-height: 1;
    }
    .clear-formula-btn:hover { color: #475569; }

    .formula-quick-hint {
        font-size: 9px;
        color: #94a3b8;
        line-height: 1.5;
        margin-bottom: 5px;
    }

    .formula-quick-hint code {
        font-family: monospace;
        font-size: 9px;
        background: #f1f5f9;
        color: #475569;
        padding: 0 3px;
        border-radius: 2px;
    }

    .chips-label {
        font-size: 9px;
        color: #94a3b8;
        margin-bottom: 3px;
    }

    .chips-row {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
        margin-bottom: 6px;
    }

    .col-chip {
        font-size: 10px;
        font-family: monospace;
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        padding: 1px 6px;
        cursor: pointer;
        color: #475569;
        white-space: nowrap;
        max-width: 90px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .col-chip:hover { background: #e2e8f0; border-color: #94a3b8; color: #1e293b; }

    .preview-label {
        font-size: 9px;
        font-weight: 600;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 3px;
    }

    .preview-table {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 6px;
    }

    .preview-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 6px;
        font-size: 10px;
        border-bottom: 1px solid #f1f5f9;
    }
    .preview-row:last-child { border-bottom: none; }

    .preview-key {
        color: #64748b;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .preview-val {
        font-family: monospace;
        color: #1e293b;
        font-weight: 600;
        flex-shrink: 0;
        margin-left: 6px;
    }

    .preview-val.preview-null { color: #94a3b8; font-weight: 400; }

    .ref-toggle { margin-bottom: 2px; }

    .ref-toggle-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 10px;
        color: #64748b;
        padding: 2px 0;
        font-weight: 600;
    }

    .ref-toggle-btn:hover { color: #475569; }

    .ref-panel {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        padding: 6px 8px;
        max-height: 240px;
        overflow-y: auto;
    }

    .ref-section {
        margin-bottom: 8px;
    }
    .ref-section:last-child { margin-bottom: 0; }

    .ref-section-title {
        font-size: 9px;
        font-weight: 700;
        color: #475569;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 3px;
        padding-bottom: 2px;
        border-bottom: 1px solid #e2e8f0;
    }

    .ref-item, .ref-example {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        margin-bottom: 2px;
        flex-wrap: wrap;
    }

    .ref-syntax, .ref-panel code {
        font-size: 9px;
        font-family: monospace;
        background: #e8f0fe;
        color: #1e40af;
        padding: 1px 4px;
        border-radius: 2px;
        white-space: nowrap;
    }

    .ref-desc {
        font-size: 9px;
        color: #64748b;
        line-height: 1.4;
    }

    .ref-examples { margin-top: 4px; }

    .panel-footer {
        padding: 8px 12px;
        border-top: 1px solid var(--cell-border, #e2e8f0);
        background: var(--table-header-bg, #f8fafc);
    }

    .delete-btn {
        background: none;
        border: 1px solid #fca5a5;
        border-radius: 4px;
        padding: 4px 10px;
        font-size: 11px;
        color: #dc2626;
        cursor: pointer;
        width: 100%;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .delete-btn:hover:not(:disabled) { background: #fef2f2; }
    .delete-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    @media (max-width: 600px) {
        .section { padding: 12px 16px; }
        .section-label { font-size: 11px; margin-bottom: 8px; }
        .toggle-label { min-height: 44px; }
        .formula-input { font-size: 14px; padding: 8px; }
        .col-chip { font-size: 12px; padding: 6px 10px; }
        .delete-btn { padding: 12px 14px; font-size: 13px; min-height: 44px; }
    }
</style>
