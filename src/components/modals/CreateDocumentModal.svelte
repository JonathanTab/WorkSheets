<script>
    import Button from "../../lib/ui/Button.svelte";
    import Textbox from "../../lib/ui/Textbox.svelte";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import {
        getDefaultTitle,
        getAppName,
        APP_SHEETS,
        APP_DOCS,
    } from "../../lib/appTypes.js";

    let { onConfirm, appType = APP_SHEETS } = $props();

    let title = $state(getDefaultTitle(appType));

    function handleSubmit() {
        onConfirm(title);
    }

    // Reactive label based on app type
    let appLabel = $derived(getAppName(appType));
</script>

<div class="dialog-content">
    <div class="field">
        <label class="field-label">Title</label>
        <Textbox
            bind:value={title}
            placeholder="Enter {appLabel.toLowerCase()} title"
        />
    </div>
    <div class="dialog-footer">
        <Button variant="secondary" onclick={closeTopModal}>Cancel</Button>
        <Button onclick={handleSubmit}>Create</Button>
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
