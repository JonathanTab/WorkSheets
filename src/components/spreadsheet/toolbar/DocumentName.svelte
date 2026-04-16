<script>
    import {
        spreadsheetSession,
        renameDocument,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import { storage } from "../../../stores/storage.js";
    import { openModal } from "../../../lib/ui/modalStore.svelte.js";
    import ConnectionStatus from "./ConnectionStatus.svelte";
    import MoveFileModal from "../../modals/MoveFileModal.svelte";
    import ShareFileModal from "../../modals/ShareFileModal.svelte";
    import { folder as folderIcon, share as shareIcon } from "../../../lib/icons/index.js";

    let isEditing = $state(false);
    let editValue = $state("");
    let inputRef  = $state(null);
    let isSaving  = $state(false);

    let documentTitle = $derived(spreadsheetSession.docTitle || "Untitled");

    $effect(() => {
        if (documentTitle) {
            document.title = documentTitle + " - Worksheets";
        } else {
            document.title = "Worksheets";
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
        if (e.key === "Enter")  finishEditing();
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

    function openShareModal() {
        const docId = spreadsheetSession.docId;
        if (!docId) return;
        const file = storage.drive.getFile(docId);
        if (!file) return;
        openModal(ShareFileModal, { file });
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
            <button class="name-display" onclick={startEditing} title="Click to rename">
                {documentTitle}
            </button>
            <button
                class="move-btn"
                onclick={openMoveModal}
                title="Move to folder"
                aria-label="Move to folder"
            >
                {@html folderIcon}
            </button>
        </div>
    {/if}
    <button class="share-pill" onclick={openShareModal} title="Share document">
        {@html shareIcon}
        Share
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
        transition: background 0.1s, color 0.1s;
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

    .share-pill {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.25rem 0.75rem;
        font-size: 0.8125rem;
        font-weight: 600;
        color: #fff;
        background: var(--color-primary, #3b82f6);
        border: none;
        border-radius: 999px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.12s, transform 0.1s;
        line-height: 1;
    }

    .share-pill :global(svg) {
        width: 13px;
        height: 13px;
        flex-shrink: 0;
    }

    .share-pill:hover {
        background: var(--color-primary-hover, #2563eb);
    }

    .share-pill:active {
        transform: scale(0.96);
    }

    .share-pill:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 2px;
    }

    /* ── Mobile ── */
    @media (pointer: coarse), (max-width: 768px) {
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
        .share-pill {
            padding: 0.3rem 0.625rem;
        }
    }
</style>
