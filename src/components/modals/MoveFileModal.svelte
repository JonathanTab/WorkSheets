<script>
    import { storage } from "../../stores/storage.js";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";

    /** @type {{ file: import('../../lib/FileRegistry/FileRegistry.js').FileDescriptor, onConfirm: (folderId: string|null) => void }} */
    let { file, onConfirm } = $props();

    const folderSvg  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    const arrowRightSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
    const homeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;

    let allFolders = $state([]);
    let browseFolderId = $state(null);
    let selectedFolderId = $state(file.folderId ?? null);
    let saving = $state(false);

    $effect(() => {
        const unsub = storage.drive.folders.subscribe(f => { allFolders = f; });
        return unsub;
    });

    let recentFolders = $derived.by(() => {
        // Last 5 distinct folders from recently opened files
        const seen = new Set();
        const result = [];
        for (const f of storage.drive.recentlyOpened(50)) {
            const fid = f.folderId;
            if (fid && !seen.has(fid) && fid !== (file.folderId ?? null)) {
                seen.add(fid);
                const folder = allFolders.find(x => x.id === fid);
                if (folder) result.push(folder);
                if (result.length >= 5) break;
            }
        }
        return result;
    });

    let currentFolderChildren = $derived(
        allFolders.filter(f => f.parentId === browseFolderId)
    );

    let breadcrumb = $derived.by(() => {
        const crumbs = [];
        let id = browseFolderId;
        while (id) {
            const folder = allFolders.find(f => f.id === id);
            if (!folder) break;
            crumbs.unshift(folder);
            id = folder.parentId;
        }
        return crumbs;
    });

    function selectFolder(id) {
        selectedFolderId = id;
    }

    function navigateInto(id) {
        browseFolderId = id;
        selectedFolderId = id;
    }

    async function confirm() {
        saving = true;
        try {
            await onConfirm(selectedFolderId);
        } finally {
            saving = false;
        }
    }

    function folderName(id) {
        if (id === null) return "My Drive";
        return allFolders.find(f => f.id === id)?.name ?? "Unknown folder";
    }
</script>

<ModalHeader title="Move to folder" />

<div class="move-modal">
    <!-- Recent folders -->
    {#if recentFolders.length > 0}
        <div class="section">
            <p class="section-label">Recent folders</p>
            <div class="recent-list">
                {#each recentFolders as folder (folder.id)}
                    <button
                        class="recent-item"
                        class:selected={selectedFolderId === folder.id}
                        onclick={() => selectFolder(folder.id)}
                        ondblclick={() => { selectFolder(folder.id); confirm(); }}
                    >
                        <span class="folder-icon">{@html folderSvg}</span>
                        {folder.name}
                    </button>
                {/each}
            </div>
        </div>
        <hr class="divider" />
    {/if}

    <!-- Browser -->
    <div class="section">
        <p class="section-label">Browse</p>

        <!-- Breadcrumb -->
        <div class="breadcrumb">
            <button class="crumb root" onclick={() => { browseFolderId = null; selectedFolderId = null; }}>
                {@html homeSvg} My Drive
            </button>
            {#each breadcrumb as crumb}
                <span class="crumb-sep">{@html arrowRightSvg}</span>
                <button class="crumb" onclick={() => { browseFolderId = crumb.id; selectedFolderId = crumb.id; }}>
                    {crumb.name}
                </button>
            {/each}
        </div>

        <!-- Root option -->
        {#if browseFolderId !== null}
            <button
                class="folder-row"
                class:selected={selectedFolderId === null}
                onclick={() => selectFolder(null)}
            >
                <span class="folder-icon">{@html homeSvg}</span>
                <span>My Drive (root)</span>
            </button>
        {:else}
            <button
                class="folder-row root-row"
                class:selected={selectedFolderId === null}
                onclick={() => selectFolder(null)}
            >
                <span class="folder-icon">{@html homeSvg}</span>
                <span>My Drive (root)</span>
            </button>
        {/if}

        <!-- Sub-folders -->
        {#each currentFolderChildren as folder (folder.id)}
            <button
                class="folder-row"
                class:selected={selectedFolderId === folder.id}
                onclick={() => selectFolder(folder.id)}
            >
                <span class="folder-icon">{@html folderSvg}</span>
                <span class="folder-name">{folder.name}</span>
                {#if allFolders.some(f => f.parentId === folder.id)}
                    <button class="into-btn" title="Open" onclick={(e) => { e.stopPropagation(); navigateInto(folder.id); }}>
                        {@html arrowRightSvg}
                    </button>
                {/if}
            </button>
        {/each}

        {#if currentFolderChildren.length === 0 && browseFolderId !== null}
            <p class="empty-hint">No sub-folders here</p>
        {/if}
    </div>

    <!-- Selection summary -->
    <p class="selection-summary">
        Move to: <strong>{folderName(selectedFolderId)}</strong>
    </p>

    <!-- Actions -->
    <div class="actions">
        <Button variant="secondary" onclick={closeTopModal}>Cancel</Button>
        <Button loading={saving} onclick={confirm} disabled={selectedFolderId === file.folderId}>
            Move here
        </Button>
    </div>
</div>

<style>
    .move-modal {
        padding: 0.75rem 1rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        max-height: 60vh;
        overflow-y: auto;
    }

    .section-label {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-text-muted);
        margin-bottom: 0.375rem;
    }

    .recent-list {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
    }

    .recent-item {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.375rem 0.625rem;
        border: 1px solid var(--color-border);
        border-radius: 8px;
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 0.8125rem;
        cursor: pointer;
        transition: border-color 0.1s, background 0.1s;
    }

    .recent-item:hover { background: var(--color-fill); }
    .recent-item.selected { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 10%, transparent); }

    .divider { border: none; border-top: 1px solid var(--color-border); }

    .breadcrumb {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 0.8125rem;
        margin-bottom: 0.375rem;
        flex-wrap: wrap;
    }

    .crumb {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        background: none;
        border: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 0.125rem 0.25rem;
        border-radius: 4px;
        font-size: 0.8125rem;
    }

    .crumb:hover { background: var(--color-fill); color: var(--color-text); }

    .crumb-sep { display: flex; align-items: center; width: 10px; height: 10px; color: var(--color-text-muted); }
    .crumb-sep :global(svg) { width: 10px; height: 10px; }
    .crumb :global(svg), .folder-icon :global(svg) { width: 14px; height: 14px; flex-shrink: 0; }

    .folder-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.5rem;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--color-text);
        font-size: 0.875rem;
        cursor: pointer;
        text-align: left;
        transition: background 0.1s, border-color 0.1s;
    }

    .folder-row:hover { background: var(--color-fill); }
    .folder-row.selected { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 10%, transparent); }

    .folder-icon { display: flex; align-items: center; color: #f59e0b; flex-shrink: 0; }
    .folder-name { flex: 1; }

    .into-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: none;
        background: var(--color-fill-secondary);
        border-radius: 4px;
        cursor: pointer;
        color: var(--color-text-secondary);
        flex-shrink: 0;
        margin-left: auto;
        padding: 0;
    }

    .into-btn :global(svg) { width: 12px; height: 12px; }
    .into-btn:hover { background: var(--color-border); color: var(--color-text); }

    .empty-hint { font-size: 0.8125rem; color: var(--color-text-muted); padding: 0.25rem 0.5rem; }

    .selection-summary {
        font-size: 0.875rem;
        color: var(--color-text-secondary);
        padding: 0.25rem 0;
    }

    .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding-top: 0.25rem;
    }
</style>
