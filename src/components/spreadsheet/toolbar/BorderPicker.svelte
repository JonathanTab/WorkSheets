<script>
    import { onMount, onDestroy } from "svelte";
    import ColorPicker from "./ColorPicker.svelte";

    let {
        value = null,
        onchange = undefined,
        selectionRange = null,
    } = $props();

    // Current border settings (color and thickness)
    let currentColor = $state("#000000");
    let currentWidth = $state(1);

    // Border style
    const defaultBorderStyle = () => ({
        style: "solid",
        width: currentWidth,
        color: currentColor,
    });

    // Border type definitions
    const borderTypes = [
        {
            id: "none",
            label: "None",
            icon: "none",
            description: "Remove all borders",
        },
        {
            id: "outside",
            label: "Outside",
            icon: "outside",
            description: "Border around selection",
        },
        {
            id: "inside",
            label: "Inside",
            icon: "inside",
            description: "Borders inside selection",
        },
        {
            id: "horizontal",
            label: "Horizontal",
            icon: "horizontal",
            description: "Horizontal inner borders",
        },
        {
            id: "vertical",
            label: "Vertical",
            icon: "vertical",
            description: "Vertical inner borders",
        },
        {
            id: "top",
            label: "Top",
            icon: "top",
            description: "Top border of selection",
        },
        {
            id: "bottom",
            label: "Bottom",
            icon: "bottom",
            description: "Bottom border of selection",
        },
        {
            id: "left",
            label: "Left",
            icon: "left",
            description: "Left border of selection",
        },
        {
            id: "right",
            label: "Right",
            icon: "right",
            description: "Right border of selection",
        },
    ];

    let open = $state(false);
    let buttonRef = $state(null);
    let panelRef = $state(null);

    // Width options
    const widthOptions = [
        { value: 1, label: "1pt" },
        { value: 2, label: "2pt" },
        { value: 3, label: "3pt" },
        { value: 4, label: "4pt" },
        { value: 5, label: "5pt" },
    ];

    function toggle() {
        open = !open;
    }

    function close() {
        open = false;
    }

    function handleBorderColorChange(color) {
        currentColor = color;
    }

    function handleWidthChange(e) {
        currentWidth = parseInt(e.target.value, 10);
    }

    /**
     * Apply a border type to the selection
     * This returns edge-based instructions for borders
     * Edge keys: "h,row,col" = horizontal edge below cell(row,col)
     *           "v,row,col" = vertical edge right of cell(row,col)
     */
    function handleBorderTypeClick(borderType) {
        if (!selectionRange) {
            close();
            return;
        }

        const { startRow, endRow, startCol, endCol } = selectionRange;
        const borderStyle = defaultBorderStyle();

        // Build edge-based border instructions
        const borderInstructions = [];

        if (borderType.id === "none") {
            // Clear all borders in range - pass a special instruction
            borderInstructions.push({
                type: "clear-range",
                startRow,
                endRow,
                startCol,
                endCol,
            });
        } else if (borderType.id === "outside") {
            // Top edge (horizontal edge above startRow)
            for (let c = startCol; c <= endCol; c++) {
                borderInstructions.push({
                    edgeKey: `h,${startRow - 1},${c}`,
                    style: { ...borderStyle },
                });
            }
            // Bottom edge (horizontal edge below endRow)
            for (let c = startCol; c <= endCol; c++) {
                borderInstructions.push({
                    edgeKey: `h,${endRow},${c}`,
                    style: { ...borderStyle },
                });
            }
            // Left edge (vertical edge left of startCol)
            for (let r = startRow; r <= endRow; r++) {
                borderInstructions.push({
                    edgeKey: `v,${r},${startCol - 1}`,
                    style: { ...borderStyle },
                });
            }
            // Right edge (vertical edge right of endCol)
            for (let r = startRow; r <= endRow; r++) {
                borderInstructions.push({
                    edgeKey: `v,${r},${endCol}`,
                    style: { ...borderStyle },
                });
            }
        } else if (borderType.id === "inside") {
            // Horizontal edges between rows (not on outside)
            for (let r = startRow; r < endRow; r++) {
                for (let c = startCol; c <= endCol; c++) {
                    borderInstructions.push({
                        edgeKey: `h,${r},${c}`,
                        style: { ...borderStyle },
                    });
                }
            }
            // Vertical edges between columns (not on outside)
            for (let r = startRow; r <= endRow; r++) {
                for (let c = startCol; c < endCol; c++) {
                    borderInstructions.push({
                        edgeKey: `v,${r},${c}`,
                        style: { ...borderStyle },
                    });
                }
            }
        } else if (borderType.id === "horizontal") {
            // Horizontal edges between rows only
            for (let r = startRow; r < endRow; r++) {
                for (let c = startCol; c <= endCol; c++) {
                    borderInstructions.push({
                        edgeKey: `h,${r},${c}`,
                        style: { ...borderStyle },
                    });
                }
            }
        } else if (borderType.id === "vertical") {
            // Vertical edges between columns only
            for (let r = startRow; r <= endRow; r++) {
                for (let c = startCol; c < endCol; c++) {
                    borderInstructions.push({
                        edgeKey: `v,${r},${c}`,
                        style: { ...borderStyle },
                    });
                }
            }
        } else if (borderType.id === "top") {
            // Top edge only (horizontal edge above startRow)
            for (let c = startCol; c <= endCol; c++) {
                borderInstructions.push({
                    edgeKey: `h,${startRow - 1},${c}`,
                    style: { ...borderStyle },
                });
            }
        } else if (borderType.id === "bottom") {
            // Bottom edge only (horizontal edge below endRow)
            for (let c = startCol; c <= endCol; c++) {
                borderInstructions.push({
                    edgeKey: `h,${endRow},${c}`,
                    style: { ...borderStyle },
                });
            }
        } else if (borderType.id === "left") {
            // Left edge only (vertical edge left of startCol)
            for (let r = startRow; r <= endRow; r++) {
                borderInstructions.push({
                    edgeKey: `v,${r},${startCol - 1}`,
                    style: { ...borderStyle },
                });
            }
        } else if (borderType.id === "right") {
            // Right edge only (vertical edge right of endCol)
            for (let r = startRow; r <= endRow; r++) {
                borderInstructions.push({
                    edgeKey: `v,${r},${endCol}`,
                    style: { ...borderStyle },
                });
            }
        }

        // Call onchange with the border instructions
        onchange?.(borderInstructions);
        close();
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

<div class="border-picker">
    <button
        bind:this={buttonRef}
        class="border-button"
        onclick={toggle}
        title="Borders"
    >
        <div class="border-icon">
            <svg width="16" height="16" viewBox="0 0 16 16">
                <rect
                    x="2"
                    y="2"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1"
                />
            </svg>
        </div>
        <span class="arrow">▾</span>
    </button>

    {#if open}
        <div bind:this={panelRef} class="border-panel">
            <!-- Color and Width Controls -->
            <div class="border-controls">
                <div class="control-group">
                    <label>Color:</label>
                    <ColorPicker
                        label="Border Color"
                        value={currentColor}
                        onchange={handleBorderColorChange}
                    />
                </div>
                <div class="control-group">
                    <label>Width:</label>
                    <select
                        class="width-select"
                        value={currentWidth}
                        onchange={handleWidthChange}
                    >
                        {#each widthOptions as opt}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </select>
                </div>
            </div>

            <div class="divider"></div>

            <!-- Border Type Buttons -->
            <div class="border-type-grid">
                {#each borderTypes as borderType}
                    <button
                        class="border-type-button"
                        onclick={() => handleBorderTypeClick(borderType)}
                        title={borderType.description}
                    >
                        <div class="border-type-icon">
                            {#if borderType.icon === "none"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="1"
                                        stroke-dasharray="2,2"
                                        opacity="0.5"
                                    />
                                </svg>
                            {:else if borderType.icon === "outside"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                    />
                                </svg>
                            {:else if borderType.icon === "inside"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="0.5"
                                        stroke-dasharray="2,2"
                                        opacity="0.3"
                                    />
                                    <line
                                        x1="3"
                                        y1="10"
                                        x2="17"
                                        y2="10"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                    />
                                    <line
                                        x1="10"
                                        y1="3"
                                        x2="10"
                                        y2="17"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                    />
                                </svg>
                            {:else if borderType.icon === "horizontal"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="0.5"
                                        stroke-dasharray="2,2"
                                        opacity="0.3"
                                    />
                                    <line
                                        x1="3"
                                        y1="10"
                                        x2="17"
                                        y2="10"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                    />
                                </svg>
                            {:else if borderType.icon === "vertical"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="0.5"
                                        stroke-dasharray="2,2"
                                        opacity="0.3"
                                    />
                                    <line
                                        x1="10"
                                        y1="3"
                                        x2="10"
                                        y2="17"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                    />
                                </svg>
                            {:else if borderType.icon === "top"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="0.5"
                                        stroke-dasharray="2,2"
                                        opacity="0.3"
                                    />
                                    <line
                                        x1="3"
                                        y1="4"
                                        x2="17"
                                        y2="4"
                                        stroke="currentColor"
                                        stroke-width="2"
                                    />
                                </svg>
                            {:else if borderType.icon === "bottom"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="0.5"
                                        stroke-dasharray="2,2"
                                        opacity="0.3"
                                    />
                                    <line
                                        x1="3"
                                        y1="16"
                                        x2="17"
                                        y2="16"
                                        stroke="currentColor"
                                        stroke-width="2"
                                    />
                                </svg>
                            {:else if borderType.icon === "left"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="0.5"
                                        stroke-dasharray="2,2"
                                        opacity="0.3"
                                    />
                                    <line
                                        x1="4"
                                        y1="3"
                                        x2="4"
                                        y2="17"
                                        stroke="currentColor"
                                        stroke-width="2"
                                    />
                                </svg>
                            {:else if borderType.icon === "right"}
                                <svg width="20" height="20" viewBox="0 0 20 20">
                                    <rect
                                        x="3"
                                        y="3"
                                        width="14"
                                        height="14"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="0.5"
                                        stroke-dasharray="2,2"
                                        opacity="0.3"
                                    />
                                    <line
                                        x1="16"
                                        y1="3"
                                        x2="16"
                                        y2="17"
                                        stroke="currentColor"
                                        stroke-width="2"
                                    />
                                </svg>
                            {/if}
                        </div>
                        <span class="border-type-label">{borderType.label}</span
                        >
                    </button>
                {/each}
            </div>
        </div>
    {/if}
</div>

<style>
    .border-picker {
        position: relative;
    }

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

    .border-button:hover {
        background: var(--color-fill);
    }

    .border-button:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .border-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-secondary);
    }

    .arrow {
        font-size: 0.5rem;
        opacity: 0.4;
    }

    .border-panel {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: 2px;
        padding: 10px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow:
            0 1px 3px rgba(0, 0, 0, 0.08),
            0 4px 12px rgba(0, 0, 0, 0.12);
        z-index: 1000;
        min-width: 200px;
    }

    .border-controls {
        display: flex;
        gap: 12px;
        margin-bottom: 8px;
    }

    .control-group {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .control-group label {
        font-size: 0.6875rem;
        color: var(--color-text-muted);
    }

    .width-select {
        height: 22px;
        padding: 0 4px;
        font-size: 0.6875rem;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
        cursor: pointer;
    }

    .width-select:hover {
        border-color: var(--color-border-strong);
    }

    .width-select:focus {
        outline: none;
        border-color: var(--color-primary);
    }

    .divider {
        height: 1px;
        background: var(--color-border);
        margin: 8px 0;
    }

    .border-type-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 2px;
    }

    .border-type-button {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 6px 4px;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        text-align: center;
        transition: background 0.08s ease;
    }

    .border-type-button:hover {
        background: var(--color-fill);
    }

    .border-type-button:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .border-type-icon {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-secondary);
    }

    .border-type-label {
        font-size: 0.5625rem;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.02em;
    }
</style>
