<script>
    /**
     * MobileToolbarShell — shared single-row 44px toolbar for all subapps on mobile.
     * Contains: back button + title area + right actions slot.
     *
     * Usage:
     *   <MobileToolbarShell onClose={handleClose} title="Doc Name">
     *     {#snippet actions()}
     *       <button>...</button>
     *     {/snippet}
     *   </MobileToolbarShell>
     */

    let {
        onClose = undefined,
        title = "",
        titleContent,
        actions,
    } = $props();
</script>

<div class="mobile-toolbar-shell">
    <div class="shell-left">
        {#if onClose}
            <button
                class="back-btn"
                onclick={onClose}
                title="Back"
                aria-label="Back"
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
            </button>
        {/if}
        {#if titleContent}
            {@render titleContent()}
        {:else}
            <span class="shell-title" title={title}>{title}</span>
        {/if}
    </div>
    <div class="shell-right">
        {@render actions?.()}
    </div>
</div>

<style>
    .mobile-toolbar-shell {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 44px;
        padding: 0 8px 0 4px;
        background: var(--color-bg-secondary, #f8fafc);
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
        user-select: none;
        gap: 8px;
    }

    .shell-left {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        flex: 1;
    }

    .shell-right {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
    }

    .back-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        background: transparent;
        border: none;
        border-radius: 8px;
        color: var(--color-text-secondary, #64748b);
        cursor: pointer;
        flex-shrink: 0;
        -webkit-tap-highlight-color: transparent;
    }

    .back-btn:active {
        background: var(--color-fill, #f1f5f9);
        color: var(--color-text, #1e293b);
    }

    .shell-title {
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--color-text, #1e293b);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
    }
</style>
