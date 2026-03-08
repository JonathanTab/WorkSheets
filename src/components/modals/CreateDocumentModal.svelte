<script>
    import Button from "../../lib/ui/Button.svelte";
    import Textbox from "../../lib/ui/Textbox.svelte";
    import { closeModal } from "../../lib/ui/modalStore.svelte.js";

    let { onConfirm } = $props();

    let title = $state("Untitled Spreadsheet");

    function handleSubmit() {
        onConfirm(title);
    }
</script>

<div class="p-6">
    <h2 class="text-lg font-semibold mb-4">Create New Spreadsheet</h2>
    <div class="mb-4">
        <label class="block text-sm font-medium mb-2">Title</label>
        <Textbox bind:value={title} placeholder="Enter document title" />
    </div>
    <div class="flex justify-end gap-2">
        <Button variant="secondary" onclick={closeModal}>Cancel</Button>
        <Button onclick={handleSubmit}>Create</Button>
    </div>
</div>
