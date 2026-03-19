<script>
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";

    let {
        title = "Input",
        label = "",
        placeholder = "",
        value = "",
        onConfirm,
        confirmText = "Create",
    } = $props();

    let inputValue = $state(value);

    function handleConfirm() {
        if (inputValue?.trim()) {
            onConfirm(inputValue.trim());
        }
    }

    function handleKeydown(e) {
        if (e.key === "Enter" && inputValue?.trim()) {
            handleConfirm();
        }
    }
</script>

<div class="prompt-modal">
    <ModalHeader {title} />
    <div class="prompt-content">
        {#if label}
            <label class="prompt-label">{label}</label>
        {/if}
        <input
            type="text"
            class="prompt-input"
            bind:value={inputValue}
            {placeholder}
            onkeydown={handleKeydown}
            autofocus
        />
    </div>
    <div class="prompt-footer">
        <Button variant="secondary" onclick={closeTopModal}>Cancel</Button>
        <Button onclick={handleConfirm} disabled={!inputValue?.trim()}>
            {confirmText}
        </Button>
    </div>
</div>

<style>
    .prompt-modal {
        display: flex;
        flex-direction: column;
        min-width: 320px;
        max-width: 400px;
    }

    .prompt-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px;
    }

    .prompt-label {
        font-size: 13px;
        color: var(--color-text-secondary);
    }

    .prompt-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--color-border);
        border-radius: 6px;
        font-size: 13px;
        background: var(--color-surface);
        color: var(--color-text);
        outline: none;
        transition:
            border-color 0.15s,
            box-shadow 0.15s;
    }

    .prompt-input:focus {
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px var(--color-focus-ring);
    }

    .prompt-input::placeholder {
        color: var(--color-text-muted);
    }

    .prompt-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 0 16px 16px 16px;
    }
</style>
