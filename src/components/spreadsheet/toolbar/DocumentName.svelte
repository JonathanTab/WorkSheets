<script>
    import {
        spreadsheetSession,
        renameDocument,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import ConnectionStatus from "./ConnectionStatus.svelte";

    let isEditing = $state(false);
    let editValue = $state("");
    let inputRef = $state(null);
    let isSaving = $state(false);

    // Use reactive docTitle from session (updates when DocManager emits doc-updated)
    let documentTitle = $derived(spreadsheetSession.docTitle || "Untitled");

    // Update page title when document title changes
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
        // Focus input on next tick
        setTimeout(() => inputRef?.focus(), 0);
    }

    async function finishEditing() {
        if (isSaving) return;

        const trimmedValue = editValue.trim();
        if (trimmedValue && trimmedValue !== documentTitle) {
            isSaving = true;
            try {
                const docId = spreadsheetSession.docId;
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
        if (e.key === "Enter") {
            finishEditing();
        } else if (e.key === "Escape") {
            isEditing = false;
        }
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
        <button
            class="name-display"
            onclick={startEditing}
            title="Click to rename"
        >
            {documentTitle}
        </button>
    {/if}
    <ConnectionStatus />
</div>

<style>
    .document-name {
        display: flex;
        align-items: center;
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
</style>
