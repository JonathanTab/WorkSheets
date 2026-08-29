/**
 * Shared helpers for resolving an A1-style range reference (optionally
 * cross-sheet, e.g. "Sheet2!A1:A10") into the live values it currently holds.
 *
 * Extracted from Grid.svelte's dropdown range-source resolution so other
 * features (e.g. the Entry Forge plugin) can resolve a configured range
 * without duplicating the ref-parsing regex.
 */

/** @returns {{row:number, col:number}|null} */
export function parseCellRef(ref) {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    if (!m) return null;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    col--;
    return { row: parseInt(m[2]) - 1, col };
}

/**
 * Resolve a range string (e.g. "A1:A10" or "Sheet2!A1:A10") to the list of
 * non-empty display values it currently contains on the given session.
 * @param {import('./SpreadsheetSession.svelte.js').SpreadsheetSession} spreadsheetSession
 * @param {string} rangeStr
 * @returns {string[]}
 */
export function resolveRangeValues(spreadsheetSession, rangeStr) {
    if (!spreadsheetSession) return [];
    let targetSheetId = null;
    let cellRange = String(rangeStr ?? '').trim();
    const sheetRefMatch = cellRange.match(/^(?:'((?:[^']|'')*)'|([^'!][^!]*?))!(.+)$/);
    if (sheetRefMatch) {
        const sheetName = (sheetRefMatch[1] ?? sheetRefMatch[2]).replace(/''/g, "'");
        cellRange = sheetRefMatch[3];
        const entry = spreadsheetSession.sheets.find(s => s.name === sheetName);
        if (entry) targetSheetId = entry.id;
    }
    const parts = cellRange.trim().toUpperCase().split(':');
    const start = parseCellRef(parts[0]);
    const end = parts[1] ? parseCellRef(parts[1]) : start;
    if (!start || !end) return [];

    const opts = [];
    if (!targetSheetId || targetSheetId === spreadsheetSession.activeSheetId) {
        for (let r = start.row; r <= end.row; r++)
            for (let c = start.col; c <= end.col; c++) {
                const v = spreadsheetSession.getCellDisplayValue(r, c);
                if (v != null && v !== '') opts.push(String(v));
            }
    } else {
        const values = spreadsheetSession.computeSheetRange(targetSheetId, start.row, start.col, end.row, end.col);
        for (const v of values)
            if (v != null && v !== '' && !(v instanceof Object)) opts.push(String(v));
    }
    return opts;
}

/**
 * Resolve a range string to options with styling (background + text colors).
 * Returns objects with value, backgroundColor, and color properties.
 * @param {import('./SpreadsheetSession.svelte.js').SpreadsheetSession} spreadsheetSession
 * @param {string} rangeStr
 * @returns {Array<{value:string, backgroundColor?:string, color?:string}>}
 */
export function resolveRangeOptions(spreadsheetSession, rangeStr) {
    if (!spreadsheetSession) return [];
    let targetSheetId = null;
    let cellRange = String(rangeStr ?? '').trim();
    const sheetRefMatch = cellRange.match(/^(?:'((?:[^']|'')*)'|([^'!][^!]*?))!(.+)$/);
    if (sheetRefMatch) {
        const sheetName = (sheetRefMatch[1] ?? sheetRefMatch[2]).replace(/''/g, "'");
        cellRange = sheetRefMatch[3];
        const entry = spreadsheetSession.sheets.find(s => s.name === sheetName);
        if (entry) targetSheetId = entry.id;
    }
    const parts = cellRange.trim().toUpperCase().split(':');
    const start = parseCellRef(parts[0]);
    const end = parts[1] ? parseCellRef(parts[1]) : start;
    if (!start || !end) return [];

    const opts = [];
    if (!targetSheetId || targetSheetId === spreadsheetSession.activeSheetId) {
        for (let r = start.row; r <= end.row; r++)
            for (let c = start.col; c <= end.col; c++) {
                const v = spreadsheetSession.getCellDisplayValue(r, c);
                if (v != null && v !== '') {
                    const cell = spreadsheetSession.getCell(r, c);
                    opts.push({
                        value: String(v),
                        backgroundColor: cell?.style?.backgroundColor ?? undefined,
                        color: cell?.style?.color ?? undefined,
                    });
                }
            }
    } else {
        const values = spreadsheetSession.computeSheetRange(targetSheetId, start.row, start.col, end.row, end.col);
        for (const v of values)
            if (v != null && v !== '' && !(v instanceof Object))
                opts.push({ value: String(v) });
    }
    return opts;
}
