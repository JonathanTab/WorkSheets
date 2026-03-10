<script>
    /**
     * VirtualPane - Generic Pane Renderer (refactored for position-absolute layout)
     *
     * Renders a single pane (corner, top, left, body) using:
     * - a clipped outer container (fixed in viewport)
     * - a translated inner content layer (scroll transform)
     * - position-absolute cells (enables merges, overflow, and row-spanning)
     *
     * Cell rendering is dispatched by type via renderContext:
     *   REGULAR         - standard cell with optional overflow
     *   MERGE_PRIMARY   - renders with computed span width/height
     *   MERGE_SHADOW    - skipped (no DOM output)
     *   VIEWPORT_OCCUPIED - skipped (viewport panel sits on top)
     *   TABLE_* / REPEATER - delegated to feature sub-components (Phase 2/3)
     */

    import { PANE } from "../../../stores/spreadsheet/virtualization/types.js";
    import { CELL_TYPE } from "../../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
    import { CellTypeRegistry } from "../../../stores/spreadsheet/cellTypes/index.js";
    import TableHeaderCell from "../features/TableHeaderCell.svelte";
    import TableEntryCell from "../features/TableEntryCell.svelte";
    import TableDataCell from "../features/TableDataCell.svelte";
    import CheckboxCell from "../cellTypes/CheckboxCell.svelte";
    import RatingCell from "../cellTypes/RatingCell.svelte";

    let {
        paneType = PANE.BODY,
        rowRange = { start: 0, end: -1, count: 0 },
        colRange = { start: 0, end: -1, count: 0 },
        rowMetrics,
        colMetrics,
        // Unified rendering API (preferred — set by Grid.svelte when available)
        renderContext = null,
        // Legacy direct props (fallback for when renderContext is null)
        sheetStore = null,
        session = null,
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

    // Resolve effective sheetStore from renderContext (preferred) or direct prop
    let effectiveSheetStore = $derived(renderContext?.sheetStore ?? sheetStore);

    // ─── Pane geometry ────────────────────────────────────────────────────────

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

    let clipStyle = $derived(
        `left:${originX}px; top:${originY}px; width:${clipWidth}px; height:${clipHeight}px;`,
    );

    let innerStyle = $derived.by(() => {
        const relX = offsetX - colBaseOffset;
        const relY = offsetY - rowBaseOffset;
        return `transform: translate(${-relX}px, ${-relY}px); width:${contentWidth}px; height:${contentHeight}px;`;
    });

    // ─── Rendering helpers ────────────────────────────────────────────────────

    /**
     * Determine cell type. Falls back to REGULAR when no renderContext.
     */
    function getCellType(row, col) {
        return renderContext?.getCellType(row, col) ?? CELL_TYPE.REGULAR;
    }

    /**
     * Compute pixel dimensions for a cell, accounting for merge span and overflow.
     * @returns {{ width: number, height: number }}
     */
    function getCellDimensions(row, col, cellType) {
        const baseW = colMetrics.sizeOf(col);
        const baseH = rowMetrics.sizeOf(row);

        if (cellType === CELL_TYPE.MERGE_PRIMARY && renderContext) {
            const span = renderContext.getMergeSpan(row, col);
            if (span) {
                return {
                    width:
                        colMetrics.offsetOf(col + span.colSpan) -
                        colMetrics.offsetOf(col),
                    height:
                        rowMetrics.offsetOf(row + span.rowSpan) -
                        rowMetrics.offsetOf(row),
                };
            }
        }

        // REGULAR cells may overflow into adjacent empty cells
        if (cellType === CELL_TYPE.REGULAR && renderContext) {
            const extra = renderContext.getOverflowExtent(
                row,
                col,
                colRange.end,
                colMetrics,
            );
            return { width: baseW + extra, height: baseH };
        }

        return { width: baseW, height: baseH };
    }

    /**
     * Get display value from renderContext or legacy session.
     */
    function getDisplayValue(row, col) {
        if (renderContext) return renderContext.getDisplayValue(row, col);
        return session?.getCellDisplayValue(row, col) ?? "";
    }

    /**
     * Build text/typography inline style string.
     */
    function buildTextStyle(cell) {
        if (!cell?.exists) return "";
        const s = [];
        if (cell.fontFamily) s.push(`font-family: ${cell.fontFamily}`);
        if (cell.fontSize) s.push(`font-size: ${cell.fontSize}px`);
        if (cell.bold) s.push("font-weight: bold");
        if (cell.italic) s.push("font-style: italic");
        const deco = [];
        if (cell.underline) deco.push("underline");
        if (cell.strikethrough) deco.push("line-through");
        if (deco.length) s.push(`text-decoration: ${deco.join(" ")}`);
        if (cell.color) s.push(`color: ${cell.color}`);
        return s.join("; ");
    }

    /**
     * Build container inline style string (background, alignment, borders).
     */
    function buildContainerStyle(cell, row, col) {
        const s = [];
        // Use getCellStyle from renderContext if available to get merged type defaults
        const effectiveStyle = renderContext
            ? renderContext.getCellStyle(row, col)
            : cell;

        if (effectiveStyle?.exists) {
            if (effectiveStyle.backgroundColor)
                s.push(`background-color: ${effectiveStyle.backgroundColor}`);
            if (effectiveStyle.horizontalAlign)
                s.push(`justify-content: ${effectiveStyle.horizontalAlign}`);
            if (effectiveStyle.verticalAlign) {
                const va =
                    effectiveStyle.verticalAlign === "top"
                        ? "flex-start"
                        : effectiveStyle.verticalAlign === "bottom"
                          ? "flex-end"
                          : "center";
                s.push(`align-items: ${va}`);
            }
        }
        const store = effectiveSheetStore;
        if (store) {
            const b = store.getCellBorders(row, col);
            if (b.top)
                s.push(
                    `border-top: ${b.top.width}px ${b.top.style} ${b.top.color}`,
                );
            if (b.right)
                s.push(
                    `border-right: ${b.right.width}px ${b.right.style} ${b.right.color}`,
                );
            if (b.bottom)
                s.push(
                    `border-bottom: ${b.bottom.width}px ${b.bottom.style} ${b.bottom.color}`,
                );
            if (b.left)
                s.push(
                    `border-left: ${b.left.width}px ${b.left.style} ${b.left.color}`,
                );
        }
        return s.join("; ");
    }

    function isSelected(row, col) {
        const sel = selectionState?.range;
        if (!sel) return false;
        return (
            row >= sel.startRow &&
            row <= sel.endRow &&
            col >= sel.startCol &&
            col <= sel.endCol
        );
    }

    function isAnchor(row, col) {
        const a = selectionState?.anchor;
        return a?.row === row && a?.col === col;
    }

    /**
     * Handle custom component changes (e.g. checkbox/rating)
     */
    function handleComponentChange(row, col, newValue) {
        effectiveSheetStore?.setCellValue(row, col, newValue);
    }

    function handleCellClick(row, col, e) {
        const ct = renderContext?.getCellTypeConfig(row, col);
        if (ct) {
            const descriptor = CellTypeRegistry.get(ct.type);
            if (descriptor?.handlesClick) {
                // For now, simple toggle logic for checkboxes if they use handleCellClick
            }
        }
    }

    // ─── Cell Pre-computation ─────────────────────────────────────────────────

    let renderCells = $derived.by(() => {
        const list = [];
        if (
            !rowRange ||
            rowRange.count <= 0 ||
            !colRange ||
            colRange.count <= 0
        )
            return list;

        // Touch dependencies to ensure reactivity
        effectiveSheetStore?.bordersVersion;

        for (let r = rowRange.start; r <= rowRange.end; r++) {
            for (let c = colRange.start; c <= colRange.end; c++) {
                const cellType = getCellType(r, c);
                if (
                    cellType === CELL_TYPE.MERGE_SHADOW ||
                    cellType === CELL_TYPE.VIEWPORT_OCCUPIED
                )
                    continue;

                const dims = getCellDimensions(r, c, cellType);
                const cellL = colMetrics.offsetOf(c) - colBaseOffset;
                const cellT = rowMetrics.offsetOf(r) - rowBaseOffset;

                if (
                    cellType === CELL_TYPE.TABLE_HEADER ||
                    cellType === CELL_TYPE.TABLE_ENTRY ||
                    cellType === CELL_TYPE.TABLE_DATA
                ) {
                    const info = renderContext?.tableManager?.getCellInfo(r, c);
                    if (info?.table) {
                        list.push({
                            isTable: true,
                            row: r,
                            col: c,
                            cellType,
                            dims,
                            cellL,
                            cellT,
                            info,
                        });
                    }
                } else {
                    const mappedRow =
                        cellType === CELL_TYPE.REPEATER
                            ? (renderContext?.repeaterEngine?.getCellRepeaterContext(
                                  r,
                                  c,
                              )?.templateRow ?? r)
                            : r;
                    const mappedCol =
                        cellType === CELL_TYPE.REPEATER
                            ? (renderContext?.repeaterEngine?.getCellRepeaterContext(
                                  r,
                                  c,
                              )?.templateCol ?? c)
                            : c;
                    const cell = effectiveSheetStore?.getCell(
                        mappedRow,
                        mappedCol,
                    );
                    const dispV = getDisplayValue(r, c);
                    const sel = isSelected(r, c);
                    const anch = isAnchor(r, c);
                    const hlCol = formulaEditState?.getCellHighlightColor(r, c);
                    const hlOn = formulaEditState?.isCellReferenced(r, c);
                    const cStyle = buildContainerStyle(cell, r, c);
                    const tStyle = buildTextStyle(cell);
                    const ct = renderContext?.getCellTypeConfig(r, c);
                    const descriptor = ct
                        ? CellTypeRegistry.get(ct.type)
                        : null;
                    const displayComp = descriptor?.getDisplayComponent?.();

                    list.push({
                        isTable: false,
                        row: r,
                        col: c,
                        cellType,
                        dims,
                        cellL,
                        cellT,
                        cell,
                        dispV,
                        sel,
                        anch,
                        hlCol,
                        hlOn,
                        cStyle,
                        tStyle,
                        ct,
                        displayComp,
                    });
                }
            }
        }
        return list;
    });
</script>

{#if rowRange.count > 0 && colRange.count > 0 && clipWidth > 0 && clipHeight > 0}
    <div class="pane-clip pane-{paneType}" style={clipStyle}>
        <div class="pane-inner" style={innerStyle}>
            {#each renderCells as item (item.row + "," + item.col)}
                {#if item.isTable}
                    {#if item.cellType === CELL_TYPE.TABLE_HEADER}
                        <div
                            class="cell table-cell"
                            style="left:{item.cellL}px; top:{item.cellT}px; width:{item
                                .dims.width}px; height:{item.dims.height}px;"
                            role="columnheader"
                        >
                            <TableHeaderCell
                                table={item.info.table}
                                colIndex={item.info.table.colIndexForSheetCol(
                                    item.col,
                                )}
                                width={item.dims.width}
                                height={item.dims.height}
                            />
                        </div>
                    {:else if item.cellType === CELL_TYPE.TABLE_ENTRY}
                        <div
                            class="cell table-cell"
                            style="left:{item.cellL}px; top:{item.cellT}px; width:{item
                                .dims.width}px; height:{item.dims.height}px;"
                            role="gridcell"
                        >
                            <TableEntryCell
                                table={item.info.table}
                                colIndex={item.info.table.colIndexForSheetCol(
                                    item.col,
                                )}
                                width={item.dims.width}
                                height={item.dims.height}
                            />
                        </div>
                    {:else if item.cellType === CELL_TYPE.TABLE_DATA}
                        <div
                            class="cell table-cell"
                            style="left:{item.cellL}px; top:{item.cellT}px; width:{item
                                .dims.width}px; height:{item.dims.height}px;"
                            role="gridcell"
                            onmousedown={(e) =>
                                onCellMouseDown?.(item.row, item.col, e)}
                            onmouseenter={() =>
                                onCellMouseEnter?.(item.row, item.col)}
                            oncontextmenu={(e) =>
                                onCellContextMenu?.(item.row, item.col, e)}
                        >
                            <TableDataCell
                                table={item.info.table}
                                colIndex={item.info.table.colIndexForSheetCol(
                                    item.col,
                                )}
                                dataIndex={item.info.dataIndex}
                                width={item.dims.width}
                                height={item.dims.height}
                            />
                        </div>
                    {/if}
                {:else}
                    <div
                        class="cell"
                        class:selected={item.sel}
                        class:anchor={item.anch}
                        class:formula-highlighted={item.hlOn}
                        class:wrap-text={item.cell?.wrapText}
                        style="left:{item.cellL}px; top:{item.cellT}px; width:{item
                            .dims.width}px; height:{item.dims
                            .height}px; {item.cStyle}; {item.hlCol
                            ? `--highlight-color: ${item.hlCol}`
                            : ''}"
                        onmousedown={(e) => {
                            handleCellClick(item.row, item.col, e);
                            onCellMouseDown?.(item.row, item.col, e);
                        }}
                        onmouseenter={() =>
                            onCellMouseEnter?.(item.row, item.col)}
                        ondblclick={() =>
                            onCellDoubleClick?.(item.row, item.col)}
                        oncontextmenu={(e) =>
                            onCellContextMenu?.(item.row, item.col, e)}
                        role="gridcell"
                        tabindex="-1"
                    >
                        {#if item.displayComp?.component === "CheckboxCell"}
                            <CheckboxCell
                                value={!!item.cell?.v}
                                on:change={(e) =>
                                    handleComponentChange(
                                        item.row,
                                        item.col,
                                        e.detail,
                                    )}
                            />
                        {:else if item.displayComp?.component === "RatingCell"}
                            <RatingCell
                                value={Number(item.cell?.v || 0)}
                                max={item.ct?.max || 5}
                                on:change={(e) =>
                                    handleComponentChange(
                                        item.row,
                                        item.col,
                                        e.detail,
                                    )}
                            />
                        {:else}
                            <span class="cell-content" style={item.tStyle}
                                >{item.dispV ?? ""}</span
                            >
                        {/if}
                    </div>
                {/if}
            {/each}

            <!-- Slot for overlays (editor, selection highlights, etc.) -->
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

    /* pane-inner: relative, exact size, will-change for GPU compositing */
    .pane-inner {
        position: relative;
        will-change: transform;
    }

    /* ── Cell base: position-absolute, flex for alignment ─────────────────── */
    .cell {
        position: absolute;
        display: flex;
        align-items: center; /* vertical-align: middle (default) */
        overflow: hidden;
        cursor: cell;
        background: var(--cell-bg, #ffffff);
        border-right: 1px solid var(--cell-border, #e2e8f0);
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        padding: 0 4px;
        box-sizing: border-box;
        contain: strict;
    }

    /* Table cells need overflow visible for popovers (filter dropdowns) */
    .cell.table-cell {
        overflow: visible;
        contain: none;
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

    .cell.formula-highlighted {
        position: absolute; /* already absolute, but needed for ::after */
    }

    .cell.formula-highlighted::after {
        content: "";
        position: absolute;
        inset: 0;
        border: 2px solid var(--highlight-color, #3b82f6);
        pointer-events: none;
        z-index: 1;
    }

    /* wrap-text: allow content to wrap and clip */
    .cell.wrap-text {
        align-items: flex-start;
    }

    .cell.wrap-text .cell-content {
        white-space: pre-wrap;
        overflow: hidden;
        text-overflow: clip;
        word-break: break-word;
    }

    /* ── Cell content span ────────────────────────────────────────────────── */
    .cell-content {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        pointer-events: none;
    }

    /* ── Overlay slot (editor, etc.) ──────────────────────────────────────── */
    .pane-slot-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 30;
    }
</style>
