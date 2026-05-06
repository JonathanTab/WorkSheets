<script>
    import { onMount, onDestroy, tick } from "svelte";

    // 7 rows × 10 columns — one hue per column: red, orange, amber, lime, green, teal, sky, indigo, purple, pink
    // Shade levels use a logarithmic curve so dark/deep rows are visually well-separated
    // L%:  grayscale | base~55% | tint~93% | light-mid~78% | medium~58% | dark~34% | deep~15%
    const PALETTE = [
        ['#000000', '#333333', '#555555', '#777777', '#999999', '#BBBBBB', '#DDDDDD', '#EEEEEE', '#F5F5F5', '#FFFFFF'],
        ['#F44336', '#FF5722', '#FFC107', '#8BC34A', '#4CAF50', '#00BCD4', '#03A9F4', '#3F51B5', '#9C27B0', '#E91E63'],
        ['#FFEBEE', '#FBE9E7', '#FFF8E1', '#F9FBE7', '#E8F5E9', '#E0F7FA', '#E1F5FE', '#E8EAF6', '#F3E5F5', '#FCE4EC'],
        ['#EF9A9A', '#FFAB91', '#FFE082', '#DCE775', '#A5D6A7', '#80DEEA', '#81D4FA', '#9FA8DA', '#CE93D8', '#F48FB1'],
        ['#E57373', '#FF7043', '#FFD54F', '#C0CA33', '#66BB6A', '#26C6DA', '#29B6F6', '#5C6BC0', '#AB47BC', '#EC407A'],
        ['#C62828', '#D84315', '#CC8A00', '#558B2F', '#2E7D32', '#00838F', '#0277BD', '#283593', '#6A1B9A', '#AD1457'],
        ['#7A0000', '#7A2400', '#5C3D00', '#2D4700', '#1B3D22', '#00333D', '#012D4A', '#0D1257', '#2D0040', '#560026'],
    ];

    const RECENT_KEY = 'color-picker-recent';
    const MAX_RECENT = 10;

    let {
        label = "",
        value = "#000000",
        variant = "text", // "text" | "fill"
        onchange = undefined,
    } = $props();

    let open = $state(false);
    let buttonRef = $state(null);
    let panelRef = $state(null);
    let panelStyle = $state("position:fixed; left:-9999px; top:-9999px;");
    let recentColors = $state([]);
    let panelResizeObserver = null;
    let buttonResizeObserver = null;

    function loadRecents() {
        try { recentColors = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); }
        catch { recentColors = []; }
    }

    function addToRecents(color) {
        const next = [color, ...recentColors.filter(c => c.toLowerCase() !== color.toLowerCase())].slice(0, MAX_RECENT);
        recentColors = next;
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
    }

    function toggle() { open = !open; }

    function close({ restoreFocus = false } = {}) {
        open = false;
        if (restoreFocus) buttonRef?.focus();
    }

    function updatePanelPosition() {
        if (!open || !buttonRef) return;
        const margin = 8, gap = 6;
        const br = buttonRef.getBoundingClientRect();
        const pr = panelRef?.getBoundingClientRect();
        const panelWidth = pr?.width ?? 232;
        const panelHeight = pr?.height ?? 220;

        let left = br.left;
        let top = br.bottom + gap;

        if (left + panelWidth > window.innerWidth - margin) left = br.right - panelWidth;
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
        const color = e.target.value;
        addToRecents(color);
        onchange?.(color);
    }

    function handleClickOutside(e) {
        if (panelRef && !panelRef.contains(e.target) && buttonRef && !buttonRef.contains(e.target)) {
            close();
        }
    }

    function handleKeydown(e) {
        if (!open) return;
        if (e.key === "Escape") { e.stopPropagation(); close({ restoreFocus: true }); }
    }

    $effect(() => {
        if (!open) return;
        tick().then(() => {
            updatePanelPosition();
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
            panelResizeObserver?.disconnect(); panelResizeObserver = null;
            buttonResizeObserver?.disconnect(); buttonResizeObserver = null;
        };
    });

    onMount(() => {
        loadRecents();
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
                <svg viewBox="0 0 16 16" fill="none" class="picker-icon">
                    <path d="M2 5.5 L4 13 H12 L14 5.5 Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="currentColor" fill-opacity="0.13"/>
                    <line x1="2" y1="5.5" x2="14" y2="5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                    <path d="M5.5 5.5 Q8 1.5 10.5 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/>
                </svg>
            {:else}
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
            <div class="palette-grid">
                {#each PALETTE as row}
                    {#each row as color}
                        <button
                            class="swatch"
                            class:selected={color.toLowerCase() === value?.toLowerCase()}
                            style="background-color: {color}"
                            title={color}
                            aria-label={color}
                            onclick={() => handlePresetClick(color)}
                        ></button>
                    {/each}
                {/each}
            </div>

            {#if recentColors.length > 0}
                <div class="section-row">
                    <span class="section-label">Recent</span>
                </div>
                <div class="recent-grid">
                    {#each recentColors as color}
                        <button
                            class="swatch"
                            class:selected={color.toLowerCase() === value?.toLowerCase()}
                            style="background-color: {color}"
                            title={color}
                            aria-label={color}
                            onclick={() => handlePresetClick(color)}
                        ></button>
                    {/each}
                </div>
            {/if}

            <div class="custom-row">
                <span class="section-label">Custom</span>
                <input
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
        padding: 10px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.07);
        z-index: 1000;
        max-width: calc(100vw - 16px);
    }

    .palette-grid,
    .recent-grid {
        display: grid;
        grid-template-columns: repeat(10, 18px);
        gap: 3px;
    }

    .swatch {
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.1);
        transition: transform 0.1s ease, box-shadow 0.1s ease;
        position: relative;
    }

    .swatch:hover {
        transform: scale(1.25);
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.22);
        z-index: 1;
    }

    .swatch.selected::after {
        content: '';
        position: absolute;
        inset: -3px;
        border-radius: 5px;
        outline: 2px solid var(--color-primary, #3b82f6);
        pointer-events: none;
    }

    .section-row {
        display: flex;
        align-items: center;
        margin: 8px 0 5px;
        gap: 6px;
    }

    .section-row::before,
    .section-row::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--color-border);
    }

    .section-label {
        font-size: 0.625rem;
        font-weight: 500;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--color-text-muted);
        white-space: nowrap;
    }

    .custom-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--color-border);
    }

    .custom-input {
        -webkit-appearance: none;
        appearance: none;
        width: 26px;
        height: 20px;
        padding: 2px;
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        cursor: pointer;
    }

    .custom-input::-webkit-color-swatch-wrapper {
        padding: 0;
    }

    .custom-input::-webkit-color-swatch {
        border: none;
        border-radius: 2px;
    }
</style>
