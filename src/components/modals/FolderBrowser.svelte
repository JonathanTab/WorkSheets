<script>
    import { storage } from "../../stores/storage.js";
    import {
        folder,
        home,
        chevronRight,
        check,
        plus,
    } from "../../lib/icons/index.js";

    /**
     * @type {{
     *   selectedFolderId: string|null,
     *   initialFolderId?: string|null,
     *   excludeFileId?: string|null,
     * }}
     */
    let {
        selectedFolderId = $bindable(null),
        initialFolderId = null,
        excludeFileId = null,
    } = $props();

    let allFolders = $state(/** @type {any[]} */ ([]));
    let allFiles = $state(/** @type {any[]} */ ([]));
    let browseFolderId = $state(initialFolderId);

    let creatingFolder = $state(false);
    let newFolderName = $state("");
    /** @type {HTMLInputElement|null} */
    let newFolderInput = $state(null);

    $effect(() => {
        const unsubFolders = storage.drive.folders.subscribe((/** @type {any[]} */ f) => { allFolders = f; });
        const unsubFiles = storage.drive.files.subscribe((/** @type {any[]} */ f) => { allFiles = f; });
        return () => { unsubFolders(); unsubFiles(); };
    });

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

    let currentSubFolders = $derived(allFolders.filter((f) => f.parentId === browseFolderId));
    let currentFiles = $derived(
        allFiles.filter((f) => (f.folderId ?? null) === browseFolderId && f.id !== excludeFileId)
    );

    function selectFolder(id) {
        selectedFolderId = id;
    }

    function navigateInto(id) {
        browseFolderId = id;
        selectedFolderId = id;
        cancelNewFolder();
    }

    function navigateTo(id) {
        browseFolderId = id;
        selectedFolderId = id;
        cancelNewFolder();
    }

    function startNewFolder() {
        creatingFolder = true;
        newFolderName = "";
        // focus after DOM updates
        setTimeout(() => newFolderInput?.focus(), 0);
    }

    function cancelNewFolder() {
        creatingFolder = false;
        newFolderName = "";
    }

    async function confirmNewFolder() {
        const name = newFolderName.trim();
        if (!name) return;
        creatingFolder = false;
        newFolderName = "";
        const fld = await storage.drive.createFolder({ name, parentId: browseFolderId });
        navigateInto(fld.id);
    }


</script>

<div class="folder-panel">
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
        <button class="new-folder-btn" onclick={startNewFolder} title="New folder">
            {@html plus}
            <span>New folder</span>
        </button>
    </div>

    <div class="folder-list">
        {#if browseFolderId === null}
            <button
                class="folder-item"
                class:selected={selectedFolderId === null}
                onclick={() => selectFolder(null)}
            >
                <span class="folder-icon root-icon">{@html home}</span>
                <span class="folder-name">My Drive (root)</span>
                {#if selectedFolderId === null}
                    <span class="check-icon">{@html check}</span>
                {/if}
            </button>
        {:else}
            <button
                class="folder-item parent-folder"
                onclick={() => navigateTo(breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 2].id : null)}
            >
                <span class="folder-icon up">{@html chevronRight}</span>
                <span class="folder-name">..</span>
            </button>
        {/if}

        {#each currentSubFolders as fld (fld.id)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="folder-item"
                class:selected={selectedFolderId === fld.id}
                onclick={() => selectFolder(fld.id)}
                ondblclick={() => navigateInto(fld.id)}
                role="button"
                tabindex="0"
                onkeydown={(e) => e.key === 'Enter' && selectFolder(fld.id)}
            >
                <span class="folder-icon">{@html folder}</span>
                <span class="folder-name">{fld.name}</span>
                {#if selectedFolderId === fld.id}
                    <span class="check-icon">{@html check}</span>
                {/if}
                <button
                    class="into-btn"
                    onclick={(e) => { e.stopPropagation(); navigateInto(fld.id); }}
                    tabindex="-1"
                >
                    {@html chevronRight}
                </button>
            </div>
        {/each}

        {#if creatingFolder}
            <div class="folder-item new-folder-row">
                <span class="folder-icon">{@html folder}</span>
                <input
                    bind:this={newFolderInput}
                    bind:value={newFolderName}
                    class="new-folder-input"
                    placeholder="Folder name"
                    onkeydown={(e) => {
                        if (e.key === 'Enter') confirmNewFolder();
                        if (e.key === 'Escape') cancelNewFolder();
                    }}
                    onblur={() => { if (!newFolderName.trim()) cancelNewFolder(); }}
                />
                <button class="new-folder-confirm" onclick={confirmNewFolder} disabled={!newFolderName.trim()}>
                    {@html check}
                </button>
            </div>
        {/if}

        {#each currentFiles as f (f.id)}
            <div class="file-row">
                <span class="file-row-name">{f.title || "Untitled"}</span>
            </div>
        {/each}

        {#if currentSubFolders.length === 0 && currentFiles.length === 0 && !creatingFolder && browseFolderId !== null}
            <p class="empty-hint">Empty folder</p>
        {/if}
    </div>
</div>

<style>
    .folder-panel {
        border: 1px solid var(--color-border);
        border-radius: 8px;
        overflow: hidden;
        background: var(--color-surface);
    }

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

    .new-folder-btn {
        display: flex;
        align-items: center;
        gap: 3px;
        margin-left: auto;
        background: none;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 2px 6px;
        font-size: 11px;
        white-space: nowrap;
    }

    .new-folder-btn :global(svg) {
        width: 10px;
        height: 10px;
    }

    .new-folder-btn:hover {
        background: var(--color-surface);
        color: var(--color-text);
        border-color: var(--color-text-muted);
    }

    .folder-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px;
        min-height: 180px;
        max-height: 250px;
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

    .folder-item.new-folder-row {
        padding: 4px 10px;
        cursor: default;
    }

    .folder-item.new-folder-row:hover {
        background: transparent;
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

    .new-folder-input {
        flex: 1;
        border: 1px solid var(--color-primary);
        border-radius: 3px;
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 12px;
        padding: 3px 6px;
        outline: none;
    }

    .new-folder-confirm {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: none;
        background: var(--color-primary);
        border-radius: 4px;
        cursor: pointer;
        color: white;
        flex-shrink: 0;
        padding: 0;
    }

    .new-folder-confirm:disabled {
        opacity: 0.4;
        cursor: default;
    }

    .new-folder-confirm :global(svg) {
        width: 12px;
        height: 12px;
    }

    .file-row {
        display: flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 4px;
        min-height: 32px;
        cursor: default;
    }

    .file-row-name {
        flex: 1;
        font-size: 12px;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .empty-hint {
        font-size: 12px;
        color: var(--color-text-muted);
        margin: 0;
        padding: 8px;
        text-align: center;
    }
</style>
