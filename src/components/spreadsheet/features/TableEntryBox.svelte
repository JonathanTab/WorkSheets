<script>
    import { close } from "../../../lib/icons/index.js";

    /**
     * TableEntryBox - Floating multi-row entry form
     *
     * A panel that sits above the grid and lets users compose one or more
     * rows before inserting them. Triggered by a toolbar button or a "+"
     * button in the entry row. Submits all rows in one Yjs transaction.
     */

    let { table, onclose = null } = $props();

    let columns = $derived(table?.columns ?? []);

    // Multi-row draft buffer (local state only, not in Yjs)
    let draftRows = $state([createBlankRow()]);
    let errors = $state([{}]);

    function createBlankRow() {
        const row = {};
        if (table) {
            for (const col of table.columns) {
                row[col.id] = "";
            }
        }
        return row;
    }

    function addRow() {
        draftRows = [...draftRows, createBlankRow()];
        errors = [...errors, {}];
    }

    function removeRow(idx) {
        if (draftRows.length <= 1) return;
        draftRows = draftRows.filter((_, i) => i !== idx);
        errors = errors.filter((_, i) => i !== idx);
    }

    function setField(rowIdx, colId, value) {
        draftRows = draftRows.map((r, i) =>
            i === rowIdx ? { ...r, [colId]: value } : r,
        );
        // Clear error for this field
        errors = errors.map((e, i) => {
            if (i !== rowIdx) return e;
            const next = { ...e };
            delete next[colId];
            return next;
        });
    }

    function validate() {
        let valid = true;
        const newErrors = draftRows.map((row) => {
            const rowErrors = {};
            for (const col of columns) {
                if (
                    col.required &&
                    (row[col.id] === undefined || row[col.id] === "")
                ) {
                    rowErrors[col.id] = "Required";
                    valid = false;
                }
            }
            return rowErrors;
        });
        errors = newErrors;
        return valid;
    }

    function submit() {
        if (!validate() || !table) return;
        for (const row of draftRows) {
            table.insertRow({ ...row });
        }
        draftRows = [createBlankRow()];
        errors = [{}];
        onclose?.();
    }

    function clear() {
        draftRows = [createBlankRow()];
        errors = [{}];
    }

    function handleKeydown(e) {
        if (e.key === "Escape") onclose?.();
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="entry-box"
    onkeydown={handleKeydown}
    role="dialog"
    aria-label="Table entry form"
>
    <div class="entry-box-header">
        <span class="entry-box-title"
            >{table?.name ?? "Table"} — New Entries</span
        >
        <button
            class="close-btn"
            onclick={() => onclose?.()}
            type="button"
            aria-label="Close">{@html close}</button
        >
    </div>

    <div class="entry-box-body">
        <!-- Column name row -->
        <div class="col-headers-row">
            <div class="row-num-cell"></div>
            {#each columns as col}
                <div class="col-header-cell" title={col.name}>
                    {col.name}
                    {#if col.required}<span class="req">*</span>{/if}
                </div>
            {/each}
            <div class="action-col"></div>
        </div>

        <!-- Draft rows -->
        {#each draftRows as row, rowIdx}
            <div class="draft-row">
                <div class="row-num-cell">{rowIdx + 1}</div>
                {#each columns as col}
                    <div
                        class="field-cell"
                        class:has-error={!!errors[rowIdx]?.[col.id]}
                    >
                        <input
                            type="text"
                            class="field-input"
                            value={row[col.id] ?? ""}
                            placeholder={col.name}
                            title={errors[rowIdx]?.[col.id] ?? col.name}
                            oninput={(e) =>
                                setField(rowIdx, col.id, e.target.value)}
                            onkeydown={(e) => e.key === "Enter" && submit()}
                        />
                        {#if errors[rowIdx]?.[col.id]}
                            <span class="field-error"
                                >{errors[rowIdx][col.id]}</span
                            >
                        {/if}
                    </div>
                {/each}
                <div class="action-col">
                    {#if draftRows.length > 1}
                        <button
                            class="remove-row-btn"
                            onclick={() => removeRow(rowIdx)}
                            type="button"
                            aria-label="Remove row">{@html close}</button
                        >
                    {/if}
                </div>
            </div>
        {/each}
    </div>

    <div class="entry-box-footer">
        <button class="add-row-btn" onclick={addRow} type="button"
            >+ Add row</button
        >
        <div class="footer-actions">
            <button class="clear-btn" onclick={clear} type="button"
                >Clear</button
            >
            <button class="submit-btn" onclick={submit} type="button"
                >Insert {draftRows.length} row{draftRows.length === 1
                    ? ""
                    : "s"}</button
            >
        </div>
    </div>
</div>

<style>
    .entry-box {
        display: flex;
        flex-direction: column;
        background: var(--surface-bg, #ffffff);
        border: 1px solid var(--table-header-border, #94a3b8);
        border-radius: 6px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
        min-width: 320px;
        max-width: 90vw;
        max-height: 80vh;
        overflow: hidden;
        font-size: 12px;
    }

    .entry-box-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: var(--table-header-bg, #f1f5f9);
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
    }

    .entry-box-title {
        font-weight: 600;
        color: var(--table-header-text, #334155);
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 14px;
        color: var(--muted, #64748b);
        padding: 2px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 3px;
    }

    .close-btn:hover {
        color: var(--text, #1e293b);
    }

    .entry-box-body {
        overflow-y: auto;
        flex: 1;
    }

    .col-headers-row,
    .draft-row {
        display: flex;
        align-items: stretch;
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
    }

    .col-headers-row {
        background: var(--table-header-bg, #f1f5f9);
        position: sticky;
        top: 0;
        z-index: 1;
    }

    .row-num-cell {
        width: 28px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--muted, #64748b);
        font-size: 10px;
        border-right: 1px solid var(--cell-border, #e2e8f0);
    }

    .col-header-cell {
        flex: 1;
        min-width: 80px;
        padding: 4px 6px;
        font-weight: 600;
        color: var(--table-header-text, #334155);
        border-right: 1px solid var(--cell-border, #e2e8f0);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .action-col {
        width: 28px;
        flex-shrink: 0;
    }

    .field-cell {
        flex: 1;
        min-width: 80px;
        position: relative;
        border-right: 1px solid var(--cell-border, #e2e8f0);
    }

    .field-cell.has-error .field-input {
        background: var(--entry-error-bg, #fef2f2);
    }

    .field-input {
        width: 100%;
        height: 28px;
        padding: 0 6px;
        border: none;
        background: transparent;
        outline: none;
        font-size: 12px;
        color: var(--cell-text, #1e293b);
        box-sizing: border-box;
    }

    .field-error {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        font-size: 9px;
        color: var(--required-color, #ef4444);
        padding: 0 4px;
        background: var(--entry-error-bg, #fef2f2);
        white-space: nowrap;
        overflow: hidden;
    }

    .remove-row-btn {
        width: 28px;
        height: 28px;
        background: none;
        border: none;
        cursor: pointer;
        color: var(--muted, #64748b);
        font-size: 11px;
    }

    .remove-row-btn:hover {
        color: var(--required-color, #ef4444);
    }

    .req {
        color: var(--required-color, #ef4444);
        margin-left: 2px;
    }

    .entry-box-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-top: 1px solid var(--cell-border, #e2e8f0);
        background: var(--surface-bg, #ffffff);
    }

    .add-row-btn {
        background: none;
        border: 1px dashed var(--cell-border, #e2e8f0);
        border-radius: 4px;
        padding: 4px 8px;
        cursor: pointer;
        color: var(--muted, #64748b);
        font-size: 11px;
    }

    .add-row-btn:hover {
        background: var(--table-header-bg, #f1f5f9);
    }

    .footer-actions {
        display: flex;
        gap: 6px;
    }

    .clear-btn {
        background: none;
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 4px;
        padding: 4px 10px;
        cursor: pointer;
        color: var(--muted, #64748b);
        font-size: 11px;
    }

    .submit-btn {
        background: var(--accent, #3b82f6);
        color: #fff;
        border: none;
        border-radius: 4px;
        padding: 4px 12px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
    }

    .submit-btn:hover {
        background: var(--accent-hover, #2563eb);
    }
</style>
