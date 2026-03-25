<script>
    /**
     * HistoryPanel — Document version history.
     *
     * Shows a list of snapshots with metadata, lets the user preview a diff
     * between a snapshot and the current document, and restore a snapshot.
     *
     * Props:
     *   registry   - FileRegistry instance
     *   fileId     - ID of the file whose history is shown
     *   currentDoc - live Y.Doc for the file (used for diff comparison)
     *   onClose    - callback when the panel should close
     */
    import { onMount } from 'svelte';
    import * as Y from 'yjs';

    let { registry, fileId, currentDoc = null, onClose } = $props();

    // ---------- State ----------
    let snapshots = $state([]);
    let loading = $state(true);
    let error = $state(null);
    let selectedId = $state(null);
    let diffResult = $state(null);   // { sheets: [{ name, added, removed, changed }] } | null
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
        if (!currentDoc) return;

        diffLoading = true;
        try {
            const data = await registry.getSnapshotData(fileId, id);
            const snapDoc = new Y.Doc();
            Y.applyUpdate(snapDoc, data);
            diffResult = computeSpreadsheetDiff(snapDoc, currentDoc);
            snapDoc.destroy();
        } catch (err) {
            diffResult = { error: err.message };
        } finally {
            diffLoading = false;
        }
    }

    // ---------- Restore ----------
    async function handleRestore(snapshotId) {
        if (!confirm('Restore this snapshot? The current state will be replaced and a new collaboration room will be created.')) return;
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

    // ---------- Diff computation ----------
    /**
     * Compare a snapshot Y.Doc vs the live Y.Doc.
     * Returns a summary of changed cells per sheet.
     * @param {Y.Doc} snapDoc
     * @param {Y.Doc} liveDoc
     */
    function computeSpreadsheetDiff(snapDoc, liveDoc) {
        try {
            const snapRoot = snapDoc.getMap('spreadsheet');
            const liveRoot = liveDoc.getMap('spreadsheet');
            const snapSheets = snapRoot.get('sheets');
            const liveSheets = liveRoot.get('sheets');
            if (!snapSheets || !liveSheets) return null;

            const results = [];

            // Build map of snap sheets by id
            const snapSheetMap = new Map();
            for (const [sid, s] of snapSheets) snapSheetMap.set(sid, s);

            for (const [sheetId, liveSheet] of liveSheets) {
                const snapSheet = snapSheetMap.get(sheetId);
                const sheetName = liveSheet.get?.('name') ?? sheetId;

                if (!snapSheet) {
                    results.push({ name: sheetName, added: '(new sheet)', removed: '', changed: 0 });
                    continue;
                }

                const liveCells = liveSheet.get?.('cells');
                const snapCells = snapSheet.get?.('cells');
                if (!liveCells || !snapCells) continue;

                let added = 0, removed = 0, changed = 0;

                // Check cells in snap that changed or disappeared in live
                for (const [key, snapCell] of snapCells) {
                    const liveCell = liveCells.get?.(key);
                    if (!liveCell) {
                        removed++;
                    } else {
                        const sv = snapCell.get?.('v');
                        const lv = liveCell.get?.('v');
                        if (sv !== lv) changed++;
                    }
                }
                // Check cells in live that didn't exist in snap
                for (const [key] of liveCells) {
                    if (!snapCells.get?.(key)) added++;
                }

                if (added + removed + changed > 0) {
                    results.push({ name: sheetName, added, removed, changed });
                }
            }

            // Sheets in snap that no longer exist in live
            for (const [sheetId, snapSheet] of snapSheetMap) {
                if (!liveSheets.get?.(sheetId)) {
                    results.push({ name: snapSheet.get?.('name') ?? sheetId, added: '', removed: '(deleted sheet)', changed: 0 });
                }
            }

            return { sheets: results };
        } catch {
            return null;
        }
    }

    // ---------- Formatting helpers ----------
    function formatDate(tsMs) {
        return new Date(tsMs).toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    }

    function formatTrigger(trigger) {
        return { auto: 'Auto', manual: 'Manual', room_empty: 'Session end' }[trigger] ?? trigger;
    }

    function formatUsers(createdBy) {
        if (!createdBy) return '';
        const names = createdBy.split(',').map(s => s.trim()).filter(Boolean);
        if (names.length === 0) return '';
        if (names.length === 1) return names[0];
        if (names.length === 2) return names.join(' & ');
        return `${names[0]} +${names.length - 1}`;
    }
</script>

<!-- Panel container -->
<div class="flex flex-col h-full bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100">

    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <h2 class="font-semibold text-base">Version History</h2>
        <button
            onclick={onClose}
            class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded"
            aria-label="Close history panel"
        >✕</button>
    </div>

    <!-- Manual snapshot bar -->
    <div class="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <input
            type="text"
            bind:value={snapshotDesc}
            placeholder="Label (optional)"
            class="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
            onclick={handleCreateSnapshot}
            disabled={snapshotCreating}
            class="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
        >
            {snapshotCreating ? 'Saving…' : 'Save snapshot'}
        </button>
    </div>

    <!-- Error banner -->
    {#if error}
        <div class="mx-4 mt-2 px-3 py-2 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded text-xs flex-shrink-0">
            {error}
        </div>
    {/if}

    <!-- Snapshot list -->
    <div class="flex-1 overflow-y-auto">
        {#if loading}
            <div class="flex items-center justify-center py-12 text-gray-400">Loading…</div>
        {:else if snapshots.length === 0}
            <div class="flex flex-col items-center justify-center py-12 text-gray-400 gap-1">
                <span class="text-2xl">🕐</span>
                <span>No snapshots yet</span>
                <span class="text-xs">Snapshots are created automatically when sessions end or every hour during activity.</span>
            </div>
        {:else}
            {#each snapshots as snap (snap.id)}
                {@const isSelected = selectedId === snap.id}
                <div class="border-b border-gray-100 dark:border-gray-800">
                    <!-- Snapshot row -->
                    <button
                        class="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors {isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}"
                        onclick={() => selectSnapshot(snap.id)}
                    >
                        <div class="flex items-start justify-between gap-2">
                            <div class="flex-1 min-w-0">
                                <div class="font-medium text-xs truncate">
                                    {snap.description || formatDate(snap.created_at)}
                                </div>
                                {#if snap.description}
                                    <div class="text-[11px] text-gray-500 dark:text-gray-400">{formatDate(snap.created_at)}</div>
                                {/if}
                                <div class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5 flex gap-2">
                                    <span>{formatTrigger(snap.trigger)}</span>
                                    {#if snap.created_by}
                                        <span>· {formatUsers(snap.created_by)}</span>
                                    {/if}
                                </div>
                            </div>
                            <span class="text-[10px] text-gray-400 flex-shrink-0 mt-0.5">{isSelected ? '▲' : '▼'}</span>
                        </div>
                    </button>

                    <!-- Expanded: diff + restore -->
                    {#if isSelected}
                        <div class="px-4 pb-3 bg-blue-50 dark:bg-blue-900/10">
                            {#if diffLoading}
                                <div class="text-xs text-gray-400 py-2">Computing diff…</div>
                            {:else if diffResult?.error}
                                <div class="text-xs text-red-500 py-2">{diffResult.error}</div>
                            {:else if diffResult?.sheets?.length === 0}
                                <div class="text-xs text-gray-500 py-2">No changes between this snapshot and current.</div>
                            {:else if diffResult?.sheets}
                                <div class="text-xs text-gray-600 dark:text-gray-300 py-2 space-y-1">
                                    <div class="font-medium mb-1">Changes vs current:</div>
                                    {#each diffResult.sheets as sheet}
                                        <div class="flex items-center gap-2">
                                            <span class="font-medium">{sheet.name}</span>
                                            {#if typeof sheet.added === 'string'}
                                                <span class="text-blue-600">{sheet.added}</span>
                                            {:else if typeof sheet.removed === 'string'}
                                                <span class="text-gray-400">{sheet.removed}</span>
                                            {:else}
                                                {#if sheet.changed > 0}<span class="text-amber-600">{sheet.changed} changed</span>{/if}
                                                {#if sheet.added > 0}<span class="text-green-600">{sheet.added} added</span>{/if}
                                                {#if sheet.removed > 0}<span class="text-red-500">{sheet.removed} removed</span>{/if}
                                            {/if}
                                        </div>
                                    {/each}
                                </div>
                            {:else if !currentDoc}
                                <div class="text-xs text-gray-400 py-2">Open the document to preview changes.</div>
                            {/if}

                            {#if restoreError}
                                <div class="text-xs text-red-500 mt-1">{restoreError}</div>
                            {/if}

                            <button
                                onclick={() => handleRestore(snap.id)}
                                disabled={restoring}
                                class="mt-2 text-xs px-3 py-1.5 bg-orange-500 text-white rounded hover:bg-orange-600 disabled:opacity-50 font-medium"
                            >
                                {restoring ? 'Restoring…' : 'Restore this version'}
                            </button>
                        </div>
                    {/if}
                </div>
            {/each}
        {/if}
    </div>
</div>
