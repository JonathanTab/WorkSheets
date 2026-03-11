<script>
    /**
     * Grid.svelte — Canvas-based spreadsheet grid
     *
     * Architecture:
     *   1. <canvas>        (z:2) — all cell rendering, pointer-events:none
     *   2. dom-overlay     (z:3) — headers, selection border, anchor border,
     *                              editor (GridOverlays), filter popovers,
     *                              entry-cell inputs, viewport panels
     *   3. event-layer     (z:4) — native scroll container over cell area,
     *                              captures scroll + mouse → HitTestEngine
     */
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
    import {
        clipboardManager,
        editSessionState,
        CellTypeRegistry,
    } from "../../stores/spreadsheet/index.js";
    import { CELL_TYPE } from "../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
    import { CanvasRenderer } from "../../stores/spreadsheet/rendering/CanvasRenderer.js";
    import { RenderScheduler } from "../../stores/spreadsheet/rendering/RenderScheduler.js";
    import { HitTestEngine } from "../../stores/spreadsheet/rendering/HitTestEngine.js";
    import { buildPaneData } from "../../stores/spreadsheet/rendering/CellPaintData.js";
    import GridOverlays from "./grid/GridOverlays.svelte";
    import ColHeaders from "./grid/ColHeaders.svelte";
    import RowHeaders from "./grid/RowHeaders.svelte";
    import ContextMenu from "./ContextMenu.svelte";
    import TableViewport from "./features/TableViewport.svelte";
    import RepeaterViewport from "./features/RepeaterViewport.svelte";
    import TableFilterPopover from "./features/TableFilterPopover.svelte";
    import TableEntryCell from "./features/TableEntryCell.svelte";
    import TableCreateDialog from "./features/TableCreateDialog.svelte";
    import RepeaterCreateDialog from "./features/RepeaterCreateDialog.svelte";

    // ─── DOM refs ──────────────────────────────────────────────────────────────
    let containerEl = $state(null);
    let scrollEl = $state(null);
    let canvasEl = $state(null);

    // ─── Canvas rendering instances ───────────────────────────────────────────
    /** @type {CanvasRenderer|null} */
    let canvasRenderer = null;
    /** @type {RenderScheduler|null} */
    let renderScheduler = null;
    const hitTestEngine = new HitTestEngine();

    // ─── Grid virtualizer ─────────────────────────────────────────────────────
    let virtualizer = $state(null);
    let overlaysRef = $state(null);
    let virtualizerSheetId = $state.raw(null);
    let resizeObserver = null;

    // ─── Interaction state ────────────────────────────────────────────────────
    let isSelectingRange = $state(false);
    let rangeStartCell = $state(null);
    let rangeEndCell = $state(null);
    let resizing = $state(null);
    let currentCursor = $state("cell");

    // ─── Overlay state ────────────────────────────────────────────────────────
    /** @type {{ table:any, colId:string|null, left:number, top:number }|null} */
    let activeFilterPopover = $state(null);
    /** @type {{ table:any, colIndex:number, row:number, col:number, left:number, top:number, width:number, height:number }|null} */
    let focusedEntryCell = $state(null);

    // ─── Context menu ─────────────────────────────────────────────────────────
    let contextMenuVisible = $state(false);
    let contextMenuPosition = $state({ x: 0, y: 0 });

    // ─── Dialog state ─────────────────────────────────────────────────────────
    let showCreateTableDialog = $state(false);
    let showCreateRepeaterDialog = $state(false);

    // ─── Derived store state ──────────────────────────────────────────────────
    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let renderContext = $derived(spreadsheetSession.renderContext);
    let renderPlan = $derived(virtualizer ? virtualizer.renderPlan : null);
    let selection = $derived(selectionState.range);
    let anchor = $derived(selectionState.anchor);
    let isFormulaEditMode = $derived(editSessionState.isFormulaMode);

    let hasLoggedZeroViewportWarning = $state(false);

    // ─── Virtualizer configuration ─────────────────────────────────────────────
    $effect(() => {
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

        const sheetId = sheetStore.id;
        const rowCount =
            renderContext?.effectiveRowCount ?? sheetStore.rowCount;
        const colCount = sheetStore.colCount;
        const frozenRows = sheetStore.frozenRows;
        const frozenCols = sheetStore.frozenColumns;
        const rowMetaVersion = sheetStore.rowMetaVersion;
        const colMetaVersion = sheetStore.colMetaVersion;
        const defaultRowHeight = sheetStore.defaultRowHeight;
        const defaultColWidth = sheetStore.defaultColWidth;

        untrack(() => {
            if (!virtualizer || virtualizerSheetId !== sheetId) {
                if (virtualizer) virtualizer.destroy();
                virtualizer = new GridVirtualizer({
                    defaultRowHeight: defaultRowHeight ?? ROW_HEIGHT,
                    defaultColWidth: defaultColWidth ?? COL_WIDTH,
                });
                virtualizerSheetId = sheetId;
                if (containerEl) {
                    const rect = containerEl.getBoundingClientRect();
                    virtualizer.setContainerSize(rect.width, rect.height);
                }
            }

            virtualizer.setSheetDimensions(rowCount, colCount);
            virtualizer.setFrozenDimensions(frozenRows, frozenCols);

            const rowMeta = sheetStore.getYMap()?.get("rowMeta");
            const colMeta = sheetStore.getYMap()?.get("colMeta");

            const heights = new Map();
            if (rowMeta) {
                rowMeta.forEach((meta, key) => {
                    const h = meta.get("height");
                    if (h !== undefined) heights.set(parseInt(key, 10), h);
                });
            }
            virtualizer.syncRowHeights(heights);

            const widths = new Map();
            if (colMeta) {
                colMeta.forEach((meta, key) => {
                    const w = meta.get("width");
                    if (w !== undefined) widths.set(parseInt(key, 10), w);
                });
            }
            virtualizer.syncColWidths(widths);
        });
    });

    // ─── HitTestEngine sync ────────────────────────────────────────────────────
    $effect(() => {
        if (virtualizer) hitTestEngine.setVirtualizer(virtualizer);
    });

    // ─── Canvas setup & resize ─────────────────────────────────────────────────
    $effect(() => {
        if (!canvasEl || !virtualizer) return;

        const w = Math.max(0, virtualizer.containerWidth - HEADER_WIDTH);
        const h = Math.max(0, virtualizer.containerHeight - HEADER_HEIGHT);
        if (w <= 0 || h <= 0) return;

        if (!canvasRenderer) {
            canvasRenderer = new CanvasRenderer(canvasEl);
            renderScheduler = new RenderScheduler(performPaint);
        }

        canvasRenderer.resize(w, h);
        untrack(() => renderScheduler?.invalidateAll());
    });

    // ─── Main repaint trigger ─────────────────────────────────────────────────
    $effect(() => {
        // Touch reactive dependencies to track them
        const _cells = sheetStore?.cells;
        const _borders = sheetStore?.bordersVersion;
        const _mergeVer = renderContext?.mergeEngine?.version;
        const _plan = renderPlan;
        const _sel = selectionState.range;
        const _anch = selectionState.anchor;
        const _editing = editSessionState.isEditing;
        const _formula = formulaEditState?.currentValue;

        if (!renderPlan || !virtualizer) return;

        untrack(() => renderScheduler?.invalidateAll());
    });

    // ─── Warn on zero viewport ────────────────────────────────────────────────
    $effect(() => {
        if (!virtualizer || !renderPlan) return;
        const zeroH = renderPlan.bodyViewportHeight <= 0;
        if (zeroH && !hasLoggedZeroViewportWarning) {
            console.warn("[Grid] body viewport height is 0");
            hasLoggedZeroViewportWarning = true;
        } else if (!zeroH) {
            hasLoggedZeroViewportWarning = false;
        }
    });

    // ─── Paint function (called by RenderScheduler on RAF) ────────────────────
    function performPaint(_dirtyPanes) {
        if (!canvasEl || !canvasRenderer || !renderPlan || !virtualizer) return;

        const frozenRows = virtualizer.frozenRows;
        const frozenCols = virtualizer.frozenCols;
        const frozenHeight = renderPlan.frozenHeight;
        const frozenWidth = renderPlan.frozenWidth;
        const scrollLeft = virtualizer.scrollLeft;
        const scrollTop = virtualizer.scrollTop;

        const commonParams = {
            rowMetrics: virtualizer.rowMetrics,
            colMetrics: virtualizer.colMetrics,
            renderContext,
            sheetStore,
            session: spreadsheetSession,
            selectionState,
            formulaEditState,
            frozenRows,
            frozenCols,
            frozenHeight,
            frozenWidth,
        };

        canvasRenderer.clear();

        // Body pane
        const bp = renderPlan.plans.body;
        if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
            canvasRenderer.paintPane(
                buildPaneData({
                    ...commonParams,
                    rowRange: bp.rowRange,
                    colRange: bp.colRange,
                    scrollLeft,
                    scrollTop,
                }),
                {
                    clipX: frozenWidth,
                    clipY: frozenHeight,
                    clipW: renderPlan.bodyViewportWidth,
                    clipH: renderPlan.bodyViewportHeight,
                },
            );
        }

        // Top pane (frozen rows × scrollable cols)
        const tp = renderPlan.plans.top;
        if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
            canvasRenderer.paintPane(
                buildPaneData({
                    ...commonParams,
                    rowRange: tp.rowRange,
                    colRange: tp.colRange,
                    scrollLeft,
                    scrollTop: 0,
                }),
                {
                    clipX: frozenWidth,
                    clipY: 0,
                    clipW: renderPlan.bodyViewportWidth,
                    clipH: frozenHeight,
                },
            );
        }

        // Left pane (scrollable rows × frozen cols)
        const lp = renderPlan.plans.left;
        if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
            canvasRenderer.paintPane(
                buildPaneData({
                    ...commonParams,
                    rowRange: lp.rowRange,
                    colRange: lp.colRange,
                    scrollLeft: 0,
                    scrollTop,
                }),
                {
                    clipX: 0,
                    clipY: frozenHeight,
                    clipW: frozenWidth,
                    clipH: renderPlan.bodyViewportHeight,
                },
            );
        }

        // Corner pane (frozen rows × frozen cols)
        const cp = renderPlan.plans.corner;
        if (cp.rowRange.count > 0 && cp.colRange.count > 0) {
            canvasRenderer.paintPane(
                buildPaneData({
                    ...commonParams,
                    rowRange: cp.rowRange,
                    colRange: cp.colRange,
                    scrollLeft: 0,
                    scrollTop: 0,
                }),
                { clipX: 0, clipY: 0, clipW: frozenWidth, clipH: frozenHeight },
            );
        }

        // Sticky table headers (painted on canvas after all panes)
        const stickyHeaders = renderContext?.getStickyTableHeaders?.(
            virtualizer.scrollTop,
            renderPlan.frozenHeight,
            virtualizer.rowMetrics,
            virtualizer.colMetrics,
        );
        if (stickyHeaders?.length > 0) {
            // Attach computed column widths as a separate property
            const headersWithWidths = stickyHeaders.map((h) => ({
                ...h,
                colWidths: h.table.columns.map((_, i) =>
                    virtualizer.getColWidth(h.table.startCol + i),
                ),
            }));
            canvasRenderer.paintStickyHeaders(headersWithWidths, {
                frozenWidth,
                frozenHeight,
                scrollLeft,
                headerHeight: HEADER_HEIGHT,
            });
        }
    }

    // ─── Pixel-to-container coordinate helpers ────────────────────────────────
    function getLocalCoords(e) {
        const rect = containerEl?.getBoundingClientRect();
        if (!rect) return { localX: 0, localY: 0 };
        return { localX: e.clientX - rect.left, localY: e.clientY - rect.top };
    }

    function cellContainerLeft(col) {
        if (!virtualizer || !renderPlan) return HEADER_WIDTH;
        if (col < virtualizer.frozenCols) {
            return HEADER_WIDTH + virtualizer.colMetrics.offsetOf(col);
        }
        return (
            HEADER_WIDTH +
            renderPlan.frozenWidth +
            virtualizer.colMetrics.offsetOf(col) -
            virtualizer.scrollLeft
        );
    }

    function cellContainerTop(row) {
        if (!virtualizer || !renderPlan) return HEADER_HEIGHT;
        if (row < virtualizer.frozenRows) {
            return HEADER_HEIGHT + virtualizer.rowMetrics.offsetOf(row);
        }
        return (
            HEADER_HEIGHT +
            renderPlan.frozenHeight +
            virtualizer.rowMetrics.offsetOf(row) -
            virtualizer.scrollTop
        );
    }

    // ─── DOM overlay position deriveds ────────────────────────────────────────
    let selectionBorderStyle = $derived.by(() => {
        if (!selection || !virtualizer || !renderPlan) return null;
        const isSingle =
            selection.startRow === selection.endRow &&
            selection.startCol === selection.endCol;
        if (isSingle) return null; // anchor border covers single-cell case

        const left = cellContainerLeft(selection.startCol);
        const top = cellContainerTop(selection.startRow);
        const right =
            cellContainerLeft(selection.endCol) +
            virtualizer.getColWidth(selection.endCol);
        const bottom =
            cellContainerTop(selection.endRow) +
            virtualizer.getRowHeight(selection.endRow);

        return `left:${left}px; top:${top}px; width:${Math.max(0, right - left)}px; height:${Math.max(0, bottom - top)}px;`;
    });

    let anchorBorderStyle = $derived.by(() => {
        if (!anchor || !virtualizer || !renderPlan) return null;
        const left = cellContainerLeft(anchor.col);
        const top = cellContainerTop(anchor.row);
        const width = virtualizer.getColWidth(anchor.col);
        const height = virtualizer.getRowHeight(anchor.row);
        return `left:${left}px; top:${top}px; width:${width}px; height:${height}px;`;
    });

    let editorBoundsForOverlay = $derived.by(() => {
        if (!editSessionState.isEditing || !virtualizer || !renderPlan)
            return null;
        const row = editSessionState.cell?.row;
        const col = editSessionState.cell?.col;
        if (row == null || col == null || row < 0 || col < 0) return null;
        return {
            top: cellContainerTop(row),
            left: cellContainerLeft(col),
            width: virtualizer.getColWidth(col),
            height: virtualizer.getRowHeight(row),
        };
    });

    // ─── Column header helper ─────────────────────────────────────────────────
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

    // ─── Event layer handlers ─────────────────────────────────────────────────
    function handleEventLayerMouseDown(e) {
        if (e.button !== 0) return;
        const { localX, localY } = getLocalCoords(e);
        const hit = hitTestEngine.hitTest(localX, localY);

        switch (hit.region) {
            case "corner":
                handleCornerCellMouseDown();
                break;
            case "colHeader":
                handleColHeaderMouseDown(hit.col);
                break;
            case "rowHeader":
                handleRowHeaderMouseDown(hit.row);
                break;
            case "colResize":
                startColResize(hit.resizeCol, e);
                break;
            case "rowResize":
                startRowResize(hit.resizeRow, e);
                break;
            case "cell":
                if (hit.row >= 0 && hit.col >= 0) {
                    handleCellMouseDown(hit.row, hit.col, e);
                }
                break;
        }
    }

    function handleEventLayerMouseMove(e) {
        const { localX, localY } = getLocalCoords(e);
        const hit = hitTestEngine.hitTest(localX, localY);
        currentCursor = hitTestEngine.getCursor(hit);

        if (isFormulaEditMode && isSelectingRange && hit.region === "cell") {
            rangeEndCell = { row: hit.row, col: hit.col };
            return;
        }
        if (selectionState.isSelecting && hit.region === "cell") {
            selectionState.extendSelection(hit.row, hit.col);
        }
    }

    function handleEventLayerDblClick(e) {
        const { localX, localY } = getLocalCoords(e);
        const hit = hitTestEngine.hitTest(localX, localY);
        if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
            handleCellDoubleClick(hit.row, hit.col);
        }
    }

    function handleEventLayerContextMenu(e) {
        const { localX, localY } = getLocalCoords(e);
        const hit = hitTestEngine.hitTest(localX, localY);
        if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
            handleCellContextMenu(hit.row, hit.col, e);
        }
    }

    // ─── Header event handlers ────────────────────────────────────────────────
    function handleCornerCellMouseDown() {
        selectionState.selectAll();
    }

    function handleRowHeaderMouseDown(row) {
        selectionState.selectRow(row);
    }

    function handleColHeaderMouseDown(col) {
        selectionState.selectColumn(col);
    }

    // ─── Cell mouse events ────────────────────────────────────────────────────
    function handleCellMouseDown(row, col, e) {
        if (e.button !== 0) return;

        // Formula range selection mode
        if (isFormulaEditMode) {
            isSelectingRange = true;
            rangeStartCell = { row, col };
            rangeEndCell = { row, col };
            e.preventDefault();
            return;
        }

        // Commit any in-progress edit
        if (
            editSessionState.isEditing &&
            !editSessionState.isEditingCell(row, col)
        ) {
            commitCurrentEdit();
        }

        // Close open filter popover
        activeFilterPopover = null;

        // Close entry cell if clicking elsewhere
        if (
            focusedEntryCell &&
            (focusedEntryCell.row !== row || focusedEntryCell.col !== col)
        ) {
            focusedEntryCell = null;
        }

        const cellType = renderContext?.getCellType(row, col);

        // ── TABLE_HEADER: sort or filter popover ─────────────────────────────
        if (cellType === CELL_TYPE.TABLE_HEADER) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table) {
                const colIndex = info.table.colIndexForSheetCol?.(col) ?? 0;
                const colDef = info.table.columns?.[colIndex];

                if (colDef) {
                    const cellLeft = cellContainerLeft(col);
                    const cellWidth = virtualizer.getColWidth(col);
                    const relX =
                        e.clientX -
                        containerEl.getBoundingClientRect().left -
                        cellLeft;

                    if (relX > cellWidth - 22) {
                        // Filter icon area
                        const cellBottom =
                            cellContainerTop(row) +
                            virtualizer.getRowHeight(row);
                        activeFilterPopover = {
                            table: info.table,
                            colId: colDef.id,
                            left: cellLeft,
                            top: cellBottom,
                        };
                    } else {
                        // Sort toggle
                        if (info.table.sortColId === colDef.id) {
                            if (info.table.sortDir === "asc")
                                info.table.setSort(colDef.id, "desc");
                            else info.table.clearSort();
                        } else {
                            info.table.setSort(colDef.id, "asc");
                        }
                    }
                }
            }
            selectionState.startSelection(row, col);
            selectionState.endSelection();
            return;
        }

        // ── TABLE_ENTRY: show DOM input overlay ──────────────────────────────
        if (cellType === CELL_TYPE.TABLE_ENTRY) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table) {
                const colIndex = info.table.colIndexForSheetCol?.(col) ?? 0;
                focusedEntryCell = {
                    table: info.table,
                    colIndex,
                    row,
                    col,
                    left: cellContainerLeft(col),
                    top: cellContainerTop(row),
                    width: virtualizer.getColWidth(col),
                    height: virtualizer.getRowHeight(row),
                };
            }
            selectionState.startSelection(row, col);
            selectionState.endSelection();
            return;
        }

        // ── TABLE_DATA: special cell type clicks ─────────────────────────────
        if (cellType === CELL_TYPE.TABLE_DATA) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                const ct = info.colDef.ct;
                if (ct?.type === "checkbox") {
                    const cur = info.table.getValue(
                        info.dataIndex,
                        info.colDef.id,
                    );
                    info.table.updateCell(info.dataIndex, info.colDef.id, !cur);
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    return;
                }
                if (ct?.type === "rating") {
                    const cellLeft = cellContainerLeft(col);
                    const cellWidth = virtualizer.getColWidth(col);
                    const max = ct.max || 5;
                    const relX = Math.max(
                        0,
                        e.clientX -
                            containerEl.getBoundingClientRect().left -
                            cellLeft,
                    );
                    const newVal = Math.max(
                        1,
                        Math.min(max, Math.ceil(relX / (cellWidth / max))),
                    );
                    info.table.updateCell(
                        info.dataIndex,
                        info.colDef.id,
                        newVal,
                    );
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    return;
                }
            }
        }

        // ── Regular cell ──────────────────────────────────────────────────────
        if (e.shiftKey && anchor) {
            selectionState.extendSelection(row, col);
        } else {
            // Handle special cell type clicks (checkbox toggle, rating)
            if (handleRegularCellClick(row, col, e)) return;
            selectionState.startSelection(row, col);
        }
    }

    /**
     * Handle click for regular (non-table) cell type special interactions.
     * @returns {boolean} true if event was fully handled (stop further processing)
     */
    function handleRegularCellClick(row, col, e) {
        const ct = renderContext?.getCellTypeConfig(row, col);
        if (!ct) return false;

        if (ct.type === "checkbox") {
            const cell = sheetStore?.getCell(row, col);
            sheetStore?.setCellValue(row, col, !cell?.v);
            selectionState.startSelection(row, col);
            selectionState.endSelection();
            return true;
        }

        if (ct.type === "rating") {
            const cellLeft = cellContainerLeft(col);
            const cellWidth = virtualizer.getColWidth(col);
            const max = ct.max || 5;
            const relX = Math.max(
                0,
                e.clientX - containerEl.getBoundingClientRect().left - cellLeft,
            );
            const newVal = Math.max(
                1,
                Math.min(max, Math.ceil(relX / (cellWidth / max))),
            );
            sheetStore?.setCellValue(row, col, newVal);
            selectionState.startSelection(row, col);
            selectionState.endSelection();
            return true;
        }

        return false;
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
            editSessionState.insertReference(ref);
            isSelectingRange = false;
            rangeStartCell = null;
            rangeEndCell = null;
            return;
        }
        selectionState.endSelection();
    }

    function handleCellDoubleClick(row, col) {
        beginCellEdit(row, col, { surface: "grid" });
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

    // ─── Editing ──────────────────────────────────────────────────────────────
    function beginCellEdit(row, col, options = {}) {
        const { seedText = null, surface = "grid" } = options;
        const rawValue = spreadsheetSession.getCellEditValue(row, col);
        const ct = renderContext?.getCellTypeConfig(row, col);
        const pickerMode =
            ct?.type === "date"
                ? "date"
                : ct?.type === "time"
                  ? "time"
                  : ct?.type === "datetime"
                    ? "datetime-local"
                    : null;

        editSessionState.beginEdit(
            row,
            col,
            seedText !== null ? seedText : (rawValue ?? ""),
            surface,
            { pickerMode },
        );
    }

    function persistEdit(payload) {
        if (!payload || !sheetStore) return;
        const { row, col, value } = payload;
        if (value.startsWith("=")) {
            sheetStore.setCellFormula(row, col, value);
        } else {
            sheetStore.setCellValue(row, col, value);
        }
    }

    function commitCurrentEdit() {
        const payload = editSessionState.commit();
        if (!payload) return;
        persistEdit(payload);
    }

    function commitEditAndMove(dRow, dCol) {
        const payload = editSessionState.commit();
        if (!payload) return;
        persistEdit(payload);
        selectionState.moveSelection(dRow, dCol);
        scrollToAnchor();
    }

    function commitEdit() {
        commitCurrentEdit();
    }
    function cancelEdit() {
        editSessionState.cancel();
    }

    function handleEditInput(value, start, end) {
        editSessionState.updateDraft(value, start, end);
    }
    function handleEditSelect(start, end) {
        editSessionState.setCursor(start, end);
    }

    $effect(() => {
        editSessionState.setFocusHandle("grid", () =>
            overlaysRef?.focusEditor?.(),
        );
        return () => editSessionState.clearFocusHandle("grid");
    });

    $effect(() => {
        if (editSessionState.isEditing && editSessionState.surface === "grid") {
            editSessionState.requestFocus("grid");
        }
    });

    // ─── Resize (columns & rows) ──────────────────────────────────────────────
    function startColResize(col, e) {
        e.preventDefault();
        e.stopPropagation();

        let indices = [col];
        if (selection && col >= selection.startCol && col <= selection.endCol) {
            indices = [];
            for (let c = selection.startCol; c <= selection.endCol; c++)
                indices.push(c);
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
            for (let r = selection.startRow; r <= selection.endRow; r++)
                indices.push(r);
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
            const newWidth = Math.max(
                20,
                resizing.startSize + (e.clientX - resizing.startPos),
            );
            for (const idx of resizing.selectedIndices)
                virtualizer.setTempColWidth(idx, newWidth);
        } else {
            const newHeight = Math.max(
                10,
                resizing.startSize + (e.clientY - resizing.startPos),
            );
            for (const idx of resizing.selectedIndices)
                virtualizer.setTempRowHeight(idx, newHeight);
        }
    }

    function handleResizeEnd() {
        if (!resizing || !virtualizer || !sheetStore) return;
        if (resizing.type === "col") {
            const finalWidth = virtualizer.getColWidth(resizing.index);
            for (const idx of resizing.selectedIndices)
                sheetStore.setColWidth(idx, finalWidth);
            virtualizer.clearTempColWidths();
        } else {
            const finalHeight = virtualizer.getRowHeight(resizing.index);
            for (const idx of resizing.selectedIndices)
                sheetStore.setRowHeight(idx, finalHeight);
            virtualizer.clearTempRowHeights();
        }
        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
        resizing = null;
    }

    // ─── Scrolling ────────────────────────────────────────────────────────────
    let scrollPending = false;
    let pendingScrollTop = 0;
    let pendingScrollLeft = 0;

    function handleScroll(e) {
        if (!virtualizer) return;
        pendingScrollTop = e.target.scrollTop;
        pendingScrollLeft = e.target.scrollLeft;

        if (!scrollPending) {
            scrollPending = true;
            requestAnimationFrame(() => {
                if (virtualizer)
                    virtualizer.setScroll(pendingScrollTop, pendingScrollLeft);
                scrollPending = false;
            });
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

    // ─── Keyboard ─────────────────────────────────────────────────────────────
    function handleKeydown(e) {
        const target = e.target;
        const isInput =
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable;
        if (isInput) return;

        if (editSessionState.isEditing) {
            if (e.key === "Enter") {
                commitEditAndMove(1, 0);
                e.preventDefault();
            } else if (e.key === "Escape") {
                cancelEdit();
                e.preventDefault();
            } else if (e.key === "Tab") {
                commitEditAndMove(0, e.shiftKey ? -1 : 1);
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
                if (anchor)
                    beginCellEdit(anchor.row, anchor.col, { surface: "grid" });
                e.preventDefault();
                break;
            case "Delete":
            case "Backspace":
                clearSelection();
                e.preventDefault();
                break;
            case "z":
                if (e.ctrlKey || e.metaKey) {
                    e.shiftKey
                        ? spreadsheetSession.redo()
                        : spreadsheetSession.undo();
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
        }
    }

    // ─── Clipboard ────────────────────────────────────────────────────────────
    function copySelection() {
        if (sheetStore) clipboardManager.copy(sheetStore, spreadsheetSession);
    }
    function cutSelection() {
        if (sheetStore && spreadsheetSession.ydoc)
            clipboardManager.cut(
                sheetStore,
                spreadsheetSession,
                spreadsheetSession.ydoc,
            );
    }
    function pasteSelection(mode = "full") {
        if (sheetStore && spreadsheetSession.ydoc)
            clipboardManager.paste(
                sheetStore,
                spreadsheetSession,
                spreadsheetSession.ydoc,
                mode,
            );
    }

    function clearSelection() {
        if (!selection || !sheetStore) return;
        for (let r = selection.startRow; r <= selection.endRow; r++)
            for (let c = selection.startCol; c <= selection.endCol; c++)
                sheetStore.clearCell(r, c);
    }

    // ─── Row / Column insert / delete ─────────────────────────────────────────
    function insertRowAbove() {
        if (sheetStore && selection) sheetStore.insertRowAt(selection.startRow);
    }
    function insertRowBelow() {
        if (sheetStore && selection)
            sheetStore.insertRowAt(selection.endRow + 1);
    }
    function insertColumnLeft() {
        if (sheetStore && selection)
            sheetStore.insertColumnAt(selection.startCol);
    }
    function insertColumnRight() {
        if (sheetStore && selection)
            sheetStore.insertColumnAt(selection.endCol + 1);
    }

    function deleteSelectedRows() {
        if (!sheetStore || !selection) return;
        for (let row = selection.endRow; row >= selection.startRow; row--)
            sheetStore.deleteRowAt(row);
    }
    function deleteSelectedColumns() {
        if (!sheetStore || !selection) return;
        for (let col = selection.endCol; col >= selection.startCol; col--)
            sheetStore.deleteColumnAt(col);
    }

    // ─── Merge ────────────────────────────────────────────────────────────────
    let canMerge = $derived(
        selection &&
            (selection.startRow !== selection.endRow ||
                selection.startCol !== selection.endCol),
    );
    let isMergePrimary = $derived.by(() => {
        if (!anchor || !sheetStore?.mergeEngine) return false;
        return sheetStore.mergeEngine.isMergePrimary(anchor.row, anchor.col);
    });

    // ─── Table / Repeater context (for context menu) ──────────────────────────
    let tableCellInfo = $derived.by(() => {
        if (!anchor || !spreadsheetSession.tableManager) return null;
        return spreadsheetSession.tableManager.getCellInfo(
            anchor.row,
            anchor.col,
        );
    });
    let repeaterContext = $derived.by(() => {
        if (!anchor || !spreadsheetSession.repeaterEngine) return null;
        return spreadsheetSession.repeaterEngine.getCellRepeaterContext(
            anchor.row,
            anchor.col,
        );
    });

    function tableInsertRow() {
        if (tableCellInfo?.rowType === "data")
            tableCellInfo.table.insertRow({});
    }
    function tableDeleteRow() {
        if (tableCellInfo?.rowType === "data")
            tableCellInfo.table.deleteRow(tableCellInfo.dataIndex);
    }
    function tableSortAsc() {
        if (tableCellInfo?.colDef)
            tableCellInfo.table.setSort(tableCellInfo.colDef.id, "asc");
    }
    function tableSortDesc() {
        if (tableCellInfo?.colDef)
            tableCellInfo.table.setSort(tableCellInfo.colDef.id, "desc");
    }
    function tableClearSort() {
        if (tableCellInfo) tableCellInfo.table.clearSort();
    }
    function tableDelete() {
        if (tableCellInfo && spreadsheetSession.tableManager)
            spreadsheetSession.tableManager.deleteTable(tableCellInfo.table.id);
    }
    function repeaterAddOne() {
        if (repeaterContext)
            repeaterContext.repeater.setCount(
                Math.min(100, repeaterContext.repeater.count + 1),
            );
    }
    function repeaterRemoveOne() {
        if (repeaterContext)
            repeaterContext.repeater.setCount(
                Math.max(1, repeaterContext.repeater.count - 1),
            );
    }
    function repeaterDelete() {
        if (repeaterContext && spreadsheetSession.repeaterEngine)
            spreadsheetSession.repeaterEngine.deleteRepeater(
                repeaterContext.repeater.id,
            );
    }

    let selectionType = $derived.by(() => {
        if (!selection || !sheetStore) return "none";
        const isSingle =
            selection.startRow === selection.endRow &&
            selection.startCol === selection.endCol;
        const isFullRow =
            selection.startCol === 0 &&
            selection.endCol === sheetStore.colCount - 1;
        const isFullCol =
            selection.startRow === 0 &&
            selection.endRow === sheetStore.rowCount - 1;
        if (isSingle) return "cell";
        if (isFullRow) return "row";
        if (isFullCol) return "column";
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
            label: "Merge Cells",
            icon: "⊞",
            action: () => {
                if (selection && sheetStore)
                    sheetStore.mergeCells(
                        selection.startRow,
                        selection.startCol,
                        selection.endRow,
                        selection.endCol,
                    );
            },
            disabled: !canMerge,
        },
        {
            label: "Unmerge Cells",
            icon: "⊞",
            action: () => {
                if (anchor && sheetStore)
                    sheetStore.unmergeCells(anchor.row, anchor.col);
            },
            disabled: !isMergePrimary,
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
                    ? `Delete ${selection?.endRow - selection?.startRow + 1} Rows`
                    : "Delete Row",
            icon: "🗑",
            action: deleteSelectedRows,
            disabled: !selection,
        },
        {
            label:
                selectionType === "column"
                    ? `Delete ${selection?.endCol - selection?.startCol + 1} Columns`
                    : "Delete Column",
            icon: "🗑",
            action: deleteSelectedColumns,
            disabled: !selection,
        },
        ...(tableCellInfo
            ? [
                  { divider: true },
                  { label: "Table Actions", icon: "⊞", disabled: true },
                  ...(tableCellInfo.rowType === "data"
                      ? [
                            { label: "Insert Row", action: tableInsertRow },
                            { label: "Delete Row", action: tableDeleteRow },
                        ]
                      : []),
                  ...(tableCellInfo.colDef
                      ? [
                            { label: "Sort Ascending", action: tableSortAsc },
                            { label: "Sort Descending", action: tableSortDesc },
                            { label: "Clear Sort", action: tableClearSort },
                        ]
                      : []),
                  { label: "Delete Table", icon: "🗑", action: tableDelete },
              ]
            : []),
        ...(repeaterContext
            ? [
                  { divider: true },
                  { label: "Repeater Actions", icon: "↻", disabled: true },
                  {
                      label: `Repetitions: ${repeaterContext.repeater.count}`,
                      disabled: true,
                  },
                  {
                      label: "+1 Repetition",
                      action: repeaterAddOne,
                      disabled: repeaterContext.repeater.count >= 100,
                  },
                  {
                      label: "−1 Repetition",
                      action: repeaterRemoveOne,
                      disabled: repeaterContext.repeater.count <= 1,
                  },
                  {
                      label: "Delete Repeater",
                      icon: "🗑",
                      action: repeaterDelete,
                  },
              ]
            : []),
        ...(!tableCellInfo && !repeaterContext && selection
            ? [
                  { divider: true },
                  {
                      label: "Create Table Here",
                      icon: "⊞",
                      action: () => {
                          showCreateTableDialog = true;
                      },
                  },
                  {
                      label: "Create Repeater",
                      icon: "↻",
                      action: () => {
                          showCreateRepeaterDialog = true;
                      },
                  },
              ]
            : []),
    ]);

    // ─── Spacer ───────────────────────────────────────────────────────────────
    // The event-layer starts at (HEADER_WIDTH, HEADER_HEIGHT), so the spacer
    // only needs to cover totalWidth × totalHeight — no header offset needed.
    // This makes native scrollLeft/scrollTop map 1:1 to virtualizer values.
    function spacerStyle() {
        if (!renderPlan) return "";
        return `width:${renderPlan.totalWidth}px; height:${renderPlan.totalHeight}px;`;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────
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
                        if (virtualizer)
                            virtualizer.setContainerSize(width, height);
                    }
                    resizeTicking = false;
                });
            });
            resizeObserver.observe(containerEl);

            const rect = containerEl.getBoundingClientRect();
            if (virtualizer)
                virtualizer.setContainerSize(rect.width, rect.height);
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
        renderScheduler?.destroy();
        canvasRenderer?.destroy();
    });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="grid-root" bind:this={containerEl}>
    {#if renderPlan && virtualizer}
        <!-- ── 1. Canvas layer (all cell rendering) ── -->
        <canvas
            bind:this={canvasEl}
            class="grid-canvas"
            style="position:absolute; left:{HEADER_WIDTH}px; top:{HEADER_HEIGHT}px; pointer-events:none;"
        ></canvas>

        <!-- ── 2. DOM overlay layer ── -->
        <div class="dom-overlay-layer">
            <!-- Corner (select-all) -->
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

            <!-- Column headers -->
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

            <!-- Row headers -->
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

            <!-- Selection border (multi-cell) — fill is on canvas -->
            {#if selectionBorderStyle}
                <div
                    class="selection-border"
                    style={selectionBorderStyle}
                ></div>
            {/if}

            <!-- Anchor border -->
            {#if anchorBorderStyle}
                <div class="anchor-border" style={anchorBorderStyle}></div>
            {/if}

            <!-- Cell editor (GridOverlays: input + formula overlay + FormulaValuePopup) -->
            <GridOverlays
                bind:this={overlaysRef}
                editorBounds={editorBoundsForOverlay}
                isEditing={editSessionState.isEditing}
                editValue={editSessionState.draft}
                onEditInput={handleEditInput}
                onEditSelect={handleEditSelect}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
            />

            <!-- Table filter popovers -->
            {#if activeFilterPopover}
                <div
                    class="filter-popover-anchor"
                    style="position:absolute; left:{activeFilterPopover.left}px; top:{activeFilterPopover.top}px; z-index:50;"
                >
                    <TableFilterPopover
                        table={activeFilterPopover.table}
                        colId={activeFilterPopover.colId}
                        onClose={() => (activeFilterPopover = null)}
                    />
                </div>
            {/if}

            <!-- Table entry cell DOM input (shown when focused) -->
            {#if focusedEntryCell}
                <div
                    class="entry-cell-overlay"
                    style="position:absolute; left:{focusedEntryCell.left}px; top:{focusedEntryCell.top}px; width:{focusedEntryCell.width}px; height:{focusedEntryCell.height}px; z-index:22;"
                >
                    <TableEntryCell
                        table={focusedEntryCell.table}
                        colIndex={focusedEntryCell.colIndex}
                        width={focusedEntryCell.width}
                        height={focusedEntryCell.height}
                    />
                </div>
            {/if}

            <!-- Viewport-mode table/repeater panels (keep as DOM) -->
            {#if renderContext}
                {#each renderContext.viewportPanels ?? [] as panel}
                    {@const rect = virtualizer.getCellRangeRect(
                        panel.startRow,
                        panel.startCol,
                        panel.endRow,
                        panel.endCol,
                    )}
                    {#if rect}
                        {@const isFrozenRow =
                            panel.startRow < virtualizer.frozenRows}
                        {@const isFrozenCol =
                            panel.startCol < virtualizer.frozenCols}
                        <div
                            class="viewport-panel"
                            style="position:absolute;
                                   left:{HEADER_WIDTH +
                                rect.x -
                                (isFrozenCol ? 0 : virtualizer.scrollLeft)}px;
                                   top:{HEADER_HEIGHT +
                                rect.y -
                                (isFrozenRow ? 0 : virtualizer.scrollTop)}px;
                                   width:{rect.width}px; height:{rect.height}px;
                                   z-index:20; overflow:hidden; pointer-events:auto;"
                        >
                            {#if panel.type === "table"}
                                <TableViewport
                                    table={panel.store}
                                    width={rect.width}
                                    height={rect.height}
                                />
                            {:else if panel.type === "repeater"}
                                <RepeaterViewport
                                    repeater={panel.store}
                                    session={spreadsheetSession}
                                    width={rect.width}
                                    height={rect.height}
                                />
                            {/if}
                        </div>
                    {/if}
                {/each}
            {/if}
        </div>
        <!-- end dom-overlay-layer -->

        <!-- ── 3. Event layer — native scroll container + mouse capture ── -->
        <!--
            This element serves dual purpose:
            1. overflow:scroll → native scrollbars, browser-physics momentum,
               flick/throw inertia, touch pan, and overscroll-behavior:contain
               prevents the scroll chain from reaching the body (no bounce).
            2. mouse event handlers → HitTestEngine → cell interactions.

            Spacer size: totalWidth × totalHeight (no +HEADER offsets because
            this element starts at HEADER_WIDTH / HEADER_HEIGHT already).
            Native scrollLeft/scrollTop map 1:1 to virtualizer.scrollLeft/Top.
        -->
        <div
            class="event-layer"
            bind:this={scrollEl}
            style="position:absolute; left:{HEADER_WIDTH}px; top:{HEADER_HEIGHT}px; right:0; bottom:0; z-index:4; cursor:{currentCursor};"
            onscroll={handleScroll}
            onmousedown={handleEventLayerMouseDown}
            onmousemove={handleEventLayerMouseMove}
            ondblclick={handleEventLayerDblClick}
            oncontextmenu={handleEventLayerContextMenu}
        >
            <div class="scroll-spacer" style={spacerStyle()}></div>
        </div>
    {/if}
</div>

<!-- Context menu (portalled) -->
{#if contextMenuVisible}
    <ContextMenu
        x={contextMenuPosition.x}
        y={contextMenuPosition.y}
        items={contextMenuItems}
        onClose={closeContextMenu}
    />
{/if}

{#if showCreateTableDialog}
    <TableCreateDialog onClose={() => (showCreateTableDialog = false)} />
{/if}

{#if showCreateRepeaterDialog}
    <RepeaterCreateDialog onClose={() => (showCreateRepeaterDialog = false)} />
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

    /* ── Canvas (z:1 inside grid-root, but below overlays) ── */
    .grid-canvas {
        z-index: 2;
        display: block; /* prevent inline baseline gap */
    }

    /* ── DOM overlay layer (z:3) ── */
    .dom-overlay-layer {
        position: absolute;
        inset: 0;
        z-index: 3;
        pointer-events: none; /* children opt in via pointer-events:auto */
        overflow: hidden;
    }

    /* ── Event layer (z:4) — native scroll container ── */
    .event-layer {
        overflow: scroll;
        /* Contain scroll so it never bubbles to the body (no overscroll bounce) */
        overscroll-behavior: contain;
        /* Allow touch pan gestures — the browser will natively scroll this element */
        touch-action: pan-x pan-y;
        pointer-events: auto;
        /* Firefox thin scrollbar */
        scrollbar-width: thin;
        scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
    }

    /* WebKit/Chrome/Safari scrollbars on the event layer */
    .event-layer::-webkit-scrollbar {
        width: 10px;
        height: 10px;
    }
    .event-layer::-webkit-scrollbar-thumb {
        background: rgba(0, 0, 0, 0.3);
        border-radius: 5px;
        border: 2px solid transparent;
        background-clip: padding-box;
    }
    .event-layer::-webkit-scrollbar-thumb:hover {
        background: rgba(0, 0, 0, 0.5);
        border: 2px solid transparent;
        background-clip: padding-box;
    }
    .event-layer::-webkit-scrollbar-track {
        background: transparent;
    }
    .event-layer::-webkit-scrollbar-corner {
        background: transparent;
    }

    /* Scroll spacer — sets the scrollable content size; invisible */
    .scroll-spacer {
        pointer-events: none;
        user-select: none;
    }

    /* ── Corner cell ── */
    .corner-cell {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 40;
        background: var(--header-bg, #f1f5f9);
        border-right: 1px solid var(--border-color, #e2e8f0);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        cursor: pointer;
        pointer-events: auto;
    }
    .corner-cell:hover {
        background: var(--header-hover, #e2e8f0);
    }

    /* ── Header layers ── */
    .col-headers-layer,
    .row-headers-layer {
        position: absolute;
        overflow: hidden;
        z-index: 30;
        pointer-events: auto;
    }

    /* ── Selection border (outline only — fill is on canvas) ── */
    .selection-border {
        position: absolute;
        border: 2px solid var(--selection-border, #3b82f6);
        pointer-events: none;
        z-index: 10;
        box-sizing: border-box;
    }

    /* ── Anchor border ── */
    .anchor-border {
        position: absolute;
        border: 2px solid var(--anchor-border, #3b82f6);
        pointer-events: none;
        z-index: 11;
        box-sizing: border-box;
    }

    /* ── Entry cell overlay ── */
    .entry-cell-overlay {
        pointer-events: auto;
        overflow: hidden;
    }

    /* ── Filter popover anchor ── */
    .filter-popover-anchor {
        pointer-events: auto;
    }
</style>
