<script>
    import { onMount, onDestroy, untrack } from "svelte";
    import {
        spreadsheetSession,
        selectionState,
        GridVirtualizer,
        ROW_HEIGHT,
        COL_WIDTH,
        HEADER_HEIGHT,
        HEADER_WIDTH,
    } from "../../stores/spreadsheetStore.svelte.js";
    import {
        formulaEditState,
        toRangeRef,
    } from "../../stores/spreadsheet/FormulaEditState.svelte.js";
    import { clipboardManager } from "../../stores/spreadsheet/index.js";
    import VirtualPane from "./grid/VirtualPane.svelte";
    import GridOverlays from "./grid/GridOverlays.svelte";
    import ColHeaders from "./grid/ColHeaders.svelte";
    import RowHeaders from "./grid/RowHeaders.svelte";
    import ContextMenu from "./ContextMenu.svelte";

    let containerEl = null;
    let scrollEl = null;
    let resizeObserver = null;

    let virtualizer = $state(null);

    let isEditing = $state(false);
    let editRow = $state(-1);
    let editCol = $state(-1);
    let editValue = $state("");

    let isSelectingRange = $state(false);
    let rangeStartCell = $state(null);
    let rangeEndCell = $state(null);

    let contextMenuVisible = $state(false);
    let contextMenuPosition = $state({ x: 0, y: 0 });

    let resizing = $state(null);

    // Track which sheet we've created a virtualizer for
    let virtualizerSheetId = $state.raw(null);

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let renderPlan = $derived(virtualizer ? virtualizer.renderPlan : null);
    let hasLoggedZeroViewportWarning = $state(false);

    let selection = $derived(selectionState.range);
    let anchor = $derived(selectionState.anchor);

    let isFormulaEditMode = $derived(formulaEditState.isFormulaMode);

    // Consolidated Virtualizer Configuration Effect
    $effect(() => {
        // 1. Lifecycle: Handle sheet changes
        if (!sheetStore) {
            if (virtualizer) {
                untrack(() => {
                    virtualizer.destroy();
                    virtualizer = null;
                    virtualizerSheetId = null;
                });
            }
            return;
        }

        // Capture dependencies
        const sheetId = sheetStore.id;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;
        const frozenRows = sheetStore.frozenRows;
        const frozenCols = sheetStore.frozenColumns;
        const rowMetaVersion = sheetStore.rowMetaVersion;
        const colMetaVersion = sheetStore.colMetaVersion;
        const defaultRowHeight = sheetStore.defaultRowHeight;
        const defaultColWidth = sheetStore.defaultColWidth;

        // 2. Synchronization: Update virtualizer state
        untrack(() => {
            // Re-create virtualizer if sheet changed
            if (!virtualizer || virtualizerSheetId !== sheetId) {
                if (virtualizer) {
                    virtualizer.destroy();
                }
                virtualizer = new GridVirtualizer({
                    defaultRowHeight: defaultRowHeight ?? ROW_HEIGHT,
                    defaultColWidth: defaultColWidth ?? COL_WIDTH,
                });
                virtualizerSheetId = sheetId;

                // Set initial container size if available
                if (containerEl) {
                    const rect = containerEl.getBoundingClientRect();
                    virtualizer.setContainerSize(rect.width, rect.height);
                }
            }

            // Sync dimensions
            virtualizer.setSheetDimensions(rowCount, colCount);
            virtualizer.setFrozenDimensions(frozenRows, frozenCols);

            // Sync row/col metadata
            const rowMeta = sheetStore.getYMap()?.get("rowMeta");
            const colMeta = sheetStore.getYMap()?.get("colMeta");

            const heights = new Map();
            if (rowMeta) {
                rowMeta.forEach((meta, key) => {
                    const height = meta.get("height");
                    if (height !== undefined)
                        heights.set(parseInt(key, 10), height);
                });
            }
            virtualizer.syncRowHeights(heights);

            const widths = new Map();
            if (colMeta) {
                colMeta.forEach((meta, key) => {
                    const width = meta.get("width");
                    if (width !== undefined)
                        widths.set(parseInt(key, 10), width);
                });
            }
            virtualizer.syncColWidths(widths);
        });
    });

    function colHeader(col) {
        let header = "";
        let c = col;
        while (c >= 0) {
            header = String.fromCharCode(65 + (c % 26)) + header;
            c = Math.floor(c / 26) - 1;
        }
        return header;
    }

    function isSelected(row, col) {
        if (!selection) return false;
        return (
            row >= selection.startRow &&
            row <= selection.endRow &&
            col >= selection.startCol &&
            col <= selection.endCol
        );
    }

    function isRowSelected(row) {
        if (!selection) return false;
        return row >= selection.startRow && row <= selection.endRow;
    }

    function isColSelected(col) {
        if (!selection) return false;
        return col >= selection.startCol && col <= selection.endCol;
    }

    function handleCornerCellMouseDown() {
        selectionState.selectAll();
    }

    function handleRowHeaderMouseDown(row) {
        selectionState.selectRow(row);
    }

    function handleColHeaderMouseDown(col) {
        selectionState.selectColumn(col);
    }

    function startColResize(col, e) {
        e.preventDefault();
        e.stopPropagation();

        let indices = [col];
        if (selection && col >= selection.startCol && col <= selection.endCol) {
            indices = [];
            for (let c = selection.startCol; c <= selection.endCol; c++) {
                indices.push(c);
            }
        }

        resizing = {
            type: "col",
            index: col,
            startPos: e.clientX,
            startSize: virtualizer.getColWidth(col),
            selectedIndices: indices,
        };

        document.addEventListener("mousemove", handleResizeMove);
        document.addEventListener("mouseup", handleResizeEnd);
    }

    function startRowResize(row, e) {
        e.preventDefault();
        e.stopPropagation();

        let indices = [row];
        if (selection && row >= selection.startRow && row <= selection.endRow) {
            indices = [];
            for (let r = selection.startRow; r <= selection.endRow; r++) {
                indices.push(r);
            }
        }

        resizing = {
            type: "row",
            index: row,
            startPos: e.clientY,
            startSize: virtualizer.getRowHeight(row),
            selectedIndices: indices,
        };

        document.addEventListener("mousemove", handleResizeMove);
        document.addEventListener("mouseup", handleResizeEnd);
    }

    function handleResizeMove(e) {
        if (!resizing || !virtualizer) return;

        if (resizing.type === "col") {
            const delta = e.clientX - resizing.startPos;
            const newWidth = Math.max(20, resizing.startSize + delta);
            for (const idx of resizing.selectedIndices) {
                virtualizer.setTempColWidth(idx, newWidth);
            }
        } else {
            const delta = e.clientY - resizing.startPos;
            const newHeight = Math.max(10, resizing.startSize + delta);
            for (const idx of resizing.selectedIndices) {
                virtualizer.setTempRowHeight(idx, newHeight);
            }
        }
    }

    function handleResizeEnd() {
        if (!resizing || !virtualizer || !sheetStore) return;

        if (resizing.type === "col") {
            const finalWidth = virtualizer.getColWidth(resizing.index);
            for (const idx of resizing.selectedIndices) {
                sheetStore.setColWidth(idx, finalWidth);
            }
            virtualizer.clearTempColWidths();
        } else {
            const finalHeight = virtualizer.getRowHeight(resizing.index);
            for (const idx of resizing.selectedIndices) {
                sheetStore.setRowHeight(idx, finalHeight);
            }
            virtualizer.clearTempRowHeights();
        }

        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
        resizing = null;
    }

    function handleScroll(e) {
        if (!virtualizer) return;
        virtualizer.setScroll(e.target.scrollTop, e.target.scrollLeft);
    }

    function handleCellMouseDown(row, col, e) {
        if (e.button !== 0) return;

        if (isFormulaEditMode) {
            isSelectingRange = true;
            rangeStartCell = { row, col };
            rangeEndCell = { row, col };
            e.preventDefault();
            return;
        }

        if (e.shiftKey && anchor) {
            selectionState.extendSelection(row, col);
        } else {
            selectionState.startSelection(row, col);
        }
    }

    function handleCellMouseEnter(row, col) {
        if (isFormulaEditMode && isSelectingRange) {
            rangeEndCell = { row, col };
            return;
        }
        if (selectionState.isSelecting) {
            selectionState.extendSelection(row, col);
        }
    }

    function handleMouseUp() {
        if (isFormulaEditMode && isSelectingRange && rangeStartCell) {
            const endCell = rangeEndCell || rangeStartCell;
            const ref = toRangeRef(
                Math.min(rangeStartCell.row, endCell.row),
                Math.min(rangeStartCell.col, endCell.col),
                Math.max(rangeStartCell.row, endCell.row),
                Math.max(rangeStartCell.col, endCell.col),
            );
            formulaEditState.insertReference(ref);
            isSelectingRange = false;
            rangeStartCell = null;
            rangeEndCell = null;
            return;
        }

        selectionState.endSelection();
    }

    function handleCellDoubleClick(row, col) {
        const rawValue = spreadsheetSession.getCellEditValue(row, col);
        editRow = row;
        editCol = col;
        editValue = rawValue ?? "";
        isEditing = true;
    }

    function commitEdit() {
        if (isEditing && editRow >= 0 && editCol >= 0 && sheetStore) {
            if (editValue.startsWith("=")) {
                sheetStore.setCellFormula(editRow, editCol, editValue);
            } else {
                sheetStore.setCellValue(editRow, editCol, editValue);
            }
        }
        isEditing = false;
        editRow = -1;
        editCol = -1;
        editValue = "";
    }

    function cancelEdit() {
        isEditing = false;
        editRow = -1;
        editCol = -1;
        editValue = "";
    }

    function handleCellContextMenu(row, col, e) {
        e.preventDefault();

        if (!isSelected(row, col)) {
            selectionState.startSelection(row, col);
            selectionState.endSelection();
        }

        contextMenuPosition = { x: e.clientX, y: e.clientY };
        contextMenuVisible = true;
    }

    function closeContextMenu() {
        contextMenuVisible = false;
    }

    function copySelection() {
        if (!sheetStore) return;
        clipboardManager.copy(sheetStore, spreadsheetSession);
    }

    function cutSelection() {
        if (!sheetStore || !spreadsheetSession.ydoc) return;
        clipboardManager.cut(
            sheetStore,
            spreadsheetSession,
            spreadsheetSession.ydoc,
        );
    }

    function pasteSelection(mode = "full") {
        if (!sheetStore || !spreadsheetSession.ydoc) return;
        clipboardManager.paste(
            sheetStore,
            spreadsheetSession,
            spreadsheetSession.ydoc,
            mode,
        );
    }

    function clearSelection() {
        if (!selection || !sheetStore) return;
        for (let r = selection.startRow; r <= selection.endRow; r++) {
            for (let c = selection.startCol; c <= selection.endCol; c++) {
                sheetStore.clearCell(r, c);
            }
        }
    }

    function insertRowAbove() {
        if (!sheetStore || !selection) return;
        sheetStore.insertRowAt(selection.startRow);
    }

    function insertRowBelow() {
        if (!sheetStore || !selection) return;
        sheetStore.insertRowAt(selection.endRow + 1);
    }

    function insertColumnLeft() {
        if (!sheetStore || !selection) return;
        sheetStore.insertColumnAt(selection.startCol);
    }

    function insertColumnRight() {
        if (!sheetStore || !selection) return;
        sheetStore.insertColumnAt(selection.endCol + 1);
    }

    function deleteSelectedRows() {
        if (!sheetStore || !selection) return;
        for (let row = selection.endRow; row >= selection.startRow; row--) {
            sheetStore.deleteRowAt(row);
        }
    }

    function deleteSelectedColumns() {
        if (!sheetStore || !selection) return;
        for (let col = selection.endCol; col >= selection.startCol; col--) {
            sheetStore.deleteColumnAt(col);
        }
    }

    function scrollToAnchor() {
        if (!scrollEl || !anchor || !virtualizer) return;
        const { scrollTop, scrollLeft } = virtualizer.scrollToCell(
            anchor.row,
            anchor.col,
        );
        if (scrollEl.scrollTop !== scrollTop) scrollEl.scrollTop = scrollTop;
        if (scrollEl.scrollLeft !== scrollLeft)
            scrollEl.scrollLeft = scrollLeft;
    }

    function handleKeydown(e) {
        const target = e.target;
        const isInputElement =
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable;
        if (isInputElement) return;

        if (isEditing) {
            if (e.key === "Enter") {
                commitEdit();
                selectionState.moveSelection(1, 0);
                scrollToAnchor();
                e.preventDefault();
            } else if (e.key === "Escape") {
                cancelEdit();
                e.preventDefault();
            } else if (e.key === "Tab") {
                commitEdit();
                selectionState.moveSelection(0, e.shiftKey ? -1 : 1);
                scrollToAnchor();
                e.preventDefault();
            }
            return;
        }

        switch (e.key) {
            case "ArrowUp":
                selectionState.moveSelection(-1, 0, e.shiftKey);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowDown":
                selectionState.moveSelection(1, 0, e.shiftKey);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowLeft":
                selectionState.moveSelection(0, -1, e.shiftKey);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowRight":
                selectionState.moveSelection(0, 1, e.shiftKey);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "Enter":
                if (anchor) handleCellDoubleClick(anchor.row, anchor.col);
                e.preventDefault();
                break;
            case "Delete":
            case "Backspace":
                clearSelection();
                e.preventDefault();
                break;
            case "z":
                if (e.ctrlKey || e.metaKey) {
                    if (e.shiftKey) spreadsheetSession.redo();
                    else spreadsheetSession.undo();
                    e.preventDefault();
                }
                break;
            case "y":
                if (e.ctrlKey || e.metaKey) {
                    spreadsheetSession.redo();
                    e.preventDefault();
                }
                break;
            case "c":
                if ((e.ctrlKey || e.metaKey) && selection) {
                    copySelection();
                    e.preventDefault();
                }
                break;
            case "x":
                if ((e.ctrlKey || e.metaKey) && selection) {
                    cutSelection();
                    e.preventDefault();
                }
                break;
            case "v":
                if ((e.ctrlKey || e.metaKey) && selection) {
                    pasteSelection("full");
                    e.preventDefault();
                }
                break;
            case "a":
                if (e.ctrlKey || e.metaKey) {
                    selectionState.selectAll();
                    e.preventDefault();
                }
                break;
            default:
                if (anchor && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                    handleCellDoubleClick(anchor.row, anchor.col);
                    editValue = e.key;
                }
        }
    }

    let selectionType = $derived.by(() => {
        if (!selection || !sheetStore) return "none";
        const isSingleCell =
            selection.startRow === selection.endRow &&
            selection.startCol === selection.endCol;
        const isFullRow =
            selection.startCol === 0 &&
            selection.endCol === sheetStore.colCount - 1;
        const isFullColumn =
            selection.startRow === 0 &&
            selection.endRow === sheetStore.rowCount - 1;
        if (isSingleCell) return "cell";
        if (isFullRow) return "row";
        if (isFullColumn) return "column";
        return "range";
    });

    let contextMenuItems = $derived([
        {
            label: "Cut",
            icon: "✂",
            shortcut: "Ctrl+X",
            action: cutSelection,
            disabled: !selection,
        },
        {
            label: "Copy",
            icon: "📋",
            shortcut: "Ctrl+C",
            action: copySelection,
            disabled: !selection,
        },
        {
            label: "Paste",
            icon: "📄",
            shortcut: "Ctrl+V",
            action: () => pasteSelection("full"),
        },
        {
            label: "Paste Special...",
            submenu: [
                {
                    label: "Values Only",
                    action: () => pasteSelection("values"),
                },
                {
                    label: "Formulas Only",
                    action: () => pasteSelection("formulas"),
                },
                {
                    label: "Formatting Only",
                    action: () => pasteSelection("formatting"),
                },
                { divider: true },
                {
                    label: "Values & Formatting",
                    action: () => pasteSelection("valuesFormat"),
                },
                {
                    label: "Formulas & Formatting",
                    action: () => pasteSelection("formulasFormat"),
                },
            ],
        },
        { divider: true },
        {
            label: "Clear Contents",
            icon: "🗑",
            shortcut: "Delete",
            action: clearSelection,
            disabled: !selection,
        },
        { divider: true },
        {
            label: "Insert Row Above",
            icon: "⬆",
            action: insertRowAbove,
            disabled: !selection,
        },
        {
            label: "Insert Row Below",
            icon: "⬇",
            action: insertRowBelow,
            disabled: !selection,
        },
        {
            label: "Insert Column Left",
            icon: "⬅",
            action: insertColumnLeft,
            disabled: !selection,
        },
        {
            label: "Insert Column Right",
            icon: "➡",
            action: insertColumnRight,
            disabled: !selection,
        },
        { divider: true },
        {
            label:
                selectionType === "row"
                    ? `Delete ${selection.endRow - selection.startRow + 1} Rows`
                    : "Delete Row",
            icon: "🗑",
            action: deleteSelectedRows,
            disabled: !selection,
        },
        {
            label:
                selectionType === "column"
                    ? `Delete ${selection.endCol - selection.startCol + 1} Columns`
                    : "Delete Column",
            icon: "🗑",
            action: deleteSelectedColumns,
            disabled: !selection,
        },
    ]);

    $effect(() => {
        if (!virtualizer || !renderPlan) return;

        const zeroHeight = renderPlan.bodyViewportHeight <= 0;
        if (zeroHeight && !hasLoggedZeroViewportWarning) {
            console.warn(
                "[Grid] body viewport height is 0; body cells cannot render",
                {
                    containerWidth: virtualizer.containerWidth,
                    containerHeight: virtualizer.containerHeight,
                    headerHeight: HEADER_HEIGHT,
                    frozenHeight: renderPlan.frozenHeight,
                    bodyViewportHeight: renderPlan.bodyViewportHeight,
                    bodyViewportWidth: renderPlan.bodyViewportWidth,
                },
            );
            hasLoggedZeroViewportWarning = true;
        } else if (!zeroHeight && hasLoggedZeroViewportWarning) {
            hasLoggedZeroViewportWarning = false;
        }
    });

    let resizeTicking = false;
    onMount(() => {
        document.addEventListener("mouseup", handleMouseUp);

        if (containerEl) {
            resizeObserver = new ResizeObserver((entries) => {
                if (resizeTicking) return;
                resizeTicking = true;
                requestAnimationFrame(() => {
                    for (const entry of entries) {
                        const { width, height } = entry.contentRect;
                        if (virtualizer) {
                            virtualizer.setContainerSize(width, height);
                        }
                    }
                    resizeTicking = false;
                });
            });
            resizeObserver.observe(containerEl);

            const rect = containerEl.getBoundingClientRect();
            if (virtualizer) {
                virtualizer.setContainerSize(rect.width, rect.height);
            }
        }

        if (!anchor) {
            selectionState.startSelection(0, 0);
            selectionState.endSelection();
        }
    });

    onDestroy(() => {
        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
        if (resizeObserver) resizeObserver.disconnect();
        virtualizer?.destroy();
    });

    function spacerStyle() {
        if (!renderPlan) return "";
        return `width:${renderPlan.totalWidth + HEADER_WIDTH}px;height:${renderPlan.totalHeight + HEADER_HEIGHT}px;`;
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="grid-root" bind:this={containerEl}>
    <div class="scroll-proxy" bind:this={scrollEl} onscroll={handleScroll}>
        <div class="scroll-spacer" style={spacerStyle()}></div>
    </div>

    {#if renderPlan && virtualizer}
        <div class="render-layer">
            <div
                class="corner-cell"
                style="width:{HEADER_WIDTH}px; height:{HEADER_HEIGHT}px;"
                onmousedown={handleCornerCellMouseDown}
                onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleCornerCellMouseDown();
                    }
                }}
                role="button"
                tabindex="0"
                title="Select All (Ctrl+A)"
            ></div>

            <div
                class="col-headers-layer"
                style="left:{HEADER_WIDTH}px; right:0; top:0; height:{HEADER_HEIGHT}px;"
            >
                <ColHeaders
                    {virtualizer}
                    bodyColRange={renderPlan.plans.body.colRange}
                    {isColSelected}
                    {colHeader}
                    onColHeaderMouseDown={handleColHeaderMouseDown}
                    onStartColResize={startColResize}
                />
            </div>

            <div
                class="row-headers-layer"
                style="top:{HEADER_HEIGHT}px; left:0; width:{HEADER_WIDTH}px; bottom:0;"
            >
                <RowHeaders
                    {virtualizer}
                    bodyRowRange={renderPlan.plans.body.rowRange}
                    {isRowSelected}
                    onRowHeaderMouseDown={handleRowHeaderMouseDown}
                    onStartRowResize={startRowResize}
                />
            </div>

            <VirtualPane
                paneType="body"
                rowRange={renderPlan.plans.body.rowRange}
                colRange={renderPlan.plans.body.colRange}
                rowMetrics={virtualizer.rowMetrics}
                colMetrics={virtualizer.colMetrics}
                {sheetStore}
                session={spreadsheetSession}
                {selectionState}
                {formulaEditState}
                originX={HEADER_WIDTH + renderPlan.frozenWidth}
                originY={HEADER_HEIGHT + renderPlan.frozenHeight}
                clipWidth={renderPlan.bodyViewportWidth}
                clipHeight={renderPlan.bodyViewportHeight}
                offsetX={virtualizer.scrollLeft}
                offsetY={virtualizer.scrollTop}
                onCellMouseDown={handleCellMouseDown}
                onCellMouseEnter={handleCellMouseEnter}
                onCellDoubleClick={handleCellDoubleClick}
                onCellContextMenu={handleCellContextMenu}
            >
                <GridOverlays
                    {virtualizer}
                    {selectionState}
                    session={spreadsheetSession}
                    rowRange={renderPlan.plans.body.rowRange}
                    colRange={renderPlan.plans.body.colRange}
                    {isEditing}
                    {editRow}
                    {editCol}
                    bind:editValue
                    onCommitEdit={commitEdit}
                    onCancelEdit={cancelEdit}
                />
            </VirtualPane>

            {#if renderPlan.plans.top.rowRange.count > 0}
                <VirtualPane
                    paneType="top"
                    rowRange={renderPlan.plans.top.rowRange}
                    colRange={renderPlan.plans.top.colRange}
                    rowMetrics={virtualizer.rowMetrics}
                    colMetrics={virtualizer.colMetrics}
                    {sheetStore}
                    session={spreadsheetSession}
                    {selectionState}
                    {formulaEditState}
                    originX={HEADER_WIDTH + renderPlan.frozenWidth}
                    originY={HEADER_HEIGHT}
                    clipWidth={renderPlan.bodyViewportWidth}
                    clipHeight={renderPlan.frozenHeight}
                    offsetX={virtualizer.scrollLeft}
                    offsetY={0}
                    onCellMouseDown={handleCellMouseDown}
                    onCellMouseEnter={handleCellMouseEnter}
                    onCellDoubleClick={handleCellDoubleClick}
                    onCellContextMenu={handleCellContextMenu}
                />
            {/if}

            {#if renderPlan.plans.left.colRange.count > 0}
                <VirtualPane
                    paneType="left"
                    rowRange={renderPlan.plans.left.rowRange}
                    colRange={renderPlan.plans.left.colRange}
                    rowMetrics={virtualizer.rowMetrics}
                    colMetrics={virtualizer.colMetrics}
                    {sheetStore}
                    session={spreadsheetSession}
                    {selectionState}
                    {formulaEditState}
                    originX={HEADER_WIDTH}
                    originY={HEADER_HEIGHT + renderPlan.frozenHeight}
                    clipWidth={renderPlan.frozenWidth}
                    clipHeight={renderPlan.bodyViewportHeight}
                    offsetX={0}
                    offsetY={virtualizer.scrollTop}
                    onCellMouseDown={handleCellMouseDown}
                    onCellMouseEnter={handleCellMouseEnter}
                    onCellDoubleClick={handleCellDoubleClick}
                    onCellContextMenu={handleCellContextMenu}
                />
            {/if}

            {#if renderPlan.plans.corner.rowRange.count > 0 && renderPlan.plans.corner.colRange.count > 0}
                <VirtualPane
                    paneType="corner"
                    rowRange={renderPlan.plans.corner.rowRange}
                    colRange={renderPlan.plans.corner.colRange}
                    rowMetrics={virtualizer.rowMetrics}
                    colMetrics={virtualizer.colMetrics}
                    {sheetStore}
                    session={spreadsheetSession}
                    {selectionState}
                    {formulaEditState}
                    originX={HEADER_WIDTH}
                    originY={HEADER_HEIGHT}
                    clipWidth={renderPlan.frozenWidth}
                    clipHeight={renderPlan.frozenHeight}
                    offsetX={0}
                    offsetY={0}
                    onCellMouseDown={handleCellMouseDown}
                    onCellMouseEnter={handleCellMouseEnter}
                    onCellDoubleClick={handleCellDoubleClick}
                    onCellContextMenu={handleCellContextMenu}
                />
            {/if}
        </div>
    {/if}
</div>

{#if contextMenuVisible}
    <ContextMenu
        x={contextMenuPosition.x}
        y={contextMenuPosition.y}
        items={contextMenuItems}
        onClose={closeContextMenu}
    />
{/if}

<style>
    .grid-root {
        width: 100%;
        height: 100%;
        position: relative;
        overflow: hidden;
        user-select: none;
        background: var(--grid-bg, #fff);
    }

    .scroll-proxy {
        position: absolute;
        inset: 0;
        overflow: auto;
        z-index: 1;
    }

    .scroll-spacer {
        pointer-events: none;
    }

    .render-layer {
        position: absolute;
        inset: 0;
        z-index: 2;
        pointer-events: none;
    }

    .render-layer :global(.pane-clip),
    .render-layer :global(.col-headers-root),
    .render-layer :global(.row-headers-root),
    .corner-cell {
        pointer-events: auto;
    }

    .col-headers-layer,
    .row-headers-layer {
        position: absolute;
        overflow: hidden;
        z-index: 30;
    }

    .corner-cell {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 40;
        background: var(--header-bg, #f1f5f9);
        border-right: 1px solid var(--border-color, #e2e8f0);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        cursor: pointer;
    }

    .corner-cell:hover {
        background: var(--header-hover, #e2e8f0);
    }
</style>
