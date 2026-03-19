<script>
    import { closeTopModal } from "./modalStore.svelte";

    let { title = "" } = $props();
</script>

<div class="modal-header">
    <h2 class="modal-title"><slot>{title}</slot></h2>
    <button
        class="close-btn"
        onclick={closeTopModal}
        aria-label="Close"
        type="button"
    >
        <svg
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
        >
            <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
    </button>
</div>

<style>
    .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-surface);
        flex-shrink: 0;
        /* Drag handle aesthetic for desktop feel */
        user-select: none;
    }

    .modal-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text);
        letter-spacing: -0.01em;
    }

    .close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        transition:
            background 0.1s,
            color 0.1s;
    }

    .close-btn:hover {
        background: var(--color-fill-secondary);
        color: var(--color-text);
    }

    .close-btn svg {
        width: 10px;
        height: 10px;
    }
</style>
