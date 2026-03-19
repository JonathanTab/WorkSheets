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
    import { SelectionRenderer } from "../../stores/spreadsheet/rendering/SelectionRenderer.js";
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
    import { PrintEngine } from "../../stores/spreadsheet/features/PrintEngine.js";
    import FloatingImages from "./FloatingImages.svelte";
    import ImageEditor from "./cellTypes/ImageEditor.svelte";
    import { setOnLoadCallback } from "../../stores/spreadsheet/rendering/ImageCache.js";
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import AlertModal from "../modals/AlertModal.svelte";

    // ─── Props ─────────────────────────────────────────────────────────────────
    let { showPageBreaks = false, printSettings = null } = $props();

    // ─── DOM refs ──────────────────────────────────────────────────────────────
    let containerEl = $state(null);
    let scrollEl = $state(null);
    let canvasEl = $state(null);
    let selectCanvasEl = $state(null);

    // ─── Canvas rendering instances ───────────────────────────────────────────
    /** @type {CanvasRenderer|null} */
    let canvasRenderer = null;
    /** @type {RenderScheduler|null} */
    let renderScheduler = null;
    /** @type {SelectionRenderer|null} */
    let selectionRenderer = null;
    /** @type {RenderScheduler|null} */
    let selectionScheduler = null;
    const hitTestEngine = new HitTestEngine();
    // Track which canvas element each renderer was created for, so we can
    // detect when the {#if} block remounts and recreates canvas elements.
    let rendererCanvasEl = null;
    let selRendererCanvasEl = null;

    // ─── Grid virtualizer ─────────────────────────────────────────────────────
    let virtualizer = $state(null);
    let overlaysRef = $state(null);
    let virtualizerSheetId = $state.raw(null);
    let resizeObserver = null;
    let vvCleanup = null; // visual viewport cleanup for iOS keyboard handling

    // ─── Page break overlay ───────────────────────────────────────────────────
    const _printEngine = new PrintEngine();

    /**
     * Compute page break lines for the overlay.
     * Returns arrays of pixel positions (in grid-root container space).
     * Only computed when showPageBreaks=true to avoid overhead.
     */
    let pageBreakLines = $derived.by(() => {
        if (!showPageBreaks || !virtualizer || !printSettings) return null;

        const sheetStore = spreadsheetSession.activeSheetStore;
        // Track printSettingsVersion so overlay updates when settings are saved
        const _psv = sheetStore?.printSettingsVersion;
        const totalRows = sheetStore?.rowCount ?? 100;
        const totalCols = sheetStore?.colCount ?? 26;

        const { rowBreaks, colBreaks } = _printEngine.computePageBreaks(
            printSettings,
            virtualizer.rowMetrics,
            virtualizer.colMetrics,
            totalRows,
            totalCols,
        );

        const scrollLeft = virtualizer.scrollLeft;
        const scrollTop = virtualizer.scrollTop;

        // Convert row breaks to Y positions in grid-root container coords.
        // Row break at rowIndex R means a new page starts at R.
        // The horizontal line goes just before row R.
        const rowLines = rowBreaks.slice(1).map((r) => {
            const rowY =
                HEADER_HEIGHT + virtualizer.rowMetrics.offsetOf(r) - scrollTop;
            return rowY;
        });

        // Convert col breaks to X positions
        const colLines = colBreaks.slice(1).map((c) => {
            const colX =
                HEADER_WIDTH + virtualizer.colMetrics.offsetOf(c) - scrollLeft;
            return colX;
        });

        // Compute printable area end in container coords (for shading)
        const ps = printSettings;
        const areaEndRow = ps.areaEndRow ?? totalRows - 1;
        const areaEndCol = ps.areaEndCol ?? totalCols - 1;
        const printEndY =
            HEADER_HEIGHT +
            virtualizer.rowMetrics.offsetOf(areaEndRow + 1) -
            scrollTop;
        const printEndX =
            HEADER_WIDTH +
            virtualizer.colMetrics.offsetOf(areaEndCol + 1) -
            scrollLeft;

        return { rowLines, colLines, printEndX, printEndY };
    });

    // ─── Interaction state ────────────────────────────────────────────────────
    let isSelectingRange = $state(false);
    let rangeStartCell = $state(null);
    let rangeEndCell = $state(null);
    let isMultiRefSelect = $state(false); // true when Ctrl/Cmd held during formula cell click
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
    /** @type {{ row:number, col:number, options:string[], left:number, top:number, width:number, height:number }|null} */
    let focusedDropdownCell = $state(null);
    let dropdownFilter = $state("");
    /** @type {{ type: 'table'|'repeater', store:any }|null} */
    let activeEditPanel = $state(null);
    /** @type {{ table:any, colId:string, left:number, top:number }|null} */
    let activeColumnConfig = $state(null);
    /** @type {{ table:any, colDef:any, row:number, col:number, left:number, top:number, width:number, height:number }|null} */
    let activeHeaderRename = $state(null);

    // ─── Context menu ─────────────────────────────────────────────────────────
    let contextMenuVisible = $state(false);
    let contextMenuPosition = $state({ x: 0, y: 0 });

    // ─── Touch interaction state ───────────────────────────────────────────────
    let touchStartPos = null; // { x, y } of first touch
    let touchHandled = false; // suppress synthetic mouse events after touch
    let touchScrolled = false; // true once movement threshold exceeded
    let lastTapTime = 0; // for double-tap detection
    let lastTapPos = null; // position of last tap
    let longPressTimer = null; // for long-press context menu
    const TOUCH_MOVE_THRESHOLD = 8; // px — max movement still considered a tap
    const DOUBLE_TAP_DELAY = 300; // ms — max interval between taps
    const LONG_PRESS_DELAY = 600; // ms — hold time for context menu

    // ─── Dialog state ─────────────────────────────────────────────────────────
    let showCreateTableDialog = $state(false);
    let showCreateRepeaterDialog = $state(false);
    let showFloatingImageInsert = $state(false);

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
                    if (rect.width > 0 && rect.height > 0)
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

        // Recreate renderer if canvas element changed (e.g. {#if} remount)
        if (!canvasRenderer || rendererCanvasEl !== canvasEl) {
            canvasRenderer?.destroy();
            renderScheduler?.destroy();
            canvasRenderer = new CanvasRenderer(canvasEl);
            renderScheduler = new RenderScheduler(performPaint);
            rendererCanvasEl = canvasEl;
        }

        canvasRenderer.resize(w, h);
        // Flush immediately to avoid a blank-canvas frame while waiting for RAF.
        // invalidateAll marks all panes dirty, then flush() paints synchronously.
        untrack(() => {
            renderScheduler?.invalidateAll();
            renderScheduler?.flush();
        });
    });

    $effect(() => {
        if (!selectCanvasEl || !virtualizer) return;

        const w = Math.max(0, virtualizer.containerWidth - HEADER_WIDTH);
        const h = Math.max(0, virtualizer.containerHeight - HEADER_HEIGHT);
        if (w <= 0 || h <= 0) return;

        // Recreate renderer if canvas element changed (e.g. {#if} remount)
        if (!selectionRenderer || selRendererCanvasEl !== selectCanvasEl) {
            selectionRenderer?.destroy();
            selectionScheduler?.destroy();
            selectionRenderer = new SelectionRenderer(selectCanvasEl);
            selectionScheduler = new RenderScheduler(performSelectionPaint);
            selRendererCanvasEl = selectCanvasEl;
        }

        selectionRenderer.resize(w, h);
        untrack(() => {
            selectionScheduler?.invalidateAll();
            selectionScheduler?.flush();
        });
    });

    // ─── Data canvas repaint trigger ──────────────────────────────────────────
    // Tracks only data/structure changes — NOT selection state or formula typing.
    // Selection fills and formula highlights are on the separate selection canvas,
    // so arrow-key navigation no longer causes an expensive full buildPaneData call.
    //
    // NOTE: We intentionally do NOT track renderPlan here. renderPlan changes on
    // every scroll frame (visible row/col ranges shift), and handleScroll already
    // does a synchronous performPaint in its RAF. Tracking renderPlan would cause
    // a redundant second paint per scroll frame (~6ms wasted at DPR=3).
    // Viewport resize is handled by the canvas resize effect (flush).
    // Frozen dimension changes are tracked explicitly below.
    $effect(() => {
        const _cellsVer = sheetStore?.cellsVersion;
        const _borders = sheetStore?.bordersVersion;
        const _rowMetaVer = sheetStore?.rowMetaVersion;
        const _colMetaVer = sheetStore?.colMetaVersion;
        const _mergeVer = renderContext?.mergeEngine?.version;
        const _tableVer = renderContext?.tableManager?.tableVersion;
        const _repVer = renderContext?.repeaterEngine?.repeaterVersion;
        const _fr = virtualizer?.frozenRows;
        const _fc = virtualizer?.frozenCols;

        untrack(() => {
            if (!renderScheduler || !renderPlan || !virtualizer) return;
            renderScheduler.invalidateAll();
        });
    });

    // ─── Selection canvas repaint trigger ─────────────────────────────────────
    // Tracks selection state and formula edit deps only. Repaints are cheap
    // (~0.3ms) since SelectionRenderer just draws fill rects — no data lookups.
    // Like the data trigger, scroll-driven repaints are handled by handleScroll.
    $effect(() => {
        const _sel = selectionState.range;
        const _selMode = selectionState.selectionMode;
        const _selRows = selectionState.selectedRows;
        const _selCols = selectionState.selectedCols;
        const _anch = selectionState.anchor;
        const _editing = editSessionState.isEditing;
        const _formula = formulaEditState?.currentValue;
        const _fr = virtualizer?.frozenRows;
        const _fc = virtualizer?.frozenCols;

        untrack(() => {
            if (!selectionScheduler || !renderPlan || !virtualizer) return;
            selectionScheduler.invalidateAll();
        });
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
    // dirtyPanes: Set of 'body'|'top'|'left'|'corner' to repaint.
    // When all four are present (default), the whole canvas is cleared first.
    // Partial sets are used by performScrollPaint to skip unchanged frozen panes.
    function performPaint(dirtyPanes = new Set(['body', 'top', 'left', 'corner'])) {
        if (!canvasEl || !canvasRenderer || !renderPlan || !virtualizer) return;

        const frozenRows = virtualizer.frozenRows;
        const frozenCols = virtualizer.frozenCols;
        const frozenHeight = renderPlan.frozenHeight;
        const frozenWidth = renderPlan.frozenWidth;
        const bodyW = renderPlan.bodyViewportWidth;
        const bodyH = renderPlan.bodyViewportHeight;
        const scrollLeft = virtualizer.scrollLeft;
        const scrollTop = virtualizer.scrollTop;

        const commonParams = {
            rowMetrics: virtualizer.rowMetrics,
            colMetrics: virtualizer.colMetrics,
            renderContext,
            sheetStore,
            session: spreadsheetSession,
            frozenRows,
            frozenCols,
            frozenHeight,
            frozenWidth,
        };

        const isFullRepaint = dirtyPanes.size === 4;
        if (isFullRepaint) {
            canvasRenderer.clear();
        }

        // Body pane
        if (dirtyPanes.has('body')) {
            const bp = renderPlan.plans.body;
            if (!isFullRepaint) canvasRenderer.clearPane(frozenWidth, frozenHeight, bodyW, bodyH);
            if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    buildPaneData({
                        ...commonParams,
                        rowRange: bp.rowRange,
                        colRange: bp.colRange,
                        scrollLeft,
                        scrollTop,
                    }),
                    { clipX: frozenWidth, clipY: frozenHeight, clipW: bodyW, clipH: bodyH },
                );
            }
        }

        // Top pane (frozen rows × scrollable cols)
        if (dirtyPanes.has('top')) {
            const tp = renderPlan.plans.top;
            if (!isFullRepaint) canvasRenderer.clearPane(frozenWidth, 0, bodyW, frozenHeight);
            if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    buildPaneData({
                        ...commonParams,
                        rowRange: tp.rowRange,
                        colRange: tp.colRange,
                        scrollLeft,
                        scrollTop: 0,
                    }),
                    { clipX: frozenWidth, clipY: 0, clipW: bodyW, clipH: frozenHeight },
                );
            }
        }

        // Left pane (scrollable rows × frozen cols)
        if (dirtyPanes.has('left')) {
            const lp = renderPlan.plans.left;
            if (!isFullRepaint) canvasRenderer.clearPane(0, frozenHeight, frozenWidth, bodyH);
            if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    buildPaneData({
                        ...commonParams,
                        rowRange: lp.rowRange,
                        colRange: lp.colRange,
                        scrollLeft: 0,
                        scrollTop,
                    }),
                    { clipX: 0, clipY: frozenHeight, clipW: frozenWidth, clipH: bodyH },
                );
            }
        }

        // Corner pane (frozen rows × frozen cols)
        if (dirtyPanes.has('corner')) {
            const cp = renderPlan.plans.corner;
            if (!isFullRepaint) canvasRenderer.clearPane(0, 0, frozenWidth, frozenHeight);
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
        }

        // Sticky table headers — repaint whenever top or body changes (they live in the top strip)
        if (dirtyPanes.has('top') || dirtyPanes.has('body') || isFullRepaint) {
            const stickyHeaders = renderContext?.getStickyTableHeaders?.(
                virtualizer.scrollTop,
                renderPlan.frozenHeight,
                virtualizer.rowMetrics,
                virtualizer.colMetrics,
            );
            if (stickyHeaders?.length > 0) {
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
    }

    // ─── Incremental scroll paint ──────────────────────────────────────────────
    // Blits each scrolling pane's existing pixels by the scroll delta, then
    // repaints only the thin strip of rows/cols that have newly entered the
    // visible viewport.
    //
    // IMPORTANT: Only content inside the pane clip rect exists on the canvas.
    // Overscan rows/cols are computed by buildPaneData but fall outside the clip
    // region, so they are never rendered.  Strip computation must therefore use
    // the *visible viewport* bounds (via indexAtOffset), not the overscan-inflated
    // body-range.  The corner pane (frozen × frozen) never changes during scroll.
    function performScrollPaint(dx, dy, prevST, prevSL) {
        if (!canvasEl || !canvasRenderer || !renderPlan || !virtualizer) return;

        const frozenRows = virtualizer.frozenRows;
        const frozenCols = virtualizer.frozenCols;
        const frozenHeight = renderPlan.frozenHeight;
        const frozenWidth = renderPlan.frozenWidth;
        const bodyW = renderPlan.bodyViewportWidth;
        const bodyH = renderPlan.bodyViewportHeight;
        const scrollLeft = virtualizer.scrollLeft;
        const scrollTop = virtualizer.scrollTop;
        const rowMetrics = virtualizer.rowMetrics;
        const colMetrics = virtualizer.colMetrics;

        const commonParams = {
            rowMetrics, colMetrics, renderContext, sheetStore,
            session: spreadsheetSession,
            frozenRows, frozenCols, frozenHeight, frozenWidth,
        };

        // Helper: build a strip row range from pixel offsets (visible-viewport based)
        function rowStripRange(fromOffset, toOffset) {
            const s = Math.max(frozenRows, rowMetrics.indexAtOffset(fromOffset));
            const e = Math.min(virtualizer.rowCount - 1, rowMetrics.indexAtOffset(toOffset) + 1);
            return s <= e ? { start: s, end: e, count: e - s + 1 } : null;
        }
        function colStripRange(fromOffset, toOffset) {
            const s = Math.max(frozenCols, colMetrics.indexAtOffset(fromOffset));
            const e = Math.min(virtualizer.colCount - 1, colMetrics.indexAtOffset(toOffset) + 1);
            return s <= e ? { start: s, end: e, count: e - s + 1 } : null;
        }

        const bp = renderPlan.plans.body;

        // ── Body pane: blit + repaint exposed strips ──────────────────────────
        canvasRenderer.blitScroll(dx, dy, frozenWidth, frozenHeight, bodyW, bodyH);

        if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
            // Vertical strip (rows entering top or bottom)
            if (dy !== 0) {
                let stripRows, clipY, clipH;
                if (dy > 0) {
                    // Scrolling down → bottom strip
                    stripRows = rowStripRange(prevST + bodyH, scrollTop + bodyH);
                    clipY = frozenHeight + bodyH - dy;
                    clipH = dy;
                } else {
                    // Scrolling up → top strip
                    stripRows = rowStripRange(scrollTop, prevST);
                    clipY = frozenHeight;
                    clipH = -dy;
                }
                if (stripRows) {
                    canvasRenderer.paintPane(
                        buildPaneData({ ...commonParams, rowRange: stripRows, colRange: bp.colRange, scrollLeft, scrollTop }),
                        { clipX: frozenWidth, clipY, clipW: bodyW, clipH },
                    );
                }
            }

            // Horizontal strip (cols entering left or right)
            if (dx !== 0) {
                let stripCols, clipX, clipW;
                if (dx > 0) {
                    stripCols = colStripRange(prevSL + bodyW, scrollLeft + bodyW);
                    clipX = frozenWidth + bodyW - dx;
                    clipW = dx;
                } else {
                    stripCols = colStripRange(scrollLeft, prevSL);
                    clipX = frozenWidth;
                    clipW = -dx;
                }
                if (stripCols) {
                    canvasRenderer.paintPane(
                        buildPaneData({ ...commonParams, rowRange: bp.rowRange, colRange: stripCols, scrollLeft, scrollTop }),
                        { clipX, clipY: frozenHeight, clipW, clipH: bodyH },
                    );
                }
            }
        }

        // ── Top pane (frozen rows × scrollable cols): blit + col strip ────────
        if (dx !== 0) {
            const tp = renderPlan.plans.top;
            if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
                canvasRenderer.blitScroll(dx, 0, frozenWidth, 0, bodyW, frozenHeight);
                let stripCols, clipX, clipW;
                if (dx > 0) {
                    stripCols = colStripRange(prevSL + bodyW, scrollLeft + bodyW);
                    clipX = frozenWidth + bodyW - dx;
                    clipW = dx;
                } else {
                    stripCols = colStripRange(scrollLeft, prevSL);
                    clipX = frozenWidth;
                    clipW = -dx;
                }
                if (stripCols) {
                    canvasRenderer.paintPane(
                        buildPaneData({ ...commonParams, rowRange: tp.rowRange, colRange: stripCols, scrollLeft, scrollTop: 0 }),
                        { clipX, clipY: 0, clipW, clipH: frozenHeight },
                    );
                }
            }
            // Sticky table headers scroll horizontally
            const stickyHeaders = renderContext?.getStickyTableHeaders?.(
                scrollTop, frozenHeight, rowMetrics, colMetrics,
            );
            if (stickyHeaders?.length > 0) {
                const headersWithWidths = stickyHeaders.map((h) => ({
                    ...h,
                    colWidths: h.table.columns.map((_, i) =>
                        virtualizer.getColWidth(h.table.startCol + i),
                    ),
                }));
                canvasRenderer.paintStickyHeaders(headersWithWidths, {
                    frozenWidth, frozenHeight, scrollLeft, headerHeight: HEADER_HEIGHT,
                });
            }
        }

        // ── Left pane (frozen cols × scrollable rows): blit + row strip ───────
        if (dy !== 0) {
            const lp = renderPlan.plans.left;
            if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
                canvasRenderer.blitScroll(0, dy, 0, frozenHeight, frozenWidth, bodyH);
                let stripRows, clipY, clipH;
                if (dy > 0) {
                    stripRows = rowStripRange(prevST + bodyH, scrollTop + bodyH);
                    clipY = frozenHeight + bodyH - dy;
                    clipH = dy;
                } else {
                    stripRows = rowStripRange(scrollTop, prevST);
                    clipY = frozenHeight;
                    clipH = -dy;
                }
                if (stripRows) {
                    canvasRenderer.paintPane(
                        buildPaneData({ ...commonParams, rowRange: stripRows, colRange: lp.colRange, scrollLeft: 0, scrollTop }),
                        { clipX: 0, clipY, clipW: frozenWidth, clipH },
                    );
                }
            }
        }

        // Corner pane: never changes during scroll — skip entirely
    }

    // ─── Selection canvas paint (called by selectionScheduler on RAF) ─────────
    function performSelectionPaint() {
        if (
            !selectCanvasEl ||
            !selectionRenderer ||
            !renderPlan ||
            !virtualizer
        )
            return;

        const frozenRows = virtualizer.frozenRows;
        const frozenCols = virtualizer.frozenCols;
        const frozenHeight = renderPlan.frozenHeight;
        const frozenWidth = renderPlan.frozenWidth;
        const scrollLeft = virtualizer.scrollLeft;
        const scrollTop = virtualizer.scrollTop;

        const commonSelParams = {
            rowMetrics: virtualizer.rowMetrics,
            colMetrics: virtualizer.colMetrics,
            selectionState,
            formulaEditState,
            frozenRows,
            frozenCols,
            frozenHeight,
            frozenWidth,
            rowCount,
            colCount,
        };

        selectionRenderer.clear();

        const bp = renderPlan.plans.body;
        if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
            selectionRenderer.paintSelectionPane({
                ...commonSelParams,
                rowRange: bp.rowRange,
                colRange: bp.colRange,
                scrollLeft,
                scrollTop,
                clipX: frozenWidth,
                clipY: frozenHeight,
                clipW: renderPlan.bodyViewportWidth,
                clipH: renderPlan.bodyViewportHeight,
            });
        }

        const tp = renderPlan.plans.top;
        if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
            selectionRenderer.paintSelectionPane({
                ...commonSelParams,
                rowRange: tp.rowRange,
                colRange: tp.colRange,
                scrollLeft,
                scrollTop: 0,
                clipX: frozenWidth,
                clipY: 0,
                clipW: renderPlan.bodyViewportWidth,
                clipH: frozenHeight,
            });
        }

        const lp = renderPlan.plans.left;
        if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
            selectionRenderer.paintSelectionPane({
                ...commonSelParams,
                rowRange: lp.rowRange,
                colRange: lp.colRange,
                scrollLeft: 0,
                scrollTop,
                clipX: 0,
                clipY: frozenHeight,
                clipW: frozenWidth,
                clipH: renderPlan.bodyViewportHeight,
            });
        }

        const cp = renderPlan.plans.corner;
        if (cp.rowRange.count > 0 && cp.colRange.count > 0) {
            selectionRenderer.paintSelectionPane({
                ...commonSelParams,
                rowRange: cp.rowRange,
                colRange: cp.colRange,
                scrollLeft: 0,
                scrollTop: 0,
                clipX: 0,
                clipY: 0,
                clipW: frozenWidth,
                clipH: frozenHeight,
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
        // Hide inline editor when the editing cell is on a different sheet
        const editingSheetId = editSessionState.editingSheetId;
        if (
            editingSheetId &&
            editingSheetId !== spreadsheetSession.activeSheetId
        )
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
     * Shown to the right of the entry row when the user is focused on an entry cell.
     */
    let entryInsertButtonInfo = $derived.by(() => {
        if (!focusedEntryCell || !virtualizer || !renderPlan) return null;
        const tbl = focusedEntryCell.table;
        const entryRow = tbl.startRow + 1;
        const top = cellContainerTop(entryRow);
        const height = virtualizer.getRowHeight(entryRow);
        // Position to the right of the last table column
        let tableWidth = 0;
        for (let c = tbl.startCol; c <= tbl.endCol; c++) {
            tableWidth += virtualizer.getColWidth(c);
        }
        const left = cellContainerLeft(tbl.startCol) + tableWidth;
        return { table: tbl, top, height, left };
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

    /**
     * Move selection with merge awareness.
     * - When the anchor is inside a merge, the move jumps from the merge's edge
     *   rather than from the anchor's individual cell.
     * - After moving, snaps the anchor to the merge primary if it landed inside
     *   a merge (so shadow cells are never directly anchored).
     * - Shift-extend moves are passed through unchanged (expandRangeForMerges
     *   handles the visual expansion, which is sufficient for extend mode).
     */
    function moveSelectionMergeAware(dRow, dCol, extend = false) {
        const mergeEngine = renderContext?.mergeEngine;

        if (!extend && mergeEngine && (dRow !== 0 || dCol !== 0)) {
            const cur = selectionState.anchor;
            if (cur) {
                const merge = mergeEngine.getMergeAt(cur.row, cur.col);
                if (merge) {
                    // Jump from the trailing edge of the merge in the direction of movement
                    let newRow, newCol;
                    if (dCol > 0) {
                        newRow = cur.row;
                        newCol = merge.endCol + dCol;
                    } else if (dCol < 0) {
                        newRow = cur.row;
                        newCol = merge.startCol + dCol;
                    } else if (dRow > 0) {
                        newRow = merge.endRow + dRow;
                        newCol = cur.col;
                    } else {
                        newRow = merge.startRow + dRow;
                        newCol = cur.col;
                    }
                    newRow = Math.max(0, Math.min(rowCount - 1, newRow));
                    newCol = Math.max(0, Math.min(colCount - 1, newCol));
                    const snapped = snapToMergePrimary(newRow, newCol);
                    selectionState.anchor = { row: snapped.row, col: snapped.col };
                    selectionState.focus  = { row: snapped.row, col: snapped.col };
                    return;
                }
            }
        }

        selectionState.moveSelection(dRow, dCol, extend, rowCount, colCount);

        // After a non-extend move, ensure anchor/focus didn't land on a shadow cell
        if (!extend && mergeEngine) {
            const anchor = selectionState.anchor;
            if (anchor) {
                const snapped = snapToMergePrimary(anchor.row, anchor.col);
                if (snapped.row !== anchor.row || snapped.col !== anchor.col) {
                    selectionState.anchor = { row: snapped.row, col: snapped.col };
                    selectionState.focus  = { row: snapped.row, col: snapped.col };
                }
            }
        }
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
        if (touchHandled) return; // suppress synthetic mouse events after touch
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
        if (touchHandled) return;
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

    // ─── Touch handlers ───────────────────────────────────────────────────────
    function getTouchLocalCoords(touch) {
        const rect = containerEl?.getBoundingClientRect();
        if (!rect) return { localX: 0, localY: 0 };
        return {
            localX: touch.clientX - rect.left,
            localY: touch.clientY - rect.top,
        };
    }

    function handleEventLayerTouchStart(e) {
        if (e.touches.length !== 1) {
            clearTimeout(longPressTimer);
            touchStartPos = null;
            return;
        }
        const touch = e.touches[0];
        touchStartPos = { x: touch.clientX, y: touch.clientY };
        touchScrolled = false;

        // Long-press: show context menu
        const savedClientX = touch.clientX;
        const savedClientY = touch.clientY;
        longPressTimer = setTimeout(() => {
            if (!touchStartPos) return;
            const { localX, localY } = getTouchLocalCoords({
                clientX: savedClientX,
                clientY: savedClientY,
            });
            const hit = hitTestEngine.hitTest(localX, localY);
            if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
                const snappedHit = snapToMergePrimary(hit.row, hit.col);
                if (!isSelected(snappedHit.row, snappedHit.col)) {
                    selectionState.startSelection(snappedHit.row, snappedHit.col);
                    selectionState.endSelection();
                }
                contextMenuPosition = { x: savedClientX, y: savedClientY };
                contextMenuVisible = true;
            }
            touchStartPos = null; // cancel tap after long-press
        }, LONG_PRESS_DELAY);
    }

    function handleEventLayerTouchMove(e) {
        if (!touchStartPos || e.touches.length !== 1) return;
        const touch = e.touches[0];
        const dx = touch.clientX - touchStartPos.x;
        const dy = touch.clientY - touchStartPos.y;
        if (Math.sqrt(dx * dx + dy * dy) > TOUCH_MOVE_THRESHOLD) {
            touchScrolled = true;
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }
    }

    function handleEventLayerTouchEnd(e) {
        clearTimeout(longPressTimer);
        if (!touchStartPos) return;
        if (e.changedTouches.length !== 1) {
            touchStartPos = null;
            return;
        }

        const touch = e.changedTouches[0];
        const dx = touch.clientX - touchStartPos.x;
        const dy = touch.clientY - touchStartPos.y;
        touchStartPos = null;

        // If moved too much it was a scroll, not a tap
        if (
            touchScrolled ||
            Math.sqrt(dx * dx + dy * dy) > TOUCH_MOVE_THRESHOLD
        )
            return;

        const { localX, localY } = getTouchLocalCoords(touch);
        const hit = hitTestEngine.hitTest(localX, localY);

        // Double-tap detection
        const now = Date.now();
        const isDoubleTap =
            now - lastTapTime < DOUBLE_TAP_DELAY &&
            lastTapPos !== null &&
            Math.abs(touch.clientX - lastTapPos.x) < 30 &&
            Math.abs(touch.clientY - lastTapPos.y) < 30;

        lastTapTime = isDoubleTap ? 0 : now;
        lastTapPos = { x: touch.clientX, y: touch.clientY };

        // Prevent synthetic mousedown/mouseup from re-firing
        touchHandled = true;
        setTimeout(() => {
            touchHandled = false;
        }, 600);

        if (isDoubleTap) {
            if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
                handleCellDoubleClick(hit.row, hit.col);
            }
            return;
        }

        // Single tap — synthetic event for handlers that need clientX/Y
        const syntheticE = {
            button: 0,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            clientX: touch.clientX,
            clientY: touch.clientY,
            preventDefault: () => {},
            stopPropagation: () => {},
        };

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
            case "cell":
                if (hit.row >= 0 && hit.col >= 0) {
                    handleCellMouseDown(hit.row, hit.col, syntheticE);
                    selectionState.endSelection(); // no drag on touch
                }
                break;
        }
    }

    function handleEventLayerTouchCancel() {
        clearTimeout(longPressTimer);
        touchStartPos = null;
        touchScrolled = false;
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
            isMultiRefSelect = e.ctrlKey || e.metaKey;
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

        // Close header rename overlay if clicking elsewhere
        if (
            activeHeaderRename &&
            (activeHeaderRename.row !== row || activeHeaderRename.col !== col)
        ) {
            activeHeaderRename = null;
        }

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

        // Close dropdown overlay if clicking elsewhere
        if (
            focusedDropdownCell &&
            (focusedDropdownCell.row !== row || focusedDropdownCell.col !== col)
        ) {
            focusedDropdownCell = null;
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
            let ref = toRangeRef(
                Math.min(rangeStartCell.row, endCell.row),
                Math.min(rangeStartCell.col, endCell.col),
                Math.max(rangeStartCell.row, endCell.row),
                Math.max(rangeStartCell.col, endCell.col),
            );

            // Prefix with sheet name when picking from a different sheet
            const currentSheetId = spreadsheetSession.activeSheetId;
            const editingSheetId = editSessionState.editingSheetId;
            if (
                currentSheetId &&
                editingSheetId &&
                currentSheetId !== editingSheetId
            ) {
                const sheetName =
                    spreadsheetSession.getSheetName(currentSheetId);
                // Quote the name if it contains spaces or special chars
                const needsQuotes = /[\s!']/.test(sheetName);
                const escapedName = needsQuotes
                    ? `'${sheetName.replace(/'/g, "''")}'`
                    : sheetName;
                ref = `${escapedName}!${ref}`;
            }

            if (isMultiRefSelect) {
                editSessionState.appendReference(ref);
            } else {
                editSessionState.insertReference(ref);
            }
            isSelectingRange = false;
            rangeStartCell = null;
            rangeEndCell = null;
            isMultiRefSelect = false;
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

        // ── TABLE_HEADER: inline rename on double-click ──────────────────────
        if (cellType === CELL_TYPE.TABLE_HEADER) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                activeHeaderRename = {
                    table: info.table,
                    colDef: info.colDef,
                    row,
                    col,
                    left: cellContainerLeft(col),
                    top: cellContainerTop(row),
                    width: virtualizer.getColWidth(col),
                    height: virtualizer.getRowHeight(row),
                };
            }
            return;
        }

        // ── TABLE_ENTRY: no plain-text editing ───────────────────────────────
        if (cellType === CELL_TYPE.TABLE_ENTRY) {
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
        // Always work with the merge primary so shadow cells are never the anchor
        const snapped = snapToMergePrimary(row, col);
        row = snapped.row;
        col = snapped.col;
        if (!isSelected(row, col)) {
            selectionState.startSelection(row, col);
            selectionState.endSelection();
        } else {
            // Anchor may have drifted onto a shadow cell via keyboard nav — re-snap it
            const anchor = selectionState.anchor;
            if (anchor) {
                const anchorSnapped = snapToMergePrimary(anchor.row, anchor.col);
                if (anchorSnapped.row !== anchor.row || anchorSnapped.col !== anchor.col) {
                    selectionState.anchor = { row: anchorSnapped.row, col: anchorSnapped.col };
                }
            }
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

        // Dropdown cell: show overlay list instead of text editor
        if (ct?.type === "dropdown") {
            let ddOptions = [];
            if (ct.source === "range" && ct.range) {
                ddOptions = resolveRangeOptions(ct.range);
            } else if (Array.isArray(ct.options)) {
                ddOptions = ct.options;
            }
            if (ddOptions.length > 0) {
                dropdownFilter = "";
                focusedDropdownCell = {
                    row,
                    col,
                    options: ddOptions,
                    left: cellContainerLeft(col),
                    top: cellContainerTop(row),
                    width: virtualizer.getColWidth(col),
                    height: virtualizer.getRowHeight(row),
                };
                return;
            }
        }
        // Image cells: set image picker mode and pass current blob ID as initial value
        if (ct?.type === "image") {
            const currentBlobId =
                spreadsheetSession.getCellEditValue(row, col) ?? "";
            editSessionState.beginEdit(row, col, currentBlobId, surface, {
                pickerMode: "image-picker",
                sheetId: spreadsheetSession.activeSheetId,
            });
            return;
        }

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
            { pickerMode, sheetId: spreadsheetSession.activeSheetId },
        );
    }

    /**
     * Persist an edit to a specific sheet (may differ from active sheet during cross-sheet formula editing).
     * Falls back to the active sheet when sheetId is null/undefined.
     */
    function persistEditOnSheet(sheetId, payload) {
        if (!payload) return;
        const { row, col, value } = payload;
        const targetSheetId = sheetId || spreadsheetSession.activeSheetId;

        if (typeof value === "string" && value.startsWith("=")) {
            spreadsheetSession.setCellFormulaOnSheet(
                targetSheetId,
                row,
                col,
                value,
            );
        } else {
            // Get the cell type config from the target sheet's store for value parsing
            const targetStore =
                targetSheetId === spreadsheetSession.activeSheetId
                    ? sheetStore
                    : null; // For non-active sheets skip type-config parsing; value is used as-is
            const ct = targetStore?.getCellTypeConfig(row, col);
            const parsedValue = CellTypeRegistry.parseInput(ct, value);
            spreadsheetSession.setCellValueOnSheet(
                targetSheetId,
                row,
                col,
                parsedValue,
            );
        }
    }

    function persistEdit(payload) {
        if (!payload || !sheetStore) return;
        const { row, col, value } = payload;

        // Data validation check (skip for formulas)
        if (typeof value !== "string" || !value.startsWith("=")) {
            // Check explicit DV rules
            const dvRules = sheetStore.getDataValidations?.() ?? [];
            for (const rule of dvRules) {
                if (row < rule.startRow || row > rule.endRow) continue;
                if (col < rule.startCol || col > rule.endCol) continue;
                const valid = checkDataValidation(value, rule);
                if (!valid) {
                    const msg = rule.message || `Invalid value for this cell.`;
                    if (rule.strict !== false) {
                        window.alert(msg);
                        return; // Reject the edit
                    } else {
                        console.warn("Data validation warning:", msg);
                    }
                }
                break;
            }

            // Check dropdown cell type validation setting
            const cellCt = sheetStore.getCellTypeConfig(row, col);
            if (
                cellCt?.type === "dropdown" &&
                cellCt.validation &&
                cellCt.validation !== "none"
            ) {
                let ddOpts = [];
                if (cellCt.source === "range" && cellCt.range) {
                    ddOpts = resolveRangeOptions(cellCt.range);
                } else if (Array.isArray(cellCt.options)) {
                    ddOpts = cellCt.options;
                }
                if (ddOpts.length > 0 && !ddOpts.includes(String(value))) {
                    const msg = `"${value}" is not a valid option.`;
                    if (cellCt.validation === "hard") {
                        window.alert(msg);
                        return;
                    } else {
                        console.warn("Dropdown validation warning:", msg);
                    }
                }
            }
        }

        if (typeof value === "string" && value.startsWith("=")) {
            sheetStore.setCellFormula(row, col, value);
        } else {
            // Parse the value according to the cell's current type config
            const ct = sheetStore.getCellTypeConfig(row, col);
            const parsedValue = CellTypeRegistry.parseInput(ct, value);
            sheetStore.setCellValue(row, col, parsedValue);
        }
    }

    function checkDataValidation(value, rule) {
        if (rule.type === "list") {
            const options = rule.options || [];
            return options.length === 0 || options.includes(String(value));
        }
        if (rule.type === "number") {
            const num = Number(value);
            if (isNaN(num)) return false;
            return checkNumericCondition(num, rule);
        }
        if (rule.type === "date") {
            const d = new Date(value);
            if (isNaN(d.getTime())) return false;
            return true; // Could extend with min/max date checks
        }
        if (rule.type === "text") {
            const len = String(value).length;
            return checkNumericCondition(len, rule);
        }
        return true;
    }

    function checkNumericCondition(num, rule) {
        const min = Number(rule.min);
        const max = Number(rule.max);
        switch (rule.condition) {
            case "between":
                return num >= min && num <= max;
            case "gt":
                return num > min;
            case "gte":
                return num >= min;
            case "lt":
                return num < min;
            case "lte":
                return num <= min;
            case "eq":
                return num === min;
            case "neq":
                return num !== min;
            default:
                return true;
        }
    }

    function commitCurrentEdit() {
        const editingSheetId = editSessionState.editingSheetId;
        const payload = editSessionState.commit();
        if (!payload) return;
        persistEditOnSheet(editingSheetId, payload);
        // Return to origin sheet if we navigated away for cross-sheet ref picking
        if (
            editingSheetId &&
            editingSheetId !== spreadsheetSession.activeSheetId
        ) {
            spreadsheetSession.setActiveSheet(editingSheetId);
        }
    }

    function commitEditAndMove(dRow, dCol) {
        const editingSheetId = editSessionState.editingSheetId;
        const payload = editSessionState.commit();
        if (!payload) return;
        persistEditOnSheet(editingSheetId, payload);
        if (
            editingSheetId &&
            editingSheetId !== spreadsheetSession.activeSheetId
        ) {
            spreadsheetSession.setActiveSheet(editingSheetId);
        } else {
            selectionState.moveSelection(dRow, dCol);
            scrollToAnchor();
        }
    }

    function commitEdit(value = undefined) {
        if (value !== undefined && editSessionState.isEditing) {
            // Rich text / contenteditable passes value (HTML string or plain string) directly
            const editingSheetId = editSessionState.editingSheetId;
            const { row, col } = editSessionState.cell;
            editSessionState.cancel();
            persistEditOnSheet(editingSheetId, { row, col, value });
            if (
                editingSheetId &&
                editingSheetId !== spreadsheetSession.activeSheetId
            ) {
                spreadsheetSession.setActiveSheet(editingSheetId);
            }
        } else {
            commitCurrentEdit();
        }
    }
    function cancelEdit() {
        const editingSheetId = editSessionState.editingSheetId;
        editSessionState.cancel();
        if (
            editingSheetId &&
            editingSheetId !== spreadsheetSession.activeSheetId
        ) {
            spreadsheetSession.setActiveSheet(editingSheetId);
        }
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

    // When editing a formula in-cell and navigating to another sheet, the cell
    // editor hides (editorBounds = null). Switch to formula bar so the formula
    // stays visible and ref picking routes focus back to the formula bar.
    $effect(() => {
        if (
            editSessionState.isFormulaMode &&
            editSessionState.surface === "grid" &&
            editSessionState.editingSheetId &&
            editSessionState.editingSheetId !== spreadsheetSession.activeSheetId
        ) {
            editSessionState.switchSurface("formulaBar", { focus: false });
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
                if (!virtualizer) { scrollPending = false; return; }

                // Capture pre-scroll positions (the visible viewport bounds, not
                // the overscan-inflated body range).
                const prevST = virtualizer.scrollTop;
                const prevSL = virtualizer.scrollLeft;

                virtualizer.setScroll(pendingScrollTop, pendingScrollLeft);
                scrollPending = false;

                if (!canvasRenderer || !renderPlan) return;

                const dy = virtualizer.scrollTop - prevST;
                const dx = virtualizer.scrollLeft - prevSL;
                const bodyH = renderPlan.bodyViewportHeight;
                const bodyW = renderPlan.bodyViewportWidth;

                // Incremental blit when delta fits within viewport; full repaint
                // for large jumps (page-down, programmatic scroll, first frame).
                const canIncremental = (dy !== 0 || dx !== 0) &&
                    Math.abs(dy) < bodyH && Math.abs(dx) < bodyW;

                if (canIncremental) {
                    performScrollPaint(dx, dy, prevST, prevSL);
                } else {
                    performPaint(new Set(['body', 'top', 'left', 'corner']));
                }

                if (selectionRenderer && renderPlan) {
                    performSelectionPaint();
                }
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

            // Block typing into image cells — they use the image picker editor
            const anchorCt = renderContext?.getCellTypeConfig(
                anchor.row,
                anchor.col,
            );
            if (anchorCt?.type === "image") {
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
                moveSelectionMergeAware(-1, 0, e.shiftKey);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowDown":
                moveSelectionMergeAware(1, 0, e.shiftKey);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowLeft":
                moveSelectionMergeAware(0, -1, e.shiftKey);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowRight":
                moveSelectionMergeAware(0, 1, e.shiftKey);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "Tab":
                moveSelectionMergeAware(0, e.shiftKey ? -1 : 1, false);
                scrollToAnchor();
                e.preventDefault();
                break;
            case "Enter":
                // Enter moves selection down, but opens the image picker for image cells.
                if (anchor) {
                    const anchorCellType = renderContext?.getCellType(
                        anchor.row,
                        anchor.col,
                    );
                    const anchorCt2 = renderContext?.getCellTypeConfig(
                        anchor.row,
                        anchor.col,
                    );
                    if (anchorCt2?.type === "image") {
                        beginCellEdit(anchor.row, anchor.col, {
                            surface: "grid",
                        });
                        e.preventDefault();
                        break;
                    }
                    if (
                        anchorCellType !== CELL_TYPE.TABLE_HEADER &&
                        anchorCellType !== CELL_TYPE.TABLE_ENTRY
                    ) {
                        moveSelectionMergeAware(
                            1,
                            0,
                            false,
                        );
                        scrollToAnchor();
                    }
                }
                e.preventDefault();
                break;
            case "F2":
                // F2 opens the cell editor (standard spreadsheet shortcut).
                if (anchor) {
                    const f2CellType = renderContext?.getCellType(
                        anchor.row,
                        anchor.col,
                    );
                    if (f2CellType === CELL_TYPE.TABLE_DATA) {
                        const info = renderContext?.tableManager?.getCellInfo(
                            anchor.row,
                            anchor.col,
                        );
                        if (info?.table && info.colDef) {
                            const colType = info.colDef.type;
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
                    } else if (
                        f2CellType !== CELL_TYPE.TABLE_HEADER &&
                        f2CellType !== CELL_TYPE.TABLE_ENTRY
                    ) {
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
                if ((e.ctrlKey || e.metaKey) && e.shiftKey && selection) {
                    // Ctrl+Shift+V → paste values only
                    pasteSelection("values");
                    e.preventDefault();
                } else if ((e.ctrlKey || e.metaKey) && selection) {
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
            case "d":
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
                    // Ctrl+D → fill down
                    fillDown();
                    e.preventDefault();
                }
                break;
            case "r":
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
                    // Ctrl+R → fill right
                    fillRight();
                    e.preventDefault();
                }
                break;
            case "4":
                if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
                    // Ctrl+Shift+4 → format as currency
                    applyTypeToSelection("currency", {
                        decimals: 2,
                        symbol: "$",
                    });
                    e.preventDefault();
                }
                break;
            case "5":
                if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
                    // Ctrl+Shift+5 → format as percent
                    applyTypeToSelection("percent", { decimals: 2 });
                    e.preventDefault();
                }
                break;
            case ";":
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+; → insert today's date
                    insertDate();
                    e.preventDefault();
                }
                break;
            case "\\":
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
                    // Ctrl+\ → clear formatting
                    clearFormatting();
                    e.preventDefault();
                }
                break;
            case "=":
                if ((e.ctrlKey || e.metaKey) && e.altKey) {
                    // Ctrl+Alt+= → insert row/column (when row/col selected)
                    const mode = selectionState.selectionMode;
                    if (mode === "rows") insertRowAbove();
                    else if (mode === "cols") insertColumnLeft();
                    e.preventDefault();
                }
                break;
            case "-":
                if ((e.ctrlKey || e.metaKey) && e.altKey) {
                    // Ctrl+Alt+- → delete row/column (when row/col selected)
                    const delMode = selectionState.selectionMode;
                    if (delMode === "rows") deleteSelectedRows();
                    else if (delMode === "cols") deleteSelectedColumns();
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
            sheetStore.clearCellValue(r, c);
        });
    }

    // ─── Dropdown range resolver ──────────────────────────────────────────────
    function resolveRangeOptions(rangeStr) {
        if (!sheetStore) return [];
        const parts = rangeStr.trim().toUpperCase().split(":");
        function parseRef(ref) {
            const m = ref.match(/^([A-Z]+)(\d+)$/);
            if (!m) return null;
            let col = 0;
            for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
            col--;
            return { row: parseInt(m[2]) - 1, col };
        }
        const start = parseRef(parts[0]);
        const end = parts[1] ? parseRef(parts[1]) : start;
        if (!start || !end) return [];
        const opts = [];
        for (let r = start.row; r <= end.row; r++) {
            for (let c = start.col; c <= end.col; c++) {
                const cell = sheetStore.getCell(r, c);
                if (cell?.v != null && cell.v !== "") opts.push(String(cell.v));
            }
        }
        return opts;
    }

    // ─── Fill Down / Right ────────────────────────────────────────────────────
    function fillDown() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff || eff.startRow === eff.endRow) return;
        sheetStore.fillDown(eff.startRow, eff.startCol, eff.endRow, eff.endCol);
    }

    function fillRight() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff || eff.startCol === eff.endCol) return;
        sheetStore.fillRight(
            eff.startRow,
            eff.startCol,
            eff.endRow,
            eff.endCol,
        );
    }

    // ─── Apply cell type to selection ─────────────────────────────────────────
    function applyTypeToSelection(type, extraOptions = {}) {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const config = { type, ...extraOptions };
        spreadsheetSession.ydoc?.transact(() => {
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    sheetStore.setCellTypeConfig(r, c, config);
                }
            }
        });
    }

    // ─── Insert today's date ──────────────────────────────────────────────────
    function insertDate() {
        if (!sheetStore || !anchor) return;
        const today = new Date();
        const mm = String(today.getMonth() + 1).padStart(2, "0");
        const dd = String(today.getDate()).padStart(2, "0");
        const yyyy = today.getFullYear();
        sheetStore.setCellValue(anchor.row, anchor.col, `${mm}/${dd}/${yyyy}`);
    }

    // ─── Clear formatting ─────────────────────────────────────────────────────
    function clearFormatting() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        sheetStore.clearRangeFormatting(
            eff.startRow,
            eff.startCol,
            eff.endRow,
            eff.endCol,
        );
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
            label: "Insert Image in Cell",
            icon: "🖼",
            action: () => {
                if (anchor) {
                    // Apply image type then open the picker
                    sheetStore?.setCellTypeConfig(anchor.row, anchor.col, {
                        type: "image",
                        fit: "contain",
                    });
                    beginCellEdit(anchor.row, anchor.col, { surface: "grid" });
                }
            },
            disabled: !anchor,
        },
        {
            label: "Insert Floating Image…",
            icon: "🖼",
            action: () => {
                if (anchor && sheetStore) {
                    showFloatingImageInsert = true;
                }
            },
            disabled: !anchor,
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
    let latestResizeW = 0;
    let latestResizeH = 0;

    /** Handler stored for cleanup — image fit change from ImageEditor */
    function handleImageFitChange(e) {
        const { fit } = e.detail ?? {};
        if (!fit || !sheetStore) return;
        const cell = editSessionState.cell;
        if (!cell) return;
        const ct = sheetStore.getCellTypeConfig(cell.row, cell.col);
        if (ct?.type === "image") {
            sheetStore.setCellTypeConfig(cell.row, cell.col, { ...ct, fit });
        }
    }

    onMount(() => {
        // Trigger a canvas repaint when any image finishes loading
        setOnLoadCallback(() => {
            renderScheduler?.invalidateAll();
        });

        window.addEventListener("image-fit-change", handleImageFitChange);

        document.addEventListener("mouseup", handleMouseUp);

        if (containerEl) {
            // ResizeObserver stores the latest dimensions and always uses them
            // in the RAF callback. The resizeTicking flag ensures at most one
            // RAF is queued, but intermediate entries update latestResize* so
            // the RAF never uses stale values.
            resizeObserver = new ResizeObserver((entries) => {
                const last = entries[entries.length - 1];
                const { width, height } = last.contentRect;
                if (width <= 0 || height <= 0) return;
                latestResizeW = width;
                latestResizeH = height;
                if (!resizeTicking) {
                    resizeTicking = true;
                    requestAnimationFrame(() => {
                        if (
                            virtualizer &&
                            latestResizeW > 0 &&
                            latestResizeH > 0
                        )
                            virtualizer.setContainerSize(
                                latestResizeW,
                                latestResizeH,
                            );
                        resizeTicking = false;
                    });
                }
            });
            resizeObserver.observe(containerEl);

            // Use getBoundingClientRect as an initial size hint.
            // The ResizeObserver will correct it once layout settles.
            const rect = containerEl.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && virtualizer)
                virtualizer.setContainerSize(rect.width, rect.height);
        }

        // On iOS Safari, the visual viewport shrinks when the keyboard appears.
        // This doesn't always trigger a ResizeObserver on the grid container,
        // so we listen directly and force a re-measure.
        // NOTE: Only listen for 'resize', NOT 'scroll'. The scroll event fires
        // during address bar hide/show animations with transitional heights,
        // which causes the canvas to be cleared and resized dozens of times
        // during a single scroll gesture, leading to blank canvas on mobile.
        if (window.visualViewport) {
            const onVVResize = () => {
                if (containerEl && virtualizer) {
                    const rect = containerEl.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0)
                        virtualizer.setContainerSize(rect.width, rect.height);
                }
            };
            window.visualViewport.addEventListener("resize", onVVResize);
            vvCleanup = () => {
                window.visualViewport?.removeEventListener(
                    "resize",
                    onVVResize,
                );
            };
        }

        if (!anchor) {
            selectionState.startSelection(0, 0);
            selectionState.endSelection();
        }
    });

    // ─── Passive touch event listeners (registered via effect, not template) ────
    // Using passive: true tells the browser it can start scrolling immediately
    // without waiting for these handlers. touch-action: pan-x pan-y already
    // handles this on Chrome/Edge, but passive listeners add explicit Safari support.
    $effect(() => {
        if (!scrollEl) return;
        const opts = { passive: true };
        scrollEl.addEventListener(
            "touchstart",
            handleEventLayerTouchStart,
            opts,
        );
        scrollEl.addEventListener("touchmove", handleEventLayerTouchMove, opts);
        scrollEl.addEventListener("touchend", handleEventLayerTouchEnd, opts);
        scrollEl.addEventListener(
            "touchcancel",
            handleEventLayerTouchCancel,
            opts,
        );
        return () => {
            scrollEl.removeEventListener(
                "touchstart",
                handleEventLayerTouchStart,
            );
            scrollEl.removeEventListener(
                "touchmove",
                handleEventLayerTouchMove,
            );
            scrollEl.removeEventListener("touchend", handleEventLayerTouchEnd);
            scrollEl.removeEventListener(
                "touchcancel",
                handleEventLayerTouchCancel,
            );
        };
    });

    onDestroy(() => {
        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
        if (resizeObserver) resizeObserver.disconnect();
        vvCleanup?.();
        virtualizer?.destroy();
        renderScheduler?.destroy();
        canvasRenderer?.destroy();
        selectionScheduler?.destroy();
        selectionRenderer?.destroy();
        setOnLoadCallback(null);
        window.removeEventListener("image-fit-change", handleImageFitChange);
    });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="grid-root" bind:this={containerEl}>
    {#if renderPlan && virtualizer}
        <!-- ── 1a. Data canvas (cell backgrounds, text, borders, gridlines) ── -->
        <!-- width/height="0" prevents the browser default 300×150 from showing -->
        <!-- before canvasRenderer.resize() sets the correct CSS dimensions.    -->
        <canvas
            bind:this={canvasEl}
            class="grid-canvas"
            width="0"
            height="0"
            style="position:absolute; left:{HEADER_WIDTH}px; top:{HEADER_HEIGHT}px; pointer-events:none;"
        ></canvas>

        <!-- ── 1b. Selection canvas (selection fills + formula highlights) ── -->
        <!-- Separate from data canvas so selection changes (arrow keys, mouse) -->
        <!-- only repaint this lightweight layer, not the full cell data. -->
        <canvas
            bind:this={selectCanvasEl}
            class="select-canvas"
            width="0"
            height="0"
            style="position:absolute; left:{HEADER_WIDTH}px; top:{HEADER_HEIGHT}px; pointer-events:none; z-index:3;"
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

            <!-- Dropdown cell overlay -->
            {#if focusedDropdownCell}
                {@const filteredOpts = dropdownFilter
                    ? focusedDropdownCell.options.filter((o) =>
                          String(o)
                              .toLowerCase()
                              .includes(dropdownFilter.toLowerCase()),
                      )
                    : focusedDropdownCell.options}
                <div
                    class="dropdown-cell-overlay"
                    style="position:absolute; left:{focusedDropdownCell.left}px; top:{focusedDropdownCell.top +
                        focusedDropdownCell.height}px; width:{Math.max(
                        focusedDropdownCell.width,
                        140,
                    )}px; z-index:30;"
                >
                    <input
                        class="dropdown-filter-input"
                        type="text"
                        placeholder="Search..."
                        bind:value={dropdownFilter}
                        autofocus
                        onkeydown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                if (filteredOpts.length > 0) {
                                    sheetStore?.setCellValue(
                                        focusedDropdownCell.row,
                                        focusedDropdownCell.col,
                                        filteredOpts[0],
                                    );
                                    focusedDropdownCell = null;
                                }
                            } else if (e.key === "Escape") {
                                focusedDropdownCell = null;
                            }
                        }}
                    />
                    {#each filteredOpts as opt}
                        <button
                            class="dropdown-option"
                            onmousedown={(e) => {
                                e.preventDefault();
                                sheetStore?.setCellValue(
                                    focusedDropdownCell.row,
                                    focusedDropdownCell.col,
                                    opt,
                                );
                                focusedDropdownCell = null;
                            }}>{opt}</button
                        >
                    {/each}
                    {#if filteredOpts.length === 0}
                        <div class="dropdown-no-match">No matches</div>
                    {/if}
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
                docId={spreadsheetSession.docId}
                onTabCommit={(dir, kind) => {
                    // dir: +1 = right/down, -1 = left/up; kind: 'tab' = horizontal
                    const dRow = kind === "tab" ? 0 : 1;
                    const dCol = kind === "tab" ? dir : 0;
                    if (editSessionState.isEditing) {
                        // Session still active (formula/plain text) — commit+move together
                        commitEditAndMove(dRow, dCol);
                    } else {
                        // Rich text: session was committed inside commitRichValue(),
                        // just move selection now.
                        selectionState.moveSelection(dRow, dCol);
                        scrollToAnchor();
                    }
                }}
            />

            <!-- Floating images layer (over-grid, draggable/resizable) -->
            {#if sheetStore && virtualizer && renderPlan}
                <FloatingImages
                    {sheetStore}
                    {virtualizer}
                    frozenWidth={renderPlan.frozenWidth}
                    frozenHeight={renderPlan.frozenHeight}
                    headerWidth={HEADER_WIDTH}
                    headerHeight={HEADER_HEIGHT}
                    docId={spreadsheetSession.docId}
                />
            {/if}

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
                        onValueChange={() =>
                            untrack(() => renderScheduler?.invalidateAll())}
                    />
                </div>
                <!-- Entry action buttons — inline to the right of the table, same row height -->
                {#if entryInsertButtonInfo}
                    <div
                        class="entry-action-bar"
                        style="position:absolute; left:{entryInsertButtonInfo.left +
                            4}px; top:{entryInsertButtonInfo.top}px; height:{entryInsertButtonInfo.height}px; z-index:23;"
                    >
                        <button
                            class="entry-add-btn"
                            onclick={commitEntryAndRefocus}
                            onmousedown={(e) => e.preventDefault()}
                            title="Add row (Enter)"
                            aria-label="Add row"
                        >
                            {@html plusIcon} Add
                        </button>
                        <button
                            class="entry-clear-btn"
                            onclick={() => {
                                focusedEntryCell.table.clearEntry();
                                focusedEntryCell = null;
                            }}
                            onmousedown={(e) => e.preventDefault()}
                            title="Clear entry (Escape)"
                            aria-label="Clear entry"
                        >
                            {@html closeIcon}
                        </button>
                    </div>
                {/if}
            {/if}

            <!-- Table header inline rename overlay (shown on double-click) -->
            {#if activeHeaderRename}
                <div
                    class="header-rename-overlay"
                    style="position:absolute; left:{activeHeaderRename.left}px; top:{activeHeaderRename.top}px; width:{activeHeaderRename.width}px; height:{activeHeaderRename.height}px; z-index:25;"
                >
                    <input
                        type="text"
                        class="header-rename-input"
                        value={activeHeaderRename.colDef.name ?? ""}
                        autofocus
                        onkeydown={(e) => {
                            if (e.key === "Enter" || e.key === "Tab") {
                                e.preventDefault();
                                e.stopPropagation();
                                const newName =
                                    /** @type {HTMLInputElement} */ (
                                        e.target
                                    ).value.trim();
                                if (newName)
                                    activeHeaderRename.table.renameColumn(
                                        activeHeaderRename.colDef.id,
                                        newName,
                                    );
                                activeHeaderRename = null;
                            } else if (e.key === "Escape") {
                                e.stopPropagation();
                                activeHeaderRename = null;
                            }
                        }}
                        onblur={(e) => {
                            const newName = /** @type {HTMLInputElement} */ (
                                e.target
                            ).value.trim();
                            if (newName)
                                activeHeaderRename?.table.renameColumn(
                                    activeHeaderRename.colDef.id,
                                    newName,
                                );
                            activeHeaderRename = null;
                        }}
                    />
                </div>
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

        <!-- ── Page break overlay ── -->
        {#if showPageBreaks && pageBreakLines}
            {@const { rowLines, colLines, printEndX, printEndY } =
                pageBreakLines}
            <svg
                class="page-break-overlay"
                style="position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:9; overflow:visible;"
                xmlns="http://www.w3.org/2000/svg"
            >
                <!-- Row page break lines -->
                {#each rowLines as y}
                    {#if y > HEADER_HEIGHT && y < 9999}
                        <line
                            x1={HEADER_WIDTH}
                            y1={y}
                            x2="100%"
                            y2={y}
                            stroke="#1a73e8"
                            stroke-width="1.5"
                            stroke-dasharray="6 3"
                            opacity="0.75"
                        />
                        <text
                            x={HEADER_WIDTH + 4}
                            y={y - 3}
                            font-size="9"
                            fill="#1a73e8"
                            opacity="0.75"
                            font-family="system-ui,sans-serif">page</text
                        >
                    {/if}
                {/each}

                <!-- Column page break lines -->
                {#each colLines as x}
                    {#if x > HEADER_WIDTH && x < 9999}
                        <line
                            x1={x}
                            y1={HEADER_HEIGHT}
                            x2={x}
                            y2="100%"
                            stroke="#1a73e8"
                            stroke-width="1.5"
                            stroke-dasharray="6 3"
                            opacity="0.75"
                        />
                    {/if}
                {/each}

                <!-- Print area end (right / bottom) shading -->
                {#if printEndX > HEADER_WIDTH && printEndX < 9999}
                    <rect
                        x={printEndX}
                        y={0}
                        width="9999"
                        height="100%"
                        fill="rgba(0,0,0,0.06)"
                    />
                {/if}
                {#if printEndY > HEADER_HEIGHT && printEndY < 9999}
                    <rect
                        x={0}
                        y={printEndY}
                        width="100%"
                        height="9999"
                        fill="rgba(0,0,0,0.06)"
                    />
                {/if}
            </svg>
        {/if}
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

{#if showFloatingImageInsert && anchor && sheetStore}
    <!-- Floating image upload dialog -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="floating-insert-backdrop"
        onmousedown={() => (showFloatingImageInsert = false)}
    >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="floating-insert-dialog"
            onmousedown={(e) => e.stopPropagation()}
        >
            <h3 class="floating-insert-title">Insert Floating Image</h3>
            <ImageEditor
                value=""
                docId={spreadsheetSession.docId}
                onCommit={(blobId, fit) => {
                    if (blobId && anchor) {
                        sheetStore.addFloatingImage({
                            blobId,
                            anchorRow: anchor.row,
                            anchorCol: anchor.col,
                            offsetX: 0,
                            offsetY: 0,
                            width: 240,
                            height: 160,
                            fit: fit ?? "contain",
                        });
                    }
                    showFloatingImageInsert = false;
                }}
                onCancel={() => (showFloatingImageInsert = false)}
            />
        </div>
    </div>
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

    /* ── Data canvas (z:2 — below selection and DOM overlays) ── */
    .grid-canvas {
        z-index: 2;
        display: block; /* prevent inline baseline gap */
    }

    /* ── Selection canvas (z:3 — above data canvas, below DOM overlays) ── */
    .select-canvas {
        display: block;
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
        will-change: transform;
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

    /* ── Dropdown cell overlay ── */
    .dropdown-cell-overlay {
        pointer-events: auto;
        background: white;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: 200px;
        overflow-y: auto;
    }

    .dropdown-option {
        padding: 5px 10px;
        text-align: left;
        background: none;
        border: none;
        border-bottom: 1px solid #f1f5f9;
        cursor: pointer;
        font-size: 0.8125rem;
        color: #1e293b;
        white-space: nowrap;
    }

    .dropdown-option:last-child {
        border-bottom: none;
    }
    .dropdown-option:hover {
        background: #eff6ff;
        color: #1d4ed8;
    }

    .dropdown-filter-input {
        width: 100%;
        padding: 5px 8px;
        border: none;
        border-bottom: 1px solid #e2e8f0;
        font-size: 0.8125rem;
        outline: none;
        box-sizing: border-box;
        background: #f8fafc;
    }

    .dropdown-no-match {
        padding: 6px 10px;
        font-size: 0.8125rem;
        color: #94a3b8;
        font-style: italic;
    }

    /* ── Entry action bar (right of entry row, inline with the row height) ── */
    .entry-action-bar {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 3px;
    }

    .entry-add-btn {
        border: 1px solid #3b82f6;
        background: #eff6ff;
        color: #1d4ed8;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 3px;
        border-radius: 4px;
        transition: background 0.1s;
        box-sizing: border-box;
        padding: 0 6px;
        height: 22px;
        white-space: nowrap;
    }

    .entry-add-btn:hover {
        background: #dbeafe;
    }

    .entry-clear-btn {
        width: 22px;
        height: 22px;
        border: 1px solid #e2e8f0;
        background: var(--cell-bg, #fff);
        color: #94a3b8;
        cursor: pointer;
        font-size: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: all 0.1s;
        box-sizing: border-box;
    }

    .entry-clear-btn:hover {
        background: #fef2f2;
        border-color: #fca5a5;
        color: #dc2626;
    }

    /* ── Table header inline rename overlay ── */
    .header-rename-overlay {
        pointer-events: auto;
        z-index: 25;
    }

    .header-rename-input {
        width: 100%;
        height: 100%;
        border: 2px solid var(--editor-outline, #3b82f6);
        background: #fff;
        padding: 0 6px;
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--text-color, #1e293b);
        box-sizing: border-box;
        outline: none;
    }

    /* ── Floating image insert dialog ── */
    .floating-insert-backdrop {
        position: fixed;
        inset: 0;
        z-index: 200;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.25);
    }

    .floating-insert-dialog {
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
        padding: 20px;
        min-width: 320px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .floating-insert-title {
        font-size: 0.9375rem;
        font-weight: 600;
        color: #1e293b;
        margin: 0;
    }

    /* ── Column config panel anchor ── */
    .col-config-anchor {
        pointer-events: auto;
    }
</style>
