<script>
    import Button from "../../lib/ui/Button.svelte";
    import Textbox from "../../lib/ui/Textbox.svelte";
    import { closeModal } from "../../lib/ui/modalStore.svelte.js";

    let { currentName, onConfirm } = $props();

    let name = $state(currentName);

    function handleSubmit() {
        onConfirm(name);
    }
</script>

<div class="p-6">
    <h2 class="text-lg font-semibold mb-4">Rename Sheet</h2>
    <div class="mb-4">
        <label class="block text-sm font-medium mb-2">Name</label>
        <Textbox bind:value={name} placeholder="Sheet name" />
    </div>
    <div class="flex justify-end gap-2">
        <Button variant="secondary" onclick={closeModal}>Cancel</Button>
        <Button onclick={handleSubmit}>Rename</Button>
    </div>
</div>
