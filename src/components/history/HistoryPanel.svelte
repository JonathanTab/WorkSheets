<script>
    /**
     * HistoryPanel — Document version history sidebar (redesigned).
     *
     * Props:
     *   historyManager  - HistoryManager instance
     *   onClose         - callback to hide the panel
     *
     * Snapshot summaries come from server diff_json (no binary downloads for the list).
     * Clicking a snapshot opens the HistoryViewer overlay (full-screen diff view).
     */

    import { onMount } from 'svelte';
    import SnapshotListItem from './SnapshotListItem.svelte';

    let { historyManager, onClose } = $props();

    let snapshotDesc = $state('');
    let snapshotCreating = $state(false);

    onMount(() => {
        historyManager.loadSnapshots();
        historyManager.loadFileMeta();
    });

    async function handleCreateSnapshot() {
        snapshotCreating = true;
        await historyManager.createSnapshot(snapshotDesc || null);
        snapshotDesc = '';
        snapshotCreating = false;
    }

    // Group snapshots by date label
    let groupedSnapshots = $derived.by(() => {
        const groups = [];
        let lastLabel = null;
        for (const snap of historyManager.snapshots) {
            const label = formatDateGroup(snap.created_at);
            if (label !== lastLabel) {
                groups.push({ label, snaps: [] });
                lastLabel = label;
            }
            groups[groups.length - 1].snaps.push(snap);
        }
        return groups;
    });

    function formatDateGroup(tsMs) {
        const d = new Date(tsMs);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart - 86_400_000);
        const weekStart = new Date(todayStart - 6 * 86_400_000);
        if (d >= todayStart)      return 'Today';
        if (d >= yesterdayStart)  return 'Yesterday';
        if (d >= weekStart)       return d.toLocaleDateString(undefined, { weekday: 'long' });
        return d.toLocaleDateString(undefined, {
            month: 'long', day: 'numeric',
            year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
        });
    }

    function formatLastEdit(lastEdit) {
        if (!lastEdit?.at) return null;
        const diff = Date.now() - lastEdit.at;
        const minutes = Math.floor(diff / 60_000);
        const hours   = Math.floor(diff / 3_600_000);
        const days    = Math.floor(diff / 86_400_000);
        let when;
        if (diff < 60_000)    when = 'just now';
        else if (minutes < 60) when = `${minutes}m ago`;
        else if (hours < 24)   when = `${hours}h ago`;
        else if (days === 1)   when = 'yesterday';
        else if (days < 7)     when = `${days} days ago`;
        else                   when = new Date(lastEdit.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return `Last edited ${when} by ${lastEdit.by}`;
    }

    let lastEditLabel = $derived(formatLastEdit(historyManager.lastEdit));
</script>

<aside class="history-panel">
    <!-- Header -->
    <div class="panel-header">
        <span class="panel-title">Version History</span>
        <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
    </div>

    <!-- Last edit info -->
    {#if lastEditLabel}
        <div class="last-edit-bar">{lastEditLabel}</div>
    {/if}

    <!-- Manual snapshot bar -->
    <div class="snapshot-bar">
        <input
            type="text"
            bind:value={snapshotDesc}
            placeholder="Version label (optional)"
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

    {#if historyManager.error}
        <div class="error-banner">{historyManager.error}</div>
    {/if}

    <!-- Snapshot list -->
    <div class="snapshot-list">
        {#if historyManager.loading}
            <div class="state-msg">Loading…</div>
        {:else if historyManager.snapshots.length === 0}
            <div class="state-msg empty">
                <div class="empty-icon">🕐</div>
                <div>No versions yet</div>
                <div class="empty-sub">Versions are saved automatically at session end, or save one manually above.</div>
            </div>
        {:else}
            {#each groupedSnapshots as group}
                <div class="date-group-label">{group.label}</div>
                {#each group.snaps as snap (snap.id)}
                    {@const summary = historyManager.interpretSnapshotDiff(snap)}
                    <SnapshotListItem
                        {snap}
                        {summary}
                        isSelected={historyManager.selectedSnap?.id === snap.id}
                        onSelect={() => historyManager.selectSnapshot(snap)}
                    />
                {/each}
            {/each}
        {/if}
    </div>
</aside>

<style>
    .history-panel {
        display: flex;
        flex-direction: column;
        width: 280px;
        height: 100%;
        background: #fff;
        border-left: 1px solid #e0e0e0;
        font-family: inherit;
        overflow: hidden;
    }

    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 12px 10px;
        border-bottom: 1px solid #e8e8e8;
        flex-shrink: 0;
    }

    .panel-title {
        font-size: 13px;
        font-weight: 600;
        color: #222;
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #888;
        font-size: 14px;
        padding: 2px 4px;
        border-radius: 3px;
    }
    .close-btn:hover { background: #f0f0f0; color: #333; }

    .last-edit-bar {
        padding: 5px 12px;
        font-size: 11px;
        color: #777;
        background: #fafafa;
        border-bottom: 1px solid #f0f0f0;
        flex-shrink: 0;
    }

    .snapshot-bar {
        display: flex;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 1px solid #ebebeb;
        flex-shrink: 0;
    }

    .label-input {
        flex: 1;
        min-width: 0;
        font-size: 12px;
        padding: 4px 7px;
        border: 1px solid #d4d4d4;
        border-radius: 4px;
        outline: none;
    }
    .label-input:focus { border-color: #4285f4; }

    .save-btn {
        font-size: 11px;
        padding: 4px 9px;
        background: #4285f4;
        color: #fff;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .save-btn:hover { background: #2b6fd4; }
    .save-btn:disabled { background: #a0b8e0; cursor: default; }

    .error-banner {
        padding: 6px 12px;
        background: #fde8e8;
        color: #a00;
        font-size: 12px;
        flex-shrink: 0;
    }

    .snapshot-list {
        flex: 1;
        overflow-y: auto;
    }

    .state-msg {
        padding: 16px 12px;
        font-size: 12px;
        color: #888;
        text-align: center;
    }
    .state-msg.empty { padding-top: 32px; }

    .empty-icon {
        font-size: 28px;
        margin-bottom: 8px;
    }

    .empty-sub {
        font-size: 11px;
        color: #aaa;
        margin-top: 6px;
        line-height: 1.5;
    }

    .date-group-label {
        padding: 8px 12px 4px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #aaa;
        background: #fafafa;
        border-bottom: 1px solid #f0f0f0;
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
