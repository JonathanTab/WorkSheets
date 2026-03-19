<script>
    import Button from "../../lib/ui/Button.svelte";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";

    let { sheetName, onConfirm } = $props();

    function handleDelete() {
        onConfirm();
    }
</script>

<div class="dialog-content">
    <p class="dialog-message">
        Delete <strong>{sheetName}</strong>? This cannot be undone.
    </p>
    <div class="dialog-footer">
        <Button variant="secondary" onclick={closeTopModal}>Cancel</Button>
        <Button variant="danger" onclick={handleDelete}>Delete</Button>
    </div>
</div>

<style>
    .dialog-content {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    .dialog-message {
        margin: 0;
        font-size: 13px;
        color: var(--color-text-secondary);
        line-height: 1.5;
    }

    .dialog-message strong {
        color: var(--color-text);
        font-weight: 500;
    }

    .dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }
</style>
