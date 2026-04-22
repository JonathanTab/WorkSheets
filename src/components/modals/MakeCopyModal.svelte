<script>
    import { storage } from "../../stores/storage.js";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";
    import Textbox from "../../lib/ui/Textbox.svelte";
    import { router } from "../../lib/router.svelte.js";
    import {
        folder,
        home,
        chevronRight,
        check,
    } from "../../lib/icons/index.js";

    /** @type {{ file: import('../../lib/FileRegistry/FileRegistry.js').FileDescriptor }} */
    let { file } = $props();

    let copyTitle = $state(`Copy of ${file.title ?? "Untitled"}`);
    let allFolders = $state(/** @type {any[]} */ ([]));
    let allFiles = $state(/** @type {any[]} */ ([]));
    let browseFolderId = $state(file.folderId ?? null);
    let selectedFolderId = $state(file.folderId ?? null);
    let saving = $state(false);

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
    let currentFiles = $derived(allFiles.filter((f) => (f.folderId ?? null) === browseFolderId));

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

    function folderName(id) {
        if (id === null) return "My Drive";
        return allFolders.find((f) => f.id === id)?.name ?? "Unknown folder";
    }

    async function makeCopy(andOpen = false) {
        if (saving) return;
        saving = true;
        try {
            const newFile = await storage.drive.duplicateFile(file.id, {
                title: copyTitle.trim() || `Copy of ${file.title ?? "Untitled"}`,
                folderId: selectedFolderId,
            });
            closeTopModal();
            if (andOpen) {
                router.openFile(newFile);
            }
        } finally {
            saving = false;
        }
    }
</script>

<ModalHeader title="Make a copy" />

<div class="copy-modal">
    <div class="field">
        <label class="field-label">Name</label>
        <Textbox bind:value={copyTitle} placeholder="Copy name" />
    </div>

    <div class="field">
        <label class="field-label">Location</label>
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
            </div>

            <div class="folder-list">
                {#if browseFolderId === null}
                    <button
                        class="folder-item"
                        class:selected={selectedFolderId === null}
                        onclick={() => selectFolder(null)}
                        ondblclick={() => makeCopy(false)}
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
                        onclick={() =>
                            navigateTo(
                                breadcrumb.length > 0
                                    ? (breadcrumb[breadcrumb.length - 1].parentId ?? null)
                                    : null,
                            )}
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

                {#each currentFiles as f (f.id)}
                    <div class="file-row">
                        <span class="file-row-name">{f.title || "Untitled"}</span>
                    </div>
                {/each}

                {#if currentSubFolders.length === 0 && currentFiles.length === 0 && browseFolderId !== null}
                    <p class="empty-hint">Empty folder</p>
                {/if}
            </div>
        </div>
    </div>

    <div class="selection-summary">
        <span class="summary-label">Destination:</span>
        <span class="summary-value">{folderName(selectedFolderId)}</span>
    </div>

    <div class="dialog-footer">
        <Button variant="secondary" onclick={closeTopModal}>Cancel</Button>
        <Button variant="secondary" loading={saving} onclick={() => makeCopy(false)}>
            Make a copy
        </Button>
        <Button loading={saving} onclick={() => makeCopy(true)}>
            Make a copy & open
        </Button>
    </div>
</div>

<style>
    .copy-modal {
        padding: 12px 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 560px;
        max-width: 90vw;
    }

    .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .field-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--color-text-muted);
        margin: 0;
    }

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

    .folder-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px;
        min-height: 160px;
        max-height: 220px;
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
