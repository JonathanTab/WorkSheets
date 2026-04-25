<script>
    import DocumentName from "./toolbar/DocumentName.svelte";
    import MenuBar from "./toolbar/MenuBar.svelte";
    import FormattingToolbar from "./toolbar/FormattingToolbar.svelte";
    import PresenceIndicator from "./PresenceIndicator.svelte";
    import UserMenu from "../UserMenu.svelte";

    let {
        onClose = undefined,
        awareness = null,
        currentUser = "",
        onShowHistory = undefined,
        registry = null,
    } = $props();
</script>

<div class="toolbar">
    <div class="toolbar-row row1">
        <div class="row1-left">
            {#if onClose}
                <button
                    class="close-btn"
                    onclick={onClose}
                    title="Close document"
                >
                    ← Back
                </button>
            {/if}
            <DocumentName />
            <MenuBar />
        </div>
        <div class="row1-right">
            <PresenceIndicator {awareness} {currentUser} />
            {#if onShowHistory}
                <button
                    class="history-btn"
                    onclick={onShowHistory}
                    title="Document history"
                    aria-label="View document history"
                >
                    <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                    </svg>
                </button>
            {/if}
            <UserMenu {registry} />
        </div>
    </div>
    <div class="toolbar-row row2">
        <FormattingToolbar />
    </div>
</div>

<style>
    .toolbar {
        display: flex;
        flex-direction: column;
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
        user-select: none;
    }

    .toolbar-row {
        display: flex;
        align-items: center;
        padding: 0 8px;
        min-height: 32px;
    }

    .row1 {
        justify-content: space-between;
        border-bottom: 1px solid var(--color-border);
        gap: 8px;
        background: var(--color-bg-secondary);
    }

    .row1-left {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .row1-right {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .history-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: 4px;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all 0.1s ease;
    }

    .history-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .history-btn:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .row2 {
        justify-content: flex-start;
        background: var(--color-surface);
        padding: 0 6px;
    }

    .close-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--color-text-secondary);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.1s ease;
    }

    .close-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .close-btn:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    /* ── Mobile: tighter rows ── */
    @media (max-width: 600px) {
        .toolbar-row {
            min-height: 38px;
            padding: 0 6px;
        }
        .row1 {
            gap: 4px;
        }
        .close-btn {
            padding: 6px 10px;
            font-size: 0.875rem;
        }
    }
</style>
