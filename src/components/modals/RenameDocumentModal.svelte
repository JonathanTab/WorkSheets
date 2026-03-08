<script>
    import Button from "../../lib/ui/Button.svelte";
    import Textbox from "../../lib/ui/Textbox.svelte";
    import { closeModal } from "../../lib/ui/modalStore.svelte.js";

    let { currentTitle, onConfirm } = $props();

    let title = $state(currentTitle);

    function handleSubmit() {
        onConfirm(title);
    }
</script>

<div class="p-6">
    <h2 class="text-lg font-semibold mb-4">Rename Document</h2>
    <div class="mb-4">
        <label class="block text-sm font-medium mb-2">Title</label>
        <Textbox bind:value={title} placeholder="Enter new title" />
    </div>
    <div class="flex justify-end gap-2">
        <Button variant="secondary" onclick={closeModal}>Cancel</Button>
        <Button onclick={handleSubmit}>Rename</Button>
    </div>
</div>
