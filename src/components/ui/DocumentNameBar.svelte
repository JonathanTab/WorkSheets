<script>
    /**
     * DocumentNameBar — shared editable document title + folder breadcrumb +
     * move button + connection status for any sub-app's toolbar.
     *
     * App-agnostic: the only app-specific bits arrive as props (the doc id, its
     * title, and a rename callback). Folder breadcrumb, move, and the connection
     * indicator all work off the shared `storage` registry, so this single
     * component is the one place to change toolbar title/folder UX.
     *
     * @typedef {Object} Props
     * @property {string|null} docId        Current document id.
     * @property {string} title             Display title.
     * @property {(newTitle: string) => (void | Promise<void>)} onRename
     * @property {string} [tabTitleSuffix]  Suffix for the browser tab title.
     */

    import { fromStore } from "svelte/store";
    import { storage } from "../../stores/storage.js";
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import { folder as folderIcon } from "../../lib/icons/index.js";
    import ConnectionStatus from "./ConnectionStatus.svelte";
    import MoveFileModal from "../modals/MoveFileModal.svelte";

    /** @type {Props} */
    let {
        docId = null,
        title = "Untitled",
        onRename = async () => {},
        tabTitleSuffix = "Scriptorium",
    } = $props();

    // Reactive drive stores — touching `.current` makes folderPath recompute
    // whenever files/folders change (e.g. after a move or folder rename).
    const driveFiles = fromStore(storage.drive.files);
    const driveFolders = fromStore(storage.drive.folders);

    let isEditing = $state(false);
    let editValue = $state("");
    let inputRef = $state(null);
    let isSaving = $state(false);

    let displayTitle = $derived(title || "Untitled");

    $effect(() => {
        document.title = displayTitle
            ? `${displayTitle} - ${tabTitleSuffix}`
            : tabTitleSuffix;
    });

    // Folder breadcrumb for current doc. Depends on the reactive drive stores so
    // it updates live after a move; uses the authoritative getters for lookup.
    let folderPath = $derived.by(() => {
        if (!docId) return null;
        void driveFiles.current; // establish reactive dependency
        void driveFolders.current;
        const file = storage.drive.getFile(docId);
        if (!file?.folderId) return null;
        const folder = storage.drive.getFolder(file.folderId);
        return folder?.name ?? null;
    });

    function startEditing() {
        editValue = displayTitle;
        isEditing = true;
        setTimeout(() => inputRef?.focus(), 0);
    }

    async function finishEditing() {
        if (isSaving) return;
        const trimmedValue = editValue.trim();
        if (trimmedValue && trimmedValue !== displayTitle) {
            isSaving = true;
            try {
                await onRename(trimmedValue);
            } catch (error) {
                console.error("Failed to rename document:", error);
            } finally {
                isSaving = false;
            }
        }
        isEditing = false;
    }

    function handleKeydown(e) {
        if (e.key === "Enter") finishEditing();
        if (e.key === "Escape") isEditing = false;
    }

    function openMoveModal() {
        if (!docId) return;
        const file = storage.drive.getFile(docId);
        if (!file) return;
        openModal(MoveFileModal, {
            file,
            onConfirm: async (targetFolderId) => {
                await storage.drive.moveFile(docId, targetFolderId);
            },
        });
    }
</script>

<div class="document-name">
    {#if isEditing}
        <input
            bind:this={inputRef}
            type="text"
            class="name-input"
            bind:value={editValue}
            onblur={finishEditing}
            onkeydown={handleKeydown}
        />
    {:else}
        <div class="title-area">
            {#if folderPath}
                <button
                    class="folder-hint"
                    onclick={openMoveModal}
                    title="Move to folder"
                >
                    {folderPath} /
                </button>
            {/if}
            <button
                class="name-display"
                onclick={startEditing}
                title="Click to rename"
            >
                {displayTitle}
            </button>
        </div>
    {/if}
    <button
        class="move-btn"
        onclick={openMoveModal}
        title="Move to folder"
        aria-label="Move to folder"
    >
        {@html folderIcon}
    </button>
    <ConnectionStatus {docId} />
</div>

<style>
    .document-name {
        display: flex;
        align-items: center;
        gap: 0.375rem;
    }

    .title-area {
        display: flex;
        align-items: center;
        gap: 0.25rem;
    }

    .folder-hint {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        padding: 0.25rem 0.375rem;
        font-size: 0.75rem;
        color: var(--color-text-muted);
        white-space: nowrap;
        cursor: pointer;
    }

    .folder-hint:hover {
        background: var(--color-fill);
        border-color: var(--color-border);
        color: var(--color-text);
    }

    .name-display {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        padding: 0.25rem 0.5rem;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text);
        cursor: text;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .name-display:hover {
        background: var(--color-fill);
        border-color: var(--color-border);
    }

    .name-input {
        background: var(--color-surface);
        border: 1px solid var(--color-primary);
        border-radius: 4px;
        padding: 0.25rem 0.5rem;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text);
        max-width: 200px;
        outline: none;
        box-shadow: 0 0 0 2px var(--color-focus-ring);
    }

    .move-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 0;
        transition:
            background 0.1s,
            color 0.1s;
        flex-shrink: 0;
    }

    .move-btn :global(svg) {
        width: 14px;
        height: 14px;
    }

    .move-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    /* ── Mobile ── */
    @media (max-width: 600px) {
        .name-display {
            max-width: 120px;
            font-size: 0.8125rem;
        }
        .move-btn {
            width: 30px;
            height: 30px;
        }
        .folder-hint {
            display: none;
        }
    }
</style>
