<script>
    import { closeModal } from "./modalStore.svelte";
    import { fly } from "svelte/transition";
    import { onMount } from "svelte";

    let { modal, isTop, depth, zIndex, onOutroend } = $props();

    let container;
    let panel;

    // Depth effects: scale down, translate down, darken, and blur
    let panelStyle = $derived(
        isTop
            ? ""
            : `transform: scale(${1 - depth * 0.03}) translateY(${depth * 12}px);
               filter: brightness(${1 - depth * 0.15}) blur(${depth * 1}px);`,
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

<div
    bind:this={container}
    class="fixed inset-0 flex items-end justify-center md:items-center pointer-events-none"
    style={`z-index: ${zIndex}`}
    on:click={handleBackdropClick}
    on:keydown={trapTab}
>
    {#if !modal.closing}
        <div
            bind:this={panel}
            role="dialog"
            aria-modal="true"
            class="
                w-full max-h-[85vh]
                flex flex-col overflow-hidden
                bg-bg-secondary border border-border
                rounded-t-2xl md:rounded-2xl
                md:min-w-[420px] md:max-w-[90vw]
                shadow-xl p-2
                {isTop ? 'pointer-events-auto' : ''}
            "
            style={panelStyle}
            in:fly|global={{
                y: window.innerWidth <= 768 ? 100 : 20,
                duration: 300,
                easing: (t) =>
                    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
            }}
            out:fly|global={{
                y: window.innerWidth <= 768 ? 100 : 20,
                duration: 250,
                easing: (t) =>
                    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
            }}
            on:outroend={() => onOutroend?.()}
        >
            <svelte:component this={modal.component} {...modal.props} />
        </div>
    {/if}
</div>

<style>
    .fixed.inset-0 {
        pointer-events: none;
    }
    .fixed.inset-0 > div {
        pointer-events: none; /* all modals non‑interactive by default */
        transition:
            transform 0.2s ease,
            filter 0.2s ease; /* smooth visual changes */
    }
    .fixed.inset-0 > div.pointer-events-auto {
        pointer-events: auto; /* only the top modal receives clicks */
    }
</style>
