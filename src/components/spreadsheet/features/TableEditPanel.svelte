<script>
    /**
     * TableEditPanel - Enhanced floating panel for editing a table's settings.
     *
     * Features:
     *   - Editable table name (click to edit inline)
     *   - Column list with type badges, formula indicators, reorder handles
     *   - Add column button
     *   - Quick access to column config (click type badge)
     *   - Stats: row count, filter count, sort indicator
     *   - Export CSV
     *   - Delete table
     */

    import { COLUMN_TYPE_ICONS } from "../../../stores/spreadsheet/features/TableStore.svelte.js";
    import TableColumnPanel from "./TableColumnPanel.svelte";

    let {
        /** @type {import('../../../stores/spreadsheet/features/TableStore.svelte.js').TableStore} */
        table,
        /** @type {import('../../../stores/spreadsheet/features/TableManager.svelte.js').TableManager} */
        tableManager,
        onClose,
    } = $props();

    let columns = $derived(table?.columns ?? []);
    let rowCount = $derived(table?.sortedFilteredRows?.length ?? 0);
    let totalRows = $derived(table?.rows?.length ?? 0);
    let filterCount = $derived(Object.keys(table?.filters ?? {}).length);
    let isSorted = $derived(!!table?.sortColId);
    let accentColor = $derived(table?.accentColor ?? "#3b82f6");

    // Insert sort state
    let insertSortColId = $derived(table?.insertSortColId ?? null);
    let insertSortDir = $derived(table?.insertSortDir ?? "asc");

    function handleInsertSortColChange(e) {
        const colId = e.currentTarget.value;
        if (!colId) {
            table?.clearInsertSort();
        } else {
            table?.setInsertSort(colId, insertSortDir);
        }
    }

    function handleInsertSortDirToggle() {
        if (!insertSortColId) return;
        table?.setInsertSort(insertSortColId, insertSortDir === "asc" ? "desc" : "asc");
    }

    // Position management
    let editingPosition = $state(false);
    let posRow = $state(0);
    let posCol = $state(0);

    function startPositionEdit() {
        posRow = table?.startRow ?? 0;
        posCol = table?.startCol ?? 0;
        editingPosition = true;
    }

    function commitPosition() {
        const r = parseInt(String(posRow), 10);
        const c = parseInt(String(posCol), 10);
        if (!isNaN(r) && !isNaN(c) && r >= 0 && c >= 0) {
            table?.moveTo(r, c);
        }
        editingPosition = false;
    }

    function cancelPosition() {
        editingPosition = false;
    }

    // Accent color
    const ACCENT_COLORS = [
        '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
        '#ef4444', '#06b6d4', '#ec4899', '#84cc16',
    ];

    // Table name editing
    let editingName = $state(false);
    let editingNameValue = $state("");

    function startNameEdit() {
        editingNameValue = table?.name ?? "";
        editingName = true;
    }

    function commitNameEdit() {
        const name = editingNameValue.trim();
        if (name && table) table.rename(name);
        editingName = false;
    }

    function cancelNameEdit() {
        editingName = false;
    }

    // Column name editing
    /** @type {string|null} */
    let editingColId = $state(null);
    let editingColName = $state("");

    function startEditColName(col) {
        editingColId = col.id;
        editingColName = col.name;
    }

    function commitColRename() {
        if (!editingColId || !table) return;
        const name = editingColName.trim();
        if (name) table.renameColumn(editingColId, name);
        editingColId = null;
    }

    function cancelColRename() {
        editingColId = null;
    }

    // Column panel (configure column)
    /** @type {string|null} */
    let configColId = $state(null);

    function openColConfig(colId) {
        configColId = configColId === colId ? null : colId;
    }

    // Add column
    function handleAddColumn() {
        if (!table) return;
        const newIdx = table.columns.length;
        const newId = `col${Date.now()}`;
        table.insertColumn(newIdx, {
            id: newId,
            name: `Column ${newIdx + 1}`,
            type: "text",
        });
        // Open config for new column
        configColId = newId;
    }

    // Delete table
    function handleDelete() {
        if (tableManager && table) {
            tableManager.deleteTable(table.id);
        }
        onClose?.();
    }

    // Export CSV
    function handleExportCSV() {
        if (!table) return;
        const csv = table.exportCSV();
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${table.name ?? "table"}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // Drag-to-reorder columns
    let dragFromIndex = $state(-1);
    let dragOverIndex = $state(-1);

    function handleDragStart(e, index) {
        dragFromIndex = index;
        e.dataTransfer?.setData("text/plain", String(index));
    }

    function handleDragOver(e, index) {
        e.preventDefault();
        dragOverIndex = index;
    }

    function handleDrop(e, index) {
        e.preventDefault();
        if (dragFromIndex >= 0 && dragFromIndex !== index) {
            table?.reorderColumns(dragFromIndex, index);
        }
        dragFromIndex = -1;
        dragOverIndex = -1;
    }

    function handleDragEnd() {
        dragFromIndex = -1;
        dragOverIndex = -1;
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            if (configColId) {
                configColId = null;
            } else if (editingColId) {
                cancelColRename();
            } else if (editingName) {
                cancelNameEdit();
            } else {
                onClose?.();
            }
        }
    }

    function colTypeLabel(col) {
        return col.type ?? "text";
    }

    function colTypeIcon(col) {
        if (col.isNonEntry) return "fx";
        return COLUMN_TYPE_ICONS[col.type] ?? "A";
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="table-edit-panel"
    onkeydown={handleKeydown}
    role="dialog"
    aria-label="Table settings"
>
    <!-- Accent top bar -->
    <div class="accent-top" style="background:{accentColor};"></div>

    <!-- Header -->
    <div class="panel-header">
        <span class="panel-icon" style="color:{accentColor};">⊞</span>
        {#if editingName}
            <input
                class="name-edit-input"
                type="text"
                bind:value={editingNameValue}
                onblur={commitNameEdit}
                onkeydown={(e) => {
                    if (e.key === "Enter") {
                        e.stopPropagation();
                        commitNameEdit();
                    } else if (e.key === "Escape") {
                        e.stopPropagation();
                        cancelNameEdit();
                    }
                }}
                autofocus
            />
        {:else}
            <button
                class="name-btn"
                onclick={startNameEdit}
                title="Click to rename"
            >
                {table?.name ?? "Table"}
            </button>
        {/if}
        <span class="row-count">{rowCount} row{rowCount !== 1 ? "s" : ""}</span>
        <button class="close-btn" onclick={() => onClose?.()} aria-label="Close"
            >✕</button
        >
    </div>

    <!-- Stats bar -->
    {#if filterCount > 0 || isSorted}
        <div class="stats-bar">
            {#if filterCount > 0}
                <span class="stat-pill filter">
                    ☰ {filterCount} filter{filterCount > 1 ? "s" : ""}
                </span>
            {/if}
            {#if isSorted}
                <span class="stat-pill sort">
                    {table?.sortDir === "asc" ? "▲" : "▼"}
                    {table?.columns?.find((c) => c.id === table.sortColId)
                        ?.name ?? ""}
                </span>
            {/if}
            {#if totalRows !== rowCount}
                <span class="stat-pill muted">
                    {totalRows} total
                </span>
            {/if}
        </div>
    {/if}

    <!-- Column list -->
    <div class="panel-body">
        <div class="col-section-label">Columns</div>
        <div class="col-list">
            {#each columns as col, idx (col.id)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="col-item"
                    class:dragging={dragFromIndex === idx}
                    class:drag-over={dragOverIndex === idx &&
                        dragFromIndex !== idx}
                    draggable="true"
                    ondragstart={(e) => handleDragStart(e, idx)}
                    ondragover={(e) => handleDragOver(e, idx)}
                    ondrop={(e) => handleDrop(e, idx)}
                    ondragend={handleDragEnd}
                >
                    <!-- Drag handle -->
                    <span class="drag-handle" title="Drag to reorder">⠿</span>

                    <!-- Type badge (click to configure) -->
                    <button
                        class="type-badge"
                        class:formula-badge={col.isNonEntry}
                        onclick={() => openColConfig(col.id)}
                        title="Configure column: {colTypeLabel(col)}"
                        style={col.isNonEntry ? "" : ""}
                    >
                        {colTypeIcon(col)}
                    </button>

                    <!-- Column name -->
                    {#if editingColId === col.id}
                        <input
                            type="text"
                            class="col-name-input"
                            bind:value={editingColName}
                            onblur={commitColRename}
                            onkeydown={(e) => {
                                if (e.key === "Enter") {
                                    e.stopPropagation();
                                    commitColRename();
                                } else if (e.key === "Escape") {
                                    e.stopPropagation();
                                    cancelColRename();
                                }
                            }}
                            autofocus
                        />
                    {:else}
                        <span
                            class="col-name"
                            role="button"
                            tabindex="0"
                            title="Double-click to rename"
                            ondblclick={() => startEditColName(col)}
                            onkeydown={(e) => {
                                if (e.key === "Enter") startEditColName(col);
                            }}
                        >
                            {col.name}
                        </span>
                    {/if}

                    <!-- Required indicator -->
                    {#if col.required}
                        <span class="required-dot" title="Required">*</span>
                    {/if}
                </div>

                <!-- Inline column config panel -->
                {#if configColId === col.id}
                    <div class="col-config-inline">
                        <TableColumnPanel
                            {table}
                            colId={col.id}
                            onClose={() => (configColId = null)}
                        />
                    </div>
                {/if}
            {/each}

            {#if columns.length === 0}
                <span class="muted-note">No columns</span>
            {/if}
        </div>

        <!-- Add column -->
        <button class="add-col-btn" onclick={handleAddColumn}>
            + Add column
        </button>

        <!-- Sort on insert -->
        <div class="section-divider"></div>
        <div class="col-section-label">Sort on Insert</div>
        <div class="insert-sort-row">
            <select
                class="sort-col-select"
                value={insertSortColId ?? ""}
                onchange={handleInsertSortColChange}
            >
                <option value="">— none —</option>
                {#each columns.filter(c => !c.isNonEntry) as col}
                    <option value={col.id}>{col.name}</option>
                {/each}
            </select>
            {#if insertSortColId}
                <button
                    class="sort-dir-btn"
                    onclick={handleInsertSortDirToggle}
                    title="Toggle direction"
                >
                    {insertSortDir === "asc" ? "▲ Asc" : "▼ Desc"}
                </button>
            {/if}
        </div>

        <!-- Position -->
        <div class="section-divider"></div>
        <div class="col-section-label">Position</div>
        {#if editingPosition}
            <div class="position-edit-row">
                <label class="pos-label">Row</label>
                <input type="number" class="pos-input" bind:value={posRow} min="0" />
                <label class="pos-label">Col</label>
                <input type="number" class="pos-input" bind:value={posCol} min="0" />
                <button class="pos-ok-btn" onclick={commitPosition}>✓</button>
                <button class="pos-cancel-btn" onclick={cancelPosition}>✕</button>
            </div>
        {:else}
            <div class="position-display-row">
                <span class="pos-value">Row {table?.startRow ?? 0}, Col {table?.startCol ?? 0}</span>
                <button class="pos-edit-btn" onclick={startPositionEdit} title="Move table">Move…</button>
            </div>
        {/if}

        <!-- Accent color -->
        <div class="section-divider"></div>
        <div class="col-section-label">Accent Color</div>
        <div class="accent-color-row">
            {#each ACCENT_COLORS as color}
                <button
                    class="color-swatch"
                    class:active={accentColor === color}
                    style="background:{color};"
                    onclick={() => table?.setAccentColor(color)}
                    title={color}
                    aria-label={color}
                ></button>
            {/each}
        </div>
    </div>

    <!-- Footer -->
    <div class="panel-footer">
        <button
            class="export-btn"
            onclick={handleExportCSV}
            title="Export as CSV"
        >
            ↓ Export CSV
        </button>
        <button class="delete-btn" onclick={handleDelete}>
            🗑 Delete Table
        </button>
    </div>
</div>

<style>
    .table-edit-panel {
        background: var(--cell-bg, #fff);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.14);
        width: 250px;
        font-size: 12px;
        color: var(--text-color, #1e293b);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: 80vh;
    }

    .accent-top {
        height: 3px;
        width: 100%;
        flex-shrink: 0;
    }

    .panel-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px 6px;
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        background: var(--header-bg, #f8fafc);
        flex-shrink: 0;
    }

    .panel-icon {
        font-size: 14px;
        flex-shrink: 0;
    }

    .name-btn {
        flex: 1;
        background: none;
        border: none;
        font-weight: 600;
        font-size: 12px;
        color: var(--text-color, #1e293b);
        cursor: pointer;
        text-align: left;
        padding: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-bottom: 1px dashed transparent;
        min-width: 0;
    }

    .name-btn:hover {
        border-bottom-color: #cbd5e1;
        color: #3b82f6;
    }

    .name-edit-input {
        flex: 1;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid #3b82f6;
        border-radius: 3px;
        padding: 1px 5px;
        outline: none;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        min-width: 0;
    }

    .row-count {
        font-size: 10px;
        color: #94a3b8;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #94a3b8;
        font-size: 12px;
        padding: 0 2px;
        line-height: 1;
        border-radius: 3px;
        flex-shrink: 0;
    }

    .close-btn:hover {
        color: #475569;
        background: #e2e8f0;
    }

    /* Stats bar */
    .stats-bar {
        display: flex;
        gap: 4px;
        padding: 4px 10px;
        background: var(--header-bg, #f8fafc);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        flex-shrink: 0;
        flex-wrap: wrap;
    }

    .stat-pill {
        font-size: 9px;
        padding: 1px 6px;
        border-radius: 8px;
        font-weight: 500;
    }

    .stat-pill.filter {
        background: #eff6ff;
        color: #1d4ed8;
    }

    .stat-pill.sort {
        background: #f0fdf4;
        color: #15803d;
    }

    .stat-pill.muted {
        background: #f1f5f9;
        color: #64748b;
    }

    /* Body */
    .panel-body {
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        overflow-y: auto;
        flex: 1;
    }

    .col-section-label {
        font-size: 10px;
        font-weight: 600;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 2px;
    }

    .col-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
    }

    .col-item {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 4px 4px;
        border-radius: 4px;
        transition: background 0.1s;
        cursor: default;
    }

    .col-item:hover {
        background: var(--header-bg, #f8fafc);
    }

    .col-item.drag-over {
        border-top: 2px solid #3b82f6;
    }

    .col-item.dragging {
        opacity: 0.4;
    }

    .drag-handle {
        color: #cbd5e1;
        cursor: grab;
        font-size: 11px;
        flex-shrink: 0;
        user-select: none;
    }

    .drag-handle:hover {
        color: #94a3b8;
    }

    .drag-handle:active {
        cursor: grabbing;
    }

    .type-badge {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 3px;
        background: #e0e7ff;
        color: #4338ca;
        font-weight: 500;
        min-width: 20px;
        text-align: center;
        flex-shrink: 0;
        border: none;
        cursor: pointer;
        transition: all 0.1s;
        line-height: 16px;
        height: 16px;
    }

    .type-badge:hover {
        background: #c7d2fe;
    }

    .type-badge.formula-badge {
        background: rgba(139, 92, 246, 0.12);
        color: #7c3aed;
    }

    .type-badge.formula-badge:hover {
        background: rgba(139, 92, 246, 0.22);
    }

    .col-name {
        flex: 1;
        font-size: 12px;
        cursor: pointer;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-bottom: 1px dashed transparent;
    }

    .col-name:hover {
        border-bottom-color: #cbd5e1;
        color: #3b82f6;
    }

    .col-name-input {
        flex: 1;
        font-size: 12px;
        border: 1px solid #3b82f6;
        border-radius: 3px;
        padding: 1px 4px;
        outline: none;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        min-width: 0;
    }

    .required-dot {
        color: #ef4444;
        font-size: 11px;
        flex-shrink: 0;
    }

    /* Inline column config */
    .col-config-inline {
        margin: 2px 0 6px 16px;
        border-left: 2px solid #e2e8f0;
        padding-left: 6px;
    }

    /* Section divider */
    .section-divider {
        height: 1px;
        background: var(--border-color, #e2e8f0);
        margin: 4px 0;
    }

    /* Insert sort */
    .insert-sort-row {
        display: flex;
        gap: 4px;
        align-items: center;
    }

    .sort-col-select {
        flex: 1;
        height: 26px;
        font-size: 11px;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 4px;
        padding: 0 4px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
        min-width: 0;
    }

    .sort-col-select:focus {
        border-color: #3b82f6;
    }

    .sort-dir-btn {
        height: 26px;
        padding: 0 8px;
        font-size: 10px;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 4px;
        background: #f1f5f9;
        color: #475569;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        transition: all 0.1s;
    }

    .sort-dir-btn:hover {
        background: #e2e8f0;
    }

    /* Position */
    .position-display-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .pos-value {
        flex: 1;
        font-size: 11px;
        color: #64748b;
    }

    .pos-edit-btn {
        font-size: 10px;
        padding: 2px 6px;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 3px;
        background: none;
        color: #64748b;
        cursor: pointer;
        transition: all 0.1s;
    }

    .pos-edit-btn:hover {
        background: #f1f5f9;
        border-color: #3b82f6;
        color: #3b82f6;
    }

    .position-edit-row {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
    }

    .pos-label {
        font-size: 10px;
        color: #64748b;
    }

    .pos-input {
        width: 48px;
        height: 22px;
        font-size: 11px;
        border: 1px solid #3b82f6;
        border-radius: 3px;
        padding: 0 3px;
        text-align: center;
        outline: none;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
    }

    .pos-ok-btn, .pos-cancel-btn {
        width: 22px;
        height: 22px;
        border-radius: 3px;
        border: 1px solid;
        font-size: 11px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
    }

    .pos-ok-btn {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
    }

    .pos-ok-btn:hover {
        background: #dbeafe;
    }

    .pos-cancel-btn {
        background: #f8fafc;
        border-color: #e2e8f0;
        color: #64748b;
    }

    .pos-cancel-btn:hover {
        background: #e2e8f0;
    }

    /* Accent color swatches */
    .accent-color-row {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
    }

    .color-swatch {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        padding: 0;
        transition: all 0.1s;
        box-sizing: border-box;
    }

    .color-swatch:hover {
        transform: scale(1.2);
    }

    .color-swatch.active {
        border-color: #1e293b;
        box-shadow: 0 0 0 1px #fff, 0 0 0 3px currentColor;
    }

    /* Add column button */
    .add-col-btn {
        margin-top: 4px;
        background: none;
        border: 1px dashed #cbd5e1;
        border-radius: 4px;
        padding: 5px 8px;
        font-size: 11px;
        color: #64748b;
        cursor: pointer;
        width: 100%;
        text-align: left;
        transition: all 0.1s;
    }

    .add-col-btn:hover {
        border-color: #3b82f6;
        color: #3b82f6;
        background: #eff6ff;
    }

    .muted-note {
        font-size: 11px;
        color: #94a3b8;
        font-style: italic;
    }

    /* Footer */
    .panel-footer {
        padding: 6px 10px 8px;
        border-top: 1px solid var(--border-color, #e2e8f0);
        background: var(--header-bg, #f8fafc);
        display: flex;
        gap: 6px;
        flex-shrink: 0;
    }

    .export-btn {
        flex: 1;
        background: none;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 11px;
        color: #64748b;
        cursor: pointer;
        text-align: center;
    }

    .export-btn:hover {
        background: #f1f5f9;
        border-color: #94a3b8;
    }

    .delete-btn {
        background: none;
        border: 1px solid #fca5a5;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 11px;
        color: #dc2626;
        cursor: pointer;
    }

    .delete-btn:hover {
        background: #fef2f2;
    }
</style>
