import { untrack } from "svelte";
import {
    spreadsheetSession,
    selectionState,
    HEADER_WIDTH,
    HEADER_HEIGHT,
} from "../../../stores/spreadsheetStore.svelte.js";
import { editSessionState } from "../../../stores/spreadsheet/index.js";
import { CanvasRenderer } from "../../../stores/spreadsheet/rendering/CanvasRenderer.js";
import { SelectionRenderer } from "../../../stores/spreadsheet/rendering/SelectionRenderer.js";
import { RenderScheduler } from "../../../stores/spreadsheet/rendering/RenderScheduler.js";
import { buildPaneData } from "../../../stores/spreadsheet/rendering/CellPaintData.js";
import { PaintInvalidator } from "../../../stores/spreadsheet/rendering/PaintInvalidator.js";
import { perfMon } from "../../../stores/spreadsheet/perf/PerfMonitor.js";

/**
 * Owns all canvas rendering: setup/resize effects, data/selection repaint
 * triggers, and the paint functions (performPaint, performScrollPaint,
 * performSelectionPaint).
 *
 * Grid.svelte creates one instance and keeps the input fields up-to-date via
 * `$effect(() => { paintCoord.X = X; })`.
 *
 * `renderScheduler` and `selectionScheduler` are `$state` so that Grid.svelte
 * can derive local references:
 *   let renderScheduler = $derived(paintCoord.renderScheduler);
 * This lets all existing `renderScheduler?.invalidateAll()` call sites remain
 * unchanged while the scheduler is actually owned here.
 */
export class GridPaintCoordinator {
    // ─── Inputs (set by Grid.svelte) ─────────────────────────────────────────
    canvasEl = $state(null);
    selectCanvasEl = $state(null);
    virtualizer = $state(null);
    renderPlan = $state(null);
    renderContext = $state(null);
    sheetStore = $state(null);
    showGridlines = $state(true);
    showFormulas = $state(false);
    tableGripHoverRow = $state(-1);
    tableRowDrag = $state(null);

    // ─── Outputs (read by Grid.svelte) ───────────────────────────────────────
    renderScheduler = $state(null);
    selectionScheduler = $state(null);
    canvasRenderer = $state(null);
    selectionRenderer = $state(null);

    // ─── Internal ─────────────────────────────────────────────────────────────
    paintInvalidator = new PaintInvalidator();
    #rendererCanvasEl = null;
    #selRendererCanvasEl = null;
    #hasLoggedZeroViewportWarning = false;

    constructor() {
        // ── Data canvas setup & resize ─────────────────────────────────────────
        $effect(() => {
            const _sheet = this.sheetStore;
            const canvasEl = this.canvasEl;
            const virtualizer = this.virtualizer;
            if (!canvasEl || !virtualizer) return;

            const w = Math.max(0, virtualizer.containerWidth - HEADER_WIDTH);
            const h = Math.max(0, virtualizer.containerHeight - HEADER_HEIGHT);
            if (w <= 0 || h <= 0) return;

            if (!this.canvasRenderer || this.#rendererCanvasEl !== canvasEl) {
                this.canvasRenderer?.destroy();
                this.renderScheduler?.destroy();
                this.canvasRenderer = new CanvasRenderer(canvasEl);
                this.renderScheduler = new RenderScheduler((dirtyPanes) => this.performPaint(dirtyPanes));
                this.#rendererCanvasEl = canvasEl;
                spreadsheetSession.requestGridRepaint = () =>
                    untrack(() => this.renderScheduler?.invalidateAll());
                this.paintInvalidator.on('data',        () => this.renderScheduler?.invalidateAll());
                this.paintInvalidator.on('viewOptions', () => this.renderScheduler?.invalidateAll());
            }

            this.canvasRenderer.resize(w, h);
            untrack(() => {
                this.renderScheduler?.invalidateAll();
                this.renderScheduler?.flush();
            });
        });

        // ── Selection canvas setup & resize ───────────────────────────────────
        $effect(() => {
            const _sheet = this.sheetStore;
            const selectCanvasEl = this.selectCanvasEl;
            const virtualizer = this.virtualizer;
            if (!selectCanvasEl || !virtualizer) return;

            const w = Math.max(0, virtualizer.containerWidth - HEADER_WIDTH);
            const h = Math.max(0, virtualizer.containerHeight - HEADER_HEIGHT);
            if (w <= 0 || h <= 0) return;

            if (!this.selectionRenderer || this.#selRendererCanvasEl !== selectCanvasEl) {
                this.selectionRenderer?.destroy();
                this.selectionScheduler?.destroy();
                this.selectionRenderer = new SelectionRenderer(selectCanvasEl);
                this.selectionScheduler = new RenderScheduler(() => this.performSelectionPaint());
                this.#selRendererCanvasEl = selectCanvasEl;
                this.paintInvalidator.on('selection', () => this.selectionScheduler?.invalidateAll());
            }

            this.selectionRenderer.resize(w, h);
            untrack(() => {
                this.selectionScheduler?.invalidateAll();
                this.selectionScheduler?.flush();
            });
        });

        // ── Data change repaint trigger ────────────────────────────────────────
        $effect(() => {
            const _cellsVer    = this.sheetStore?.cellsVersion;
            const _borders     = this.sheetStore?.bordersVersion;
            const _rowMetaVer  = this.sheetStore?.rowMetaVersion;
            const _colMetaVer  = this.sheetStore?.colMetaVersion;
            const _cfVer       = this.sheetStore?.cfVersion;
            const _mergeVer    = this.renderContext?.mergeEngine?.version;
            const _tableVer    = this.renderContext?.tableManager?.tableVersion;
            const _repVer      = this.renderContext?.repeaterEngine?.repeaterVersion;
            const _fr          = this.virtualizer?.frozenRows;
            const _fc          = this.virtualizer?.frozenCols;
            const _formulaVer  = spreadsheetSession?.formulaEngine?.computedVersion;

            untrack(() => {
                if (!this.renderScheduler || !this.renderPlan || !this.virtualizer) return;
                this.paintInvalidator.emit('data');
            });
        });

        // ── View option change repaint ─────────────────────────────────────────
        $effect(() => {
            const _gl = this.showGridlines;
            const _sf = this.showFormulas;
            untrack(() => this.paintInvalidator.emit('viewOptions'));
        });

        // ── Selection canvas repaint trigger ──────────────────────────────────
        $effect(() => {
            const _sel     = selectionState.range;
            const _selMode = selectionState.selectionMode;
            const _selRows = selectionState.selectedRows;
            const _selCols = selectionState.selectedCols;
            const _anch    = selectionState.anchor;
            const _editing = editSessionState.isEditing;
            const _formula = editSessionState.draft;
            const _fr      = this.virtualizer?.frozenRows;
            const _fc      = this.virtualizer?.frozenCols;

            untrack(() => {
                if (!this.selectionScheduler || !this.renderPlan || !this.virtualizer) return;
                this.paintInvalidator.emit('selection');
            });
        });

        // ── Warn on zero viewport ──────────────────────────────────────────────
        $effect(() => {
            const virtualizer = this.virtualizer;
            const renderPlan = this.renderPlan;
            if (!virtualizer || !renderPlan) return;
            const zeroH = renderPlan.bodyViewportHeight <= 0;
            if (zeroH && !this.#hasLoggedZeroViewportWarning) {
                console.warn("[Grid] body viewport height is 0");
                this.#hasLoggedZeroViewportWarning = true;
            } else if (!zeroH) {
                this.#hasLoggedZeroViewportWarning = false;
            }
        });
    }

    destroy() {
        this.renderScheduler?.destroy();
        this.selectionScheduler?.destroy();
        this.canvasRenderer?.destroy();
        this.selectionRenderer?.destroy();
        this.paintInvalidator.destroy();
    }

    // ─── Timed buildPaneData wrapper ─────────────────────────────────────────

    #buildPaneDataTimed(params) {
        if (!perfMon.enabled) return buildPaneData(params);
        const t = performance.now();
        const result = buildPaneData(params);
        perfMon.record('render.buildPaneData', performance.now() - t);
        perfMon.record('render.buildPaneCells', result.length);
        return result;
    }

    // ─── Paint function ───────────────────────────────────────────────────────

    performPaint(dirtyPanes = new Set(["body", "top", "left", "corner"])) {
        const { canvasEl, canvasRenderer, renderPlan, virtualizer, renderContext, sheetStore } = this;
        if (!canvasEl || !canvasRenderer || !renderPlan || !virtualizer) return;

        const frozenRows = virtualizer.frozenRows;
        const frozenCols = virtualizer.frozenCols;
        const frozenHeight = renderPlan.frozenHeight;
        const frozenWidth = renderPlan.frozenWidth;
        const bodyW = renderPlan.bodyViewportWidth;
        const bodyH = renderPlan.bodyViewportHeight;
        const scrollLeft = virtualizer.scrollLeft;
        const scrollTop = virtualizer.scrollTop;
        const showGridlines = this.showGridlines;
        const showFormulas = this.showFormulas;

        const commonParams = {
            rowMetrics: virtualizer.rowMetrics,
            colMetrics: virtualizer.colMetrics,
            renderContext,
            sheetStore,
            session: spreadsheetSession,
            frozenRows, frozenCols, frozenHeight, frozenWidth,
            showFormulas,
        };

        const isFullRepaint = dirtyPanes.size === 4;
        if (isFullRepaint) canvasRenderer.clear();

        if (dirtyPanes.has("body")) {
            const bp = renderPlan.plans.body;
            if (!isFullRepaint) canvasRenderer.clearPane(frozenWidth, frozenHeight, bodyW, bodyH);
            if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    this.#buildPaneDataTimed({ ...commonParams, rowRange: bp.rowRange, colRange: bp.colRange, scrollLeft, scrollTop }),
                    { clipX: frozenWidth, clipY: frozenHeight, clipW: bodyW, clipH: bodyH, showGridLines: showGridlines },
                );
            }
        }
        if (dirtyPanes.has("top")) {
            const tp = renderPlan.plans.top;
            if (!isFullRepaint) canvasRenderer.clearPane(frozenWidth, 0, bodyW, frozenHeight);
            if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    this.#buildPaneDataTimed({ ...commonParams, rowRange: tp.rowRange, colRange: tp.colRange, scrollLeft, scrollTop: 0 }),
                    { clipX: frozenWidth, clipY: 0, clipW: bodyW, clipH: frozenHeight, showGridLines: showGridlines },
                );
            }
        }
        if (dirtyPanes.has("left")) {
            const lp = renderPlan.plans.left;
            if (!isFullRepaint) canvasRenderer.clearPane(0, frozenHeight, frozenWidth, bodyH);
            if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    this.#buildPaneDataTimed({ ...commonParams, rowRange: lp.rowRange, colRange: lp.colRange, scrollLeft: 0, scrollTop }),
                    { clipX: 0, clipY: frozenHeight, clipW: frozenWidth, clipH: bodyH, showGridLines: showGridlines },
                );
            }
        }
        if (dirtyPanes.has("corner")) {
            const cp = renderPlan.plans.corner;
            if (!isFullRepaint) canvasRenderer.clearPane(0, 0, frozenWidth, frozenHeight);
            if (cp.rowRange.count > 0 && cp.colRange.count > 0) {
                canvasRenderer.paintPane(
                    this.#buildPaneDataTimed({ ...commonParams, rowRange: cp.rowRange, colRange: cp.colRange, scrollLeft: 0, scrollTop: 0 }),
                    { clipX: 0, clipY: 0, clipW: frozenWidth, clipH: frozenHeight, showGridLines: showGridlines },
                );
            }
        }

        if (dirtyPanes.has("top") || dirtyPanes.has("body") || isFullRepaint) {
            const stickyHeaders = renderContext?.getStickyTableHeaders?.(
                virtualizer.scrollTop, renderPlan.frozenHeight,
                virtualizer.rowMetrics, virtualizer.colMetrics,
            );
            if (stickyHeaders?.length > 0) {
                canvasRenderer.paintStickyHeaders(stickyHeaders, { frozenWidth, frozenHeight, scrollLeft });
            }
        }

    }

    // Grip icon dots — drawn on the SELECTION canvas so hover changes only trigger
    // performSelectionPaint (cheap, no buildPaneData) rather than a full data repaint.
    #paintTableGripIcons(scrollLeft, scrollTop, frozenHeight, bodyH) {
        const { selectCanvasEl, virtualizer, renderContext, tableGripHoverRow, tableRowDrag } = this;
        if (!selectCanvasEl || !virtualizer || !renderContext?.tableManager) return;
        const ctx = selectCanvasEl.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio ?? 1;
        ctx.save();
        ctx.scale(dpr, dpr);

        for (const table of renderContext.tableManager.stores.values()) {
            if (table.sortColId) continue;
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
                for (let r = 0; r < 3; r++)
                    for (let c = 0; c < 2; c++)
                        ctx.fillRect(Math.round(cx + c * 4 - 2), Math.round(cy + r * 4 - 4), 2, 2);
            }
        }
        ctx.restore();
    }

    // ─── Incremental scroll paint ─────────────────────────────────────────────

    performScrollPaint(dx, dy, prevST, prevSL) {
        const { canvasEl, canvasRenderer, renderPlan, virtualizer, renderContext, sheetStore } = this;
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

        const stickyHeaders = renderContext?.getStickyTableHeaders?.(
            scrollTop, frozenHeight, rowMetrics, colMetrics,
        ) ?? [];
        const prevStickyHeaders = dy < 0
            ? (renderContext?.getStickyTableHeaders?.(prevST, frozenHeight, rowMetrics, colMetrics) ?? [])
            : stickyHeaders;
        const stickyOverlayH = prevStickyHeaders.reduce(
            (m, h) => Math.max(m, h.headerHeightPx + (h.showEntry ? h.entryHeightPx : 0)), 0,
        );

        const rowStripRange = (fromOffset, toOffset) => {
            const s = Math.max(frozenRows, rowMetrics.indexAtOffset(fromOffset));
            const e = Math.min(virtualizer.rowCount - 1, rowMetrics.indexAtOffset(toOffset) + 1);
            return s <= e ? { start: s, end: e, count: e - s + 1 } : null;
        };

        const showGridlines = this.showGridlines;
        const bp = renderPlan.plans.body;

        canvasRenderer.blitScroll(dx, dy, frozenWidth, frozenHeight, bodyW, bodyH);

        if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
            if (dy !== 0) {
                let stripRows, clipY, clipH;
                if (dy > 0) {
                    stripRows = rowStripRange(frozenHeight + prevST + bodyH, frozenHeight + scrollTop + bodyH);
                    clipY = frozenHeight + bodyH - dy;
                    clipH = dy;
                } else {
                    stripRows = rowStripRange(frozenHeight + scrollTop, frozenHeight + prevST + stickyOverlayH);
                    clipY = frozenHeight;
                    clipH = Math.min(-dy + stickyOverlayH, bodyH);
                }
                if (stripRows) {
                    canvasRenderer.paintPane(
                        this.#buildPaneDataTimed({ ...commonParams, rowRange: stripRows, colRange: bp.colRange, scrollLeft, scrollTop }),
                        { clipX: frozenWidth, clipY, clipW: bodyW, clipH, showGridLines: showGridlines },
                    );
                }
            }
            if (dx !== 0) {
                const clipX = dx > 0 ? frozenWidth + bodyW - dx : frozenWidth;
                const clipW = Math.abs(dx);
                canvasRenderer.paintPane(
                    this.#buildPaneDataTimed({ ...commonParams, rowRange: bp.rowRange, colRange: bp.colRange, scrollLeft, scrollTop }),
                    { clipX, clipY: frozenHeight, clipW, clipH: bodyH, showGridLines: showGridlines },
                );
            }
        }

        if (dx !== 0) {
            const tp = renderPlan.plans.top;
            if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
                canvasRenderer.blitScroll(dx, 0, frozenWidth, 0, bodyW, frozenHeight);
                const clipX = dx > 0 ? frozenWidth + bodyW - dx : frozenWidth;
                const clipW = Math.abs(dx);
                canvasRenderer.paintPane(
                    this.#buildPaneDataTimed({ ...commonParams, rowRange: tp.rowRange, colRange: tp.colRange, scrollLeft, scrollTop: 0 }),
                    { clipX, clipY: 0, clipW, clipH: frozenHeight, showGridLines: showGridlines },
                );
            }
        }

        if (dy !== 0) {
            const lp = renderPlan.plans.left;
            if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
                canvasRenderer.blitScroll(0, dy, 0, frozenHeight, frozenWidth, bodyH);
                let stripRows, clipY, clipH;
                if (dy > 0) {
                    stripRows = rowStripRange(frozenHeight + prevST + bodyH, frozenHeight + scrollTop + bodyH);
                    clipY = frozenHeight + bodyH - dy;
                    clipH = dy;
                } else {
                    stripRows = rowStripRange(frozenHeight + scrollTop, frozenHeight + prevST);
                    clipY = frozenHeight;
                    clipH = -dy;
                }
                if (stripRows) {
                    canvasRenderer.paintPane(
                        this.#buildPaneDataTimed({ ...commonParams, rowRange: stripRows, colRange: lp.colRange, scrollLeft: 0, scrollTop }),
                        { clipX: 0, clipY, clipW: frozenWidth, clipH, showGridLines: showGridlines },
                    );
                }
            }
        }

        if (stickyHeaders.length > 0) {
            canvasRenderer.paintStickyHeaders(stickyHeaders, { frozenWidth, frozenHeight, scrollLeft });
        }
    }

    // ─── Selection canvas paint ───────────────────────────────────────────────

    performSelectionPaint() {
        const { selectCanvasEl, selectionRenderer, renderPlan, virtualizer, renderContext } = this;
        if (!selectCanvasEl || !selectionRenderer || !renderPlan || !virtualizer) return;

        const frozenRows = virtualizer.frozenRows;
        const frozenCols = virtualizer.frozenCols;
        const frozenHeight = renderPlan.frozenHeight;
        const frozenWidth = renderPlan.frozenWidth;
        const scrollLeft = virtualizer.scrollLeft;
        const scrollTop = virtualizer.scrollTop;
        const rowCount = this.sheetStore?.rowCount ?? 0;
        const colCount = this.sheetStore?.colCount ?? 0;

        const commonSelParams = {
            rowMetrics: virtualizer.rowMetrics,
            colMetrics: virtualizer.colMetrics,
            selectionState,
            formulaEditState: editSessionState,
            frozenRows, frozenCols, frozenHeight, frozenWidth,
            rowCount, colCount,
            mergeEngine: renderContext?.mergeEngine ?? null,
        };

        selectionRenderer.clear();

        const bp = renderPlan.plans.body;
        if (bp.rowRange.count > 0 && bp.colRange.count > 0) {
            selectionRenderer.paintSelectionPane({
                ...commonSelParams, rowRange: bp.rowRange, colRange: bp.colRange,
                scrollLeft, scrollTop,
                clipX: frozenWidth, clipY: frozenHeight,
                clipW: renderPlan.bodyViewportWidth, clipH: renderPlan.bodyViewportHeight,
            });
        }
        const tp = renderPlan.plans.top;
        if (tp.rowRange.count > 0 && tp.colRange.count > 0) {
            selectionRenderer.paintSelectionPane({
                ...commonSelParams, rowRange: tp.rowRange, colRange: tp.colRange,
                scrollLeft, scrollTop: 0,
                clipX: frozenWidth, clipY: 0,
                clipW: renderPlan.bodyViewportWidth, clipH: frozenHeight,
            });
        }
        const lp = renderPlan.plans.left;
        if (lp.rowRange.count > 0 && lp.colRange.count > 0) {
            selectionRenderer.paintSelectionPane({
                ...commonSelParams, rowRange: lp.rowRange, colRange: lp.colRange,
                scrollLeft: 0, scrollTop,
                clipX: 0, clipY: frozenHeight,
                clipW: frozenWidth, clipH: renderPlan.bodyViewportHeight,
            });
        }
        const cp = renderPlan.plans.corner;
        if (cp.rowRange.count > 0 && cp.colRange.count > 0) {
            selectionRenderer.paintSelectionPane({
                ...commonSelParams, rowRange: cp.rowRange, colRange: cp.colRange,
                scrollLeft: 0, scrollTop: 0,
                clipX: 0, clipY: 0,
                clipW: frozenWidth, clipH: frozenHeight,
            });
        }

        // Grip icons on top of selection fills — cheap, no buildPaneData needed.
        // Hover changes only trigger selectionScheduler, not the expensive data scheduler.
        this.#paintTableGripIcons(scrollLeft, scrollTop, frozenHeight, renderPlan.bodyViewportHeight);
    }
}
