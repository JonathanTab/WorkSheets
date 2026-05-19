<script>
    import { storage } from "../../stores/storage.js";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";
    import Textbox from "../../lib/ui/Textbox.svelte";
    import FolderBrowser from "./FolderBrowser.svelte";
    import { getFileRoute } from "../../lib/appTypes.js";

    /** @type {{ file: import('../../lib/FileRegistry/FileRegistry.js').FileDescriptor }} */
    let { file } = $props();

    let copyTitle = $state(`Copy of ${file.title ?? "Untitled"}`);
    let allFolders = $state(/** @type {any[]} */ ([]));
    let selectedFolderId = $state(file.folderId ?? null);
    let saving = $state(false);

    $effect(() => {
        const unsub = storage.drive.folders.subscribe((/** @type {any[]} */ f) => { allFolders = f; });
        return () => unsub();
    });

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
            if (andOpen) {
                window.location.href = getFileRoute(newFile.app, newFile.id);
            } else {
                closeTopModal();
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
        <FolderBrowser
            bind:selectedFolderId
            initialFolderId={file.folderId ?? null}
        />
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
