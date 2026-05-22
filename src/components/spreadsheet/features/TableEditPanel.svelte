<script>
    /**
     * TableEditPanel — lightweight quick-access popup shown when clicking a
     * table/view header in the grid.
     *
     * All schema editing (columns, types, formulas) and view management lives in
     * DocumentTablesPanel. This panel provides just enough context to understand
     * what you're looking at and a fast path to the Tables panel.
     *
     * Shows:
     *   - View/table name + "view" badge if applicable
     *   - Row count, filter summary
     *   - Ad-hoc filter clear button (clears session filters, not view definition filters)
     *   - "Open Tables Panel" button → full management
     *   - Delete view / delete table
     *   - Position (move)
     */

    import { onMount } from 'svelte';
    import BottomSheet from '../../ui/BottomSheet.svelte';
    import { mobileState } from '../../../stores/mobileState.svelte.js';
    import { close, filter, trash, table as tableIcon } from '../../../lib/icons/index.js';
    import { viewPlacementStore } from '../../../stores/spreadsheet/viewPlacementStore.svelte.js';

    let {
        table,
        tableManager,
        session,
        onClose,
        onOpenTablesPanel,
    } = $props();

    let panelEl = $state(null);

    // ── Derived ────────────────────────────────────────────────────────────────
    let isView          = $derived(table?.isView ?? false);
    let rowCount        = $derived(table?.sortedFilteredRows?.length ?? 0);
    let totalRows       = $derived(table?.rows?.length ?? 0);
    let adHocFilters    = $derived(Object.entries(table?.filters ?? {}));
    let defFilterCount  = $derived(Object.keys(table?.viewDefinitionFilters ?? {}).length);

    // Name of the source table (for views)
    let sourceName = $derived.by(() => {
        if (!isView || !session?.tableRegistry) return null;
        for (const { store } of session.tableRegistry.getSourceTables()) {
            const views = session.tableRegistry.getViewsForTable(store.id ?? '');
            if (views.some((/** @type {any} */ v) => v.store === table)) return store.name;
        }
        return null;
    });

    // ── Rename ─────────────────────────────────────────────────────────────────
    let editingName = $state(false);
    let editNameVal = $state('');

    function startRename() { editNameVal = table?.name ?? ''; editingName = true; }
    function commitRename() {
        if (editNameVal.trim() && table) table.rename(editNameVal.trim());
        editingName = false;
    }

    // ── Position — delegates to placement overlay on the grid ─────────────────
    function startMove() {
        if (!table) return;
        const reg = session?.tableRegistry;
        const sheetId = reg?.getSheetId(table.id) ?? session?.activeSheetId;
        if (sheetId && sheetId !== session?.activeSheetId) session?.setActiveSheet(sheetId);
        onClose?.(); // close popup so the grid is accessible
        viewPlacementStore.activate(table.name ?? 'View', (row, col) => {
            table?.moveTo(row, col);
        });
    }

    // ── Delete ─────────────────────────────────────────────────────────────────
    function handleDelete() {
        if (isView) {
            const reg = session?.tableRegistry;
            if (!reg || !table || !session?.ydoc || !session?.root) return;
            const sheetId = reg.getSheetId(table.id);
            const viewsMap = session.root.get('sheets')?.get(sheetId)?.get('tableViews');
            if (viewsMap) session.ydoc.transact(() => viewsMap.delete(table.id));
        } else if (tableManager && table) {
            tableManager.deleteTable(table.id);
        }
        onClose?.();
    }

    function handleKeydown(/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            if (editingName) { editingName = false; }
            else { onClose?.(); }
        }
    }

    onMount(() => { if (!mobileState.isMobile) panelEl?.focus(); });
</script>

{#snippet panelContent()}
    <div class="popup-body">

        <!-- View definition filters notice (transparent, always applied) -->
        {#if defFilterCount > 0 && isView}
            <div class="def-filter-notice">
                {@html filter}
                <span>{defFilterCount} definition filter{defFilterCount > 1 ? 's' : ''} active</span>
                <span class="dfn-hint">(managed in Tables panel)</span>
            </div>
        {/if}

        <!-- Ad-hoc session filters -->
        {#if adHocFilters.length > 0}
            <div class="adhoc-section">
                <span class="adhoc-label">Session filters</span>
                {#each adHocFilters as [colId, f]}
                    {@const col = table?.columns?.find((/** @type {any} */ c) => c.id === colId)}
                    <div class="adhoc-row">
                        <span class="adhoc-desc">{col?.name ?? colId} {f.op} {f.value ?? ''}</span>
                        <button class="icon-btn sm" onclick={() => table?.clearFilter(colId)} aria-label="Remove filter">{@html close}</button>
                    </div>
                {/each}
                <button class="clear-adhoc-btn" onclick={() => table?.clearAllFilters()}>Clear all</button>
            </div>
        {/if}

        <!-- Position -->
        <div class="pos-display">
            <span class="pos-text">
                {#if table}
                    {@const col = table.startCol + 1}
                    {@const colStr = (() => { let s = '', c = col; while (c > 0) { s = String.fromCharCode(64 + ((c - 1) % 26 + 1)) + s; c = Math.floor((c - 1) / 26); } return s; })()}
                    {colStr}{table.startRow + 1}
                {:else}—{/if}
            </span>
            <button class="move-btn" onclick={startMove}>
                Move on grid…
            </button>
        </div>

        <!-- Open Tables panel shortcut -->
        {#if onOpenTablesPanel}
            <button class="open-panel-btn" onclick={() => { onOpenTablesPanel?.(); onClose?.(); }}>
                {@html tableIcon} Open Tables panel →
            </button>
        {/if}

    </div>

    <!-- Footer -->
    <div class="popup-footer">
        <button class="del-btn" onclick={handleDelete}>
            {@html trash} {isView ? 'Delete view' : 'Delete table'}
        </button>
    </div>
{/snippet}

{#if mobileState.isMobile}
    <BottomSheet open={true} onClose={onClose} title={table?.name ?? 'Table'} maxHeight="60vh">
        {@render panelContent()}
    </BottomSheet>
{:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        bind:this={panelEl}
        class="popup"
        onkeydown={handleKeydown}
        role="dialog"
        aria-label="View settings"
        tabindex="-1"
    >
        <!-- Header -->
        <div class="popup-header">
            <div class="popup-title">
                {#if editingName}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                        class="name-input"
                        bind:value={editNameVal}
                        autofocus
                        onblur={commitRename}
                        onkeydown={(/** @type {KeyboardEvent} */ e) => {
                            if (e.key === 'Enter') { e.stopPropagation(); commitRename(); }
                            else if (e.key === 'Escape') { e.stopPropagation(); editingName = false; }
                        }}
                    />
                {:else}
                    <button class="name-btn" onclick={startRename} title="Click to rename">
                        {table?.name ?? 'Table'}
                    </button>
                {/if}
                {#if isView}
                    <span class="view-badge">view</span>
                {/if}
            </div>
            <div class="popup-meta">
                {#if sourceName}
                    <span class="source-ref">of {sourceName}</span>
                {/if}
                <span class="row-count">{rowCount} row{rowCount !== 1 ? 's' : ''}</span>
                {#if totalRows !== rowCount}
                    <span class="row-count muted">({totalRows} total)</span>
                {/if}
            </div>
            <button class="close-btn" onclick={() => onClose?.()} aria-label="Close">{@html close}</button>
        </div>

        {@render panelContent()}
    </div>
{/if}

<style>
    .popup {
        background: var(--cell-bg, #fff);
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
        width: 240px;
        font-size: 12px;
        color: var(--text-color, #1e293b);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: min(70vh, 400px);
    }

    .popup-header {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 9px 10px 7px;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
        flex-shrink: 0;
    }

    .popup-title {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .name-btn {
        flex: 1;
        background: none; border: none; font-weight: 700; font-size: 12px;
        color: var(--text-color, #1e293b); cursor: pointer; text-align: left;
        padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .name-btn:hover { color: #475569; }

    .name-input {
        flex: 1; font-size: 12px; font-weight: 700;
        border: 1px solid #94a3b8; border-radius: 3px;
        padding: 1px 5px; outline: none;
        background: var(--cell-bg, #fff); color: var(--text-color, #1e293b); min-width: 0;
    }

    .view-badge {
        font-size: 9px; padding: 1px 5px; border-radius: 8px;
        background: #eff6ff; color: #2563eb; font-weight: 600; flex-shrink: 0;
    }

    .popup-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        flex-wrap: wrap;
    }

    .source-ref { font-size: 10px; color: #64748b; font-style: italic; }
    .row-count  { font-size: 10px; color: #94a3b8; white-space: nowrap; }
    .row-count.muted { color: #cbd5e1; }

    .close-btn {
        background: none; border: none; cursor: pointer; color: #94a3b8;
        padding: 2px; border-radius: 3px; display: flex; align-items: center;
        width: 20px; height: 20px; flex-shrink: 0; margin-top: 1px;
    }
    .close-btn:hover { color: #475569; background: #e2e8f0; }
    .close-btn :global(svg) { width: 12px; height: 12px; }

    .popup-body {
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        overflow-y: auto;
        flex: 1;
    }

    /* Definition filter notice */
    .def-filter-notice {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 5px 8px;
        background: #fef9c3;
        border: 1px solid #fde68a;
        border-radius: 4px;
        font-size: 10px;
        color: #92400e;
    }
    .def-filter-notice :global(svg) { width: 10px; height: 10px; flex-shrink: 0; }
    .dfn-hint { color: #b45309; font-style: italic; font-size: 9px; }

    /* Ad-hoc filters */
    .adhoc-section {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 6px 8px;
        background: #f0f9ff;
        border: 1px solid #bae6fd;
        border-radius: 4px;
    }

    .adhoc-label {
        font-size: 9px;
        font-weight: 600;
        color: #0369a1;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 1px;
    }

    .adhoc-row {
        display: flex;
        align-items: center;
        gap: 5px;
    }

    .adhoc-desc {
        flex: 1;
        font-size: 11px;
        color: #0c4a6e;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .clear-adhoc-btn {
        background: none; border: none; font-size: 10px; color: #0369a1;
        cursor: pointer; text-align: left; padding: 1px 0;
    }
    .clear-adhoc-btn:hover { text-decoration: underline; }

    /* Manual order */
    .manual-order-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 7px;
        background: #f0fdf4;
        border: 1px solid #bbf7d0;
        border-radius: 4px;
    }
    .manual-order-badge {
        flex: 1;
        font-size: 10px;
        font-weight: 600;
        color: #166534;
    }
    .reset-order-btn {
        font-size: 9px;
        background: none;
        border: 1px solid #86efac;
        border-radius: 3px;
        padding: 1px 6px;
        color: #166534;
        cursor: pointer;
    }
    .reset-order-btn:hover { background: #dcfce7; }

    /* Position */
    .pos-display { display: flex; align-items: center; gap: 8px; }
    .pos-text { flex: 1; font-size: 11px; color: #64748b; font-family: monospace; font-weight: 600; }
    .move-btn {
        font-size: 10px; padding: 3px 8px;
        border: 1px solid #bfdbfe; border-radius: 4px;
        background: #eff6ff; color: #2563eb; cursor: pointer; font-weight: 500;
        white-space: nowrap;
    }
    .move-btn:hover { background: #dbeafe; }

    /* Icon buttons */
    .icon-btn {
        width: 22px; height: 22px; border-radius: 3px; border: 1px solid #e2e8f0;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        padding: 0; background: #f8fafc; color: #64748b; flex-shrink: 0;
    }
    .icon-btn:hover { background: #e2e8f0; }
    .icon-btn.sm { width: 18px; height: 18px; }
    .icon-btn :global(svg) { width: 11px; height: 11px; }

    /* Open Tables panel */
    .open-panel-btn {
        width: 100%;
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 5px;
        padding: 7px 10px;
        font-size: 11px;
        font-weight: 500;
        color: #2563eb;
        cursor: pointer;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .open-panel-btn:hover { background: #dbeafe; }
    .open-panel-btn :global(svg) { width: 12px; height: 12px; flex-shrink: 0; }

    /* Footer */
    .popup-footer {
        padding: 6px 10px 8px;
        border-top: 1px solid #e2e8f0;
        background: #f8fafc;
        flex-shrink: 0;
    }

    .del-btn {
        width: 100%;
        background: none; border: 1px solid #fca5a5; border-radius: 4px;
        padding: 5px 10px; font-size: 11px; color: #dc2626; cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 5px;
    }
    .del-btn:hover { background: #fef2f2; }
    .del-btn :global(svg) { width: 11px; height: 11px; }

    @media (max-width: 600px) {
        .popup-body  { padding: 12px 14px; gap: 10px; }
        .popup-footer { padding: 10px 14px 12px; }
        .del-btn { padding: 10px; font-size: 13px; min-height: 44px; }
    }
</style>
