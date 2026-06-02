import { untrack } from "svelte";
import {
    spreadsheetSession,
    selectionState,
    ROW_HEIGHT,
} from "../../../stores/spreadsheetStore.svelte.js";
import {
    clipboardManager,
    editSessionState,
    CellTypeRegistry,
    colParseConfig,
} from "../../../stores/spreadsheet/index.js";
import { CELL_TYPE } from "../../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
import { clearFormatting as clearFormattingCmd } from "../../../stores/spreadsheet/formatCommands.js";
import storage from "../../../stores/storage.js";
import { YJS_ORIGIN } from "../../../stores/spreadsheet/yjsOrigins.js";

/**
 * Owns the grid keyboard handler and dropdown-overlay state.
 *
 * Grid.svelte creates one instance and keeps `ctx` up-to-date.  The
 * `focusedDropdownCell` and `dropdownFilter` fields are `$state` so the
 * template can read them reactively.
 *
 * ctx shape:
 *   virtualizer          — current virtualizer (may be null)
 *   renderScheduler      — for invalidateAll after clear
 *   beginCellEdit        — (row, col, opts) => void
 *   commitEditAndMove    — (dRow, dCol) => void
 *   cancelEdit           — () => void
 *   moveSelectionMergeAware — (dRow, dCol, extend) => void
 *   jumpToEdgeAndSelect  — (dRow, dCol, extend) => void
 *   scrollToAnchor       — () => void
 *   scrollToFocus        — () => void
 *   scrollToPrimaryCell  — () => void
 */
export class GridKeyboardController {
    ctx = null;

    // Dropdown overlay state — reactive so Grid.svelte template can bind to them
    focusedDropdownCell = $state(null);
    dropdownFilter = $state("");
    dropdownFilterInputEl = $state(null);

    // ─── Self-contained action helpers ───────────────────────────────────────

    _sheetStore() { return spreadsheetSession.activeSheetStore; }
    _rc()         { return spreadsheetSession.renderContext; }
    _anchor()     { return selectionState.anchor; }
    _rowCount()   { return this._sheetStore()?.rowCount ?? 0; }
    _colCount()   { return this._sheetStore()?.colCount ?? 0; }

    _copySelection() {
        const ss = this._sheetStore();
        if (ss) clipboardManager.copy(ss, spreadsheetSession);
    }

    _cutSelection() {
        const ss = this._sheetStore();
        if (ss && spreadsheetSession.ydoc)
            clipboardManager.cut(ss, spreadsheetSession, spreadsheetSession.ydoc);
    }

    _clearSelection() {
        const ss = this._sheetStore();
        if (!ss) return;
        const rc = this._rc();
        const ranges = selectionState.allEffectiveRanges(this._rowCount(), this._colCount());
        if (ranges.length === 0) return;

        // Batch every clear (table + sheet) into one Yjs transaction so the
        // UndoManager records a single user op and observers fire once.
        // Side-effect deletes (blob storage) stay outside the transact.
        let tableCleared = false;
        const blobsToDelete = [];

        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                for (let r = eff.startRow; r <= eff.endRow; r++) {
                    for (let c = eff.startCol; c <= eff.endCol; c++) {
                        const ct = rc?.getCellType(r, c);
                        if (ct !== CELL_TYPE.TABLE_DATA && ct !== CELL_TYPE.TABLE_ENTRY) continue;
                        const info = rc?.tableManager?.getCellInfo(r, c);
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

            ss.cells.forEach((_cell, key) => {
                const [r, c] = key.split(",").map(Number);
                if (!ranges.some(eff => r >= eff.startRow && r <= eff.endRow && c >= eff.startCol && c <= eff.endCol)) return;
                const ct = rc?.getCellType(r, c);
                if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY ||
                    ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.VIEWPORT_OCCUPIED) return;
                const ctConfig = ss.getCellTypeConfig(r, c);
                if (ctConfig?.type === "file" || ctConfig?.type === "image") {
                    const blobId = ss.getCell(r, c)?.v;
                    if (blobId) blobsToDelete.push(blobId);
                }
                ss.clearCellValue(r, c);
            });
        }, YJS_ORIGIN.UI);

        if (tableCleared) untrack(() => this.ctx?.renderScheduler?.invalidateAll());
        for (const blobId of blobsToDelete) storage.app.delete(blobId).catch(() => {});
    }

    _clearFormatting() {
        clearFormattingCmd(spreadsheetSession, selectionState);
    }

    _fillDown() {
        const ss = this._sheetStore();
        if (!ss) return;
        const ranges = selectionState.allEffectiveRanges(this._rowCount(), this._colCount());
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                if (eff.startRow === eff.endRow) continue;
                ss.fillDown(eff.startRow, eff.startCol, eff.endRow, eff.endCol);
            }
        }, YJS_ORIGIN.UI);
    }

    _fillRight() {
        const ss = this._sheetStore();
        if (!ss) return;
        const ranges = selectionState.allEffectiveRanges(this._rowCount(), this._colCount());
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                if (eff.startCol === eff.endCol) continue;
                ss.fillRight(eff.startRow, eff.startCol, eff.endRow, eff.endCol);
            }
        }, YJS_ORIGIN.UI);
    }

    _insertRowAbove() {
        if (!this._sheetStore()) return;
        const eff = selectionState.effectiveRange(this._rowCount(), this._colCount());
        if (!eff) return;
        // Route through SpreadsheetSession so selection shifts and table-aware
        // routing (refusing inside a table) apply.
        const count = eff.endRow - eff.startRow + 1;
        for (let i = 0; i < count; i++) spreadsheetSession.insertRowAt(eff.startRow);
    }

    _insertColumnLeft() {
        if (!this._sheetStore()) return;
        const eff = selectionState.effectiveRange(this._rowCount(), this._colCount());
        if (!eff) return;
        const count = eff.endCol - eff.startCol + 1;
        for (let i = 0; i < count; i++) spreadsheetSession.insertColumnAt(eff.startCol);
    }

    _deleteSelectedRows() {
        if (!this._sheetStore()) return;
        const mode = selectionState.selectionMode;
        const rows = new Set();
        if (mode === 'rows') {
            for (const r of selectionState.allRowRanges)
                for (let i = r.start; i <= r.end; i++) rows.add(i);
        } else {
            const eff = selectionState.effectiveRange(this._rowCount(), this._colCount());
            if (!eff) return;
            for (let i = eff.startRow; i <= eff.endRow; i++) rows.add(i);
        }
        spreadsheetSession.deleteRowsAt([...rows]);
    }

    _deleteSelectedColumns() {
        if (!this._sheetStore()) return;
        const mode = selectionState.selectionMode;
        const cols = new Set();
        if (mode === 'cols') {
            for (const c of selectionState.allColRanges)
                for (let i = c.start; i <= c.end; i++) cols.add(i);
        } else {
            const eff = selectionState.effectiveRange(this._rowCount(), this._colCount());
            if (!eff) return;
            for (let i = eff.startCol; i <= eff.endCol; i++) cols.add(i);
        }
        // Descending so each delete's at-index is valid in the pre-delete coord
        // space at the time it runs.
        const sorted = [...cols].sort((a, b) => b - a);
        for (const col of sorted) spreadsheetSession.deleteColumnAt(col);
    }

    _applyTypeToSelection(type, extraOptions = {}) {
        const ss = this._sheetStore();
        if (!ss) return;
        const rc = this._rc();
        const ranges = selectionState.allEffectiveRanges(this._rowCount(), this._colCount());
        if (ranges.length === 0) return;
        const config = { type, ...extraOptions };
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                for (let r = eff.startRow; r <= eff.endRow; r++) {
                    for (let c = eff.startCol; c <= eff.endCol; c++) {
                        const ct = rc?.getCellType(r, c);
                        if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_DATA ||
                            ct === CELL_TYPE.TABLE_ENTRY) continue;
                        ss.setCellTypeConfig(r, c, config);
                    }
                }
            }
        }, YJS_ORIGIN.UI);
    }

    _setCellOrTableValue(value) {
        const ss = this._sheetStore();
        const anchor = this._anchor();
        const rc = this._rc();
        if (!ss || !anchor) return;
        const ct = rc?.getCellType(anchor.row, anchor.col);
        if (ct === CELL_TYPE.TABLE_ENTRY || ct === CELL_TYPE.TABLE_DATA) {
            const info = rc?.tableManager?.getCellInfo(anchor.row, anchor.col);
            if (info?.table && info.colDef && !info.colDef.isNonEntry) {
                const parsed = CellTypeRegistry.parseInput(colParseConfig(info.colDef), value);
                if (ct === CELL_TYPE.TABLE_ENTRY) {
                    info.table.setEntryValue(info.colDef.id, parsed);
                } else {
                    info.table.updateCell(info.dataIndex, info.colDef.id, parsed);
                    spreadsheetSession.formulaEngine?.cellValueChanged(anchor.row, anchor.col);
                    spreadsheetSession.formulaEngine?.recalculateDirty();
                }
                // The entry buffer / table data aren't reactive paint inputs — the
                // canvas only repaints on explicit invalidation, so request one
                // here (otherwise the inserted value stays invisible until the
                // next edit elsewhere triggers a repaint).
                untrack(() => this.ctx?.renderScheduler?.invalidateAll());
                return;
            }
        }
        ss.setCellValue(anchor.row, anchor.col, value);
    }

    _insertDate() {
        const today = new Date();
        const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        this._setCellOrTableValue(iso);
    }

    _insertTime() {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        this._setCellOrTableValue(timeStr);
    }

    // ─── Main handler ─────────────────────────────────────────────────────────

    handleKeydown = (e) => {
        const ctx = this.ctx;
        if (!ctx) return;

        const target = /** @type {HTMLElement} */ (e.target);
        const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
        if (isInput) return;

        // ── Active cell edit: only route commit/cancel keys ────────────────────
        if (editSessionState.isEditing) {
            if (e.key === "Enter") { ctx.commitEditAndMove(1, 0); e.preventDefault(); }
            else if (e.key === "Escape") { ctx.cancelEdit(); e.preventDefault(); }
            else if (e.key === "Tab") { ctx.commitEditAndMove(0, e.shiftKey ? -1 : 1); e.preventDefault(); }
            return;
        }

        // ── Escape: cancel a pending cut marquee (clipboard contents survive) ──
        if (e.key === "Escape" && clipboardManager.cutMarquee) {
            clipboardManager.cancelCut();
            e.preventDefault();
            return;
        }

        const anchor = this._anchor();
        const rc = this._rc();
        const ss = this._sheetStore();
        const rowCount = this._rowCount();
        const colCount = this._colCount();

        // ── Space: toggle checkbox ─────────────────────────────────────────────
        if (e.key === ' ' && anchor && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const spaceCt = rc?.getCellTypeConfig(anchor.row, anchor.col);
            if (spaceCt?.type === 'checkbox') {
                const spaceCellType = rc?.getCellType(anchor.row, anchor.col);
                if (spaceCellType === CELL_TYPE.TABLE_DATA) {
                    const info = rc?.tableManager?.getCellInfo(anchor.row, anchor.col);
                    if (info?.table && info.colDef) {
                        const cur = info.table.getValue(info.dataIndex, info.colDef.id);
                        info.table.updateCell(info.dataIndex, info.colDef.id, !cur);
                        untrack(() => ctx.renderScheduler?.invalidateAll());
                    }
                } else if (spaceCellType === CELL_TYPE.TABLE_ENTRY) {
                    const info = rc?.tableManager?.getCellInfo(anchor.row, anchor.col);
                    if (info?.table && info.colDef) {
                        const cur = info.table.entryBuffer?.[info.colDef.id];
                        info.table.setEntryValue(info.colDef.id, !cur);
                        untrack(() => ctx.renderScheduler?.invalidateAll());
                    }
                } else {
                    const cell = ss?.getCell(anchor.row, anchor.col);
                    ss?.setCellValue(anchor.row, anchor.col, !cell?.v);
                    untrack(() => ctx.renderScheduler?.invalidateAll());
                }
                e.preventDefault();
                return;
            }
        }

        // ── Dropdown overlay open: Escape closes, printable chars filter ────────
        if (this.focusedDropdownCell) {
            if (e.key === 'Escape') {
                this.focusedDropdownCell = null;
                e.preventDefault();
                return;
            }
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                this.dropdownFilter += e.key;
                setTimeout(() => this.dropdownFilterInputEl?.focus(), 0);
                e.preventDefault();
                return;
            }
        }

        // ── Printable character: start cell edit ─────────────────────────────
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && anchor) {
            const anchorCellType = rc?.getCellType(anchor.row, anchor.col);
            if (anchorCellType === CELL_TYPE.REPEATER) {
                const repCtx = rc?.repeaterEngine?.getCellRepeaterContext(anchor.row, anchor.col);
                if (repCtx && repCtx.repIndex > 0) { e.preventDefault(); return; }
            }
            if (anchorCellType === CELL_TYPE.TABLE_HEADER) { e.preventDefault(); return; }
            if (rc?.tableManager?.isTableShadowCell(anchor.row, anchor.col)) { e.preventDefault(); return; }
            const anchorCt = rc?.getCellTypeConfig(anchor.row, anchor.col);
            if (anchorCt?.type === "image") { e.preventDefault(); return; }
            if (anchorCellType === CELL_TYPE.TABLE_DATA || anchorCellType === CELL_TYPE.TABLE_ENTRY) {
                const info = rc?.tableManager?.getCellInfo(anchor.row, anchor.col);
                if (info?.table && info.colDef) {
                    const colType = info.colDef.type;
                    if (colType !== "checkbox" && colType !== "rating" && !info.colDef.isNonEntry) {
                        let targetCol = anchor.col;
                        if (anchorCellType === CELL_TYPE.TABLE_ENTRY && info.colDef.isNonEntry) {
                            const firstEditable = info.table.columns.findIndex(c => !c.isNonEntry);
                            if (firstEditable >= 0) targetCol = info.table.startCol + firstEditable;
                        }
                        ctx.beginCellEdit(anchor.row, targetCol, { seedText: e.key, surface: "grid" });
                    }
                }
                e.preventDefault();
                return;
            }
            ctx.beginCellEdit(anchor.row, anchor.col, { seedText: e.key, surface: "grid" });
            e.preventDefault();
            return;
        }

        // ── Switch statement for special keys ─────────────────────────────────
        switch (e.key) {
            case "ArrowUp":
                this.focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) ctx.jumpToEdgeAndSelect(-1, 0, e.shiftKey);
                else ctx.moveSelectionMergeAware(-1, 0, e.shiftKey);
                e.shiftKey ? ctx.scrollToFocus() : ctx.scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowDown":
                this.focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) ctx.jumpToEdgeAndSelect(1, 0, e.shiftKey);
                else ctx.moveSelectionMergeAware(1, 0, e.shiftKey);
                e.shiftKey ? ctx.scrollToFocus() : ctx.scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowLeft":
                this.focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) ctx.jumpToEdgeAndSelect(0, -1, e.shiftKey);
                else ctx.moveSelectionMergeAware(0, -1, e.shiftKey);
                e.shiftKey ? ctx.scrollToFocus() : ctx.scrollToAnchor();
                e.preventDefault();
                break;
            case "ArrowRight":
                this.focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) ctx.jumpToEdgeAndSelect(0, 1, e.shiftKey);
                else ctx.moveSelectionMergeAware(0, 1, e.shiftKey);
                e.shiftKey ? ctx.scrollToFocus() : ctx.scrollToAnchor();
                e.preventDefault();
                break;
            case "Home": {
                this.focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) {
                    if (e.shiftKey) { selectionState.focus = { row: 0, col: 0 }; ctx.scrollToFocus(); }
                    else { selectionState.selectionMode = 'range'; selectionState.anchor = { row: 0, col: 0 }; selectionState.focus = { row: 0, col: 0 }; ctx.scrollToAnchor(); }
                } else {
                    const homeRow = e.shiftKey ? (selectionState.focus?.row ?? selectionState.anchor?.row ?? 0) : (selectionState.anchor?.row ?? 0);
                    if (e.shiftKey) { selectionState.focus = { row: homeRow, col: 0 }; ctx.scrollToFocus(); }
                    else { selectionState.selectionMode = 'range'; selectionState.anchor = { row: homeRow, col: 0 }; selectionState.focus = { row: homeRow, col: 0 }; ctx.scrollToAnchor(); }
                }
                e.preventDefault();
                break;
            }
            case "End": {
                this.focusedDropdownCell = null;
                if (e.ctrlKey || e.metaKey) {
                    let lastRow = 0, lastCol = 0;
                    ss?.cells.forEach((_cell, key) => {
                        const [r, c] = key.split(',').map(Number);
                        if (r > lastRow) lastRow = r;
                        if (c > lastCol) lastCol = c;
                    });
                    const endDest = { row: lastRow, col: lastCol };
                    if (e.shiftKey) { selectionState.focus = endDest; ctx.scrollToFocus(); }
                    else { selectionState.selectionMode = 'range'; selectionState.anchor = endDest; selectionState.focus = endDest; ctx.scrollToAnchor(); }
                } else {
                    const endRow = e.shiftKey ? (selectionState.focus?.row ?? selectionState.anchor?.row ?? 0) : (selectionState.anchor?.row ?? 0);
                    const endCol = colCount - 1;
                    if (e.shiftKey) { selectionState.focus = { row: endRow, col: endCol }; ctx.scrollToFocus(); }
                    else { selectionState.selectionMode = 'range'; selectionState.anchor = { row: endRow, col: endCol }; selectionState.focus = { row: endRow, col: endCol }; ctx.scrollToAnchor(); }
                }
                e.preventDefault();
                break;
            }
            case "PageUp": {
                this.focusedDropdownCell = null;
                const pageRowsUp = Math.max(1, Math.floor((ctx.virtualizer?.bodyViewportHeight ?? ROW_HEIGHT) / ROW_HEIGHT));
                selectionState.moveSelection(-pageRowsUp, 0, e.shiftKey, rowCount, colCount);
                e.shiftKey ? ctx.scrollToFocus() : ctx.scrollToAnchor();
                e.preventDefault();
                break;
            }
            case "PageDown": {
                this.focusedDropdownCell = null;
                const pageRowsDn = Math.max(1, Math.floor((ctx.virtualizer?.bodyViewportHeight ?? ROW_HEIGHT) / ROW_HEIGHT));
                selectionState.moveSelection(pageRowsDn, 0, e.shiftKey, rowCount, colCount);
                e.shiftKey ? ctx.scrollToFocus() : ctx.scrollToAnchor();
                e.preventDefault();
                break;
            }
            case "Tab": {
                this.focusedDropdownCell = null;
                const isSingleMergeSelected = selectionState.hasTabSelection &&
                    selectionState.extraRanges.length === 0 &&
                    (() => {
                        const r = selectionState.range;
                        if (!r) return false;
                        const me = rc?.mergeEngine;
                        if (!me) return false;
                        const m = me.getMergeAt(r.startRow, r.startCol);
                        return m && m.startRow === r.startRow && m.endRow === r.endRow &&
                            m.startCol === r.startCol && m.endCol === r.endCol;
                    })();
                if (selectionState.hasTabSelection && !isSingleMergeSelected) {
                    e.shiftKey ? selectionState.tabPrev() : selectionState.tabNext();
                    ctx.scrollToPrimaryCell();
                } else {
                    ctx.moveSelectionMergeAware(0, e.shiftKey ? -1 : 1, false);
                    ctx.scrollToAnchor();
                }
                e.preventDefault();
                break;
            }
            case "Enter":
                if (anchor) {
                    const anchorCellType = rc?.getCellType(anchor.row, anchor.col);
                    const anchorCt2 = rc?.getCellTypeConfig(anchor.row, anchor.col);
                    if (anchorCt2?.type === "image") {
                        ctx.beginCellEdit(anchor.row, anchor.col, { surface: "grid" });
                        e.preventDefault();
                        break;
                    }
                    if (anchorCellType === CELL_TYPE.TABLE_ENTRY) {
                        ctx.beginCellEdit(anchor.row, anchor.col, { surface: "grid" });
                    } else if (anchorCellType !== CELL_TYPE.TABLE_HEADER) {
                        ctx.moveSelectionMergeAware(1, 0, false);
                        ctx.scrollToAnchor();
                    }
                }
                e.preventDefault();
                break;
            case "F2":
                if (anchor) {
                    const f2CellType = rc?.getCellType(anchor.row, anchor.col);
                    if (f2CellType !== CELL_TYPE.TABLE_HEADER) {
                        ctx.beginCellEdit(anchor.row, anchor.col, { surface: "grid" });
                    }
                }
                e.preventDefault();
                break;
            case "Delete":
            case "Backspace":
                this._clearSelection();
                e.preventDefault();
                break;
            case "z":
                if (e.ctrlKey || e.metaKey) {
                    e.shiftKey ? spreadsheetSession.redo() : spreadsheetSession.undo();
                    e.preventDefault();
                }
                break;
            case "y":
                if (e.ctrlKey || e.metaKey) { spreadsheetSession.redo(); e.preventDefault(); }
                break;
            case "p":
                if (e.ctrlKey || e.metaKey) { document.dispatchEvent(new CustomEvent('openPdfExport')); e.preventDefault(); }
                break;
            case "c":
                if ((e.ctrlKey || e.metaKey) && selectionState.range) this._copySelection();
                break;
            case "x":
                if ((e.ctrlKey || e.metaKey) && selectionState.range) this._cutSelection();
                break;
            case "v":
                if ((e.ctrlKey || e.metaKey) && selectionState.range) {
                    clipboardManager._pendingPasteMode = e.shiftKey ? "values" : "full";
                }
                break;
            case "a":
                if (e.ctrlKey || e.metaKey) { selectionState.selectAll(); e.preventDefault(); }
                break;
            case "d":
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) { this._fillDown(); e.preventDefault(); }
                break;
            case "r":
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) { this._fillRight(); e.preventDefault(); }
                break;
            case "4":
                if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
                    this._applyTypeToSelection("currency", { decimals: 2, symbol: "$" });
                    e.preventDefault();
                }
                break;
            case "5":
                if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
                    this._applyTypeToSelection("percent", { decimals: 2 });
                    e.preventDefault();
                }
                break;
            case ";":
                if ((e.ctrlKey || e.metaKey) && e.shiftKey) { this._insertTime(); e.preventDefault(); }
                else if (e.ctrlKey || e.metaKey) { this._insertDate(); e.preventDefault(); }
                break;
            case "\\":
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey) { this._clearFormatting(); e.preventDefault(); }
                break;
            case "=":
                if ((e.ctrlKey || e.metaKey) && e.altKey) {
                    const mode = selectionState.selectionMode;
                    if (mode === "rows") this._insertRowAbove();
                    else if (mode === "cols") this._insertColumnLeft();
                    e.preventDefault();
                }
                break;
            case "-":
                if ((e.ctrlKey || e.metaKey) && e.altKey) {
                    const delMode = selectionState.selectionMode;
                    if (delMode === "rows") this._deleteSelectedRows();
                    else if (delMode === "cols") this._deleteSelectedColumns();
                    e.preventDefault();
                }
                break;
        }
    };
}
