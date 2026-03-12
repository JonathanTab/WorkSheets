<script>
    /**
     * TableColumnPanel - Full column configuration panel
     *
     * Floats near the column header. Allows:
     *   - Rename column
     *   - Change type (grid of type buttons)
     *   - Toggle required
     *   - Set alignment (L/C/R)
     *   - Toggle formula column + enter formula
     *   - Add one conditional format rule
     *   - Delete column
     */

    import { CellTypeRegistry } from "../../../stores/spreadsheet/cellTypes/index.js";
    import { COLUMN_TYPE_ICONS } from "../../../stores/spreadsheet/features/TableStore.svelte.js";

    let {
        /** @type {import('../../../stores/spreadsheet/features/TableStore.svelte.js').TableStore} */
        table,
        /** Column ID to configure */
        colId,
        onClose,
    } = $props();

    let col = $derived(table?.columns?.find((c) => c.id === colId) ?? null);

    // Local form state (initialized from col)
    let localName = $state("");
    let localType = $state("text");
    let localRequired = $state(false);
    let localHAlign = $state(null);
    let localIsFormula = $state(false);
    let localFormula = $state("");
    let localCondFmt = $state(null); // single rule: { condition, value, style }

    // Initialize when col changes
    $effect(() => {
        if (col) {
            localName = col.name ?? "";
            localType = col.type ?? "text";
            localRequired = col.required ?? false;
            localHAlign = col.hAlign ?? null;
            localIsFormula = col.isNonEntry ?? false;
            localFormula = col.formula ?? "";
            localCondFmt = col.conditionalFormats?.[0] ?? null;
        }
    });

    const ALL_TYPES = [
        { id: "text", label: "Text", icon: "A" },
        { id: "number", label: "Number", icon: "#" },
        { id: "currency", label: "Currency", icon: "$" },
        { id: "percent", label: "Percent", icon: "%" },
        { id: "date", label: "Date", icon: "📅" },
        { id: "checkbox", label: "Checkbox", icon: "✓" },
        { id: "rating", label: "Rating", icon: "★" },
        { id: "url", label: "URL", icon: "🔗" },
    ];

    const ALIGN_OPTIONS = [
        { value: null, label: "Auto", icon: "≡" },
        { value: "left", label: "Left", icon: "⬅" },
        { value: "center", label: "Center", icon: "⬛" },
        { value: "right", label: "Right", icon: "➡" },
    ];

    const COND_OPS = [
        { value: "gt", label: "> Greater than" },
        { value: "lt", label: "< Less than" },
        { value: "gte", label: "≥ Greater or equal" },
        { value: "lte", label: "≤ Less or equal" },
        { value: "eq", label: "= Equals" },
        { value: "neq", label: "≠ Not equals" },
        { value: "contains", label: "Contains" },
    ];

    function applyName() {
        const n = localName.trim();
        if (!n || !table || !colId) return;
        table.renameColumn(colId, n);
    }

    function applyType(type) {
        localType = type;
        if (table && colId) table.updateColumnDef(colId, { type });
    }

    function applyRequired(val) {
        localRequired = val;
        if (table && colId) table.updateColumnDef(colId, { required: val });
    }

    function applyAlign(val) {
        localHAlign = val;
        if (table && colId) table.updateColumnDef(colId, { hAlign: val });
    }

    function applyFormula() {
        if (!table || !colId) return;
        if (localIsFormula && localFormula.trim()) {
            table.setColumnFormula(colId, localFormula.trim());
        } else if (!localIsFormula) {
            table.setColumnFormula(colId, null);
        }
    }

    function toggleFormula(val) {
        localIsFormula = val;
        if (!val) {
            localFormula = "";
            table?.setColumnFormula(colId, null);
        }
    }

    function applyCondFmt() {
        if (!table || !colId) return;
        const fmts = localCondFmt ? [localCondFmt] : [];
        table.updateColumnDef(colId, { conditionalFormats: fmts });
    }

    function addCondFmt() {
        localCondFmt = {
            condition: "gt",
            value: "0",
            style: { backgroundColor: "#fef3c7" },
        };
    }

    function removeCondFmt() {
        localCondFmt = null;
        applyCondFmt();
    }

    function handleDelete() {
        if (!table || !colId) return;
        if (table.columns.length <= 1) return; // don't delete last column
        table.deleteColumn(colId);
        onClose?.();
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            onClose?.();
        }
    }

    // Column name input: commit on Enter or blur
    function handleNameKeydown(e) {
        if (e.key === "Enter") {
            e.stopPropagation();
            applyName();
        } else if (e.key === "Escape") {
            e.stopPropagation();
            localName = col?.name ?? "";
        }
    }

    let formulaPlaceholder = $derived(
        localType === "number" ||
            localType === "currency" ||
            localType === "percent"
            ? "e.g. CUMSUM(amount) or {price}*{qty}"
            : "e.g. CUMSUM(amount)",
    );

    let canDelete = $derived(table ? table.columns.length > 1 : false);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="col-panel"
    onkeydown={handleKeydown}
    role="dialog"
    aria-label="Column settings"
>
    <!-- Header -->
    <div
        class="panel-header"
        style="--accent: {table?.accentColor ?? '#3b82f6'};"
    >
        <div class="accent-bar"></div>
        <div class="header-content">
            <span class="header-icon"
                >{COLUMN_TYPE_ICONS[localType] ?? "A"}</span
            >
            <input
                class="name-input"
                type="text"
                bind:value={localName}
                onblur={applyName}
                onkeydown={handleNameKeydown}
                placeholder="Column name"
            />
            <button
                class="close-btn"
                onclick={() => onClose?.()}
                aria-label="Close">✕</button
            >
        </div>
    </div>

    <div class="panel-body">
        <!-- Type picker -->
        <section class="section">
            <div class="section-label">Type</div>
            <div class="type-grid">
                {#each ALL_TYPES as t}
                    <button
                        class="type-btn"
                        class:active={localType === t.id}
                        onclick={() => applyType(t.id)}
                        title={t.label}
                    >
                        <span class="type-icon">{t.icon}</span>
                        <span class="type-label">{t.label}</span>
                    </button>
                {/each}
            </div>
        </section>

        <!-- Alignment -->
        <section class="section section-row">
            <div class="section-label">Alignment</div>
            <div class="align-group">
                {#each ALIGN_OPTIONS as opt}
                    <button
                        class="align-btn"
                        class:active={localHAlign === opt.value}
                        onclick={() => applyAlign(opt.value)}
                        title={opt.label}>{opt.icon}</button
                    >
                {/each}
            </div>
        </section>

        <!-- Required toggle -->
        <section class="section section-row">
            <label class="toggle-label">
                <span class="section-label" style="margin:0;">Required</span>
                <div class="toggle-wrapper">
                    <input
                        type="checkbox"
                        class="toggle-input"
                        bind:checked={localRequired}
                        onchange={() => applyRequired(localRequired)}
                    />
                    <div class="toggle-track" class:on={localRequired}></div>
                </div>
            </label>
        </section>

        <!-- Formula column -->
        <section class="section">
            <div class="section-row" style="margin-bottom:6px;">
                <label class="toggle-label">
                    <div>
                        <div class="section-label" style="margin:0;">
                            Computed column
                        </div>
                        <div class="section-sublabel">
                            Value is calculated, not entered
                        </div>
                    </div>
                    <div class="toggle-wrapper">
                        <input
                            type="checkbox"
                            class="toggle-input"
                            bind:checked={localIsFormula}
                            onchange={() => toggleFormula(localIsFormula)}
                        />
                        <div
                            class="toggle-track"
                            class:on={localIsFormula}
                        ></div>
                    </div>
                </label>
            </div>
            {#if localIsFormula}
                <div class="formula-input-row">
                    <span class="fx-badge">fx</span>
                    <input
                        class="formula-input"
                        type="text"
                        bind:value={localFormula}
                        placeholder={formulaPlaceholder}
                        onblur={applyFormula}
                        onkeydown={(e) => {
                            if (e.key === "Enter") {
                                e.stopPropagation();
                                applyFormula();
                            }
                        }}
                    />
                </div>
                <div class="formula-help">
                    <code>CUMSUM(colId)</code> • <code>SUM(colId)</code> •
                    <code>AVG(colId)</code>
                    •
                    <code>{"{colId}"}</code> for row values
                </div>
            {/if}
        </section>

        <!-- Conditional format (single rule) -->
        <section class="section">
            <div class="section-row" style="margin-bottom:4px;">
                <div class="section-label">Conditional format</div>
                {#if !localCondFmt}
                    <button class="add-rule-btn" onclick={addCondFmt}
                        >+ Add rule</button
                    >
                {/if}
            </div>
            {#if localCondFmt}
                <div class="cond-fmt-row">
                    <select
                        class="cond-select"
                        value={localCondFmt.condition}
                        onchange={(e) => {
                            localCondFmt = {
                                ...localCondFmt,
                                condition: e.currentTarget.value,
                            };
                        }}
                    >
                        {#each COND_OPS as op}
                            <option value={op.value}>{op.label}</option>
                        {/each}
                    </select>
                    <input
                        class="cond-value"
                        type="text"
                        value={localCondFmt.value ?? ""}
                        oninput={(e) => {
                            localCondFmt = {
                                ...localCondFmt,
                                value: e.currentTarget.value,
                            };
                        }}
                        placeholder="Value"
                    />
                </div>
                <div class="cond-fmt-style">
                    <label class="style-label">
                        <span>Bg</span>
                        <input
                            type="color"
                            value={localCondFmt.style?.backgroundColor ??
                                "#fef3c7"}
                            oninput={(e) => {
                                localCondFmt = {
                                    ...localCondFmt,
                                    style: {
                                        ...localCondFmt.style,
                                        backgroundColor: e.currentTarget.value,
                                    },
                                };
                            }}
                        />
                    </label>
                    <label class="style-label">
                        <span>Text</span>
                        <input
                            type="color"
                            value={localCondFmt.style?.color ?? "#000000"}
                            oninput={(e) => {
                                localCondFmt = {
                                    ...localCondFmt,
                                    style: {
                                        ...localCondFmt.style,
                                        color: e.currentTarget.value,
                                    },
                                };
                            }}
                        />
                    </label>
                    <label class="style-label checkbox-label">
                        <input
                            type="checkbox"
                            checked={localCondFmt.style?.bold ?? false}
                            onchange={(e) => {
                                localCondFmt = {
                                    ...localCondFmt,
                                    style: {
                                        ...localCondFmt.style,
                                        bold: e.currentTarget.checked,
                                    },
                                };
                            }}
                        />
                        <span>Bold</span>
                    </label>
                    <button class="apply-cond-btn" onclick={applyCondFmt}
                        >Apply</button
                    >
                    <button class="remove-cond-btn" onclick={removeCondFmt}
                        >✕</button
                    >
                </div>
            {/if}
        </section>
    </div>

    <!-- Footer -->
    <div class="panel-footer">
        <button
            class="delete-btn"
            onclick={handleDelete}
            disabled={!canDelete}
            title={canDelete
                ? "Delete this column"
                : "Cannot delete the only column"}
        >
            🗑 Delete Column
        </button>
    </div>
</div>

<style>
    .col-panel {
        background: var(--cell-bg, #fff);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.14);
        width: 260px;
        font-size: 12px;
        color: var(--text-color, #1e293b);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: 90vh;
    }

    .panel-header {
        position: relative;
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        background: var(--header-bg, #f8fafc);
    }

    .accent-bar {
        height: 3px;
        background: var(--accent);
        width: 100%;
    }

    .header-content {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
    }

    .header-icon {
        font-size: 14px;
        color: var(--color-text-secondary, #64748b);
        flex-shrink: 0;
    }

    .name-input {
        flex: 1;
        border: none;
        background: transparent;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-color, #1e293b);
        outline: none;
        min-width: 0;
        padding: 0;
    }

    .name-input:focus {
        border-bottom: 1.5px solid var(--color-primary, #3b82f6);
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #94a3b8;
        font-size: 12px;
        padding: 2px 4px;
        border-radius: 3px;
        flex-shrink: 0;
    }

    .close-btn:hover {
        background: #e2e8f0;
        color: #475569;
    }

    .panel-body {
        padding: 4px 0;
        overflow-y: auto;
        flex: 1;
    }

    .section {
        padding: 8px 12px;
        border-bottom: 1px solid var(--border-color, #f1f5f9);
    }

    .section:last-child {
        border-bottom: none;
    }

    .section-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .section-label {
        font-size: 10px;
        font-weight: 600;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 6px;
    }

    .section-sublabel {
        font-size: 10px;
        color: #94a3b8;
        margin-top: 1px;
    }

    /* Type grid */
    .type-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 4px;
    }

    .type-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 6px 4px;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 5px;
        background: var(--cell-bg, #fff);
        cursor: pointer;
        font-size: 10px;
        color: #64748b;
        transition: all 0.1s;
    }

    .type-btn:hover {
        background: var(--color-fill, #f1f5f9);
        border-color: #94a3b8;
    }

    .type-btn.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }

    .type-icon {
        font-size: 13px;
        line-height: 1;
    }

    .type-label {
        font-size: 9px;
    }

    /* Alignment */
    .align-group {
        display: flex;
        gap: 2px;
    }

    .align-btn {
        width: 26px;
        height: 24px;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 4px;
        background: var(--cell-bg, #fff);
        cursor: pointer;
        font-size: 11px;
        color: #64748b;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .align-btn:hover {
        background: var(--color-fill, #f1f5f9);
    }

    .align-btn.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }

    /* Toggle */
    .toggle-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        cursor: pointer;
        gap: 8px;
    }

    .toggle-wrapper {
        position: relative;
        flex-shrink: 0;
    }

    .toggle-input {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
    }

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

    .toggle-track.on {
        background: #3b82f6;
    }

    .toggle-track.on::after {
        transform: translateX(12px);
    }

    /* Formula */
    .formula-input-row {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 4px;
    }

    .fx-badge {
        font-size: 10px;
        font-weight: 600;
        color: #7c3aed;
        background: rgba(139, 92, 246, 0.1);
        padding: 1px 5px;
        border-radius: 3px;
        flex-shrink: 0;
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

    .formula-input:focus {
        border-color: #7c3aed;
    }

    .formula-help {
        font-size: 9px;
        color: #94a3b8;
        line-height: 1.6;
    }

    .formula-help code {
        background: #f1f5f9;
        padding: 0 3px;
        border-radius: 2px;
        font-family: monospace;
    }

    /* Conditional format */
    .add-rule-btn {
        font-size: 10px;
        color: #3b82f6;
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
    }

    .add-rule-btn:hover {
        text-decoration: underline;
    }

    .cond-fmt-row {
        display: flex;
        gap: 4px;
        margin-bottom: 6px;
    }

    .cond-select {
        flex: 1;
        font-size: 11px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        padding: 3px 4px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
    }

    .cond-value {
        width: 60px;
        font-size: 11px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        padding: 3px 5px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
    }

    .cond-fmt-style {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }

    .style-label {
        display: flex;
        align-items: center;
        gap: 3px;
        font-size: 10px;
        color: #64748b;
        cursor: pointer;
    }

    .style-label input[type="color"] {
        width: 20px;
        height: 20px;
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        padding: 1px;
        cursor: pointer;
    }

    .checkbox-label {
        gap: 3px;
    }

    .apply-cond-btn {
        font-size: 10px;
        padding: 3px 7px;
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        margin-left: auto;
    }

    .remove-cond-btn {
        font-size: 10px;
        color: #94a3b8;
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px 4px;
    }

    .remove-cond-btn:hover {
        color: #ef4444;
    }

    /* Footer */
    .panel-footer {
        padding: 8px 12px;
        border-top: 1px solid var(--border-color, #e2e8f0);
        background: var(--header-bg, #f8fafc);
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
    }

    .delete-btn:hover:not(:disabled) {
        background: #fef2f2;
    }

    .delete-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
</style>
