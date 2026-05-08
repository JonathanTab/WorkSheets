<script>
    import {
        spreadsheetSession,
        renameDocument,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import { storage } from "../../../stores/storage.js";
    import { openModal } from "../../../lib/ui/modalStore.svelte.js";
    import ConnectionStatus from "./ConnectionStatus.svelte";
    import MoveFileModal from "../../modals/MoveFileModal.svelte";
    import { folder as folderIcon } from "../../../lib/icons/index.js";

    let isEditing = $state(false);
    let editValue = $state("");
    let inputRef = $state(null);
    let isSaving = $state(false);

    let documentTitle = $derived(spreadsheetSession.docTitle || "Untitled");

    $effect(() => {
        if (documentTitle) {
            document.title = documentTitle + " - Scriptorium";
        } else {
            document.title = "Scriptorium";
        }
    });

    async function startEditing() {
        editValue = documentTitle;
        isEditing = true;
        setTimeout(() => inputRef?.focus(), 0);
    }

    async function finishEditing() {
        if (isSaving) return;
        const trimmedValue = editValue.trim();
        if (trimmedValue && trimmedValue !== documentTitle) {
            isSaving = true;
            try {
                const docId = spreadsheetSession.docId;
                if (docId) await renameDocument(docId, trimmedValue);
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
        const docId = spreadsheetSession.docId;
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

    // Folder breadcrumb for current doc
    let folderPath = $derived.by(() => {
        const docId = spreadsheetSession.docId;
        if (!docId) return null;
        const file = storage.drive.getFile(docId);
        if (!file?.folderId) return null;
        const folder = storage.drive.getFolder(file.folderId);
        return folder?.name ?? null;
    });
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
                <span class="folder-hint">{folderPath} /</span>
            {/if}
            <button
                class="name-display"
                onclick={startEditing}
                title="Click to rename"
            >
                {documentTitle}
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
    <ConnectionStatus />
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
        font-size: 0.75rem;
        color: var(--color-text-muted);
        white-space: nowrap;
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
            opacity: 1;
            width: 30px;
            height: 30px;
        }
        .folder-hint {
            display: none;
        }
    }
</style>
