<script>
    /**
     * SplitOverlay — drives the Entry Forge "split a transaction" flow.
     *
     * Opened from the grid context menu (sets entryForgeUi.split). The original
     * row is highlighted; clicking "Add New Row" inserts a real adjacent table
     * row (so the user edits it with full native grid editing) pre-filled with the
     * current remaining amount. The original row's amount live-updates to
     * `startingAmount − Σ(split amounts)`. On "Done", if the remaining is ~0 the
     * original row is deleted; otherwise it stays with the reduced amount.
     *
     * Rows are tracked by their stable `_pos` (the plain-object row snapshots are
     * rebuilt on every sync, so object identity can't be relied on; `_pos` only
     * changes on reorder, which this flow never triggers).
     */
    import { spreadsheetSession } from '../../../../stores/spreadsheetStore.svelte.js';
    import { HEADER_WIDTH, HEADER_HEIGHT } from '../../../../stores/spreadsheet/constants.js';
    import { getConfig } from '../../../../stores/spreadsheet/plugins/entryForge/entryForgeConfig.js';
    import { toAmount } from '../../../../stores/spreadsheet/plugins/entryForge/mirrorDetection.js';
    import { entryForgeUi, closeSplit } from '../../../../stores/spreadsheet/plugins/entryForge/entryForgeUiState.svelte.js';

    let { virtualizer } = $props();

    const ROW_HILITE = '#fef9c3';   // pale yellow row background
    const AMT_HILITE = '#fde68a';   // amber amount cell
    const ZERO_EPS = 0.005;

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let tableManager = $derived(spreadsheetSession.tableManager);

    /**
     * @type {{ table:any, mapping:any, originalPos:number, startingAmount:number,
     *          splitPositions:number[] } | null}
     */
    let session = $state(null);

    // Plain (non-reactive) guard so the init effect runs once per open request.
    let activeReq = null;

    function round6(n) { return Math.round(n * 1e6) / 1e6; }

    /** Current display index of a row identified by its _pos, or -1. */
    function indexOfPos(table, pos) {
        return table.sortedFilteredRows.findIndex(r => r._pos === pos);
    }

    function initSession(req) {
        const table = tableManager?.stores?.get(req.tableId);
        if (!table) return null;
        const cfg = getConfig(sheetStore, table.sourceTableId);
        const mapping = cfg?.mapping;
        if (!mapping?.amount) return null;

        const origRow = table.sortedFilteredRows[req.displayIndex];
        if (!origRow) return null;

        const startingAmount = toAmount(origRow[mapping.amount]) || 0;

        // Highlight the original row + its amount cell. Formatting attaches to the
        // row's Y.Map so it travels with the row regardless of later index shifts.
        table.setTableRowFormatting(req.displayIndex, { backgroundColor: ROW_HILITE });
        table.setCellFormatting(req.displayIndex, mapping.amount, { bold: true, backgroundColor: AMT_HILITE });

        return { table, mapping, originalPos: origRow._pos, startingAmount, splitPositions: [] };
    }

    // ── Open / close lifecycle ──────────────────────────────────────────────────
    $effect(() => {
        const req = entryForgeUi.split;
        if (req === activeReq) return;
        activeReq = req;
        if (!req) { session = null; return; }
        const s = initSession(req);
        session = s;
        if (!s) closeSplit(); // bad config — bail out cleanly
    });

    // ── Live subtraction: original amount = starting − Σ split amounts ──────────
    function sumSplits(s) {
        const rows = s.table.sortedFilteredRows;
        let sum = 0;
        for (const pos of s.splitPositions) {
            const r = rows.find(rr => rr._pos === pos);
            if (r) sum += toAmount(r[s.mapping.amount]) || 0;
        }
        return sum;
    }

    let remaining = $derived.by(() => {
        const s = session;
        if (!s) return 0;
        const _tv = tableManager?.tableVersion; // recompute on any table change
        return round6(s.startingAmount - sumSplits(s));
    });

    $effect(() => {
        const s = session;
        if (!s) return;
        const rem = remaining; // dep
        const origIdx = indexOfPos(s.table, s.originalPos);
        if (origIdx < 0) return;
        const current = toAmount(s.table.sortedFilteredRows[origIdx][s.mapping.amount]) || 0;
        if (Math.abs(current - rem) > 1e-6) {
            s.table.updateCell(origIdx, s.mapping.amount, rem);
        }
    });

    // ── Actions ─────────────────────────────────────────────────────────────────
    function addRow() {
        const s = session;
        if (!s) return;
        const rows = s.table.sortedFilteredRows;
        const origIdx = indexOfPos(s.table, s.originalPos);
        if (origIdx < 0) return;
        const origRow = rows[origIdx];

        // Copy all (stored) columns from the original, but leave the amount empty
        // so the user fills it in — the original's amount only drops once a split
        // amount is entered. Insert above the original (tables show newest on top).
        const newData = {};
        for (const col of s.table.columns) {
            if (col.isNonEntry) continue;
            newData[col.id] = origRow[col.id];
        }
        newData[s.mapping.amount] = null;

        const inserted = s.table.insertRowBefore(origIdx, newData);
        if (inserted) session.splitPositions = [...s.splitPositions, inserted._pos];
    }

    function clearHighlight(s, origIdx) {
        if (origIdx < 0) return;
        s.table.setTableRowFormatting(origIdx, { backgroundColor: null });
        s.table.setCellFormatting(origIdx, s.mapping.amount, { bold: null, backgroundColor: null });
    }

    function done() {
        const s = session;
        if (!s) { closeSplit(); return; }
        const origIdx = indexOfPos(s.table, s.originalPos);
        clearHighlight(s, origIdx);
        // If fully allocated, the original is now redundant — remove it.
        if (origIdx >= 0 && Math.abs(remaining) < ZERO_EPS) {
            s.table.deleteRow(origIdx);
        }
        closeSplit();
    }

    function cancel() {
        const s = session;
        if (!s) { closeSplit(); return; }
        // Remove the rows we added and restore the original amount.
        const rows = s.table.sortedFilteredRows;
        const delIdxs = [];
        for (const pos of s.splitPositions) {
            const idx = rows.findIndex(r => r._pos === pos);
            if (idx >= 0) delIdxs.push(idx);
        }
        if (delIdxs.length) s.table.deleteRows(delIdxs);

        const origIdx = indexOfPos(s.table, s.originalPos);
        if (origIdx >= 0) {
            s.table.updateCell(origIdx, s.mapping.amount, s.startingAmount);
            clearHighlight(s, origIdx);
        }
        closeSplit();
    }

    // ── Panel position (beside the original row, always clamped on-screen) ──────
    // Measured panel size so clamping keeps the whole panel within the grid body.
    let panelW = $state(208);
    let panelH = $state(160);

    let panelPos = $derived.by(() => {
        const s = session;
        if (!s || !virtualizer) return null;
        const _tv = tableManager?.tableVersion;
        const sl = virtualizer.scrollLeft;
        const st = virtualizer.scrollTop;
        const frozenW = virtualizer.frozenWidth;
        const frozenH = virtualizer.frozenHeight;
        const containerW = virtualizer.containerWidth;
        const containerH = virtualizer.containerHeight;

        const origIdx = indexOfPos(s.table, s.originalPos);
        if (origIdx < 0) return null;
        const gridRow = s.table.gridRowForDisplayIndex(origIdx);

        // Prefer parking just right of the table; fall back to its left side if the
        // table is wide, then clamp into the visible grid body either way.
        const rightCol = s.table.endCol;
        const rOff = virtualizer.colMetrics.offsetOf(rightCol);
        const rW = virtualizer.getColWidth(rightCol);
        const rightInFrozen = frozenW > 0 && rOff < frozenW;
        const tableRightX = HEADER_WIDTH + rOff + rW - (rightInFrozen ? 0 : sl);

        const lOff = virtualizer.colMetrics.offsetOf(s.table.startCol);
        const leftInFrozen = frozenW > 0 && lOff < frozenW;
        const tableLeftX = HEADER_WIDTH + lOff - (leftInFrozen ? 0 : sl);

        let x = tableRightX + 12;
        if (x + panelW > containerW - 6) x = tableLeftX - panelW - 12; // try left side
        x = Math.min(Math.max(x, HEADER_WIDTH + 6), Math.max(HEADER_WIDTH + 6, containerW - panelW - 6));

        const rowOff = virtualizer.rowMetrics.offsetOf(gridRow);
        const inFrozenY = frozenH > 0 && rowOff < frozenH;
        let y = HEADER_HEIGHT + rowOff - (inFrozenY ? 0 : st);
        y = Math.min(Math.max(y, HEADER_HEIGHT + 6), Math.max(HEADER_HEIGHT + 6, containerH - panelH - 6));

        return { x, y };
    });

    let fmt = $derived(new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }));
</script>

{#if session && panelPos}
    <div
        class="split-panel"
        style="left:{panelPos.x}px; top:{panelPos.y}px;"
        bind:clientWidth={panelW}
        bind:clientHeight={panelH}
    >
        <div class="split-header">
            Split entry
            <button class="x-btn" title="Cancel — undo splits" onclick={cancel}>✕</button>
        </div>
        <div class="split-stat">
            <span class="stat-label">Original</span>
            <span class="stat-val">{fmt.format(session.startingAmount)}</span>
        </div>
        <div class="split-stat">
            <span class="stat-label">Remaining</span>
            <span class="stat-val" class:zero={Math.abs(remaining) < ZERO_EPS}>{fmt.format(remaining)}</span>
        </div>
        <div class="split-actions">
            <button class="add-btn" onclick={addRow}>+ Add New Row</button>
            <button class="done-btn" onclick={done}>Done</button>
        </div>
        <div class="split-hint">
            {#if Math.abs(remaining) < ZERO_EPS}
                Original fully allocated — it will be removed on Done.
            {:else}
                Edit each new row’s amount; the remainder stays on the original.
            {/if}
        </div>
    </div>
{/if}

<style>
    .split-panel {
        position: absolute;
        z-index: 30;
        width: 200px;
        background: white;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.16);
        font-size: 0.78rem;
        pointer-events: all;
        overflow: hidden;
    }
    .split-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 8px; background: #fffbeb; border-bottom: 1px solid #fde68a;
        font-weight: 600; color: #92400e;
    }
    .x-btn { background: none; border: none; cursor: pointer; color: #92400e; font-size: 0.9rem; padding: 0 2px; }
    .split-stat {
        display: flex; align-items: center; justify-content: space-between;
        padding: 4px 8px; border-bottom: 1px solid #f3f4f6;
    }
    .stat-label { color: #6b7280; }
    .stat-val { font-family: monospace; font-weight: 600; color: #111827; }
    .stat-val.zero { color: #059669; }
    .split-actions { display: flex; gap: 6px; padding: 8px; }
    .add-btn, .done-btn {
        flex: 1; padding: 5px 8px; border-radius: 4px; cursor: pointer;
        font-size: 0.78rem; font-weight: 500; border: 1px solid transparent;
    }
    .add-btn { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
    .add-btn:hover { background: #dbeafe; }
    .done-btn { background: #3b82f6; color: white; }
    .done-btn:hover { background: #2563eb; }
    .split-hint { padding: 0 8px 8px; color: #9ca3af; font-size: 0.7rem; line-height: 1.3; }
</style>
