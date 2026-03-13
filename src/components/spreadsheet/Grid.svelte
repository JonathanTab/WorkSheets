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
        cut as cutIcon,
        copy as copyIcon,
        paste as pasteIcon,
        trash as trashIcon,
        settings as settingsIcon,
        arrowUp,
        arrowDown,
        arrowLeft,
        arrowRight,
        merge as mergeIcon,
        repeat as repeatIcon,
        table as tableIcon,
        plus as plusIcon,
        close as closeIcon,
        enter as enterIcon,
    } from "../../lib/icons/index.js";
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
    import TableFilterPopover from "./features/TableFilterPopover.svelte";
    import TableEntryCell from "./features/TableEntryCell.svelte";
    import TableCreateDialog from "./features/TableCreateDialog.svelte";
    import RepeaterCreateDialog from "./features/RepeaterCreateDialog.svelte";
    import RepeaterEditPanel from "./features/RepeaterEditPanel.svelte";
    import TableEditPanel from "./features/TableEditPanel.svelte";
    import TableColumnPanel from "./features/TableColumnPanel.svelte";

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

    // ─── Filter popover position (with boundary detection) ───────────────────
    let filterPopoverPosition = $state(null);

    /**
     * Calculate position for filter popover, ensuring it stays within viewport.
     */
    function calculateFilterPopoverPosition(cellLeft, cellTop, cellWidth) {
        if (!containerEl) return { left: cellLeft, top: cellTop };

        const containerRect = containerEl.getBoundingClientRect();
        const popoverWidth = 240; // max-width from TableFilterPopover styles
        const popoverHeight = 300; // approximate height
        const margin = 8;

        let left = cellLeft;
        let top = cellTop;

        // Check right edge - if popover would go off right side, align to right edge of cell
        const rightEdge = left + popoverWidth;
        const containerRight = containerRect.width;
        if (rightEdge > containerRight - margin) {
            left = cellLeft + cellWidth - popoverWidth;
        }

        // Check left edge
        if (left < margin) {
            left = margin;
        }

        // Check bottom edge - if would go off screen, position above the header instead
        const bottomEdge = top + popoverHeight;
        const containerBottom = containerRect.height;
        if (bottomEdge > containerBottom - margin) {
            // Position above the header row (top is already at header bottom)
            top = cellTop - popoverHeight - 24 - margin; // 24 is approx header height
            // If still too low, clamp to available space
            if (top < margin) {
                top = margin;
            }
        }

        return { left: Math.round(left), top: Math.round(top) };
    }

    // ─── Edit panel position (with boundary detection) ────────────────────────
    /** @type {{ x: number, y: number }|null} */
    let editPanelPosition = $state(null);
    let editPanelEl = $state(null);

    /**
     * Calculate position for edit panel, ensuring it stays within viewport.
     * @param {'table'|'repeater'} type
     * @param {any} store
     * @returns {{ x: number, y: number }}
     */
    function calculateEditPanelPosition(type, store) {
        if (!containerEl || !virtualizer || !renderPlan) return { x: 0, y: 0 };

        const containerRect = containerEl.getBoundingClientRect();
        const panelWidth = type === "table" ? 250 : 240;
        const panelMaxHeight = window.innerHeight * 0.8;
        const margin = 8;

        let anchorRight, anchorTop;

        if (type === "repeater") {
            const rect = rangeOutlineStyle(
                store.templateStartRow,
                store.templateStartCol,
                store.inlineEndRow,
                store.inlineEndCol,
            );
            if (!rect) return { x: 0, y: 0 };
            anchorRight = rect.left + rect.width;
            anchorTop = rect.top;
        } else {
            const endRow = store.startRow + 1 + store.sortedFilteredRows.length;
            const rect = rangeOutlineStyle(
                store.startRow,
                store.startCol,
                endRow,
                store.endCol,
            );
            if (!rect) return { x: 0, y: 0 };
            anchorRight = rect.left + rect.width;
            anchorTop = rect.top;
        }

        // Adjusted position (below the settings button)
        let x = anchorRight;
        let y = anchorTop + 26;

        // Check right edge - if panel would go off right side, flip to left
        const rightEdge = x + panelWidth;
        const containerRight = containerRect.width;
        if (rightEdge > containerRight - margin) {
            // Flip to left side of the anchor
            x = anchorRight - panelWidth - margin;
        }

        // Check left edge
        if (x < margin) {
            x = margin;
        }

        // Check bottom edge
        const bottomEdge = y + panelMaxHeight;
        const containerBottom = containerRect.height;
        if (bottomEdge > containerBottom - margin) {
            // Try to position above the anchor instead
            y = anchorTop - panelMaxHeight - margin;
            // If still too low, just clamp to bottom
            if (y + panelMaxHeight > containerBottom - margin) {
                y = containerBottom - panelMaxHeight - margin;
            }
        }

        // Check top edge
        if (y < margin) {
            y = margin;
        }

        return { x: Math.round(x), y: Math.round(y) };
    }

    // Recalculate position when activeEditPanel changes
    $effect(() => {
        if (activeEditPanel && containerEl && virtualizer && renderPlan) {
            editPanelPosition = calculateEditPanelPosition(
                activeEditPanel.type,
                activeEditPanel.store,
            );
        } else {
            editPanelPosition = null;
        }
    });

    // Recalculate filter popover position when it changes
    $effect(() => {
        if (activeFilterPopover && containerEl && virtualizer) {
            const cellWidth = virtualizer.getColWidth(
                activeFilterPopover.table.startCol +
                    activeFilterPopover.table.columns.findIndex(
                        (c) => c.id === activeFilterPopover.colId,
                    ),
            );
            filterPopoverPosition = calculateFilterPopoverPosition(
                activeFilterPopover.left,
                activeFilterPopover.top,
                cellWidth,
            );
        } else {
            filterPopoverPosition = null;
        }
    });
    /** @type {{ table:any, colIndex:number, row:number, col:number, left:number, top:number, width:number, height:number }|null} */
    let focusedEntryCell = $state(null);
    /** @type {{ table:any, dataIndex:number, colDef:any, row:number, col:number, left:number, top:number, width:number, height:number }|null} */
    let focusedTableDataCell = $state(null);
    /** @type {{ type: 'table'|'repeater', store:any }|null} */
    let activeEditPanel = $state(null);
    /** @type {{ table:any, colId:string, left:number, top:number }|null} */
    let activeColumnConfig = $state(null);

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
    let rowCount = $derived(sheetStore?.rowCount ?? 0);
    let colCount = $derived(sheetStore?.colCount ?? 0);

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
        // Touch reactive dependencies to track them.
        // NOTE: we track cellsVersion (not sheetStore.cells) because Svelte 5 does
        // not detect Map.set/delete mutations via a plain reference read.
        const _cellsVer = sheetStore?.cellsVersion;
        const _borders = sheetStore?.bordersVersion;
        const _mergeVer = renderContext?.mergeEngine?.version;
        // Table and repeater version counters trigger repaints on structure changes
        const _tableVer = renderContext?.tableManager?.tableVersion;
        const _repVer = renderContext?.repeaterEngine?.repeaterVersion;
        const _plan = renderPlan;
        const _sel = selectionState.range;
        const _selMode = selectionState.selectionMode;
        const _selRows = selectionState.selectedRows;
        const _selCols = selectionState.selectedCols;
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
        // Use the merge-expanded range for the selection border
        const eff = expandedRange;
        if (!eff || !virtualizer || !renderPlan) return null;
        const isSingle =
            eff.startRow === eff.endRow && eff.startCol === eff.endCol;
        if (isSingle) return null; // anchor border covers single-cell case

        const left = cellContainerLeft(eff.startCol);
        const top = cellContainerTop(eff.startRow);
        const right =
            cellContainerLeft(eff.endCol) + virtualizer.getColWidth(eff.endCol);
        const bottom =
            cellContainerTop(eff.endRow) + virtualizer.getRowHeight(eff.endRow);

        return `left:${left}px; top:${top}px; width:${Math.max(0, right - left)}px; height:${Math.max(0, bottom - top)}px;`;
    });

    let anchorBorderStyle = $derived.by(() => {
        if (!anchor || !virtualizer || !renderPlan) return null;

        // If the anchor is inside a merge, draw the border around the full merge span
        const mergeEngine = renderContext?.mergeEngine;
        if (mergeEngine?.isMergeCell(anchor.row, anchor.col)) {
            const merge = mergeEngine.getMergeAt(anchor.row, anchor.col);
            if (merge) {
                const left = cellContainerLeft(merge.startCol);
                const top = cellContainerTop(merge.startRow);
                let width = 0;
                for (let c = merge.startCol; c <= merge.endCol; c++)
                    width += virtualizer.getColWidth(c);
                let height = 0;
                for (let r = merge.startRow; r <= merge.endRow; r++)
                    height += virtualizer.getRowHeight(r);
                return `left:${left}px; top:${top}px; width:${width}px; height:${height}px;`;
            }
        }

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

        // If editing a merged cell, span the entire merged area
        const mergeEngine = renderContext?.mergeEngine;
        if (mergeEngine?.isMergePrimary(row, col)) {
            const merge = mergeEngine.getMergeAt(row, col);
            if (merge) {
                const top = cellContainerTop(merge.startRow);
                const left = cellContainerLeft(merge.startCol);
                let width = 0;
                for (let c = merge.startCol; c <= merge.endCol; c++)
                    width += virtualizer.getColWidth(c);
                let height = 0;
                for (let r = merge.startRow; r <= merge.endRow; r++)
                    height += virtualizer.getRowHeight(r);
                return { top, left, width, height };
            }
        }

        return {
            top: cellContainerTop(row),
            left: cellContainerLeft(col),
            width: virtualizer.getColWidth(col),
            height: virtualizer.getRowHeight(row),
        };
    });

    // ─── Range outline + edit button (table / repeater) ──────────────────────

    /**
     * Build a CSS position style string spanning row/col ranges.
     */
    function rangeOutlineStyle(startRow, startCol, endRow, endCol) {
        if (!virtualizer || !renderPlan) return null;
        const left = cellContainerLeft(startCol);
        const top = cellContainerTop(startRow);
        const right =
            cellContainerLeft(endCol) + virtualizer.getColWidth(endCol);
        const bottom =
            cellContainerTop(endRow) + virtualizer.getRowHeight(endRow);
        const w = Math.max(0, right - left);
        const h = Math.max(0, bottom - top);
        if (w <= 0 || h <= 0) return null;
        return { left, top, width: w, height: h };
    }

    /**
     * Insert button info for the active entry row.
     * Shown below the entry row when the user is focused on an entry cell.
     */
    let entryInsertButtonInfo = $derived.by(() => {
        if (!focusedEntryCell || !virtualizer || !renderPlan) return null;
        const tbl = focusedEntryCell.table;
        const entryRow = tbl.startRow + 1;
        const top =
            cellContainerTop(entryRow) + virtualizer.getRowHeight(entryRow);
        const left = cellContainerLeft(tbl.startCol);
        let width = 0;
        for (let c = tbl.startCol; c <= tbl.endCol; c++) {
            width += virtualizer.getColWidth(c);
        }
        return { table: tbl, top, left, width };
    });

    /**
     * All visible table outlines (subtle, always-on, pointer-events:none).
     */
    let allTableOutlines = $derived.by(() => {
        if (!renderContext?.tableManager || !virtualizer || !renderPlan)
            return [];
        const result = [];
        for (const table of renderContext.tableManager.stores.values()) {
            const endRow = table.startRow + 1 + table.sortedFilteredRows.length;
            const rect = rangeOutlineStyle(
                table.startRow,
                table.startCol,
                endRow,
                table.endCol,
            );
            if (rect) result.push({ table, rect });
        }
        return result;
    });

    /**
     * All visible repeater outlines (subtle, always-on, pointer-events:none).
     */
    let allRepeaterOutlines = $derived.by(() => {
        if (!renderContext?.repeaterEngine || !virtualizer || !renderPlan)
            return [];
        const result = [];
        for (const rep of renderContext.repeaterEngine.stores.values()) {
            const rect = rangeOutlineStyle(
                rep.templateStartRow,
                rep.templateStartCol,
                rep.inlineEndRow,
                rep.inlineEndCol,
            );
            if (rect) result.push({ repeater: rep, rect });
        }
        return result;
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

    /**
     * Expand a selection range to fully encompass every merged region it overlaps.
     * Iterates until stable (handles chains of merges).
     * @param {{startRow,endRow,startCol,endCol}|null} range
     * @param {import('../../stores/spreadsheet/features/MergeEngine.svelte.js').MergeEngine|null|undefined} mergeEngine
     * @returns {{startRow,endRow,startCol,endCol}|null}
     */
    function expandRangeForMerges(range, mergeEngine) {
        if (!range || !mergeEngine || mergeEngine.merges.length === 0)
            return range;
        let { startRow, endRow, startCol, endCol } = range;
        let changed = true;
        while (changed) {
            changed = false;
            for (const m of mergeEngine.merges) {
                if (
                    m.startRow <= endRow &&
                    m.endRow >= startRow &&
                    m.startCol <= endCol &&
                    m.endCol >= startCol
                ) {
                    if (m.startRow < startRow) {
                        startRow = m.startRow;
                        changed = true;
                    }
                    if (m.endRow > endRow) {
                        endRow = m.endRow;
                        changed = true;
                    }
                    if (m.startCol < startCol) {
                        startCol = m.startCol;
                        changed = true;
                    }
                    if (m.endCol > endCol) {
                        endCol = m.endCol;
                        changed = true;
                    }
                }
            }
        }
        return { startRow, endRow, startCol, endCol };
    }

    /**
     * For a cell click: if the cell is inside a merge, return the primary cell coords.
     * Otherwise return the original coords.
     */
    function snapToMergePrimary(row, col) {
        const mergeEngine = renderContext?.mergeEngine;
        if (!mergeEngine) return { row, col };
        const merge = mergeEngine.getMergeAt(row, col);
        if (merge) return { row: merge.startRow, col: merge.startCol };
        return { row, col };
    }

    // Expanded range for selection border (covers all touched merges)
    let expandedRange = $derived.by(() => {
        if (selectionState.selectionMode !== "range") return null;
        const range = selectionState.range;
        if (!range) return null;
        return expandRangeForMerges(range, renderContext?.mergeEngine) ?? range;
    });

    function isSelected(row, col) {
        return selectionState.isSelected(row, col, rowCount, colCount);
    }
    function isRowSelected(row) {
        return selectionState.isRowHighlighted(row);
    }
    function isColSelected(col) {
        return selectionState.isColHighlighted(col);
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

        // Close table data cell edit if clicking elsewhere
        if (
            focusedTableDataCell &&
            (focusedTableDataCell.row !== row ||
                focusedTableDataCell.col !== col)
        ) {
            focusedTableDataCell = null;
        }

        const cellType = renderContext?.getCellType(row, col);

        // ── REPEATER non-template: block editing, just select ─────────────────
        if (cellType === CELL_TYPE.REPEATER) {
            const repCtx =
                renderContext?.repeaterEngine?.getCellRepeaterContext(row, col);
            if (repCtx && repCtx.repIndex > 0) {
                // Non-template repetition — not editable
                if (!e.shiftKey) {
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                } else if (anchor) {
                    selectionState.extendSelection(row, col);
                }
                return;
            }
            // repIndex === 0 — template cell, falls through to regular editing
        }

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
                let colIndex = info.table.colIndexForSheetCol?.(col) ?? 0;
                // If clicked on formula col, jump to first editable col
                if (info.table.columns?.[colIndex]?.isNonEntry) {
                    const firstEditable = info.table.columns.findIndex(
                        (c) => !c.isNonEntry,
                    );
                    if (firstEditable >= 0) colIndex = firstEditable;
                }
                const sheetCol = info.table.startCol + colIndex;
                focusedEntryCell = {
                    table: info.table,
                    colIndex,
                    row,
                    col: sheetCol,
                    left: cellContainerLeft(sheetCol),
                    top: cellContainerTop(row),
                    width: virtualizer.getColWidth(sheetCol),
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
                const colType = info.colDef.type;
                if (colType === "checkbox") {
                    const cur = info.table.getValue(
                        info.dataIndex,
                        info.colDef.id,
                    );
                    info.table.updateCell(info.dataIndex, info.colDef.id, !cur);
                    // Force canvas repaint for table cell data changes
                    untrack(() => renderScheduler?.invalidateAll());
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    return;
                }
                if (colType === "rating") {
                    const cellLeft = cellContainerLeft(col);
                    const cellWidth = virtualizer.getColWidth(col);
                    const max = 5;
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
                    // Force canvas repaint for table cell data changes
                    untrack(() => renderScheduler?.invalidateAll());
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    return;
                }
            }
        }

        // ── Regular cell ──────────────────────────────────────────────────────
        if (e.shiftKey && anchor) {
            // Snap shift-click to merge boundary too (extend to the primary cell)
            const snapped = snapToMergePrimary(row, col);
            selectionState.extendSelection(snapped.row, snapped.col);
        } else {
            // Handle special cell type clicks (checkbox toggle, rating)
            if (handleRegularCellClick(row, col, e)) return;
            // Snap to merge primary so anchor always lands on the top-left cell
            const snapped = snapToMergePrimary(row, col);
            selectionState.startSelection(snapped.row, snapped.col);
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
        // Snap to merge primary so only the primary cell can be edited
        const mergeEngine = renderContext?.mergeEngine;
        if (mergeEngine?.isMergeCell(row, col)) {
            const merge = mergeEngine.getMergeAt(row, col);
            if (merge) {
                row = merge.startRow;
                col = merge.startCol;
            }
        }

        const cellType = renderContext?.getCellType(row, col);

        // ── REPEATER non-template: not editable ───────────────────────────────
        if (cellType === CELL_TYPE.REPEATER) {
            const repCtx =
                renderContext?.repeaterEngine?.getCellRepeaterContext(row, col);
            if (repCtx && repCtx.repIndex > 0) return; // block edit
        }

        // ── TABLE_DATA: show inline cell editor overlay ───────────────────────
        if (cellType === CELL_TYPE.TABLE_DATA) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                const colType = info.colDef.type;
                // Checkbox/rating handled by single click; formula columns not editable
                if (
                    colType !== "checkbox" &&
                    colType !== "rating" &&
                    !info.colDef.isNonEntry
                ) {
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    focusedTableDataCell = {
                        table: info.table,
                        dataIndex: info.dataIndex,
                        colDef: info.colDef,
                        row,
                        col,
                        left: cellContainerLeft(col),
                        top: cellContainerTop(row),
                        width: virtualizer.getColWidth(col),
                        height: virtualizer.getRowHeight(row),
                    };
                }
            }
            return;
        }

        // ── TABLE_HEADER / TABLE_ENTRY: no plain-text editing ────────────────
        if (
            cellType === CELL_TYPE.TABLE_HEADER ||
            cellType === CELL_TYPE.TABLE_ENTRY
        ) {
            return;
        }

        beginCellEdit(row, col, { surface: "grid" });
    }

    /** Commit an inline table data cell edit. */
    function commitTableDataEdit(value) {
        if (!focusedTableDataCell) return;
        const { table, dataIndex, colDef } = focusedTableDataCell;
        // Coerce value to correct type
        let typedValue = value;
        const colType = colDef.type;
        if (
            colType === "number" ||
            colType === "currency" ||
            colType === "percent"
        ) {
            const n = parseFloat(value);
            typedValue = isNaN(n) ? null : n;
        }
        table.updateCell(dataIndex, colDef.id, typedValue);
        focusedTableDataCell = null;
        // Force canvas repaint for table cell data changes
        untrack(() => renderScheduler?.invalidateAll());
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
        if (typeof value === "string" && value.startsWith("=")) {
            sheetStore.setCellFormula(row, col, value);
        } else {
            // Parse the value according to the cell's current type config
            const ct = sheetStore.getCellTypeConfig(row, col);
            const parsedValue = CellTypeRegistry.parseInput(ct, value);
            sheetStore.setCellValue(row, col, parsedValue);
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

    function commitEdit(value = undefined) {
        if (value !== undefined && editSessionState.isEditing) {
            // Rich text / contenteditable passes value (HTML string or plain string) directly
            const { row, col } = editSessionState.cell;
            editSessionState.cancel();
            persistEdit({ row, col, value });
        } else {
            commitCurrentEdit();
        }
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
        // For 'cols' mode, resize all selected columns
        if (
            selectionState.selectionMode === "cols" &&
            selectionState.selectedCols &&
            col >= selectionState.selectedCols.start &&
            col <= selectionState.selectedCols.end
        ) {
            indices = [];
            for (
                let c = selectionState.selectedCols.start;
                c <= selectionState.selectedCols.end;
                c++
            )
                indices.push(c);
        } else if (
            selection &&
            col >= selection.startCol &&
            col <= selection.endCol
        ) {
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
        // For 'rows' mode, resize all selected rows
        if (
            selectionState.selectionMode === "rows" &&
            selectionState.selectedRows &&
            row >= selectionState.selectedRows.start &&
            row <= selectionState.selectedRows.end
        ) {
            indices = [];
            for (
                let r = selectionState.selectedRows.start;
                r <= selectionState.selectedRows.end;
                r++
            )
                indices.push(r);
        } else if (
            selection &&
            row >= selection.startRow &&
            row <= selection.endRow
        ) {
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

        // Typing a printable character (no modifier) starts editing the selected cell
        if (
            e.key.length === 1 &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            anchor
        ) {
            const anchorCellType = renderContext?.getCellType(
                anchor.row,
                anchor.col,
            );
            // Block typing into non-template repeater cells
            if (anchorCellType === CELL_TYPE.REPEATER) {
                const repCtx =
                    renderContext?.repeaterEngine?.getCellRepeaterContext(
                        anchor.row,
                        anchor.col,
                    );
                if (repCtx && repCtx.repIndex > 0) {
                    e.preventDefault();
                    return;
                }
            }
            // Block typing into table structural cells (headers and entry rows)
            // TABLE_DATA cells: open inline editor with typed character as initial value
            if (
                anchorCellType === CELL_TYPE.TABLE_HEADER ||
                anchorCellType === CELL_TYPE.TABLE_ENTRY
            ) {
                e.preventDefault();
                return;
            }

            // For TABLE_DATA cells, open the inline editor with the typed character
            if (anchorCellType === CELL_TYPE.TABLE_DATA) {
                const info = renderContext?.tableManager?.getCellInfo(
                    anchor.row,
                    anchor.col,
                );
                if (info?.table && info.colDef) {
                    const colType = info.colDef.type;
                    // Only allow typing for editable columns (not checkbox/rating/formula)
                    if (
                        colType !== "checkbox" &&
                        colType !== "rating" &&
                        !info.colDef.isNonEntry
                    ) {
                        focusedTableDataCell = {
                            table: info.table,
                            dataIndex: info.dataIndex,
                            colDef: info.colDef,
                            row: anchor.row,
                            col: anchor.col,
                            left: cellContainerLeft(anchor.col),
                            top: cellContainerTop(anchor.row),
                            width: virtualizer.getColWidth(anchor.col),
                            height: virtualizer.getRowHeight(anchor.row),
                            seedText: e.key, // Pass the typed character to initialize the editor
                        };
                    }
                }
                e.preventDefault();
                return;
            }

            beginCellEdit(anchor.row, anchor.col, {
                seedText: e.key,
                surface: "grid",
            });
            e.preventDefault();
            return;
        }

        switch (e.key) {
            case "ArrowUp":
                selectionState.moveSelection(
                    -1,
                    0,
                    e.shiftKey,
                    rowCount,
                    colCount,
                );
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowDown":
                selectionState.moveSelection(
                    1,
                    0,
                    e.shiftKey,
                    rowCount,
                    colCount,
                );
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowLeft":
                selectionState.moveSelection(
                    0,
                    -1,
                    e.shiftKey,
                    rowCount,
                    colCount,
                );
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowRight":
                selectionState.moveSelection(
                    0,
                    1,
                    e.shiftKey,
                    rowCount,
                    colCount,
                );
                scrollToAnchor();
                e.preventDefault();
                break;
            case "Enter":
                if (anchor) {
                    const anchorCellType = renderContext?.getCellType(
                        anchor.row,
                        anchor.col,
                    );
                    // TABLE_DATA: open the inline editor overlay
                    if (anchorCellType === CELL_TYPE.TABLE_DATA) {
                        const info = renderContext?.tableManager?.getCellInfo(
                            anchor.row,
                            anchor.col,
                        );
                        if (info?.table && info.colDef) {
                            const colType = info.colDef.type;
                            // Checkbox/rating handled by single click; formula columns not editable
                            if (
                                colType !== "checkbox" &&
                                colType !== "rating" &&
                                !info.colDef.isNonEntry
                            ) {
                                focusedTableDataCell = {
                                    table: info.table,
                                    dataIndex: info.dataIndex,
                                    colDef: info.colDef,
                                    row: anchor.row,
                                    col: anchor.col,
                                    left: cellContainerLeft(anchor.col),
                                    top: cellContainerTop(anchor.row),
                                    width: virtualizer.getColWidth(anchor.col),
                                    height: virtualizer.getRowHeight(
                                        anchor.row,
                                    ),
                                };
                            }
                        }
                    }
                    // TABLE_HEADER / TABLE_ENTRY: block the regular editor
                    else if (
                        anchorCellType === CELL_TYPE.TABLE_HEADER ||
                        anchorCellType === CELL_TYPE.TABLE_ENTRY
                    ) {
                        // No action - don't open any editor
                    }
                    // Regular cells: open the standard cell editor
                    else {
                        beginCellEdit(anchor.row, anchor.col, {
                            surface: "grid",
                        });
                    }
                }
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

    /**
     * Clear cell values in the current selection.
     * Uses effectiveRange (works for all selectionModes).
     * Skips TABLE_DATA/TABLE_HEADER/TABLE_ENTRY/VIEWPORT_OCCUPIED cells
     * since those manage their own data.
     * Iterates only existing cells to avoid scanning millions of empty ones.
     */
    function clearSelection() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        // Iterate only cells that actually exist (sparse map)
        sheetStore.cells.forEach((_cell, key) => {
            const [r, c] = key.split(",").map(Number);
            if (r < eff.startRow || r > eff.endRow) return;
            if (c < eff.startCol || c > eff.endCol) return;
            // Skip table/repeater/viewport cells
            const ct = renderContext?.getCellType(r, c);
            if (
                ct === CELL_TYPE.TABLE_HEADER ||
                ct === CELL_TYPE.TABLE_ENTRY ||
                ct === CELL_TYPE.TABLE_DATA ||
                ct === CELL_TYPE.VIEWPORT_OCCUPIED
            )
                return;
            sheetStore.clearCell(r, c);
        });
    }

    // ─── Row / Column insert / delete ─────────────────────────────────────────
    function insertRowAbove() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (eff) sheetStore.insertRowAt(eff.startRow);
    }
    function insertRowBelow() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (eff) sheetStore.insertRowAt(eff.endRow + 1);
    }
    function insertColumnLeft() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (eff) sheetStore.insertColumnAt(eff.startCol);
    }
    function insertColumnRight() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (eff) sheetStore.insertColumnAt(eff.endCol + 1);
    }

    function deleteSelectedRows() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        for (let row = eff.endRow; row >= eff.startRow; row--)
            sheetStore.deleteRowAt(row);
    }
    function deleteSelectedColumns() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        for (let col = eff.endCol; col >= eff.startCol; col--)
            sheetStore.deleteColumnAt(col);
    }

    // ─── Merge ────────────────────────────────────────────────────────────────
    let canMerge = $derived.by(() => {
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return false;
        return eff.startRow !== eff.endRow || eff.startCol !== eff.endCol;
    });
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

    // ─── Entry cell Tab navigation ────────────────────────────────────────────

    /**
     * Move the focused entry cell to a different column index in the same table.
     * Skips formula columns (isNonEntry).
     */
    function focusEntryCol(table, colIndex) {
        if (!table || !virtualizer || !renderPlan) return;
        const cols = table.columns;
        if (!cols?.length) return;
        const clampedIdx = Math.max(0, Math.min(colIndex, cols.length - 1));
        const sheetCol = table.startCol + clampedIdx;
        const entryRow = table.startRow + 1;
        focusedEntryCell = {
            table,
            colIndex: clampedIdx,
            row: entryRow,
            col: sheetCol,
            left: cellContainerLeft(sheetCol),
            top: cellContainerTop(entryRow),
            width: virtualizer.getColWidth(sheetCol),
            height: virtualizer.getRowHeight(entryRow),
        };
    }

    /**
     * Commit the current entry and focus the first editable entry cell.
     * Called by Enter key and the Insert button.
     */
    function commitEntryAndRefocus() {
        if (!focusedEntryCell) return;
        const { table } = focusedEntryCell;
        const success = table.commitEntry();
        if (success !== false) {
            // Find first editable column
            const firstIdx = table.columns.findIndex((c) => !c.isNonEntry);
            if (firstIdx >= 0) {
                focusEntryCol(table, firstIdx);
            } else {
                focusedEntryCell = null;
            }
        }
    }

    /**
     * Tab to the next non-formula entry column; wraps around and commits on last.
     */
    function entryTabNext() {
        if (!focusedEntryCell) return;
        const { table, colIndex } = focusedEntryCell;
        const cols = table.columns;
        // Find next editable column
        for (let i = 1; i <= cols.length; i++) {
            const nextIdx = (colIndex + i) % cols.length;
            if (nextIdx < colIndex) {
                // Wrapped around — commit entry and refocus first
                commitEntryAndRefocus();
                return;
            }
            if (!cols[nextIdx]?.isNonEntry) {
                focusEntryCol(table, nextIdx);
                return;
            }
        }
        // All columns are formula — commit
        commitEntryAndRefocus();
    }

    /**
     * Shift+Tab to the previous non-formula entry column.
     */
    function entryTabPrev() {
        if (!focusedEntryCell) return;
        const { table, colIndex } = focusedEntryCell;
        const cols = table.columns;
        for (let i = 1; i <= cols.length; i++) {
            const prevIdx = (colIndex - i + cols.length) % cols.length;
            if (!cols[prevIdx]?.isNonEntry) {
                focusEntryCol(table, prevIdx);
                return;
            }
        }
    }

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

    // Whether any selection exists (works for all modes)
    let hasAnySelection = $derived(anchor !== null);

    let selectionType = $derived.by(() => {
        const mode = selectionState.selectionMode;
        if (mode === "rows") return "row";
        if (mode === "cols") return "column";
        if (mode === "all") return "all";
        if (!selection || !sheetStore) return "none";
        const isSingle =
            selection.startRow === selection.endRow &&
            selection.startCol === selection.endCol;
        if (isSingle) return "cell";
        return "range";
    });

    // Row/col counts for context menu labels (works for all modes)
    let effSelRowCount = $derived.by(() => {
        if (
            selectionState.selectionMode === "rows" &&
            selectionState.selectedRows
        )
            return (
                selectionState.selectedRows.end -
                selectionState.selectedRows.start +
                1
            );
        if (selectionState.selectionMode === "all") return rowCount;
        return selection ? selection.endRow - selection.startRow + 1 : 1;
    });
    let effSelColCount = $derived.by(() => {
        if (
            selectionState.selectionMode === "cols" &&
            selectionState.selectedCols
        )
            return (
                selectionState.selectedCols.end -
                selectionState.selectedCols.start +
                1
            );
        if (selectionState.selectionMode === "all") return colCount;
        return selection ? selection.endCol - selection.startCol + 1 : 1;
    });

    let contextMenuItems = $derived([
        {
            label: "Cut",
            icon: cutIcon,
            isSvgIcon: true,
            shortcut: "Ctrl+X",
            action: cutSelection,
            disabled: !hasAnySelection,
        },
        {
            label: "Copy",
            icon: copyIcon,
            isSvgIcon: true,
            shortcut: "Ctrl+C",
            action: copySelection,
            disabled: !hasAnySelection,
        },
        {
            label: "Paste",
            icon: pasteIcon,
            isSvgIcon: true,
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
            icon: mergeIcon,
            isSvgIcon: true,
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
            icon: mergeIcon,
            isSvgIcon: true,
            action: () => {
                if (anchor && sheetStore)
                    sheetStore.unmergeCells(anchor.row, anchor.col);
            },
            disabled: !isMergePrimary,
        },
        { divider: true },
        {
            label: "Insert Row Above",
            icon: arrowUp,
            isSvgIcon: true,
            action: insertRowAbove,
            disabled: !hasAnySelection,
        },
        {
            label: "Insert Row Below",
            icon: arrowDown,
            isSvgIcon: true,
            action: insertRowBelow,
            disabled: !hasAnySelection,
        },
        {
            label: "Insert Column Left",
            icon: arrowLeft,
            isSvgIcon: true,
            action: insertColumnLeft,
            disabled: !hasAnySelection,
        },
        {
            label: "Insert Column Right",
            icon: arrowRight,
            isSvgIcon: true,
            action: insertColumnRight,
            disabled: !hasAnySelection,
        },
        { divider: true },
        {
            label:
                selectionType === "row" || selectionType === "all"
                    ? `Delete ${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""}`
                    : "Delete Row",
            icon: trashIcon,
            isSvgIcon: true,
            action: deleteSelectedRows,
            disabled: !hasAnySelection,
        },
        {
            label:
                selectionType === "column" || selectionType === "all"
                    ? `Delete ${effSelColCount} Column${effSelColCount > 1 ? "s" : ""}`
                    : "Delete Column",
            icon: trashIcon,
            isSvgIcon: true,
            action: deleteSelectedColumns,
            disabled: !hasAnySelection,
        },
        ...(tableCellInfo
            ? [
                  { divider: true },
                  {
                      label: `⊞ ${tableCellInfo.table.name}`,
                      disabled: true,
                  },
                  // Row operations (when in data row)
                  ...(tableCellInfo.rowType === "data"
                      ? [
                            {
                                label: "Delete This Row",
                                icon: trashIcon,
                                isSvgIcon: true,
                                action: tableDeleteRow,
                            },
                            { divider: true },
                        ]
                      : []),
                  // Entry row operations
                  ...(tableCellInfo.rowType === "entry"
                      ? [
                            {
                                label: "Commit Entry (Enter)",
                                action: () => tableCellInfo.table.commitEntry(),
                            },
                            {
                                label: "Clear Entry (Esc)",
                                action: () => tableCellInfo.table.clearEntry(),
                            },
                            { divider: true },
                        ]
                      : []),
                  // Column operations (when colDef exists)
                  ...(tableCellInfo.colDef
                      ? [
                            {
                                label: "Sort A→Z",
                                action: tableSortAsc,
                                icon: "▲",
                            },
                            {
                                label: "Sort Z→A",
                                action: tableSortDesc,
                                icon: "▼",
                            },
                            {
                                label: "Clear Sort",
                                action: tableClearSort,
                                disabled: !tableCellInfo.table.sortColId,
                            },
                            { divider: true },
                            {
                                label: "Configure Column…",
                                icon: "⚙",
                                action: () => {
                                    if (
                                        tableCellInfo?.colDef &&
                                        anchor &&
                                        virtualizer
                                    ) {
                                        activeColumnConfig = {
                                            table: tableCellInfo.table,
                                            colId: tableCellInfo.colDef.id,
                                            left: cellContainerLeft(anchor.col),
                                            top:
                                                cellContainerTop(
                                                    tableCellInfo.table
                                                        .startRow,
                                                ) +
                                                virtualizer.getRowHeight(
                                                    tableCellInfo.table
                                                        .startRow,
                                                ),
                                        };
                                    }
                                },
                            },
                            { divider: true },
                        ]
                      : []),
                  // Table-wide operations
                  {
                      label: "Add Row",
                      icon: "+",
                      action: () => tableCellInfo.table.insertRow({}),
                  },
                  {
                      label: "Configure Table ⊞",
                      action: () => {
                          if (tableCellInfo) {
                              activeEditPanel =
                                  activeEditPanel?.store === tableCellInfo.table
                                      ? null
                                      : {
                                            type: "table",
                                            store: tableCellInfo.table,
                                        };
                          }
                      },
                  },
                  {
                      label: "Delete Table",
                      icon: trashIcon,
                      isSvgIcon: true,
                      action: tableDelete,
                  },
              ]
            : []),
        ...(repeaterContext
            ? [
                  { divider: true },
                  {
                      label: `↻ ${repeaterContext.repeater.name}`,
                      disabled: true,
                  },
                  {
                      label: "Repeater Settings…",
                      icon: "⚙",
                      action: () => {
                          if (repeaterContext) {
                              activeEditPanel =
                                  activeEditPanel?.store ===
                                  repeaterContext.repeater
                                      ? null
                                      : {
                                            type: "repeater",
                                            store: repeaterContext.repeater,
                                        };
                          }
                      },
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
                      icon: trashIcon,
                      isSvgIcon: true,
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

            <!-- Always-visible repeater outlines (all repeaters, subtle) -->
            {#each allRepeaterOutlines as { repeater: rep, rect }}
                <div
                    class="range-outline range-outline--repeater"
                    class:range-outline--active={repeaterContext?.repeater ===
                        rep}
                    style="left:{rect.left}px; top:{rect.top}px; width:{rect.width}px; height:{rect.height}px;"
                ></div>
                <!-- Settings button anchored to top-right of repeater range -->
                {@const btnLeft = rect.left + rect.width}
                {@const btnTop = rect.top}
                <button
                    class="feature-settings-btn feature-settings-btn--repeater"
                    style="left:{btnLeft}px; top:{btnTop}px;"
                    onclick={(e) => {
                        e.stopPropagation();
                        activeEditPanel =
                            activeEditPanel?.store === rep
                                ? null
                                : { type: "repeater", store: rep };
                    }}
                    title="Repeater settings: {rep.name}"
                    aria-label="Repeater settings">↻</button
                >
            {/each}

            <!-- Always-visible table outlines (all tables, subtle) -->
            {#each allTableOutlines as { table: tbl, rect }}
                <div
                    class="range-outline range-outline--table"
                    class:range-outline--active={tableCellInfo?.table === tbl}
                    style="left:{rect.left}px; top:{rect.top}px; width:{rect.width}px; height:{rect.height}px;"
                ></div>
                <!-- Settings button anchored to top-right of table header row -->
                {@const btnLeft =
                    cellContainerLeft(tbl.endCol) +
                    (virtualizer?.getColWidth(tbl.endCol) ?? 0)}
                <button
                    class="feature-settings-btn feature-settings-btn--table"
                    style="left:{btnLeft}px; top:{cellContainerTop(
                        tbl.startRow,
                    )}px;"
                    onclick={(e) => {
                        e.stopPropagation();
                        activeEditPanel =
                            activeEditPanel?.store === tbl
                                ? null
                                : { type: "table", store: tbl };
                    }}
                    title="Table settings: {tbl.name}"
                    aria-label="Table settings">⊞</button
                >
            {/each}

            <!-- Edit panel (repeater or table settings) -->
            {#if activeEditPanel && editPanelPosition}
                <div
                    class="edit-panel-anchor"
                    style="left:{editPanelPosition.x}px; top:{editPanelPosition.y}px;"
                >
                    {#if activeEditPanel.type === "repeater"}
                        <RepeaterEditPanel
                            repeater={activeEditPanel.store}
                            repeaterEngine={spreadsheetSession.repeaterEngine}
                            onClose={() => (activeEditPanel = null)}
                        />
                    {:else if activeEditPanel.type === "table"}
                        <TableEditPanel
                            table={activeEditPanel.store}
                            tableManager={spreadsheetSession.tableManager}
                            onClose={() => (activeEditPanel = null)}
                        />
                    {/if}
                </div>
            {/if}

            <!-- TABLE_DATA inline cell edit overlay (shown on Enter or typing) -->
            {#if focusedTableDataCell}
                {@const cellValue = focusedTableDataCell.table.getValue(
                    focusedTableDataCell.dataIndex,
                    focusedTableDataCell.colDef.id,
                )}
                {@const initialValue =
                    focusedTableDataCell.seedText ??
                    (cellValue != null ? String(cellValue) : "")}
                <div
                    class="table-data-edit-overlay"
                    style="position:absolute; left:{focusedTableDataCell.left}px; top:{focusedTableDataCell.top}px; width:{focusedTableDataCell.width}px; height:{focusedTableDataCell.height}px; z-index:22;"
                >
                    <input
                        type="text"
                        class="table-data-edit-input"
                        value={initialValue}
                        onblur={(e) =>
                            commitTableDataEdit(
                                /** @type {HTMLInputElement} */ (e.target)
                                    .value,
                            )}
                        onkeydown={(e) => {
                            if (e.key === "Enter" || e.key === "Tab") {
                                e.stopPropagation();
                                commitTableDataEdit(
                                    /** @type {HTMLInputElement} */ (e.target)
                                        .value,
                                );
                            } else if (e.key === "Escape") {
                                e.stopPropagation();
                                focusedTableDataCell = null;
                            }
                        }}
                        autofocus
                    />
                </div>
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
            {#if activeFilterPopover && filterPopoverPosition}
                <div
                    class="filter-popover-anchor"
                    style="position:absolute; left:{filterPopoverPosition.left}px; top:{filterPopoverPosition.top}px; z-index:50;"
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
                        onTabNext={entryTabNext}
                        onTabPrev={entryTabPrev}
                        onCommit={commitEntryAndRefocus}
                    />
                </div>
                <!-- Floating Insert button below the entry row -->
                {#if entryInsertButtonInfo}
                    <div
                        class="entry-insert-bar"
                        style="position:absolute; left:{entryInsertButtonInfo.left}px; top:{entryInsertButtonInfo.top}px; width:{entryInsertButtonInfo.width}px; z-index:23;"
                    >
                        <button
                            class="entry-insert-btn"
                            onclick={commitEntryAndRefocus}
                            title="Insert row (Enter)"
                            aria-label="Insert row"
                        >
                            ↵ Insert
                        </button>
                        <button
                            class="entry-clear-btn"
                            onclick={() => {
                                focusedEntryCell.table.clearEntry();
                                focusedEntryCell = null;
                            }}
                            title="Clear entry (Escape)"
                            aria-label="Clear entry"
                        >
                            {@html closeIcon}
                        </button>
                    </div>
                {/if}
            {/if}

            <!-- Column config panel (floating, from context menu or header badge click) -->
            {#if activeColumnConfig}
                <div
                    class="col-config-anchor"
                    style="position:absolute; left:{activeColumnConfig.left}px; top:{activeColumnConfig.top}px; z-index:60; pointer-events:auto;"
                >
                    <TableColumnPanel
                        table={activeColumnConfig.table}
                        colId={activeColumnConfig.colId}
                        onClose={() => (activeColumnConfig = null)}
                    />
                </div>
            {/if}

            <!-- (Viewport mode removed — all tables/repeaters are inline) -->
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

    /* ── DOM overlay layer (z:5) ── */
    .dom-overlay-layer {
        position: absolute;
        inset: 0;
        z-index: 5;
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

    /* ── Range outlines (repeater / table, always visible) ── */
    .range-outline {
        position: absolute;
        box-sizing: border-box;
        pointer-events: none;
        border-radius: 2px;
        z-index: 8; /* below selection border */
        transition: opacity 0.15s;
    }

    .range-outline--repeater {
        border: 1px solid rgba(124, 58, 237, 0.35);
        background: rgba(124, 58, 237, 0.02);
    }

    .range-outline--repeater.range-outline--active {
        border: 2px dashed rgba(124, 58, 237, 0.6);
        background: rgba(124, 58, 237, 0.03);
    }

    .range-outline--table {
        border: 1px solid rgba(59, 130, 246, 0.3);
        background: rgba(59, 130, 246, 0.015);
    }

    .range-outline--table.range-outline--active {
        border: 2px dashed rgba(59, 130, 246, 0.55);
        background: rgba(59, 130, 246, 0.025);
    }

    /* ── Feature settings buttons (per table / repeater) ── */
    .feature-settings-btn {
        position: absolute;
        z-index: 15;
        width: 20px;
        height: 20px;
        border-radius: 3px;
        border: 1px solid;
        background: var(--cell-bg, #fff);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        line-height: 1;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        pointer-events: auto;
        transition: all 0.1s;
        opacity: 0.6;
    }

    .feature-settings-btn:hover {
        opacity: 1;
        transform: scale(1.1);
    }

    .feature-settings-btn--repeater {
        color: #7c3aed;
        border-color: rgba(124, 58, 237, 0.4);
    }
    .feature-settings-btn--repeater:hover {
        background: #ede9fe;
        border-color: #7c3aed;
    }

    .feature-settings-btn--table {
        color: #3b82f6;
        border-color: rgba(59, 130, 246, 0.4);
    }
    .feature-settings-btn--table:hover {
        background: #eff6ff;
        border-color: #3b82f6;
    }

    /* ── Edit panel anchor ── */
    .edit-panel-anchor {
        position: absolute;
        z-index: 55;
        pointer-events: auto;
    }

    /* ── Table data cell inline edit overlay ── */
    .table-data-edit-overlay {
        pointer-events: auto;
        overflow: hidden;
    }

    .table-data-edit-input {
        width: 100%;
        height: 100%;
        border: none;
        padding: 0 4px;
        font-size: 0.8125rem;
        outline: 2px solid #3b82f6;
        background: var(--input-bg, #ffffff);
        color: var(--text-color, #1e293b);
        box-sizing: border-box;
    }

    /* ── Entry insert bar (below entry row, shown when entry cell is focused) ── */
    .entry-insert-bar {
        pointer-events: auto;
        display: flex;
        align-items: stretch;
        gap: 0;
        height: 24px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    }

    .entry-insert-btn {
        flex: 1;
        border: 1px solid #3b82f6;
        background: #eff6ff;
        color: #1d4ed8;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        border-radius: 0 0 0 4px;
        transition: background 0.1s;
        box-sizing: border-box;
        padding: 0 8px;
    }

    .entry-insert-btn:hover {
        background: #dbeafe;
    }

    .entry-clear-btn {
        width: 26px;
        border: 1px solid #e2e8f0;
        border-left: none;
        background: var(--cell-bg, #fff);
        color: #94a3b8;
        cursor: pointer;
        font-size: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 0 0 4px 0;
        transition: all 0.1s;
        box-sizing: border-box;
    }

    .entry-clear-btn:hover {
        background: #fef2f2;
        border-color: #fca5a5;
        color: #dc2626;
    }

    /* ── Column config panel anchor ── */
    .col-config-anchor {
        pointer-events: auto;
    }
</style>
