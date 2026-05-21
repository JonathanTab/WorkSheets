import { selectionState, HEADER_WIDTH, HEADER_HEIGHT } from "../../../stores/spreadsheetStore.svelte.js";
import { MIN_COL_WIDTH, MIN_ROW_HEIGHT } from "../../../stores/spreadsheet/constants.js";

/**
 * Wraps a single pointer-down event (mouse or touch) and normalises its
 * move/end stream into a common (clientX, clientY) callback pair.
 * Automatically removes document listeners on end/cancel.
 */
class PointerAdapter {
    constructor(startEvent, onMove, onEnd) {
        if (startEvent.type.startsWith("touch")) {
            const touchMove = (e) => {
                if (e.touches.length !== 1) return;
                e.preventDefault();
                const t = e.touches[0];
                onMove(t.clientX, t.clientY);
            };
            const touchEnd = (e) => {
                cleanup();
                const t = e.changedTouches?.[0];
                if (t) onEnd(t.clientX, t.clientY);
            };
            const cleanup = () => {
                document.removeEventListener("touchmove", touchMove);
                document.removeEventListener("touchend", touchEnd);
                document.removeEventListener("touchcancel", touchEnd);
            };
            document.addEventListener("touchmove", touchMove, { passive: false });
            document.addEventListener("touchend", touchEnd);
            document.addEventListener("touchcancel", touchEnd);
        } else {
            const mouseMove = (e) => onMove(e.clientX, e.clientY);
            const mouseUp = (e) => {
                document.removeEventListener("mousemove", mouseMove);
                document.removeEventListener("mouseup", mouseUp);
                onEnd(e.clientX, e.clientY);
            };
            document.addEventListener("mousemove", mouseMove);
            document.addEventListener("mouseup", mouseUp);
        }
    }
}

/**
 * Handles all column/row resize and freeze-handle drag gestures for the grid.
 * Grid.svelte creates one instance and keeps `virtualizer`, `sheetStore`,
 * `containerEl`, and `renderScheduler` up-to-date via property assignment.
 * Public methods are arrow functions so they can be passed directly as event
 * handler props without losing `this`.
 */
export class GridResizeController {
    virtualizer = null;
    sheetStore = null;
    containerEl = null;
    renderScheduler = null;

    // ─── Helpers ──────────────────────────────────────────────────────────────

    _buildColIndices(col) {
        const selection = selectionState.range;
        if (selectionState.selectionMode === "cols") {
            const ranges = selectionState.allColRanges;
            if (ranges.some(r => col >= r.start && col <= r.end)) {
                const set = new Set();
                for (const r of ranges) for (let c = r.start; c <= r.end; c++) set.add(c);
                return [...set].sort((a, b) => a - b);
            }
        } else if (selection && col >= selection.startCol && col <= selection.endCol) {
            const out = [];
            for (let c = selection.startCol; c <= selection.endCol; c++) out.push(c);
            return out;
        }
        return [col];
    }

    _buildRowIndices(row) {
        const selection = selectionState.range;
        if (selectionState.selectionMode === "rows") {
            const ranges = selectionState.allRowRanges;
            if (ranges.some(r => row >= r.start && row <= r.end)) {
                const set = new Set();
                for (const r of ranges) for (let i = r.start; i <= r.end; i++) set.add(i);
                return [...set].sort((a, b) => a - b);
            }
        } else if (selection && row >= selection.startRow && row <= selection.endRow) {
            const out = [];
            for (let r = selection.startRow; r <= selection.endRow; r++) out.push(r);
            return out;
        }
        return [row];
    }

    _snapToColFreezeCount(contentX) {
        const v = this.virtualizer;
        if (!v || contentX <= 0) return 0;
        const metrics = v.colMetrics;
        const total = v.colCount;
        let best = 0, bestDist = contentX;
        for (let c = 1; c <= total; c++) {
            const offset = metrics.offsetOf(c);
            const dist = Math.abs(contentX - offset);
            if (dist < bestDist) { bestDist = dist; best = c; }
            if (offset > contentX + 80) break;
        }
        return best;
    }

    _snapToRowFreezeCount(contentY) {
        const v = this.virtualizer;
        if (!v || contentY <= 0) return 0;
        const metrics = v.rowMetrics;
        const total = v.rowCount;
        let best = 0, bestDist = contentY;
        for (let r = 1; r <= total; r++) {
            const offset = metrics.offsetOf(r);
            const dist = Math.abs(contentY - offset);
            if (dist < bestDist) { bestDist = dist; best = r; }
            if (offset > contentY + 80) break;
        }
        return best;
    }

    // ─── Column resize (mouse + touch unified) ────────────────────────────────

    startColResize = (col, e) => {
        const v = this.virtualizer;
        if (!v) return;
        if (!e.type.startsWith("touch")) { e.preventDefault(); e.stopPropagation(); }

        const indices = this._buildColIndices(col);
        const startSize = v.getColWidth(col);
        const startX = e.type.startsWith("touch") ? e.touches[0].clientX : e.clientX;

        new PointerAdapter(e,
            (clientX) => {
                const w = Math.max(MIN_COL_WIDTH, startSize + (clientX - startX));
                for (const idx of indices) v.setTempColWidth(idx, w);
            },
            () => {
                const finalWidth = v.getColWidth(col);
                for (const idx of indices) this.sheetStore?.setColWidth(idx, finalWidth);
                v.clearTempColWidths();
            }
        );
    };

    // Alias — ColHeaders passes touch start separately; both unify through startColResize.
    startColResizeTouch = (col, e) => this.startColResize(col, e);

    // ─── Row resize (mouse + touch unified) ───────────────────────────────────

    startRowResize = (row, e) => {
        const v = this.virtualizer;
        if (!v) return;
        if (!e.type.startsWith("touch")) { e.preventDefault(); e.stopPropagation(); }

        const indices = this._buildRowIndices(row);
        const startSize = v.getRowHeight(row);
        const startY = e.type.startsWith("touch") ? e.touches[0].clientY : e.clientY;

        new PointerAdapter(e,
            (_, clientY) => {
                const h = Math.max(MIN_ROW_HEIGHT, startSize + (clientY - startY));
                for (const idx of indices) v.setTempRowHeight(idx, h);
            },
            () => {
                const finalHeight = v.getRowHeight(row);
                for (const idx of indices) this.sheetStore?.setRowHeight(idx, finalHeight);
                v.clearTempRowHeights();
            }
        );
    };

    startRowResizeTouch = (row, e) => this.startRowResize(row, e);

    // ─── Freeze-handle drag (mouse only) ─────────────────────────────────────

    startFreezeColDrag = (e) => {
        const v = this.virtualizer;
        const ss = this.sheetStore;
        const el = this.containerEl;
        if (!v || !ss || !el) return;
        e.preventDefault();
        e.stopPropagation();

        let currentCount = v.frozenCols;

        new PointerAdapter(e,
            (clientX) => {
                const rect = el.getBoundingClientRect();
                const newCount = this._snapToColFreezeCount(clientX - rect.left - HEADER_WIDTH);
                if (newCount !== currentCount) {
                    currentCount = newCount;
                    v.setFrozenDimensions(v.frozenRows, newCount);
                    this.renderScheduler?.invalidateAll();
                }
            },
            (clientX) => {
                const rect = el.getBoundingClientRect();
                ss.setFrozenColumns(this._snapToColFreezeCount(clientX - rect.left - HEADER_WIDTH));
            }
        );
    };

    startFreezeRowDrag = (e) => {
        const v = this.virtualizer;
        const ss = this.sheetStore;
        const el = this.containerEl;
        if (!v || !ss || !el) return;
        e.preventDefault();
        e.stopPropagation();

        let currentCount = v.frozenRows;

        new PointerAdapter(e,
            (_, clientY) => {
                const rect = el.getBoundingClientRect();
                const newCount = this._snapToRowFreezeCount(clientY - rect.top - HEADER_HEIGHT);
                if (newCount !== currentCount) {
                    currentCount = newCount;
                    v.setFrozenDimensions(newCount, v.frozenCols);
                    this.renderScheduler?.invalidateAll();
                }
            },
            (_, clientY) => {
                const rect = el.getBoundingClientRect();
                ss.setFrozenRows(this._snapToRowFreezeCount(clientY - rect.top - HEADER_HEIGHT));
            }
        );
    };
}
