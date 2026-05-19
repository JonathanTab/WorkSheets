<script>
    /**
     * SpreadsheetHistoryViewer — diff viewer for spreadsheet snapshots.
     *
     * Reads the v4 spreadsheet schema directly from the snapshot Y.Doc
     * (cellValues + cellStyles as YKeyValue-backed Y.Arrays). Renders a
     * scrollable grid covering the changed region (± context rows/cols) with
     * diff highlights from the server-precomputed diff JSON.
     *
     * Props:
     *   prevDoc  - Y.Doc of the "before" state (may be empty for initial snapshots)
     *   snapDoc  - Y.Doc of the "after" state (selected snapshot)
     *   diff     - parsed server diff object (v2 JSON from diff_json column, or null)
     *   currentDoc - live Y.Doc (not used by this viewer, but passed through)
     */

    import * as Y from 'yjs';

    const CONTEXT_PAD = 3;
    const MAX_GRID_ROWS = 100;
    const MAX_GRID_COLS = 40;

    let { prevDoc = null, snapDoc = null, diff = null } = $props();

    // ─── Read YKeyValue Y.Array into Map<key, value> ───────────────────────────
    function readYKeyValue(arr) {
        const map = new Map();
        if (!arr || !(arr instanceof Y.Array)) return map;
        arr.forEach(item => {
            if (item instanceof Y.Map) {
                const k = item.get('key');
                const v = item.get('val');
                if (k !== undefined) map.set(k, v);
            }
        });
        return map;
    }

    // ─── Cell display helpers ──────────────────────────────────────────────────
    function colToLetter(col) {
        let s = '', n = col + 1;
        while (n > 0) { const r = (n-1)%26; s = String.fromCharCode(65+r)+s; n = Math.floor((n-1)/26); }
        return s;
    }

    function formatVal(v) {
        if (v === undefined || v === null || v === '') return '';
        const s = String(v);
        return s.length > 30 ? s.slice(0, 28) + '…' : s;
    }

    // ─── Diff processing ───────────────────────────────────────────────────────

    // Build per-sheet cell lookup from v2 diff: Map<sheetId, Map<"row,col", cellEntry>>
    let diffCellsBySheet = $derived.by(() => {
        const result = new Map();
        if (!diff?.sheets) return result;
        for (const sheet of diff.sheets) {
            if (!sheet.cells?.length) continue;
            const m = new Map();
            for (const c of sheet.cells) {
                m.set(`${c.row},${c.col}`, c);
            }
            result.set(sheet.id, m);
        }
        return result;
    });

    // Sheets from the diff that have any changes
    let changedSheets = $derived.by(() => {
        if (!diff?.sheets) return [];
        return diff.sheets.filter(s =>
            s.isNew || s.isDeleted ||
            s.cells?.length > 0 ||
            s.formatCells?.length > 0 ||
            s.structure?.length > 0 ||
            s.tables?.length > 0
        );
    });

    let activeSheetIdx = $state(0);
    let activeSheet = $derived(changedSheets[activeSheetIdx] ?? null);

    // ─── Read sheet cells from the snapshot Y.Doc ──────────────────────────────
    function getSheetYMap(ydoc, sheetId) {
        if (!ydoc) return null;
        return ydoc.getMap('spreadsheet')?.get('sheets')?.get(sheetId) ?? null;
    }

    // Build the grid for the active sheet
    let gridData = $derived.by(() => {
        if (!activeSheet || !snapDoc) return null;

        const sheetId = activeSheet.id;
        const cellMap = diffCellsBySheet.get(sheetId);

        // If deleted or no cells, nothing to render
        if (activeSheet.isDeleted || !cellMap) return null;

        const cells = activeSheet.cells ?? [];
        if (cells.length === 0) return null;

        // Find bounding box of changed cells
        let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
        for (const c of cells) {
            if (c.row < minRow) minRow = c.row;
            if (c.row > maxRow) maxRow = c.row;
            if (c.col < minCol) minCol = c.col;
            if (c.col > maxCol) maxCol = c.col;
        }
        if (!isFinite(minRow)) return null;

        const r0 = Math.max(0, minRow - CONTEXT_PAD);
        const r1 = Math.min(r0 + MAX_GRID_ROWS - 1, maxRow + CONTEXT_PAD);
        const c0 = Math.max(0, minCol - CONTEXT_PAD);
        const c1 = Math.min(c0 + MAX_GRID_COLS - 1, maxCol + CONTEXT_PAD);

        // Read actual cell values from the snapshot Y.Doc
        const sheetYMap = getSheetYMap(snapDoc, sheetId);
        const snapCellValues = sheetYMap ? readYKeyValue(sheetYMap.get('cellValues')) : new Map();

        const rows = [];
        for (let r = r0; r <= r1; r++) {
            const cols = [];
            for (let c = c0; c <= c1; c++) {
                const key = `${r},${c}`;
                const cellDiff = cellMap?.get(key) ?? null;
                const valEntry = snapCellValues.get(key);
                const displayVal = formatVal(valEntry?.v ?? valEntry);
                cols.push({ r, c, key, cellDiff, displayVal });
            }
            rows.push({ r, cols });
        }

        const truncated = activeSheet.cellsTruncated > 0;
        return { rows, r0, r1, c0, c1, truncated, totalChanged: cells.length };
    });

    function statusClass(cellDiff) {
        if (!cellDiff) return '';
        return { changed: 'diff-changed', added: 'diff-added', removed: 'diff-removed' }[cellDiff.status] ?? '';
    }

    function tooltipText(cellDiff) {
        if (!cellDiff) return '';
        const from = cellDiff.from?.v ?? null;
        const to   = cellDiff.to?.v   ?? null;
        const fStr = (from === null || from === '') ? '(empty)' : String(from).slice(0, 50);
        const tStr = (to   === null || to   === '') ? '(empty)' : String(to).slice(0, 50);
        if (cellDiff.status === 'added')   return `(empty) → ${tStr}`;
        if (cellDiff.status === 'removed') return `${fStr} → (deleted)`;
        return `${fStr} → ${tStr}`;
    }

    function sheetTabLabel(sheet) {
        const n = (sheet.cells?.length ?? 0) + (sheet.formatCells?.length ?? 0) + (sheet.tables?.length ?? 0);
        const flag = sheet.isNew ? '+' : sheet.isDeleted ? '−' : '';
        return `${flag}${sheet.name}${n > 0 ? ` (${n})` : ''}`;
    }

    // Totals from the diff for summary chips
    let totals = $derived(diff?.totals ?? null);
</script>

{#if !diff || (changedSheets.length === 0 && !diff.isInitial)}
    <div class="placeholder">
        <div class="placeholder-icon">✓</div>
        <div>No content changes in this snapshot</div>
    </div>
{:else if diff.isInitial && changedSheets.length === 0}
    <div class="placeholder">
        <div class="placeholder-icon">📄</div>
        <div>Initial version</div>
    </div>
{:else}

<!-- Sheet tabs -->
<div class="sheet-tabs">
    {#each changedSheets as sheet, i}
        <button
            class="sheet-tab {i === activeSheetIdx ? 'sheet-tab--active' : ''}"
            type="button"
            onclick={() => { activeSheetIdx = i; }}
        >
            {sheetTabLabel(sheet)}
        </button>
    {/each}
</div>

<!-- Summary chips -->
{#if totals}
<div class="summary-bar">
    {#if totals.cells > 0}<span class="chip chip--cell">{totals.cells} cell{totals.cells !== 1 ? 's' : ''}</span>{/if}
    {#if totals.formatting > 0}<span class="chip chip--fmt">{totals.formatting} formatting</span>{/if}
    {#if totals.structure > 0}<span class="chip chip--struct">{totals.structure} structural</span>{/if}
    {#if totals.tables > 0}<span class="chip chip--table">{totals.tables} table change{totals.tables !== 1 ? 's' : ''}</span>{/if}
    {#if totals.sheetsAdded > 0}<span class="chip chip--add">{totals.sheetsAdded} sheet added</span>{/if}
    {#if totals.sheetsRemoved > 0}<span class="chip chip--remove">{totals.sheetsRemoved} sheet removed</span>{/if}
</div>
{/if}

{#if activeSheet}
<div class="sheet-view">

    {#if activeSheet.isNew}
        <div class="sheet-status sheet-status--added">New sheet added</div>
    {:else if activeSheet.isDeleted}
        <div class="sheet-status sheet-status--removed">Sheet deleted</div>
    {:else if gridData}

    <!-- Diff grid -->
    <div class="grid-scroll">
        <table class="diff-grid">
            <thead>
                <tr>
                    <th class="hdr-corner"></th>
                    {#each gridData.rows[0]?.cols ?? [] as cell}
                        <th class="hdr-col">{colToLetter(cell.c)}</th>
                    {/each}
                </tr>
            </thead>
            <tbody>
                {#each gridData.rows as row}
                    <tr>
                        <td class="hdr-row">{row.r + 1}</td>
                        {#each row.cols as cell}
                            <td
                                class="grid-cell {statusClass(cell.cellDiff)}"
                                title={tooltipText(cell.cellDiff)}
                            >
                                {#if cell.cellDiff?.status === 'removed'}
                                    <span class="val-old">{formatVal(cell.cellDiff.from?.v)}</span>
                                {:else}
                                    {cell.displayVal}
                                    {#if cell.cellDiff?.status === 'changed'}
                                        <span class="val-from" title={tooltipText(cell.cellDiff)}>↑{formatVal(cell.cellDiff.from?.v)}</span>
                                    {/if}
                                {/if}
                            </td>
                        {/each}
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>

    {#if gridData.truncated}
        <div class="truncate-msg">Showing first {gridData.totalChanged} of {gridData.totalChanged + activeSheet.cellsTruncated} changes. Open a full diff to see all.</div>
    {/if}

    <!-- Structured change list below the grid -->
    <div class="change-list">

        <!-- Format changes -->
        {#if activeSheet.formatCells?.length > 0}
        <div class="section-hdr">Formatting Changes ({activeSheet.formatCells.length})</div>
        {#each activeSheet.formatCells.slice(0, 20) as fc}
            <div class="change-row">
                <span class="change-ref">{fc.ref}</span>
                <span class="change-detail">{fc.changes?.map(c => c.field).join(', ')}</span>
            </div>
        {/each}
        {/if}

        <!-- Structure -->
        {#if activeSheet.structure?.length > 0}
        <div class="section-hdr">Structure Changes</div>
        {#each activeSheet.structure as sc}
            <div class="change-row">
                <span class="change-ref">{sc.field}</span>
                {#if sc.from}<span class="val-old">{sc.from}</span><span class="arrow">→</span>{/if}
                <span class="val-new">{sc.to}</span>
            </div>
        {/each}
        {/if}

        <!-- Tables -->
        {#if activeSheet.tables?.length > 0}
        <div class="section-hdr">Table Changes</div>
        {#each activeSheet.tables as tc}
            <div class="change-row">
                <span class="change-ref">{tc.name}</span>
                <span class="change-detail">
                    {#if tc.type === 'added'}added{:else if tc.type === 'removed'}removed{:else if tc.type === 'renamed'}{tc.from} → {tc.to}{:else}{tc.detail ?? tc.type}{/if}
                </span>
            </div>
        {/each}
        {/if}

    </div>

    {:else if activeSheet.structure?.length > 0 || activeSheet.tables?.length > 0 || activeSheet.formatCells?.length > 0}
    <!-- No cell value changes but other changes exist -->
    <div class="change-list">
        {#if activeSheet.formatCells?.length > 0}
        <div class="section-hdr">Formatting Changes ({activeSheet.formatCells.length})</div>
        {#each activeSheet.formatCells.slice(0, 30) as fc}
            <div class="change-row">
                <span class="change-ref">{fc.ref}</span>
                <span class="change-detail">{fc.changes?.map(c => c.field).join(', ')}</span>
            </div>
        {/each}
        {/if}
        {#if activeSheet.structure?.length > 0}
        <div class="section-hdr">Structure</div>
        {#each activeSheet.structure as sc}
            <div class="change-row">
                <span class="change-ref">{sc.field}</span>
                {#if sc.from}<span class="val-old">{sc.from}</span><span class="arrow">→</span>{/if}
                <span class="val-new">{sc.to}</span>
            </div>
        {/each}
        {/if}
        {#if activeSheet.tables?.length > 0}
        <div class="section-hdr">Tables</div>
        {#each activeSheet.tables as tc}
            <div class="change-row">
                <span class="change-ref">{tc.name}</span>
                <span class="change-detail">{tc.type === 'added' ? 'added' : tc.type === 'removed' ? 'removed' : tc.detail ?? tc.type}</span>
            </div>
        {/each}
        {/if}
    </div>
    {:else}
    <div class="placeholder">
        <div>Sheet-level changes detected but no cell details available.</div>
    </div>
    {/if}

</div>
{/if}

<!-- Doc-level metadata -->
{#if diff?.sheetsRenamed?.length > 0 || diff?.sheetOrder}
<div class="meta-bar">
    {#if diff.sheetOrder}<div class="meta-item">Sheet order changed</div>{/if}
    {#each diff.sheetsRenamed as r}
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
        text-align: center;
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
    .sheet-tab:hover { background: #eee; }
    .sheet-tab--active { background: #fff; color: #222; font-weight: 600; }

    /* Summary chips */
    .summary-bar {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
        padding: 8px 12px;
        border-bottom: 1px solid #f0f0f0;
        flex-shrink: 0;
    }
    .chip {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 7px;
        border-radius: 10px;
    }
    .chip--cell   { background: #fff9c4; color: #7a6800; }
    .chip--fmt    { background: #e8f0fe; color: #1a4a8a; }
    .chip--struct { background: #fff3e0; color: #8a4400; }
    .chip--table  { background: #fce8ff; color: #7a0f8a; }
    .chip--add    { background: #e6f4ea; color: #1a5c1a; }
    .chip--remove { background: #fde8e8; color: #a00; }

    /* Sheet view */
    .sheet-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .sheet-status {
        padding: 12px;
        font-size: 13px;
        font-weight: 500;
    }
    .sheet-status--added   { color: #1a7a1a; }
    .sheet-status--removed { color: #a00; }

    /* Diff grid */
    .grid-scroll {
        overflow: auto;
        max-height: 340px;
        border-bottom: 1px solid #e8e8e8;
        padding: 8px 12px;
        background: #fafafa;
        flex-shrink: 0;
    }

    .diff-grid {
        border-collapse: collapse;
        font-size: 11px;
        font-family: monospace;
    }

    .hdr-corner, .hdr-col, .hdr-row {
        background: #f0f0f0;
        color: #888;
        font-weight: 600;
        font-size: 10px;
        padding: 2px 6px;
        border: 1px solid #e0e0e0;
        text-align: center;
        min-width: 24px;
        position: sticky;
    }
    .hdr-col { top: 0; }
    .hdr-row { left: 0; }
    .hdr-corner { top: 0; left: 0; z-index: 1; }

    .grid-cell {
        border: 1px solid #e8e8e8;
        padding: 2px 5px;
        min-width: 70px;
        max-width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 11px;
        vertical-align: top;
        cursor: default;
        position: relative;
    }
    .diff-changed { background: #fff9c4; }
    .diff-added   { background: #e6f4ea; }
    .diff-removed { background: #fde8e8; }

    .val-old {
        color: #a00;
        text-decoration: line-through;
        font-size: 10px;
    }
    .val-from {
        display: block;
        font-size: 9px;
        color: #a00;
        text-decoration: line-through;
        opacity: 0.7;
        margin-top: 1px;
    }

    /* Change list */
    .change-list {
        flex: 1;
        overflow-y: auto;
        padding: 4px 12px 8px;
    }

    .section-hdr {
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
        min-width: 50px;
        flex-shrink: 0;
    }

    .change-detail { color: #666; flex: 1; }

    .val-new { color: #1a7a1a; font-weight: 500; }
    .arrow   { color: #bbb; flex-shrink: 0; }

    .truncate-msg {
        font-size: 11px;
        color: #aaa;
        padding: 4px 12px;
        font-style: italic;
        flex-shrink: 0;
    }

    /* Doc-level meta */
    .meta-bar {
        padding: 6px 12px;
        border-top: 1px solid #e8e8e8;
        background: #fafafa;
        font-size: 11px;
        color: #666;
        flex-shrink: 0;
    }
    .meta-item { padding: 2px 0; }
</style>
