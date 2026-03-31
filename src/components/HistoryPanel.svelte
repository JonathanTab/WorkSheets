<script>
    /**
     * HistoryPanel — Document version history sidebar.
     *
     * Props:
     *   registry    - FileRegistry instance
     *   fileId      - ID of the file whose history is shown
     *   currentDoc  - live Y.Doc for diff comparison (optional)
     *   diffFn      - optional async (snapDoc, liveDoc) => DiffResult
     *                 If not provided the panel shows a generic "open document to diff" message.
     *   onClose     - callback when the panel should close
     *
     * DiffResult shape (returned by diffFn):
     *   { sheets: Array<{ name, cells, totalChanged, totalAdded, totalRemoved, isNew, isDeleted }> }
     *   where cells: Array<{ ref, from, to, status: 'changed'|'added'|'removed' }>
     */
    import { onMount } from 'svelte';
    import * as Y from 'yjs';

    let { registry, fileId, currentDoc = null, diffFn = null, onClose } = $props();

    // ---------- State ----------
    let snapshots = $state([]);
    let loading = $state(true);
    let error = $state(null);
    let selectedId = $state(null);
    let diffResult = $state(null);
    let diffLoading = $state(false);
    let restoring = $state(false);
    let restoreError = $state(null);

    // ---------- Load snapshot list ----------
    onMount(async () => {
        try {
            snapshots = await registry.listSnapshots(fileId);
        } catch (err) {
            error = err.message ?? 'Failed to load history';
        } finally {
            loading = false;
        }
    });

    // ---------- Manual snapshot ----------
    let snapshotDesc = $state('');
    let snapshotCreating = $state(false);

    async function handleCreateSnapshot() {
        snapshotCreating = true;
        try {
            await registry.createSnapshot(fileId, snapshotDesc || undefined);
            snapshotDesc = '';
            snapshots = await registry.listSnapshots(fileId);
        } catch (err) {
            error = err.message ?? 'Failed to create snapshot';
        } finally {
            snapshotCreating = false;
        }
    }

    // ---------- Select snapshot → compute diff ----------
    async function selectSnapshot(id) {
        if (selectedId === id) { selectedId = null; diffResult = null; return; }
        selectedId = id;
        diffResult = null;
        if (!currentDoc || !diffFn) return;

        diffLoading = true;
        try {
            const data = await registry.getSnapshotData(fileId, id);
            const snapDoc = new Y.Doc();
            Y.applyUpdate(snapDoc, data);
            diffResult = await diffFn(snapDoc, currentDoc);
            snapDoc.destroy();
        } catch (err) {
            diffResult = { error: err.message };
        } finally {
            diffLoading = false;
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
        if (d >= weekStart) {
            return d.toLocaleDateString(undefined, { weekday: 'long' });
        }
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

    // Total changes in diff
    function diffTotal(sheets) {
        return sheets.reduce((s, sh) => s + sh.totalChanged + sh.totalAdded + sh.totalRemoved, 0);
    }

    // Color for change count badge
    function changeCountClass(count) {
        if (!count || count === 0) return 'badge-neutral';
        if (count < 5) return 'badge-low';
        if (count < 20) return 'badge-mid';
        return 'badge-high';
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
                    {@const changeCount = snap.change_count ?? null}
                    <div class="snap-item {isSelected ? 'snap-item--selected' : ''}">
                        <!-- Row button -->
                        <button class="snap-row" onclick={() => selectSnapshot(snap.id)}>
                            <div class="snap-main">
                                <div class="snap-time-row">
                                    <span class="snap-time">{formatTime(snap.created_at)}</span>
                                    <span class="snap-trigger">{formatTrigger(snap.trigger)}</span>
                                    {#if changeCount !== null}
                                        <span class="snap-badge {changeCountClass(changeCount)}">{changeCount}</span>
                                    {/if}
                                </div>
                                {#if snap.description}
                                    <div class="snap-desc">"{snap.description}"</div>
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
                                {#if diffLoading}
                                    <div class="diff-loading">Computing diff…</div>
                                {:else if !currentDoc}
                                    <div class="diff-hint">Open the document to preview changes.</div>
                                {:else if !diffFn}
                                    <div class="diff-hint">No diff preview available for this document type.</div>
                                {:else if diffResult?.error}
                                    <div class="diff-error">{diffResult.error}</div>
                                {:else if diffResult?.sheets?.length === 0}
                                    <div class="diff-hint">No cell changes between this version and current.</div>
                                {:else if diffResult?.sheets}
                                    <div class="diff-summary">
                                        <span class="diff-total">{diffTotal(diffResult.sheets)} cell{diffTotal(diffResult.sheets) !== 1 ? 's' : ''} differ from current</span>
                                    </div>
                                    {#each diffResult.sheets as sheet}
                                        <div class="diff-sheet">
                                            {#if sheet.isNew}
                                                <div class="diff-sheet-name diff-sheet-name--new">+ {sheet.name} <span class="diff-tag diff-tag--added">new sheet</span></div>
                                            {:else if sheet.isDeleted}
                                                <div class="diff-sheet-name diff-sheet-name--deleted">− {sheet.name} <span class="diff-tag diff-tag--removed">deleted</span></div>
                                            {:else}
                                                <div class="diff-sheet-name">{sheet.name}
                                                    <span class="diff-counts">
                                                        {#if sheet.totalChanged > 0}<span class="diff-tag diff-tag--changed">{sheet.totalChanged} changed</span>{/if}
                                                        {#if sheet.totalAdded > 0}<span class="diff-tag diff-tag--added">{sheet.totalAdded} added</span>{/if}
                                                        {#if sheet.totalRemoved > 0}<span class="diff-tag diff-tag--removed">{sheet.totalRemoved} removed</span>{/if}
                                                    </span>
                                                </div>
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
                                                            <div class="diff-overflow">+{(sheet.totalChanged + sheet.totalAdded + sheet.totalRemoved) - sheet.cells.length} more cell{(sheet.totalChanged + sheet.totalAdded + sheet.totalRemoved) - sheet.cells.length !== 1 ? 's' : ''} not shown</div>
                                                        {/if}
                                                    </div>
                                                {/if}
                                            {/if}
                                        </div>
                                    {/each}
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
    .snap-item {
        border-bottom: 1px solid var(--color-border);
    }
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

    .snap-desc {
        margin-top: 2px;
        font-size: 11px;
        font-style: italic;
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

    .diff-loading, .diff-hint, .diff-error {
        font-size: 11px;
        color: var(--color-text-muted);
        padding: 4px 0 8px;
    }
    .diff-error { color: #b91c1c; }

    .diff-summary {
        margin-bottom: 8px;
    }
    .diff-total {
        font-size: 11px;
        font-weight: 500;
        color: var(--color-text-secondary);
    }

    /* Per-sheet block */
    .diff-sheet {
        margin-bottom: 8px;
    }
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

    .diff-counts { display: flex; gap: 4px; align-items: center; }

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

    /* Cell rows */
    .diff-cells {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-left: 4px;
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
