<script>
    import { storage } from "../../stores/storage.js";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";
    import {
        folder,
        home,
        chevronRight,
        chevronDown,
        check,
    } from "../../lib/icons/index.js";

    /** @type {{ file: import('../../lib/FileRegistry/FileRegistry.js').FileDescriptor, onConfirm: (folderId: string|null) => void }} */
    let { file, onConfirm } = $props();

    let allFolders = $state([]);
    let browseFolderId = $state(null);
    let selectedFolderId = $state(file.folderId ?? null);
    let saving = $state(false);
    let expandedFolders = $state(new Set());

    $effect(() => {
        const unsub = storage.drive.folders.subscribe((f) => {
            allFolders = f;
        });
        return unsub;
    });

    // Flatten folder tree for rendering
    let flattenedFolders = $derived.by(() => {
        const result = [];
        const flatten = (parentId = null, depth = 0) => {
            const children = allFolders.filter((f) => f.parentId === parentId);
            for (const f of children) {
                result.push({ ...f, depth });
                if (expandedFolders.has(f.id)) {
                    flatten(f.id, depth + 1);
                }
            }
        };
        flatten(null, 0);
        return result;
    });

    // Recent folders
    let recentFolders = $derived.by(() => {
        const seen = new Set();
        const result = [];
        for (const f of storage.drive.recentlyOpened(50)) {
            const fid = f.folderId;
            if (fid && !seen.has(fid) && fid !== (file.folderId ?? null)) {
                seen.add(fid);
                const fld = allFolders.find((x) => x.id === fid);
                if (fld) result.push(fld);
                if (result.length >= 5) break;
            }
        }
        return result;
    });

    // Breadcrumb for current browse location
    let breadcrumb = $derived.by(() => {
        const crumbs = [];
        let id = browseFolderId;
        while (id) {
            const fld = allFolders.find((f) => f.id === id);
            if (!fld) break;
            crumbs.unshift(fld);
            id = fld.parentId;
        }
        return crumbs;
    });

    // Folders in current browse location
    let currentFolderChildren = $derived(
        allFolders.filter((f) => f.parentId === browseFolderId),
    );

    function toggleFolderExpand(folderId) {
        const newExpanded = new Set(expandedFolders);
        if (newExpanded.has(folderId)) {
            newExpanded.delete(folderId);
        } else {
            newExpanded.add(folderId);
        }
        expandedFolders = newExpanded;
    }

    function selectFolder(id) {
        selectedFolderId = id;
    }

    function navigateInto(id) {
        browseFolderId = id;
        selectedFolderId = id;
    }

    function navigateTo(id) {
        browseFolderId = id;
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
        return allFolders.find((f) => f.id === id)?.name ?? "Unknown folder";
    }

    // Check if folder has children
    function hasChildren(folderId) {
        return allFolders.some((f) => f.parentId === folderId);
    }
</script>

<ModalHeader title="Move to folder" />

<div class="move-modal">
    <!-- File being moved -->
    <div class="file-info">
        <span class="file-label">Moving:</span>
        <span class="file-name">{file.title || "Untitled"}</span>
    </div>

    <!-- Recent folders -->
    {#if recentFolders.length > 0}
        <div class="section">
            <p class="section-label">Recent locations</p>
            <div class="recent-list">
                {#each recentFolders as fld (fld.id)}
                    <button
                        class="recent-item"
                        class:selected={selectedFolderId === fld.id}
                        onclick={() => selectFolder(fld.id)}
                        ondblclick={() => {
                            selectFolder(fld.id);
                            confirm();
                        }}
                    >
                        <span class="folder-icon">{@html folder}</span>
                        <span class="recent-name">{fld.name}</span>
                        {#if selectedFolderId === fld.id}
                            <span class="check-icon">{@html check}</span>
                        {/if}
                    </button>
                {/each}
            </div>
        </div>
        <div class="divider"></div>
    {/if}

    <!-- Single panel folder browser -->
    <div class="folder-panel">
        <!-- Breadcrumb navigation -->
        <div class="breadcrumb">
            <button
                class="crumb root"
                class:active={browseFolderId === null}
                onclick={() => navigateTo(null)}
            >
                <span class="crumb-icon">{@html home}</span>
                <span>My Drive</span>
            </button>
            {#each breadcrumb as crumb, i}
                <span class="crumb-sep">{@html chevronRight}</span>
                <button
                    class="crumb"
                    class:active={i === breadcrumb.length - 1}
                    onclick={() => navigateTo(crumb.id)}
                >
                    {crumb.name}
                </button>
            {/each}
        </div>

        <!-- Folder list -->
        <div class="folder-list">
            <!-- Root option when at root level -->
            {#if browseFolderId === null}
                <button
                    class="folder-item"
                    class:selected={selectedFolderId === null}
                    onclick={() => selectFolder(null)}
                    ondblclick={() => confirm()}
                >
                    <span class="folder-icon root-icon">{@html home}</span>
                    <span class="folder-name">My Drive (root)</span>
                    {#if selectedFolderId === null}
                        <span class="check-icon">{@html check}</span>
                    {/if}
                </button>
            {:else}
                <!-- Parent folder navigation -->
                <button
                    class="folder-item parent-folder"
                    onclick={() =>
                        navigateTo(
                            breadcrumb.length > 0
                                ? (breadcrumb[breadcrumb.length - 1].parentId ??
                                      null)
                                : null,
                        )}
                >
                    <span class="folder-icon up">{@html chevronRight}</span>
                    <span class="folder-name">..</span>
                </button>
            {/if}

            {#each currentFolderChildren as fld (fld.id)}
                <button
                    class="folder-item"
                    class:selected={selectedFolderId === fld.id}
                    onclick={() => selectFolder(fld.id)}
                    ondblclick={() => navigateInto(fld.id)}
                >
                    <span class="folder-icon">{@html folder}</span>
                    <span class="folder-name">{fld.name}</span>
                    {#if selectedFolderId === fld.id}
                        <span class="check-icon">{@html check}</span>
                    {/if}
                    {#if hasChildren(fld.id)}
                        <button
                            class="into-btn"
                            onclick={(e) => {
                                e.stopPropagation();
                                navigateInto(fld.id);
                            }}
                        >
                            {@html chevronRight}
                        </button>
                    {/if}
                </button>
            {/each}

            {#if currentFolderChildren.length === 0 && browseFolderId !== null}
                <p class="empty-hint">No sub-folders</p>
            {/if}
        </div>
    </div>

    <!-- Selection summary -->
    <div class="selection-summary">
        <span class="summary-label">Destination:</span>
        <span class="summary-value">{folderName(selectedFolderId)}</span>
    </div>

    <!-- Actions -->
    <div class="dialog-footer">
        <Button variant="secondary" onclick={closeTopModal}>Cancel</Button>
        <Button
            loading={saving}
            onclick={confirm}
            disabled={selectedFolderId === file.folderId}
        >
            Move here
        </Button>
    </div>
</div>

<style>
    .move-modal {
        padding: 12px 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 560px;
        max-width: 90vw;
    }

    .file-info {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        background: var(--color-fill);
        border-radius: 6px;
        font-size: 0.8125rem;
    }

    .file-label {
        color: var(--color-text-muted);
    }

    .file-name {
        font-weight: 500;
        color: var(--color-text);
    }

    .section-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--color-text-muted);
        margin: 0 0 6px 0;
    }

    .recent-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .recent-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border: 1px solid var(--color-border);
        border-radius: 6px;
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 12px;
        cursor: pointer;
        transition: all 0.15s;
    }

    .recent-item:hover {
        background: var(--color-fill);
        border-color: var(--color-primary);
    }

    .recent-item.selected {
        border-color: var(--color-primary);
        background: var(--color-primary-soft);
    }

    .recent-name {
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .divider {
        height: 1px;
        background: var(--color-border);
        margin: 4px 0;
    }

    /* Folder Panel */
    .folder-panel {
        border: 1px solid var(--color-border);
        border-radius: 8px;
        overflow: hidden;
        background: var(--color-surface);
    }

    /* Breadcrumb */
    .breadcrumb {
        display: flex;
        align-items: center;
        gap: 2px;
        font-size: 11px;
        flex-wrap: wrap;
        padding: 8px 10px;
        background: var(--color-fill);
        border-bottom: 1px solid var(--color-border);
    }

    .crumb {
        display: flex;
        align-items: center;
        gap: 3px;
        background: none;
        border: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 3px;
        font-size: 11px;
    }

    .crumb:hover {
        background: var(--color-surface);
        color: var(--color-text);
    }

    .crumb.active {
        color: var(--color-text);
        font-weight: 500;
    }

    .crumb.root {
        font-weight: 500;
    }

    .crumb-icon {
        display: flex;
        align-items: center;
        width: 12px;
        height: 12px;
    }

    .crumb-icon :global(svg) {
        width: 12px;
        height: 12px;
    }

    .crumb-sep {
        display: flex;
        align-items: center;
        width: 10px;
        height: 10px;
        color: var(--color-text-muted);
    }

    .crumb-sep :global(svg) {
        width: 10px;
        height: 10px;
    }

    /* Folder list */
    .folder-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px;
        min-height: 200px;
        max-height: 280px;
        overflow-y: auto;
    }

    .folder-item {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 8px 10px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text);
        font-size: 12px;
        cursor: pointer;
        text-align: left;
        transition: all 0.1s;
        min-height: 36px;
    }

    .folder-item:hover {
        background: var(--color-fill);
    }

    .folder-item.selected {
        background: var(--color-primary-soft);
        border-color: var(--color-primary);
    }

    .folder-item.parent-folder {
        color: var(--color-text-muted);
    }

    .folder-icon {
        display: flex;
        align-items: center;
        width: 16px;
        height: 16px;
        color: #f59e0b;
        flex-shrink: 0;
    }

    .folder-icon :global(svg) {
        width: 16px;
        height: 16px;
    }

    .folder-icon.up {
        color: var(--color-text-muted);
        transform: rotate(-90deg);
    }

    .folder-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

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
        padding: 0;
    }

    .into-btn :global(svg) {
        width: 12px;
        height: 12px;
    }

    .into-btn:hover {
        background: var(--color-border);
        color: var(--color-text);
    }

    .check-icon {
        display: flex;
        align-items: center;
        width: 14px;
        height: 14px;
        color: var(--color-primary);
        flex-shrink: 0;
        margin-left: auto;
    }

    .check-icon :global(svg) {
        width: 14px;
        height: 14px;
    }

    .empty-hint {
        font-size: 12px;
        color: var(--color-text-muted);
        margin: 0;
        padding: 8px;
        text-align: center;
    }

    .selection-summary {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        background: var(--color-fill);
        border-radius: 6px;
        font-size: 0.8125rem;
    }

    .summary-label {
        color: var(--color-text-muted);
    }

    .summary-value {
        font-weight: 500;
        color: var(--color-primary);
    }

    .dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--color-border);
        margin-top: 4px;
    }
</style>
