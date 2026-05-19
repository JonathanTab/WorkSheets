import { CELL_TYPE } from './features/SheetRenderContext.svelte.js';

/**
 * Clears all formatting (styles + borders) for the current selection.
 * @param {import('./SpreadsheetSession.svelte.js').SpreadsheetSession} session
 * @param {import('./SelectionState.svelte.js').SelectionState} selectionState
 */
export function clearFormatting(session, selectionState) {
    const sheetStore = session.activeSheetStore;
    const renderContext = session.renderContext;
    if (!sheetStore) return;

    const rowCount = sheetStore.rowCount ?? 0;
    const colCount = sheetStore.colCount ?? 0;
    const ranges = selectionState.allEffectiveRanges?.(rowCount, colCount)
        ?? (selectionState.range ? [selectionState.range] : []);
    if (ranges.length === 0) return;

    for (const eff of ranges) {
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
        sheetStore.clearBordersInRange(eff.startRow, eff.endRow, eff.startCol, eff.endCol);
    }
}
