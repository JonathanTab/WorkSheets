<script>
    /**
     * BottomSheet — generic slide-up drawer used by mobile UIs across all subapps.
     *
     * Usage:
     *   <BottomSheet open={showPanel} onClose={() => showPanel = false} title="Format">
     *     ...content...
     *   </BottomSheet>
     */

    let {
        open = false,
        onClose = undefined,
        title = "",
        maxHeight = "80vh",
        children,
    } = $props();

    // Track touch drag for swipe-to-dismiss
    let dragStartY = $state(null);
    let dragDeltaY = $state(0);
    let isDragging = $state(false);

    function handleHandleTouchStart(e) {
        if (e.touches.length !== 1) return;
        dragStartY = e.touches[0].clientY;
        dragDeltaY = 0;
        isDragging = true;
    }

    function handleHandleTouchMove(e) {
        if (!isDragging || dragStartY === null) return;
        const dy = e.touches[0].clientY - dragStartY;
        dragDeltaY = Math.max(0, dy); // only allow dragging down
    }

    function handleHandleTouchEnd() {
        if (dragDeltaY > 80) {
            onClose?.();
        }
        dragStartY = null;
        dragDeltaY = 0;
        isDragging = false;
    }

    function handleBackdropClick() {
        onClose?.();
    }

    function handleKeydown(e) {
        if (e.key === "Escape") onClose?.();
    }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
    <!-- Backdrop -->
    <div
        class="bottom-sheet-backdrop"
        role="presentation"
        onclick={handleBackdropClick}
    ></div>

    <!-- Sheet -->
    <div
        class="bottom-sheet"
        style="max-height: {maxHeight}; transform: translateY({dragDeltaY}px);"
        role="dialog"
        aria-modal="true"
        aria-label={title || "Panel"}
    >
        <!-- Drag handle -->
        <div
            class="bottom-sheet-handle-bar"
            role="presentation"
            ontouchstart={handleHandleTouchStart}
            ontouchmove={handleHandleTouchMove}
            ontouchend={handleHandleTouchEnd}
        >
            <div class="bottom-sheet-handle-pill"></div>
        </div>

        {#if title}
            <div class="bottom-sheet-header">
                <span class="bottom-sheet-title">{title}</span>
                <button
                    class="bottom-sheet-close"
                    onclick={onClose}
                    aria-label="Close"
                >✕</button>
            </div>
        {/if}

        <div class="bottom-sheet-content">
            {@render children?.()}
        </div>
    </div>
{/if}

<style>
    .bottom-sheet-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 300;
        animation: fade-in 0.2s ease;
    }

    .bottom-sheet {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        background: var(--color-surface, #ffffff);
        border-radius: 16px 16px 0 0;
        border-top: 1px solid var(--color-border, #e2e8f0);
        z-index: 301;
        overflow: hidden;
        overscroll-behavior: contain;
        box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
        animation: slide-up 0.25s ease;
        will-change: transform;
        transition: transform 0.05s linear;
        display: flex;
        flex-direction: column;
    }

    .bottom-sheet-handle-bar {
        padding: 10px 0 4px;
        display: flex;
        justify-content: center;
        flex-shrink: 0;
        touch-action: none;
        cursor: grab;
    }

    .bottom-sheet-handle-pill {
        width: 36px;
        height: 4px;
        background: var(--color-border, #cbd5e1);
        border-radius: 2px;
    }

    .bottom-sheet-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 16px 12px;
        flex-shrink: 0;
    }

    .bottom-sheet-title {
        font-size: 1rem;
        font-weight: 600;
        color: var(--color-text, #1e293b);
    }

    .bottom-sheet-close {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-fill, #f1f5f9);
        border: none;
        border-radius: 50%;
        font-size: 0.875rem;
        color: var(--color-text-secondary, #64748b);
        cursor: pointer;
    }

    .bottom-sheet-close:active {
        background: var(--color-border, #e2e8f0);
    }

    .bottom-sheet-content {
        overflow-y: auto;
        overscroll-behavior: contain;
        flex: 1;
        min-height: 0;
    }

    @keyframes fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }

    @keyframes slide-up {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
    }
</style>
