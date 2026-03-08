<script>
    let { value = "left", onchange = undefined } = $props();

    const alignments = [
        { id: "left", icon: "≡", label: "Align Left" },
        { id: "center", icon: "☰", label: "Align Center" },
        { id: "right", icon: "≡", label: "Align Right" },
    ];

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
            <span
                class="align-icon"
                class:centered={align.id === "center"}
                class:right={align.id === "right"}
            >
                {align.icon}
            </span>
        </button>
    {/each}
</div>

<style>
    .alignment-picker {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .align-button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--color-text-secondary);
    }

    .align-button:hover {
        background: var(--color-fill);
    }

    .align-button.selected {
        background: var(--color-primary-soft);
        color: var(--color-primary);
    }

    .align-icon {
        font-size: 1rem;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        width: 16px;
    }

    .align-icon.centered {
        justify-content: center;
    }

    .align-icon.right {
        justify-content: flex-end;
    }
</style>
