<script>
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import { info, warning, check } from "../../lib/icons/index.js";

    let {
        title = "Notice",
        message,
        type = "info",
        buttonText = "OK",
    } = $props();

    const iconMap = {
        info: info,
        warning: warning,
        success: check,
    };

    const iconColorMap = {
        info: "var(--color-primary)",
        warning: "#f59e0b",
        success: "#22c55e",
    };
</script>

<div class="alert-modal">
    <ModalHeader {title} />
    <div class="alert-content">
        <div
            class="alert-icon"
            style="color: {iconColorMap[type] || iconColorMap.info}"
        >
            {@html iconMap[type] || info}
        </div>
        <p class="alert-message">{message}</p>
    </div>
    <div class="alert-footer">
        <Button onclick={closeTopModal}>{buttonText}</Button>
    </div>
</div>

<style>
    .alert-modal {
        display: flex;
        flex-direction: column;
        min-width: 300px;
        max-width: 400px;
    }

    .alert-content {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 16px;
    }

    .alert-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        flex-shrink: 0;
    }

    .alert-icon :global(svg) {
        width: 24px;
        height: 24px;
    }

    .alert-message {
        margin: 0;
        font-size: 13px;
        color: var(--color-text-secondary);
        line-height: 1.5;
    }

    .alert-footer {
        display: flex;
        justify-content: flex-end;
        padding: 0 16px 16px 16px;
    }
</style>
