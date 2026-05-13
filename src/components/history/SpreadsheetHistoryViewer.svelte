<script>
    /**
     * SpreadsheetHistoryViewer — focused diff view for spreadsheet history.
     *
     * Shows:
     *  - Sheet tabs (only sheets with changes)
     *  - Per-sheet: a mini diff grid (changed region + context) and a change detail list
     *
     * Props:
     *   prevDoc     - Y.Doc of the "before" state (previous snapshot)
     *   snapDoc     - Y.Doc of the "after" state (selected snapshot)
     *   diff        - DiffResult from computeSpreadsheetDiff(prevDoc, snapDoc)
     */

    const CONTEXT_PAD = 3; // rows/cols of context around the changed region
    const MAX_GRID_SPAN = 60; // if range is wider/taller, show list only (no grid)

    let { prevDoc = null, snapDoc = null, diff = null } = $props();

    let activeSheetIdx = $state(0);

    // Sheets that have any changes
    let changedSheets = $derived.by(() => {
        if (!diff?.sheets) return [];
        return diff.sheets.filter(s =>
            s.isNew || s.isDeleted ||
            s.totalChanged + s.totalAdded + s.totalRemoved > 0 ||
            s.tableChanges?.length > 0 ||
            s.structureChanges?.length > 0 ||
            s.formatChanges > 0
        );
    });

    let activeSheet = $derived(changedSheets[activeSheetIdx] ?? null);

    // Parse A1 notation → {row, col} (1-based)
    function parseA1(ref) {
        const m = ref?.match(/^([A-Z]+)(\d+)$/i);
        if (!m) return null;
        let col = 0;
        for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
        return { row: parseInt(m[2]), col };
    }

    // 1-based col → A, B, ..., Z, AA, AB, ...
    function colLabel(col) {
        let label = '';
        while (col > 0) {
            label = String.fromCharCode(((col - 1) % 26) + 65) + label;
            col = Math.floor((col - 1) / 26);
        }
        return label;
    }

    // Build a map of A1 → CellDiff for efficient lookup
    function buildCellMap(cells) {
        const m = new Map();
        for (const c of cells ?? []) m.set(c.ref, c);
        return m;
    }

    // Compute bounding box of changed cells
    function getBBox(cells) {
        let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
        for (const c of cells ?? []) {
            const pos = parseA1(c.ref);
            if (!pos) continue;
            if (pos.row < minRow) minRow = pos.row;
            if (pos.row > maxRow) maxRow = pos.row;
            if (pos.col < minCol) minCol = pos.col;
            if (pos.col > maxCol) maxCol = pos.col;
        }
        return { minRow, maxRow, minCol, maxCol };
    }

    // Build the mini grid data for the active sheet
    let gridData = $derived.by(() => {
        if (!activeSheet) return null;
        const cells = activeSheet.cells ?? [];
        if (cells.length === 0) return null;

        const { minRow, maxRow, minCol, maxCol } = getBBox(cells);
        if (!isFinite(minRow)) return null;

        const r0 = Math.max(1, minRow - CONTEXT_PAD);
        const r1 = maxRow + CONTEXT_PAD;
        const c0 = Math.max(1, minCol - CONTEXT_PAD);
        const c1 = maxCol + CONTEXT_PAD;

        const spanRows = r1 - r0 + 1;
        const spanCols = c1 - c0 + 1;

        if (spanRows > MAX_GRID_SPAN || spanCols > MAX_GRID_SPAN) {
            return null; // too large to render inline
        }

        const cellMap = buildCellMap(cells);

        // Build row × col grid
        const rows = [];
        for (let r = r0; r <= r1; r++) {
            const cols = [];
            for (let c = c0; c <= c1; c++) {
                const ref = `${colLabel(c)}${r}`;
                const diff = cellMap.get(ref) ?? null;
                cols.push({ ref, diff });
            }
            rows.push({ r, cols });
        }

        return { rows, c0, c1, r0, r1 };
    });

    function cellClass(diff) {
        if (!diff) return 'ctx';
        return { changed: 'changed', added: 'added', removed: 'removed' }[diff.status] ?? 'changed';
    }

    function truncate(val, len = 20) {
        if (!val || val === '(empty)') return '';
        return val.length > len ? val.slice(0, len) + '…' : val;
    }

    function totalChanges(sheet) {
        return (sheet.totalChanged ?? 0) + (sheet.totalAdded ?? 0) + (sheet.totalRemoved ?? 0);
    }

    function sheetTabLabel(sheet) {
        const n = totalChanges(sheet) + (sheet.tableChanges?.length ?? 0) + (sheet.structureChanges?.length ?? 0) + (sheet.formatChanges ?? 0);
        return `${sheet.name} (${n})`;
    }
</script>

{#if !diff || changedSheets.length === 0}
    <div class="placeholder">
        <div class="placeholder-icon">✓</div>
        <div>No content changes in this snapshot</div>
    </div>
{:else}

<!-- Sheet tabs -->
<div class="sheet-tabs">
    {#each changedSheets as sheet, i}
        <button
            class="sheet-tab {i === activeSheetIdx ? 'sheet-tab--active' : ''}"
            onclick={() => { activeSheetIdx = i; }}
        >
            {#if sheet.isNew}+ {/if}{#if sheet.isDeleted}− {/if}{sheetTabLabel(sheet)}
        </button>
    {/each}
</div>

{#if activeSheet}
<div class="sheet-view">

    <!-- Mini diff grid (when range is not too large) -->
    {#if gridData}
    <div class="grid-wrap">
        <table class="diff-grid">
            <!-- Col header row -->
            <thead>
                <tr>
                    <th class="corner-cell"></th>
                    {#each gridData.rows[0].cols as col}
                        <th class="col-header">{colLabel(parseA1(col.ref)?.col ?? 0)}</th>
                    {/each}
                </tr>
            </thead>
            <tbody>
                {#each gridData.rows as row}
                    <tr>
                        <td class="row-header">{row.r}</td>
                        {#each row.cols as cell}
                            {@const cls = cellClass(cell.diff)}
                            <td class="grid-cell grid-cell--{cls}" title={cell.diff ? `${cell.diff.from} → ${cell.diff.to}` : ''}>
                                {#if cell.diff}
                                    {#if cell.diff.status === 'removed'}
                                        <span class="cell-old">{truncate(cell.diff.from)}</span>
                                    {:else if cell.diff.status === 'added'}
                                        <span class="cell-new">{truncate(cell.diff.to)}</span>
                                    {:else}
                                        <span class="cell-old">{truncate(cell.diff.from, 12)}</span>
                                        <span class="cell-arrow">→</span>
                                        <span class="cell-new">{truncate(cell.diff.to, 12)}</span>
                                    {/if}
                                {/if}
                            </td>
                        {/each}
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
    {/if}

    <!-- Change detail list -->
    <div class="change-list">

        <!-- Counters header -->
        <div class="change-summary-row">
            {#if activeSheet.totalChanged > 0}<span class="chip chip--changed">{activeSheet.totalChanged} changed</span>{/if}
            {#if activeSheet.totalAdded > 0}<span class="chip chip--added">{activeSheet.totalAdded} added</span>{/if}
            {#if activeSheet.totalRemoved > 0}<span class="chip chip--removed">{activeSheet.totalRemoved} removed</span>{/if}
            {#if activeSheet.formatChanges > 0}<span class="chip chip--format">{activeSheet.formatChanges} formatting</span>{/if}
            {#if activeSheet.tableChanges?.length > 0}<span class="chip chip--table">{activeSheet.tableChanges.length} table{activeSheet.tableChanges.length !== 1 ? 's' : ''}</span>{/if}
            {#if activeSheet.structureChanges?.length > 0}<span class="chip chip--struct">{activeSheet.structureChanges.length} structural</span>{/if}
        </div>

        <!-- Cell value changes -->
        {#if activeSheet.cells?.length > 0}
        <div class="section-header">Cell Changes</div>
        {#each activeSheet.cells as cell}
            <div class="change-row change-row--{cell.status}">
                <span class="change-ref">{cell.ref}</span>
                {#if cell.status === 'removed'}
                    <span class="change-val val-old">{cell.from}</span>
                    <span class="change-arrow">→</span>
                    <span class="change-empty">(deleted)</span>
                {:else if cell.status === 'added'}
                    <span class="change-empty">(empty)</span>
                    <span class="change-arrow">→</span>
                    <span class="change-val val-new">{cell.to}</span>
                {:else}
                    <span class="change-val val-old">{cell.from}</span>
                    <span class="change-arrow">→</span>
                    <span class="change-val val-new">{cell.to}</span>
                {/if}
            </div>
        {/each}
        {#if (activeSheet.totalChanged + activeSheet.totalAdded + activeSheet.totalRemoved) > activeSheet.cells.length}
            <div class="overflow-msg">
                +{(activeSheet.totalChanged + activeSheet.totalAdded + activeSheet.totalRemoved) - activeSheet.cells.length} more changes not shown
            </div>
        {/if}
        {/if}

        <!-- Table changes -->
        {#if activeSheet.tableChanges?.length > 0}
        <div class="section-header">Table Changes</div>
        {#each activeSheet.tableChanges as tc}
            <div class="change-row change-row--table">
                <span class="change-ref">Table</span>
                <span class="change-val">
                    {#if tc.type === 'added'}+ {tc.name}{:else if tc.type === 'removed'}− {tc.name}{:else if tc.type === 'renamed'}Renamed "{tc.from}" → "{tc.to}"{:else}{tc.name}: {tc.detail ?? tc.type}{/if}
                </span>
            </div>
        {/each}
        {/if}

        <!-- Structure changes -->
        {#if activeSheet.structureChanges?.length > 0}
        <div class="section-header">Structure Changes</div>
        {#each activeSheet.structureChanges as sc}
            <div class="change-row change-row--struct">
                <span class="change-ref">{sc.field}</span>
                <span class="change-val val-old">{sc.from}</span>
                <span class="change-arrow">→</span>
                <span class="change-val val-new">{sc.to}</span>
            </div>
        {/each}
        {/if}

        <!-- Format changes -->
        {#if activeSheet.formatChanges > 0 && activeSheet.formatCells?.length > 0}
        <div class="section-header">Formatting Changes ({activeSheet.formatChanges})</div>
        {#each activeSheet.formatCells as fc}
            <div class="change-row change-row--format">
                <span class="change-ref">{fc.ref}</span>
                <span class="change-val">{fc.changes?.map(c => c.field).join(', ')}</span>
            </div>
        {/each}
        {/if}

        {#if activeSheet.isNew}
            <div class="sheet-status-msg sheet-status-msg--added">New sheet added</div>
        {:else if activeSheet.isDeleted}
            <div class="sheet-status-msg sheet-status-msg--removed">Sheet deleted</div>
        {/if}
    </div>

</div>
{/if}

<!-- Doc-level meta -->
{#if diff.meta?.renamedSheets?.length > 0 || diff.meta?.sheetOrderChanged}
<div class="meta-section">
    {#if diff.meta.sheetOrderChanged}
        <div class="meta-item">Sheet order changed</div>
    {/if}
    {#each diff.meta.renamedSheets as r}
        <div class="meta-item">Sheet renamed: "{r.from}" → "{r.to}"</div>
    {/each}
</div>
{/if}

{/if}

<style>
    .placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        gap: 8px;
        font-size: 14px;
        color: #888;
    }
    .placeholder-icon { font-size: 32px; }

    /* Sheet tabs */
    .sheet-tabs {
        display: flex;
        gap: 2px;
        padding: 8px 12px 0;
        border-bottom: 2px solid #e0e0e0;
        overflow-x: auto;
        flex-shrink: 0;
    }
    .sheet-tab {
        padding: 5px 12px;
        font-size: 12px;
        border: 1px solid #e0e0e0;
        border-bottom: none;
        background: #f5f5f5;
        color: #555;
        border-radius: 4px 4px 0 0;
        cursor: pointer;
        white-space: nowrap;
    }
    .sheet-tab:hover { background: #eee; color: #222; }
    .sheet-tab--active { background: #fff; color: #222; font-weight: 600; border-color: #e0e0e0; }

    /* Sheet view area */
    .sheet-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    /* Mini diff grid */
    .grid-wrap {
        overflow: auto;
        max-height: 300px;
        border-bottom: 1px solid #e8e8e8;
        padding: 8px 12px;
        background: #fafafa;
    }

    .diff-grid {
        border-collapse: collapse;
        font-size: 11px;
        font-family: monospace;
    }

    .corner-cell, .col-header, .row-header {
        background: #f0f0f0;
        color: #888;
        font-weight: 600;
        font-size: 10px;
        padding: 2px 6px;
        border: 1px solid #e0e0e0;
        text-align: center;
        min-width: 24px;
    }

    .grid-cell {
        border: 1px solid #e8e8e8;
        padding: 2px 5px;
        min-width: 60px;
        max-width: 140px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 11px;
        vertical-align: middle;
    }
    .grid-cell--ctx      { background: #fff; color: #ccc; }
    .grid-cell--changed  { background: #fff9c4; }
    .grid-cell--added    { background: #e6f4ea; }
    .grid-cell--removed  { background: #fde8e8; }

    .cell-old   { color: #a00; text-decoration: line-through; font-size: 10px; }
    .cell-new   { color: #1a7a1a; font-weight: 600; }
    .cell-arrow { color: #aaa; margin: 0 2px; font-size: 10px; }

    /* Change list */
    .change-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px 12px;
    }

    .change-summary-row {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
        margin-bottom: 10px;
    }

    .chip {
        font-size: 10px;
        padding: 2px 7px;
        border-radius: 10px;
        font-weight: 600;
    }
    .chip--changed  { background: #fff9c4; color: #7a6800; }
    .chip--added    { background: #e6f4ea; color: #1a5c1a; }
    .chip--removed  { background: #fde8e8; color: #a00; }
    .chip--format   { background: #e8f0fe; color: #1a4a8a; }
    .chip--table    { background: #fce8ff; color: #7a0f8a; }
    .chip--struct   { background: #fff3e0; color: #8a4400; }

    .section-header {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #aaa;
        margin: 10px 0 4px;
    }

    .change-row {
        display: flex;
        align-items: baseline;
        gap: 6px;
        padding: 3px 0;
        border-bottom: 1px solid #f5f5f5;
        font-size: 12px;
    }

    .change-ref {
        font-family: monospace;
        font-size: 11px;
        font-weight: 600;
        color: #555;
        min-width: 40px;
        flex-shrink: 0;
    }

    .change-val {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .val-old { color: #a00; text-decoration: line-through; }
    .val-new { color: #1a7a1a; font-weight: 500; }

    .change-arrow { color: #bbb; flex-shrink: 0; }
    .change-empty { color: #bbb; font-style: italic; }

    .overflow-msg {
        font-size: 11px;
        color: #aaa;
        padding: 4px 0;
        font-style: italic;
    }

    .sheet-status-msg {
        padding: 8px 0;
        font-size: 12px;
        font-weight: 500;
    }
    .sheet-status-msg--added   { color: #1a7a1a; }
    .sheet-status-msg--removed { color: #a00; }

    .meta-section {
        padding: 8px 12px;
        border-top: 1px solid #e8e8e8;
        background: #fafafa;
        font-size: 11px;
        color: #666;
    }
    .meta-item { padding: 2px 0; }
</style>
