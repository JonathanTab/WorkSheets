<script>
    /**
     * DocumentTablesPanel — the single central UI for all table management.
     *
     * Layout: two-pane side panel.
     *   Left  (180px) — list of source tables, clickable to select.
     *   Right (380px) — detail pane for selected table:
     *       • Table header: name, sort-on-insert, stats
     *       • Columns tab: add/rename/type/formula/reorder/delete columns
     *       • Views tab: list of views with column order + transparent filters
     */

    import { close, plus, trash, filter, download, check } from '../../../lib/icons/index.js';
    import TableColumnPanel from './TableColumnPanel.svelte';
    import { viewPlacementStore } from '../../../stores/spreadsheet/viewPlacementStore.svelte.js';

    let { session, onClose, initialTableId = null, initialColId = null } = $props();

    // ── Registry / data ────────────────────────────────────────────────────────
    let registry = $derived(session?.tableRegistry ?? null);
    let sheets   = $derived(session?.sheets ?? []);

    let sourceTables = $derived.by(() => {
        if (!registry) return [];
        void registry.tableVersion;
        return registry.getSourceTables().sort((a, b) =>
            (a.store.name ?? '').localeCompare(b.store.name ?? ''));
    });

    /** @param {string} sheetId */
    function sheetName(sheetId) {
        return sheets.find(s => s.id === sheetId)?.name ?? sheetId;
    }

    /** @param {string} tableId */
    function viewsFor(tableId) {
        if (!registry) return [];
        void registry.tableVersion;
        return registry.getViewsForTable(tableId);
    }

    // ── Table selection ─────────────────────────────────────────────────────
    let selectedTableId = $state(/** @type {string|null} */ (null));
    let selectedTable   = $derived(
        selectedTableId ? sourceTables.find(t => t.tableId === selectedTableId) ?? null : null
    );

    // Apply initialTableId prop once on mount, then auto-select first table
    let _initialApplied = $state(false);
    $effect(() => {
        if (!_initialApplied && sourceTables.length > 0) {
            _initialApplied = true;
            if (initialTableId && sourceTables.some(t => t.tableId === initialTableId)) {
                selectedTableId = initialTableId;
            } else {
                selectedTableId = sourceTables[0].tableId;
            }
        }
    });

    // ── Active tab in detail pane ───────────────────────────────────────────
    /** @type {'columns' | 'views'} */
    let activeTab = $state('columns');

    // ── Table-level rename ──────────────────────────────────────────────────
    let renamingTableId = $state(/** @type {string|null} */ (null));
    let renameValue     = $state('');

    function startRenameTable(tableId, current) {
        renamingTableId = tableId;
        renameValue = current;
    }

    function commitRenameTable(store) {
        const name = renameValue.trim();
        if (name) store.rename(name);
        renamingTableId = null;
    }

    // ── Columns tab ─────────────────────────────────────────────────────────
    /** colId currently open in the inline config expander */
    let expandedColId = $state(/** @type {string|null} */ (null));

    // Apply initialColId once after table is selected
    $effect(() => {
        if (initialColId && selectedTableId === initialTableId && !expandedColId) {
            expandedColId = initialColId;
            activeTab = 'columns';
        }
    });

    /** colId currently being renamed */
    let renamingColId  = $state(/** @type {string|null} */ (null));
    let renameColValue = $state('');

    function startRenameCol(colId, current, e) {
        e?.stopPropagation();
        renamingColId  = colId;
        renameColValue = current;
    }

    function commitRenameCol(store, colId) {
        const name = renameColValue.trim();
        if (name) store.renameColumn(colId, name);
        renamingColId = null;
    }

    function addColumn(store) {
        const idx = store.columns.length;
        const id  = `col${Date.now()}`;
        store.insertColumn(idx, { id, name: `Column ${idx + 1}`, type: 'text' });
        expandedColId = id;
    }

    const TYPE_ICONS = { text:'A', number:'#', currency:'$', percent:'%', date:'D',
                         checkbox:'✓', rating:'★', url:'↗', dropdown:'▾' };
    /** @param {any} col */
    function colTypeIcon(col) { return col.defaultFormula ? 'fx' : (TYPE_ICONS[col.type] ?? 'A'); }

    // ── Drag-to-reorder source columns ──────────────────────────────────────
    let dragColFrom = $state(-1);
    let dragColOver = $state(-1);

    function colDragStart(e, idx) { dragColFrom = idx; e.dataTransfer?.setData('text/plain', String(idx)); }
    function colDragOver(e, idx)  { e.preventDefault(); dragColOver = idx; }
    function colDrop(e, idx, store) {
        e.preventDefault();
        if (dragColFrom >= 0 && dragColFrom !== idx) store.reorderColumns(dragColFrom, idx);
        dragColFrom = dragColOver = -1;
    }
    function colDragEnd() { dragColFrom = dragColOver = -1; }

    // ── Views tab ────────────────────────────────────────────────────────────

    /** viewId expanded in the views list */
    let expandedViewId = $state(/** @type {string|null} */ (null));

    /** viewId being renamed */
    let renamingViewId  = $state(/** @type {string|null} */ (null));
    let renameViewValue = $state('');

    function startRenameView(viewId, current, e) {
        e?.stopPropagation();
        renamingViewId = viewId;
        renameViewValue = current;
    }
    function commitRenameView(store) {
        const name = renameViewValue.trim();
        if (name) store.rename(name);
        renamingViewId = null;
    }

    // ── Visible columns for a view — ordered draggable list ─────────────────
    /**
     * Per-view local state: ordered list of colIds for visible columns.
     * We keep a separate local drag state per view.
     * @type {Record<string, string[]>}
     */
    let viewVisibleCols = $state({});

    /**
     * Initialize (or sync) the local visible column order for a view when it
     * is expanded. Uses the view's actual visibleColumns if set, otherwise all
     * source columns in source order.
     */
    function initViewCols(viewId, vStore, srcStore) {
        // vStore.columns already reflects the visible+ordered subset (or all if show-all).
        viewVisibleCols = { ...viewVisibleCols, [viewId]: vStore.columns.map((/** @type {any} */ c) => c.id) };
    }

    /** Returns ordered list of visible colIds for this view (from local state). */
    function getVisibleColOrder(viewId, vStore, srcStore) {
        if (viewId in viewVisibleCols) return viewVisibleCols[viewId];
        return vStore.columns.map((/** @type {any} */ c) => c.id);
    }

    /** Returns hidden colIds (source cols not in visible order). */
    function getHiddenCols(viewId, vStore, srcStore) {
        const visible = new Set(getVisibleColOrder(viewId, vStore, srcStore));
        return srcStore.columns.filter((/** @type {any} */ c) => !visible.has(c.id));
    }

    /** Toggle a column's visibility in a view. */
    function toggleViewCol(viewId, colId, vStore, srcStore) {
        const visible = getVisibleColOrder(viewId, vStore, srcStore);
        let next;
        if (visible.includes(colId)) {
            next = visible.filter(id => id !== colId);
        } else {
            next = [...visible, colId];
        }
        viewVisibleCols = { ...viewVisibleCols, [viewId]: next };
        vStore.setVisibleColumns(next);
    }

    // Drag-to-reorder visible columns within a view
    let viewDragFrom = $state(-1);
    let viewDragOver = $state(-1);
    let viewDragId   = $state(/** @type {string|null} */ (null)); // which viewId is being dragged

    function viewColDragStart(e, viewId, idx) {
        viewDragFrom = idx; viewDragId = viewId;
        e.dataTransfer?.setData('text/plain', String(idx));
    }
    function viewColDragOver(e, idx) { e.preventDefault(); viewDragOver = idx; }
    function viewColDragEnd() { viewDragFrom = viewDragOver = -1; viewDragId = null; }
    function viewColDrop(e, viewId, idx, vStore, srcStore) {
        e.preventDefault();
        if (viewDragFrom >= 0 && viewDragId === viewId && viewDragFrom !== idx) {
            const order = [...getVisibleColOrder(viewId, vStore, srcStore)];
            const [moved] = order.splice(viewDragFrom, 1);
            order.splice(idx, 0, moved);
            viewVisibleCols = { ...viewVisibleCols, [viewId]: order };
            vStore.setVisibleColumns(order);
        }
        viewDragFrom = viewDragOver = -1; viewDragId = null;
    }

    // ── View definition filters ──────────────────────────────────────────────
    /** @type {Record<string, boolean>} viewId → filter form open */
    let viewFilterFormOpen = $state({});

    /** @type {Record<string, {colId:string, op:string, value:string}>} */
    let pendingFilter = $state({});

    const FILTER_OPS = ['=','<>','>','<','>=','<=','contains','notcontains','startswith','empty','notempty'];

    function openFilterForm(viewId, cols) {
        pendingFilter = { ...pendingFilter, [viewId]: { colId: cols[0]?.id ?? '', op: '=', value: '' } };
        viewFilterFormOpen = { ...viewFilterFormOpen, [viewId]: true };
    }

    function addViewFilter(viewId, store) {
        const pf = pendingFilter[viewId];
        if (!pf?.colId) return;
        store.setViewFilter(pf.colId, pf.op, pf.value);
        viewFilterFormOpen = { ...viewFilterFormOpen, [viewId]: false };
    }

    // ── Create new view ──────────────────────────────────────────────────────
    let creatingViewFor = $state(/** @type {string|null} */ (null));
    let newViewName     = $state('');

    function openCreateView(tableId, store) {
        creatingViewFor = tableId;
        newViewName = `${store.name} View`;
    }

    function commitCreateView(sourceTableId, store) {
        if (!creatingViewFor) return;
        const name = newViewName.trim() || 'View';
        const targetSheet = session?.activeSheetId ?? '';
        creatingViewFor = null;

        viewPlacementStore.activate(name, (row, col) => {
            session?.createTableViewOnSheet({
                sourceTableId,
                targetSheetId: targetSheet,
                name,
                startRow: row,
                startCol: col,
                visibleColumns: store.columns.map((/** @type {any} */ c) => c.id),
            });
        });
        // Close panel so grid is accessible for placement
        onClose?.();
    }

    /** Activate placement mode to move an existing view. */
    function moveView(viewId, vStore) {
        const sheetId = registry?.getSheetId(viewId);
        if (!sheetId) return;
        if (sheetId !== session?.activeSheetId) {
            session?.setActiveSheet(sheetId);
        }
        viewPlacementStore.activate(vStore.name, (row, col) => {
            vStore.moveTo(row, col);
        });
        onClose?.();
    }

    // ── Delete helpers ───────────────────────────────────────────────────────
    function deleteTable(tableId, store) {
        if (!confirm(`Delete table "${store.name}" and all its views? This cannot be undone.`)) return;
        for (const { viewId, isLegacy } of viewsFor(tableId)) {
            if (!isLegacy) _deleteFromSheet(viewId);
        }
        _deleteFromSheet(tableId);
        selectedTableId = null;
    }

    function deleteView(viewId, store) {
        if (!confirm(`Delete view "${store.name}"?`)) return;
        _deleteFromSheet(viewId);
        if (expandedViewId === viewId) expandedViewId = null;
    }

    function _deleteFromSheet(id) {
        if (!session?.ydoc || !session?.root) return;
        const sheetId = registry?.getSheetId(id);
        if (sheetId) {
            // View or legacy table on a specific sheet
            const tablesMap = session.root.get('sheets')?.get(sheetId)?.get('tables');
            if (tablesMap) session.ydoc.transact(() => tablesMap.delete(id));
        } else {
            // Document-level source table in root.tables
            const globalTables = session.root.get('tables');
            if (globalTables) session.ydoc.transact(() => globalTables.delete(id));
        }
    }

    // ── Navigate to view ─────────────────────────────────────────────────────
    function goToView(sheetId) {
        session?.setActiveSheet(sheetId);
        onClose?.();
    }

    // ── Export ───────────────────────────────────────────────────────────────
    function exportCSV(store) {
        const csv  = store.exportCSV();
        const blob = new Blob([csv], { type: 'text/csv' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `${store.name ?? 'table'}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }
</script>

<div class="panel">

    <!-- ── Header ───────────────────────────────────────────────────────────── -->
    <div class="panel-header">
        <span class="panel-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="3" y1="15" x2="21" y2="15"/>
                <line x1="9" y1="3" x2="9" y2="21"/>
            </svg>
            Tables
            {#if sourceTables.length > 0}
                <span class="count-badge">{sourceTables.length}</span>
            {/if}
        </span>
        <button class="close-btn" onclick={() => onClose?.()}>{@html close}</button>
    </div>

    <!-- ── Body: table list + detail ────────────────────────────────────────── -->
    <div class="panel-body">

        <!-- Left: table list -->
        <div class="table-list">
            {#each sourceTables as { tableId, sheetId, store } (tableId)}
                {@const isSelected = selectedTableId === tableId}
                {@const views = viewsFor(tableId)}
                <button
                    class="table-list-item"
                    class:selected={isSelected}
                    style="--accent: #3b82f6"
                    onclick={() => { selectedTableId = tableId; }}
                >
                    <div class="tli-accent"></div>
                    <div class="tli-info">
                        <span class="tli-name">{store.name}</span>
                        <span class="tli-meta">
                            {store.getRowCount()} rows · {views.length} view{views.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                </button>
            {/each}

            {#if sourceTables.length === 0}
                <div class="tl-empty">No tables yet.<br>Use Insert → Table to create one.</div>
            {/if}
        </div>

        <!-- Right: detail pane -->
        <div class="detail-pane">
            {#if selectedTable}
                {@const { tableId, sheetId, store } = selectedTable}

                <!-- ── Detail header ─────────────────────────────────────────── -->
                <div class="detail-header" style="--accent: #3b82f6">
                    <div class="detail-accent-strip"></div>
                    <div class="detail-header-content">
                        <div class="detail-title-row">
                            {#if renamingTableId === tableId}
                                <!-- svelte-ignore a11y_autofocus -->
                                <input
                                    class="detail-name-input"
                                    bind:value={renameValue}
                                    autofocus
                                    onblur={() => commitRenameTable(store)}
                                    onkeydown={e => {
                                        if (e.key === 'Enter') { e.stopPropagation(); commitRenameTable(store); }
                                        else if (e.key === 'Escape') { e.stopPropagation(); renamingTableId = null; }
                                    }}
                                />
                            {:else}
                                <!-- svelte-ignore a11y_no_static_element_interactions -->
                                <span
                                    class="detail-name"
                                    title="Double-click to rename"
                                    ondblclick={() => startRenameTable(tableId, store.name)}
                                >{store.name}</span>
                            {/if}
                            <span class="detail-source-badge">table</span>
                        </div>
                        <div class="detail-stats">
                            <span>{store.getRowCount()} rows</span>
                            <span class="dot">·</span>
                            <span>{store.columns.length} columns</span>
                            <span class="dot">·</span>
                            <span>{sheetName(sheetId)}</span>
                        </div>
                        <!-- Place-by row (governs where new rows land on insert) -->
                        <div class="insert-sort-row">
                            <span class="insert-sort-label">Place by:</span>
                            {#if store.insertSortColId}
                                {@const isc = store.columns.find((/** @type {any} */ c) => c.id === store.insertSortColId)}
                                <span class="insert-sort-value">{isc?.name ?? store.insertSortColId}</span>
                                <button class="insert-sort-clear" onclick={() => store.clearInsertSort()} title="Remove place-by column">✕</button>
                            {:else}
                                <select
                                    class="insert-sort-sel"
                                    value=""
                                    onchange={e => {
                                        const val = /** @type {HTMLSelectElement} */ (e.target).value;
                                        if (val) store.setInsertSort(val, 'asc');
                                    }}
                                >
                                    <option value="">— none —</option>
                                    {#each store.columns.filter((/** @type {any} */ c) => !c.isNonEntry || c.defaultFormula) as c}
                                        <option value={c.id}>{c.name}</option>
                                    {/each}
                                </select>
                            {/if}
                            {#if store.insertSortColId}
                                <select
                                    class="insert-sort-dir"
                                    value={store.insertSortDir}
                                    onchange={e => store.setInsertSort(store.insertSortColId, /** @type {HTMLSelectElement} */ (e.target).value)}
                                >
                                    <option value="asc">Highest first</option>
                                    <option value="desc">Lowest first</option>
                                </select>
                            {/if}
                        </div>
                    </div>
                    <div class="detail-header-actions">
                        <button class="hdr-btn" onclick={() => exportCSV(store)} title="Export CSV" aria-label="Export CSV">{@html download}</button>
                        <button class="hdr-btn danger" onclick={() => deleteTable(tableId, store)} title="Delete table" aria-label="Delete table">{@html trash}</button>
                    </div>
                </div>

                <!-- ── Tabs ───────────────────────────────────────────────────── -->
                <div class="tabs">
                    <button
                        class="tab"
                        class:active={activeTab === 'columns'}
                        onclick={() => activeTab = 'columns'}
                    >Columns ({store.columns.length})</button>
                    <button
                        class="tab"
                        class:active={activeTab === 'views'}
                        onclick={() => activeTab = 'views'}
                    >Views ({viewsFor(tableId).length})</button>
                </div>

                <!-- ── Columns tab ────────────────────────────────────────────── -->
                {#if activeTab === 'columns'}
                    <div class="tab-body">
                        {#each store.columns as col, idx (col.id)}
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <div
                                class="col-row"
                                class:drag-over={dragColOver === idx && dragColFrom !== idx}
                                class:dragging={dragColFrom === idx}
                                class:col-expanded={expandedColId === col.id}
                                role="listitem"
                                draggable="true"
                                ondragstart={e => colDragStart(e, idx)}
                                ondragover={e => colDragOver(e, idx)}
                                ondrop={e => colDrop(e, idx, store)}
                                ondragend={colDragEnd}
                            >
                                <span class="drag-grip" title="Drag to reorder">⠿</span>
                                <button
                                    class="col-type-btn"
                                    class:formula={col.defaultFormula}
                                    onclick={() => expandedColId = expandedColId === col.id ? null : col.id}
                                    title="Configure column"
                                >{colTypeIcon(col)}</button>
                                {#if renamingColId === col.id}
                                    <!-- svelte-ignore a11y_autofocus -->
                                    <input
                                        class="col-name-input"
                                        bind:value={renameColValue}
                                        autofocus
                                        onblur={() => commitRenameCol(store, col.id)}
                                        onkeydown={e => {
                                            if (e.key === 'Enter') { e.stopPropagation(); commitRenameCol(store, col.id); }
                                            else if (e.key === 'Escape') { e.stopPropagation(); renamingColId = null; }
                                        }}
                                    />
                                {:else}
                                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                                    <span
                                        class="col-name"
                                        title="Double-click to rename"
                                        ondblclick={e => startRenameCol(col.id, col.name, e)}
                                    >{col.name}</span>
                                {/if}
                                {#if col.defaultFormula}
                                    <span class="col-formula-badge" title={col.defaultFormula}>= {col.defaultFormula.slice(0, 12)}</span>
                                {:else if col.isNonEntry}
                                    <span class="col-formula-badge col-readonly-badge">read-only</span>
                                {/if}
                                <button
                                    class="col-del-btn"
                                    onclick={() => store.deleteColumn(col.id)}
                                    title="Delete column"
                                >{@html trash}</button>
                            </div>
                            {#if expandedColId === col.id}
                                <div class="col-config-slot">
                                    <TableColumnPanel
                                        table={store}
                                        colId={col.id}
                                        inline={true}
                                        onClose={() => expandedColId = null}
                                    />
                                </div>
                            {/if}
                        {/each}
                        <button class="add-col-btn" onclick={() => addColumn(store)}>
                            {@html plus} Add column
                        </button>
                    </div>
                {/if}

                <!-- ── Views tab ──────────────────────────────────────────────── -->
                {#if activeTab === 'views'}
                    <div class="tab-body">
                        {#each viewsFor(tableId) as { viewId, sheetId: vSheetId, store: vStore, isLegacy } (viewId)}
                            {@const vFilterCount = Object.keys(vStore.viewDefinitionFilters ?? {}).length}
                            {@const vColCount = vStore.columns.length}
                            {@const isExpanded = expandedViewId === viewId}

                            <!-- View summary row -->
                            <div class="view-row" class:expanded={isExpanded && !isLegacy}>
                                {#if !isLegacy}
                                    <button
                                        class="view-expand-btn"
                                        class:open={isExpanded}
                                        onclick={() => {
                                            const next = isExpanded ? null : viewId;
                                            expandedViewId = next;
                                            if (next && !isLegacy) {
                                                initViewCols(viewId, vStore, store);
                                            }
                                        }}
                                        title={isExpanded ? 'Collapse' : 'Expand view settings'}
                                        aria-label="Expand view settings"
                                        aria-expanded={isExpanded}
                                    >
                                        <span class="expand-chevron">{isExpanded ? '▾' : '▸'}</span>
                                        <span class="expand-label">Settings</span>
                                    </button>
                                {:else}
                                    <span class="view-expand-spacer"></span>
                                {/if}

                                <div class="view-info">
                                    {#if !isLegacy && renamingViewId === viewId}
                                        <!-- svelte-ignore a11y_autofocus -->
                                        <input
                                            class="view-name-input"
                                            bind:value={renameViewValue}
                                            autofocus
                                            onblur={() => commitRenameView(vStore)}
                                            onkeydown={e => {
                                                if (e.key === 'Enter') { e.stopPropagation(); commitRenameView(vStore); }
                                                else if (e.key === 'Escape') { e.stopPropagation(); renamingViewId = null; }
                                            }}
                                        />
                                    {:else}
                                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                                        <span
                                            class="view-name"
                                            ondblclick={!isLegacy ? e => startRenameView(viewId, vStore.name, e) : undefined}
                                            title={isLegacy ? 'Legacy table placement' : 'Double-click to rename'}
                                        >{vStore.name}</span>
                                    {/if}

                                    <div class="view-chips">
                                        <span class="chip sheet">{sheetName(vSheetId)}</span>
                                        {#if isLegacy}
                                            <span class="chip legacy" title="Created before the source/view split. All columns always shown.">legacy</span>
                                        {:else}
                                            <span class="chip cols">{vColCount} col{vColCount !== 1 ? 's' : ''}</span>
                                            {#if vFilterCount > 0}
                                                <span class="chip filt">
                                                    {@html filter}
                                                    {vFilterCount}
                                                </span>
                                            {/if}
                                        {/if}
                                    </div>
                                </div>

                                <div class="view-row-actions">
                                    {#if !isLegacy}
                                        <button class="vra-btn move" onclick={() => moveView(viewId, vStore)} title="Move on grid" aria-label="Move view on grid">⊹</button>
                                    {/if}
                                    <button class="vra-btn" onclick={() => goToView(vSheetId)} title="Go to sheet" aria-label="Go to sheet">→</button>
                                    {#if !isLegacy}
                                        <button class="vra-btn danger" onclick={() => deleteView(viewId, vStore)} title="Delete view" aria-label="Delete view">{@html trash}</button>
                                    {/if}
                                </div>
                            </div>

                            <!-- Expanded view settings (new-style views only) -->
                            {#if isExpanded && !isLegacy}
                                {@const visibleOrder = getVisibleColOrder(viewId, vStore, store)}
                                {@const hiddenCols   = getHiddenCols(viewId, vStore, store)}
                                <div class="view-detail">

                                    <!-- Column order section -->
                                    <div class="vd-section-label">
                                        Column order
                                        <span class="vd-section-hint">drag to reorder · uncheck to hide</span>
                                    </div>

                                    <!-- Visible columns (draggable, ordered) -->
                                    <div class="vd-col-order">
                                        {#each visibleOrder as colId, ci (colId)}
                                            {@const srcCol = store.columns.find((/** @type {any} */ c) => c.id === colId)}
                                            {#if srcCol}
                                                <!-- svelte-ignore a11y_no_static_element_interactions -->
                                                <div
                                                    class="vd-col-item visible"
                                                    class:vd-drag-over={viewDragId === viewId && viewDragOver === ci && viewDragFrom !== ci}
                                                    class:vd-dragging={viewDragId === viewId && viewDragFrom === ci}
                                                    draggable="true"
                                                    role="listitem"
                                                    ondragstart={e => viewColDragStart(e, viewId, ci)}
                                                    ondragover={e => viewColDragOver(e, ci)}
                                                    ondrop={e => viewColDrop(e, viewId, ci, vStore, store)}
                                                    ondragend={viewColDragEnd}
                                                >
                                                    <span class="vd-col-grip">⠿</span>
                                                    <input
                                                        type="checkbox"
                                                        class="vd-col-check"
                                                        checked={true}
                                                        onchange={() => toggleViewCol(viewId, colId, vStore, store)}
                                                    />
                                                    <span class="vd-col-type">{colTypeIcon(srcCol)}</span>
                                                    <span class="vd-col-name">{srcCol.name}</span>
                                                </div>
                                            {/if}
                                        {/each}
                                    </div>

                                    <!-- Hidden columns (fixed order, just toggle to show) -->
                                    {#if hiddenCols.length > 0}
                                        <div class="vd-hidden-label">Hidden</div>
                                        {#each hiddenCols as srcCol (srcCol.id)}
                                            <div class="vd-col-item hidden">
                                                <span class="vd-col-grip-ph"></span>
                                                <input
                                                    type="checkbox"
                                                    class="vd-col-check"
                                                    checked={false}
                                                    onchange={() => toggleViewCol(viewId, srcCol.id, vStore, store)}
                                                />
                                                <span class="vd-col-type">{colTypeIcon(srcCol)}</span>
                                                <span class="vd-col-name">{srcCol.name}</span>
                                            </div>
                                        {/each}
                                    {/if}

                                    <!-- Transparent filters -->
                                    <div class="vd-section-label" style="margin-top:10px">
                                        Definition filters
                                        <span class="vd-section-hint">(always applied)</span>
                                    </div>

                                    {#each Object.entries(vStore.viewDefinitionFilters ?? {}) as [fColId, fEntry]}
                                        {@const fcol = store.columns.find((/** @type {any} */ c) => c.id === fColId)}
                                        <div class="vd-filter-row">
                                            <span class="vdf-col">{fcol?.name ?? fColId}</span>
                                            <span class="vdf-op">{fEntry.op}</span>
                                            {#if fEntry.value !== '' && fEntry.value != null}
                                                <span class="vdf-val">"{fEntry.value}"</span>
                                            {/if}
                                            <button
                                                class="vdf-del"
                                                onclick={() => vStore.clearViewFilter(fColId)}
                                                title="Remove filter"
                                            >{@html close}</button>
                                        </div>
                                    {/each}

                                    {#if viewFilterFormOpen[viewId]}
                                        {@const pf = pendingFilter[viewId] ?? { colId: '', op: '=', value: '' }}
                                        <div class="vd-filter-form">
                                            <select
                                                class="vff-sel"
                                                value={pf.colId}
                                                onchange={e => pendingFilter = { ...pendingFilter,
                                                    [viewId]: { ...pf, colId: /** @type {any} */ (e.target).value } }}
                                            >
                                                {#each store.columns.filter((/** @type {any} */ c) => !c.isNonEntry || c.defaultFormula) as c}
                                                    <option value={c.id}>{c.name}</option>
                                                {/each}
                                            </select>
                                            <select
                                                class="vff-sel narrow"
                                                value={pf.op}
                                                onchange={e => pendingFilter = { ...pendingFilter,
                                                    [viewId]: { ...pf, op: /** @type {any} */ (e.target).value } }}
                                            >
                                                {#each FILTER_OPS as op}<option value={op}>{op}</option>{/each}
                                            </select>
                                            {#if pf.op !== 'empty' && pf.op !== 'notempty'}
                                                <input
                                                    class="vff-input"
                                                    type="text"
                                                    placeholder="value"
                                                    value={pf.value}
                                                    oninput={e => pendingFilter = { ...pendingFilter,
                                                        [viewId]: { ...pf, value: /** @type {any} */ (e.target).value } }}
                                                />
                                            {/if}
                                            <div class="vff-actions">
                                                <button class="vff-add" onclick={() => addViewFilter(viewId, vStore)}>
                                                    {@html check} Apply
                                                </button>
                                                <button class="vff-cancel" onclick={() => viewFilterFormOpen = { ...viewFilterFormOpen, [viewId]: false }}>
                                                    {@html close}
                                                </button>
                                            </div>
                                        </div>
                                    {:else}
                                        <button
                                            class="vd-add-filter-btn"
                                            onclick={() => openFilterForm(viewId, store.columns)}
                                        >
                                            {@html plus} Add filter
                                        </button>
                                    {/if}

                                    {#if vFilterCount > 0}
                                        <button class="vd-clear-filters" onclick={() => vStore.clearAllViewFilters()}>
                                            Clear all filters
                                        </button>
                                    {/if}

                                    <!-- Position -->
                                    <div class="vd-section-label" style="margin-top:10px">Position on sheet</div>
                                    <div class="vd-pos">
                                        <span class="vd-pos-ref">{@html `Row&nbsp;${vStore.startRow + 1},&nbsp;Col&nbsp;${vStore.startCol + 1}`}</span>
                                        <button class="vd-pos-edit" onclick={() => moveView(viewId, vStore)}>
                                            Move on grid…
                                        </button>
                                    </div>
                                </div>
                            {/if}
                        {/each}

                        <!-- Create view -->
                        {#if creatingViewFor === tableId}
                            <div class="create-view-card">
                                <div class="cv-header">New view on current sheet</div>
                                <div class="cv-field-row">
                                    <label class="cv-label" for="cv-name">Name</label>
                                    <!-- svelte-ignore a11y_autofocus -->
                                    <input
                                        id="cv-name"
                                        class="cv-input"
                                        type="text"
                                        bind:value={newViewName}
                                        autofocus
                                        onkeydown={e => {
                                            if (e.key === 'Enter') { e.stopPropagation(); commitCreateView(tableId, store); }
                                            else if (e.key === 'Escape') { e.stopPropagation(); creatingViewFor = null; }
                                        }}
                                    />
                                </div>
                                <div class="cv-hint">Click the grid to place the view after creating.</div>
                                <div class="cv-actions">
                                    <button class="cv-create-btn" onclick={() => commitCreateView(tableId, store)}>
                                        {@html check} Place on grid…
                                    </button>
                                    <button class="cv-cancel-btn" onclick={() => creatingViewFor = null}>{@html close}</button>
                                </div>
                            </div>
                        {:else}
                            <button class="add-view-btn" onclick={() => openCreateView(tableId, store)}>
                                {@html plus} Add view on current sheet
                            </button>
                        {/if}
                    </div>
                {/if}
            {:else}
                <div class="detail-empty">Select a table to manage it.</div>
            {/if}
        </div>
    </div>
</div>

<style>
    /* ── Panel shell ────────────────────────────────────────────────────────── */
    .panel {
        width: 560px;
        height: 100%;
        display: flex;
        flex-direction: column;
        background: var(--cell-bg, #fff);
        border-left: 1px solid var(--cell-border, #e2e8f0);
        font-size: 12px;
        color: var(--text-color, #1e293b);
        overflow: hidden;
    }

    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px 8px;
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        background: var(--color-bg-secondary, #f8fafc);
        flex-shrink: 0;
    }

    .panel-title {
        font-weight: 600;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 7px;
    }
    .panel-title svg { flex-shrink: 0; }

    .count-badge {
        background: #e2e8f0;
        color: #64748b;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 10px;
        font-weight: 500;
    }

    .close-btn {
        background: none; border: none; cursor: pointer; color: #94a3b8;
        width: 24px; height: 24px; border-radius: 4px; padding: 0;
        display: flex; align-items: center; justify-content: center;
    }
    .close-btn:hover { background: #e2e8f0; color: #475569; }
    .close-btn :global(svg) { width: 14px; height: 14px; }

    /* ── Body: two-pane ─────────────────────────────────────────────────────── */
    .panel-body {
        flex: 1;
        display: flex;
        overflow: hidden;
        min-height: 0;
    }

    /* ── Left: table list ─────────────────────────────────────────────────── */
    .table-list {
        width: 180px;
        flex-shrink: 0;
        border-right: 1px solid var(--cell-border, #e2e8f0);
        overflow-y: auto;
        background: var(--color-bg-secondary, #f8fafc);
        padding: 4px 0;
    }

    .table-list-item {
        width: 100%;
        display: flex;
        align-items: stretch;
        gap: 0;
        padding: 0;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        border-bottom: 1px solid transparent;
        transition: background 0.1s;
    }
    .table-list-item:hover { background: #f1f5f9; }
    .table-list-item.selected { background: #eff6ff; }

    .tli-accent {
        width: 3px;
        background: var(--accent, #3b82f6);
        flex-shrink: 0;
        border-radius: 0 2px 2px 0;
    }

    .tli-info {
        flex: 1;
        padding: 7px 10px;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .tli-name {
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-color, #1e293b);
    }
    .table-list-item.selected .tli-name { color: #2563eb; }

    .tli-meta {
        font-size: 10px;
        color: #94a3b8;
        white-space: nowrap;
    }

    .tl-empty {
        padding: 16px 14px;
        font-size: 11px;
        color: #94a3b8;
        text-align: center;
        line-height: 1.5;
    }

    /* ── Right: detail pane ──────────────────────────────────────────────── */
    .detail-pane {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 0;
    }

    .detail-empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        color: #94a3b8;
        font-style: italic;
    }

    /* ── Detail header ────────────────────────────────────────────────────── */
    .detail-header {
        display: flex;
        align-items: stretch;
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        background: var(--color-bg-secondary, #f8fafc);
        flex-shrink: 0;
    }

    .detail-accent-strip {
        width: 4px;
        background: var(--accent, #3b82f6);
        flex-shrink: 0;
    }

    .detail-header-content {
        flex: 1;
        padding: 10px 12px 8px;
        min-width: 0;
    }

    .detail-title-row {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-bottom: 3px;
    }

    .detail-name {
        font-weight: 700;
        font-size: 14px;
        cursor: pointer;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .detail-name:hover { color: #3b82f6; }

    .detail-name-input {
        font-size: 14px;
        font-weight: 700;
        border: 1px solid #94a3b8;
        border-radius: 3px;
        padding: 1px 6px;
        outline: none;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        min-width: 0;
        flex: 1;
    }

    .detail-source-badge {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 8px;
        background: #f1f5f9;
        color: #64748b;
        font-weight: 500;
        flex-shrink: 0;
    }

    .detail-stats {
        font-size: 11px;
        color: #64748b;
        display: flex;
        gap: 5px;
        align-items: center;
        margin-bottom: 5px;
    }
    .dot { color: #cbd5e1; }

    /* Sort on insert row */
    .insert-sort-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }
    .insert-sort-label {
        font-size: 10px;
        font-weight: 600;
        color: #64748b;
        white-space: nowrap;
    }
    .insert-sort-value {
        font-size: 11px;
        color: #1e293b;
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        padding: 1px 6px;
    }
    .insert-sort-sel, .insert-sort-dir {
        height: 22px;
        font-size: 10px;
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        padding: 0 4px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
    }
    .insert-sort-clear {
        background: none;
        border: none;
        cursor: pointer;
        color: #94a3b8;
        font-size: 10px;
        padding: 1px 4px;
        border-radius: 3px;
        line-height: 1;
    }
    .insert-sort-clear:hover { color: #dc2626; background: #fef2f2; }

    .detail-header-actions {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
        padding: 8px 10px;
        flex-shrink: 0;
    }

    .hdr-btn {
        background: none;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        padding: 4px 7px;
        cursor: pointer;
        color: #64748b;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        height: 26px;
    }
    .hdr-btn:hover { background: #f1f5f9; }
    .hdr-btn.danger { color: #dc2626; border-color: #fca5a5; }
    .hdr-btn.danger:hover { background: #fef2f2; }
    .hdr-btn :global(svg) { width: 11px; height: 11px; }

    /* ── Tabs ─────────────────────────────────────────────────────────────── */
    .tabs {
        display: flex;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
        flex-shrink: 0;
    }

    .tab {
        padding: 7px 16px;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        font-size: 12px;
        font-weight: 500;
        color: #64748b;
        cursor: pointer;
        transition: color 0.1s, border-color 0.1s;
    }
    .tab:hover { color: #1e293b; }
    .tab.active { color: #2563eb; border-bottom-color: #2563eb; }

    /* ── Tab body ─────────────────────────────────────────────────────────── */
    .tab-body {
        flex: 1;
        overflow-y: auto;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    /* ── Columns tab ──────────────────────────────────────────────────────── */
    .col-row {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 5px 4px;
        border-radius: 5px;
        cursor: default;
    }
    .col-row:hover { background: #f8fafc; }
    .col-row.drag-over { border-top: 2px solid #3b82f6; }
    .col-row.dragging  { opacity: 0.4; }
    .col-row.col-expanded { background: #f0f4ff; }

    .drag-grip {
        color: #cbd5e1;
        cursor: grab;
        font-size: 13px;
        flex-shrink: 0;
        user-select: none;
        line-height: 1;
    }
    .drag-grip:hover { color: #94a3b8; }
    .drag-grip:active { cursor: grabbing; }

    .col-type-btn {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 3px;
        background: #f1f5f9;
        color: #475569;
        font-weight: 600;
        min-width: 20px;
        text-align: center;
        border: 1px solid #e2e8f0;
        cursor: pointer;
        flex-shrink: 0;
        height: 18px;
        line-height: 16px;
    }
    .col-type-btn:hover { background: #e2e8f0; }
    .col-type-btn.formula { font-family: monospace; color: #7c3aed; }

    .col-name {
        flex: 1;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
    }
    .col-name:hover { color: #3b82f6; }

    .col-name-input {
        flex: 1;
        font-size: 12px;
        border: 1px solid #94a3b8;
        border-radius: 3px;
        padding: 1px 5px;
        outline: none;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        min-width: 0;
    }

    .col-formula-badge {
        font-size: 9px;
        padding: 1px 4px;
        border-radius: 3px;
        background: #f5f3ff;
        color: #7c3aed;
        font-family: monospace;
        flex-shrink: 0;
        white-space: nowrap;
        overflow: hidden;
        max-width: 90px;
        text-overflow: ellipsis;
    }

    .col-readonly-badge {
        background: #f1f5f9;
        color: #64748b;
        font-family: sans-serif;
    }

    .col-del-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #cbd5e1;
        padding: 2px;
        border-radius: 3px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        opacity: 0;
        transition: opacity 0.1s;
    }
    .col-row:hover .col-del-btn { opacity: 1; }
    .col-del-btn:hover { color: #dc2626; background: #fef2f2; }
    .col-del-btn :global(svg) { width: 12px; height: 12px; }

    .col-config-slot {
        margin: 0 0 6px 28px;
        border-left: 2px solid #e2e8f0;
        padding-left: 8px;
    }

    .add-col-btn {
        margin-top: 4px;
        width: 100%;
        background: none;
        border: 1px dashed #cbd5e1;
        border-radius: 5px;
        padding: 7px 10px;
        font-size: 11px;
        color: #64748b;
        cursor: pointer;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 5px;
    }
    .add-col-btn:hover { border-color: #94a3b8; color: #1e293b; background: #f8fafc; }
    .add-col-btn :global(svg) { width: 11px; height: 11px; }

    /* ── Views tab ────────────────────────────────────────────────────────── */
    .view-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 6px 4px;
        border-radius: 5px;
        border: 1px solid transparent;
    }
    .view-row:hover { background: #f8fafc; }
    .view-row.expanded {
        background: #f8fafc;
        border-color: #e2e8f0;
        border-radius: 5px 5px 0 0;
    }

    /* Expand button — wider and more prominent */
    .view-expand-btn {
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        cursor: pointer;
        font-size: 10px;
        color: #475569;
        height: 22px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 3px;
        margin-top: 1px;
        border-radius: 4px;
        padding: 0 6px;
        font-weight: 500;
        transition: background 0.1s, color 0.1s;
    }
    .view-expand-btn:hover { background: #e2e8f0; color: #1e293b; }
    .view-expand-btn.open  { background: #dbeafe; border-color: #bfdbfe; color: #2563eb; }
    .expand-chevron { font-size: 9px; }
    .expand-label   { font-size: 10px; }

    .view-info {
        flex: 1;
        min-width: 0;
    }

    .view-name {
        font-size: 12px;
        font-weight: 600;
        display: block;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 3px;
    }
    .view-name:hover { color: #3b82f6; }

    .view-name-input {
        font-size: 12px;
        font-weight: 600;
        border: 1px solid #94a3b8;
        border-radius: 3px;
        padding: 1px 5px;
        outline: none;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        width: 100%;
        margin-bottom: 3px;
        box-sizing: border-box;
    }

    .view-chips {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
    }
    .chip {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 8px;
        font-weight: 500;
    }
    .chip.sheet  { background: #eff6ff; color: #2563eb; }
    .chip.cols   { background: #f0fdf4; color: #16a34a; }
    .chip.filt   { background: #fef9c3; color: #ca8a04; display:flex;align-items:center;gap:2px; }
    .chip.filt :global(svg) { width: 8px; height: 8px; }
    .chip.legacy { background: #f1f5f9; color: #94a3b8; font-style: italic; }

    .view-expand-spacer { width: 60px; flex-shrink: 0; }

    .view-row-actions {
        display: flex;
        gap: 3px;
        flex-shrink: 0;
    }
    .vra-btn {
        background: none;
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        padding: 2px 6px;
        font-size: 11px;
        color: #64748b;
        cursor: pointer;
        height: 22px;
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .vra-btn:hover { background: #f1f5f9; }
    .vra-btn.danger { color: #dc2626; border-color: #fca5a5; }
    .vra-btn.danger:hover { background: #fef2f2; }
    .vra-btn.move { color: #2563eb; border-color: #bfdbfe; font-size: 13px; }
    .vra-btn.move:hover { background: #eff6ff; }
    .vra-btn :global(svg) { width: 11px; height: 11px; }

    /* Expanded view detail */
    .view-detail {
        margin: 0 0 8px;
        padding: 10px 14px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-top: none;
        border-radius: 0 0 5px 5px;
    }

    .vd-section-label {
        font-size: 10px;
        font-weight: 600;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 5px;
        display: flex;
        align-items: center;
        gap: 5px;
    }

    .vd-section-hint {
        font-size: 9px;
        color: #b0b8c4;
        text-transform: none;
        letter-spacing: 0;
        font-weight: 400;
        font-style: italic;
    }

    /* Column order list */
    .vd-col-order {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-bottom: 4px;
    }

    .vd-col-item {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 3px 4px;
        border-radius: 4px;
        border: 1px solid transparent;
        font-size: 11px;
    }
    .vd-col-item.visible {
        background: #fff;
        border-color: #e2e8f0;
    }
    .vd-col-item.hidden {
        background: none;
        opacity: 0.55;
    }
    .vd-col-item.vd-drag-over { border-color: #3b82f6; border-style: dashed; }
    .vd-col-item.vd-dragging  { opacity: 0.3; }

    .vd-col-grip {
        color: #cbd5e1;
        cursor: grab;
        font-size: 12px;
        user-select: none;
        line-height: 1;
        flex-shrink: 0;
    }
    .vd-col-grip:hover { color: #94a3b8; }
    .vd-col-grip:active { cursor: grabbing; }
    .vd-col-grip-ph { width: 14px; flex-shrink: 0; }

    .vd-col-check {
        flex-shrink: 0;
        cursor: pointer;
        accent-color: #3b82f6;
    }

    .vd-col-type {
        font-size: 9px;
        width: 16px;
        text-align: center;
        color: #64748b;
        flex-shrink: 0;
    }

    .vd-col-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .vd-hidden-label {
        font-size: 9px;
        font-weight: 600;
        color: #b0b8c4;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 6px 0 3px 2px;
    }

    .vd-filter-row {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 4px 6px;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        margin-bottom: 3px;
    }
    .vdf-col { font-size: 11px; font-weight: 600; color: #1e293b; }
    .vdf-op  { font-size: 10px; color: #64748b; font-style: italic; }
    .vdf-val { font-size: 11px; color: #3b82f6; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vdf-del {
        background: none; border: none; cursor: pointer; color: #cbd5e1;
        display: flex; align-items: center; padding: 2px; border-radius: 3px; flex-shrink: 0;
    }
    .vdf-del:hover { color: #dc2626; background: #fef2f2; }
    .vdf-del :global(svg) { width: 11px; height: 11px; }

    .vd-filter-form {
        padding: 7px;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        display: flex;
        flex-direction: column;
        gap: 5px;
        margin-bottom: 4px;
    }
    .vff-sel, .vff-input {
        height: 24px;
        font-size: 11px;
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        padding: 0 5px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
        width: 100%;
        box-sizing: border-box;
    }
    .vff-sel.narrow { width: auto; }
    .vff-actions { display: flex; gap: 4px; align-items: center; }
    .vff-add {
        flex: 1; height: 24px; font-size: 11px;
        border: 1px solid #3b82f6; border-radius: 3px;
        background: #3b82f6; color: #fff; cursor: pointer; font-weight: 500;
        display: flex; align-items: center; justify-content: center; gap: 3px;
    }
    .vff-add:hover { background: #2563eb; }
    .vff-add :global(svg) { width: 11px; height: 11px; }
    .vff-cancel {
        width: 24px; height: 24px; border-radius: 3px;
        border: 1px solid #e2e8f0; cursor: pointer; background: #f8fafc; color: #64748b;
        display: flex; align-items: center; justify-content: center; padding: 0;
    }
    .vff-cancel:hover { background: #e2e8f0; }
    .vff-cancel :global(svg) { width: 11px; height: 11px; }

    .vd-add-filter-btn {
        background: none;
        border: 1px dashed #cbd5e1;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 10px;
        color: #64748b;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        margin-top: 2px;
    }
    .vd-add-filter-btn:hover { border-color: #94a3b8; color: #1e293b; }
    .vd-add-filter-btn :global(svg) { width: 10px; height: 10px; }

    .vd-clear-filters {
        background: none;
        border: 1px solid #fca5a5;
        border-radius: 3px;
        padding: 3px 8px;
        font-size: 10px;
        color: #dc2626;
        cursor: pointer;
        margin-top: 3px;
        width: 100%;
    }
    .vd-clear-filters:hover { background: #fef2f2; }

    .vd-pos {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .vd-pos-ref {
        font-size: 11px;
        color: #475569;
        font-family: monospace;
    }
    .vd-pos-edit {
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 4px;
        padding: 3px 8px;
        font-size: 10px;
        font-weight: 500;
        color: #2563eb;
        cursor: pointer;
        white-space: nowrap;
    }
    .vd-pos-edit:hover { background: #dbeafe; }

    /* ── Create view card ─────────────────────────────────────────────────── */
    .create-view-card {
        margin-top: 4px;
        padding: 12px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        gap: 7px;
    }

    .cv-header {
        font-size: 11px;
        font-weight: 700;
        color: #1e293b;
    }

    .cv-hint {
        font-size: 10px;
        color: #94a3b8;
        font-style: italic;
    }

    .cv-field-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .cv-label {
        font-size: 10px;
        font-weight: 600;
        color: #64748b;
        width: 36px;
        flex-shrink: 0;
        text-align: right;
    }
    .cv-input {
        flex: 1;
        height: 26px;
        font-size: 11px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        padding: 0 6px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
        box-sizing: border-box;
    }
    .cv-input:focus { border-color: #94a3b8; }

    .cv-actions {
        display: flex;
        gap: 5px;
        align-items: center;
    }
    .cv-create-btn {
        flex: 1; height: 28px; font-size: 11px;
        border: 1px solid #3b82f6; border-radius: 4px;
        background: #3b82f6; color: #fff; cursor: pointer; font-weight: 600;
        display: flex; align-items: center; justify-content: center; gap: 4px;
    }
    .cv-create-btn:hover { background: #2563eb; }
    .cv-create-btn :global(svg) { width: 12px; height: 12px; }
    .cv-cancel-btn {
        width: 28px; height: 28px; border-radius: 4px;
        border: 1px solid #e2e8f0; cursor: pointer; background: #f8fafc; color: #64748b;
        display: flex; align-items: center; justify-content: center; padding: 0;
    }
    .cv-cancel-btn:hover { background: #e2e8f0; }
    .cv-cancel-btn :global(svg) { width: 13px; height: 13px; }

    .add-view-btn {
        width: 100%; margin-top: 4px;
        background: none; border: 1px dashed #cbd5e1; border-radius: 5px;
        padding: 7px 10px; font-size: 11px; color: #64748b; cursor: pointer;
        text-align: left; display: flex; align-items: center; gap: 5px;
    }
    .add-view-btn:hover { border-color: #94a3b8; color: #1e293b; background: #f8fafc; }
    .add-view-btn :global(svg) { width: 11px; height: 11px; }
</style>
