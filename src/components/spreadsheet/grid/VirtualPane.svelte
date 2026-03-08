<script>
    /**
     * VirtualPane - Generic Pane Renderer
     *
     * Renders a single pane (corner, top, left, body) using:
     * - a clipped outer container (fixed in viewport)
     * - a translated inner content layer (scroll transform)
     * - absolute row positioning relative to the pane range start
     */

    import { PANE } from "../../../stores/spreadsheet/virtualization/types.js";

    let {
        paneType = PANE.BODY,
        rowRange = { start: 0, end: -1, count: 0 },
        colRange = { start: 0, end: -1, count: 0 },
        rowMetrics,
        colMetrics,
        sheetStore,
        session,
        selectionState,
        formulaEditState,
        originX = 0,
        originY = 0,
        clipWidth = 0,
        clipHeight = 0,
        offsetX = 0,
        offsetY = 0,
        children = null,
        onCellMouseDown,
        onCellMouseEnter,
        onCellDoubleClick,
        onCellContextMenu,
    } = $props();

    let rowBaseOffset = $derived(
        rowRange.count > 0 ? (rowMetrics?.offsetOf(rowRange.start) ?? 0) : 0,
    );
    let colBaseOffset = $derived(
        colRange.count > 0 ? (colMetrics?.offsetOf(colRange.start) ?? 0) : 0,
    );

    let contentWidth = $derived(
        colRange.count > 0
            ? (colMetrics?.offsetOf(colRange.end + 1) ?? 0) - colBaseOffset
            : 0,
    );
    let contentHeight = $derived(
        rowRange.count > 0
            ? (rowMetrics?.offsetOf(rowRange.end + 1) ?? 0) - rowBaseOffset
            : 0,
    );

    function isSelected(row, col) {
        const selection = selectionState?.range;
        if (!selection) return false;
        return (
            row >= selection.startRow &&
            row <= selection.endRow &&
            col >= selection.startCol &&
            col <= selection.endCol
        );
    }

    function isAnchor(row, col) {
        const anchor = selectionState?.anchor;
        return anchor?.row === row && anchor?.col === col;
    }

    function getCellHighlightColor(row, col) {
        return formulaEditState?.getCellHighlightColor(row, col);
    }

    function isCellHighlighted(row, col) {
        return formulaEditState?.isCellReferenced(row, col);
    }

    function buildCellStyle(cell) {
        if (!cell || !cell.exists) return "";
        const styles = [];
        if (cell.fontFamily) styles.push(`font-family: ${cell.fontFamily}`);
        if (cell.fontSize) styles.push(`font-size: ${cell.fontSize}px`);
        if (cell.bold) styles.push("font-weight: bold");
        if (cell.italic) styles.push("font-style: italic");
        const textDecorations = [];
        if (cell.underline) textDecorations.push("underline");
        if (cell.strikethrough) textDecorations.push("line-through");
        if (textDecorations.length > 0) {
            styles.push(`text-decoration: ${textDecorations.join(" ")}`);
        }
        if (cell.color) styles.push(`color: ${cell.color}`);
        return styles.join("; ");
    }

    function buildCellContainerStyle(cell, row, col) {
        const styles = [];

        if (cell?.exists) {
            if (cell.backgroundColor) {
                styles.push(`background-color: ${cell.backgroundColor}`);
            }
            if (cell.horizontalAlign) {
                styles.push(`justify-content: ${cell.horizontalAlign}`);
            }
        }

        if (sheetStore) {
            const borders = sheetStore.getCellBorders(row, col);
            if (borders.top) {
                styles.push(
                    `border-top: ${borders.top.width}px ${borders.top.style} ${borders.top.color}`,
                );
            }
            if (borders.right) {
                styles.push(
                    `border-right: ${borders.right.width}px ${borders.right.style} ${borders.right.color}`,
                );
            }
            if (borders.bottom) {
                styles.push(
                    `border-bottom: ${borders.bottom.width}px ${borders.bottom.style} ${borders.bottom.color}`,
                );
            }
            if (borders.left) {
                styles.push(
                    `border-left: ${borders.left.width}px ${borders.left.style} ${borders.left.color}`,
                );
            }
        }

        return styles.join("; ");
    }

    let rowIndices = $derived.by(() => {
        const result = [];
        for (let row = rowRange.start; row <= rowRange.end; row++) {
            result.push(row);
        }
        return result;
    });

    let colIndices = $derived.by(() => {
        const result = [];
        for (let col = colRange.start; col <= colRange.end; col++) {
            result.push(col);
        }
        return result;
    });

    let clipStyle = $derived(
        `left:${originX}px; top:${originY}px; width:${clipWidth}px; height:${clipHeight}px;`,
    );

    let innerStyle = $derived.by(() => {
        const relX = offsetX - colBaseOffset;
        const relY = offsetY - rowBaseOffset;
        return `transform: translate(${-relX}px, ${-relY}px); width:${contentWidth}px; height:${contentHeight}px;`;
    });
</script>

{#if rowRange.count > 0 && colRange.count > 0 && clipWidth > 0 && clipHeight > 0}
    <div class="pane-clip pane-{paneType}" style={clipStyle}>
        <div class="pane-inner" style={innerStyle}>
            {#each rowIndices as row (row)}
                {@const rowTop = rowMetrics.offsetOf(row) - rowBaseOffset}
                {@const rowHeight = rowMetrics.sizeOf(row)}
                <div class="row" style="top:{rowTop}px; height:{rowHeight}px;">
                    {#each colIndices as col (col)}
                        {@const cell = sheetStore?.getCell(row, col)}
                        {@const displayValue = session?.getCellDisplayValue(
                            row,
                            col,
                        )}
                        {@const selected = isSelected(row, col)}
                        {@const isAnchorCell = isAnchor(row, col)}
                        {@const cellContainerStyle = buildCellContainerStyle(
                            cell,
                            row,
                            col,
                        )}
                        {@const cellTextStyle = buildCellStyle(cell)}
                        {@const highlightColor = getCellHighlightColor(
                            row,
                            col,
                        )}
                        {@const isHighlighted = isCellHighlighted(row, col)}
                        {@const colWidth = colMetrics.sizeOf(col)}

                        <div
                            class="cell"
                            class:selected
                            class:anchor={isAnchorCell}
                            class:formula-highlighted={isHighlighted}
                            style="width: {colWidth}px; {cellContainerStyle}; {highlightColor
                                ? `--highlight-color: ${highlightColor}`
                                : ''}"
                            onmousedown={(e) => onCellMouseDown?.(row, col, e)}
                            onmouseenter={() => onCellMouseEnter?.(row, col)}
                            ondblclick={() => onCellDoubleClick?.(row, col)}
                            oncontextmenu={(e) =>
                                onCellContextMenu?.(row, col, e)}
                            role="gridcell"
                            tabindex="-1"
                        >
                            <span class="cell-content" style={cellTextStyle}>
                                {displayValue}
                            </span>
                        </div>
                    {/each}
                </div>
            {/each}

            <div class="pane-slot-layer">
                {#if children}
                    {@render children()}
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .pane-clip {
        position: absolute;
        overflow: hidden;
        contain: strict;
        pointer-events: auto;
    }

    .pane-body {
        z-index: 10;
    }

    .pane-top,
    .pane-left {
        z-index: 15;
    }

    .pane-corner {
        z-index: 20;
    }

    .pane-inner {
        position: relative;
        will-change: transform;
    }

    .row {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
    }

    .cell {
        height: 100%;
        border-right: 1px solid var(--cell-border, #e2e8f0);
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        padding: 0 4px;
        display: flex;
        align-items: center;
        overflow: hidden;
        cursor: cell;
        background: var(--cell-bg, #ffffff);
        contain: content;
        flex-shrink: 0;
    }

    .cell:hover {
        background: var(--cell-hover, #f8fafc);
    }

    .cell.selected {
        box-shadow: inset 0 0 0 9999px
            color-mix(in srgb, var(--cell-selected, #dbeafe) 40%, transparent);
    }

    .cell.anchor {
        outline: 2px solid var(--anchor-border, #3b82f6);
        outline-offset: -1px;
    }

    .cell-content {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .cell.formula-highlighted {
        position: relative;
    }

    .cell.formula-highlighted::after {
        content: "";
        position: absolute;
        inset: 0;
        border: 2px solid var(--highlight-color, #3b82f6);
        pointer-events: none;
        z-index: 1;
    }

    .pane-slot-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 30;
    }
</style>
