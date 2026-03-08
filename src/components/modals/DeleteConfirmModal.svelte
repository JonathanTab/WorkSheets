<script>
    import Button from "../../lib/ui/Button.svelte";
    import { closeModal } from "../../lib/ui/modalStore.svelte.js";

    let { documentTitle, onConfirm } = $props();

    function handleDelete() {
        onConfirm();
    }
</script>

<div class="p-6">
    <h2 class="text-lg font-semibold mb-4">Delete Document</h2>
    <p class="mb-4 text-text-muted">
        Are you sure you want to delete "{documentTitle}"? This action cannot be
        undone.
    </p>
    <div class="flex justify-end gap-2">
        <Button variant="secondary" onclick={closeModal}>Cancel</Button>
        <Button variant="danger" onclick={handleDelete}>Delete</Button>
    </div>
</div>
