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
    import { buildRenderRuns, hitTestLink } from "../../stores/spreadsheet/textFormatRuns.js";
    import { perfMon } from "../../stores/spreadsheet/perf/PerfMonitor.js";
    import GridOverlays from "./grid/GridOverlays.svelte";
    import LinkPopover from "./grid/LinkPopover.svelte";
    import ColHeaders from "./grid/ColHeaders.svelte";
    import RowHeaders from "./grid/RowHeaders.svelte";
    import ContextMenu from "../ui/ContextMenu.svelte";
    import FileViewer from "./cellTypes/FileViewer.svelte";
    import TableFilterPopover from "./features/TableFilterPopover.svelte";
    import TableCreateDialog from "./features/TableCreateDialog.svelte";
    import RepeaterCreateDialog from "./features/RepeaterCreateDialog.svelte";
    import RepeaterEditPanel from "./features/RepeaterEditPanel.svelte";
    import ViewPlacementOverlay from "./features/ViewPlacementOverlay.svelte";
    import { viewPlacementStore } from "../../stores/spreadsheet/viewPlacementStore.svelte.js";
    import { PrintEngine } from "../../stores/spreadsheet/features/PrintEngine.js";
    import FloatingImages from "./FloatingImages.svelte";
    import ImageEditor from "./cellTypes/ImageEditor.svelte";
    import DatePickerEditor from "./cellTypes/DatePickerEditor.svelte";
    import { setOnLoadCallback } from "../../stores/spreadsheet/rendering/ImageCache.js";
    import storage from "../../stores/storage.js";
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import AlertModal from "../modals/AlertModal.svelte";
    import { mobileState } from "../../stores/mobileState.svelte.js";
    import SelectionHandles from "./grid/SelectionHandles.svelte";
    import MobileCellActionBar from "./grid/MobileCellActionBar.svelte";

    // ─── Props ─────────────────────────────────────────────────────────────────
    let {
        showPageBreaks = false,
        printSettings = null,
        requestMobileKeyboardFocus = null,
        onShowTablesPanel = undefined,
    } = $props();

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
    // Expose to child components (e.g. SelectionHandles) without prop drilling
    setContext("hitTestEngine", hitTestEngine);
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

    // ─── Freeze-handle drag state ─────────────────────────────────────────────
    // null | { axis: 'row'|'col', startPx: number, currentCount: number }
    let freezeDrag = $state(null);

    // ─── Fill-handle drag state ────────────────────────────────────────────────
    // null | { srcRange: CellRange, fillRange: CellRange|null, direction: string|null }
    let fillHandleDrag = $state(null);

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

    function getOverlayViewportRect(margin = 8) {
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
        const offset = opts.offset ?? 6;
        const margin = opts.margin ?? 8;
        const bounds = getOverlayViewportRect(margin);
        if (!bounds) return { left: anchor.left, top: anchor.top + anchor.height + offset };

        const panelWidth = Math.max(120, panel.width);
        const panelHeight = Math.max(60, panel.height);
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
                width: panelRect?.width ?? 244,
                height: panelRect?.height ?? 320,
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
    let editPanelPosition = $state(null);
    let editPanelEl = $state(null);

    /**
     * Calculate position for repeater edit panel, ensuring it stays within viewport.
     * @param {'repeater'} type
     * @param {any} store
     * @returns {{ x: number, y: number }}
     */
    function calculateEditPanelPosition(type, store) {
        if (!containerEl || !virtualizer || !renderPlan) return { x: 0, y: 0 };

        const panelRect = editPanelEl?.getBoundingClientRect();
        const panelWidth = panelRect?.width ?? 248;
        const panelHeight = panelRect?.height ?? 380;

        let anchorRight, anchorTop;

        const rect = rangeOutlineStyle(
            store.templateStartRow,
            store.templateStartCol,
            store.inlineEndRow,
            store.inlineEndCol,
        );
        if (!rect) return { x: 0, y: 0 };
        anchorRight = rect.left + rect.width;
        anchorTop = rect.top;

        const placed = placeOverlayNearAnchor(
            { left: anchorRight, top: anchorTop + 20, width: 18, height: 18 },
            { width: panelWidth, height: panelHeight },
            { preferX: "start", preferY: "below", offset: 6, margin: 8 },
        );
        return { x: placed.left, y: placed.top };
    }

    // Recalculate position when activeEditPanel changes
    $effect(() => {
        const _sl = virtualizer?.scrollLeft;
        const _st = virtualizer?.scrollTop;
        const _cw = containerEl?.clientWidth;
        const _vh = getContainerVisibleBottomPx();
        const _panelEl = editPanelEl;
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
    /** @type {{ row:number, col:number, options:string[], left:number, top:number, width:number, height:number }|null} */
    let focusedDropdownCell = $state(null);
    let dropdownFilter = $state("");
    let dropdownFilterInputEl = $state(null);
    /** @type {{ type: 'repeater', store:any }|null} */
    let activeEditPanel = $state(null);

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

    // ─── Canvas setup & resize ─────────────────────────────────────────────────
    $effect(() => {
        // Track sheetStore so this effect re-runs when the document loads.
        // The virtualizer init effect (declared above) runs first in the same batch,
        // so virtualizer is already set by the time we get here.
        const _sheet = sheetStore;
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
        const _sheet = sheetStore; // same as data canvas: re-run when sheet loads
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
        const _cfVer = sheetStore?.cfVersion;
        const _mergeVer = renderContext?.mergeEngine?.version;
        const _tableVer = renderContext?.tableManager?.tableVersion;
        const _repVer = renderContext?.repeaterEngine?.repeaterVersion;
        const _fr = virtualizer?.frozenRows;
        const _fc = virtualizer?.frozenCols;
        const _formulaVer = spreadsheetSession?.formulaEngine?.computedVersion;

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

    // ─── Timed buildPaneData wrapper ──────────────────────────────────────────
    function buildPaneDataTimed(params) {
        if (!perfMon.enabled) return buildPaneData(params);
        const t = performance.now();
        const result = buildPaneData(params);
        perfMon.record('render.buildPaneData', performance.now() - t);
        perfMon.record('render.buildPaneCells', result.length);
        return result;
    }

    // ─── Paint function (called by RenderScheduler on RAF) ────────────────────
    // dirtyPanes: Set of 'body'|'top'|'left'|'corner' to repaint.
    // When all four are present (default), the whole canvas is cleared first.
    // Partial sets are used by performScrollPaint to skip unchanged frozen panes.
    function performPaint(
        dirtyPanes = new Set(["body", "top", "left", "corner"]),
    ) {
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
        if (dirtyPanes.has("body")) {
            const bp = renderPlan.plans.body;
            if (!isFullRepaint)
                canvasRenderer.clearPane(
                    frozenWidth,
                    frozenHeight,
                    bodyW,
                    bodyH,
                );
            if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    buildPaneDataTimed({
                        ...commonParams,
                        rowRange: bp.rowRange,
                        colRange: bp.colRange,
                        scrollLeft,
                        scrollTop,
                    }),
                    {
                        clipX: frozenWidth,
                        clipY: frozenHeight,
                        clipW: bodyW,
                        clipH: bodyH,
                    },
                );
            }
        }

        // Top pane (frozen rows × scrollable cols)
        if (dirtyPanes.has("top")) {
            const tp = renderPlan.plans.top;
            if (!isFullRepaint)
                canvasRenderer.clearPane(frozenWidth, 0, bodyW, frozenHeight);
            if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    buildPaneDataTimed({
                        ...commonParams,
                        rowRange: tp.rowRange,
                        colRange: tp.colRange,
                        scrollLeft,
                        scrollTop: 0,
                    }),
                    {
                        clipX: frozenWidth,
                        clipY: 0,
                        clipW: bodyW,
                        clipH: frozenHeight,
                    },
                );
            }
        }

        // Left pane (scrollable rows × frozen cols)
        if (dirtyPanes.has("left")) {
            const lp = renderPlan.plans.left;
            if (!isFullRepaint)
                canvasRenderer.clearPane(0, frozenHeight, frozenWidth, bodyH);
            if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    buildPaneDataTimed({
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
                        clipH: bodyH,
                    },
                );
            }
        }

        // Corner pane (frozen rows × frozen cols)
        if (dirtyPanes.has("corner")) {
            const cp = renderPlan.plans.corner;
            if (!isFullRepaint)
                canvasRenderer.clearPane(0, 0, frozenWidth, frozenHeight);
            if (cp.rowRange.count > 0 && cp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    buildPaneDataTimed({
                        ...commonParams,
                        rowRange: cp.rowRange,
                        colRange: cp.colRange,
                        scrollLeft: 0,
                        scrollTop: 0,
                    }),
                    {
                        clipX: 0,
                        clipY: 0,
                        clipW: frozenWidth,
                        clipH: frozenHeight,
                    },
                );
            }
        }

        // Sticky table headers — repaint whenever top or body changes (they live in the top strip)
        if (dirtyPanes.has("top") || dirtyPanes.has("body") || isFullRepaint) {
            const stickyHeaders = renderContext?.getStickyTableHeaders?.(
                virtualizer.scrollTop,
                renderPlan.frozenHeight,
                virtualizer.rowMetrics,
                virtualizer.colMetrics,
            );
            if (stickyHeaders?.length > 0) {
                canvasRenderer.paintStickyHeaders(stickyHeaders, {
                    frozenWidth,
                    frozenHeight,
                    scrollLeft,
                });
            }
        }

        // Grip icons for reorderable table rows (post-paint, direct 2d context)
        paintTableGripIcons(scrollLeft, scrollTop, frozenHeight, bodyH);
    }

    function paintTableGripIcons(scrollLeft, scrollTop, frozenHeight, bodyH) {
        if (!canvasEl || !virtualizer || !renderContext?.tableManager) return;
        const ctx = canvasEl.getContext('2d');
        if (!ctx) return;

        for (const table of renderContext.tableManager.stores.values()) {
            if (table.isSourceOnly || table.sortColId) continue;

            const tableCanvasX = virtualizer.colMetrics.offsetOf(table.startCol) - scrollLeft;
            const colW = virtualizer.getColWidth(table.startCol);
            if (tableCanvasX > virtualizer.containerWidth - HEADER_WIDTH || tableCanvasX + colW < 0) continue;

            const firstDataRow = table.startRow + 2;
            const rowCount = table.sortedFilteredRows.length;

            for (let di = 0; di < rowCount; di++) {
                const gridRow = firstDataRow + di;
                const rowCanvasY = virtualizer.rowMetrics.offsetOf(gridRow) - scrollTop + frozenHeight;
                const rowH = virtualizer.getRowHeight(gridRow);
                if (rowCanvasY + rowH < frozenHeight || rowCanvasY > frozenHeight + bodyH) continue;

                const isHovered = tableGripHoverRow === gridRow;
                const isDragging = tableRowDrag?.fromGridRow === gridRow;
                ctx.fillStyle = isDragging ? 'rgba(59,130,246,0.8)'
                    : isHovered ? 'rgba(100,116,139,0.65)'
                    : 'rgba(148,163,184,0.3)';

                const cx = tableCanvasX + 7;
                const cy = rowCanvasY + rowH / 2;
                for (let r = 0; r < 3; r++) {
                    for (let c = 0; c < 2; c++) {
                        ctx.fillRect(Math.round(cx + c * 4 - 2), Math.round(cy + r * 4 - 4), 2, 2);
                    }
                }
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
            rowMetrics,
            colMetrics,
            renderContext,
            sheetStore,
            session: spreadsheetSession,
            frozenRows,
            frozenCols,
            frozenHeight,
            frozenWidth,
        };

        // Pre-compute sticky headers so we can extend the upward-scroll strip to erase ghosts.
        // When scrolling up, blitScroll shifts the sticky-header pixels down into the body,
        // leaving a ghost copy. Extending the strip repaint to cover that ghost zone erases it.
        // IMPORTANT: use prevST (the scroll position before this frame) to find what was
        // sticky on the canvas before the blit — not scrollTop, which may have crossed the
        // un-sticky threshold so it returns nothing and leaves the ghost un-erased.
        const stickyHeaders = renderContext?.getStickyTableHeaders?.(
            scrollTop, frozenHeight, rowMetrics, colMetrics,
        ) ?? [];
        const prevStickyHeaders = dy < 0
            ? (renderContext?.getStickyTableHeaders?.(prevST, frozenHeight, rowMetrics, colMetrics) ?? [])
            : stickyHeaders;
        const stickyOverlayH = prevStickyHeaders.reduce(
            (m, h) => Math.max(m, h.headerHeightPx + (h.showEntry ? h.entryHeightPx : 0)), 0,
        );

        // Helper: build a strip row range from pixel offsets (visible-viewport based)
        function rowStripRange(fromOffset, toOffset) {
            const s = Math.max(
                frozenRows,
                rowMetrics.indexAtOffset(fromOffset),
            );
            const e = Math.min(
                virtualizer.rowCount - 1,
                rowMetrics.indexAtOffset(toOffset) + 1,
            );
            return s <= e ? { start: s, end: e, count: e - s + 1 } : null;
        }
        function colStripRange(fromOffset, toOffset) {
            const s = Math.max(
                frozenCols,
                colMetrics.indexAtOffset(fromOffset),
            );
            const e = Math.min(
                virtualizer.colCount - 1,
                colMetrics.indexAtOffset(toOffset) + 1,
            );
            return s <= e ? { start: s, end: e, count: e - s + 1 } : null;
        }

        const bp = renderPlan.plans.body;

        // ── Body pane: blit + repaint exposed strips ──────────────────────────
        canvasRenderer.blitScroll(
            dx,
            dy,
            frozenWidth,
            frozenHeight,
            bodyW,
            bodyH,
        );

        if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
            // Vertical strip (rows entering top or bottom)
            if (dy !== 0) {
                let stripRows, clipY, clipH;
                if (dy > 0) {
                    // Scrolling down → bottom strip
                    stripRows = rowStripRange(
                        frozenHeight + prevST + bodyH,
                        frozenHeight + scrollTop + bodyH,
                    );
                    clipY = frozenHeight + bodyH - dy;
                    clipH = dy;
                } else {
                    // Scrolling up → top strip, extended by stickyOverlayH to repaint the ghost
                    // zone where blitScroll shifted the sticky header pixels downward.
                    stripRows = rowStripRange(frozenHeight + scrollTop, frozenHeight + prevST + stickyOverlayH);
                    clipY = frozenHeight;
                    clipH = Math.min(-dy + stickyOverlayH, bodyH);
                }
                if (stripRows) {
                    canvasRenderer.paintPane(
                        buildPaneDataTimed({
                            ...commonParams,
                            rowRange: stripRows,
                            colRange: bp.colRange,
                            scrollLeft,
                            scrollTop,
                        }),
                        { clipX: frozenWidth, clipY, clipW: bodyW, clipH },
                    );
                }
            }

            // Horizontal strip (cols entering left or right)
            if (dx !== 0) {
                let stripCols, clipX, clipW;
                if (dx > 0) {
                    stripCols = colStripRange(
                        frozenWidth + prevSL + bodyW,
                        frozenWidth + scrollLeft + bodyW,
                    );
                    clipX = frozenWidth + bodyW - dx;
                    clipW = dx;
                } else {
                    stripCols = colStripRange(frozenWidth + scrollLeft, frozenWidth + prevSL);
                    clipX = frozenWidth;
                    clipW = -dx;
                }
                if (stripCols) {
                    canvasRenderer.paintPane(
                        buildPaneDataTimed({
                            ...commonParams,
                            rowRange: bp.rowRange,
                            colRange: stripCols,
                            scrollLeft,
                            scrollTop,
                        }),
                        { clipX, clipY: frozenHeight, clipW, clipH: bodyH },
                    );
                }
            }
        }

        // ── Top pane (frozen rows × scrollable cols): blit + col strip ────────
        if (dx !== 0) {
            const tp = renderPlan.plans.top;
            if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
                canvasRenderer.blitScroll(
                    dx,
                    0,
                    frozenWidth,
                    0,
                    bodyW,
                    frozenHeight,
                );
                let stripCols, clipX, clipW;
                if (dx > 0) {
                    stripCols = colStripRange(
                        frozenWidth + prevSL + bodyW,
                        frozenWidth + scrollLeft + bodyW,
                    );
                    clipX = frozenWidth + bodyW - dx;
                    clipW = dx;
                } else {
                    stripCols = colStripRange(frozenWidth + scrollLeft, frozenWidth + prevSL);
                    clipX = frozenWidth;
                    clipW = -dx;
                }
                if (stripCols) {
                    canvasRenderer.paintPane(
                        buildPaneDataTimed({
                            ...commonParams,
                            rowRange: tp.rowRange,
                            colRange: stripCols,
                            scrollLeft,
                            scrollTop: 0,
                        }),
                        { clipX, clipY: 0, clipW, clipH: frozenHeight },
                    );
                }
            }
        }

        // ── Left pane (frozen cols × scrollable rows): blit + row strip ───────
        if (dy !== 0) {
            const lp = renderPlan.plans.left;
            if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
                canvasRenderer.blitScroll(
                    0,
                    dy,
                    0,
                    frozenHeight,
                    frozenWidth,
                    bodyH,
                );
                let stripRows, clipY, clipH;
                if (dy > 0) {
                    stripRows = rowStripRange(
                        frozenHeight + prevST + bodyH,
                        frozenHeight + scrollTop + bodyH,
                    );
                    clipY = frozenHeight + bodyH - dy;
                    clipH = dy;
                } else {
                    stripRows = rowStripRange(frozenHeight + scrollTop, frozenHeight + prevST);
                    clipY = frozenHeight;
                    clipH = -dy;
                }
                if (stripRows) {
                    canvasRenderer.paintPane(
                        buildPaneDataTimed({
                            ...commonParams,
                            rowRange: stripRows,
                            colRange: lp.colRange,
                            scrollLeft: 0,
                            scrollTop,
                        }),
                        { clipX: 0, clipY, clipW: frozenWidth, clipH },
                    );
                }
            }
        }

        // Corner pane: never changes during scroll — skip entirely

        // Sticky table headers — repaint after all blits/strips so they appear on top
        if (stickyHeaders.length > 0) {
            canvasRenderer.paintStickyHeaders(stickyHeaders, {
                frozenWidth,
                frozenHeight,
                scrollLeft,
            });
        }
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

    let dropdownOverlayStyle = $derived.by(() => {
        if (!focusedDropdownCell || !containerEl) return "display:none;";
        const preferredWidth = Math.max(focusedDropdownCell.width, 164);
        const preferredHeight = 240;
        const anchor = {
            left: focusedDropdownCell.left,
            top: focusedDropdownCell.top,
            width: focusedDropdownCell.width,
            height: focusedDropdownCell.height,
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
                    selectionState.anchor = {
                        row: snapped.row,
                        col: snapped.col,
                    };
                    selectionState.focus = {
                        row: snapped.row,
                        col: snapped.col,
                    };
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

    // Bottom-right corner (container-local px) where the fill handle dot sits.
    let fillHandlePos = $derived.by(() => {
        if (!virtualizer || !renderPlan || editSessionState.isEditing) return null;
        if (selectionState.selectionMode !== 'range') return null;
        if (selectionState.isSelecting || fillHandleDrag) return null;
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

    // ─── Fill-handle handlers ─────────────────────────────────────────────────
    function handleFillHandleMouseDown(e) {
        e.preventDefault();
        e.stopPropagation();

        const range = selectionState.range;
        const srcRange = range ?? (anchor ? { startRow: anchor.row, endRow: anchor.row, startCol: anchor.col, endCol: anchor.col } : null);
        if (!srcRange) return;

        fillHandleDrag = { srcRange, fillRange: null, direction: null };
        currentCursor = 'crosshair';

        function onMove(e) {
            if (!fillHandleDrag || !virtualizer || !containerEl) return;
            const { localX, localY } = getLocalCoords(e);
            const hit = doHitTest(localX, localY);
            if (hit.region !== 'cell') return;

            const { row, col } = hit;
            const src = fillHandleDrag.srcRange;
            let fillRange = null;
            let direction = null;

            if (row > src.endRow) {
                direction = 'down';
                fillRange = { startRow: src.endRow + 1, endRow: row, startCol: src.startCol, endCol: src.endCol };
            } else if (row < src.startRow) {
                direction = 'up';
                fillRange = { startRow: row, endRow: src.startRow - 1, startCol: src.startCol, endCol: src.endCol };
            } else if (col > src.endCol) {
                direction = 'right';
                fillRange = { startRow: src.startRow, endRow: src.endRow, startCol: src.endCol + 1, endCol: col };
            } else if (col < src.startCol) {
                direction = 'left';
                fillRange = { startRow: src.startRow, endRow: src.endRow, startCol: col, endCol: src.startCol - 1 };
            }

            fillHandleDrag = { ...fillHandleDrag, fillRange, direction };
        }

        function onUp() {
            if (fillHandleDrag?.fillRange && fillHandleDrag.direction) {
                applyFill(fillHandleDrag.srcRange, fillHandleDrag.fillRange, fillHandleDrag.direction);
            }
            fillHandleDrag = null;
            currentCursor = 'cell';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    // ─── Fill-handle series detection helpers ────────────────────────────────
    const FILL_MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const FILL_MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const FILL_DAYS_SHORT   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const FILL_DAYS_LONG    = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const FILL_CYCLIC_LISTS = [FILL_MONTHS_SHORT, FILL_MONTHS_LONG, FILL_DAYS_SHORT, FILL_DAYS_LONG];

    /**
     * Given an array of raw (non-formula) source values ordered along the fill axis,
     * returns a function (stepIndex) => value, or null if no series is detected.
     * stepIndex is the 0-based offset from srcRange.startRow/Col — negative for up/left fills.
     */
    function detectFillSeries(rawValues) {
        const vals = rawValues.filter(v => v !== null && v !== undefined);
        if (vals.length === 0) return null;

        // 1. Number series
        if (vals.every(v => typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v))))) {
            const nums = vals.map(Number);
            const step = nums.length === 1 ? 1 : (nums[nums.length - 1] - nums[0]) / (nums.length - 1);
            const base = nums[0];
            return (si) => {
                const result = base + si * step;
                return Number.isInteger(step) ? Math.round(result) : result;
            };
        }

        // 2. Cyclic named lists (months, weekdays)
        for (const list of FILL_CYCLIC_LISTS) {
            const lower = list.map(s => s.toLowerCase());
            const indices = vals.map(v => (typeof v === 'string' ? lower.indexOf(v.toLowerCase()) : -1));
            if (indices.every(i => i >= 0)) {
                const baseIdx = indices[0];
                const step = indices.length > 1
                    ? ((indices[1] - indices[0] + list.length) % list.length) || 1
                    : 1;
                const n = list.length;
                return (si) => list[((baseIdx + si * step) % n + n) % n];
            }
        }

        // 3. String + number suffix  (e.g. "Q1", "Q2" or "Item 1", "Item 2")
        const SFX = /^(.*?)(\d+)(\D*)$/;
        const matches = vals.map(v => {
            if (typeof v !== 'string') return null;
            const m = v.match(SFX);
            return m ? { prefix: m[1], num: parseInt(m[2], 10), padLen: m[2].length, suffix: m[3] } : null;
        });
        if (matches.every(m => m !== null)) {
            const { prefix, padLen, suffix } = matches[0];
            if (matches.every(m => m.prefix === prefix && m.suffix === suffix)) {
                const nums = matches.map(m => m.num);
                const step = nums.length === 1 ? 1 : Math.round((nums[nums.length - 1] - nums[0]) / (nums.length - 1));
                return (si) => {
                    const n = Math.round(nums[0] + si * step);
                    const digits = String(Math.abs(n)).padStart(padLen, '0');
                    return `${prefix}${n < 0 ? '-' : ''}${digits}${suffix}`;
                };
            }
        }

        return null;
    }

    function applyFill(srcRange, fillRange, direction) {
        const store = sheetStore;
        if (!store) return;

        /**
         * Write a fill value to cell (r,c), routing table cells to their store.
         * Formulas are adjusted for table data cells to plain formula strings only
         * if the column supports it; otherwise the raw value is used.
         */
        /** @param {number} r @param {number} c @param {any} value */
        function writeFillValue(r, c, value) {
            const ct = renderContext?.getCellType(r, c);
            if (ct === CELL_TYPE.TABLE_DATA) {
                const info = renderContext?.tableManager?.getCellInfo(r, c);
                if (info?.table && info.colDef && !info.colDef.isNonEntry && info.dataIndex >= 0) {
                    const parsed = typeof value === 'string' && value.startsWith('=')
                        ? value
                        : CellTypeRegistry.parseInput({ type: info.colDef.type }, value);
                    info.table.updateCell(info.dataIndex, info.colDef.id, parsed);
                }
                return; // never fall through to sheet store for table cells
            }
            if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY) return;
            if (typeof value === 'string' && value.startsWith('=')) {
                store.setCellFormula(r, c, value);
            } else {
                store.setCellValue(r, c, value);
            }
        }

        const srcRows = srcRange.endRow - srcRange.startRow + 1;
        const srcCols = srcRange.endCol - srcRange.startCol + 1;
        const isVertical = direction === 'down' || direction === 'up';

        if (isVertical) {
            for (let c = srcRange.startCol; c <= srcRange.endCol; c++) {
                const laneValues = [];
                let hasFormula = false;
                for (let r = srcRange.startRow; r <= srcRange.endRow; r++) {
                    const cell = store.getCell(r, c);
                    const v = cell?.exists ? cell.v : null;
                    if (typeof v === 'string' && v.startsWith('=')) hasFormula = true;
                    laneValues.push(v);
                }
                const seriesFn = hasFormula ? null : detectFillSeries(laneValues);

                for (let r = fillRange.startRow; r <= fillRange.endRow; r++) {
                    if (hasFormula) {
                        const srcRow = srcRange.startRow + (((r - srcRange.startRow) % srcRows) + srcRows) % srcRows;
                        const cell = store.getCell(srcRow, c);
                        if (!cell?.exists) continue;
                        const v = cell.v;
                        if (v !== null && v !== undefined) {
                            const adjusted = typeof v === 'string' && v.startsWith('=')
                                ? clipboardManager.adjustFormula(v, r - srcRow, 0)
                                : v;
                            writeFillValue(r, c, adjusted);
                        }
                    } else if (seriesFn) {
                        writeFillValue(r, c, seriesFn(r - srcRange.startRow));
                    } else {
                        const srcRow = srcRange.startRow + (((r - srcRange.startRow) % srcRows) + srcRows) % srcRows;
                        const cell = store.getCell(srcRow, c);
                        if (cell?.exists && cell.v !== null && cell.v !== undefined) {
                            writeFillValue(r, c, cell.v);
                        }
                    }
                }
            }
        } else {
            for (let r = srcRange.startRow; r <= srcRange.endRow; r++) {
                const laneValues = [];
                let hasFormula = false;
                for (let c = srcRange.startCol; c <= srcRange.endCol; c++) {
                    const cell = store.getCell(r, c);
                    const v = cell?.exists ? cell.v : null;
                    if (typeof v === 'string' && v.startsWith('=')) hasFormula = true;
                    laneValues.push(v);
                }
                const seriesFn = hasFormula ? null : detectFillSeries(laneValues);

                for (let c = fillRange.startCol; c <= fillRange.endCol; c++) {
                    if (hasFormula) {
                        const srcCol = srcRange.startCol + (((c - srcRange.startCol) % srcCols) + srcCols) % srcCols;
                        const cell = store.getCell(r, srcCol);
                        if (!cell?.exists) continue;
                        const v = cell.v;
                        if (v !== null && v !== undefined) {
                            const adjusted = typeof v === 'string' && v.startsWith('=')
                                ? clipboardManager.adjustFormula(v, 0, c - srcCol)
                                : v;
                            writeFillValue(r, c, adjusted);
                        }
                    } else if (seriesFn) {
                        writeFillValue(r, c, seriesFn(c - srcRange.startCol));
                    } else {
                        const srcCol = srcRange.startCol + (((c - srcRange.startCol) % srcCols) + srcCols) % srcCols;
                        const cell = store.getCell(r, srcCol);
                        if (cell?.exists && cell.v !== null && cell.v !== undefined) {
                            writeFillValue(r, c, cell.v);
                        }
                    }
                }
            }
        }

        renderScheduler?.invalidateAll();
        selectionScheduler?.invalidateAll();
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
        const hit = doHitTest(localX, localY);
        currentCursor = hitTestEngine.getCursor(hit);

        // Detect grip-handle hover: leftmost 14 px of a reorderable TABLE_DATA row.
        if (hit.region === 'cell' && hit.row >= 0 && hit.col >= 0) {
            const cellType = renderContext?.getCellType(hit.row, hit.col);
            if (cellType === CELL_TYPE.TABLE_DATA) {
                const info = renderContext?.tableManager?.getCellInfo(hit.row, hit.col);
                if (info?.table && !info.table.sortColId && hit.col === info.table.startCol) {
                    const xInCell = localX - cellContainerLeft(hit.col);
                    if (xInCell >= 0 && xInCell < 14) {
                        currentCursor = tableRowDrag ? 'grabbing' : 'grab';
                        if (tableGripHoverRow !== hit.row) {
                            tableGripHoverRow = hit.row;
                            untrack(() => renderScheduler?.invalidateAll());
                        }
                        return;
                    }
                }
            }
        }
        if (tableGripHoverRow !== -1) {
            tableGripHoverRow = -1;
            untrack(() => renderScheduler?.invalidateAll());
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
            rangeEndCell = { row: hit.row, col: hit.col };
            return;
        }
        if (selectionState.isSelecting) {
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
                selectionState.extendSelection(hit.row, hit.col);
            }
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
                    selectionState.startSelection(snappedHit.row, snappedHit.col);
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
                selectionState.extendSelection(hit.row, hit.col);
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
            : CellTypeRegistry.parseInput({ type: info.colDef.type }, value);
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
        const parsed = CellTypeRegistry.parseInput({ type: info.colDef.type }, value);
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

            // ── Drag handle: leftmost 14 px of the table's first column ─────
            if (info?.table && !info.table.sortColId && col === info.table.startCol) {
                const cellLeft = cellContainerLeft(col);
                const { localX } = getLocalCoords(e);
                if (localX - cellLeft >= 0 && localX - cellLeft < 14) {
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
            // Snap shift-click to merge boundary too (extend to the primary cell)
            const snapped = snapToMergePrimary(row, col);
            selectionState.extendSelection(snapped.row, snapped.col);
        } else if (isCtrl) {
            // Ctrl+click: add a new non-contiguous range
            const snapped = snapToMergePrimary(row, col);
            selectionState.startAdditionalSelection(snapped.row, snapped.col);
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
            selectionState.startSelection(row, col);
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

    // ─── Editing ──────────────────────────────────────────────────────────────
    function beginCellEdit(row, col, options = {}) {
        const { seedText = null, surface = "grid" } = options;

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
                    dropdownFilter = seedText ?? "";
                    const capturedInfo = info;
                    const capturedCellType = tblCellType;
                    focusedDropdownCell = {
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
                dropdownFilter = seedText ?? "";
                const capturedRow = row, capturedCol = col;
                focusedDropdownCell = {
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
    function persistEditOnSheet(sheetId, payload) {
        if (!payload) return;
        const { row, col, value, tfr } = payload;
        const targetSheetId = sheetId || spreadsheetSession.activeSheetId;

        if (typeof value === "string" && value.startsWith("=")) {
            spreadsheetSession.setCellFormulaOnSheet(targetSheetId, row, col, value);
        } else if (tfr && tfr.length > 0) {
            // Rich text: store plain value + runs together
            const targetStore =
                targetSheetId === spreadsheetSession.activeSheetId ? sheetStore : null;
            const ct = targetStore?.getCellTypeConfig(row, col);
            const parsedValue = CellTypeRegistry.parseInput(ct, value);
            targetStore?.setCellValueWithRuns(row, col, parsedValue, tfr);
        } else {
            const targetStore =
                targetSheetId === spreadsheetSession.activeSheetId ? sheetStore : null;
            const ct = targetStore?.getCellTypeConfig(row, col);
            const parsedValue = CellTypeRegistry.parseInput(ct, value);
            spreadsheetSession.setCellValueOnSheet(targetSheetId, row, col, parsedValue);
        }
    }

    /**
     * Persist a cell edit to the correct store (table or sheet).
     * Routes to commitTableDataCell, commitTableEntryCell, renameColumn, or persistEditOnSheet.
     * value may be a plain string or { value, tfr } for rich text.
     */
    function persistCellEdit(sheetId, row, col, value, tfr = null) {
        // Unpack if caller passed a { value, tfr } object
        let plainValue = value;
        let runsTfr    = tfr;
        if (value !== null && typeof value === 'object' && 'value' in value) {
            plainValue = value.value;
            runsTfr    = value.tfr ?? null;
        }

        const cellType = renderContext?.getCellType(row, col);
        if (cellType === CELL_TYPE.TABLE_DATA) {
            commitTableDataCell(renderContext.tableManager.getCellInfo(row, col), row, col, plainValue);
            return;
        }
        if (cellType === CELL_TYPE.TABLE_ENTRY) {
            commitTableEntryCell(renderContext.tableManager.getCellInfo(row, col), plainValue);
            return;
        }
        if (cellType === CELL_TYPE.TABLE_HEADER) {
            const info = renderContext?.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                const newName = String(plainValue ?? "").trim();
                if (newName) info.table.renameColumn(info.colDef.id, newName);
            }
            return;
        }
        persistEditOnSheet(sheetId, { row, col, value: plainValue, tfr: runsTfr });
    }

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
        persistCellEdit(editingSheetId, payload.row, payload.col, payload.value, payload.tfr);
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

        persistCellEdit(editingSheetId, payload.row, payload.col, payload.value, payload.tfr);

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
            persistCellEdit(editingSheetId, editRow, editCol, plainValue, tfr);
            if (entryInfo?.table)
                lastTableEntryEditInfo = { row: editRow, col: editCol, table: entryInfo.table };
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

    // ─── Resize (columns & rows) ──────────────────────────────────────────────
    function startColResize(col, e) {
        e.preventDefault();
        e.stopPropagation();

        let indices = [col];
        // For 'cols' mode, resize all selected columns (including extra ranges)
        if (selectionState.selectionMode === "cols") {
            const allColRanges = selectionState.allColRanges;
            const inSelection = allColRanges.some(r => col >= r.start && col <= r.end);
            if (inSelection) {
                const colSet = new Set();
                for (const r of allColRanges)
                    for (let c = r.start; c <= r.end; c++) colSet.add(c);
                indices = [...colSet].sort((a, b) => a - b);
            }
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
        // For 'rows' mode, resize all selected rows (including extra ranges)
        if (selectionState.selectionMode === "rows") {
            const allRowRanges = selectionState.allRowRanges;
            const inSelection = allRowRanges.some(r => row >= r.start && row <= r.end);
            if (inSelection) {
                const rowSet = new Set();
                for (const r of allRowRanges)
                    for (let i = r.start; i <= r.end; i++) rowSet.add(i);
                indices = [...rowSet].sort((a, b) => a - b);
            }
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

    // ─── Touch-based resize ──────────────────────────────────────────────────

    function handleResizeTouchMove(e) {
        if (!resizing || !virtualizer || e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        if (resizing.type === "col") {
            const newWidth = Math.max(20, resizing.startSize + (touch.clientX - resizing.startPos));
            for (const idx of resizing.selectedIndices) virtualizer.setTempColWidth(idx, newWidth);
        } else {
            const newHeight = Math.max(10, resizing.startSize + (touch.clientY - resizing.startPos));
            for (const idx of resizing.selectedIndices) virtualizer.setTempRowHeight(idx, newHeight);
        }
    }

    function handleResizeTouchEnd() {
        if (!resizing || !virtualizer || !sheetStore) return;
        if (resizing.type === "col") {
            const finalWidth = virtualizer.getColWidth(resizing.index);
            for (const idx of resizing.selectedIndices) sheetStore.setColWidth(idx, finalWidth);
            virtualizer.clearTempColWidths();
        } else {
            const finalHeight = virtualizer.getRowHeight(resizing.index);
            for (const idx of resizing.selectedIndices) sheetStore.setRowHeight(idx, finalHeight);
            virtualizer.clearTempRowHeights();
        }
        document.removeEventListener("touchmove", handleResizeTouchMove);
        document.removeEventListener("touchend", handleResizeTouchEnd);
        document.removeEventListener("touchcancel", handleResizeTouchEnd);
        resizing = null;
    }

    function startColResizeTouch(col, e) {
        const touch = e.touches[0];
        let indices = [col];
        if (selectionState.selectionMode === "cols") {
            const allColRanges = selectionState.allColRanges;
            if (allColRanges.some(r => col >= r.start && col <= r.end)) {
                const colSet = new Set();
                for (const r of allColRanges)
                    for (let c = r.start; c <= r.end; c++) colSet.add(c);
                indices = [...colSet].sort((a, b) => a - b);
            }
        }
        resizing = { type: "col", index: col, startPos: touch.clientX, startSize: virtualizer.getColWidth(col), selectedIndices: indices };
        document.addEventListener("touchmove", handleResizeTouchMove, { passive: false });
        document.addEventListener("touchend", handleResizeTouchEnd);
        document.addEventListener("touchcancel", handleResizeTouchEnd);
    }

    function startRowResizeTouch(row, e) {
        const touch = e.touches[0];
        let indices = [row];
        if (selectionState.selectionMode === "rows") {
            const allRowRanges = selectionState.allRowRanges;
            if (allRowRanges.some(r => row >= r.start && row <= r.end)) {
                const rowSet = new Set();
                for (const r of allRowRanges)
                    for (let i = r.start; i <= r.end; i++) rowSet.add(i);
                indices = [...rowSet].sort((a, b) => a - b);
            }
        }
        resizing = { type: "row", index: row, startPos: touch.clientY, startSize: virtualizer.getRowHeight(row), selectedIndices: indices };
        document.addEventListener("touchmove", handleResizeTouchMove, { passive: false });
        document.addEventListener("touchend", handleResizeTouchEnd);
        document.addEventListener("touchcancel", handleResizeTouchEnd);
    }

    // ─── Freeze-handle drag ───────────────────────────────────────────────────

    /**
     * Snap a pixel offset to the nearest column boundary count.
     * Returns the number of columns to freeze (0 = unfreeze all).
     */
    function snapToColFreezeCount(contentX) {
        if (!virtualizer) return 0;
        if (contentX <= 0) return 0;
        const metrics = virtualizer.colMetrics;
        const total = virtualizer.colCount;
        let best = 0;
        let bestDist = contentX; // distance to boundary at offset 0
        for (let c = 1; c <= total; c++) {
            const offset = metrics.offsetOf(c);
            const dist = Math.abs(contentX - offset);
            if (dist < bestDist) { bestDist = dist; best = c; }
            if (offset > contentX + 80) break;
        }
        return best;
    }

    /**
     * Snap a pixel offset to the nearest row boundary count.
     */
    function snapToRowFreezeCount(contentY) {
        if (!virtualizer) return 0;
        if (contentY <= 0) return 0;
        const metrics = virtualizer.rowMetrics;
        const total = virtualizer.rowCount;
        let best = 0;
        let bestDist = contentY;
        for (let r = 1; r <= total; r++) {
            const offset = metrics.offsetOf(r);
            const dist = Math.abs(contentY - offset);
            if (dist < bestDist) { bestDist = dist; best = r; }
            if (offset > contentY + 80) break;
        }
        return best;
    }

    function startFreezeColDrag(e) {
        if (!virtualizer || !sheetStore || !containerEl) return;
        e.preventDefault();
        e.stopPropagation();
        freezeDrag = { axis: 'col', startClientX: e.clientX, startFrozenCount: virtualizer.frozenCols };

        function onMove(e) {
            if (!freezeDrag || !virtualizer || !containerEl) return;
            const rect = containerEl.getBoundingClientRect();
            const contentX = e.clientX - rect.left - HEADER_WIDTH;
            const newCount = snapToColFreezeCount(contentX);
            if (freezeDrag.currentCount !== newCount) {
                freezeDrag = { ...freezeDrag, currentCount: newCount };
                // Live preview via virtualizer (no Yjs write yet)
                virtualizer.setFrozenDimensions(virtualizer.frozenRows, newCount);
                renderScheduler?.invalidateAll();
            }
        }

        function onUp(e) {
            if (!sheetStore) return;
            const rect = containerEl?.getBoundingClientRect();
            if (rect) {
                const contentX = e.clientX - rect.left - HEADER_WIDTH;
                const newCount = snapToColFreezeCount(contentX);
                sheetStore.setFrozenColumns(newCount);
            }
            freezeDrag = null;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function startFreezeRowDrag(e) {
        if (!virtualizer || !sheetStore || !containerEl) return;
        e.preventDefault();
        e.stopPropagation();
        freezeDrag = { axis: 'row', startClientY: e.clientY, startFrozenCount: virtualizer.frozenRows };

        function onMove(e) {
            if (!freezeDrag || !virtualizer || !containerEl) return;
            const rect = containerEl.getBoundingClientRect();
            const contentY = e.clientY - rect.top - HEADER_HEIGHT;
            const newCount = snapToRowFreezeCount(contentY);
            if (freezeDrag.currentCount !== newCount) {
                freezeDrag = { ...freezeDrag, currentCount: newCount };
                virtualizer.setFrozenDimensions(newCount, virtualizer.frozenCols);
                renderScheduler?.invalidateAll();
            }
        }

        function onUp(e) {
            if (!sheetStore) return;
            const rect = containerEl?.getBoundingClientRect();
            if (rect) {
                const contentY = e.clientY - rect.top - HEADER_HEIGHT;
                const newCount = snapToRowFreezeCount(contentY);
                sheetStore.setFrozenRows(newCount);
            }
            freezeDrag = null;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
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
                    performScrollPaint(dx, dy, prevST, prevSL);
                } else {
                    performPaint(new Set(["body", "top", "left", "corner"]));
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
        } else {
            selectionState.selectionMode = 'range';
            selectionState.anchor = snapped;
            selectionState.focus = snapped;
        }
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

        // Space: toggle checkbox cells without starting an edit
        if (e.key === ' ' && anchor && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const spaceCt = renderContext?.getCellTypeConfig(anchor.row, anchor.col);
            if (spaceCt?.type === 'checkbox') {
                const spaceCellType = renderContext?.getCellType(anchor.row, anchor.col);
                if (spaceCellType === CELL_TYPE.TABLE_DATA) {
                    const info = renderContext?.tableManager?.getCellInfo(anchor.row, anchor.col);
                    if (info?.table && info.colDef) {
                        const cur = info.table.getValue(info.dataIndex, info.colDef.id);
                        info.table.updateCell(info.dataIndex, info.colDef.id, !cur);
                        untrack(() => renderScheduler?.invalidateAll());
                    }
                } else if (spaceCellType === CELL_TYPE.TABLE_ENTRY) {
                    const info = renderContext?.tableManager?.getCellInfo(anchor.row, anchor.col);
                    if (info?.table && info.colDef) {
                        const cur = info.table.entryBuffer?.[info.colDef.id];
                        info.table.setEntryValue(info.colDef.id, !cur);
                        untrack(() => renderScheduler?.invalidateAll());
                    }
                } else {
                    const cell = sheetStore?.getCell(anchor.row, anchor.col);
                    sheetStore?.setCellValue(anchor.row, anchor.col, !cell?.v);
                    untrack(() => renderScheduler?.invalidateAll());
                }
                e.preventDefault();
                return;
            }
        }

        // If dropdown overlay is open: Escape closes it, printable chars append to filter
        if (focusedDropdownCell) {
            if (e.key === 'Escape') {
                focusedDropdownCell = null;
                e.preventDefault();
                return;
            }
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                dropdownFilter += e.key;
                setTimeout(() => dropdownFilterInputEl?.focus(), 0);
                e.preventDefault();
                return;
            }
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
            // Block typing into table header cells
            if (anchorCellType === CELL_TYPE.TABLE_HEADER) {
                e.preventDefault();
                return;
            }
            // Block typing into table buffer zone (rows below last data row)
            if (renderContext?.tableManager?.isTableShadowCell(anchor.row, anchor.col)) {
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

            // For TABLE_DATA and TABLE_ENTRY cells, use beginCellEdit with typed character
            if (
                anchorCellType === CELL_TYPE.TABLE_DATA ||
                anchorCellType === CELL_TYPE.TABLE_ENTRY
            ) {
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
                        let targetCol = anchor.col;
                        if (
                            anchorCellType === CELL_TYPE.TABLE_ENTRY &&
                            info.colDef.isNonEntry
                        ) {
                            const firstEditable = info.table.columns.findIndex(
                                (c) => !c.isNonEntry,
                            );
                            if (firstEditable >= 0)
                                targetCol = info.table.startCol + firstEditable;
                        }
                        beginCellEdit(anchor.row, targetCol, {
                            seedText: e.key,
                            surface: "grid",
                        });
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
                focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) {
                    jumpToEdgeAndSelect(-1, 0, e.shiftKey);
                } else {
                    moveSelectionMergeAware(-1, 0, e.shiftKey);
                }
                e.shiftKey ? scrollToFocus() : scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowDown":
                focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) {
                    jumpToEdgeAndSelect(1, 0, e.shiftKey);
                } else {
                    moveSelectionMergeAware(1, 0, e.shiftKey);
                }
                e.shiftKey ? scrollToFocus() : scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowLeft":
                focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) {
                    jumpToEdgeAndSelect(0, -1, e.shiftKey);
                } else {
                    moveSelectionMergeAware(0, -1, e.shiftKey);
                }
                e.shiftKey ? scrollToFocus() : scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowRight":
                focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) {
                    jumpToEdgeAndSelect(0, 1, e.shiftKey);
                } else {
                    moveSelectionMergeAware(0, 1, e.shiftKey);
                }
                e.shiftKey ? scrollToFocus() : scrollToAnchor();
                e.preventDefault();
                break;
            case "Home": {
                focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+Home → jump to A1
                    if (e.shiftKey) {
                        selectionState.focus = { row: 0, col: 0 };
                        scrollToFocus();
                    } else {
                        selectionState.selectionMode = 'range';
                        selectionState.anchor = { row: 0, col: 0 };
                        selectionState.focus = { row: 0, col: 0 };
                        scrollToAnchor();
                    }
                } else {
                    // Home → beginning of row
                    const homeRow = e.shiftKey
                        ? (selectionState.focus?.row ?? selectionState.anchor?.row ?? 0)
                        : (selectionState.anchor?.row ?? 0);
                    if (e.shiftKey) {
                        selectionState.focus = { row: homeRow, col: 0 };
                        scrollToFocus();
                    } else {
                        selectionState.selectionMode = 'range';
                        selectionState.anchor = { row: homeRow, col: 0 };
                        selectionState.focus = { row: homeRow, col: 0 };
                        scrollToAnchor();
                    }
                }
                e.preventDefault();
                break;
            }
            case "End": {
                focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+End → last used cell (bottom-right of data)
                    let lastRow = 0, lastCol = 0;
                    sheetStore?.cells.forEach((_cell, key) => {
                        const [r, c] = key.split(',').map(Number);
                        if (r > lastRow) lastRow = r;
                        if (c > lastCol) lastCol = c;
                    });
                    const endDest = { row: lastRow, col: lastCol };
                    if (e.shiftKey) {
                        selectionState.focus = endDest;
                        scrollToFocus();
                    } else {
                        selectionState.selectionMode = 'range';
                        selectionState.anchor = endDest;
                        selectionState.focus = endDest;
                        scrollToAnchor();
                    }
                } else {
                    // End → last col of current row
                    const endRow = e.shiftKey
                        ? (selectionState.focus?.row ?? selectionState.anchor?.row ?? 0)
                        : (selectionState.anchor?.row ?? 0);
                    const endCol = colCount - 1;
                    if (e.shiftKey) {
                        selectionState.focus = { row: endRow, col: endCol };
                        scrollToFocus();
                    } else {
                        selectionState.selectionMode = 'range';
                        selectionState.anchor = { row: endRow, col: endCol };
                        selectionState.focus = { row: endRow, col: endCol };
                        scrollToAnchor();
                    }
                }
                e.preventDefault();
                break;
            }
            case "PageUp": {
                focusedDropdownCell = null;
                const pageRows = Math.max(1, Math.floor((virtualizer?.bodyViewportHeight ?? ROW_HEIGHT) / ROW_HEIGHT));
                if (e.shiftKey) {
                    selectionState.moveSelection(-pageRows, 0, true, rowCount, colCount);
                    scrollToFocus();
                } else {
                    selectionState.moveSelection(-pageRows, 0, false, rowCount, colCount);
                    scrollToAnchor();
                }
                e.preventDefault();
                break;
            }
            case "PageDown": {
                focusedDropdownCell = null;
                const pageRows = Math.max(1, Math.floor((virtualizer?.bodyViewportHeight ?? ROW_HEIGHT) / ROW_HEIGHT));
                if (e.shiftKey) {
                    selectionState.moveSelection(pageRows, 0, true, rowCount, colCount);
                    scrollToFocus();
                } else {
                    selectionState.moveSelection(pageRows, 0, false, rowCount, colCount);
                    scrollToAnchor();
                }
                e.preventDefault();
                break;
            }
            case "Tab":
                focusedDropdownCell = null;
                if (selectionState.hasTabSelection) {
                    e.shiftKey ? selectionState.tabPrev() : selectionState.tabNext();
                    scrollToPrimaryCell();
                } else {
                    moveSelectionMergeAware(0, e.shiftKey ? -1 : 1, false);
                    scrollToAnchor();
                }
                e.preventDefault();
                break;
            case "Enter":
                // Enter moves selection down, but opens editors for special cells.
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
                    if (anchorCellType === CELL_TYPE.TABLE_ENTRY) {
                        // Enter on entry row starts editing
                        beginCellEdit(anchor.row, anchor.col, {
                            surface: "grid",
                        });
                    } else if (anchorCellType !== CELL_TYPE.TABLE_HEADER) {
                        moveSelectionMergeAware(1, 0, false);
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
                    if (f2CellType !== CELL_TYPE.TABLE_HEADER) {
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
            case "p":
                if (e.ctrlKey || e.metaKey) {
                    document.dispatchEvent(new CustomEvent('openPdfExport'));
                    e.preventDefault();
                }
                break;
            case "c":
                if ((e.ctrlKey || e.metaKey) && selection) {
                    copySelection();
                    // Don't preventDefault — browser fires a native copy event which
                    // handleCopy() intercepts to write all MIME formats synchronously.
                }
                break;
            case "x":
                if ((e.ctrlKey || e.metaKey) && selection) {
                    cutSelection();
                    // Don't preventDefault — browser fires a native cut event which
                    // handleCut() intercepts to write all MIME formats synchronously.
                }
                break;
            case "v":
                if ((e.ctrlKey || e.metaKey) && selection) {
                    // Set pending paste mode — don't preventDefault so the browser
                    // fires a native paste event, giving us access to all MIME types
                    // (including Google Sheets' compact JSON) via e.clipboardData
                    clipboardManager._pendingPasteMode = e.shiftKey ? "values" : "full";
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
    function clearSelection() {
        if (!sheetStore) return;
        const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
        if (ranges.length === 0) return;

        // Handle table cells in the ranges (sparse map misses these)
        let tableCleared = false;
        for (const eff of ranges) {
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (ct !== CELL_TYPE.TABLE_DATA && ct !== CELL_TYPE.TABLE_ENTRY) continue;
                    const info = renderContext?.tableManager?.getCellInfo(r, c);
                    if (!info?.table || !info.colDef || info.colDef.isNonEntry) continue;
                    if (ct === CELL_TYPE.TABLE_ENTRY) {
                        info.table.setEntryValue(info.colDef.id, null);
                    } else {
                        info.table.updateCell(info.dataIndex, info.colDef.id, null);
                    }
                    tableCleared = true;
                }
            }
        }
        if (tableCleared) untrack(() => renderScheduler?.invalidateAll());

        // Iterate only regular cells that actually exist (sparse map)
        sheetStore.cells.forEach((_cell, key) => {
            const [r, c] = key.split(",").map(Number);
            if (!ranges.some(eff => r >= eff.startRow && r <= eff.endRow && c >= eff.startCol && c <= eff.endCol)) return;
            // Skip table/repeater/viewport cells (handled above)
            const ct = renderContext?.getCellType(r, c);
            if (
                ct === CELL_TYPE.TABLE_HEADER ||
                ct === CELL_TYPE.TABLE_ENTRY ||
                ct === CELL_TYPE.TABLE_DATA ||
                ct === CELL_TYPE.VIEWPORT_OCCUPIED
            )
                return;
            // Delete blob files when clearing file or image cells
            const ctConfig = sheetStore.getCellTypeConfig(r, c);
            if (ctConfig?.type === "file" || ctConfig?.type === "image") {
                const blobId = sheetStore.getCell(r, c)?.v;
                if (blobId) {
                    storage.app.delete(blobId).catch(() => {});
                }
            }
            sheetStore.clearCellValue(r, c);
        });
    }

    // ─── Dropdown range resolver ──────────────────────────────────────────────
    function resolveRangeOptions(rangeStr) {
        if (!sheetStore) return [];

        // Parse optional cross-sheet prefix: 'Sheet Name'!A1:A10 or SheetName!A1:A10
        let targetSheetId = null;
        let cellRange = rangeStr.trim();
        const sheetRefMatch = cellRange.match(/^(?:'((?:[^']|'')*)'|([^'!][^!]*?))!(.+)$/);
        if (sheetRefMatch) {
            const sheetName = (sheetRefMatch[1] ?? sheetRefMatch[2]).replace(/''/g, "'");
            cellRange = sheetRefMatch[3];
            const entry = spreadsheetSession.sheets.find(s => s.name === sheetName);
            if (entry) targetSheetId = entry.id;
        }

        const parts = cellRange.trim().toUpperCase().split(":");
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
        if (!targetSheetId || targetSheetId === spreadsheetSession.activeSheetId) {
            // Current sheet — use computed display values
            for (let r = start.row; r <= end.row; r++) {
                for (let c = start.col; c <= end.col; c++) {
                    const v = spreadsheetSession.getCellDisplayValue(r, c);
                    if (v != null && v !== "") opts.push(String(v));
                }
            }
        } else {
            // Another sheet — use a temporary FormulaEngine so spill/IMPORTRANGE values are visible
            const values = spreadsheetSession.computeSheetRange(
                targetSheetId, start.row, start.col, end.row, end.col
            );
            for (const v of values) {
                if (v != null && v !== "" && !(v instanceof Object)) opts.push(String(v));
            }
        }
        return opts;
    }

    function resolveTableColumnOptions(tableName, columnId) {
        const t = renderContext?.tableManager?.getTableByName(tableName);
        if (t) {
            return t.getColumn(t.resolveColId(String(columnId)))
                .filter(v => v != null && v !== "")
                .map(String);
        }
        // Table is on a different sheet — read raw Yjs values via the session
        return spreadsheetSession.getTableColumnValues(tableName, columnId);
    }

    // ─── Fill Down / Right ────────────────────────────────────────────────────
    function fillDown() {
        if (!sheetStore) return;
        const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                if (eff.startRow === eff.endRow) continue;
                sheetStore.fillDown(eff.startRow, eff.startCol, eff.endRow, eff.endCol);
            }
        });
    }

    function fillRight() {
        if (!sheetStore) return;
        const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                if (eff.startCol === eff.endCol) continue;
                sheetStore.fillRight(eff.startRow, eff.startCol, eff.endRow, eff.endCol);
            }
        });
    }

    // ─── Apply cell type to selection ─────────────────────────────────────────
    function applyTypeToSelection(type, extraOptions = {}) {
        if (!sheetStore) return;
        const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
        if (ranges.length === 0) return;
        const config = { type, ...extraOptions };
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                for (let r = eff.startRow; r <= eff.endRow; r++) {
                    for (let c = eff.startCol; c <= eff.endCol; c++) {
                        const ct = renderContext?.getCellType(r, c);
                        if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_DATA ||
                            ct === CELL_TYPE.TABLE_ENTRY) continue;
                        sheetStore.setCellTypeConfig(r, c, config);
                    }
                }
            }
        });
    }

    // ─── Insert today's date ──────────────────────────────────────────────────
    function insertDate() {
        if (!anchor) return;
        const t = new Date();
        const mm = String(t.getMonth() + 1).padStart(2, "0");
        const dd = String(t.getDate()).padStart(2, "0");
        const yyyy = t.getFullYear();
        const displayStr = `${mm}/${dd}/${yyyy}`;

        // Table data cell: update via table store
        const cellType = renderContext?.getCellType(anchor.row, anchor.col);
        if (cellType === CELL_TYPE.TABLE_DATA || cellType === CELL_TYPE.TABLE_ENTRY) {
            const info = renderContext?.tableManager?.getCellInfo(
                anchor.row,
                anchor.col,
            );
            if (info?.table && info.colDef && !info.colDef.isNonEntry) {
                const colType = info.colDef.type;
                // For date columns store "YYYY-MM-DD"; for others store the display string
                const val =
                    colType === "date"
                        ? `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`
                        : displayStr;
                if (cellType === CELL_TYPE.TABLE_ENTRY) {
                    info.table.setEntryValue(info.colDef.id, val);
                } else {
                    info.table.updateCell(info.dataIndex, info.colDef.id, val);
                    untrack(() => renderScheduler?.invalidateAll());
                }
            }
            return;
        }

        // Regular sheet cell: parse through the cell's type descriptor
        if (!sheetStore) return;
        const ct = sheetStore.getCellTypeConfig(anchor.row, anchor.col);
        const parsedValue = CellTypeRegistry.parseInput(ct, displayStr);
        sheetStore.setCellValue(anchor.row, anchor.col, parsedValue);
    }

    // ─── Clear formatting ─────────────────────────────────────────────────────
    function clearFormatting() {
        if (!sheetStore) return;
        const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
        if (ranges.length === 0) return;

        for (const eff of ranges) {
            // Clear per-cell formatting for any table data cells in the range
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (ct !== CELL_TYPE.TABLE_DATA) continue;
                    const info = renderContext?.tableManager?.getCellInfo(r, c);
                    if (info?.table && info.colDef && info.dataIndex >= 0) {
                        info.table.clearCellFormatting(info.dataIndex, info.colDef.id);
                    }
                }
            }
            sheetStore.clearRangeFormatting(eff.startRow, eff.startCol, eff.endRow, eff.endCol);
        }
    }

    // ─── Row / Column insert / delete ─────────────────────────────────────────
    function insertRowAbove() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const count = eff.endRow - eff.startRow + 1;
        for (let i = 0; i < count; i++) sheetStore.insertRowAt(eff.startRow);
    }
    function insertRowBelow() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const count = eff.endRow - eff.startRow + 1;
        for (let i = 0; i < count; i++)
            sheetStore.insertRowAt(eff.endRow + 1 + i);
    }
    function insertColumnLeft() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const count = eff.endCol - eff.startCol + 1;
        for (let i = 0; i < count; i++) sheetStore.insertColumnAt(eff.startCol);
    }
    function insertColumnRight() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const count = eff.endCol - eff.startCol + 1;
        for (let i = 0; i < count; i++)
            sheetStore.insertColumnAt(eff.endCol + 1 + i);
    }

    function deleteSelectedRows() {
        if (!sheetStore) return;
        const mode = selectionState.selectionMode;
        // Collect all unique row indices across all selected ranges, then delete
        // highest-to-lowest so indices don't shift as rows are removed.
        const rows = new Set();
        if (mode === 'rows') {
            for (const r of selectionState.allRowRanges)
                for (let i = r.start; i <= r.end; i++) rows.add(i);
        } else {
            const eff = selectionState.effectiveRange(rowCount, colCount);
            if (!eff) return;
            for (let i = eff.startRow; i <= eff.endRow; i++) rows.add(i);
        }
        sheetStore.deleteRowsAt([...rows]);
    }
    function deleteSelectedColumns() {
        if (!sheetStore) return;
        const mode = selectionState.selectionMode;
        const cols = new Set();
        if (mode === 'cols') {
            for (const c of selectionState.allColRanges)
                for (let i = c.start; i <= c.end; i++) cols.add(i);
        } else {
            const eff = selectionState.effectiveRange(rowCount, colCount);
            if (!eff) return;
            for (let i = eff.startCol; i <= eff.endCol; i++) cols.add(i);
        }
        const sorted = [...cols].sort((a, b) => b - a);
        for (const col of sorted) sheetStore.deleteColumnAt(col);
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

    // Display indices of all table data rows covered by the current selection,
    // including all non-contiguous ranges in a multi-selection.
    let tableSelectedDataRows = $derived.by(() => {
        if (!tableCellInfo || tableCellInfo.rowType !== "data" || !spreadsheetSession.tableManager) return [];
        const table = tableCellInfo.table;
        const mode = selectionState.selectionMode;
        const indices = new Set();

        // Collect row spans to scan from all active ranges
        /** @type {{ startRow: number, endRow: number }[]} */
        const spans = [];
        if (mode === 'range') {
            for (const rng of selectionState.allRanges) spans.push(rng);
        } else if (mode === 'rows') {
            for (const r of selectionState.allRowRanges) spans.push({ startRow: r.start, endRow: r.end });
        } else {
            const eff = selectionState.effectiveRange(rowCount, colCount);
            if (eff) spans.push(eff);
        }

        for (const span of spans) {
            for (let r = span.startRow; r <= span.endRow; r++) {
                const info = spreadsheetSession.tableManager.getCellInfo(r, table.startCol);
                if (info?.table === table && info.rowType === "data") indices.add(info.dataIndex);
            }
        }
        return indices.size > 0 ? [...indices] : [tableCellInfo.dataIndex];
    });

    function tableInsertRow() {
        if (tableCellInfo?.rowType === "data")
            tableCellInfo.table.insertRow({});
    }
    function tableDeleteRow() {
        if (tableCellInfo?.rowType === "data")
            tableCellInfo.table.deleteRows(tableSelectedDataRows);
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

    // Row/col counts for context menu labels — sums across all selected ranges
    let effSelRowCount = $derived.by(() => {
        if (selectionState.selectionMode === "rows") {
            return selectionState.allRowRanges.reduce((n, r) => n + r.end - r.start + 1, 0) || 1;
        }
        if (selectionState.selectionMode === "all") return rowCount;
        // range mode: sum unique rows across all ranges
        const rows = new Set();
        for (const rng of selectionState.allRanges)
            for (let r = rng.startRow; r <= rng.endRow; r++) rows.add(r);
        return rows.size || (selection ? selection.endRow - selection.startRow + 1 : 1);
    });
    let effSelColCount = $derived.by(() => {
        if (selectionState.selectionMode === "cols") {
            return selectionState.allColRanges.reduce((n, c) => n + c.end - c.start + 1, 0) || 1;
        }
        if (selectionState.selectionMode === "all") return colCount;
        const cols = new Set();
        for (const rng of selectionState.allRanges)
            for (let c = rng.startCol; c <= rng.endCol; c++) cols.add(c);
        return cols.size || (selection ? selection.endCol - selection.startCol + 1 : 1);
    });

    let isHeaderSelection = $derived(
        selectionType === "row" || selectionType === "column",
    );

    let tableSelectionRowType = $derived.by(() => {
        if (!anchor) return null;
        const info = spreadsheetSession.renderContext?.tableManager?.getCellInfo(anchor.row, anchor.col);
        return (info?.rowType === 'entry' || info?.rowType === 'data') ? info.rowType : null;
    });

    function clearContents() {
        if (!sheetStore) return;
        const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
        if (ranges.length === 0) return;
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                for (let r = eff.startRow; r <= eff.endRow; r++) {
                    for (let c = eff.startCol; c <= eff.endCol; c++) {
                        sheetStore.clearCell(r, c);
                    }
                }
            }
        });
    }

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
            label: tableSelectionRowType === 'entry' ? "Paste Rows" : "Paste",
            icon: pasteIcon,
            isSvgIcon: true,
            shortcut: "Ctrl+V",
            action: () => pasteSelection("full"),
        },
        ...(!isHeaderSelection && !tableSelectionRowType
            ? [
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
              ]
            : []),
        {
            label: "Clear Contents",
            shortcut: "Del",
            action: clearContents,
            disabled: !hasAnySelection,
        },
        { divider: true },
        ...(!isHeaderSelection
            ? [
                  {
                      label: "Insert Image in Cell",
                      icon: "🖼",
                      action: () => {
                          if (anchor) {
                              sheetStore?.setCellTypeConfig(
                                  anchor.row,
                                  anchor.col,
                                  {
                                      type: "image",
                                      fit: "contain",
                                  },
                              );
                              beginCellEdit(anchor.row, anchor.col, {
                                  surface: "grid",
                              });
                          }
                      },
                      disabled: selectionType !== "cell",
                  },
                  {
                      label: "Attach File to Cell",
                      icon: "📎",
                      action: () => {
                          if (anchor) {
                              sheetStore?.setCellTypeConfig(
                                  anchor.row,
                                  anchor.col,
                                  {
                                      type: "file",
                                  },
                              );
                              beginCellEdit(anchor.row, anchor.col, {
                                  surface: "grid",
                              });
                          }
                      },
                      disabled: selectionType !== "cell",
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
                  ...(!tableCellInfo
                      ? [
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
                        ]
                      : []),
              ]
            : []),
        ...(!tableCellInfo
            ? selectionType === "row"
                ? [
                      {
                          label: `Insert ${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""} Above`,
                          icon: arrowUp,
                          isSvgIcon: true,
                          action: insertRowAbove,
                      },
                      {
                          label: `Insert ${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""} Below`,
                          icon: arrowDown,
                          isSvgIcon: true,
                          action: insertRowBelow,
                      },
                      { divider: true },
                      {
                          label: `Delete ${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""}`,
                          icon: trashIcon,
                          isSvgIcon: true,
                          action: deleteSelectedRows,
                      },
                  ]
                : selectionType === "column"
                  ? [
                        {
                            label: `Insert ${effSelColCount} Column${effSelColCount > 1 ? "s" : ""} Left`,
                            icon: arrowLeft,
                            isSvgIcon: true,
                            action: insertColumnLeft,
                        },
                        {
                            label: `Insert ${effSelColCount} Column${effSelColCount > 1 ? "s" : ""} Right`,
                            icon: arrowRight,
                            isSvgIcon: true,
                            action: insertColumnRight,
                        },
                        { divider: true },
                        {
                            label: `Delete ${effSelColCount} Column${effSelColCount > 1 ? "s" : ""}`,
                            icon: trashIcon,
                            isSvgIcon: true,
                            action: deleteSelectedColumns,
                        },
                    ]
                  : [
                        {
                            label: "Insert...",
                            submenu: [
                                {
                                    label: "Row Above",
                                    icon: arrowUp,
                                    isSvgIcon: true,
                                    action: insertRowAbove,
                                },
                                {
                                    label: "Row Below",
                                    icon: arrowDown,
                                    isSvgIcon: true,
                                    action: insertRowBelow,
                                },
                                { divider: true },
                                {
                                    label: "Column Left",
                                    icon: arrowLeft,
                                    isSvgIcon: true,
                                    action: insertColumnLeft,
                                },
                                {
                                    label: "Column Right",
                                    icon: arrowRight,
                                    isSvgIcon: true,
                                    action: insertColumnRight,
                                },
                            ],
                            disabled: !hasAnySelection,
                        },
                        {
                            label: "Delete...",
                            submenu: [
                                {
                                    label: selectionType === "all"
                                        ? `${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""}`
                                        : "Row",
                                    icon: trashIcon,
                                    isSvgIcon: true,
                                    action: deleteSelectedRows,
                                },
                                {
                                    label: selectionType === "all"
                                        ? `${effSelColCount} Column${effSelColCount > 1 ? "s" : ""}`
                                        : "Column",
                                    icon: trashIcon,
                                    isSvgIcon: true,
                                    action: deleteSelectedColumns,
                                },
                            ],
                            disabled: !hasAnySelection,
                        },
                    ]
            : []),
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
                                label: tableSelectedDataRows.length > 1
                                    ? `Delete ${tableSelectedDataRows.length} Rows`
                                    : "Delete This Row",
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
                                label: "Sort Ascending",
                                action: tableSortAsc,
                                icon: tableCellInfo.table.sortColId === tableCellInfo.colDef.id && tableCellInfo.table.sortDir === "asc" ? "▲" : "△",
                            },
                            {
                                label: "Sort Descending",
                                action: tableSortDesc,
                                icon: tableCellInfo.table.sortColId === tableCellInfo.colDef.id && tableCellInfo.table.sortDir === "desc" ? "▼" : "▽",
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
                                    if (tableCellInfo?.colDef) {
                                        onShowTablesPanel?.(tableCellInfo.table.id, tableCellInfo.colDef.id);
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
                              onShowTablesPanel?.(tableCellInfo.table.id);
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
        _stopStorageFilesWatch?.();
        window.removeEventListener("image-fit-change", handleImageFitChange);
        window.removeEventListener("file-meta-change", handleFileMetaChange);
        window.removeEventListener("show-file-viewer", handleShowFileViewer);
    });
</script>

<svelte:window onkeydown={handleKeydown} oncopy={handleCopy} oncut={handleCut} onpaste={handlePaste} />

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
                    onColHeaderContextMenu={handleColHeaderContextMenu}
                    onStartColResize={startColResize}
                    onStartColResizeTouch={startColResizeTouch}
                    onStartFreezeColDrag={startFreezeColDrag}
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
                    onStartRowResize={startRowResize}
                    onStartRowResizeTouch={startRowResizeTouch}
                    onStartFreezeRowDrag={startFreezeRowDrag}
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
                    onmousedown={handleFillHandleMouseDown}
                ></div>
            {/if}

            <!-- Fill preview border (shown while dragging fill handle) -->
            {#if fillHandleDrag?.fillRange && virtualizer}
                {@const fr = fillHandleDrag.fillRange}
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
                        activeEditPanel =
                            activeEditPanel?.store === rep
                                ? null
                                : { type: "repeater", store: rep };
                    }}
                    title="Repeater settings: {rep.name}"
                    aria-label="Repeater settings">↻</button
                >
            {/each}

            <!-- Table settings buttons (no outline — tables look like regular cells) -->
            {#each allTableOutlines as { table: tbl }}
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
                        onShowTablesPanel?.(tbl.id);
                    }}
                    title="Table settings: {tbl.name}"
                    aria-label="Table settings">⊞</button
                >
            {/each}

            <!-- Edit panel (repeater settings) -->
            {#if activeEditPanel && editPanelPosition}
                <div
                    class="edit-panel-anchor"
                    bind:this={editPanelEl}
                    style="left:{editPanelPosition.x}px; top:{editPanelPosition.y}px;"
                >
                    {#if activeEditPanel.type === "repeater"}
                        <RepeaterEditPanel
                            repeater={activeEditPanel.store}
                            repeaterEngine={spreadsheetSession.repeaterEngine}
                            onClose={() => (activeEditPanel = null)}
                        />
                    {/if}
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
                    style={dropdownOverlayStyle}
                >
                    <input
                        class="dropdown-filter-input"
                        type="text"
                        placeholder="Search..."
                        bind:value={dropdownFilter}
                        bind:this={dropdownFilterInputEl}
                        autofocus
                        onkeydown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                if (filteredOpts.length > 0) {
                                    if (focusedDropdownCell.onCommit) {
                                        focusedDropdownCell.onCommit(filteredOpts[0]);
                                    } else {
                                        sheetStore?.setCellValue(focusedDropdownCell.row, focusedDropdownCell.col, filteredOpts[0]);
                                    }
                                    focusedDropdownCell = null;
                                }
                            } else if (e.key === "Tab") {
                                e.preventDefault();
                                if (filteredOpts.length > 0) {
                                    if (focusedDropdownCell.onCommit) {
                                        focusedDropdownCell.onCommit(filteredOpts[0]);
                                    } else {
                                        sheetStore?.setCellValue(focusedDropdownCell.row, focusedDropdownCell.col, filteredOpts[0]);
                                    }
                                }
                                focusedDropdownCell = null;
                                moveSelectionMergeAware(0, e.shiftKey ? -1 : 1, false);
                                scrollToAnchor();
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
                                if (focusedDropdownCell.onCommit) {
                                    focusedDropdownCell.onCommit(opt);
                                } else {
                                    sheetStore?.setCellValue(focusedDropdownCell.row, focusedDropdownCell.col, opt);
                                }
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

<!-- Context menu (portalled) — desktop uses popup, mobile uses action bar -->
{#if contextMenuVisible}
    {#if mobileState.isMobile}
        <MobileCellActionBar
            rect={selectionHandleRect}
            containerEl={containerEl}
            tableInfo={tableCellInfo}
            onClose={closeContextMenu}
            onCopy={() => { clipboardManager.copy(); closeContextMenu(); }}
            onCut={() => { clipboardManager.cut(); closeContextMenu(); }}
            onPaste={() => { clipboardManager.paste(); closeContextMenu(); }}
            onClear={() => { clearSelection(); closeContextMenu(); }}
            onDeleteRow={() => {
                tableDeleteRow();
                closeContextMenu();
            }}
        />
    {:else}
        <ContextMenu
            x={contextMenuPosition.x}
            y={contextMenuPosition.y}
            items={contextMenuItems}
            onClose={closeContextMenu}
        />
    {/if}
{/if}

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
        contain: layout style;
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
