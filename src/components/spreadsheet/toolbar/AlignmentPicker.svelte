<script>
    import {
        alignLeft,
        alignCenter,
        alignRight,
        alignTop,
        alignMiddle,
        alignBottom,
    } from "../../../lib/icons/index.js";

    let { value = "left", onchange = undefined, vertical = false } = $props();

    const hAlignments = [
        { id: "left", icon: alignLeft, label: "Align Left" },
        { id: "center", icon: alignCenter, label: "Align Center" },
        { id: "right", icon: alignRight, label: "Align Right" },
    ];

    const vAlignments = [
        { id: "top", icon: alignTop, label: "Align Top" },
        { id: "middle", icon: alignMiddle, label: "Align Middle" },
        { id: "bottom", icon: alignBottom, label: "Align Bottom" },
    ];

    let alignments = $derived(vertical ? vAlignments : hAlignments);

    function handleSelect(alignId) {
        onchange?.(alignId);
    }
</script>

<div class="alignment-picker">
    {#each alignments as align}
        <button
            class="align-button"
            class:selected={value === align.id}
            onclick={() => handleSelect(align.id)}
            title={align.label}
        >
            <span class="align-icon">
                {@html align.icon}
            </span>
        </button>
    {/each}
</div>

<style>
    .alignment-picker {
        display: flex;
        align-items: center;
        gap: 1px;
    }

    .align-button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--color-text-secondary);
        transition: all 0.08s ease;
    }

    .align-button:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .align-button.selected {
        background: var(--color-primary-soft);
        color: var(--color-primary);
    }

    .align-button:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .align-icon {
        font-size: 0.875rem;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        width: 14px;
    }

    .align-icon.centered {
        justify-content: center;
    }

    .align-icon.right {
        justify-content: flex-end;
    }
</style>
