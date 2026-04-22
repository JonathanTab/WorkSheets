<script>
    import { onMount, onDestroy, tick } from "svelte";

    let {
        label = "",
        value = "#000000",
        variant = "text", // "text" | "fill"
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
    let panelStyle = $state("position:fixed; left:-9999px; top:-9999px;");
    let panelResizeObserver = null;
    let buttonResizeObserver = null;

    function toggle() {
        open = !open;
    }

    function close({ restoreFocus = false } = {}) {
        open = false;
        if (restoreFocus) buttonRef?.focus();
    }

    function updatePanelPosition() {
        if (!open || !buttonRef) return;
        const margin = 8;
        const gap = 6;
        const br = buttonRef.getBoundingClientRect();
        const pr = panelRef?.getBoundingClientRect();
        const panelWidth = pr?.width ?? 210;
        const panelHeight = pr?.height ?? 154;

        let left = br.left;
        let top = br.bottom + gap;

        if (left + panelWidth > window.innerWidth - margin) {
            left = br.right - panelWidth;
        }
        if (left < margin) left = margin;

        if (top + panelHeight > window.innerHeight - margin) {
            const aboveTop = br.top - panelHeight - gap;
            top = aboveTop >= margin ? aboveTop : Math.max(margin, window.innerHeight - panelHeight - margin);
        }

        panelStyle = `position:fixed; left:${Math.round(left)}px; top:${Math.round(top)}px;`;
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
        if (!open) return;
        if (e.key === "Escape") {
            e.stopPropagation();
            close({ restoreFocus: true });
        }
    }

    $effect(() => {
        if (!open) return;
        tick().then(() => {
            updatePanelPosition();
            colorInputRef?.focus();
            if (!panelResizeObserver && panelRef) {
                panelResizeObserver = new ResizeObserver(() => updatePanelPosition());
                panelResizeObserver.observe(panelRef);
            }
            if (!buttonResizeObserver && buttonRef) {
                buttonResizeObserver = new ResizeObserver(() => updatePanelPosition());
                buttonResizeObserver.observe(buttonRef);
            }
        });
        return () => {
            panelResizeObserver?.disconnect();
            panelResizeObserver = null;
            buttonResizeObserver?.disconnect();
            buttonResizeObserver = null;
        };
    });

    onMount(() => {
        document.addEventListener("click", handleClickOutside);
        document.addEventListener("keydown", handleKeydown);
        window.addEventListener("resize", updatePanelPosition);
        window.addEventListener("scroll", updatePanelPosition, true);
        window.visualViewport?.addEventListener("resize", updatePanelPosition);
        window.visualViewport?.addEventListener("scroll", updatePanelPosition);
    });

    onDestroy(() => {
        document.removeEventListener("click", handleClickOutside);
        document.removeEventListener("keydown", handleKeydown);
        window.removeEventListener("resize", updatePanelPosition);
        window.removeEventListener("scroll", updatePanelPosition, true);
        window.visualViewport?.removeEventListener("resize", updatePanelPosition);
        window.visualViewport?.removeEventListener("scroll", updatePanelPosition);
    });
</script>

<div class="color-picker">
    <button
        bind:this={buttonRef}
        class="color-button"
        onclick={toggle}
        title={label}
    >
        <div class="icon-stack">
            {#if variant === "fill"}
                <!-- Paint bucket icon: wider at top (standard bucket shape) -->
                <svg viewBox="0 0 16 16" fill="none" class="picker-icon">
                    <path d="M2 5.5 L4 13 H12 L14 5.5 Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="currentColor" fill-opacity="0.13"/>
                    <line x1="2" y1="5.5" x2="14" y2="5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                    <path d="M5.5 5.5 Q8 1.5 10.5 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/>
                </svg>
            {:else}
                <!-- Text color "A" icon -->
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="picker-icon">
                    <path d="M2.5 13.5 8 2 13.5 13.5"/>
                    <path d="M4.8 9.5h6.4"/>
                </svg>
            {/if}
            <div class="color-bar" style="background-color: {value}"></div>
        </div>
        <svg viewBox="0 0 8 5" class="chevron" fill="currentColor">
            <path d="M0 0.5L4 4.5L8 0.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
        </svg>
    </button>

    {#if open}
        <div bind:this={panelRef} class="color-panel" style={panelStyle}>
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
        gap: 2px;
        padding: 0 5px;
        height: 30px;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--color-text-secondary);
        transition: background 0.08s, color 0.08s;
    }

    .color-button:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .color-button:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .icon-stack {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
    }

    .picker-icon {
        width: 16px;
        height: 14px;
        flex-shrink: 0;
    }

    .color-bar {
        width: 16px;
        height: 3px;
        border-radius: 1.5px;
        flex-shrink: 0;
    }

    .chevron {
        width: 7px;
        height: 5px;
        opacity: 0.45;
        flex-shrink: 0;
    }

    .color-panel {
        padding: 8px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
        z-index: 1000;
        max-width: calc(100vw - 16px);
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
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
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
        font-size: 0.6875rem;
        color: var(--color-text-muted);
    }

    .custom-input {
        width: 28px;
        height: 22px;
        padding: 0;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        cursor: pointer;
    }
</style>
