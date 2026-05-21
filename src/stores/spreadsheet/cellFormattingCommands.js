/**
 * cellFormattingCommands.js — shared formatting commands for spreadsheet toolbars.
 *
 * Exports pure functions (no Svelte reactivity) that read from stores at call
 * time. Components import these and call them inside $derived.by() or event
 * handlers. This eliminates the ~250 LOC of near-identical code that used to
 * live independently in FormattingToolbar, MobileFormattingSheet, and
 * MobileToolbar.
 *
 * Also exports computeSelectedFormatting() and computeBorderSelectionRange()
 * — pure functions suitable for wrapping in $derived.by().
 */

import {
    spreadsheetSession,
    selectionState,
} from '../spreadsheetStore.svelte.js';
import { editSessionState } from './index.js';
import { CELL_TYPE } from './features/SheetRenderContext.svelte.js';

// ── Formatting property keys ──────────────────────────────────────────────────

export const FORMATTING_KEYS = [
    'bold', 'italic', 'underline', 'fontSize', 'fontFamily',
    'color', 'backgroundColor', 'horizontalAlign', 'verticalAlign',
];

// ── Context helpers ───────────────────────────────────────────────────────────

/**
 * When the anchor is on a TABLE_HEADER, returns { table, colId, colDef }.
 * Returns null for all other cell types.
 */
export function getTableColContext() {
    const renderContext = spreadsheetSession.renderContext;
    const anchor = selectionState.anchor;
    if (!anchor || !renderContext) return null;
    const cellType = renderContext.getCellType(anchor.row, anchor.col);
    if (cellType !== CELL_TYPE.TABLE_HEADER) return null;
    const info = renderContext.tableManager?.getCellInfo(anchor.row, anchor.col);
    if (!info?.table || !info?.colDef) return null;
    const liveCol = info.table.columns.find(c => c.id === info.colDef.id) ?? info.colDef;
    return { table: info.table, colId: liveCol.id, colDef: liveCol };
}

/**
 * When the anchor is on a TABLE_DATA or TABLE_ENTRY cell, returns the cell
 * info. Returns null for other cell types.
 */
export function getTableDataCellInfo() {
    const renderContext = spreadsheetSession.renderContext;
    const anchor = selectionState.anchor;
    if (!anchor || !renderContext) return null;
    const cellType = renderContext.getCellType(anchor.row, anchor.col);
    if (cellType !== CELL_TYPE.TABLE_DATA && cellType !== CELL_TYPE.TABLE_ENTRY) return null;
    return renderContext.tableManager?.getCellInfo(anchor.row, anchor.col) ?? null;
}

// ── Formatting derivation ─────────────────────────────────────────────────────

/** @type {number} Maximum cells to sample when computing mixed formatting state */
const MAX_SAMPLE_CELLS = 200;

/**
 * Compute the effective formatting for the current selection. Suitable for
 * use inside $derived.by(). Returns null when there is no active sheet.
 * @returns {Record<string, any> | null}
 */
export function computeSelectedFormatting() {
    const sheetStore = spreadsheetSession.activeSheetStore;
    if (!sheetStore) return null;

    // TABLE_HEADER: read formatting from column definition
    const tcc = getTableColContext();
    if (tcc) {
        const cd = tcc.colDef;
        return {
            bold: cd.bold ?? null,
            italic: cd.italic ?? null,
            underline: cd.underline ?? null,
            fontSize: cd.fontSize ?? null,
            fontFamily: cd.fontFamily ?? null,
            color: cd.textColor ?? null,
            backgroundColor: cd.bgColor ?? null,
            horizontalAlign: cd.hAlign ?? null,
            verticalAlign: null,
        };
    }

    // TABLE_DATA / TABLE_ENTRY: read effective merged formatting
    const tdi = getTableDataCellInfo();
    if (tdi?.table && tdi?.colDef && tdi.dataIndex >= 0) {
        const fmt = tdi.table.getEffectiveCellFormatting(tdi.dataIndex, tdi.colDef.id);
        return {
            bold: fmt.bold ?? null,
            italic: fmt.italic ?? null,
            underline: fmt.underline ?? null,
            fontSize: fmt.fontSize ?? null,
            fontFamily: fmt.fontFamily ?? null,
            color: fmt.color ?? null,
            backgroundColor: fmt.backgroundColor ?? null,
            horizontalAlign: fmt.horizontalAlign ?? null,
            verticalAlign: fmt.verticalAlign ?? null,
        };
    }

    // Touch version counters so the derived re-runs on any meta change
    const _rowMetaVer = sheetStore.rowMetaVersion;
    const _colMetaVer = sheetStore.colMetaVersion;
    const _cellsVer = sheetStore.cellsVersion;

    const mode = selectionState.selectionMode;
    const rowCount = sheetStore.rowCount;
    const colCount = sheetStore.colCount;

    if (mode === 'rows' && selectionState.selectedRows) {
        const fmt = sheetStore.getRowFormatting?.(selectionState.selectedRows.start) ?? {};
        return _axisFormatting(fmt);
    }

    if (mode === 'cols' && selectionState.selectedCols) {
        const fmt = sheetStore.getColFormatting?.(selectionState.selectedCols.start) ?? {};
        return _axisFormatting(fmt);
    }

    if (mode === 'all') {
        const fmt = sheetStore.getColFormatting?.(0) ?? {};
        return _axisFormatting(fmt);
    }

    // Range mode: sample from cells
    const eff = selectionState.effectiveRange(rowCount, colCount);
    if (!eff) return null;

    const renderContext = spreadsheetSession.renderContext;
    const props = {};
    for (const key of FORMATTING_KEYS) props[key] = { values: new Set(), count: 0 };

    let sampled = 0;
    for (let r = eff.startRow; r <= eff.endRow && sampled < MAX_SAMPLE_CELLS; r++) {
        for (let c = eff.startCol; c <= eff.endCol && sampled < MAX_SAMPLE_CELLS; c++) {
            const ct = renderContext?.getCellType(r, c);
            if (ct === CELL_TYPE.TABLE_HEADER) continue;

            if (ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.TABLE_ENTRY) {
                const info = renderContext?.tableManager?.getCellInfo(r, c);
                if (info?.table && info.colDef && info.dataIndex >= 0) {
                    const fmt = info.table.getEffectiveCellFormatting(info.dataIndex, info.colDef.id);
                    for (const key of FORMATTING_KEYS) {
                        props[key].values.add(fmt[key] ?? null);
                        props[key].count++;
                    }
                    sampled++;
                }
                continue;
            }

            const cell = sheetStore.getCell(r, c);
            for (const key of FORMATTING_KEYS) {
                props[key].values.add(cell[key] ?? null);
                props[key].count++;
            }
            sampled++;
        }
    }

    const result = {};
    for (const key of FORMATTING_KEYS) {
        const { values } = props[key];
        result[key] = values.size === 1 ? [...values][0] : 'mixed';
    }
    return result;
}

function _axisFormatting(fmt) {
    return {
        bold: fmt.bold ?? null,
        italic: fmt.italic ?? null,
        underline: fmt.underline ?? null,
        fontSize: fmt.fontSize ?? null,
        fontFamily: fmt.fontFamily ?? null,
        color: fmt.color ?? null,
        backgroundColor: fmt.backgroundColor ?? null,
        horizontalAlign: fmt.horizontalAlign ?? null,
        verticalAlign: fmt.verticalAlign ?? null,
    };
}

// ── Border selection range ────────────────────────────────────────────────────

/**
 * Compute the effective border selection range, expanding to cover merged cells.
 * Suitable for use inside $derived.by().
 * @returns {{ startRow:number, endRow:number, startCol:number, endCol:number } | null}
 */
export function computeBorderSelectionRange() {
    const sheetStore = spreadsheetSession.activeSheetStore;
    if (!sheetStore) return null;
    const mode = selectionState.selectionMode;
    if (mode !== 'range') {
        return selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
    }
    const range = selectionState.range;
    if (!range) return null;
    const mergeEngine = sheetStore.mergeEngine;
    if (!mergeEngine || mergeEngine.merges.length === 0) return range;
    let { startRow, endRow, startCol, endCol } = range;
    let changed = true;
    while (changed) {
        changed = false;
        for (const m of mergeEngine.merges) {
            if (m.startRow <= endRow && m.endRow >= startRow && m.startCol <= endCol && m.endCol >= startCol) {
                if (m.startRow < startRow) { startRow = m.startRow; changed = true; }
                if (m.endRow > endRow)     { endRow   = m.endRow;   changed = true; }
                if (m.startCol < startCol) { startCol = m.startCol; changed = true; }
                if (m.endCol > endCol)     { endCol   = m.endCol;   changed = true; }
            }
        }
    }
    return { startRow, endRow, startCol, endCol };
}

// ── applyFormatting ──────────────────────────────────────────────────────────

const _TFR_PROP_MAP = {
    bold:          'bold',
    italic:        'italic',
    underline:     'underline',
    strikethrough: 'strikethrough',
    color:         'foregroundColor',
    fontSize:      'fontSize',
    fontFamily:    'fontFamily',
};
const _TOGGLE_PROPS = new Set(['bold', 'italic', 'underline', 'strikethrough']);

const _COL_PROP_MAP = {
    bold:            'bold',
    italic:          'italic',
    underline:       'underline',
    fontSize:        'fontSize',
    fontFamily:      'fontFamily',
    color:           'textColor',
    backgroundColor: 'bgColor',
    horizontalAlign: 'hAlign',
};

/**
 * Apply a formatting property to the current selection.
 * Handles inline editing, table header routing, row/col/all/range modes, and
 * multi-range selections.
 * @param {string} property
 * @param {any} value
 */
export function applyFormatting(property, value) {
    // Inline editing: try to apply to the text selection first.
    if (editSessionState.isEditing && editSessionState.applyInlineFormat) {
        const tfrProp = _TFR_PROP_MAP[property];
        if (tfrProp) {
            const tfrValue = _TOGGLE_PROPS.has(property) ? undefined : value;
            if (editSessionState.applyInlineFormat(tfrProp, tfrValue)) return;
        }
    }

    // TABLE_HEADER: route to column definition
    const tcc = getTableColContext();
    if (tcc) {
        const colProp = _COL_PROP_MAP[property];
        if (colProp) tcc.table.updateColumnDef(tcc.colId, { [colProp]: value });
        return;
    }

    const sheetStore = spreadsheetSession.activeSheetStore;
    if (!sheetStore) return;

    const mode = selectionState.selectionMode;
    const rowCount = sheetStore.rowCount;
    const colCount = sheetStore.colCount;

    if (mode === 'rows') {
        const rowRanges = selectionState.allRowRanges;
        if (!rowRanges?.length) return;
        const rowSet = new Set();
        for (const { start, end } of rowRanges) {
            for (let r = start; r <= end; r++) rowSet.add(r);
        }
        spreadsheetSession.ydoc?.transact(() => {
            for (const r of rowSet) sheetStore.setRowFormatting?.(r, { [property]: value });
            sheetStore.clearCellStylePropertyInRows?.(rowSet, property);
        });
        return;
    }

    if (mode === 'cols') {
        const colRanges = selectionState.allColRanges;
        if (!colRanges?.length) return;
        const colSet = new Set();
        for (const { start, end } of colRanges) {
            for (let c = start; c <= end; c++) colSet.add(c);
        }
        spreadsheetSession.ydoc?.transact(() => {
            for (const c of colSet) sheetStore.setColFormatting?.(c, { [property]: value });
            sheetStore.clearCellStylePropertyInCols?.(colSet, property);
        });
        return;
    }

    if (mode === 'all') {
        spreadsheetSession.ydoc?.transact(() => {
            for (let c = 0; c < colCount; c++) {
                sheetStore.setColFormatting?.(c, { [property]: value });
            }
            sheetStore.clearCellStylePropertyAll?.(property);
        });
        return;
    }

    // Range mode — iterate all selected ranges
    const ranges = selectionState.allRanges;
    if (!ranges?.length || !ranges[0]) return;
    const renderContext = spreadsheetSession.renderContext;
    spreadsheetSession.ydoc?.transact(() => {
        for (const eff of ranges) {
            if (!eff) continue;
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (ct === CELL_TYPE.TABLE_HEADER) continue;
                    if (ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.TABLE_ENTRY) {
                        const info = renderContext?.tableManager?.getCellInfo(r, c);
                        if (info?.table && info.colDef && !info.colDef.isNonEntry && info.dataIndex >= 0) {
                            info.table.setCellFormatting(info.dataIndex, info.colDef.id, { [property]: value });
                        }
                        continue;
                    }
                    sheetStore.setCellProperties(r, c, { [property]: value });
                }
            }
        }
    });
}

// ── handleBorderChange ────────────────────────────────────────────────────────

/**
 * Apply edge-based border instructions to the active sheet.
 * @param {any[] | null} borderInstructions
 */
export function handleBorderChange(borderInstructions) {
    if (!borderInstructions || !Array.isArray(borderInstructions)) return;
    const sheetStore = spreadsheetSession.activeSheetStore;
    if (!sheetStore) return;
    const clearInstruction = borderInstructions.find(i => i.type === 'clear-range');
    if (clearInstruction) {
        const { startRow, endRow, startCol, endCol } = clearInstruction;
        sheetStore.clearBordersInRange(startRow, endRow, startCol, endCol);
        return;
    }
    sheetStore.applyBorders(borderInstructions);
}

// ── handleCellTypeChange ──────────────────────────────────────────────────────

/**
 * Apply a cell-type config to the current selection.
 * Routes to column defs for TABLE_HEADER, row/col configs for axis modes, and
 * per-cell for range/all modes.
 * @param {{ type: string, [key: string]: any } | null} config
 */
export function handleCellTypeChange(config) {
    const tcc = getTableColContext();
    if (tcc) {
        tcc.table.updateColumnTypeConfig(tcc.colId, config);
        return;
    }

    const sheetStore = spreadsheetSession.activeSheetStore;
    if (!sheetStore) return;

    const mode = selectionState.selectionMode;
    const rowCount = sheetStore.rowCount;
    const colCount = sheetStore.colCount;

    if (mode === 'rows') {
        spreadsheetSession.ydoc?.transact(() => {
            for (const { start, end } of selectionState.allRowRanges) {
                for (let r = start; r <= end; r++) sheetStore.setRowTypeConfig(r, config);
            }
        });
        return;
    }

    if (mode === 'cols') {
        spreadsheetSession.ydoc?.transact(() => {
            for (const { start, end } of selectionState.allColRanges) {
                for (let c = start; c <= end; c++) sheetStore.setColTypeConfig(c, config);
            }
        });
        return;
    }

    const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
    if (!ranges?.length) return;
    const renderContext = spreadsheetSession.renderContext;
    spreadsheetSession.ydoc?.transact(() => {
        for (const eff of ranges) {
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY ||
                        ct === CELL_TYPE.TABLE_DATA) continue;
                    sheetStore.setCellTypeConfig(r, c, config);
                }
            }
        }
    });
}
