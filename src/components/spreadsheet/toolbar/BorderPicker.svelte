<script>
    import { onMount, onDestroy, tick } from "svelte";
    import ColorPicker from "./ColorPicker.svelte";

    let {
        onchange = undefined,
        selectionRange = null,
    } = $props();

    // Current border settings
    let currentColor = $state("#000000");
    let currentWidth = $state(1);
    let currentStyle = $state("solid"); // "solid" | "dashed" | "double"
    let clearMode = $state(false); // When true, clicking a position removes borders

    // Style presets (shown as a row of icons)
    const stylePresets = [
        { id: "thin",   style: "solid",  width: 1, label: "Thin" },
        { id: "medium", style: "solid",  width: 2, label: "Medium" },
        { id: "thick",  style: "solid",  width: 3, label: "Thick" },
        { id: "dashed", style: "dashed", width: 1, label: "Dashed" },
        { id: "double", style: "double", width: 1, label: "Double" },
    ];

    let selectedPreset = $state("thin");

    // Border position definitions (9-button grid, no "none")
    const borderPositions = [
        { id: "all",        label: "All",     description: "All borders" },
        { id: "outside",    label: "Outside", description: "Border around selection" },
        { id: "inside",     label: "Inside",  description: "Borders inside selection" },
        { id: "top",        label: "Top",     description: "Top border" },
        { id: "bottom",     label: "Bottom",  description: "Bottom border" },
        { id: "left",       label: "Left",    description: "Left border" },
        { id: "right",      label: "Right",   description: "Right border" },
        { id: "horizontal", label: "Horiz",   description: "Horizontal inner borders" },
        { id: "vertical",   label: "Vert",    description: "Vertical inner borders" },
    ];

    let open = $state(false);
    let buttonRef = $state(null);
    let panelRef = $state(null);
    let panelStyle = $state("position:fixed; left:-9999px; top:-9999px;");
    let panelResizeObserver = null;
    let buttonResizeObserver = null;

    function toggle() { open = !open; }

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
        const panelWidth = pr?.width ?? 236;
        const panelHeight = pr?.height ?? 320;

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

    function handleColorChange(color) {
        currentColor = color;
        clearMode = false;
    }

    function toggleClearMode() {
        clearMode = !clearMode;
    }

    function selectPreset(preset) {
        selectedPreset = preset.id;
        currentStyle = preset.style;
        currentWidth = preset.width;
        clearMode = false;
    }

    function buildEdges(positionId) {
        if (!selectionRange) return [];
        const { startRow, endRow, startCol, endCol } = selectionRange;
        const edges = [];

        const addTopEdge    = () => { for (let c = startCol; c <= endCol; c++) edges.push(`h,${startRow - 1},${c}`); };
        const addBottomEdge = () => { for (let c = startCol; c <= endCol; c++) edges.push(`h,${endRow},${c}`); };
        const addLeftEdge   = () => { for (let r = startRow; r <= endRow; r++) edges.push(`v,${r},${startCol - 1}`); };
        const addRightEdge  = () => { for (let r = startRow; r <= endRow; r++) edges.push(`v,${r},${endCol}`); };
        const addInnerH     = () => {
            for (let r = startRow; r < endRow; r++)
                for (let c = startCol; c <= endCol; c++) edges.push(`h,${r},${c}`);
        };
        const addInnerV     = () => {
            for (let r = startRow; r <= endRow; r++)
                for (let c = startCol; c < endCol; c++) edges.push(`v,${r},${c}`);
        };

        switch (positionId) {
            case "all":        addTopEdge(); addBottomEdge(); addLeftEdge(); addRightEdge(); addInnerH(); addInnerV(); break;
            case "outside":    addTopEdge(); addBottomEdge(); addLeftEdge(); addRightEdge(); break;
            case "inside":     addInnerH(); addInnerV(); break;
            case "horizontal": addInnerH(); break;
            case "vertical":   addInnerV(); break;
            case "top":        addTopEdge(); break;
            case "bottom":     addBottomEdge(); break;
            case "left":       addLeftEdge(); break;
            case "right":      addRightEdge(); break;
        }
        return edges;
    }

    function handlePositionClick(positionId) {
        if (!selectionRange) return;
        const edges = buildEdges(positionId);
        const borderStyle = clearMode ? null : { style: currentStyle, width: currentWidth, color: currentColor };
        onchange?.(edges.map(edgeKey => ({ edgeKey, style: borderStyle })));
        // Panel stays open — user may apply more positions
    }

    function handleClearAll() {
        if (!selectionRange) return;
        const { startRow, endRow, startCol, endCol } = selectionRange;
        onchange?.([{ type: "clear-range", startRow, endRow, startCol, endCol }]);
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
            panelRef?.querySelector(".position-btn")?.focus();
        });
        return () => {
            panelResizeObserver?.disconnect(); panelResizeObserver = null;
            buttonResizeObserver?.disconnect(); buttonResizeObserver = null;
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

<div class="border-picker">
    <button bind:this={buttonRef} class="border-button" onclick={toggle} title="Borders">
        <div class="border-icon">
            <svg width="16" height="16" viewBox="0 0 16 16">
                <!-- outer border -->
                <rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.25"/>
                <!-- inner cross -->
                <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" stroke-width="1.25"/>
                <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.25"/>
            </svg>
        </div>
        <span class="arrow">▾</span>
    </button>

    {#if open}
        <div bind:this={panelRef} class="border-panel" style={panelStyle}>

            <!-- Color row -->
            <div class="setting-row">
                <span class="setting-label">Color</span>
                <div class="setting-controls">
                    <ColorPicker label="Border Color" value={currentColor} onchange={handleColorChange} />
                    <button
                        class="no-border-btn"
                        class:active={clearMode}
                        onclick={toggleClearMode}
                        title="No border — click a position to erase those edges"
                    >
                        <svg width="14" height="14" viewBox="0 0 14 14">
                            <!-- Eraser-style X through a small box -->
                            <rect x="1.5" y="1.5" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2,2" opacity="0.5"/>
                            <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.5"/>
                            <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.5"/>
                        </svg>
                        <span>No border</span>
                    </button>
                </div>
            </div>

            <!-- Style row -->
            <div class="setting-row">
                <span class="setting-label">Style</span>
                <div class="setting-controls style-presets">
                    {#each stylePresets as preset}
                        <button
                            class="style-preset-btn"
                            class:selected={selectedPreset === preset.id && !clearMode}
                            onclick={() => selectPreset(preset)}
                            title={preset.label}
                        >
                            <svg width="32" height="10" viewBox="0 0 32 10">
                                {#if preset.style === "double"}
                                    <line x1="2" y1="3.5" x2="30" y2="3.5" stroke="currentColor" stroke-width="1"/>
                                    <line x1="2" y1="6.5" x2="30" y2="6.5" stroke="currentColor" stroke-width="1"/>
                                {:else if preset.style === "dashed"}
                                    <line x1="2" y1="5" x2="30" y2="5" stroke="currentColor" stroke-width="{preset.width}" stroke-dasharray="4,3"/>
                                {:else}
                                    <line x1="2" y1="5" x2="30" y2="5" stroke="currentColor" stroke-width="{preset.width}"/>
                                {/if}
                            </svg>
                        </button>
                    {/each}
                </div>
            </div>

            <div class="divider"></div>

            <!-- Position grid (3 columns, 3 rows) -->
            <div class="position-grid">
                {#each borderPositions as pos}
                    <button
                        class="position-btn"
                            onclick={() => handlePositionClick(pos.id)}
                        title={pos.description}
                    >
                        <div class="pos-icon">
                            {#if pos.id === "all"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"/>
                                    <line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.5"/>
                                    <line x1="10" y1="3" x2="10" y2="17" stroke="currentColor" stroke-width="1.5"/>
                                </svg>
                            {:else if pos.id === "outside"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"/>
                                </svg>
                            {:else if pos.id === "inside"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.3"/>
                                    <line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.5"/>
                                    <line x1="10" y1="3" x2="10" y2="17" stroke="currentColor" stroke-width="1.5"/>
                                </svg>
                            {:else if pos.id === "top"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.3"/>
                                    <line x1="3" y1="4" x2="17" y2="4" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            {:else if pos.id === "bottom"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.3"/>
                                    <line x1="3" y1="16" x2="17" y2="16" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            {:else if pos.id === "left"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.3"/>
                                    <line x1="4" y1="3" x2="4" y2="17" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            {:else if pos.id === "right"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.3"/>
                                    <line x1="16" y1="3" x2="16" y2="17" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            {:else if pos.id === "horizontal"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.3"/>
                                    <line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.5"/>
                                </svg>
                            {:else if pos.id === "vertical"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.3"/>
                                    <line x1="10" y1="3" x2="10" y2="17" stroke="currentColor" stroke-width="1.5"/>
                                </svg>
                            {/if}
                        </div>
                        <span class="pos-label">{pos.label}</span>
                    </button>
                {/each}
            </div>

            <!-- Clear all borders (full width) -->
            <button class="clear-all-btn" onclick={handleClearAll} title="Remove all borders from selection">
                <svg width="14" height="14" viewBox="0 0 14 14">
                    <rect x="1.5" y="1.5" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2,2" opacity="0.6"/>
                </svg>
                Clear borders
            </button>
        </div>
    {/if}
</div>

<style>
    .border-picker { position: relative; }

    .border-button {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 3px 4px;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
    }
    .border-button:hover { background: var(--color-fill); }
    .border-button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }

    .border-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-secondary);
    }
    .arrow { font-size: 0.5rem; opacity: 0.4; }

    .border-panel {
        padding: 10px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
        z-index: 1000;
        min-width: 210px;
        max-width: calc(100vw - 16px);
    }

    /* ── Setting rows (color + style) ── */
    .setting-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }
    .setting-label {
        font-size: 0.6875rem;
        color: var(--color-text-muted);
        width: 32px;
        flex-shrink: 0;
    }
    .setting-controls {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    /* No-border toggle */
    .no-border-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.6875rem;
        color: var(--color-text-secondary);
        transition: background 0.08s, border-color 0.08s, color 0.08s;
    }
    .no-border-btn:hover { background: var(--color-fill); }
    .no-border-btn.active {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: #fff;
    }
    .no-border-btn.active svg { color: #fff; }

    /* Style presets row */
    .style-presets { gap: 2px; }
    .style-preset-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 3px 4px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        cursor: pointer;
        color: var(--color-text-secondary);
        transition: background 0.08s, border-color 0.08s;
    }
    .style-preset-btn:hover { background: var(--color-fill); }
    .style-preset-btn.selected {
        border-color: var(--color-primary);
        background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    }

    .divider { height: 1px; background: var(--color-border); margin: 8px 0; }

    /* Position grid */
    .position-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 2px;
        margin-bottom: 6px;
    }

    .position-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 6px 4px;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.08s;
    }
    .position-btn:hover { background: var(--color-fill); }
    .position-btn:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }

    .pos-icon {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: inherit;
    }
    .pos-label {
        font-size: 0.5625rem;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.02em;
    }

    /* Clear all button */
    .clear-all-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        width: 100%;
        padding: 5px 8px;
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.6875rem;
        color: var(--color-text-secondary);
        transition: background 0.08s, border-color 0.08s;
    }
    .clear-all-btn:hover {
        background: var(--color-fill);
        border-color: var(--color-border-strong);
    }
    .clear-all-btn:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
