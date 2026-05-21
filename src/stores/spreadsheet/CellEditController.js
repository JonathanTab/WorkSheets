import { spreadsheetSession } from "../../stores/spreadsheetStore.svelte.js";
import { CELL_TYPE } from "./features/SheetRenderContext.svelte.js";
import { CellTypeRegistry } from "./index.js";

/**
 * Single entry point for committing a cell edit from any surface (Grid,
 * FormulaBar, MobileInputBar).  Replaces three near-identical routing copies
 * that each handled TABLE_DATA / TABLE_ENTRY / TABLE_HEADER / sheet cells.
 *
 * @param {string|null} sheetId      The sheet the edit belongs to (null → active sheet)
 * @param {number} row
 * @param {number} col
 * @param {string|any} value         Plain value, formula string, or {value, tfr} for rich text
 * @param {any[]|null} [tfr]         Rich text runs (optional; overridden if value is {value,tfr})
 */
export function commitCellEdit(sheetId, row, col, value, tfr = null) {
    // Normalise: callers may pass { value, tfr } as a single object
    let plainValue = value;
    let richTfr = tfr;
    if (value !== null && typeof value === "object" && "value" in value) {
        plainValue = value.value;
        richTfr = value.tfr ?? null;
    }

    const rc = spreadsheetSession.renderContext;
    if (rc) {
        const cellType = rc.getCellType(row, col);

        if (cellType === CELL_TYPE.TABLE_DATA) {
            const info = rc.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef && !info.colDef.isNonEntry && info.dataIndex >= 0) {
                const parsed = CellTypeRegistry.parseInput({ type: info.colDef.type }, plainValue);
                info.table.updateCell(info.dataIndex, info.colDef.id, parsed);
            }
            return;
        }

        if (cellType === CELL_TYPE.TABLE_ENTRY) {
            const info = rc.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef && !info.colDef.isNonEntry) {
                const parsed = CellTypeRegistry.parseInput({ type: info.colDef.type }, plainValue);
                info.table.setEntryValue(info.colDef.id, parsed);
                spreadsheetSession.requestGridRepaint?.();
            }
            return;
        }

        if (cellType === CELL_TYPE.TABLE_HEADER) {
            const info = rc.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                const newName = String(plainValue ?? "").trim();
                if (newName) info.table.renameColumn(info.colDef.id, newName);
            }
            return;
        }
    }

    const targetSheetId = sheetId ?? spreadsheetSession.activeSheetId;

    if (richTfr && richTfr.length > 0) {
        const store = spreadsheetSession.activeSheetStore;
        const ct = store?.getCellTypeConfig(row, col);
        const parsedValue = CellTypeRegistry.parseInput(ct, plainValue);
        store?.setCellValueWithRuns(row, col, parsedValue, richTfr);
        return;
    }

    if (typeof plainValue === "string" && plainValue.startsWith("=")) {
        spreadsheetSession.setCellFormulaOnSheet(targetSheetId, row, col, plainValue);
    } else {
        const store = spreadsheetSession.activeSheetStore;
        const ct = store?.getCellTypeConfig(row, col);
        const parsedValue = CellTypeRegistry.parseInput(ct, plainValue);
        spreadsheetSession.setCellValueOnSheet(targetSheetId, row, col, parsedValue);
    }
}
