<script>
    /**
     * SelectionHandles — draggable corner handles for touch-based range selection.
     * Rendered inside the dom-overlay-layer of Grid.svelte when on mobile.
     *
     * Two handles:
     *  - Bottom-right: drag to extend selection forward
     *  - Top-left: drag to shrink/extend selection backward
     *
     * Touch events use e.preventDefault() + touch-action:none to prevent scroll.
     * Uses hitTestEngine from Svelte context to map touch coords → row/col.
     */
    import { getContext } from "svelte";
    import { selectionState } from "../../../stores/spreadsheet/index.js";

    let {
        rect = null,       // { x, y, width, height } in container-local px
        onEndSelection = undefined,
    } = $props();

    const hitTestEngine = getContext("hitTestEngine");

    let draggingHandle = $state(null);
    let cachedContainerRect = null;

    // Handle elements — we attach touchstart via addEventListener to get passive:false
    let brHandleEl = $state(null);
    let tlHandleEl = $state(null);

    $effect(() => {
        if (!brHandleEl) return;
        const h = (e) => startDrag(e, 'br');
        brHandleEl.addEventListener('touchstart', h, { passive: false });
        return () => brHandleEl.removeEventListener('touchstart', h);
    });

    $effect(() => {
        if (!tlHandleEl) return;
        const h = (e) => startDrag(e, 'tl');
        tlHandleEl.addEventListener('touchstart', h, { passive: false });
        return () => tlHandleEl.removeEventListener('touchstart', h);
    });

    function startDrag(e, handle) {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        draggingHandle = handle;

        // Re-enter selecting mode with the correct anchor:
        // BR handle: anchor stays top-left, drag extends toward bottom-right
        // TL handle: anchor swaps to bottom-right, drag extends toward top-left
        const anchor = selectionState.anchor;
        const focus = selectionState.focus ?? anchor;
        if (anchor) {
            if (handle === 'tl') {
                // Anchor at the current focus (far corner), extend from there
                selectionState.startSelection(focus.row, focus.col, false);
            } else {
                // Anchor stays, just re-enable selecting
                selectionState.startSelection(anchor.row, anchor.col, false);
                if (focus && (focus.row !== anchor.row || focus.col !== anchor.col)) {
                    selectionState.focus = focus;
                }
            }
        }

        const el = e.currentTarget.closest(".grid-root") ??
                   document.querySelector(".grid-root");
        cachedContainerRect = el?.getBoundingClientRect() ?? null;
        document.addEventListener('touchmove', handleTouchMove, { passive: false });
        document.addEventListener('touchend', handleTouchEnd);
        document.addEventListener('touchcancel', handleTouchEnd);
    }

    function handleTouchMove(e) {
        if (!draggingHandle || !hitTestEngine) return;
        e.preventDefault();
        const touch = e.touches[0];
        const cr = cachedContainerRect;
        if (!cr) return;
        const hit = hitTestEngine.hitTest(touch.clientX - cr.left, touch.clientY - cr.top);
        if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
            selectionState.extendSelection(hit.row, hit.col);
        }
    }

    function handleTouchEnd() {
        if (!draggingHandle) return;
        draggingHandle = null;
        cachedContainerRect = null;
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('touchcancel', handleTouchEnd);
        selectionState.endSelection();
        onEndSelection?.();
    }

    // Positions derived from rect
    let brX = $derived(rect ? rect.x + rect.width : null);
    let brY = $derived(rect ? rect.y + rect.height : null);
    let tlX = $derived(rect ? rect.x : null);
    let tlY = $derived(rect ? rect.y : null);

    // Only show TL handle when selection spans more than one cell
    let showTL = $derived(rect && (rect.width > 30 || rect.height > 30));
</script>

{#if rect}
    <!-- Bottom-right handle -->
    <div
        bind:this={brHandleEl}
        class="sel-handle sel-handle-br"
        style="left: {brX - 10}px; top: {brY - 10}px;"
        role="presentation"
        aria-hidden="true"
    >
        <div class="sel-handle-dot"></div>
    </div>

    <!-- Top-left handle (only for multi-cell selections) -->
    {#if showTL}
        <div
            bind:this={tlHandleEl}
            class="sel-handle sel-handle-tl"
            style="left: {tlX - 10}px; top: {tlY - 10}px;"
            role="presentation"
            aria-hidden="true"
        >
            <div class="sel-handle-dot"></div>
        </div>
    {/if}
{/if}

<style>
    .sel-handle {
        position: absolute;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 12;
        touch-action: none;
        pointer-events: auto;
        /* Expand touch target beyond visual dot */
        cursor: crosshair;
    }

    .sel-handle-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--selection-border, #3b82f6);
        border: 2px solid #ffffff;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
        pointer-events: none;
    }
</style>
