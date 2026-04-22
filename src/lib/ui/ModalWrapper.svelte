<script>
    import { closeModal } from "./modalStore.svelte";
    import { scale } from "svelte/transition";
    import { onMount } from "svelte";

    let { modal, isTop, depth, zIndex, onOutroend } = $props();

    let container;
    let panel = $state(null);

    // Depth effects for stacked modals - subtle scale and dim
    let panelStyle = $derived(
        isTop
            ? ""
            : `transform: scale(${1 - depth * 0.02}) translateY(${depth * 8}px);
               opacity: ${1 - depth * 0.15};`,
    );

    function getFocusable() {
        return panel?.querySelectorAll(
            'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
    }

    function trapTab(e) {
        if (!isTop || e.key !== "Tab") return;
        const focusables = getFocusable();
        if (!focusables?.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    $effect(() => {
        if (!isTop) return;
        setTimeout(() => {
            const focusables = getFocusable();
            focusables?.[0]?.focus();
        }, 50);
    });

    function handleKeydown(e) {
        if (e.key === "Escape" && isTop) closeModal(modal.id);
    }

    onMount(() => {
        window.addEventListener("keydown", handleKeydown);
        return () => window.removeEventListener("keydown", handleKeydown);
    });

    function handleBackdropClick(e) {
        if (e.target === container && isTop) closeModal(modal.id);
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    bind:this={container}
    class="modal-backdrop"
    style={`z-index: ${zIndex}`}
    onclick={handleBackdropClick}
    onkeydown={trapTab}
>
    {#if !modal.closing}
        <div
            bind:this={panel}
            role="dialog"
            aria-modal="true"
            class="modal-panel {isTop ? 'modal-panel-top' : ''}"
            style={panelStyle}
            in:scale|global={{ start: 0.95, duration: 150 }}
            out:scale|global={{ start: 0.95, duration: 100 }}
            onoutroend={() => onOutroend?.()}
        >
            <modal.component {...modal.props} />
        </div>
    {/if}
</div>

<style>
    .modal-backdrop {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
    }

    .modal-panel {
        /* Desktop dialog styling - sharp corners, window-like appearance */
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow:
            0 8px 32px rgba(0, 0, 0, 0.15),
            0 2px 8px rgba(0, 0, 0, 0.1);

        /* Sizing */
        min-width: 360px;
        max-width: 680px;
        max-height: 85vh;

        /* Layout */
        display: flex;
        flex-direction: column;
        overflow: hidden;

        pointer-events: none;
        transition:
            transform 0.15s ease,
            opacity 0.15s ease;
    }

    .modal-panel-top {
        pointer-events: auto;
    }

    /* Responsive adjustments */
    @media (max-width: 480px) {
        .modal-panel {
            min-width: calc(100vw - 32px);
            max-width: calc(100vw - 32px);
            max-height: calc(100vh - 48px);
        }
    }
</style>
