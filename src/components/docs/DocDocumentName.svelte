<script>
    /**
     * DocDocumentName — editable document title with actions menu.
     * Mirrors the sheets DocumentName component for consistent UX.
     */
    import {
        docSession,
        renameDocument,
    } from "../../stores/docs/docStore.svelte.js";
    import { storage } from "../../stores/storage.js";
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import ConnectionStatus from "../spreadsheet/toolbar/ConnectionStatus.svelte";
    import MoveFileModal from "../modals/MoveFileModal.svelte";
    import ShareFileModal from "../modals/ShareFileModal.svelte";

    const moveSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`;
    const shareSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

    let isEditing = $state(false);
    let editValue = $state("");
    let inputRef = $state(null);
    let isSaving = $state(false);
    let showMenu = $state(false);
    let menuRef = $state(null);

    let documentTitle = $derived(docSession.metadata?.title || "Untitled");

    $effect(() => {
        if (documentTitle) {
            document.title = documentTitle + " - Documents";
        } else {
            document.title = "Documents";
        }
    });

    // Close menu on outside click
    function handleWindowClick(e) {
        if (showMenu && menuRef && !menuRef.contains(e.target)) {
            showMenu = false;
        }
    }

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
                const docId = docSession.docId;
                if (docId) {
                    await renameDocument(docId, trimmedValue);
                }
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
        showMenu = false;
        const docId = docSession.docId;
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
        showMenu = false;
        const docId = docSession.docId;
        if (!docId) return;
        const file = storage.drive.getFile(docId);
        if (!file) return;
        openModal(ShareFileModal, { file });
    }

    // Folder breadcrumb for current doc
    let folderPath = $derived.by(() => {
        const docId = docSession.docId;
        if (!docId) return null;
        const file = storage.drive.getFile(docId);
        if (!file?.folderId) return null;
        const folder = storage.drive.getFolder(file.folderId);
        return folder?.name ?? null;
    });
</script>

<svelte:window onclick={handleWindowClick} />

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
            <div class="doc-actions" bind:this={menuRef}>
                <button
                    class="doc-action-btn"
                    title="More options"
                    onclick={(e) => {
                        e.stopPropagation();
                        showMenu = !showMenu;
                    }}
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        width="12"
                        height="12"
                    >
                        <circle cx="12" cy="12" r="1" /><circle
                            cx="12"
                            cy="5"
                            r="1"
                        /><circle cx="12" cy="19" r="1" />
                    </svg>
                </button>
                {#if showMenu}
                    <div class="doc-menu">
                        <button class="doc-menu-item" onclick={openMoveModal}>
                            {@html moveSvg} Move to…
                        </button>
                        <button class="doc-menu-item" onclick={openShareModal}>
                            {@html shareSvg} Share…
                        </button>
                    </div>
                {/if}
            </div>
        </div>
    {/if}
    <ConnectionStatus />
</div>

<style>
    .document-name {
        display: flex;
        align-items: center;
        gap: 0.25rem;
    }

    .title-area {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        position: relative;
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

    .doc-actions {
        position: relative;
        display: flex;
        align-items: center;
    }

    .doc-action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        padding: 0;
        opacity: 0;
        transition: opacity 0.15s;
    }

    .title-area:hover .doc-action-btn {
        opacity: 1;
    }

    .doc-action-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .doc-menu {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        z-index: 200;
        min-width: 140px;
        padding: 0.25rem;
    }

    .doc-menu-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.625rem;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--color-text);
        font-size: 0.8125rem;
        cursor: pointer;
        text-align: left;
    }

    .doc-menu-item:hover {
        background: var(--color-fill);
    }

    /* Mobile: always show action button, truncate name */
    @media (pointer: coarse), (max-width: 768px) {
        .name-display {
            max-width: 120px;
            font-size: 0.8125rem;
        }
        .doc-action-btn {
            opacity: 1;
            width: 30px;
            height: 30px;
        }
        .folder-hint {
            display: none;
        }
        .doc-menu-item {
            padding: 0.625rem 0.75rem;
            font-size: 0.875rem;
        }
    }
</style>
