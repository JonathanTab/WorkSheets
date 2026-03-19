<script>
    import Button from "../../lib/ui/Button.svelte";
    import Textbox from "../../lib/ui/Textbox.svelte";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";

    let { currentTitle, onConfirm } = $props();

    let title = $state(currentTitle);

    function handleSubmit() {
        onConfirm(title);
    }
</script>

<div class="dialog-content">
    <div class="field">
        <label class="field-label">Title</label>
        <Textbox bind:value={title} placeholder="Enter new title" />
    </div>
    <div class="dialog-footer">
        <Button variant="secondary" onclick={closeTopModal}>Cancel</Button>
        <Button onclick={handleSubmit}>Rename</Button>
    </div>
</div>

<style>
    .dialog-content {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .field-label {
        font-size: 12px;
        font-weight: 500;
        color: var(--color-text-secondary);
    }

    .dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding-top: 8px;
    }
</style>
