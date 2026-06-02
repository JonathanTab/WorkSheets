/**
 * clipboard/tables/tableApply.js — paste INTO a Table.
 *
 * Tables own their data (rows live in a TableStore, not the sheet cell map), so a
 * paste whose top-left lands inside a table is handled here instead of the plain
 * grid writer:
 *   - entry row → insert the clipboard rows as new table rows
 *   - data row  → overwrite cells in place (overflow rows append at the bottom)
 *
 * Isolated behind a single entry point (`tryTablePaste`) so the table semantics
 * never leak into the grid apply path.
 */

/**
 * Attempt a table-aware paste. Returns true if the target was a table and the
 * paste was handled; false to fall through to the grid writer.
 *
 * @param {object} ctx { sheetStore, session }
 * @param {object} region   the region being pasted (normalized cells)
 * @param {{startRow:number,startCol:number}} target  destination top-left
 * @returns {boolean}
 */
export function tryTablePaste({ session }, region, target) {
    const tableManager = session?.renderContext?.tableManager;
    if (!tableManager) return false;

    const info = tableManager.getCellInfo(target.startRow, target.startCol);
    if (!info?.table) return false;

    const cells = region.cells;
    const rows2D = cells.map(row => row.map(cell => String(cell?.displayValue ?? cell?.v ?? '')));
    const absColOffset = Math.max(0, target.startCol - info.table.startCol);

    if (info.rowType === 'entry') {
        // pasteRows maps into entryCols[]; count only non-formula columns before
        // the clicked position to get the entry-relative start offset.
        const entryColOffset = info.table.columns
            .slice(0, absColOffset)
            .filter(c => !c.isNonEntry).length;
        info.table.pasteRows(rows2D, entryColOffset);
        return true;
    }
    if (info.rowType === 'data') {
        // updateRows uses this.columns[] (all cols) internally → absolute offset.
        info.table.updateRows(rows2D, info.dataIndex, absColOffset);
        return true;
    }
    // Header / non-entry cells: nothing safe to do — treat as handled (no-op) so we
    // don't spill table content into the surrounding sheet.
    return true;
}

/**
 * Clear a single cell that belongs to a table (used by cut-source clearing).
 * Returns true if the cell was a table cell (and thus handled), false otherwise.
 */
export function tryClearTableCell(session, r, c) {
    const tableManager = session?.renderContext?.tableManager;
    if (!tableManager) return false;
    const info = tableManager.getCellInfo?.(r, c);
    if (!info?.table) return false;

    if (info.colDef && !info.colDef.isNonEntry) {
        if (info.rowType === 'data') info.table.updateCell(info.dataIndex, info.colDef.id, null);
        else if (info.rowType === 'entry') info.table.setEntryValue(info.colDef.id, null);
    }
    // Header / non-entry cells: can't safely clear — but still a table cell.
    return true;
}
