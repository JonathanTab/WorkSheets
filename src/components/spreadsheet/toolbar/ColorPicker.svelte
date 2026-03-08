<script>
    import { onMount, onDestroy } from "svelte";

    let {
        label = "",
        value = "#000000",
        onchange = undefined,
        presetColors = [
            "#000000",
            "#434343",
            "#666666",
            "#999999",
            "#b7b7b7",
            "#cccccc",
            "#d9d9d9",
            "#efefef",
            "#f3f3f3",
            "#ffffff",
            "#980000",
            "#ff0000",
            "#ff9900",
            "#ffff00",
            "#00ff00",
            "#00ffff",
            "#4a86e8",
            "#0000ff",
            "#9900ff",
            "#ff00ff",
        ],
    } = $props();

    let open = $state(false);
    let buttonRef = $state(null);
    let panelRef = $state(null);
    let colorInputRef = $state(null);

    function toggle() {
        open = !open;
    }

    function close() {
        open = false;
    }

    function handlePresetClick(color) {
        onchange?.(color);
        close();
    }

    function handleColorInputChange(e) {
        onchange?.(e.target.value);
    }

    function handleClickOutside(e) {
        if (
            panelRef &&
            !panelRef.contains(e.target) &&
            buttonRef &&
            !buttonRef.contains(e.target)
        ) {
            close();
        }
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            close();
        }
    }

    onMount(() => {
        document.addEventListener("click", handleClickOutside);
        document.addEventListener("keydown", handleKeydown);
    });

    onDestroy(() => {
        document.removeEventListener("click", handleClickOutside);
        document.removeEventListener("keydown", handleKeydown);
    });
</script>

<div class="color-picker">
    <button
        bind:this={buttonRef}
        class="color-button"
        onclick={toggle}
        title={label}
    >
        <div class="color-swatch" style="background-color: {value}"></div>
        <span class="arrow">▾</span>
    </button>

    {#if open}
        <div bind:this={panelRef} class="color-panel">
            <div class="preset-grid">
                {#each presetColors as color}
                    <button
                        class="preset-color"
                        class:selected={color === value}
                        style="background-color: {color}"
                        onclick={() => handlePresetClick(color)}
                    >
                    </button>
                {/each}
            </div>
            <div class="custom-section">
                <label class="custom-label">Custom:</label>
                <input
                    bind:this={colorInputRef}
                    type="color"
                    class="custom-input"
                    {value}
                    onchange={handleColorInputChange}
                />
            </div>
        </div>
    {/if}
</div>

<style>
    .color-picker {
        position: relative;
    }

    .color-button {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 4px;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
    }

    .color-button:hover {
        background: var(--color-fill);
    }

    .color-swatch {
        width: 18px;
        height: 18px;
        border: 1px solid var(--color-border);
        border-radius: 3px;
    }

    .arrow {
        font-size: 0.5rem;
        opacity: 0.6;
    }

    .color-panel {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: 4px;
        padding: 8px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 1000;
    }

    .preset-grid {
        display: grid;
        grid-template-columns: repeat(10, 1fr);
        gap: 2px;
    }

    .preset-color {
        width: 16px;
        height: 16px;
        padding: 0;
        border: 1px solid var(--color-border);
        border-radius: 2px;
        cursor: pointer;
    }

    .preset-color:hover {
        transform: scale(1.1);
    }

    .preset-color.selected {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .custom-section {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--color-border);
    }

    .custom-label {
        font-size: 0.75rem;
        color: var(--color-text-tertiary);
    }

    .custom-input {
        width: 32px;
        height: 24px;
        padding: 0;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        cursor: pointer;
    }
</style>
