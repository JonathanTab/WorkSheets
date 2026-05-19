<script>
    /**
     * HistoryViewer — full-screen overlay for viewing document diffs.
     *
     * Layout:
     *   [Header bar: title | snapshot info | Restore | Close]
     *   [Left sidebar: snapshot list] [Main: app-specific ViewerComponent]
     *
     * Fetches the precomputed diff JSON on-demand (no binary downloads).
     *
     * Props:
     *   historyManager  - HistoryManager instance (carries adapter, registry, fileId)
     */

    import SnapshotListItem from './SnapshotListItem.svelte';

    let { historyManager } = $props();

    let adapter = $derived(historyManager.adapter);

    let diffResult  = $state(null);
    let diffLoading = $state(false);
    let diffError   = $state(/** @type {string|null} */ (null));

    // Keep track of which snapshot we've loaded so we don't reload unnecessarily
    let loadedSnapId = $state(/** @type {string|null} */ (null));

    // Load diff whenever selectedSnap changes
    $effect(() => {
        const snap = historyManager.selectedSnap;
        if (!snap || snap.id === loadedSnapId) return;
        loadedSnapId = snap.id;
        loadDiff(snap);
    });

    async function loadDiff(snap) {
        diffLoading = true;
        diffError = null;
        diffResult = null;

        try {
            // Fetch the precomputed diff JSON — lightweight, no binaries.
            const diff = await historyManager.fetchDiff(snap);

            // Warn if we got a v1 generic diff for a sheets file (backfill needed)
            if (diff?.v === 1 && snap.app_type === 'sheets') {
                console.warn(`[history] Snapshot ${snap.id} has a v1 generic diff despite app_type=sheets. Run /api/backfill-diffs to fix.`);
            }

            diffResult = diff;
        } catch (err) {
            diffError = err.message ?? 'Failed to load diff';
        } finally {
            diffLoading = false;
        }
    }

    async function handleRestore() {
        const snap = historyManager.selectedSnap;
        if (!snap) return;
        if (!confirm('Restore this version? The current document state will be replaced.')) return;
        await historyManager.restoreSnapshot(snap.id);
    }

    function formatSnapInfo(snap) {
        if (!snap) return '';
        const d = new Date(snap.created_at);
        const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const users = snap.created_by
            ? snap.created_by.split(',').map(s => s.trim()).filter(Boolean).slice(0, 2).join(', ')
            : null;
        return `${date}, ${time}${users ? ` · by ${users}` : ''}`;
    }

    let snapInfo = $derived(formatSnapInfo(historyManager.selectedSnap));

    function formatDateGroup(tsMs) {
        const d = new Date(tsMs);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart - 86_400_000);
        const weekStart = new Date(todayStart - 6 * 86_400_000);
        if (d >= todayStart)     return 'Today';
        if (d >= yesterdayStart) return 'Yesterday';
        if (d >= weekStart)      return d.toLocaleDateString(undefined, { weekday: 'long' });
        return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    }

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

    // Keyboard: Escape closes the viewer
    function handleKeydown(e) {
        if (e.key === 'Escape') historyManager.closeViewer();
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Full-screen overlay -->
<div class="viewer-overlay" role="dialog" aria-modal="true" aria-label="Version history viewer">

    <!-- Top bar -->
    <div class="viewer-topbar">
        <button class="topbar-back" onclick={() => historyManager.closeViewer()}>
            ← History
        </button>

        <div class="topbar-info">
            {#if historyManager.selectedSnap}
                <span class="topbar-snapinfo">{snapInfo}</span>
            {:else}
                <span class="topbar-snapinfo">Select a version from the list</span>
            {/if}
        </div>

        <div class="topbar-actions">
            {#if historyManager.selectedSnap}
                <button
                    class="restore-btn"
                    onclick={handleRestore}
                    disabled={historyManager.restoring}
                >
                    {historyManager.restoring ? 'Restoring…' : 'Restore this version'}
                </button>
            {/if}
            <button class="close-btn" onclick={() => historyManager.closeViewer()} aria-label="Close">✕</button>
        </div>
    </div>

    <!-- Body -->
    <div class="viewer-body">

        <!-- Left sidebar: snapshot list -->
        <div class="viewer-sidebar">
            {#each groupedSnapshots as group}
                <div class="date-group-label">{group.label}</div>
                {#each group.snaps as snap (snap.id)}
                    <SnapshotListItem
                        {snap}
                        isSelected={historyManager.selectedSnap?.id === snap.id}
                        onSelect={() => historyManager.selectSnapshot(snap)}
                    />
                {/each}
            {/each}
        </div>

        <!-- Main diff area -->
        <div class="viewer-main">
            {#if !historyManager.selectedSnap}
                <div class="viewer-placeholder">
                    <div class="placeholder-icon">🕐</div>
                    <div>Select a version from the list to see what changed</div>
                </div>
            {:else if diffLoading}
                <div class="viewer-placeholder">
                    <div class="placeholder-icon spin">⟳</div>
                    <div>Loading diff…</div>
                </div>
            {:else if diffError}
                <div class="viewer-placeholder viewer-placeholder--error">
                    <div>Failed to load: {diffError}</div>
                </div>
            {:else if diffResult && adapter?.ViewerComponent}
                <svelte:component
                    this={adapter.ViewerComponent}
                    diff={diffResult}
                />
            {:else if diffResult}
                <!-- v1 generic diff or no app-specific viewer -->
                <div class="viewer-placeholder">
                    <div>Visual diff not available for this snapshot format.</div>
                    <div class="placeholder-sub">Re-run the server backfill to upgrade this snapshot.</div>
                </div>
            {:else if !diffLoading}
                <div class="viewer-placeholder">
                    <div>No diff data available for this snapshot.</div>
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .viewer-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        background: #fff;
        font-family: inherit;
    }

    /* ── Top bar ── */
    .viewer-topbar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 16px;
        height: 48px;
        border-bottom: 1px solid #e0e0e0;
        flex-shrink: 0;
        background: #fff;
    }

    .topbar-back {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 13px;
        color: #4285f4;
        padding: 4px 8px;
        border-radius: 4px;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .topbar-back:hover { background: #eef4ff; }

    .topbar-info {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        overflow: hidden;
    }

    .topbar-snapinfo {
        font-size: 13px;
        font-weight: 500;
        color: #333;
        white-space: nowrap;
    }

    .topbar-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }

    .restore-btn {
        font-size: 12px;
        padding: 5px 12px;
        background: #4285f4;
        color: #fff;
        border: none;
        border-radius: 4px;
        cursor: pointer;
    }
    .restore-btn:hover { background: #2b6fd4; }
    .restore-btn:disabled { background: #a0b8e0; cursor: default; }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #666;
        font-size: 16px;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
    }
    .close-btn:hover { background: #f0f0f0; color: #222; }

    /* ── Body ── */
    .viewer-body {
        flex: 1;
        display: flex;
        overflow: hidden;
    }

    /* Left sidebar */
    .viewer-sidebar {
        width: 260px;
        flex-shrink: 0;
        border-right: 1px solid #e0e0e0;
        overflow-y: auto;
        background: #fafafa;
    }

    .date-group-label {
        padding: 8px 12px 4px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #aaa;
        background: #f5f5f5;
        border-bottom: 1px solid #eee;
        position: sticky;
        top: 0;
        z-index: 1;
    }

    /* Main diff area */
    .viewer-main {
        flex: 1;
        overflow: auto;
        position: relative;
    }

    .viewer-placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        gap: 8px;
        font-size: 14px;
        color: #888;
        text-align: center;
        padding: 24px;
    }
    .viewer-placeholder--error { color: #c00; }

    .placeholder-icon {
        font-size: 36px;
        margin-bottom: 4px;
    }
    .placeholder-sub {
        font-size: 12px;
        color: #aaa;
    }

    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { display: inline-block; animation: spin 1s linear infinite; }
</style>
