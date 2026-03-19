<script>
    import {
        modalStack,
        closeTopModal,
        pruneClosed,
    } from "./modalStore.svelte";
    import ModalWrapper from "./ModalWrapper.svelte";
    import { fade } from "svelte/transition";

    let previousActiveElement = null;

    function lockScroll() {
        document.body.style.overflow = "hidden";
    }

    function unlockScroll() {
        document.body.style.overflow = "";
    }

    $effect(() => {
        if (modalStack.length > 0) {
            previousActiveElement = document.activeElement;
            lockScroll();
        } else {
            unlockScroll();
            previousActiveElement?.focus?.();
        }
    });
</script>

{#if modalStack.some((m) => !m.closing)}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 bg-black/30"
        style="z-index: 2000"
        in:fade|global={{ duration: 150 }}
        out:fade|global={{ duration: 100 }}
        onclick={closeTopModal}
    ></div>
{/if}

{#each modalStack as modal, index (modal.id)}
    <ModalWrapper
        {modal}
        isTop={index === modalStack.length - 1}
        depth={modalStack.length - 1 - index}
        zIndex={2001 + index}
        onOutroend={pruneClosed}
    />
{/each}
