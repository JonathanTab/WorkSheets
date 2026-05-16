<script>
    import { onMount } from 'svelte';
    import ModalHeader from '../../lib/ui/ModalHeader.svelte';
    import { closeTopModal } from '../../lib/ui/modalStore.svelte.js';
    import { HistoryManager } from '../../lib/history/HistoryManager.svelte.js';

    /**
     * @type {{
     *   registry: any,
     *   file: any,
     *   onAfterRestore?: (() => Promise<void>) | null
     * }}
     */
    let { registry, file, onAfterRestore = null } = $props();

    const hm = new HistoryManager({
        fileId: file.id,
        registry,
        appType: file.app ?? 'sheets',
        onAfterRestore,
    });

    onMount(() => hm.loadSnapshots());

    let snapshotDesc = $state('');
    let snapshotCreating = $state(false);
    let restoreSuccess = $state(false);

    async function handleCreateSnapshot() {
        snapshotCreating = true;
        await hm.createSnapshot(snapshotDesc || null);
        snapshotDesc = '';
        snapshotCreating = false;
    }

    async function handleRestore(snapshotId) {
        if (!confirm('Restore this version? The current state will be replaced.')) return;
        hm.error = null;
        restoreSuccess = false;
        await hm.restoreSnapshot(snapshotId);
        if (!hm.error) {
            restoreSuccess = true;
            setTimeout(() => closeTopModal(), 1200);
        }
    }

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
        return d.toLocaleDateString(undefined, {
            month: 'long', day: 'numeric',
            year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
        });
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

    function changeCountClass(count) {
        if (!count || count === 0) return 'badge-neutral';
        if (count < 5) return 'badge-low';
        if (count < 20) return 'badge-mid';
        return 'badge-high';
    }

    let selectedId = $state(null);

    let groupedSnapshots = $derived.by(() => {
        const groups = [];
        let lastLabel = null;
        for (const snap of hm.snapshots) {
            const label = formatDateGroup(snap.created_at);
            if (label !== lastLabel) {
                groups.push({ label, snaps: [] });
                lastLabel = label;
            }
            groups[groups.length - 1].snaps.push(snap);
        }
        return groups;
    });
</script>

<div class="vh-modal">
    <ModalHeader title="Version History — {file.name ?? file.title}" />

    <!-- Save current version bar -->
    <div class="save-bar">
        <input
            type="text"
            bind:value={snapshotDesc}
            placeholder="Label (optional)"
            class="label-input"
            onkeydown={e => e.key === 'Enter' && handleCreateSnapshot()}
        />
        <button
            class="save-btn"
            onclick={handleCreateSnapshot}
            disabled={snapshotCreating}
        >
            {snapshotCreating ? 'Saving…' : 'Save version'}
        </button>
    </div>

    {#if hm.error}
        <div class="error-banner">{hm.error}</div>
    {/if}

    {#if restoreSuccess}
        <div class="success-banner">Version restored successfully.</div>
    {/if}

    <!-- Snapshot list -->
    <div class="snap-list">
        {#if hm.loading}
            <div class="state-msg">Loading…</div>
        {:else if hm.snapshots.length === 0}
            <div class="state-msg empty">
                <div class="empty-icon">🕐</div>
                <div>No versions yet</div>
                <div class="empty-sub">Versions are saved automatically when sessions end, or you can save one manually above.</div>
            </div>
        {:else}
            {#each groupedSnapshots as group}
                <div class="date-group">{group.label}</div>
                {#each group.snaps as snap (snap.id)}
                    {@const isSelected = selectedId === snap.id}
                    {@const users = formatUsers(snap.created_by)}
                    {@const summary = hm.interpretSnapshotDiff(snap)}
                    <div class="snap-item" class:snap-item--selected={isSelected}>
                        <button class="snap-row" onclick={() => { selectedId = isSelected ? null : snap.id; }}>
                            <div class="snap-main">
                                <div class="snap-time-row">
                                    <span class="snap-time">{formatTime(snap.created_at)}</span>
                                    <span class="snap-trigger">{formatTrigger(snap.trigger)}</span>
                                    {#if summary.changeCount > 0}
                                        <span class="snap-badge {changeCountClass(summary.changeCount)}">{summary.changeCount}</span>
                                    {/if}
                                </div>
                                {#if snap.description}
                                    <div class="snap-desc">"{snap.description}"</div>
                                {/if}
                                {#if summary.summary && summary.summary !== 'No changes' && summary.summary !== '—'}
                                    <div class="snap-summary">{summary.summary}</div>
                                {/if}
                                {#if users}
                                    <div class="snap-users">{users}</div>
                                {/if}
                            </div>
                            <span class="snap-chevron">{isSelected ? '▲' : '▼'}</span>
                        </button>

                        {#if isSelected}
                            <div class="snap-detail">
                                {#if restoreSuccess}
                                    <!-- already handled above -->
                                {:else}
                                    <button
                                        class="restore-btn"
                                        onclick={() => handleRestore(snap.id)}
                                        disabled={hm.restoring}
                                    >
                                        {hm.restoring ? 'Restoring…' : 'Restore this version'}
                                    </button>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/each}
            {/each}
        {/if}
    </div>
</div>

<style>
    .vh-modal {
        display: flex;
        flex-direction: column;
        width: 480px;
        max-width: 95vw;
        max-height: 80vh;
        min-height: 300px;
    }

    .save-bar {
        display: flex;
        gap: 6px;
        padding: 10px 16px;
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
    }
    .label-input {
        flex: 1;
        min-width: 0;
        border: 1px solid var(--color-border);
        border-radius: 5px;
        padding: 5px 8px;
        font-size: 12px;
        background: var(--color-bg);
        color: var(--color-text);
        outline: none;
    }
    .label-input:focus { border-color: var(--color-primary); }
    .save-btn {
        padding: 5px 12px;
        background: var(--color-primary);
        color: #fff;
        border: none;
        border-radius: 5px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .save-btn:hover { opacity: 0.9; }
    .save-btn:disabled { opacity: 0.5; cursor: default; }

    .error-banner {
        margin: 6px 16px;
        padding: 6px 10px;
        background: #fef2f2;
        color: #b91c1c;
        border-radius: 5px;
        font-size: 12px;
        flex-shrink: 0;
    }
    .success-banner {
        margin: 6px 16px;
        padding: 6px 10px;
        background: #f0fdf4;
        color: #166534;
        border-radius: 5px;
        font-size: 12px;
        flex-shrink: 0;
    }

    .snap-list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
    }

    .state-msg {
        text-align: center;
        padding: 32px 16px;
        color: var(--color-text-muted);
        font-size: 13px;
    }
    .state-msg.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .empty-icon { font-size: 28px; }
    .empty-sub {
        font-size: 12px;
        color: var(--color-text-muted);
        text-align: center;
        line-height: 1.4;
        max-width: 260px;
    }

    .date-group {
        padding: 6px 16px 4px;
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

    .snap-item { border-bottom: 1px solid var(--color-border); }
    .snap-item--selected {
        background: color-mix(in srgb, var(--color-primary) 6%, var(--color-surface));
    }

    .snap-row {
        width: 100%;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        padding: 9px 16px;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        color: inherit;
    }
    .snap-row:hover { background: var(--color-bg-secondary); }
    .snap-item--selected .snap-row:hover {
        background: color-mix(in srgb, var(--color-primary) 10%, var(--color-surface));
    }

    .snap-main { flex: 1; min-width: 0; }

    .snap-time-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }
    .snap-time { font-weight: 600; font-size: 13px; color: var(--color-text); }
    .snap-trigger { font-size: 11px; color: var(--color-text-muted); }
    .snap-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 10px;
        margin-left: auto;
    }
    .badge-neutral { background: var(--color-bg-tertiary); color: var(--color-text-secondary); }
    .badge-low     { background: #dcfce7; color: #166534; }
    .badge-mid     { background: #fef9c3; color: #854d0e; }
    .badge-high    { background: #fee2e2; color: #991b1b; }

    .snap-desc {
        margin-top: 2px;
        font-size: 12px;
        font-style: italic;
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .snap-summary {
        margin-top: 2px;
        font-size: 11px;
        color: var(--color-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .snap-users {
        margin-top: 2px;
        font-size: 11px;
        color: var(--color-text-muted);
    }
    .snap-chevron {
        font-size: 9px;
        color: var(--color-text-muted);
        flex-shrink: 0;
        margin-top: 4px;
    }

    .snap-detail {
        padding: 10px 16px 12px;
        background: color-mix(in srgb, var(--color-primary) 4%, var(--color-surface));
        border-top: 1px solid color-mix(in srgb, var(--color-primary) 20%, var(--color-border));
    }
    .restore-btn {
        padding: 6px 14px;
        background: #f97316;
        color: #fff;
        border: none;
        border-radius: 5px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        width: 100%;
    }
    .restore-btn:hover { background: #ea580c; }
    .restore-btn:disabled { opacity: 0.5; cursor: default; }
</style>
