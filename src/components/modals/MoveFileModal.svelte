<script>
    import { storage } from "../../stores/storage.js";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";
    import FolderBrowser from "./FolderBrowser.svelte";

    /** @type {{ file: import('../../lib/FileRegistry/FileRegistry.js').FileDescriptor, onConfirm: (folderId: string|null) => void }} */
    let { file, onConfirm } = $props();

    let allFolders = $state(/** @type {any[]} */ ([]));
    let selectedFolderId = $state(file.folderId ?? null);

    $effect(() => {
        const unsub = storage.drive.folders.subscribe((/** @type {any[]} */ f) => { allFolders = f; });
        return () => unsub();
    });

    function folderName(id) {
        if (id === null) return "My Drive";
        return allFolders.find((f) => f.id === id)?.name ?? "Unknown folder";
    }

    async function confirm() {
        closeTopModal();
        onConfirm(selectedFolderId);
    }
</script>

<ModalHeader title="Move to folder" />

<div class="move-modal">
    <div class="file-info">
        <span class="file-label">Moving:</span>
        <span class="file-name">{file.title || "Untitled"}</span>
    </div>

    <FolderBrowser
        bind:selectedFolderId
        initialFolderId={file.folderId ?? null}
        excludeFileId={file.id}
    />

    <div class="selection-summary">
        <span class="summary-label">Destination:</span>
        <span class="summary-value">{folderName(selectedFolderId)}</span>
    </div>

    <div class="dialog-footer">
        <Button variant="secondary" onclick={closeTopModal}>Cancel</Button>
        <Button
            onclick={confirm}
            disabled={selectedFolderId === (file.folderId ?? null)}
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
