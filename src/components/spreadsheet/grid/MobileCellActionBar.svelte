<script>
    /**
     * MobileCellActionBar - floating action bar shown above/below the selection on mobile.
     * Replaces the right-click context menu for touch.
     */
    import MobileFormattingSheet from "../MobileFormattingSheet.svelte";

    let {
        rect = null,       // { x, y, width, height } selection bounds in container-local px
        containerEl = null,
        tableInfo = null,
        onClose = undefined,
        onCopy = undefined,
        onCut = undefined,
        onPaste = undefined,
        onClear = undefined,
        onDeleteRow = undefined,
    } = $props();

    let showFormatSheet = $state(false);

    const BAR_HEIGHT = 44;
    const BAR_MIN_MARGIN = 8;

    /**
     * Position the bar above the selection if there's room, else below.
     * Returns a fixed-position style string.
     */
    let barStyle = $derived.by(() => {
        if (!rect || !containerEl) return "display:none";
        const cr = containerEl.getBoundingClientRect();
        const selTop = cr.top + rect.y;
        const selBottom = cr.top + rect.y + rect.height;
        const selCenterX = cr.left + rect.x + rect.width / 2;
        const barWidth = canDeleteTableRow ? 400 : 340;
        let top;
        if (selTop - BAR_HEIGHT - BAR_MIN_MARGIN > 0) {
            top = selTop - BAR_HEIGHT - 6;
        } else {
            top = selBottom + 6;
        }
        const left = Math.max(
            BAR_MIN_MARGIN,
            Math.min(
                selCenterX - barWidth / 2,
                window.innerWidth - barWidth - BAR_MIN_MARGIN,
            ),
        );
        return `position:fixed; top:${top}px; left:${left}px; width:${barWidth}px; z-index:350;`;
    });

    let canDeleteTableRow = $derived(
        tableInfo?.rowType === "data",
    );

    function action(fn) {
        fn?.();
        // Don't auto-close so user can chain operations (copy -> paste, etc.)
    }
</script>

<svelte:window onclick={(e) => {
    // Close if tapping outside the bar
    if (!e.target.closest?.(".mobile-action-bar") && !e.target.closest?.(".bottom-sheet")) {
        onClose?.();
    }
}} />

{#if rect}
    <div class="mobile-action-bar" style={barStyle} role="toolbar" aria-label="Cell actions">
        <button class="action-btn" onclick={() => action(onCut)} title="Cut" aria-label="Cut selected cells">Cut</button>
        <div class="sep"></div>
        <button class="action-btn" onclick={() => action(onCopy)} title="Copy" aria-label="Copy selected cells">Copy</button>
        <div class="sep"></div>
        <button class="action-btn" onclick={() => action(onPaste)} title="Paste" aria-label="Paste into selection">Paste</button>
        <div class="sep"></div>
        <button class="action-btn" onclick={() => action(onClear)} title="Clear" aria-label="Clear selected cells">Clear</button>
        <div class="sep"></div>
        {#if canDeleteTableRow}
            <button
                class="action-btn"
                onclick={() => action(onDeleteRow)}
                title="Delete selected table row"
                aria-label="Delete selected table row"
            >
                Del Row
            </button>
            <div class="sep"></div>
        {/if}
        <button class="action-btn primary" onclick={() => { showFormatSheet = true; }} title="Format" aria-label="Open formatting actions">
            Format
        </button>
        <div class="sep"></div>
        <button class="action-btn action-btn--close" onclick={onClose} title="Close actions" aria-label="Close action bar">
            ✕
        </button>
    </div>
{/if}

<MobileFormattingSheet
    open={showFormatSheet}
    onClose={() => { showFormatSheet = false; onClose?.(); }}
/>

<style>
    .mobile-action-bar {
        display: flex;
        align-items: center;
        background: var(--color-surface, #ffffff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 10px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        overflow: hidden;
        height: 44px;
        pointer-events: auto;
        touch-action: manipulation;
    }

    .action-btn {
        flex: 1 1 auto;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        font-size: 0.8125rem;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        padding: 0 4px;
        -webkit-tap-highlight-color: transparent;
        white-space: nowrap;
        gap: 3px;
        min-width: 52px;
    }

    .action-btn:active {
        background: var(--color-fill, #f1f5f9);
    }

    .action-btn.primary {
        color: var(--color-primary, #3b82f6);
        font-weight: 600;
    }

    .action-btn--close {
        flex: 0 0 40px;
        min-width: 40px;
        font-weight: 700;
    }

    .sep {
        width: 1px;
        height: 28px;
        background: var(--color-border, #e2e8f0);
        flex-shrink: 0;
    }
</style>
