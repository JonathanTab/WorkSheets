<script>
    import Card from "../lib/ui/Card.svelte";
    import Button from "../lib/ui/Button.svelte";
    import { openModal, closeModal } from "../lib/ui/modalStore.svelte.js";
    import { spreadsheet, edit, trash, plus } from "../lib/icons/index.js";
    import CreateDocumentModal from "./modals/CreateDocumentModal.svelte";
    import DeleteConfirmModal from "./modals/DeleteConfirmModal.svelte";
    import RenameDocumentModal from "./modals/RenameDocumentModal.svelte";
    import { storage } from "../stores/storage.js";
    import {
        createDocument,
        deleteDocument,
        renameDocument,
    } from "../stores/spreadsheetStore.svelte.js";

    let ready = $state(false);
    let files = $state([]);

    // Single effect: subscribe to storage.ready, and immediately subscribe to
    // drive.files inside the same callback when ready fires. This avoids the
    // Svelte 5 cross-effect race condition where a second $effect reading
    // `ready` could run before the first $effect's state update propagates.
    $effect(() => {
        let filesUnsub = null;

        const readyUnsub = storage.ready.subscribe((r) => {
            ready = r;
            if (r) {
                // storage.ready.subscribe fires synchronously with the current
                // value, so this runs immediately when storage is already ready.
                if (filesUnsub) filesUnsub();
                filesUnsub = storage.drive.files.subscribe((f) => {
                    files = f;
                });
            }
        });

        return () => {
            readyUnsub();
            if (filesUnsub) filesUnsub();
        };
    });

    // Derive documents from files reactively - only Yjs files, sorted by title
    let documents = $derived(
        files
            .filter((f) => f.type === "yjs")
            .sort((a, b) => (a.title || "").localeCompare(b.title || "")),
    );

    function handleOpenDocument(docId) {
        window.location.hash = docId;
    }

    function handleCreateDocument() {
        openModal(CreateDocumentModal, {
            onConfirm: async (title) => {
                try {
                    const doc = await createDocument(title);
                    closeModal();
                    handleOpenDocument(doc.id);
                } catch (e) {
                    console.error("Failed to create document:", e);
                }
            },
        });
    }

    function handleDeleteDocument(docId, event) {
        event.stopPropagation();
        const doc = documents.find((d) => d.id === docId);
        openModal(DeleteConfirmModal, {
            documentTitle: doc?.title || "this document",
            onConfirm: async () => {
                try {
                    await deleteDocument(docId);
                    closeModal();
                } catch (e) {
                    console.error("Failed to delete document:", e);
                }
            },
        });
    }

    function handleRenameDocument(docId, event) {
        event.stopPropagation();
        const doc = documents.find((d) => d.id === docId);
        openModal(RenameDocumentModal, {
            currentTitle: doc?.title || "",
            onConfirm: async (newTitle) => {
                try {
                    await renameDocument(docId, newTitle);
                    closeModal();
                } catch (e) {
                    console.error("Failed to rename document:", e);
                }
            },
        });
    }
</script>

<div class="document-picker">
    <div class="header">
        <div>
            <h1 class="text-2xl font-bold">WorkSheets</h1>
            <p class="text-text-muted text-sm mt-1">
                Collaborative Spreadsheets
            </p>
        </div>
        <Button onclick={handleCreateDocument} icon={plus} iconPosition="left">
            New Spreadsheet
        </Button>
    </div>

    {#if !ready}
        <div class="loading-state">
            <div class="spinner"></div>
            <p class="text-text-muted">Loading workspace...</p>
        </div>
    {:else if documents.length === 0}
        <div class="empty-state">
            <div class="empty-icon">{@html spreadsheet}</div>
            <h2 class="text-lg font-medium mb-2">No spreadsheets yet</h2>
            <p class="text-text-muted mb-4">
                Create your first spreadsheet to get started
            </p>
            <Button
                onclick={handleCreateDocument}
                icon={plus}
                iconPosition="left"
            >
                Create Spreadsheet
            </Button>
        </div>
    {:else}
        <div class="documents-grid">
            {#each documents as doc (doc.id)}
                <Card
                    className="document-card cursor-pointer hover:shadow-md transition-shadow"
                    onclick={() => handleOpenDocument(doc.id)}
                >
                    <div class="card-content">
                        <div class="document-icon">{@html spreadsheet}</div>
                        <h3 class="font-medium truncate">{doc.title}</h3>
                        <p class="text-text-muted text-sm">
                            {doc.owned
                                ? "Owned by you"
                                : `Shared by ${doc.owner || "someone"}`}
                        </p>
                        <div class="document-actions">
                            <button
                                class="action-btn"
                                onclick={(e) => handleRenameDocument(doc.id, e)}
                                title="Rename"
                            >
                                {@html edit}
                            </button>
                            {#if doc.owned}
                                <button
                                    class="action-btn"
                                    onclick={(e) =>
                                        handleDeleteDocument(doc.id, e)}
                                    title="Delete"
                                >
                                    {@html trash}
                                </button>
                            {/if}
                        </div>
                    </div>
                </Card>
            {/each}
        </div>
    {/if}
</div>

<style>
    .document-picker {
        padding: 2rem;
        max-width: 1200px;
        margin: 0 auto;
    }

    .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 2rem;
    }

    .loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 4rem 2rem;
        text-align: center;
    }

    .spinner {
        border: 4px solid #f3f3f3;
        border-top: 4px solid #3498db;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        animation: spin 1s linear infinite;
        margin-bottom: 1em;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 4rem 2rem;
        text-align: center;
    }

    .empty-icon {
        font-size: 4rem;
        margin-bottom: 1rem;
    }

    .documents-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
        gap: 1rem;
    }

    .document-card {
        position: relative;
    }

    .card-content {
        padding: 1rem;
    }

    .document-icon {
        font-size: 2rem;
        margin-bottom: 0.5rem;
    }

    .document-actions {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        display: flex;
        gap: 0.25rem;
        opacity: 0;
        transition: opacity 0.2s;
    }

    .document-card:hover .document-actions {
        opacity: 1;
    }

    .action-btn {
        padding: 0.25rem 0.5rem;
        background: rgba(0, 0, 0, 0.1);
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .action-btn:hover {
        background: rgba(0, 0, 0, 0.2);
    }
</style>
