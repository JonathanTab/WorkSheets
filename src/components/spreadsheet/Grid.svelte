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
    import { onMount, onDestroy, untrack, setContext } from "svelte";
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
        TOUCH_MOVE_THRESHOLD,
        DOUBLE_TAP_DELAY,
        LONG_PRESS_DELAY,
    } from "../../stores/spreadsheet/constants.js";
    import {
        OVERLAY_MARGIN_PX,
        OVERLAY_OFFSET_PX,
        PANEL_MIN_WIDTH,
        PANEL_MIN_HEIGHT,
        FILTER_POPOVER_DEFAULT_WIDTH,
        FILTER_POPOVER_DEFAULT_HEIGHT,
        TABLE_GRIP_HANDLE_PX,
    } from "../../stores/spreadsheet/gridConstants.js";
    import { toRangeRef } from "../../formulas/refCoords.js";
    import {
        clipboardManager,
        editSessionState,
        CellTypeRegistry,
        colParseConfig,
    } from "../../stores/spreadsheet/index.js";
    import { CELL_TYPE } from "../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
    import { clearFormatting as clearFormattingCmd } from "../../stores/spreadsheet/formatCommands.js";
    import { HitTestEngine } from "../../stores/spreadsheet/rendering/HitTestEngine.js";
    import { buildRenderRuns, hitTestLink } from "../../stores/spreadsheet/textFormatRuns.js";
    import { perfMon } from "../../stores/spreadsheet/perf/PerfMonitor.js";
    import GridOverlays from "./grid/GridOverlays.svelte";
    import LinkPopover from "./grid/LinkPopover.svelte";
    import ColHeaders from "./grid/ColHeaders.svelte";
    import RowHeaders from "./grid/RowHeaders.svelte";
    import GridContextMenu from "./grid/GridContextMenu.svelte";
    import { GridResizeController } from "./grid/GridResizeController.js";
    import { GridFillHandle } from "./grid/GridFillHandle.svelte.js";
    import { commitCellEdit } from "../../stores/spreadsheet/CellEditController.js";
    import { GridKeyboardController } from "./grid/GridKeyboardController.svelte.js";
    import { GridPaintCoordinator } from "./grid/GridPaintCoordinator.svelte.js";
    import FileViewer from "./cellTypes/FileViewer.svelte";
    import TableFilterPopover from "./features/TableFilterPopover.svelte";
    import TableCreateDialog from "./features/TableCreateDialog.svelte";
    import ViewPlacementOverlay from "./features/ViewPlacementOverlay.svelte";
    import { viewPlacementStore } from "../../stores/spreadsheet/viewPlacementStore.svelte.js";
    import { computePrintBounds, computePageBreaks } from "../../stores/spreadsheet/rendering/PrintShared.js";
    import FloatingImages from "./FloatingImages.svelte";
    import ImageEditor from "./cellTypes/ImageEditor.svelte";
    import DatePickerEditor from "./cellTypes/DatePickerEditor.svelte";
    import { setOnLoadCallback } from "../../stores/spreadsheet/rendering/ImageCache.js";
    import storage from "../../stores/storage.js";
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import AlertModal from "../modals/AlertModal.svelte";
    import { mobileState } from "../../stores/mobileState.svelte.js";
    import SelectionHandles from "./grid/SelectionHandles.svelte";
    import PluginOverlay from "./plugins/PluginOverlay.svelte";
    import EntryForgeOverlay from "./plugins/entryForge/EntryForgeOverlay.svelte";
    import SplitOverlay from "./plugins/entryForge/SplitOverlay.svelte";
    import { resolveRangeValues } from "../../stores/spreadsheet/rangeRefUtils.js";
    import "../../stores/spreadsheet/plugins/horam/registerHoramPlugin.js";
    import "../../stores/spreadsheet/plugins/entryForge/registerEntryForgePlugin.js";

    // ─── Props ─────────────────────────────────────────────────────────────────
    let {
        showPageBreaks = false,
        printSettings = null,
        requestMobileKeyboardFocus = null,
        onShowTablesPanel = undefined,
        onShowRepeatersPanel = undefined,
        showGridlines = true,
        showFormulas = false,
    } = $props();

    // ─── DOM refs ──────────────────────────────────────────────────────────────
    let containerEl = $state(null);
    let scrollEl = $state(null);
    let canvasEl = $state(null);
    let selectCanvasEl = $state(null);



    // ─── Resize controller ────────────────────────────────────────────────────
    const resizeCtrl = new GridResizeController();

    // ─── Fill-handle controller ───────────────────────────────────────────────
    const fillCtrl = new GridFillHandle();

    // ─── Keyboard controller ──────────────────────────────────────────────────
    const kbCtrl = new GridKeyboardController();

    // ─── Paint coordinator ────────────────────────────────────────────────────
    // Accessors, not mirrored fields — see GridPaintCoordinator for why. These
    // close over bindings declared later in this file; they are only invoked from
    // effects, which run after init, so the TDZ is never hit.
    const paintCoord = new GridPaintCoordinator({
        canvasEl: () => canvasEl,
        selectCanvasEl: () => selectCanvasEl,
        virtualizer: () => virtualizer,
        renderContext: () => renderContext,
        sheetStore: () => sheetStore,
        showGridlines: () => showGridlines,
        showFormulas: () => showFormulas,
        tableGripHoverRow: () => tableGripHoverRow,
        tableRowDrag: () => tableRowDrag,
    });


    // ─── Canvas rendering — owned by GridPaintCoordinator ────────────────────
    // \ refs let all existing renderScheduler?.invalidateAll() calls work
    // while the actual scheduler lives in paintCoord.
    let renderScheduler = $derived(paintCoord.renderScheduler);
    let selectionScheduler = $derived(paintCoord.selectionScheduler);
    let canvasRenderer = $derived(paintCoord.canvasRenderer);
    let selectionRenderer = $derived(paintCoord.selectionRenderer);
    const hitTestEngine = new HitTestEngine();
    // Expose to child components (e.g. SelectionHandles) without prop drilling
    setContext("hitTestEngine", hitTestEngine);

    // ─── Cut marquee (marching ants) ──────────────────────────────────────────
    // Animate the dashed cut outline by repainting the selection canvas each frame
    // while a cut is pending. The effect re-runs (and tears down) when the marquee
    // is set/cleared, so the rAF loop only runs while there's something to animate.
    $effect(() => {
        const marquee = clipboardManager.cutMarquee;
        // Repaint once on any change so the outline appears/erases immediately.
        paintCoord.performSelectionPaint();
        if (!marquee) return;
        let raf = requestAnimationFrame(function tick() {
            paintCoord.performSelectionPaint();
            raf = requestAnimationFrame(tick);
        });
        return () => cancelAnimationFrame(raf);
    });

    // Cancel a pending cut when the user starts editing or switches sheets. The
    // clipboard contents survive; the cut simply downgrades to a copy.
    $effect(() => {
        const editing = editSessionState.isEditing;
        const sid = spreadsheetSession.activeSheetId;
        const marquee = clipboardManager.cutMarquee;
        if (marquee && (editing || marquee.sheetId !== sid)) {
            untrack(() => clipboardManager.cancelCut());
        }
    });

    // ─── Grid virtualizer ─────────────────────────────────────────────────────
    let virtualizer = $state(null);
    let overlaysRef = $state(null);
    let virtualizerSheetId = $state.raw(null);
    let resizeObserver = null;
    let dprMql = null; // matchMedia query for DPR change (moving between displays)
    let vvCleanup = null; // visual viewport cleanup for iOS keyboard handling
    let remeasureRAF = null; // post-mount deferred re-measure (mobile layout settling)
    let onPageVisibleHandler = null; // re-arms the deferred re-measure burst on foreground
    /** @type {Map<string, {scrollTop: number, scrollLeft: number}>} */
    const sheetScrollPositions = new Map();
    /** @type {Map<string, any>} Per-sheet selection snapshots, mirroring sheetScrollPositions */
    const sheetSelections = new Map();

    // ─── Page break overlay ───────────────────────────────────────────────────
    /**
     * Compute page break lines for the overlay.
     * Returns arrays of pixel positions (in grid-root container space).
     * Only computed when showPageBreaks=true to avoid overhead.
     */
    let pageBreakLines = $derived.by(() => {
        if (!showPageBreaks || !virtualizer || !printSettings) return null;

        const sheetStore = spreadsheetSession.activeSheetStore;
        const totalRows = sheetStore?.rowCount ?? 100;
        const totalCols = sheetStore?.colCount ?? 26;

        // For usedArea mode, compute actual content bounds so page breaks and
        // shading match what the PDF engine will produce.
        let effectiveSettings = printSettings;
        const printArea = printSettings.printArea ?? 'usedArea';
        if (printArea === 'usedArea' && sheetStore) {
            const bounds = computePrintBounds(sheetStore, virtualizer.rowMetrics, virtualizer.colMetrics);
            if (bounds) {
                effectiveSettings = { ...printSettings,
                    areaStartRow: bounds.startRow, areaStartCol: bounds.startCol,
                    areaEndRow:   bounds.endRow,   areaEndCol:   bounds.endCol,
                };
            }
        }

        const { rowBreaks, colBreaks } = computePageBreaks(
            effectiveSettings,
            virtualizer.rowMetrics,
            virtualizer.colMetrics,
            totalRows,
            totalCols,
        );

        const scrollLeft = virtualizer.scrollLeft;
        const scrollTop = virtualizer.scrollTop;

        // Convert row breaks to Y positions in grid-root container coords.
        // Row break at rowIndex R means a new page starts at R; line goes just before R.
        const rowLines = rowBreaks.slice(1).map((r) => {
            return HEADER_HEIGHT + virtualizer.rowMetrics.offsetOf(r) - scrollTop;
        });

        // Convert col breaks to X positions
        const colLines = colBreaks.slice(1).map((c) => {
            return HEADER_WIDTH + virtualizer.colMetrics.offsetOf(c) - scrollLeft;
        });

        // Shading: dim everything outside the print area.
        const areaEndRow = effectiveSettings.areaEndRow ?? totalRows - 1;
        const areaEndCol = effectiveSettings.areaEndCol ?? totalCols - 1;
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
    let currentCursor = $state("cell");

    // ─── Drag auto-scroll state ───────────────────────────────────────────────
    let dragAutoScrollRAF = null;
    let dragClientX = 0;
    let dragClientY = 0;


    // ─── Link popover (shown when hovering a cell with link runs) ────────────
    // null | { url, cellLeft, cellTop, cellWidth, cellHeight }
    let hoveredLink = $state(null);

    // ─── Table row drag / grip hover ─────────────────────────────────────────
    let tableGripHoverRow = $state(-1); // grid row whose grip is hovered (-1 = none)
    // null | { table, fromDisplayIndex, fromGridRow, ghostY, dropGridRow, dropDisplayIndex }
    let tableRowDrag = $state(null);
    // Width/left of the ghost bar in container coords (derived when drag is active)
    let tableRowDragGeom = $derived.by(() => {
        if (!tableRowDrag || !virtualizer || !renderPlan) return null;
        const { table } = tableRowDrag;
        const left = cellContainerLeft(table.startCol);
        const right = cellContainerLeft(table.endCol) + virtualizer.getColWidth(table.endCol);
        return { left, width: Math.max(0, right - left) };
    });

    // ─── Out-of-order notice ──────────────────────────────────────────────────
    // { table, displayIndex, gridRow, placeInOrder: fn } | null
    let outOfOrderNotice = $state(null);

    // ─── Overlay state ────────────────────────────────────────────────────────
    /** @type {{ table:any, colId:string|null, anchorRow:number, anchorCol:number }|null} */
    let activeFilterPopover = $state(null);

    // ─── Filter popover position (with boundary detection) ───────────────────
    let filterPopoverPosition = $state(null);
    let filterPopoverEl = $state(null);

    /**
     * Calculate position for filter popover, ensuring it stays within viewport.
     */
    function getContainerKeyboardOverlapPx() {
        if (!mobileState.isMobile || !mobileState.isKeyboardOpen || !containerEl)
            return 0;
        const cr = containerEl.getBoundingClientRect();
        const keyboardTop = window.innerHeight - mobileState.keyboardHeight;
        return Math.max(0, cr.bottom - keyboardTop);
    }

    function getContainerVisibleBottomPx() {
        if (!containerEl) return 0;
        const cr = containerEl.getBoundingClientRect();
        return Math.max(0, cr.height - getContainerKeyboardOverlapPx());
    }

    function clamp(v, min, max) {
        return Math.min(Math.max(v, min), max);
    }

    function getOverlayViewportRect(margin = OVERLAY_MARGIN_PX) {
        if (!containerEl) return null;
        const width = containerEl.clientWidth;
        const visibleBottom = getContainerVisibleBottomPx();
        return {
            left: margin,
            top: margin,
            right: Math.max(margin, width - margin),
            bottom: Math.max(margin, visibleBottom - margin),
        };
    }

    /**
     * Position a panel near an anchor while keeping it visible in the grid viewport.
     * @param {{ left:number, top:number, width:number, height:number }} anchor
     * @param {{ width:number, height:number }} panel
     * @param {{ preferX?: 'start'|'end', preferY?: 'below'|'above', offset?: number, margin?: number }} [opts]
     */
    function placeOverlayNearAnchor(anchor, panel, opts = {}) {
        const offset = opts.offset ?? OVERLAY_OFFSET_PX;
        const margin = opts.margin ?? OVERLAY_MARGIN_PX;
        const bounds = getOverlayViewportRect(margin);
        if (!bounds) return { left: anchor.left, top: anchor.top + anchor.height + offset };

        const panelWidth = Math.max(PANEL_MIN_WIDTH, panel.width);
        const panelHeight = Math.max(PANEL_MIN_HEIGHT, panel.height);
        const preferX = opts.preferX ?? "start";
        const preferY = opts.preferY ?? "below";

        let left =
            preferX === "end"
                ? anchor.left + anchor.width - panelWidth
                : anchor.left;
        let top =
            preferY === "above"
                ? anchor.top - panelHeight - offset
                : anchor.top + anchor.height + offset;

        const roomBelow = bounds.bottom - (anchor.top + anchor.height + offset);
        const roomAbove = anchor.top - offset - bounds.top;
        if (preferY === "below" && roomBelow < panelHeight && roomAbove > roomBelow) {
            top = anchor.top - panelHeight - offset;
        } else if (preferY === "above" && roomAbove < panelHeight && roomBelow > roomAbove) {
            top = anchor.top + anchor.height + offset;
        }

        if (left + panelWidth > bounds.right) {
            left = anchor.left + anchor.width - panelWidth;
        }
        left = clamp(left, bounds.left, Math.max(bounds.left, bounds.right - panelWidth));
        top = clamp(top, bounds.top, Math.max(bounds.top, bounds.bottom - panelHeight));
        return { left: Math.round(left), top: Math.round(top) };
    }

    function getTableHeaderAnchorRect(table, colId) {
        if (!table || !colId || !virtualizer) return null;
        const idx = table.columns.findIndex((c) => c.id === colId);
        if (idx < 0) return null;
        const col = table.startCol + idx;
        const row = table.startRow;
        return {
            left: cellContainerLeft(col),
            top: cellContainerTop(row),
            width: virtualizer.getColWidth(col),
            height: virtualizer.getRowHeight(row),
        };
    }

    function calculateFilterPopoverPosition() {
        if (!activeFilterPopover || !containerEl || !virtualizer) return null;
        const anchor = getTableHeaderAnchorRect(
            activeFilterPopover.table,
            activeFilterPopover.colId,
        );
        if (!anchor) return null;
        const panelRect = filterPopoverEl?.getBoundingClientRect();
        return placeOverlayNearAnchor(
            anchor,
            {
                width: panelRect?.width ?? FILTER_POPOVER_DEFAULT_WIDTH,
                height: panelRect?.height ?? FILTER_POPOVER_DEFAULT_HEIGHT,
            },
            {
                preferX: "end",
                preferY: "below",
                offset: 4,
                margin: 8,
            },
        );
    }

    // ─── Edit panel position (with boundary detection) ────────────────────────
    /** @type {{ x: number, y: number }|null} */
    // Recalculate filter popover position when it changes
    $effect(() => {
        const _sl = virtualizer?.scrollLeft;
        const _st = virtualizer?.scrollTop;
        const _cw = containerEl?.clientWidth;
        const _vh = getContainerVisibleBottomPx();
        const _panelEl = filterPopoverEl;
        if (activeFilterPopover && containerEl && virtualizer) {
            filterPopoverPosition = calculateFilterPopoverPosition();
        } else {
            filterPopoverPosition = null;
        }
    });
    /** Stores last TABLE_ENTRY edit info for post-commit navigation (rich-text path). */
    let lastTableEntryEditInfo = $state(null);

    // ─── Context menu ─────────────────────────────────────────────────────────
    let contextMenuVisible = $state(false);
    let contextMenuPosition = $state({ x: 0, y: 0 });

    // ─── File viewer (portalled outside grid-root to escape contain:layout) ───
    let fileViewerProps = $state(null);

    function handleShowFileViewer(e) {
        fileViewerProps = e.detail ?? null;
    }

    // ─── Touch interaction state ───────────────────────────────────────────────
    let touchStartPos = null; // { x, y } of first touch
    let touchHandled = false; // suppress synthetic mouse events after touch
    let touchScrolled = false; // true once movement threshold exceeded
    let lastTapTime = 0; // for double-tap detection
    let lastTapPos = null; // position of last tap
    let isLongPressDragging = false; // long-press-drag range selection mode
    let longPressTimer = null; // for long-press context menu

    // ─── Dialog state ─────────────────────────────────────────────────────────
    let showCreateTableDialog = $state(false);
    let showFloatingImageInsert = $state(false);

    function handleInsertFloatingImageEvent() {
        if (selectionState.anchor && spreadsheetSession.activeSheetStore) {
            showFloatingImageInsert = true;
        }
    }

    // ─── Derived store state ──────────────────────────────────────────────────
    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let renderContext = $derived(spreadsheetSession.renderContext);
    let renderPlan = $derived(virtualizer ? virtualizer.renderPlan : null);

    // Keep resize controller deps in sync with reactive Grid state
    $effect(() => { resizeCtrl.virtualizer = virtualizer; });
    $effect(() => { resizeCtrl.sheetStore = sheetStore; });
    $effect(() => { resizeCtrl.containerEl = containerEl; });
    $effect(() => { resizeCtrl.renderScheduler = renderScheduler; });

    // Keep fill-handle controller deps in sync
    $effect(() => { fillCtrl.sheetStore = sheetStore; });
    $effect(() => { fillCtrl.renderContext = renderContext; });
    $effect(() => { fillCtrl.renderScheduler = renderScheduler; });
    $effect(() => { fillCtrl.selectionScheduler = selectionScheduler; });
    $effect(() => { fillCtrl.doHitTest = doHitTest; });
    $effect(() => { fillCtrl.getLocalCoords = getLocalCoords; });
    $effect(() => { fillCtrl.onCursorChange = (c) => { currentCursor = c; }; });

    // Keep keyboard controller context in sync
    $effect(() => {
        kbCtrl.ctx = {
            virtualizer,
            renderScheduler,
            beginCellEdit,
            commitEditAndMove,
            cancelEdit,
            moveSelectionMergeAware,
            jumpToEdgeAndSelect,
            scrollToAnchor,
            scrollToFocus,
            scrollToPrimaryCell,
        };
    });

    // Paint coordinator deps need no mirroring effects — it reads them live
    // through the accessors passed to its constructor.

    /**
     * Map from grid row → Y offset within the sticky table header band.
     * A row appears here when its table's header has scrolled past the frozen band
     * but the table still has data rows in view. Used by cellContainerTop() so
     * that the anchor border, editor, and dropdown overlays render at the correct
     * sticky position rather than off-screen.
     *   row → 0             header row (top of sticky band)
     *   row → headerHeightPx  entry row (just below header in sticky band)
     */
    let stickyRowPositions = $derived.by(() => {
        const result = new Map();
        if (!renderContext || !virtualizer || !renderPlan) return result;
        // Track table structure changes so we recompute when tables are added/removed
        const _tableVer = renderContext?.tableManager?.tableVersion;
        const headers = renderContext.getStickyTableHeaders(
            virtualizer.scrollTop,
            renderPlan.frozenHeight,
            virtualizer.rowMetrics,
            virtualizer.colMetrics,
        );
        for (const h of headers) {
            result.set(h.table.startRow, 0);
            if (h.showEntry) {
                result.set(h.table.startRow + 1, h.headerHeightPx);
            }
        }
        return result;
    });
    let selection = $derived(selectionState.range);
    let anchor = $derived(selectionState.anchor);
    let isFormulaEditMode = $derived(editSessionState.isFormulaMode);
    let rowCount = $derived(sheetStore?.rowCount ?? 0);
    let colCount = $derived(sheetStore?.colCount ?? 0);
    let remoteSelections = $derived(spreadsheetSession.remoteSelections);

    // ─── Broadcast local selection to awareness ───────────────────────────────
    $effect(() => {
        // Track selection and active sheet for broadcasting
        const _sel = selectionState.range;
        const _selMode = selectionState.selectionMode;
        const _selRows = selectionState.selectedRows;
        const _selCols = selectionState.selectedCols;
        const _anch = selectionState.anchor;
        const _sheetId = spreadsheetSession.activeSheetId;

        untrack(() => {
            if (!_sheetId) return;

            // Build selection payload based on mode
            if (_selMode === "range" && _sel) {
                spreadsheetSession.setLocalSelection({
                    mode: "range",
                    startRow: _sel.startRow,
                    startCol: _sel.startCol,
                    endRow: _sel.endRow,
                    endCol: _sel.endCol,
                });
            } else if (_selMode === "rows" && _selRows) {
                spreadsheetSession.setLocalSelection({
                    mode: "rows",
                    startRow: _selRows.start,
                    endRow: _selRows.end,
                });
            } else if (_selMode === "cols" && _selCols) {
                spreadsheetSession.setLocalSelection({
                    mode: "cols",
                    startCol: _selCols.start,
                    endCol: _selCols.end,
                });
            } else if (_selMode === "all") {
                spreadsheetSession.setLocalSelection({ mode: "all" });
            } else if (_anch) {
                spreadsheetSession.setLocalSelection({
                    mode: "cell",
                    row: _anch.row,
                    col: _anch.col,
                });
            }
        });
    });


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
                // True sheet switch (as opposed to first-ever virtualizer setup).
                const isSwitch = virtualizerSheetId !== null;
                if (virtualizer) {
                    sheetScrollPositions.set(virtualizerSheetId, {
                        scrollTop: virtualizer.scrollTop,
                        scrollLeft: virtualizer.scrollLeft,
                    });
                    virtualizer.destroy();
                }
                if (isSwitch) {
                    sheetSelections.set(virtualizerSheetId, selectionState.snapshot());
                }
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
                const saved = sheetScrollPositions.get(sheetId);
                const restoredTop = saved?.scrollTop ?? 0;
                const restoredLeft = saved?.scrollLeft ?? 0;
                virtualizer.setScroll(restoredTop, restoredLeft);
                if (scrollEl) {
                    scrollEl.scrollTop = restoredTop;
                    scrollEl.scrollLeft = restoredLeft;
                }
                // Selection is document-wide but sheet-specific in meaning —
                // give the incoming sheet its own cursor back (or A1 the first
                // time we see it) instead of the outgoing sheet's coordinates,
                // which may not even exist here.
                if (isSwitch) {
                    selectionState.restore(
                        sheetSelections.get(sheetId),
                        rowCount,
                        colCount,
                    );
                }
            }

            virtualizer.setSheetDimensions(rowCount, colCount);
            virtualizer.setFrozenDimensions(frozenRows, frozenCols);
            virtualizer.syncRowHeights(sheetStore.getRowHeightsMap());
            virtualizer.syncColWidths(sheetStore.getColWidthsMap());
        });
    });

    // ─── HitTestEngine sync ────────────────────────────────────────────────────
    $effect(() => {
        if (virtualizer) hitTestEngine.setVirtualizer(virtualizer);
    });

    /**
     * Hit-test with sticky table header awareness.
     * When the click coordinates land in the sticky table header/entry overlay
     * (painted at the top of the scrollable body area when those rows have scrolled
     * past), remap the result to the actual table row so all interaction logic
     * (sort, filter, entry editing) works correctly.
     */
    function doHitTest(localX, localY) {
        if (renderContext && virtualizer && renderPlan) {
            const contentX = localX - HEADER_WIDTH;
            const contentY = localY - HEADER_HEIGHT;
            const frozenH = renderPlan.frozenHeight;

            // Sticky area starts right at the bottom edge of the frozen band
            if (contentY >= frozenH) {
                const stickyHeaders = renderContext.getStickyTableHeaders(
                    virtualizer.scrollTop,
                    frozenH,
                    virtualizer.rowMetrics,
                    virtualizer.colMetrics,
                );

                for (const h of stickyHeaders) {
                    const stickyH = h.headerHeightPx + (h.showEntry ? h.entryHeightPx : 0);
                    if (contentY >= frozenH + stickyH) continue;

                    const tableLeft = h.leftPx - virtualizer.scrollLeft;
                    if (contentX < tableLeft || contentX >= tableLeft + h.widthPx) continue;

                    // Determine row: header or entry
                    const row = (contentY < frozenH + h.headerHeightPx)
                        ? h.table.startRow
                        : h.table.startRow + 1;

                    // Determine column from per-column widths
                    let col = h.table.endCol;
                    let xCursor = tableLeft;
                    for (let i = 0; i < h.colWidths.length; i++) {
                        if (contentX < xCursor + h.colWidths[i]) {
                            col = h.table.startCol + i;
                            break;
                        }
                        xCursor += h.colWidths[i];
                    }

                    return { row, col, region: 'cell', pane: 'sticky' };
                }
            }
        }
        return hitTestEngine.hitTest(localX, localY);
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
            virtualizer.colMetrics.offsetOf(col) -
            virtualizer.scrollLeft
        );
    }

    function cellContainerTop(row) {
        if (!virtualizer || !renderPlan) return HEADER_HEIGHT;
        if (row < virtualizer.frozenRows) {
            return HEADER_HEIGHT + virtualizer.rowMetrics.offsetOf(row);
        }
        // If this row is currently in the sticky table header overlay, return its
        // position within the sticky band so that editor/anchor/dropdown overlays
        // appear at the correct on-screen location instead of off-screen.
        const sp = stickyRowPositions;
        if (sp.has(row)) {
            return HEADER_HEIGHT + renderPlan.frozenHeight + sp.get(row);
        }
        return (
            HEADER_HEIGHT +
            virtualizer.rowMetrics.offsetOf(row) -
            virtualizer.scrollTop
        );
    }

    // ─── DOM overlay position deriveds ────────────────────────────────────────

    /** Compute a border style string for a cell range (null = skip). */
    function rangeBorderStyle(range) {
        const eff = expandRangeForMerges(range, renderContext?.mergeEngine) ?? range;
        if (!eff) return null;
        const isSingle = eff.startRow === eff.endRow && eff.startCol === eff.endCol;
        if (isSingle) return null;
        const left = cellContainerLeft(eff.startCol);
        const top = cellContainerTop(eff.startRow);
        const right = cellContainerLeft(eff.endCol) + virtualizer.getColWidth(eff.endCol);
        const bottom = cellContainerTop(eff.endRow) + virtualizer.getRowHeight(eff.endRow);
        return `transform:translate(${left}px,${top}px); width:${Math.max(0, right - left)}px; height:${Math.max(0, bottom - top)}px;`;
    }

    /** One style string per visible selection border (active + extra ranges). */
    let selectionBorderStyles = $derived.by(() => {
        const mode = selectionState.selectionMode;
        if (!virtualizer || !renderPlan) return [];

        if (mode === 'range') {
            const styles = [];
            // Active range (merge-expanded)
            const activeStyle = rangeBorderStyle(selectionState.range);
            if (activeStyle) styles.push(activeStyle);
            // Extra ranges
            for (const r of selectionState.extraRanges) {
                const s = rangeBorderStyle(r);
                if (s) styles.push(s);
            }
            return styles;
        }

        if (mode === 'rows') {
            const styles = [];
            for (const sr of selectionState.allRowRanges) {
                const top = cellContainerTop(sr.start);
                const bottom = cellContainerTop(sr.end) + virtualizer.getRowHeight(sr.end);
                styles.push(`transform:translate(${HEADER_WIDTH}px,${top}px); width:${renderPlan.totalWidth}px; height:${Math.max(0, bottom - top)}px;`);
            }
            return styles;
        }

        if (mode === 'cols') {
            const styles = [];
            for (const sc of selectionState.allColRanges) {
                const left = cellContainerLeft(sc.start);
                const right = cellContainerLeft(sc.end) + virtualizer.getColWidth(sc.end);
                styles.push(`transform:translate(${left}px,${HEADER_HEIGHT}px); width:${Math.max(0, right - left)}px; height:${renderPlan.totalHeight}px;`);
            }
            return styles;
        }

        if (mode === 'all') {
            return [`transform:translate(${HEADER_WIDTH}px,${HEADER_HEIGHT}px); width:${renderPlan.totalWidth}px; height:${renderPlan.totalHeight}px;`];
        }

        return [];
    });

    /**
     * Selection bounding box in container-local px for SelectionHandles (mobile).
     * Returns {x, y, width, height} or null when there is no range.
     */
    let selectionHandleRect = $derived.by(() => {
        if (!virtualizer || !renderPlan) return null;
        const mode = selectionState.selectionMode;
        let x, y, width, height;
        if (mode === 'range') {
            const eff = expandedRange ?? selectionState.range;
            if (!eff) {
                // Single anchor cell
                const anch = selectionState.anchor;
                if (!anch) return null;
                x = cellContainerLeft(anch.col);
                y = cellContainerTop(anch.row);
                width = virtualizer.getColWidth(anch.col);
                height = virtualizer.getRowHeight(anch.row);
            } else {
                x = cellContainerLeft(eff.startCol);
                y = cellContainerTop(eff.startRow);
                const right = cellContainerLeft(eff.endCol) + virtualizer.getColWidth(eff.endCol);
                const bottom = cellContainerTop(eff.endRow) + virtualizer.getRowHeight(eff.endRow);
                width = Math.max(0, right - x);
                height = Math.max(0, bottom - y);
            }
        } else if (mode === 'rows') {
            const sr = selectionState.selectedRows;
            if (!sr) return null;
            x = HEADER_WIDTH;
            y = cellContainerTop(sr.start);
            width = renderPlan.totalWidth;
            height = Math.max(0, cellContainerTop(sr.end) + virtualizer.getRowHeight(sr.end) - y);
        } else if (mode === 'cols') {
            const sc = selectionState.selectedCols;
            if (!sc) return null;
            x = cellContainerLeft(sc.start);
            y = HEADER_HEIGHT;
            width = Math.max(0, cellContainerLeft(sc.end) + virtualizer.getColWidth(sc.end) - x);
            height = renderPlan.totalHeight;
        } else if (mode === 'all') {
            x = HEADER_WIDTH; y = HEADER_HEIGHT;
            width = renderPlan.totalWidth; height = renderPlan.totalHeight;
        } else {
            return null;
        }
        return { x, y, width, height };
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
                return `transform:translate(${left}px,${top}px); width:${width}px; height:${height}px;`;
            }
        }

        const left = cellContainerLeft(anchor.col);
        const top = cellContainerTop(anchor.row);
        const width = virtualizer.getColWidth(anchor.col);
        const height = virtualizer.getRowHeight(anchor.row);
        return `transform:translate(${left}px,${top}px); width:${width}px; height:${height}px;`;
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

        let bounds = null;

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
                bounds = { top, left, width, height };
            }
        }

        if (!bounds) {
            bounds = {
                top: cellContainerTop(row),
                left: cellContainerLeft(col),
                width: virtualizer.getColWidth(col),
                height: virtualizer.getRowHeight(row),
            };

            // Expand editor bounds to match the overflow area as the user types.
            // Only for plain text (non-formula) editing of regular cells.
            const draft = editSessionState.draft;
            if (draft && renderContext && !editSessionState.isFormulaMode) {
                // Determine hAlign with same col→row→cell priority as CellPaintData
                const _sc = sheetStore?.getCell(row, col);
                let hAlign = 'left';
                const _colFmt = sheetStore?.getColFormatting?.(col);
                if (_colFmt?.horizontalAlign) hAlign = _colFmt.horizontalAlign;
                const _rowFmt = sheetStore?.getRowFormatting?.(row);
                if (_rowFmt?.horizontalAlign) hAlign = _rowFmt.horizontalAlign;
                if (_sc?.horizontalAlign) hAlign = _sc.horizontalAlign;

                const colRange = renderPlan?.plans?.body?.colRange ?? { start: 0, end: 9999 };
                const { leftExtra, rightExtra } = renderContext.getEditorOverflow(
                    row, col, draft, hAlign, colRange, virtualizer.colMetrics,
                );
                if (leftExtra > 0) {
                    bounds.left -= leftExtra;
                    bounds.width += leftExtra;
                }
                if (rightExtra > 0) {
                    bounds.width += rightExtra;
                }
            }
        }

        // Keep in-cell editor visible above the soft keyboard on mobile.
        if (mobileState.isMobile && mobileState.isKeyboardOpen && containerEl) {
            const visibleBottom = getContainerVisibleBottomPx();
            const margin = 8;
            const pickerMode = editSessionState.pickerMode;
            const preferredEditorHeight =
                pickerMode === "image-picker"
                    ? 340
                    : pickerMode === "file-picker"
                      ? 360
                      : pickerMode
                        ? 320
                        : bounds.height;
            const preferredEditorWidth =
                pickerMode === "image-picker"
                    ? 300
                    : pickerMode === "file-picker"
                      ? 320
                      : bounds.width;
            const maxTop = Math.max(
                HEADER_HEIGHT,
                visibleBottom - preferredEditorHeight - margin,
            );
            if (bounds.top > maxTop) bounds.top = maxTop;
            const maxLeft = Math.max(
                HEADER_WIDTH,
                containerEl.clientWidth - preferredEditorWidth - margin,
            );
            if (bounds.left > maxLeft) bounds.left = maxLeft;
            if (bounds.left < HEADER_WIDTH) bounds.left = HEADER_WIDTH;
        }

        return bounds;
    });

    let isEditingEntryRow = $derived.by(() => {
        if (!editSessionState.isEditing) return false;
        const row = editSessionState.cell?.row;
        const col = editSessionState.cell?.col;
        if (row == null || col == null) return false;
        return renderContext?.getCellType(row, col) === CELL_TYPE.TABLE_ENTRY;
    });

    let selectedEntryRowInfo = $derived.by(() => {
        const a = anchor;
        if (!a || !virtualizer || !renderPlan) return null;
        if (renderContext?.getCellType(a.row, a.col) !== CELL_TYPE.TABLE_ENTRY) return null;
        return renderContext.tableManager?.getCellInfo(a.row, a.col) ?? null;
    });

    let entryRowHasValues = $derived.by(() => {
        const buf = selectedEntryRowInfo?.table?.entryBuffer;
        if (!buf) return false;
        return Object.values(buf).some(v => v !== null && v !== undefined && v !== '');
    });

    let entryRowHintStyle = $derived.by(() => {
        if (!selectedEntryRowInfo) return "display:none;";
        if (!isEditingEntryRow && !entryRowHasValues) return "display:none;";
        let left, top, height;
        if (isEditingEntryRow && editorBoundsForOverlay) {
            const b = editorBoundsForOverlay;
            left = b.left; top = b.top; height = b.height;
        } else {
            const a = anchor;
            if (!a) return "display:none;";
            left = cellContainerLeft(a.col);
            top = cellContainerTop(a.row);
            height = virtualizer?.getRowHeight(a.row) ?? 24;
        }
        return `left:${left}px; top:${top + height + 4}px;`;
    });

    let dropdownOverlayStyle = $derived.by(() => {
        if (!kbCtrl.focusedDropdownCell || !containerEl) return "display:none;";
        const preferredWidth = Math.max(kbCtrl.focusedDropdownCell.width, 164);
        const preferredHeight = 240;
        const anchor = {
            left: kbCtrl.focusedDropdownCell.left,
            top: kbCtrl.focusedDropdownCell.top,
            width: kbCtrl.focusedDropdownCell.width,
            height: kbCtrl.focusedDropdownCell.height,
        };
        const placed = placeOverlayNearAnchor(
            anchor,
            { width: preferredWidth, height: preferredHeight },
            { preferX: "start", preferY: "below", offset: 4, margin: 8 },
        );
        const visibleBottom = getContainerVisibleBottomPx();
        const maxHeight = Math.max(100, visibleBottom - placed.top - 8);
        return `position:absolute; left:${placed.left}px; top:${placed.top}px; width:${Math.round(preferredWidth)}px; max-height:${Math.round(maxHeight)}px; z-index:30;`;
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
     * Expand a range rect to cover every merge it overlaps.
     * Delegates to MergeEngine.expandRange so the algorithm lives in one place.
     * @param {{startRow,endRow,startCol,endCol}|null} range
     * @param {import('../../stores/spreadsheet/features/MergeEngine.svelte.js').MergeEngine|null|undefined} me
     * @returns {{startRow,endRow,startCol,endCol}|null}
     */
    function expandRangeForMerges(range, me) {
        if (!range || !me) return range;
        return me.expandRange(range);
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
     * After any anchor/focus change, expand the selection range to fully cover
     * every merge that overlaps it.  The anchor stays fixed; focus is pushed to
     * whichever edge of the expanded range is farther from the anchor.
     */
    function normalizeSelectionForMerges() {
        const mergeEngine = renderContext?.mergeEngine;
        if (!mergeEngine || mergeEngine.merges.length === 0) return;
        const range  = selectionState.range;
        const anchor = selectionState.anchor;
        const focus  = selectionState.focus;
        if (!range || !anchor || !focus) return;

        const expanded = expandRangeForMerges(range, mergeEngine);
        if (!expanded) return;
        if (
            expanded.startRow === range.startRow && expanded.endRow === range.endRow &&
            expanded.startCol === range.startCol && expanded.endCol === range.endCol
        ) return;

        // Push focus to the far edge of the expansion (anchor direction determines which edge)
        const newFocusRow = anchor.row <= focus.row ? expanded.endRow : expanded.startRow;
        const newFocusCol = anchor.col <= focus.col ? expanded.endCol : expanded.startCol;
        selectionState.focus = { row: newFocusRow, col: newFocusCol };
    }

    /**
     * Start a fresh selection that covers the full merge when the target cell is
     * inside a merged region (anchor = primary cell, focus = end cell of merge).
     * For regular cells, equivalent to startSelection(row, col).
     */
    function startSelectionOnCell(row, col) {
        const snapped = snapToMergePrimary(row, col);
        selectionState.startSelection(snapped.row, snapped.col);
        normalizeSelectionForMerges();
    }

    /**
     * Extend the active selection to a cell, then expand to cover any overlapping
     * merges — so the full extent of every touched merge is always included.
     */
    function extendSelectionToCell(row, col) {
        selectionState.extendSelection(row, col);
        normalizeSelectionForMerges();
    }

    /**
     * Check whether a pointer event landed inside the rendered checkbox square.
     * Checkbox rendering is centered and sized to min(16, cellHeight-4, cellWidth-4).
     */
    function isCheckboxClick(row, col, e) {
        if (!containerEl || !virtualizer) return false;
        const { localX, localY } = getLocalCoords(e);
        const cellLeft = cellContainerLeft(col);
        const cellTop = cellContainerTop(row);
        const cellWidth = virtualizer.getColWidth(col);
        const cellHeight = virtualizer.getRowHeight(row);
        const size = Math.min(16, cellHeight - 4, cellWidth - 4);
        if (size <= 0) return false;

        const checkboxLeft = cellLeft + (cellWidth - size) / 2;
        const checkboxTop = cellTop + (cellHeight - size) / 2;
        const checkboxRight = checkboxLeft + size;
        const checkboxBottom = checkboxTop + size;

        return (
            localX >= checkboxLeft &&
            localX <= checkboxRight &&
            localY >= checkboxTop &&
            localY <= checkboxBottom
        );
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
                    selectionState.extraRanges = [];
                    selectionState.primaryCell = null;
                    selectionState.anchor = { row: snapped.row, col: snapped.col };
                    selectionState.focus  = { row: snapped.row, col: snapped.col };
                    normalizeSelectionForMerges();
                    return;
                }
            }
        }

        selectionState.moveSelection(dRow, dCol, extend, rowCount, colCount);

        if (!extend && mergeEngine) {
            // After a non-extend move, snap anchor/focus off any shadow cell
            const anchor = selectionState.anchor;
            if (anchor) {
                const snapped = snapToMergePrimary(anchor.row, anchor.col);
                if (snapped.row !== anchor.row || snapped.col !== anchor.col) {
                    selectionState.anchor = { row: snapped.row, col: snapped.col };
                    selectionState.focus  = { row: snapped.row, col: snapped.col };
                }
            }
            // Then expand to cover the full merge the cursor landed on
            normalizeSelectionForMerges();
        } else if (extend && mergeEngine) {
            // Shift+arrow: expand focus to cover any merge it landed inside
            normalizeSelectionForMerges();
        }
    }

    // Expanded range for selection border (covers all touched merges)
    let expandedRange = $derived.by(() => {
        if (selectionState.selectionMode !== "range") return null;
        const range = selectionState.range;
        if (!range) return null;
        return expandRangeForMerges(range, renderContext?.mergeEngine) ?? range;
    });

    // Bottom-right corner (container-local px) where the fill handle dot sits.
    let fillHandlePos = $derived.by(() => {
        if (!virtualizer || !renderPlan || editSessionState.isEditing) return null;
        if (selectionState.selectionMode !== 'range') return null;
        if (selectionState.isSelecting || fillCtrl.fillHandleDrag) return null;
        if (!anchor) return null;
        const eff = expandedRange;
        const endCol = eff ? eff.endCol : anchor.col;
        const endRow = eff ? eff.endRow : anchor.row;
        return {
            right: cellContainerLeft(endCol) + virtualizer.getColWidth(endCol),
            bottom: cellContainerTop(endRow) + virtualizer.getRowHeight(endRow),
        };
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
        const hit = doHitTest(localX, localY);

        switch (hit.region) {
            case "corner":
                handleCornerCellMouseDown();
                break;
            case "colHeader":
                handleColHeaderMouseDown(hit.col, e);
                break;
            case "rowHeader":
                handleRowHeaderMouseDown(hit.row, e);
                break;
            case "colResize":
                resizeCtrl.startColResize(hit.resizeCol, e);
                break;
            case "rowResize":
                resizeCtrl.startRowResize(hit.resizeRow, e);
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
        const hit = doHitTest(localX, localY);
        currentCursor = hitTestEngine.getCursor(hit);

        // Detect grip-handle hover: leftmost TABLE_GRIP_HANDLE_PX of a reorderable TABLE_DATA row.
        if (hit.region === 'cell' && hit.row >= 0 && hit.col >= 0) {
            const cellType = renderContext?.getCellType(hit.row, hit.col);
            if (cellType === CELL_TYPE.TABLE_DATA) {
                const info = renderContext?.tableManager?.getCellInfo(hit.row, hit.col);
                if (info?.table && !info.table.sortColId && hit.col === info.table.startCol) {
                    const xInCell = localX - cellContainerLeft(hit.col);
                    if (xInCell >= 0 && xInCell < TABLE_GRIP_HANDLE_PX) {
                        currentCursor = tableRowDrag ? 'grabbing' : 'grab';
                        if (tableGripHoverRow !== hit.row) {
                            tableGripHoverRow = hit.row;
                            untrack(() => selectionScheduler?.invalidateAll());
                        }
                        return;
                    }
                }
            }
        }
        if (tableGripHoverRow !== -1) {
            tableGripHoverRow = -1;
            untrack(() => selectionScheduler?.invalidateAll());
        }

        // Link hover detection — re-measure on demand (only when cell has tfr with links)
        if (hit.region === 'cell' && hit.row >= 0 && hit.col >= 0 && !editSessionState.isEditing) {
            const cellData = sheetStore?.getCell(hit.row, hit.col);
            if (cellData?.tfr?.some(r => r.format?.link)) {
                const cellW    = virtualizer.getColWidth(hit.col);
                const cellH    = virtualizer.getRowHeight(hit.row);
                const cellLeft = cellContainerLeft(hit.col);
                const cellTop  = cellContainerTop(hit.row);
                const xInCell  = localX - cellLeft;
                const yInCell  = localY - cellTop;
                const style    = sheetStore.getEffectiveCellStyle(hit.row, hit.col);
                const theme    = canvasRenderer?.theme ?? {};
                const runs     = buildRenderRuns(cellData.v ?? '', cellData.tfr);
                const url      = hitTestLink(xInCell, yInCell, runs, cellW, cellH, style, theme);
                if (url) {
                    hoveredLink = { url, cellLeft, cellTop, cellWidth: cellW, cellHeight: cellH };
                    currentCursor = 'pointer';
                } else {
                    hoveredLink = null;
                }
            } else {
                hoveredLink = null;
            }
        } else if (hit.region !== 'cell') {
            hoveredLink = null;
        }

        if (isFormulaEditMode && isSelectingRange && hit.region === "cell") {
            rangeEndCell = snapToMergePrimary(hit.row, hit.col);
            return;
        }
        if (selectionState.isSelecting) {
            dragClientX = e.clientX;
            dragClientY = e.clientY;

            if (
                selectionState.selectionMode === "rows" &&
                (hit.region === "rowHeader" || hit.region === "cell")
            ) {
                selectionState.extendRowSelection(hit.row);
            } else if (
                selectionState.selectionMode === "cols" &&
                (hit.region === "colHeader" || hit.region === "cell")
            ) {
                selectionState.extendColSelection(hit.col);
            } else if (
                selectionState.selectionMode === "range" &&
                hit.region === "cell"
            ) {
                extendSelectionToCell(hit.row, hit.col);
            }

            // Start edge auto-scroll when mouse is near the content-area edges
            if (containerEl) {
                const cRect = containerEl.getBoundingClientRect();
                const EDGE = 50;
                const nearEdge =
                    e.clientX - (cRect.left + HEADER_WIDTH) < EDGE ||
                    cRect.right - e.clientX < EDGE ||
                    e.clientY - (cRect.top + HEADER_HEIGHT) < EDGE ||
                    cRect.bottom - e.clientY < EDGE;
                if (nearEdge) startDragAutoScroll();
                else stopDragAutoScroll();
            }
        } else {
            stopDragAutoScroll();
        }
    }

    function handleEventLayerDblClick(e) {
        const { localX, localY } = getLocalCoords(e);
        const hit = doHitTest(localX, localY);
        if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
            handleCellDoubleClick(hit.row, hit.col);
        }
    }

    function handleEventLayerContextMenu(e) {
        const { localX, localY } = getLocalCoords(e);
        const hit = doHitTest(localX, localY);
        if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
            handleCellContextMenu(hit.row, hit.col, e);
        } else if (hit.region === "rowHeader") {
            // Select the row if not already in the selection
            if (!selectionState.isRowHighlighted(hit.row)) {
                selectionState.selectRow(hit.row);
            }
            e.preventDefault();
            contextMenuPosition = { x: e.clientX, y: e.clientY };
            contextMenuVisible = true;
        } else if (hit.region === "colHeader") {
            if (!selectionState.isColHighlighted(hit.col)) {
                selectionState.selectColumn(hit.col);
            }
            e.preventDefault();
            contextMenuPosition = { x: e.clientX, y: e.clientY };
            contextMenuVisible = true;
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

        // Long-press: enter drag-to-select mode OR show context menu
        const savedClientX = touch.clientX;
        const savedClientY = touch.clientY;
        longPressTimer = setTimeout(() => {
            if (!touchStartPos) return;
            const { localX, localY } = getTouchLocalCoords({
                clientX: savedClientX,
                clientY: savedClientY,
            });
            const hit = doHitTest(localX, localY);
            if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
                const snappedHit = snapToMergePrimary(hit.row, hit.col);
                if (!isSelected(snappedHit.row, snappedHit.col)) {
                    startSelectionOnCell(hit.row, hit.col);
                    selectionState.endSelection();
                }
                // Enter drag-range mode — touch-move now extends selection instead of scrolling
                isLongPressDragging = true;
                if (scrollEl) scrollEl.style.touchAction = "none";
                // Context menu shows on touchend if no drag occurs
                contextMenuPosition = { x: savedClientX, y: savedClientY };
            }
            touchStartPos = null; // cancel tap after long-press
        }, LONG_PRESS_DELAY);
    }

    function handleEventLayerTouchMove(e) {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        // If in long-press-drag mode, extend selection instead of scrolling
        if (isLongPressDragging) {
            const { localX, localY } = getTouchLocalCoords(touch);
            const hit = doHitTest(localX, localY);
            if (hit.region === "cell" && hit.row >= 0 && hit.col >= 0) {
                extendSelectionToCell(hit.row, hit.col);
            }
            return;
        }
        if (!touchStartPos) return;
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

        // End long-press-drag mode
        if (isLongPressDragging) {
            isLongPressDragging = false;
            if (scrollEl) scrollEl.style.touchAction = "";
            selectionState.endSelection();
            // Show context menu only if the finger barely moved (< threshold)
            if (e.changedTouches.length === 1) {
                const touch = e.changedTouches[0];
                const dx = touch.clientX - contextMenuPosition.x;
                const dy = touch.clientY - contextMenuPosition.y;
                if (Math.sqrt(dx * dx + dy * dy) < TOUCH_MOVE_THRESHOLD * 3) {
                    contextMenuVisible = true;
                }
            }
            touchStartPos = null;
            return;
        }

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
        const hit = doHitTest(localX, localY);

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
                handleColHeaderMouseDown(hit.col, syntheticE);
                break;
            case "rowHeader":
                handleRowHeaderMouseDown(hit.row, syntheticE);
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
        if (isLongPressDragging) {
            isLongPressDragging = false;
            if (scrollEl) scrollEl.style.touchAction = "";
            selectionState.endSelection();
        }
        touchStartPos = null;
        touchScrolled = false;
    }

    // ─── Out-of-order helper ──────────────────────────────────────────────────
    // Called after any table data cell edit — shows the reorder notice if the
    // edited column is the insertSortColId and the row is now out of position.
    function checkOrderAfterUpdate(info, gridRow) {
        if (!info?.table || !info.colDef) return;
        if (info.colDef.id !== info.table.insertSortColId) return;
        const ooo = info.table.checkOutOfOrder(info.dataIndex);
        if (ooo) outOfOrderNotice = { table: info.table, displayIndex: info.dataIndex, gridRow, placeInOrder: ooo.placeInOrder };
        else outOfOrderNotice = null;
    }

    /**
     * Single source of truth for mutating a TABLE_DATA cell.
     * Parses the value, writes to the table store, notifies the formula engine,
     * checks insertion-sort order, and schedules a repaint.
     */
    function commitTableDataCell(info, row, col, value) {
        if (!info?.table || !info.colDef || info.colDef.isNonEntry) return;
        const parsed = typeof value === 'string' && value.startsWith('=')
            ? value
            : CellTypeRegistry.parseInput(colParseConfig(info.colDef), value);
        info.table.updateCell(info.dataIndex, info.colDef.id, parsed);
        spreadsheetSession.formulaEngine?.cellValueChanged(row, col);
        spreadsheetSession.formulaEngine?.recalculateDirty();
        checkOrderAfterUpdate(info, row);
        untrack(() => renderScheduler?.invalidateAll());
    }

    /**
     * Single source of truth for mutating a TABLE_ENTRY buffer cell.
     * Parses the value, writes to the entry buffer, and schedules a repaint.
     */
    function commitTableEntryCell(info, value) {
        if (!info?.table || !info.colDef || info.colDef.isNonEntry) return;
        const parsed = CellTypeRegistry.parseInput(colParseConfig(info.colDef), value);
        info.table.setEntryValue(info.colDef.id, parsed);
        untrack(() => renderScheduler?.invalidateAll());
    }

    // ─── Table row drag ───────────────────────────────────────────────────────

    function startTableRowDrag(e, table, displayIndex, gridRow) {
        tableRowDrag = { table, fromDisplayIndex: displayIndex, fromGridRow: gridRow,
                         ghostY: e.clientY, dropGridRow: gridRow, dropDisplayIndex: displayIndex };
        outOfOrderNotice = null;

        function onMove(ev) {
            if (!tableRowDrag || !virtualizer) return;
            const { localY } = getLocalCoords(ev);
            // Find which TABLE_DATA row the cursor is over within the same table
            const hit = doHitTest(cellContainerLeft(tableRowDrag.table.startCol) + 7, localY);
            let dropGridRow = tableRowDrag.dropGridRow;
            let dropDisplayIndex = tableRowDrag.dropDisplayIndex;
            if (hit.region === 'cell' && hit.row >= 0) {
                const hitType = renderContext?.getCellType(hit.row, tableRowDrag.table.startCol);
                if (hitType === CELL_TYPE.TABLE_DATA) {
                    const hitInfo = renderContext?.tableManager?.getCellInfo(hit.row, tableRowDrag.table.startCol);
                    if (hitInfo?.table === tableRowDrag.table) {
                        dropGridRow = hit.row;
                        dropDisplayIndex = hitInfo.dataIndex;
                    }
                }
            }
            tableRowDrag = { ...tableRowDrag, ghostY: ev.clientY, dropGridRow, dropDisplayIndex };
        }

        function onUp() {
            if (tableRowDrag) {
                const { table: t, fromDisplayIndex, dropDisplayIndex } = tableRowDrag;
                if (fromDisplayIndex !== dropDisplayIndex) {
                    t.reorderRow(fromDisplayIndex, dropDisplayIndex);
                    untrack(() => renderScheduler?.invalidateAll());
                }
                tableRowDrag = null;
            }
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    // ─── Header event handlers ────────────────────────────────────────────────
    function handleCornerCellMouseDown() {
        selectionState.selectAll();
    }

    function handleRowHeaderMouseDown(row, e) {
        if (e?.button !== 0) return;
        const isCtrl = e?.ctrlKey || e?.metaKey;
        if (e?.shiftKey && selectionState.selectionMode === "rows") {
            selectionState.extendRowSelection(row);
        } else if (isCtrl && selectionState.selectionMode === "rows") {
            selectionState.addRowSelection(row);
        } else {
            selectionState.startRowDrag(row);
        }
    }

    function handleRowHeaderContextMenu(row, e) {
        if (!selectionState.isRowHighlighted(row)) {
            selectionState.selectRow(row);
        }
        e.preventDefault();
        contextMenuPosition = { x: e.clientX, y: e.clientY };
        contextMenuVisible = true;
    }

    function handleColHeaderMouseDown(col, e) {
        if (e?.button !== 0) return;
        const isCtrl = e?.ctrlKey || e?.metaKey;
        if (e?.shiftKey && selectionState.selectionMode === "cols") {
            selectionState.extendColSelection(col);
        } else if (isCtrl && selectionState.selectionMode === "cols") {
            selectionState.addColSelection(col);
        } else {
            selectionState.startColDrag(col);
        }
    }

    function handleColHeaderContextMenu(col, e) {
        if (!selectionState.isColHighlighted(col)) {
            selectionState.selectColumn(col);
        }
        e.preventDefault();
        contextMenuPosition = { x: e.clientX, y: e.clientY };
        contextMenuVisible = true;
    }

    // ─── Cell mouse events ────────────────────────────────────────────────────
    function handleCellMouseDown(row, col, e) {
        if (e.button !== 0) return;

        // Formula range selection mode
        if (isFormulaEditMode) {
            const snapped = snapToMergePrimary(row, col);
            isSelectingRange = true;
            rangeStartCell = snapped;
            rangeEndCell = snapped;
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

        // Close dropdown overlay if clicking elsewhere
        if (
            kbCtrl.focusedDropdownCell &&
            (kbCtrl.focusedDropdownCell.row !== row || kbCtrl.focusedDropdownCell.col !== col)
        ) {
            kbCtrl.focusedDropdownCell = null;
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

                    const filterZoneWidth = mobileState.isMobile ? 36 : 22;
                    if (relX > cellWidth - filterZoneWidth) {
                        // Filter icon area
                        activeFilterPopover = {
                            table: info.table,
                            colId: colDef.id,
                            anchorRow: row,
                            anchorCol: col,
                        };
                    }
                }
            }
            selectionState.startSelection(row, col);
            selectionState.endSelection();
            return;
        }

        // ── TABLE_ENTRY: single click selects, Enter/typing starts editing ───
        if (cellType === CELL_TYPE.TABLE_ENTRY) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table) {
                // Checkbox in entry row: toggle entryBuffer value on click
                if (info.colDef?.type === "checkbox") {
                    if (isCheckboxClick(row, col, e)) {
                        const cur = info.table.entryBuffer?.[info.colDef.id];
                        commitTableEntryCell(info, !cur);
                    }
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    return;
                }
                // Rating in entry row: click to set value
                if (info.colDef?.type === "rating") {
                    const ct = renderContext?.getCellTypeConfig(row, col);
                    const max = ct?.max || 5;
                    const cellLeft = cellContainerLeft(col);
                    const cellWidth = virtualizer.getColWidth(col);
                    const relX = Math.max(0, e.clientX - containerEl.getBoundingClientRect().left - cellLeft);
                    const newVal = Math.max(1, Math.min(max, Math.ceil(relX / (cellWidth / max))));
                    commitTableEntryCell(info, newVal);
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    return;
                }
                // Formula columns: redirect selection to first editable column
                let targetCol = col;
                if (info.colDef?.isNonEntry) {
                    const firstEditable = info.table.columns.findIndex(
                        (c) => !c.isNonEntry,
                    );
                    if (firstEditable >= 0) {
                        targetCol = info.table.startCol + firstEditable;
                    }
                }
                // Single click = just select. User presses Enter/F2/types to start editing.
                selectionState.startSelection(row, targetCol);
                selectionState.endSelection();
            }
            return;
        }

        // ── TABLE_DATA: special cell type clicks ─────────────────────────────
        if (cellType === CELL_TYPE.TABLE_DATA) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);

            // ── Drag handle: leftmost TABLE_GRIP_HANDLE_PX of the table's first column ─────
            if (info?.table && !info.table.sortColId && col === info.table.startCol) {
                const cellLeft = cellContainerLeft(col);
                const { localX } = getLocalCoords(e);
                if (localX - cellLeft >= 0 && localX - cellLeft < TABLE_GRIP_HANDLE_PX) {
                    e.preventDefault();
                    startTableRowDrag(e, info.table, info.dataIndex, row);
                    return;
                }
            }

            if (info?.table && info.colDef) {
                const colType = info.colDef.type;
                if (colType === "checkbox") {
                    if (isCheckboxClick(row, col, e)) {
                        const cur = info.table.getValue(info.dataIndex, info.colDef.id);
                        commitTableDataCell(info, row, col, !cur);
                    }
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    return;
                }
                if (colType === "rating") {
                    const cellLeft = cellContainerLeft(col);
                    const cellWidth = virtualizer.getColWidth(col);
                    const max = 5;
                    const relX = Math.max(0, e.clientX - containerEl.getBoundingClientRect().left - cellLeft);
                    const newVal = Math.max(1, Math.min(max, Math.ceil(relX / (cellWidth / max))));
                    commitTableDataCell(info, row, col, newVal);
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    return;
                }
            }
        }

        // ── Regular cell ──────────────────────────────────────────────────────
        const isCtrl = e.ctrlKey || e.metaKey;
        if (e.shiftKey && anchor) {
            extendSelectionToCell(row, col);
        } else if (isCtrl) {
            // Ctrl+click: add a new non-contiguous range covering the full merge
            const snapped = snapToMergePrimary(row, col);
            selectionState.startAdditionalSelection(snapped.row, snapped.col);
            normalizeSelectionForMerges();
        } else {
            // Handle special cell type clicks (checkbox toggle, rating)
            if (handleRegularCellClick(row, col, e)) return;
            startSelectionOnCell(row, col);
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
            if (!isCheckboxClick(row, col, e)) return false;
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
        stopDragAutoScroll();
        if (isFormulaEditMode && isSelectingRange && rangeStartCell) {
            const endCell = rangeEndCell || rangeStartCell;

            // Build the bounding rect of the dragged range, then expand it to
            // cover the full extent of any merged cells it touches.
            let rawRange = {
                startRow: Math.min(rangeStartCell.row, endCell.row),
                startCol: Math.min(rangeStartCell.col, endCell.col),
                endRow:   Math.max(rangeStartCell.row, endCell.row),
                endCol:   Math.max(rangeStartCell.col, endCell.col),
            };
            // A single-cell pick references the merge's primary cell directly
            // (rangeStartCell is already snapped to primary), e.g. "A1" — not the
            // expanded "A1:B2" range, which would turn =A1+1 into a range expr.
            // Only multi-cell drags expand to fully cover straddled merges.
            const isSingleCellPick =
                rawRange.startRow === rawRange.endRow &&
                rawRange.startCol === rawRange.endCol;
            const refRange = isSingleCellPick
                ? rawRange
                : (expandRangeForMerges(rawRange, renderContext?.mergeEngine) ?? rawRange);

            let ref = toRangeRef(
                refRange.startRow,
                refRange.startCol,
                refRange.endRow,
                refRange.endCol,
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

    function getTableAwareEditValue(row, col, cellType = null) {
        const resolvedCellType = cellType ?? renderContext?.getCellType(row, col);
        if (resolvedCellType === CELL_TYPE.TABLE_DATA) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                return info.table.getRawValue(info.dataIndex, info.colDef.id) ?? "";
            }
        }
        if (resolvedCellType === CELL_TYPE.TABLE_ENTRY) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                return info.table.entryBuffer?.[info.colDef.id] ?? "";
            }
        }
        if (resolvedCellType === CELL_TYPE.TABLE_HEADER) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            return info?.colDef?.name ?? "";
        }
        return spreadsheetSession.getCellEditValue(row, col);
    }

    function getPreferredEditSurface(row, col, cellType = null) {
        if (!mobileState.isMobile) return "grid";

        // Cells with specialized popups/editors should stay on the grid surface.
        const ct = renderContext?.getCellTypeConfig(row, col);
        const uiEditorTypes = new Set([
            "dropdown",
            "date",
            "time",
            "datetime",
            "image",
            "file",
        ]);
        if (uiEditorTypes.has(ct?.type)) return "grid";

        const rawValue = getTableAwareEditValue(row, col, cellType);
        // Cells with inline formatting (tfr) always open in the grid contenteditable.
        if (sheetStore?.getCell(row, col)?.tfr?.length) return "grid";
        return "formulaBar";
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
        const editSurface = getPreferredEditSurface(row, col, cellType);
        const startCellEdit = () => {
            if (mobileState.isMobile && editSurface === "formulaBar") {
                requestMobileKeyboardFocus?.();
            }
            beginCellEdit(row, col, { surface: editSurface });
        };

        // ── REPEATER non-template: not editable ───────────────────────────────
        if (cellType === CELL_TYPE.REPEATER) {
            const repCtx =
                renderContext?.repeaterEngine?.getCellRepeaterContext(row, col);
            if (repCtx && repCtx.repIndex > 0) return; // block edit
        }

        // ── TABLE_DATA: begin edit on double-click ────────────────────────────
        if (cellType === CELL_TYPE.TABLE_DATA) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                const colType = info.colDef.type;
                if (
                    colType !== "checkbox" &&
                    colType !== "rating" &&
                    !info.colDef.isNonEntry
                ) {
                    selectionState.startSelection(row, col);
                    selectionState.endSelection();
                    startCellEdit();
                }
            }
            return;
        }

        // ── TABLE_HEADER: rename on double-click ─────────────────────────────
        if (cellType === CELL_TYPE.TABLE_HEADER) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                selectionState.startSelection(row, col);
                selectionState.endSelection();
                startCellEdit();
            }
            return;
        }

        startCellEdit();
    }

    function handleCellContextMenu(row, col, e) {
        e.preventDefault();
        // Always work with the merge primary so shadow cells are never the anchor
        const snapped = snapToMergePrimary(row, col);
        row = snapped.row;
        col = snapped.col;
        if (!isSelected(row, col)) {
            startSelectionOnCell(row, col);
            selectionState.endSelection();
        } else {
            // Anchor may have drifted onto a shadow cell via keyboard nav — re-snap it
            const anchor = selectionState.anchor;
            if (anchor) {
                const anchorSnapped = snapToMergePrimary(
                    anchor.row,
                    anchor.col,
                );
                if (
                    anchorSnapped.row !== anchor.row ||
                    anchorSnapped.col !== anchor.col
                ) {
                    selectionState.anchor = {
                        row: anchorSnapped.row,
                        col: anchorSnapped.col,
                    };
                }
            }
        }
        contextMenuPosition = { x: e.clientX, y: e.clientY };
        contextMenuVisible = true;
    }

    function closeContextMenu() {
        contextMenuVisible = false;
    }


    // ─── Dropdown range / table resolver helpers ─────────────────────────────
    function resolveRangeOptions(rangeStr) {
        if (!sheetStore) return [];
        return resolveRangeValues(spreadsheetSession, rangeStr);
    }

    function resolveTableColumnOptions(tableName, columnId) {
        return spreadsheetSession.getTableColumnValues(tableName, columnId);
    }

    // ─── Editing ──────────────────────────────────────────────────────────────
    function beginCellEdit(row, col, options = {}) {
        const { seedText = null, surface = "grid" } = options;

        // Snap any shadow cell of a merge to its primary (top-left) cell so the
        // editor renders over — and the commit writes to — the merged region's
        // primary cell, never a hidden shadow cell. The keyboard typing path and
        // some navigation jumps can land the anchor on a shadow cell; this is the
        // single choke point that guarantees correct merged-cell editing.
        const editMerge = renderContext?.mergeEngine?.getMergeAt(row, col);
        if (editMerge && (editMerge.startRow !== row || editMerge.startCol !== col)) {
            row = editMerge.startRow;
            col = editMerge.startCol;
        }

        // ── Table cell editing ──────────────────────────────────────────────────
        const tblCellType = renderContext?.getCellType(row, col);

        // Block editing in table buffer zone (rows below last data row)
        if (renderContext?.tableManager?.isTableShadowCell(row, col)) return;

        if (
            tblCellType === CELL_TYPE.TABLE_DATA ||
            tblCellType === CELL_TYPE.TABLE_ENTRY ||
            tblCellType === CELL_TYPE.TABLE_HEADER
        ) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (!info?.table) return;

            if (tblCellType === CELL_TYPE.TABLE_HEADER) {
                const colName = info.colDef?.name ?? "";
                editSessionState.beginEdit(
                    row,
                    col,
                    seedText !== null ? seedText : colName,
                    surface,
                    {
                        sheetId: spreadsheetSession.activeSheetId,
                    },
                );
                return;
            }

            if (info.colDef?.isNonEntry) return; // Formula columns not editable

            // Get initial value from the right source (entry buffer or table data).
            // Use getRawValue for data cells so a formula like "=10*15" opens in
            // the editor as the formula string, not the evaluated result.
            let initialValue;
            if (tblCellType === CELL_TYPE.TABLE_ENTRY) {
                initialValue = info.table.entryBuffer?.[info.colDef?.id] ?? "";
            } else {
                initialValue = info.table.getRawValue(info.dataIndex, info.colDef.id) ?? "";
            }

            // Use unified cell type config (column typeConfig → column type → sheet override)
            const ct = renderContext?.getCellTypeConfig(row, col);

            // Checkbox/rating: handled by click events, not a text editor
            if (ct?.type === "checkbox" || ct?.type === "rating") return;

            // Dropdown: show overlay list
            if (ct?.type === "dropdown") {
                let ddOptions = [];
                if (ct.source === "range" && ct.range) {
                    ddOptions = resolveRangeOptions(ct.range);
                } else if (ct.source === "table" && ct.tableName && ct.columnId) {
                    ddOptions = resolveTableColumnOptions(ct.tableName, ct.columnId);
                } else if (Array.isArray(ct.options)) {
                    ddOptions = ct.options;
                }
                if (ddOptions.length > 0) {
                    kbCtrl.dropdownFilter = seedText ?? "";
                    const capturedInfo = info;
                    const capturedCellType = tblCellType;
                    kbCtrl.focusedDropdownCell = {
                        row, col,
                        options: ddOptions,
                        left: cellContainerLeft(col),
                        top: cellContainerTop(row),
                        width: virtualizer.getColWidth(col),
                        height: virtualizer.getRowHeight(row),
                        onCommit: (opt) => {
                            if (capturedCellType === CELL_TYPE.TABLE_ENTRY) {
                                commitTableEntryCell(capturedInfo, opt);
                            } else {
                                commitTableDataCell(capturedInfo, row, col, opt);
                            }
                        },
                    };
                    return;
                }
            }

            // Image picker
            if (ct?.type === "image") {
                editSessionState.beginEdit(row, col, String(initialValue), surface, {
                    pickerMode: "image-picker",
                    sheetId: spreadsheetSession.activeSheetId,
                });
                return;
            }

            // File picker
            if (ct?.type === "file") {
                editSessionState.beginEdit(row, col, String(initialValue), surface, {
                    pickerMode: "file-picker",
                    sheetId: spreadsheetSession.activeSheetId,
                });
                return;
            }

            // Date/time pickers
            const pickerMode =
                ct?.type === "date" ? "date" :
                ct?.type === "time" ? "time" :
                ct?.type === "datetime" ? "datetime-local" : null;

            editSessionState.beginEdit(
                row, col,
                seedText !== null ? seedText : String(initialValue),
                surface,
                { pickerMode, sheetId: spreadsheetSession.activeSheetId },
            );
            return;
        }

        const rawValue = spreadsheetSession.getCellEditValue(row, col);
        const ct = renderContext?.getCellTypeConfig(row, col);

        // Dropdown cell: show overlay list instead of text editor
        if (ct?.type === "dropdown") {
            let ddOptions = [];
            if (ct.source === "range" && ct.range) {
                ddOptions = resolveRangeOptions(ct.range);
            } else if (ct.source === "table" && ct.tableName && ct.columnId) {
                ddOptions = resolveTableColumnOptions(ct.tableName, ct.columnId);
            } else if (Array.isArray(ct.options)) {
                ddOptions = ct.options;
            }
            if (ddOptions.length > 0) {
                kbCtrl.dropdownFilter = seedText ?? "";
                const capturedRow = row, capturedCol = col;
                kbCtrl.focusedDropdownCell = {
                    row,
                    col,
                    options: ddOptions,
                    left: cellContainerLeft(col),
                    top: cellContainerTop(row),
                    width: virtualizer.getColWidth(col),
                    height: virtualizer.getRowHeight(row),
                    onCommit: (opt) => {
                        sheetStore?.setCellValue(capturedRow, capturedCol, opt);
                    },
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
        // File cells: set file picker mode and pass current blob ID as initial value
        if (ct?.type === "file") {
            const currentBlobId =
                spreadsheetSession.getCellEditValue(row, col) ?? "";
            editSessionState.beginEdit(row, col, currentBlobId, surface, {
                pickerMode: "file-picker",
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

        const initialTfr = seedText !== null ? null : (sheetStore?.getCell(row, col)?.tfr ?? null);
        editSessionState.beginEdit(
            row,
            col,
            seedText !== null ? seedText : (rawValue ?? ""),
            surface,
            { pickerMode, sheetId: spreadsheetSession.activeSheetId, initialTfr },
        );
    }

    /**
     * Persist an edit to a specific sheet (may differ from active sheet during cross-sheet formula editing).
     * Falls back to the active sheet when sheetId is null/undefined.
     */
    /**
     * Navigate within a table entry row after a commit.
     * @param {number} entryRow  Grid row of the entry row
     * @param {number} currentCol  Grid column that was just committed
     * @param {number} dRow  0 or 1 (1 = Enter, moving down)
     * @param {number} dCol  0 or ±1 (Tab navigation)
     * @param {any} table
     */
    function navigateEntryRow(entryRow, currentCol, dRow, dCol, table) {
        const cols = table.columns;
        const curColIndex = table.colIndexForSheetCol
            ? table.colIndexForSheetCol(currentCol)
            : cols.findIndex((_, i) => table.startCol + i === currentCol);

        if (dRow === 1 && dCol === 0) {
            // Enter: commit entry row and refocus first editable column
            table.commitEntry();
            const firstEditable = cols.findIndex((c) => !c.isNonEntry);
            if (firstEditable >= 0) {
                const firstCol = table.startCol + firstEditable;
                selectionState.startSelection(entryRow, firstCol);
                selectionState.endSelection();
                beginCellEdit(entryRow, firstCol, { surface: "grid" });
            }
        } else if (dCol !== 0) {
            if (dCol > 0) {
                // Tab forward: wrap to next editable; commit entry on wrap
                let nextIdx = null;
                let wrapped = false;
                for (let i = 1; i <= cols.length; i++) {
                    const idx = (curColIndex + i) % cols.length;
                    if (idx < curColIndex || (idx === 0 && curColIndex > 0))
                        wrapped = true;
                    if (!cols[idx]?.isNonEntry) {
                        nextIdx = idx;
                        break;
                    }
                }
                if (wrapped && nextIdx != null) table.commitEntry();
                if (nextIdx != null) {
                    const nextCol = table.startCol + nextIdx;
                    selectionState.startSelection(entryRow, nextCol);
                    selectionState.endSelection();
                    beginCellEdit(entryRow, nextCol, { surface: "grid" });
                }
            } else {
                // Shift+Tab: go to prev editable column
                let prevIdx = null;
                for (let i = 1; i <= cols.length; i++) {
                    const idx = (curColIndex - i + cols.length) % cols.length;
                    if (!cols[idx]?.isNonEntry) {
                        prevIdx = idx;
                        break;
                    }
                }
                if (prevIdx != null) {
                    const prevCol = table.startCol + prevIdx;
                    selectionState.startSelection(entryRow, prevCol);
                    selectionState.endSelection();
                    beginCellEdit(entryRow, prevCol, { surface: "grid" });
                }
            }
        }
    }

    function commitCurrentEdit() {
        const editingSheetId = editSessionState.editingSheetId;
        const payload = editSessionState.commit();
        if (!payload) return;
        const result = commitCellEdit(editingSheetId, payload.row, payload.col, payload.value, payload.tfr);
        if (result?.tableInfo) checkOrderAfterUpdate(result.tableInfo, result.row);
        if (editingSheetId && editingSheetId !== spreadsheetSession.activeSheetId)
            spreadsheetSession.setActiveSheet(editingSheetId);
    }

    function commitEditAndMove(dRow, dCol) {
        const editRow = editSessionState.cell?.row;
        const editCol = editSessionState.cell?.col;
        const editingSheetId = editSessionState.editingSheetId;
        const editCellType = editRow != null ? renderContext?.getCellType(editRow, editCol) : null;
        const payload = editSessionState.commit();
        if (!payload) return;

        const commitResult = commitCellEdit(editingSheetId, payload.row, payload.col, payload.value, payload.tfr);
        if (commitResult?.tableInfo) checkOrderAfterUpdate(commitResult.tableInfo, commitResult.row);

        if (editCellType === CELL_TYPE.TABLE_ENTRY) {
            const info = renderContext?.tableManager?.getCellInfo(payload.row, payload.col);
            if (info?.table) navigateEntryRow(payload.row, payload.col, dRow, dCol, info.table);
        } else if (editCellType === CELL_TYPE.TABLE_DATA || editCellType === CELL_TYPE.TABLE_HEADER) {
            selectionState.moveSelection(dRow, dCol);
            scrollToAnchor();
        } else if (editingSheetId && editingSheetId !== spreadsheetSession.activeSheetId) {
            spreadsheetSession.setActiveSheet(editingSheetId);
        } else {
            selectionState.moveSelection(dRow, dCol);
            scrollToAnchor();
        }
    }

    function commitEdit(value = undefined) {
        if (value !== undefined && editSessionState.isEditing) {
            // Pickers and contenteditable pass an explicit value.
            // Value may be a plain string or { value, tfr } from the rich text editor.
            const editRow = editSessionState.cell.row;
            const editCol = editSessionState.cell.col;
            const editingSheetId = editSessionState.editingSheetId;
            const editCellType = renderContext?.getCellType(editRow, editCol);
            const entryInfo = editCellType === CELL_TYPE.TABLE_ENTRY
                ? renderContext?.tableManager?.getCellInfo(editRow, editCol)
                : null;
            editSessionState.cancel();
            // Unpack { value, tfr } if needed
            const plainValue = (value !== null && typeof value === 'object' && 'value' in value)
                ? value.value : value;
            const tfr = (value !== null && typeof value === 'object' && 'tfr' in value)
                ? value.tfr : null;
            const editResult = commitCellEdit(editingSheetId, editRow, editCol, plainValue, tfr);
            if (editResult?.tableInfo) checkOrderAfterUpdate(editResult.tableInfo, editResult.row);
            lastTableEntryEditInfo = entryInfo?.table
                ? { row: editRow, col: editCol, table: entryInfo.table }
                : null;
            if (editingSheetId && editingSheetId !== spreadsheetSession.activeSheetId)
                spreadsheetSession.setActiveSheet(editingSheetId);
        } else {
            commitCurrentEdit();
        }
    }
    function cancelEdit() {
        const editRow = editSessionState.cell?.row;
        const editCol = editSessionState.cell?.col;
        const editingSheetId = editSessionState.editingSheetId;
        const editCellType =
            editRow != null
                ? renderContext?.getCellType(editRow, editCol)
                : null;
        editSessionState.cancel();
        // For TABLE_ENTRY: clear the entry buffer on Escape
        if (editCellType === CELL_TYPE.TABLE_ENTRY) {
            const info = renderContext?.tableManager?.getCellInfo(
                editRow,
                editCol,
            );
            info?.table?.clearEntry();
        }
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
                if (!virtualizer) {
                    scrollPending = false;
                    return;
                }

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
                const canIncremental =
                    (dy !== 0 || dx !== 0) &&
                    Math.abs(dy) < bodyH &&
                    Math.abs(dx) < bodyW;

                if (canIncremental) {
                    paintCoord.performScrollPaint(dx, dy, prevST, prevSL);
                } else {
                    paintCoord.performPaint(new Set(["body", "top", "left", "corner"]));
                }

                if (selectionRenderer && renderPlan) {
                    paintCoord.performSelectionPaint();
                }
            });
        }
    }

    // ─── Drag auto-scroll ─────────────────────────────────────────────────────

    function stopDragAutoScroll() {
        if (dragAutoScrollRAF !== null) {
            cancelAnimationFrame(dragAutoScrollRAF);
            dragAutoScrollRAF = null;
        }
    }

    function dragAutoScrollTick() {
        dragAutoScrollRAF = null;
        if (!selectionState.isSelecting || !scrollEl || !virtualizer || !containerEl) return;

        const cRect = containerEl.getBoundingClientRect();
        const mode  = selectionState.selectionMode;
        const EDGE  = 50;
        const MAX_SPEED = 16;

        // Scroll axes depend on selection mode:
        // rows → vertical only, cols → horizontal only, range → both.
        // Use content-area origin (past headers) so header-drag mice don't
        // erroneously trigger the wrong axis.
        let dx = 0, dy = 0;

        if (mode !== 'rows') {
            const contentLeft = cRect.left + HEADER_WIDTH;
            const distLeft  = dragClientX - contentLeft;
            const distRight = cRect.right - dragClientX;
            if (distLeft < EDGE)        dx = -MAX_SPEED * Math.max(0, 1 - distLeft / EDGE);
            else if (distRight < EDGE)  dx =  MAX_SPEED * Math.max(0, 1 - distRight / EDGE);
        }

        if (mode !== 'cols') {
            const contentTop = cRect.top + HEADER_HEIGHT;
            const distTop    = dragClientY - contentTop;
            const distBottom = cRect.bottom - dragClientY;
            if (distTop < EDGE)         dy = -MAX_SPEED * Math.max(0, 1 - distTop / EDGE);
            else if (distBottom < EDGE) dy =  MAX_SPEED * Math.max(0, 1 - distBottom / EDGE);
        }

        if (dx === 0 && dy === 0) return; // mouse moved away from edge — stop loop

        const newScrollLeft = Math.max(0, scrollEl.scrollLeft + dx);
        const newScrollTop  = Math.max(0, scrollEl.scrollTop  + dy);
        scrollEl.scrollLeft = newScrollLeft;
        scrollEl.scrollTop  = newScrollTop;

        // Compute target row/col from new scroll without touching virtualizer state
        // (mirrors HitTestEngine logic so the render pipeline stays clean).
        const contentX = Math.max(0, dragClientX - cRect.left - HEADER_WIDTH);
        const contentY = Math.max(0, dragClientY - cRect.top  - HEADER_HEIGHT);
        const frozenW  = virtualizer.frozenWidth;
        const frozenH  = virtualizer.frozenHeight;

        let targetCol;
        if (frozenW > 0 && contentX < frozenW) {
            targetCol = virtualizer.colMetrics.indexAtOffset(contentX);
        } else {
            const colOff = contentX + newScrollLeft;
            targetCol = virtualizer.colMetrics.indexAtOffset(Math.max(0, colOff));
            if (targetCol < virtualizer.frozenCols) targetCol = virtualizer.frozenCols;
            targetCol = Math.min(targetCol, virtualizer.colCount - 1);
        }

        let targetRow;
        if (frozenH > 0 && contentY < frozenH) {
            targetRow = virtualizer.rowMetrics.indexAtOffset(contentY);
        } else {
            const rowOff = contentY + newScrollTop;
            targetRow = virtualizer.rowMetrics.indexAtOffset(Math.max(0, rowOff));
            if (targetRow < virtualizer.frozenRows) targetRow = virtualizer.frozenRows;
            targetRow = Math.min(targetRow, virtualizer.rowCount - 1);
        }

        if (mode === 'rows') {
            selectionState.extendRowSelection(targetRow);
        } else if (mode === 'cols') {
            selectionState.extendColSelection(targetCol);
        } else if (targetRow >= 0 && targetCol >= 0) {
            extendSelectionToCell(targetRow, targetCol);
        }

        dragAutoScrollRAF = requestAnimationFrame(dragAutoScrollTick);
    }

    // Document-level mousemove for row/col header drag-select.
    // The event-layer doesn't cover the header area, so implicit pointer capture
    // keeps mousemove on the header element — this handler bridges the gap.
    function handleHeaderDragMouseMove(e) {
        if (!selectionState.isSelecting) return;
        const mode = selectionState.selectionMode;
        if (mode !== 'rows' && mode !== 'cols') return;

        dragClientX = e.clientX;
        dragClientY = e.clientY;

        const { localX, localY } = getLocalCoords(e);
        const hit = doHitTest(localX, localY);

        if (mode === 'rows' && (hit.region === 'rowHeader' || hit.region === 'cell')) {
            selectionState.extendRowSelection(hit.row);
        } else if (mode === 'cols' && (hit.region === 'colHeader' || hit.region === 'cell')) {
            selectionState.extendColSelection(hit.col);
        }

        // Trigger auto-scroll based on content-area edges
        if (containerEl) {
            const cRect = containerEl.getBoundingClientRect();
            const EDGE = 50;
            let nearEdge = false;
            if (mode === 'rows') {
                nearEdge =
                    dragClientY - (cRect.top + HEADER_HEIGHT) < EDGE ||
                    cRect.bottom - dragClientY < EDGE;
            } else {
                nearEdge =
                    dragClientX - (cRect.left + HEADER_WIDTH) < EDGE ||
                    cRect.right - dragClientX < EDGE;
            }
            if (nearEdge) startDragAutoScroll();
            else stopDragAutoScroll();
        }
    }

    function startDragAutoScroll() {
        if (dragAutoScrollRAF !== null) return;
        dragAutoScrollRAF = requestAnimationFrame(dragAutoScrollTick);
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

    function scrollToPrimaryCell() {
        const pc = selectionState.primaryCell ?? selectionState.anchor;
        if (!scrollEl || !pc || !virtualizer) return;
        const { scrollTop, scrollLeft } = virtualizer.scrollToCell(pc.row, pc.col);
        if (scrollEl.scrollTop !== scrollTop) scrollEl.scrollTop = scrollTop;
        if (scrollEl.scrollLeft !== scrollLeft) scrollEl.scrollLeft = scrollLeft;
    }

    function scrollToFocus() {
        if (!scrollEl || !virtualizer) return;
        const focus = selectionState.focus;
        if (!focus) return;
        const { scrollTop, scrollLeft } = virtualizer.scrollToCell(
            focus.row,
            focus.col,
        );
        if (scrollEl.scrollTop !== scrollTop) scrollEl.scrollTop = scrollTop;
        if (scrollEl.scrollLeft !== scrollLeft)
            scrollEl.scrollLeft = scrollLeft;
    }

    // Keep the active editor cell in view when the soft keyboard opens on mobile.
    $effect(() => {
        const _editing = editSessionState.isEditing;
        const _surface = editSessionState.surface;
        const _picker = editSessionState.pickerMode;
        const cell = editSessionState.cell;
        const _kbOpen = mobileState.isKeyboardOpen;
        if (
            !mobileState.isMobile ||
            !_editing ||
            _surface !== "grid" ||
            !!_picker ||
            !_kbOpen ||
            !cell ||
            !scrollEl ||
            !virtualizer
        ) {
            return;
        }
        const { scrollTop, scrollLeft } = virtualizer.scrollToCell(
            cell.row,
            cell.col,
        );
        if (scrollEl.scrollTop !== scrollTop) scrollEl.scrollTop = scrollTop;
        if (scrollEl.scrollLeft !== scrollLeft) scrollEl.scrollLeft = scrollLeft;
    });

    /**
     * Jump to the edge of a data region in the given direction (Ctrl+Arrow).
     * Mirrors Excel/Google Sheets behavior:
     *   - Current cell non-empty AND next cell non-empty → scan to end of block
     *   - Otherwise → skip empties and land on first non-empty, or sheet edge
     */
    function jumpToEdge(startRow, startCol, dRow, dCol) {
        if (!sheetStore) return { row: startRow, col: startCol };
        const maxRow = rowCount - 1;
        const maxCol = colCount - 1;
        const inBounds = (r, c) => r >= 0 && r <= maxRow && c >= 0 && c <= maxCol;
        const hasValue = (r, c) => {
            if (!inBounds(r, c)) return false;
            const cell = sheetStore.getCell(r, c);
            return cell.exists && cell.v != null && cell.v !== '';
        };

        let r = startRow;
        let c = startCol;
        const nr = r + dRow;
        const nc = c + dCol;
        if (!inBounds(nr, nc)) return { row: r, col: c }; // already at edge

        if (hasValue(r, c) && hasValue(nr, nc)) {
            // Scan forward to end of contiguous data block
            r = nr; c = nc;
            while (inBounds(r + dRow, c + dCol) && hasValue(r + dRow, c + dCol)) {
                r += dRow;
                c += dCol;
            }
        } else {
            // Skip empties until we hit data or the sheet edge
            r = nr; c = nc;
            while (inBounds(r, c) && !hasValue(r, c)) {
                r += dRow;
                c += dCol;
            }
            // Clamp if we walked past the boundary
            r = Math.max(0, Math.min(maxRow, r));
            c = Math.max(0, Math.min(maxCol, c));
        }
        return { row: r, col: c };
    }

    /**
     * Ctrl+Arrow helper: jump to edge from the appropriate anchor/focus cell.
     * When extend=false moves both anchor and focus; when extend=true keeps
     * anchor and moves only focus (shift-extend behavior).
     */
    function jumpToEdgeAndSelect(dRow, dCol, extend) {
        const from = extend
            ? (selectionState.focus || selectionState.anchor)
            : selectionState.anchor;
        if (!from) return;
        const dest = jumpToEdge(from.row, from.col, dRow, dCol);
        const snapped = snapToMergePrimary(dest.row, dest.col);
        if (extend) {
            selectionState.focus = snapped;
            normalizeSelectionForMerges();
        } else {
            selectionState.selectionMode = 'range';
            selectionState.anchor = snapped;
            selectionState.focus = snapped;
            normalizeSelectionForMerges();
        }
    }

    /**
     * Handle native copy event — fires after keydown (Ctrl+C) when we do NOT
     * call preventDefault on the keydown. Delegates to ClipboardManager which
     * writes all MIME formats synchronously via e.clipboardData.setData().
     * This path is permission-free and works in all browsers.
     */
    function handleCopy(e) {
        // Guard: ignore if a text input / cell editor has focus — let it copy normally.
        const target = e.target;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        ) return;

        clipboardManager.handleNativeCopyEvent(e);
    }

    /**
     * Handle native cut event — same as copy but for Ctrl+X.
     */
    function handleCut(e) {
        const target = e.target;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        ) return;

        clipboardManager.handleNativeCopyEvent(e);
    }

    /**
     * Handle native paste event — gives access to all MIME types including
     * Google Sheets' compact JSON via e.clipboardData.
     */
    function handlePaste(e) {
        const mode = clipboardManager._pendingPasteMode;
        if (!mode) return; // Not our paste (e.g. paste into an input field)

        e.preventDefault();
        clipboardManager._pendingPasteMode = null;

        if (sheetStore && spreadsheetSession.ydoc) {
            clipboardManager.pasteFromEvent(
                e.clipboardData,
                sheetStore,
                spreadsheetSession,
                spreadsheetSession.ydoc,
                mode,
            );
        }
    }

    /**
     * Clear cell values in the current selection.
     * Uses effectiveRange (works for all selectionModes).
     * Skips TABLE_DATA/TABLE_HEADER/TABLE_ENTRY/VIEWPORT_OCCUPIED cells
     * since those manage their own data.
     * Iterates only existing cells to avoid scanning millions of empty ones.
     */

    // ─── Repeater context (for range-outline active class in template) ──────────
    let repeaterContext = $derived.by(() => {
        if (!anchor || !spreadsheetSession.repeaterEngine) return null;
        return spreadsheetSession.repeaterEngine.getCellRepeaterContext(
            anchor.row,
            anchor.col,
        );
    });

    // ─── Spacer ───────────────────────────────────────────────────────────────
    // The event-layer starts at (HEADER_WIDTH, HEADER_HEIGHT), so the spacer
    // only needs to cover totalWidth × totalHeight — no header offset needed.
    // This makes native scrollLeft/scrollTop map 1:1 to virtualizer values.
    function spacerStyle() {
        if (!renderPlan) return "";
        return `width:${renderPlan.totalWidth}px; height:${renderPlan.totalHeight}px;`;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────
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

    /** Handler — file metadata change from FileEditor (mimeType, filename, size, fit) */
    function handleFileMetaChange(e) {
        const meta = e.detail ?? {};
        if (!sheetStore) return;
        const cell = editSessionState.cell;
        if (!cell) return;
        const ct = sheetStore.getCellTypeConfig(cell.row, cell.col);
        if (ct?.type === "file") {
            sheetStore.setCellTypeConfig(cell.row, cell.col, {
                ...ct,
                ...meta,
            });
        }
    }

    let _stopStorageFilesWatch = null;

    // Re-register on each DPR change so we catch subsequent changes (e.g. moving
    // from a 1× monitor to a 2× monitor and then back to a 1.5× monitor).
    function refreshOnDprChange() {
        dprMql?.removeEventListener('change', refreshOnDprChange);
        dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        dprMql.addEventListener('change', refreshOnDprChange);
        if (!canvasRenderer || !virtualizer) return;
        const w = Math.max(0, virtualizer.containerWidth - HEADER_WIDTH);
        const h = Math.max(0, virtualizer.containerHeight - HEADER_HEIGHT);
        if (w <= 0 || h <= 0) return;
        canvasRenderer.resize(w, h);
        renderScheduler?.invalidateAll();
        renderScheduler?.flush();
        selectionRenderer?.resize(w, h);
        selectionScheduler?.invalidateAll();
        selectionScheduler?.flush();
    }

    onMount(() => {
        // Trigger a canvas repaint when any image finishes loading
        setOnLoadCallback(() => {
            renderScheduler?.invalidateAll();
        });

        // Repaint when file descriptors arrive via sync — file cells in tables
        // look up mimeType from the registry synchronously at paint time, so we
        // need a repaint once newly synced descriptors are available.
        _stopStorageFilesWatch = storage.app.files.subscribe(() => {
            renderScheduler?.invalidateAll();
        });

        window.addEventListener("image-fit-change", handleImageFitChange);
        window.addEventListener("file-meta-change", handleFileMetaChange);
        window.addEventListener("show-file-viewer", handleShowFileViewer);

        document.addEventListener("insertFloatingImage", handleInsertFloatingImageEvent);
        document.addEventListener("mouseup", handleMouseUp);
        document.addEventListener("mousemove", handleHeaderDragMouseMove);

        refreshOnDprChange(); // set up initial DPR change listener

        if (containerEl) {
            // Apply the new size SYNCHRONOUSLY. This used to defer into a RAF
            // behind a `resizeTicking` latch, which is unsafe: if that RAF is
            // never served (a starved cold launch, a backgrounded tab), the latch
            // stays true and every later resize is dropped for good.
            //
            // setContainerSize only writes two $state values and self-dedups on
            // unchanged input, so there is nothing here worth batching, and the
            // browser already coalesces ResizeObserver delivery.
            resizeObserver = new ResizeObserver((entries) => {
                const last = entries[entries.length - 1];
                const { width, height } = last.contentRect;
                if (width <= 0 || height <= 0) return;
                latestResizeW = width;
                latestResizeH = height;
                if (virtualizer) virtualizer.setContainerSize(width, height);
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
                mobileState.refreshKeyboardMetrics();
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

        // Deferred re-measure: on mobile the grid can mount before the
        // viewport/flex layout has settled, so the initial getBoundingClientRect()
        // and the ResizeObserver's first callback can report height 0. Force a
        // fresh measure across the next few frames so the first valid size reaches
        // the virtualizer without user interaction.
        let remeasureFrame = 0;
        const remeasure = () => {
            if (!containerEl || !virtualizer) return;
            const r = containerEl.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                virtualizer.setContainerSize(r.width, r.height);
                renderScheduler?.invalidateAll();
                renderScheduler?.flush();
                selectionScheduler?.invalidateAll();
                selectionScheduler?.flush();
            }
            // Keep retrying for a short window in case layout is still settling.
            if (remeasureFrame++ < 6)
                remeasureRAF = requestAnimationFrame(remeasure);
        };
        remeasureRAF = requestAnimationFrame(remeasure);

        // Re-arm the burst once the page is actually foregrounded, so a launch
        // that settled while backgrounded still ends up correctly sized.
        onPageVisibleHandler = () => {
            if (document.visibilityState !== "visible") return;
            if (remeasureRAF !== null) cancelAnimationFrame(remeasureRAF);
            remeasureFrame = 0;
            remeasureRAF = requestAnimationFrame(remeasure);
        };
        document.addEventListener("visibilitychange", onPageVisibleHandler);
        window.addEventListener("pageshow", onPageVisibleHandler);
    });

    // Re-measure viewport-dependent layout when soft-keyboard metrics change.
    $effect(() => {
        const _kb = mobileState.keyboardHeight;
        const _isOpen = mobileState.isKeyboardOpen;
        if (!mobileState.isMobile || !containerEl || !virtualizer) return;
        const rect = containerEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            untrack(() => {
                virtualizer.setContainerSize(rect.width, rect.height);
            });
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
        stopDragAutoScroll();
        document.removeEventListener("insertFloatingImage", handleInsertFloatingImageEvent);
        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("mousemove", handleHeaderDragMouseMove);
        if (resizeObserver) resizeObserver.disconnect();
        if (remeasureRAF !== null) cancelAnimationFrame(remeasureRAF);
        if (onPageVisibleHandler) {
            document.removeEventListener("visibilitychange", onPageVisibleHandler);
            window.removeEventListener("pageshow", onPageVisibleHandler);
        }
        vvCleanup?.();
        virtualizer?.destroy();
        paintCoord.destroy();
        setOnLoadCallback(null);
        _stopStorageFilesWatch?.();
        window.removeEventListener("image-fit-change", handleImageFitChange);
        window.removeEventListener("file-meta-change", handleFileMetaChange);
        window.removeEventListener("show-file-viewer", handleShowFileViewer);
        dprMql?.removeEventListener('change', refreshOnDprChange);
    });
</script>

<svelte:window onkeydown={kbCtrl.handleKeydown} oncopy={handleCopy} oncut={handleCut} onpaste={handlePaste} />

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
        ></canvas>

        <!-- ── 1b. Selection canvas (selection fills + formula highlights) ── -->
        <!-- Separate from data canvas so selection changes (arrow keys, mouse) -->
        <!-- only repaint this lightweight layer, not the full cell data. -->
        <canvas
            bind:this={selectCanvasEl}
            class="select-canvas"
            width="0"
            height="0"
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
                    onColHeaderContextMenu={handleColHeaderContextMenu}
                    onStartColResize={resizeCtrl.startColResize}
                    onStartColResizeTouch={resizeCtrl.startColResizeTouch}
                    onStartFreezeColDrag={resizeCtrl.startFreezeColDrag}
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
                    onRowHeaderContextMenu={handleRowHeaderContextMenu}
                    onStartRowResize={resizeCtrl.startRowResize}
                    onStartRowResizeTouch={resizeCtrl.startRowResizeTouch}
                    onStartFreezeRowDrag={resizeCtrl.startFreezeRowDrag}
                />
            </div>

            <!-- Selection border(s) (multi-cell) — fill is on canvas -->
            {#each selectionBorderStyles as style}
                <div class="selection-border" {style}></div>
            {/each}

            <!-- Anchor border -->
            {#if anchorBorderStyle}
                <div class="anchor-border" style={anchorBorderStyle}></div>
            {/if}

            <!-- Fill handle dot (bottom-right of selection) -->
            {#if fillHandlePos && !mobileState.isMobile}
                <div
                    class="fill-handle"
                    role="presentation"
                    style="transform: translate({fillHandlePos.right - 4}px, {fillHandlePos.bottom - 4}px);"
                    onmousedown={fillCtrl.handleFillHandleMouseDown}
                ></div>
            {/if}

            <!-- Fill preview border (shown while dragging fill handle) -->
            {#if fillCtrl.fillHandleDrag?.fillRange && virtualizer}
                {@const fr = fillCtrl.fillHandleDrag.fillRange}
                {@const fLeft = cellContainerLeft(fr.startCol)}
                {@const fTop = cellContainerTop(fr.startRow)}
                {@const fRight = cellContainerLeft(fr.endCol) + virtualizer.getColWidth(fr.endCol)}
                {@const fBottom = cellContainerTop(fr.endRow) + virtualizer.getRowHeight(fr.endRow)}
                <div
                    class="fill-preview-border"
                    style="transform: translate({fLeft}px, {fTop}px); width:{Math.max(0, fRight - fLeft)}px; height:{Math.max(0, fBottom - fTop)}px;"
                ></div>
            {/if}

            <!-- Table row drag: ghost bar + drop line -->
            {#if tableRowDrag && tableRowDragGeom && virtualizer && containerEl}
                {@const geom = tableRowDragGeom}
                {@const rowH = virtualizer.getRowHeight(tableRowDrag.fromGridRow)}
                {@const ghostTop = tableRowDrag.ghostY - containerEl.getBoundingClientRect().top - rowH / 2}
                {@const dropTop = cellContainerTop(tableRowDrag.dropGridRow) + (tableRowDrag.dropDisplayIndex >= tableRowDrag.fromDisplayIndex ? virtualizer.getRowHeight(tableRowDrag.dropGridRow) : 0)}
                <!-- Ghost row -->
                <div class="trow-drag-ghost" style="left:{geom.left}px; top:{ghostTop}px; width:{geom.width}px; height:{rowH}px;"></div>
                <!-- Drop indicator line -->
                <div class="trow-drag-drop-line" style="left:{geom.left}px; top:{dropTop}px; width:{geom.width}px;"></div>
            {/if}

            <!-- Out-of-order notice -->
            {#if outOfOrderNotice && virtualizer}
                {@const noticeTop = cellContainerTop(outOfOrderNotice.gridRow) + virtualizer.getRowHeight(outOfOrderNotice.gridRow) + 2}
                {@const noticeLeft = outOfOrderNotice.table ? cellContainerLeft(outOfOrderNotice.table.startCol) : HEADER_WIDTH}
                <div class="ooo-notice" style="left:{noticeLeft}px; top:{noticeTop}px;">
                    Row out of order —
                    <button class="ooo-btn" onclick={() => { outOfOrderNotice?.placeInOrder(); outOfOrderNotice = null; untrack(() => renderScheduler?.invalidateAll()); }}>Place in order</button>
                    <button class="ooo-dismiss" onclick={() => outOfOrderNotice = null}>Keep here</button>
                </div>
            {/if}

            <!-- Mobile selection handles -->
            {#if mobileState.isMobile && !editSessionState.isEditing}
                <SelectionHandles
                    rect={selectionHandleRect}
                />
            {/if}

            <!-- Frozen-row divider line -->
            {#if virtualizer?.frozenRows > 0}
                <div
                    class="frozen-divider frozen-divider--row"
                    style="top:{HEADER_HEIGHT + renderPlan.frozenHeight}px; left:{HEADER_WIDTH}px;"
                ></div>
            {/if}

            <!-- Frozen-col divider line -->
            {#if virtualizer?.frozenCols > 0}
                <div
                    class="frozen-divider frozen-divider--col"
                    style="left:{HEADER_WIDTH + renderPlan.frozenWidth}px; top:{HEADER_HEIGHT}px;"
                ></div>
            {/if}

            <!-- Remote user cursors -->
            {#each remoteSelections as rs}
                {#if rs.mode === "cell" && rs.row != null && rs.col != null}
                    {@const left = cellContainerLeft(rs.col)}
                    {@const top = cellContainerTop(rs.row)}
                    {@const width =
                        virtualizer?.getColWidth(rs.col) ?? COL_WIDTH}
                    {@const height =
                        virtualizer?.getRowHeight(rs.row) ?? ROW_HEIGHT}
                    <div
                        class="remote-cursor"
                        style="left:{left}px; top:{top}px; width:{width}px; height:{height}px; --cursor-color: {rs.color ||
                            '#22c55e'};"
                        title={rs.user || "Remote user"}
                    >
                        <span class="remote-cursor-label"
                            >{rs.user || "Remote user"}</span
                        >
                    </div>
                {:else if rs.mode === "range" && rs.startRow != null}
                    {@const left = cellContainerLeft(rs.startCol)}
                    {@const top = cellContainerTop(rs.startRow)}
                    {@const right =
                        cellContainerLeft(rs.endCol) +
                        (virtualizer?.getColWidth(rs.endCol) ?? COL_WIDTH)}
                    {@const bottom =
                        cellContainerTop(rs.endRow) +
                        (virtualizer?.getRowHeight(rs.endRow) ?? ROW_HEIGHT)}
                    <div
                        class="remote-selection"
                        style="left:{left}px; top:{top}px; width:{Math.max(
                            0,
                            right - left,
                        )}px; height:{Math.max(
                            0,
                            bottom - top,
                        )}px; --cursor-color: {rs.color || '#22c55e'};"
                        title={rs.user || "Remote user"}
                    >
                        <span class="remote-cursor-label"
                            >{rs.user || "Remote user"}</span
                        >
                    </div>
                {/if}
            {/each}

            <!-- Always-visible repeater outlines (all repeaters, subtle) -->
            {#each allRepeaterOutlines as { repeater: rep, rect }}
                <div
                    class="range-outline range-outline--repeater"
                    class:range-outline--active={repeaterContext?.repeater ===
                        rep}
                    style="transform:translate({rect.left}px,{rect.top}px); width:{rect.width}px; height:{rect.height}px;"
                ></div>
                <!-- Settings button anchored to top-right of repeater range -->
                {@const btnLeft = rect.left + rect.width}
                {@const btnTop = rect.top}
                <button
                    class="feature-settings-btn feature-settings-btn--repeater"
                    style="left:{btnLeft}px; top:{btnTop}px;"
                    onclick={(e) => {
                        e.stopPropagation();
                        onShowRepeatersPanel?.(rep.id);
                    }}
                    title="Repeater settings: {rep.name}"
                    aria-label="Repeater settings">↻</button
                >
            {/each}

            <!-- Dropdown cell overlay -->
            {#if kbCtrl.focusedDropdownCell}
                {@const filteredOpts = kbCtrl.dropdownFilter
                    ? kbCtrl.focusedDropdownCell.options.filter((o) =>
                          String(o)
                              .toLowerCase()
                              .includes(kbCtrl.dropdownFilter.toLowerCase()),
                      )
                    : kbCtrl.focusedDropdownCell.options}
                <div
                    class="dropdown-cell-overlay"
                    style={dropdownOverlayStyle}
                >
                    <input
                        class="dropdown-filter-input"
                        type="text"
                        placeholder="Search..."
                        bind:value={kbCtrl.dropdownFilter}
                        bind:this={kbCtrl.dropdownFilterInputEl}
                        autofocus
                        onkeydown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                if (filteredOpts.length > 0) {
                                    if (kbCtrl.focusedDropdownCell.onCommit) {
                                        kbCtrl.focusedDropdownCell.onCommit(filteredOpts[0]);
                                    } else {
                                        sheetStore?.setCellValue(kbCtrl.focusedDropdownCell.row, kbCtrl.focusedDropdownCell.col, filteredOpts[0]);
                                    }
                                    kbCtrl.focusedDropdownCell = null;
                                }
                            } else if (e.key === "Tab") {
                                e.preventDefault();
                                if (filteredOpts.length > 0) {
                                    if (kbCtrl.focusedDropdownCell.onCommit) {
                                        kbCtrl.focusedDropdownCell.onCommit(filteredOpts[0]);
                                    } else {
                                        sheetStore?.setCellValue(kbCtrl.focusedDropdownCell.row, kbCtrl.focusedDropdownCell.col, filteredOpts[0]);
                                    }
                                }
                                kbCtrl.focusedDropdownCell = null;
                                moveSelectionMergeAware(0, e.shiftKey ? -1 : 1, false);
                                scrollToAnchor();
                            } else if (e.key === "Escape") {
                                kbCtrl.focusedDropdownCell = null;
                            }
                        }}
                    />
                    {#each filteredOpts as opt}
                        <button
                            class="dropdown-option"
                            onmousedown={(e) => {
                                e.preventDefault();
                                if (kbCtrl.focusedDropdownCell.onCommit) {
                                    kbCtrl.focusedDropdownCell.onCommit(opt);
                                } else {
                                    sheetStore?.setCellValue(kbCtrl.focusedDropdownCell.row, kbCtrl.focusedDropdownCell.col, opt);
                                }
                                kbCtrl.focusedDropdownCell = null;
                            }}>{opt}</button
                        >
                    {/each}
                    {#if filteredOpts.length === 0}
                        <div class="dropdown-no-match">No matches</div>
                    {/if}
                </div>
            {/if}

            <!-- Entry-row insert hint -->
            <div class="entry-row-hint" style={entryRowHintStyle}>
                <kbd>↵</kbd> to insert row
            </div>

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
                        // Session still active (formula mode) — commit+move together
                        commitEditAndMove(dRow, dCol);
                    } else {
                        // Text editor called commitEdit() before onTabCommit — session already ended.
                        // Check if we just committed a TABLE_ENTRY cell.
                        if (lastTableEntryEditInfo) {
                            const { row, col, table } = lastTableEntryEditInfo;
                            lastTableEntryEditInfo = null;
                            navigateEntryRow(row, col, dRow, dCol, table);
                            return;
                        }
                        selectionState.moveSelection(dRow, dCol);
                        scrollToAnchor();
                    }
                }}
            />

            <!-- Link popover (shown when hovering a cell with a hyperlink run) -->
            <LinkPopover link={hoveredLink} />

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
                    bind:this={filterPopoverEl}
                    style="position:absolute; left:{filterPopoverPosition.left}px; top:{filterPopoverPosition.top}px; z-index:50;"
                >
                    <TableFilterPopover
                        table={activeFilterPopover.table}
                        colId={activeFilterPopover.colId}
                        onClose={() => (activeFilterPopover = null)}
                    />
                </div>
            {/if}


            <!-- Plugin action buttons (positioned over their anchor cells) -->
            {#if virtualizer}
                <PluginOverlay {virtualizer} />
                <EntryForgeOverlay {virtualizer} />
                <SplitOverlay {virtualizer} />
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

    <!-- ── View placement overlay ── -->
    {#if viewPlacementStore.active && virtualizer}
        <ViewPlacementOverlay {virtualizer} />
    {/if}
</div>

<!-- Context menu — desktop popup or mobile action bar -->
<GridContextMenu
    visible={contextMenuVisible}
    position={contextMenuPosition}
    onClose={closeContextMenu}
    {containerEl}
    {selectionHandleRect}
    onBeginCellEdit={beginCellEdit}
    onShowFloatingImageInsert={() => { showFloatingImageInsert = true; }}
    onShowCreateTableDialog={() => { showCreateTableDialog = true; }}
    {onShowTablesPanel}
    {onShowRepeatersPanel}
/>

<!-- File viewer (portalled outside grid-root to escape contain:layout stacking context) -->
{#if fileViewerProps}
    <FileViewer
        blobId={fileViewerProps.blobId}
        onClose={() => (fileViewerProps = null)}
    />
{/if}

{#if showCreateTableDialog}
    <TableCreateDialog onClose={() => (showCreateTableDialog = false)} />
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
    .entry-row-hint {
        position: absolute;
        z-index: 30;
        display: flex;
        align-items: center;
        gap: 4px;
        background: var(--surface-bg, #fff);
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 4px;
        padding: 2px 7px 2px 5px;
        font-size: 11px;
        color: var(--muted, #64748b);
        pointer-events: none;
        box-shadow: 0 2px 6px rgba(0,0,0,0.08);
        white-space: nowrap;
    }

    .entry-row-hint kbd {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--table-header-bg, #f1f5f9);
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 3px;
        padding: 0 4px;
        font-family: inherit;
        font-size: 10px;
        line-height: 1.6;
        color: var(--muted, #64748b);
    }

    .entry-row-insert-btn {
        pointer-events: auto;
        background: var(--table-header-bg, #f1f5f9);
        color: var(--muted, #64748b);
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 3px;
        padding: 0 8px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        line-height: 1.6;
        text-decoration: underline;
        text-decoration-color: var(--cell-border, #e2e8f0);
        text-underline-offset: 2px;
    }

    .entry-row-insert-btn:hover {
        border-color: var(--muted, #64748b);
        color: var(--text, #1e293b);
        text-decoration-color: var(--muted, #64748b);
    }

    .grid-root {
        width: 100%;
        height: 100%;
        position: relative;
        overflow: hidden;
        user-select: none;
        background: var(--grid-bg, #fff);
        contain: layout style;
    }

    /* ── Data canvas (z:2 — below selection and DOM overlays) ── */
    .grid-canvas {
        position: absolute;
        left: 50px; /* HEADER_WIDTH */
        top: 28px;  /* HEADER_HEIGHT */
        pointer-events: none;
        z-index: 2;
        display: block; /* prevent inline baseline gap */
    }

    /* ── Selection canvas (z:3 — above data canvas, below DOM overlays) ── */
    .select-canvas {
        position: absolute;
        left: 50px; /* HEADER_WIDTH */
        top: 28px;  /* HEADER_HEIGHT */
        pointer-events: none;
        display: block;
        z-index: 3;
    }

    /* ── DOM overlay layer (z:5) ── */
    .dom-overlay-layer {
        position: absolute;
        inset: 0;
        z-index: 5;
        pointer-events: none; /* children opt in via pointer-events:auto */
        overflow: hidden;
        contain: layout style;
    }

    /* ── Event layer (z:4) — native scroll container ── */
    .event-layer {
        overflow: scroll;
        /* Contain scroll so it never bubbles to the body (no overscroll bounce) */
        overscroll-behavior: contain;
        /* Allow touch pan gestures — the browser will natively scroll this element */
        touch-action: pan-x pan-y;
        pointer-events: auto;
        /* Slightly larger scrollbar for easier grabbing */
        scrollbar-width: auto;
        scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
    }

    /* WebKit/Chrome/Safari scrollbars on the event layer */
    .event-layer::-webkit-scrollbar {
        width: 20px;
        height: 20px;
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
        contain: layout style;
    }

    /* ── Selection border (outline only — fill is on canvas) ── */
    .selection-border {
        position: absolute;
        left: 0;
        top: 0;
        border: 2px solid var(--selection-border, #3b82f6);
        pointer-events: none;
        z-index: 10;
        box-sizing: border-box;
        will-change: transform;
    }

    /* ── Anchor border ── */
    .anchor-border {
        position: absolute;
        left: 0;
        top: 0;
        border: 2px solid var(--anchor-border, #3b82f6);
        pointer-events: none;
        z-index: 11;
        box-sizing: border-box;
        will-change: transform;
    }

    /* ── Fill handle dot ── */
    .fill-handle {
        position: absolute;
        left: 0;
        top: 0;
        width: 8px;
        height: 8px;
        background: var(--selection-border, #3b82f6);
        border: 1px solid #fff;
        border-radius: 1px;
        pointer-events: auto;
        cursor: crosshair;
        z-index: 12;
        will-change: transform;
    }

    /* ── Fill preview border (dashed, shown while dragging fill handle) ── */
    .fill-preview-border {
        position: absolute;
        left: 0;
        top: 0;
        border: 2px dashed var(--selection-border, #3b82f6);
        pointer-events: none;
        z-index: 10;
        box-sizing: border-box;
        will-change: transform;
    }

    /* ── Table row drag ghost + drop line ── */
    .trow-drag-ghost {
        position: absolute;
        pointer-events: none;
        z-index: 18;
        background: rgba(59, 130, 246, 0.12);
        border: 1px solid rgba(59, 130, 246, 0.4);
        border-radius: 2px;
        box-sizing: border-box;
    }

    .trow-drag-drop-line {
        position: absolute;
        height: 2px;
        background: #3b82f6;
        pointer-events: none;
        z-index: 19;
        border-radius: 1px;
        box-shadow: 0 0 4px rgba(59, 130, 246, 0.6);
    }

    /* ── Out-of-order notice ── */
    .ooo-notice {
        position: absolute;
        z-index: 22;
        background: #fef9c3;
        border: 1px solid #fde68a;
        border-radius: 5px;
        padding: 4px 8px;
        font-size: 11px;
        color: #92400e;
        display: flex;
        align-items: center;
        gap: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        white-space: nowrap;
        pointer-events: all;
    }

    .ooo-btn {
        font-size: 10px;
        padding: 2px 7px;
        border: 1px solid #f59e0b;
        border-radius: 3px;
        background: #fff;
        color: #92400e;
        cursor: pointer;
        font-weight: 600;
    }
    .ooo-btn:hover { background: #fef3c7; }

    .ooo-dismiss {
        font-size: 10px;
        background: none;
        border: none;
        color: #b45309;
        cursor: pointer;
        padding: 0;
    }
    .ooo-dismiss:hover { text-decoration: underline; }

    /* ── Frozen-pane divider lines ── */
    .frozen-divider {
        position: absolute;
        pointer-events: none;
        z-index: 20;
    }
    .frozen-divider--row {
        right: 0;
        height: 0;
        border-top: 2px solid rgba(100, 116, 139, 0.45);
        box-shadow: 0 2px 5px rgba(0, 0, 0, 0.10);
    }
    .frozen-divider--col {
        bottom: 0;
        width: 0;
        border-left: 2px solid rgba(100, 116, 139, 0.45);
        box-shadow: 2px 0 5px rgba(0, 0, 0, 0.10);
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
        left: 0;
        top: 0;
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
        background: var(--cell-bg, #ffffff);
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 8px 28px rgba(15, 23, 42, 0.16);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: 200px;
        overflow-y: auto;
    }

    .dropdown-option {
        padding: 6px 10px;
        text-align: left;
        background: none;
        border: none;
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        cursor: pointer;
        font-size: 0.8125rem;
        color: var(--text-color, #1e293b);
        white-space: nowrap;
    }

    .dropdown-option:last-child {
        border-bottom: none;
    }
    .dropdown-option:hover {
        background: var(--cell-hover, #f1f5f9);
        color: var(--text-color, #1e293b);
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
        position: relative;
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
        padding: 20px;
        width: 360px;
        max-width: 92vw;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    /* ImageEditor is absolutely positioned for cell overlay use; in this dialog it
       should sit in normal flow under the title. */
    .floating-insert-dialog :global(.image-editor) {
        position: relative;
        z-index: auto;
    }

    .floating-insert-title {
        font-size: 0.9375rem;
        font-weight: 600;
        color: #1e293b;
        margin: 0;
    }

    /* ── Remote user cursors ── */
    .remote-cursor {
        position: absolute;
        border: 2px solid var(--cursor-color, #22c55e);
        pointer-events: none;
        z-index: 12;
        box-sizing: border-box;
        border-radius: 2px;
    }

    .remote-cursor-label {
        position: absolute;
        top: -18px;
        left: -2px;
        background: var(--cursor-color, #22c55e);
        color: white;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 3px;
        white-space: nowrap;
        font-weight: 500;
    }

    .remote-selection {
        position: absolute;
        border: 2px solid var(--cursor-color, #22c55e);
        background: color-mix(
            in srgb,
            var(--cursor-color, #22c55e) 15%,
            transparent
        );
        pointer-events: none;
        z-index: 12;
        box-sizing: border-box;
        border-radius: 2px;
    }
</style>
