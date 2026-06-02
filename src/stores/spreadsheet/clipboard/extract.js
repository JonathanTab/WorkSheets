/**
 * clipboard/extract.js — Sheet region → Region (the read side of internal copy).
 *
 * Pure-ish: given a SheetStore + session + an absolute range, produce one
 * {@link Region} with dense cells and relative-coordinate borders/merges/dims.
 * Table cells resolve their raw value through the TableStore so numeric typing
 * and computed formula-column results survive the copy.
 */

import { FORMAT_KEYS } from './model.js';
import { bordersStylesEqual } from '../rendering/BorderGeometry.js';

function bordersEqual(a, b) {
    return bordersStylesEqual(a, b);
}

/**
 * Extract a single absolute range into a Region.
 * @param {import('../SheetStore.svelte.js').SheetStore} sheetStore
 * @param {import('../SpreadsheetSession.svelte.js').SpreadsheetSession} session
 * @param {{startRow:number,endRow:number,startCol:number,endCol:number}} range
 * @returns {object} Region
 */
export function extractRegion(sheetStore, session, range) {
    const { startRow, endRow, startCol, endCol } = range;
    const cells = [];
    const borders = [];
    const merges = [];
    const dataValidations = [];
    const conditionalFormats = [];
    const rowHeights = [];
    const colWidths = [];

    const tableManager = session?.renderContext?.tableManager;

    // ── Cells ──────────────────────────────────────────────────────────────────
    for (let r = startRow; r <= endRow; r++) {
        const rowData = [];
        for (let c = startCol; c <= endCol; c++) {
            rowData.push(extractCell(sheetStore, session, tableManager, r, c));
        }
        cells.push(rowData);
    }

    // ── Borders (emit only edges that differ from the neighbour, per original) ──
    for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
            const cb = sheetStore.getCellBorders(r, c);
            for (const edge of ['top', 'bottom', 'left', 'right']) {
                const include =
                    (edge === 'top'    && (r === startRow || !bordersEqual(cb.top,  sheetStore.getCellBorders(r - 1, c).bottom))) ||
                    (edge === 'bottom' && r === endRow) ||
                    (edge === 'left'   && (c === startCol || !bordersEqual(cb.left, sheetStore.getCellBorders(r, c - 1).right))) ||
                    (edge === 'right'  && c === endCol);
                if (include && cb[edge]) {
                    borders.push({
                        relRow: r - startRow, relCol: c - startCol, edge,
                        style: cb[edge].style, width: cb[edge].width, color: cb[edge].color,
                    });
                }
            }
        }
    }

    // ── Merges fully inside the range ───────────────────────────────────────────
    for (const m of (sheetStore.getMerges?.() || [])) {
        if (m.startRow >= startRow && m.endRow <= endRow && m.startCol >= startCol && m.endCol <= endCol) {
            merges.push({
                relStartRow: m.startRow - startRow, relStartCol: m.startCol - startCol,
                relEndRow:   m.endRow   - startRow, relEndCol:   m.endCol   - startCol,
            });
        }
    }

    // ── Data validations / conditional formats fully inside the range ───────────
    for (const rule of (sheetStore.getDataValidations?.() || [])) {
        if (rule.startRow >= startRow && rule.endRow <= endRow && rule.startCol >= startCol && rule.endCol <= endCol) {
            dataValidations.push({
                ...rule,
                startRow: rule.startRow - startRow, startCol: rule.startCol - startCol,
                endRow:   rule.endRow   - startRow, endCol:   rule.endCol   - startCol,
            });
        }
    }
    for (const rule of (sheetStore.getConditionalFormats?.() || [])) {
        if (rule.startRow >= startRow && rule.endRow <= endRow && rule.startCol >= startCol && rule.endCol <= endCol) {
            conditionalFormats.push({
                ...rule,
                startRow: rule.startRow - startRow, startCol: rule.startCol - startCol,
                endRow:   rule.endRow   - startRow, endCol:   rule.endCol   - startCol,
            });
        }
    }

    // ── Dimensions ──────────────────────────────────────────────────────────────
    for (let r = startRow; r <= endRow; r++) rowHeights.push(sheetStore.getRowHeight?.(r) ?? null);
    for (let c = startCol; c <= endCol; c++) colWidths.push(sheetStore.getColWidth?.(c) ?? null);

    return {
        range: { startRow, endRow, startCol, endCol },
        cells, borders, merges, dataValidations, conditionalFormats,
        rowHeights, colWidths,
        rowCount: endRow - startRow + 1,
        colCount: endCol - startCol + 1,
    };
}

/**
 * Extract a single cell into the normalized Cell shape. Resolves table-backed
 * cells through the TableStore (raw value / formula-column result / header name).
 */
function extractCell(sheetStore, session, tableManager, r, c) {
    const cell = sheetStore.getCell(r, c);
    const ct = sheetStore.getCellTypeConfig(r, c);
    const dispVal = session.getCellDisplayValue(r, c);
    const displayValue = dispVal !== '' && dispVal != null ? dispVal : null;

    let rawV = cell.exists ? cell.v : null;
    if (!cell.exists && tableManager) {
        const info = tableManager.getCellInfo?.(r, c);
        if (info?.table && info.colDef) {
            if (info.rowType === 'data' && info.dataIndex >= 0) {
                rawV = info.table.getValue?.(info.dataIndex, info.colDef.id) ?? null;
            } else if (info.rowType === 'entry' && !info.colDef.isNonEntry) {
                rawV = info.table.entryBuffer?.[info.colDef.id] ?? null;
            } else if (info.rowType === 'header') {
                rawV = info.colDef.name ?? null;
            }
        }
    }

    const out = {
        v: rawV ?? null,
        isFormula: typeof rawV === 'string' && rawV.startsWith('='),
        displayValue,
    };
    if (cell.tfr) out.tfr = cell.tfr;
    if (ct) out.ct = ct;
    // Flat canonical formatting — only emit set props so empty cells stay tiny.
    // wrapText is tri-state (true/false/unset): emit it whenever explicitly set
    // so an explicit nowrap (false) round-trips. Other keys emit only when truthy.
    for (const k of FORMAT_KEYS) {
        const val = cell[k];
        if (k === 'wrapText') {
            if (val != null) out.wrapText = val;
        } else if (val != null && val !== false) {
            out[k] = val;
        }
    }
    return out;
}
