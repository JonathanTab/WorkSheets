<script>
    /**
     * HistoryPanel — Document version history sidebar.
     *
     * Props:
     *   registry    - FileRegistry instance
     *   fileId      - ID of the file whose history is shown
     *   currentDoc  - live Y.Doc for diff comparison (optional)
     *   diffFn      - optional (snapDoc: Y.Doc, otherDoc: Y.Doc) => DiffResult
     *                 App-specific diff function. HistoryPanel is doc-type agnostic;
     *                 each subapp (sheets, docs, svg) supplies its own implementation.
     *                 If null, the panel shows "no diff available" for this doc type.
     *   onClose     - callback when the panel should close
     *
     * Compare modes:
     *   "prev"    - diffFn(prevSnapDoc, selectedSnapDoc) — what changed in this version
     *   "current" - diffFn(selectedSnapDoc, currentDoc)  — how this version differs from now
     *
     * DiffResult shape (from diffFn):
     *   {
     *     sheets: Array<SheetDiff>,
     *     meta?: { renamedSheets: Array<{from,to}>, sheetOrderChanged: boolean }
     *   }
     *   SheetDiff: {
     *     name, isNew, isDeleted, renamed,
     *     totalChanged, totalAdded, totalRemoved, cells,
     *     formatChanges, formatCells,
     *     structureChanges, tableChanges
     *   }
     */
    import { onMount } from 'svelte';
    import * as Y from 'yjs';
    import { diffTotalCount } from '../lib/spreadsheetDiff.js';

    let { registry, fileId, currentDoc = null, diffFn = null, onClose } = $props();

    // ---------- State ----------
    let snapshots = $state([]);
    let loading = $state(true);
    let error = $state(null);
    let selectedId = $state(null);
    let compareMode = $state('prev'); // 'prev' | 'current'
    let diffResult = $state(null);
    let diffLoading = $state(false);
    let restoring = $state(false);
    let restoreError = $state(null);

    // Cache: Map<"snapId:mode", DiffResult> — avoids re-fetching
    const diffCache = new Map();
    // Summary badge cache: Map<snapId, number>
    let summaryCache = $state(new Map());

    // Stale-result guard: if user clicks fast, discard results from older requests
    let diffSeq = 0;

    // ---------- Load snapshot list ----------
    onMount(async () => {
        try {
            snapshots = await registry.listSnapshots(fileId);
        } catch (err) {
            error = err.message ?? 'Failed to load history';
        } finally {
            loading = false;
        }

        // Progressive background loading of badges for first 10 snapshots
        if (diffFn && snapshots.length > 0) {
            loadSummaryBadges(snapshots.slice(0, 10));
        }
    });

    /**
     * Fire background diffs (vs. previous) for a batch of snapshots to populate badges.
     * Uses Promise.allSettled so one failure doesn't block others.
     */
    async function loadSummaryBadges(batch) {
        await Promise.allSettled(batch.map(async (snap) => {
            const cacheKey = `${snap.id}:prev`;
            if (diffCache.has(cacheKey)) {
                summaryCache = new Map(summaryCache).set(snap.id, diffTotalCount(diffCache.get(cacheKey)));
                return;
            }
            try {
                const result = await computeDiff(snap.id, 'prev');
                if (result && !result.error) {
                    summaryCache = new Map(summaryCache).set(snap.id, diffTotalCount(result));
                }
            } catch { /* ignore */ }
        }));
    }

    // ---------- Manual snapshot ----------
    let snapshotDesc = $state('');
    let snapshotCreating = $state(false);

    async function handleCreateSnapshot() {
        snapshotCreating = true;
        try {
            await registry.createSnapshot(fileId, snapshotDesc || undefined);
            snapshotDesc = '';
            snapshots = await registry.listSnapshots(fileId);
            // Load badge for the new snapshot
            if (diffFn && snapshots.length > 0) loadSummaryBadges([snapshots[0]]);
        } catch (err) {
            error = err.message ?? 'Failed to create snapshot';
        } finally {
            snapshotCreating = false;
        }
    }

    // ---------- Load a Y.Doc from a snapshot id (or return empty doc) ----------
    async function loadSnapDoc(snapId) {
        if (!snapId) return new Y.Doc();
        const data = await registry.getSnapshotData(fileId, snapId);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, data);
        return doc;
    }

    /**
     * Compute and cache a diff for a snapshot in the given compare mode.
     * Returns the cached result if already computed.
     */
    async function computeDiff(snapId, mode) {
        const cacheKey = `${snapId}:${mode}`;
        if (diffCache.has(cacheKey)) return diffCache.get(cacheKey);

        const idx = snapshots.findIndex(s => s.id === snapId);
        let result;

        if (mode === 'prev') {
            const prevSnap = snapshots[idx + 1] ?? null;
            const [selectedDoc, prevDoc] = await Promise.all([
                loadSnapDoc(snapId),
                loadSnapDoc(prevSnap?.id ?? null),
            ]);
            result = diffFn(prevDoc, selectedDoc);
            selectedDoc.destroy();
            prevDoc.destroy();
        } else {
            // vs. current live doc
            if (!currentDoc) return null;
            const selectedDoc = await loadSnapDoc(snapId);
            result = diffFn(selectedDoc, currentDoc);
            selectedDoc.destroy();
        }

        diffCache.set(cacheKey, result);
        return result;
    }

    // ---------- Select snapshot → compute diff ----------
    async function selectSnapshot(id) {
        if (selectedId === id) { selectedId = null; diffResult = null; return; }
        selectedId = id;
        diffResult = null;
        if (!diffFn) return;

        const seq = ++diffSeq;
        diffLoading = true;
        try {
            const result = await computeDiff(id, compareMode);
            if (diffSeq !== seq) return; // stale
            diffResult = result;
            // Update badge if not already set
            if (result && !result.error && !summaryCache.has(id)) {
                summaryCache = new Map(summaryCache).set(id, diffTotalCount(result));
            }
        } catch (err) {
            if (diffSeq === seq) diffResult = { error: err.message };
        } finally {
            if (diffSeq === seq) diffLoading = false;
        }
    }

    // ---------- Switch compare mode for the currently selected snapshot ----------
    async function switchMode(mode) {
        if (mode === compareMode || !selectedId || !diffFn) { compareMode = mode; return; }
        compareMode = mode;
        diffResult = null;

        const seq = ++diffSeq;
        diffLoading = true;
        try {
            const result = await computeDiff(selectedId, mode);
            if (diffSeq !== seq) return;
            diffResult = result;
        } catch (err) {
            if (diffSeq === seq) diffResult = { error: err.message };
        } finally {
            if (diffSeq === seq) diffLoading = false;
        }
    }

    // ---------- Restore ----------
    async function handleRestore(snapshotId) {
        if (!confirm('Restore this snapshot? The current state will be replaced.')) return;
        restoring = true;
        restoreError = null;
        try {
            await registry.restoreSnapshot(fileId, snapshotId);
            onClose?.();
        } catch (err) {
            restoreError = err.message ?? 'Restore failed';
        } finally {
            restoring = false;
        }
    }

    // ---------- Formatting helpers ----------
    function formatTime(tsMs) {
        return new Date(tsMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function formatDateGroup(tsMs) {
        const d = new Date(tsMs);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart - 86_400_000);
        const weekStart = new Date(todayStart - 6 * 86_400_000);

        if (d >= todayStart) return 'Today';
        if (d >= yesterdayStart) return 'Yesterday';
        if (d >= weekStart) return d.toLocaleDateString(undefined, { weekday: 'long' });
        return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    }

    function formatTrigger(trigger) {
        return { auto: 'Auto-saved', manual: 'Manual', room_empty: 'Session end', session_end: 'Session end', session_cap: 'Checkpoint' }[trigger] ?? trigger;
    }

    function formatUsers(createdBy) {
        if (!createdBy) return null;
        const names = createdBy.split(',').map(s => s.trim()).filter(Boolean);
        if (names.length === 0) return null;
        if (names.length === 1) return names[0];
        if (names.length === 2) return `${names[0]} & ${names[1]}`;
        return `${names[0]} +${names.length - 1} others`;
    }

    function formatFieldName(field) {
        const labels = {
            bold: 'Bold', italic: 'Italic', underline: 'Underline', strikethrough: 'Strikethrough',
            color: 'Text color', backgroundColor: 'Fill color',
            fontSize: 'Font size', fontFamily: 'Font',
            align: 'Alignment', valign: 'Vertical align', wrap: 'Wrap', numberFormat: 'Number format',
        };
        return labels[field] ?? field;
    }

    function formatFormatVal(_field, v) {
        if (v === null || v === undefined) return 'default';
        if (typeof v === 'boolean') return v ? 'on' : 'off';
        if (typeof v === 'string' && v.length > 30) return v.slice(0, 27) + '…';
        return String(v);
    }

    // Group snapshots by date label
    let groupedSnapshots = $derived.by(() => {
        const groups = [];
        let lastLabel = null;
        for (const snap of snapshots) {
            const label = formatDateGroup(snap.created_at);
            if (label !== lastLabel) {
                groups.push({ label, snaps: [] });
                lastLabel = label;
            }
            groups[groups.length - 1].snaps.push(snap);
        }
        return groups;
    });

    // Totals for each diff category
    function valueTotal(sheets) {
        return (sheets ?? []).reduce((s, sh) => s + sh.totalChanged + sh.totalAdded + sh.totalRemoved, 0);
    }
    function formatTotal(sheets) {
        return (sheets ?? []).reduce((s, sh) => s + (sh.formatChanges ?? 0), 0);
    }
    function tableTotal(sheets) {
        return (sheets ?? []).reduce((s, sh) => s + (sh.tableChanges?.length ?? 0), 0);
    }
    function structTotal(sheets) {
        return (sheets ?? []).reduce((s, sh) => s + (sh.structureChanges?.length ?? 0), 0);
    }

    // Color for change count badge
    function changeCountClass(count) {
        if (!count || count === 0) return 'badge-neutral';
        if (count < 5) return 'badge-low';
        if (count < 20) return 'badge-mid';
        return 'badge-high';
    }

    // Affected sheet names for a snapshot (from summary cache diff result)
    function affectedSheets(snapId) {
        const key = `${snapId}:prev`;
        const result = diffCache.get(key);
        if (!result?.sheets?.length) return null;
        const names = result.sheets.filter(s => !s.isDeleted).map(s => s.name);
        if (names.length === 0) return null;
        if (names.length <= 2) return names.join(', ');
        return `${names[0]}, ${names[1]} +${names.length - 2} more`;
    }
</script>

<aside class="history-panel">
    <!-- Header -->
    <div class="panel-header">
        <span class="panel-title">Version History</span>
        <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
    </div>

    <!-- Manual snapshot bar -->
    <div class="snapshot-bar">
        <input
            type="text"
            bind:value={snapshotDesc}
            placeholder="Label (optional)"
            class="label-input"
            onkeydown={e => e.key === 'Enter' && handleCreateSnapshot()}
        />
        <button
            onclick={handleCreateSnapshot}
            disabled={snapshotCreating}
            class="save-btn"
        >
            {snapshotCreating ? 'Saving…' : 'Save version'}
        </button>
    </div>

    {#if error}
        <div class="error-banner">{error}</div>
    {/if}

    <!-- Snapshot list -->
    <div class="snapshot-list">
        {#if loading}
            <div class="state-msg">Loading…</div>
        {:else if snapshots.length === 0}
            <div class="state-msg empty">
                <div class="empty-icon">🕐</div>
                <div>No versions yet</div>
                <div class="empty-sub">Versions are saved automatically when sessions end, or you can save one manually above.</div>
            </div>
        {:else}
            {#each groupedSnapshots as group}
                <div class="date-group-label">{group.label}</div>
                {#each group.snaps as snap (snap.id)}
                    {@const isSelected = selectedId === snap.id}
                    {@const users = formatUsers(snap.created_by)}
                    {@const badgeCount = summaryCache.get(snap.id) ?? null}
                    {@const sheetNames = affectedSheets(snap.id)}
                    <div class="snap-item {isSelected ? 'snap-item--selected' : ''}">
                        <!-- Row button -->
                        <button class="snap-row" onclick={() => selectSnapshot(snap.id)}>
                            <div class="snap-main">
                                <div class="snap-time-row">
                                    <span class="snap-time">{formatTime(snap.created_at)}</span>
                                    <span class="snap-trigger">{formatTrigger(snap.trigger)}</span>
                                    {#if badgeCount !== null}
                                        <span class="snap-badge {changeCountClass(badgeCount)}">{badgeCount}</span>
                                    {:else if diffFn}
                                        <span class="snap-badge badge-loading">·</span>
                                    {/if}
                                </div>
                                {#if snap.description}
                                    <div class="snap-desc">"{snap.description}"</div>
                                {/if}
                                {#if sheetNames}
                                    <div class="snap-sheets">{sheetNames}</div>
                                {/if}
                                {#if users}
                                    <div class="snap-users">{users}</div>
                                {/if}
                            </div>
                            <span class="snap-chevron">{isSelected ? '▲' : '▼'}</span>
                        </button>

                        <!-- Expanded panel -->
                        {#if isSelected}
                            <div class="snap-detail">
                                <!-- Compare mode toggle -->
                                {#if diffFn}
                                    <div class="compare-toggle">
                                        <button
                                            class="toggle-btn {compareMode === 'prev' ? 'toggle-btn--active' : ''}"
                                            onclick={() => switchMode('prev')}
                                        >← vs. previous</button>
                                        <button
                                            class="toggle-btn {compareMode === 'current' ? 'toggle-btn--active' : ''}"
                                            onclick={() => switchMode('current')}
                                            disabled={!currentDoc}
                                        >vs. current →</button>
                                    </div>
                                {/if}

                                {#if diffLoading}
                                    <div class="diff-loading">Computing diff…</div>
                                {:else if !diffFn}
                                    <div class="diff-hint">No diff preview available for this document type.</div>
                                {:else if compareMode === 'current' && !currentDoc}
                                    <div class="diff-hint">Open the document to compare against current state.</div>
                                {:else if diffResult?.error}
                                    <div class="diff-error">{diffResult.error}</div>
                                {:else if diffResult}
                                    {@const vt = valueTotal(diffResult.sheets)}
                                    {@const ft = formatTotal(diffResult.sheets)}
                                    {@const tt = tableTotal(diffResult.sheets)}
                                    {@const st = structTotal(diffResult.sheets)}
                                    {@const hasMeta = diffResult.meta?.renamedSheets?.length > 0 || diffResult.meta?.sheetOrderChanged}
                                    {@const hasAnything = vt + ft + tt + st > 0 || diffResult.sheets.some(s => s.isNew || s.isDeleted || s.renamed) || hasMeta}

                                    {#if !hasAnything}
                                        <div class="diff-hint">No changes detected between versions.</div>
                                    {:else}
                                        <!-- Summary chips -->
                                        <div class="diff-chips">
                                            {#if vt > 0}<span class="chip chip--value">{vt} value{vt !== 1 ? 's' : ''}</span>{/if}
                                            {#if ft > 0}<span class="chip chip--format">{ft} formatting</span>{/if}
                                            {#if tt > 0}<span class="chip chip--table">{tt} table{tt !== 1 ? 's' : ''}</span>{/if}
                                            {#if st > 0}<span class="chip chip--struct">{st} structural</span>{/if}
                                        </div>

                                        {#each diffResult.sheets as sheet}
                                            <div class="diff-sheet">
                                                <!-- Sheet header -->
                                                {#if sheet.isNew}
                                                    <div class="diff-sheet-name diff-sheet-name--new">+ {sheet.name} <span class="diff-tag diff-tag--added">new sheet</span></div>
                                                {:else if sheet.isDeleted}
                                                    <div class="diff-sheet-name diff-sheet-name--deleted">− {sheet.name} <span class="diff-tag diff-tag--removed">deleted</span></div>
                                                {:else}
                                                    <div class="diff-sheet-name">
                                                        {sheet.name}
                                                        {#if sheet.renamed}<span class="diff-tag diff-tag--changed">renamed from {sheet.renamed.from}</span>{/if}
                                                        <span class="diff-counts">
                                                            {#if sheet.totalChanged > 0}<span class="diff-tag diff-tag--changed">{sheet.totalChanged} changed</span>{/if}
                                                            {#if sheet.totalAdded > 0}<span class="diff-tag diff-tag--added">{sheet.totalAdded} added</span>{/if}
                                                            {#if sheet.totalRemoved > 0}<span class="diff-tag diff-tag--removed">{sheet.totalRemoved} removed</span>{/if}
                                                            {#if sheet.formatChanges > 0}<span class="diff-tag diff-tag--format">{sheet.formatChanges} fmt</span>{/if}
                                                            {#if sheet.tableChanges?.length > 0}<span class="diff-tag diff-tag--table">{sheet.tableChanges.length} table{sheet.tableChanges.length !== 1 ? 's' : ''}</span>{/if}
                                                        </span>
                                                    </div>

                                                    <!-- Cell value rows -->
                                                    {#if sheet.cells.length > 0}
                                                        <div class="diff-cells">
                                                            {#each sheet.cells as cell}
                                                                <div class="diff-cell diff-cell--{cell.status}">
                                                                    <span class="diff-cell-ref">{cell.ref}</span>
                                                                    <span class="diff-cell-from">{cell.from}</span>
                                                                    <span class="diff-cell-arrow">→</span>
                                                                    <span class="diff-cell-to">{cell.to}</span>
                                                                </div>
                                                            {/each}
                                                            {#if (sheet.totalChanged + sheet.totalAdded + sheet.totalRemoved) - sheet.cells.length > 0}
                                                                <div class="diff-overflow">+{(sheet.totalChanged + sheet.totalAdded + sheet.totalRemoved) - sheet.cells.length} more not shown</div>
                                                            {/if}
                                                        </div>
                                                    {/if}

                                                    <!-- Table changes -->
                                                    {#if sheet.tableChanges?.length > 0}
                                                        <div class="diff-section">
                                                            <div class="diff-section-label">Tables</div>
                                                            {#each sheet.tableChanges as tc}
                                                                <div class="diff-table-row">
                                                                    {#if tc.type === 'added'}
                                                                        <span class="diff-table-icon diff-table-icon--added">+</span> <span class="diff-table-name">{tc.name}</span> <span class="diff-table-detail">added</span>
                                                                    {:else if tc.type === 'removed'}
                                                                        <span class="diff-table-icon diff-table-icon--removed">−</span> <span class="diff-table-name">{tc.name}</span> <span class="diff-table-detail">removed</span>
                                                                    {:else if tc.type === 'renamed'}
                                                                        <span class="diff-table-icon diff-table-icon--changed">⟲</span> <span class="diff-table-name">{tc.from}</span> → <span class="diff-table-name">{tc.to}</span>
                                                                    {:else if tc.type === 'columns'}
                                                                        <span class="diff-table-icon diff-table-icon--changed">≡</span> <span class="diff-table-name">{tc.name}</span> <span class="diff-table-detail">{tc.detail}</span>
                                                                    {:else if tc.type === 'rows'}
                                                                        <span class="diff-table-icon diff-table-icon--changed">↕</span> <span class="diff-table-name">{tc.name}</span> <span class="diff-table-detail">{tc.detail}</span>
                                                                    {/if}
                                                                </div>
                                                            {/each}
                                                        </div>
                                                    {/if}

                                                    <!-- Structural changes -->
                                                    {#if sheet.structureChanges?.length > 0}
                                                        <div class="diff-section">
                                                            <div class="diff-section-label">Structure</div>
                                                            {#each sheet.structureChanges as sc}
                                                                <div class="diff-struct-row">
                                                                    <span class="diff-struct-field">{sc.field}</span>
                                                                    {#if sc.from && sc.to && sc.from !== sc.to && sc.from !== ''}
                                                                        <span class="diff-struct-from">{sc.from}</span>
                                                                        <span class="diff-cell-arrow">→</span>
                                                                        <span class="diff-struct-to">{sc.to}</span>
                                                                    {:else}
                                                                        <span class="diff-struct-to">{sc.to}</span>
                                                                    {/if}
                                                                </div>
                                                            {/each}
                                                        </div>
                                                    {/if}

                                                    <!-- Formatting changes (collapsed by default — just a count line) -->
                                                    {#if sheet.formatChanges > 0}
                                                        <div class="diff-section">
                                                            <div class="diff-section-label">Formatting — {sheet.formatChanges} cell{sheet.formatChanges !== 1 ? 's' : ''}</div>
                                                            {#each sheet.formatCells.slice(0, 10) as fc}
                                                                <div class="diff-fmt-row">
                                                                    <span class="diff-cell-ref">{fc.ref}</span>
                                                                    <span class="diff-fmt-changes">
                                                                        {fc.changes.map(c => `${formatFieldName(c.field)}: ${formatFormatVal(c.field, c.from)}→${formatFormatVal(c.field, c.to)}`).join(', ')}
                                                                    </span>
                                                                </div>
                                                            {/each}
                                                            {#if sheet.formatCells.length > 10}
                                                                <div class="diff-overflow">+{sheet.formatCells.length - 10} more</div>
                                                            {/if}
                                                        </div>
                                                    {/if}
                                                {/if}
                                            </div>
                                        {/each}

                                        <!-- Doc-level meta -->
                                        {#if hasMeta}
                                            <div class="diff-section diff-section--meta">
                                                <div class="diff-section-label">Document</div>
                                                {#if diffResult.meta.sheetOrderChanged}
                                                    <div class="diff-meta-row">Sheet order changed</div>
                                                {/if}
                                                {#each diffResult.meta.renamedSheets as r}
                                                    <div class="diff-meta-row">"{r.from}" renamed to "{r.to}"</div>
                                                {/each}
                                            </div>
                                        {/if}
                                    {/if}
                                {:else}
                                    <div class="diff-hint">Click to compute diff…</div>
                                {/if}

                                {#if restoreError}
                                    <div class="restore-error">{restoreError}</div>
                                {/if}
                                <button
                                    onclick={() => handleRestore(snap.id)}
                                    disabled={restoring}
                                    class="restore-btn"
                                >
                                    {restoring ? 'Restoring…' : 'Restore this version'}
                                </button>
                            </div>
                        {/if}
                    </div>
                {/each}
            {/each}
        {/if}
    </div>
</aside>

<style>
    .history-panel {
        display: flex;
        flex-direction: column;
        width: 300px;
        min-width: 260px;
        height: 100%;
        background: var(--color-surface);
        border-right: 1px solid var(--color-border);
        font-size: 12px;
        color: var(--color-text);
        flex-shrink: 0;
        overflow: hidden;
    }

    /* Header */
    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
        flex-shrink: 0;
    }
    .panel-title {
        font-weight: 600;
        font-size: 13px;
        color: var(--color-text);
    }
    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-text-muted);
        padding: 2px 4px;
        border-radius: 4px;
        font-size: 13px;
        line-height: 1;
    }
    .close-btn:hover { color: var(--color-text); background: var(--color-bg-tertiary); }

    /* Save bar */
    .snapshot-bar {
        display: flex;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-surface);
        flex-shrink: 0;
    }
    .label-input {
        flex: 1;
        min-width: 0;
        border: 1px solid var(--color-border);
        border-radius: 5px;
        padding: 4px 7px;
        font-size: 11px;
        background: var(--color-bg);
        color: var(--color-text);
        outline: none;
    }
    .label-input:focus { border-color: var(--color-primary); }
    .save-btn {
        padding: 4px 10px;
        background: var(--color-primary);
        color: #fff;
        border: none;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .save-btn:hover { opacity: 0.9; }
    .save-btn:disabled { opacity: 0.5; cursor: default; }

    /* Error */
    .error-banner {
        margin: 6px 10px;
        padding: 6px 8px;
        background: #fef2f2;
        color: #b91c1c;
        border-radius: 5px;
        font-size: 11px;
    }

    /* List */
    .snapshot-list {
        flex: 1;
        overflow-y: auto;
    }
    .state-msg {
        text-align: center;
        padding: 32px 16px;
        color: var(--color-text-muted);
    }
    .state-msg.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .empty-icon { font-size: 28px; }
    .empty-sub { font-size: 11px; color: var(--color-text-muted); text-align: center; line-height: 1.4; max-width: 220px; }

    /* Date group */
    .date-group-label {
        padding: 8px 12px 4px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--color-text-muted);
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
        position: sticky;
        top: 0;
        z-index: 1;
    }

    /* Snapshot item */
    .snap-item { border-bottom: 1px solid var(--color-border); }
    .snap-item--selected { background: color-mix(in srgb, var(--color-primary) 6%, var(--color-surface)); }

    .snap-row {
        width: 100%;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 6px;
        padding: 8px 12px;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        color: inherit;
    }
    .snap-row:hover { background: var(--color-bg-secondary); }
    .snap-item--selected .snap-row:hover { background: color-mix(in srgb, var(--color-primary) 10%, var(--color-surface)); }

    .snap-main { flex: 1; min-width: 0; }

    .snap-time-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }
    .snap-time {
        font-weight: 600;
        font-size: 12px;
        color: var(--color-text);
    }
    .snap-trigger {
        font-size: 10px;
        color: var(--color-text-muted);
    }
    .snap-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 5px;
        border-radius: 10px;
        margin-left: auto;
    }
    .badge-neutral { background: var(--color-bg-tertiary); color: var(--color-text-secondary); }
    .badge-low     { background: #dcfce7; color: #166534; }
    .badge-mid     { background: #fef9c3; color: #854d0e; }
    .badge-high    { background: #fee2e2; color: #991b1b; }
    .badge-loading { background: var(--color-bg-tertiary); color: var(--color-text-muted); font-size: 14px; line-height: 1; padding: 0 4px; }

    .snap-desc {
        margin-top: 2px;
        font-size: 11px;
        font-style: italic;
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .snap-sheets {
        margin-top: 2px;
        font-size: 10px;
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .snap-users {
        margin-top: 2px;
        font-size: 10px;
        color: var(--color-text-muted);
    }
    .snap-chevron {
        font-size: 9px;
        color: var(--color-text-muted);
        flex-shrink: 0;
        margin-top: 3px;
    }

    /* Detail / diff pane */
    .snap-detail {
        padding: 8px 12px 10px;
        background: color-mix(in srgb, var(--color-primary) 4%, var(--color-surface));
        border-top: 1px solid color-mix(in srgb, var(--color-primary) 20%, var(--color-border));
    }

    /* Compare mode toggle */
    .compare-toggle {
        display: flex;
        gap: 4px;
        margin-bottom: 8px;
    }
    .toggle-btn {
        flex: 1;
        padding: 3px 6px;
        font-size: 10px;
        font-weight: 500;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text-muted);
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.1s, color 0.1s;
    }
    .toggle-btn:hover:not(:disabled) { background: var(--color-bg-secondary); color: var(--color-text); }
    .toggle-btn--active {
        background: var(--color-primary);
        color: #fff;
        border-color: var(--color-primary);
    }
    .toggle-btn:disabled { opacity: 0.4; cursor: default; }

    .diff-loading, .diff-hint, .diff-error {
        font-size: 11px;
        color: var(--color-text-muted);
        padding: 4px 0 8px;
    }
    .diff-error { color: #b91c1c; }

    /* Summary chips */
    .diff-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
    }
    .chip {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 10px;
    }
    .chip--value  { background: #fef9c3; color: #92400e; }
    .chip--format { background: #e0e7ff; color: #3730a3; }
    .chip--table  { background: #d1fae5; color: #065f46; }
    .chip--struct { background: #f3f4f6; color: #374151; }

    /* Per-sheet block */
    .diff-sheet { margin-bottom: 10px; }
    .diff-sheet-name {
        font-size: 11px;
        font-weight: 600;
        color: var(--color-text);
        display: flex;
        align-items: center;
        gap: 5px;
        flex-wrap: wrap;
        margin-bottom: 4px;
    }
    .diff-sheet-name--new  { color: #166534; }
    .diff-sheet-name--deleted { color: var(--color-text-muted); }

    .diff-counts { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }

    .diff-tag {
        font-size: 9px;
        font-weight: 600;
        padding: 1px 5px;
        border-radius: 8px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
    }
    .diff-tag--changed { background: #fef9c3; color: #92400e; }
    .diff-tag--added   { background: #dcfce7; color: #166534; }
    .diff-tag--removed { background: #fee2e2; color: #991b1b; }
    .diff-tag--format  { background: #e0e7ff; color: #3730a3; }
    .diff-tag--table   { background: #d1fae5; color: #065f46; }

    /* Cell rows */
    .diff-cells {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-left: 4px;
        margin-bottom: 4px;
    }
    .diff-cell {
        display: grid;
        grid-template-columns: 32px 1fr 14px 1fr;
        gap: 3px;
        align-items: baseline;
        font-size: 10px;
        padding: 1px 0;
        border-left: 2px solid transparent;
        padding-left: 5px;
    }
    .diff-cell--changed { border-left-color: #eab308; }
    .diff-cell--added   { border-left-color: #22c55e; }
    .diff-cell--removed { border-left-color: #ef4444; }

    .diff-cell-ref {
        font-weight: 700;
        color: var(--color-text-secondary);
        font-variant-numeric: tabular-nums;
    }
    .diff-cell-from {
        color: #ef4444;
        text-decoration: line-through;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .diff-cell--added .diff-cell-from { display: none; }
    .diff-cell--added { grid-template-columns: 32px 14px 1fr; }

    .diff-cell-arrow { color: var(--color-text-muted); text-align: center; }
    .diff-cell-to {
        color: #16a34a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .diff-cell--removed .diff-cell-to { color: var(--color-text-muted); font-style: italic; }

    .diff-overflow {
        font-size: 10px;
        color: var(--color-text-muted);
        font-style: italic;
        padding: 2px 0 0 5px;
    }

    /* Subsection (tables, structure, formatting) */
    .diff-section {
        margin: 6px 0 4px 4px;
        padding-left: 6px;
        border-left: 2px solid var(--color-border);
    }
    .diff-section-label {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--color-text-muted);
        margin-bottom: 3px;
    }

    /* Table rows */
    .diff-table-row {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        padding: 1px 0;
        color: var(--color-text);
    }
    .diff-table-icon { font-weight: 700; width: 12px; text-align: center; flex-shrink: 0; }
    .diff-table-icon--added   { color: #16a34a; }
    .diff-table-icon--removed { color: #ef4444; }
    .diff-table-icon--changed { color: #d97706; }
    .diff-table-name { font-weight: 600; }
    .diff-table-detail { color: var(--color-text-muted); font-style: italic; }

    /* Structural rows */
    .diff-struct-row {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        padding: 1px 0;
    }
    .diff-struct-field { color: var(--color-text-secondary); flex-shrink: 0; }
    .diff-struct-from  { color: #ef4444; text-decoration: line-through; }
    .diff-struct-to    { color: #16a34a; }

    /* Formatting rows */
    .diff-fmt-row {
        display: flex;
        align-items: baseline;
        gap: 5px;
        font-size: 10px;
        padding: 1px 0;
    }
    .diff-fmt-changes {
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    /* Meta section */
    .diff-section--meta { border-left-color: var(--color-primary); }
    .diff-meta-row {
        font-size: 10px;
        color: var(--color-text-secondary);
        padding: 1px 0;
    }

    /* Restore */
    .restore-error {
        font-size: 10px;
        color: #b91c1c;
        margin-bottom: 4px;
    }
    .restore-btn {
        margin-top: 8px;
        padding: 5px 12px;
        background: #f97316;
        color: #fff;
        border: none;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        width: 100%;
    }
    .restore-btn:hover { background: #ea580c; }
    .restore-btn:disabled { opacity: 0.5; cursor: default; }
</style>
