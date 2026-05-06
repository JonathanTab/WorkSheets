<script>
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import { warning, trash } from "../../lib/icons/index.js";

    let {
        title = "Confirm",
        message,
        confirmText = "Confirm",
        cancelText = "Cancel",
        variant = "default",
        onConfirm,
    } = $props();

    function handleConfirm() {
        closeTopModal();
        onConfirm();
    }
</script>

<div class="confirm-modal">
    <ModalHeader {title} />
    <div class="confirm-content">
        <div class="confirm-icon" class:danger={variant === "danger"}>
            {@html variant === "danger" ? trash : warning}
        </div>
        <p class="confirm-message">{message}</p>
    </div>
    <div class="confirm-footer">
        <Button variant="secondary" onclick={closeTopModal}>{cancelText}</Button
        >
        <Button
            variant={variant === "danger" ? "danger" : "primary"}
            onclick={handleConfirm}
        >
            {confirmText}
        </Button>
    </div>
</div>

<style>
    .confirm-modal {
        display: flex;
        flex-direction: column;
        min-width: 320px;
        max-width: 400px;
    }

    .confirm-content {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 16px;
    }

    .confirm-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        color: #f59e0b;
    }

    .confirm-icon.danger {
        color: var(--color-error, #ef4444);
    }

    .confirm-icon :global(svg) {
        width: 24px;
        height: 24px;
    }

    .confirm-message {
        margin: 0;
        font-size: 13px;
        color: var(--color-text-secondary);
        line-height: 1.5;
    }

    .confirm-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 0 16px 16px 16px;
    }
</style>
