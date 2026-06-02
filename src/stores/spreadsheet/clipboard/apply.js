/**
 * clipboard/apply.js — the SINGLE writer. Every paste path funnels here.
 *
 * Consumes a normalized ClipboardModel + a destination range + a paste mode, and
 * performs the mutations. Caller is responsible for wrapping this in a Yjs
 * transaction. Table targets are delegated to tables/tableApply.js.
 */

import { adjustByOffset } from '../../../formulas/refs.js';
import { FORMAT_KEYS, isCellContentEmpty, cellHasFormatting } from './model.js';
import { resolvePastePlan } from './pasteModes.js';
import { tryTablePaste, tryClearTableCell } from './tables/tableApply.js';

/**
 * Apply a full model (handles multi-range) at a destination top-left.
 *
 * @param {object} ctx { sheetStore, session }
 * @param {object} model  ClipboardModel
 * @param {{startRow,endRow,startCol,endCol}} targetRange
 * @param {import('./pasteModes.js').PasteMode} mode
 * @param {boolean} isInternal
 */
export function applyModel(ctx, model, targetRange, mode, isInternal) {
    const regions = model.regions ?? [];
    if (regions.length <= 1) {
        applyRegion(ctx, regions[0], targetRange, mode, isInternal);
        return;
    }
    // Multi-range: offset every region by (target - firstSource) top-left delta.
    const firstSrc = regions[0].range;
    const offsetRow = targetRange.startRow - firstSrc.startRow;
    const offsetCol = targetRange.startCol - firstSrc.startCol;
    for (const region of regions) {
        const dest = {
            startRow: region.range.startRow + offsetRow, endRow: region.range.endRow + offsetRow,
            startCol: region.range.startCol + offsetCol, endCol: region.range.endCol + offsetCol,
        };
        applyRegion(ctx, region, dest, mode, isInternal);
    }
}

/**
 * Apply one region into a destination range.
 */
export function applyRegion(ctx, region, targetRange, mode, isInternal) {
    if (!region) return;
    const { sheetStore } = ctx;
    const { cells } = region;
    const srcRowCount = region.rowCount || cells.length;
    const srcColCount = region.colCount || cells[0]?.length || 0;
    if (srcRowCount === 0 || srcColCount === 0) return;

    const destStartRow = targetRange.startRow;
    const destStartCol = targetRange.startCol;

    // ── Table target → delegate ─────────────────────────────────────────────────
    if (tryTablePaste(ctx, region, { startRow: destStartRow, startCol: destStartCol })) return;

    const isSingleCell = srcRowCount === 1 && srcColCount === 1;
    const destEndRow = isSingleCell ? targetRange.endRow : destStartRow + srcRowCount - 1;
    const destEndCol = isSingleCell ? targetRange.endCol : destStartCol + srcColCount - 1;

    const plan = resolvePastePlan(mode, isInternal);

    for (let r = destStartRow; r <= destEndRow; r++) {
        for (let c = destStartCol; c <= destEndCol; c++) {
            const srcRow = isSingleCell ? 0 : (r - destStartRow) % srcRowCount;
            const srcCol = isSingleCell ? 0 : (c - destStartCol) % srcColCount;
            const cell = cells[srcRow]?.[srcCol];
            if (!cell) continue;

            // "full" paste: an empty source cell clears the destination.
            if (plan.replaceStructure && isCellContentEmpty(cell)) {
                sheetStore.clearCell(r, c);
                if (!plan.includesFormatting || !cellHasFormatting(cell)) continue;
            }

            // Formula offset = dest minus the source cell's absolute position.
            // region.range holds absolute coords for internal copies and 0-based for
            // external, so r - (region.range.start + srcRow) is correct for both.
            const rowOffset = r - (region.range.startRow + srcRow);
            const colOffset = c - (region.range.startCol + srcCol);

            if (plan.formulasOnly) {
                applyFormulaOnly(sheetStore, cell, r, c, rowOffset, colOffset, isInternal);
            } else if (plan.includesFormulas && (cell.isFormula || cell.formula)) {
                applyValue(sheetStore, cell, r, c, rowOffset, colOffset, isInternal);
            } else if (plan.includesValues) {
                applyValueOnly(sheetStore, cell, r, c);
            }

            if (plan.includesFormatting) applyFormatting(sheetStore, cell, r, c, plan.clearAbsentStyleProps);
        }
    }

    if (plan.includesFormatting && plan.includesBorders && region.borders?.length > 0) {
        applyBorders(sheetStore, region, isSingleCell, destStartRow, destStartCol, destEndRow, destEndCol, plan.clearExistingBorders);
    }

    if (plan.replaceStructure && !isSingleCell) {
        // Unmerge first so an unmerged source cleanly drops destination merges.
        sheetStore.mergeEngine?.unmergeRange?.(destStartRow, destEndRow, destStartCol, destEndCol);
        for (const m of (region.merges || [])) {
            sheetStore.mergeCells?.(
                destStartRow + m.relStartRow, destStartCol + m.relStartCol,
                destStartRow + m.relEndRow,   destStartCol + m.relEndCol,
            );
        }
    }

    if (plan.replaceStructure) {
        for (const rule of (region.dataValidations || [])) {
            sheetStore.addDataValidation?.({
                ...rule, id: newId(),
                startRow: destStartRow + (rule.startRow || 0), startCol: destStartCol + (rule.startCol || 0),
                endRow:   destStartRow + (rule.endRow   || 0), endCol:   destStartCol + (rule.endCol   || 0),
            });
        }
        for (const rule of (region.conditionalFormats || [])) {
            sheetStore.addConditionalFormat?.({
                ...rule, id: newId(),
                startRow: destStartRow + (rule.startRow || 0), startCol: destStartCol + (rule.startCol || 0),
                endRow:   destStartRow + (rule.endRow   || 0), endCol:   destStartCol + (rule.endCol   || 0),
            });
        }
        if (!isSingleCell && region.rowHeights) {
            for (let i = 0; i < region.rowHeights.length; i++) {
                if (region.rowHeights[i] != null) sheetStore.setRowHeight?.(destStartRow + i, region.rowHeights[i]);
            }
        }
    }
}

// ─── Cut-source clearing (deferred cut) ────────────────────────────────────────

/**
 * Clear a source range the way Excel-style cut does: value + formatting + borders
 * + merges, so the source ends up indistinguishable from an empty rectangle.
 * Table cells are cleared through the TableStore (formatting stays on the table).
 * Caller wraps this in a Yjs transaction.
 *
 * @param {object} ctx { sheetStore, session }
 * @param {{startRow,endRow,startCol,endCol}} range
 */
export function clearSourceRange(ctx, range) {
    const { sheetStore, session } = ctx;
    const { startRow, endRow, startCol, endCol } = range;
    for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
            if (tryClearTableCell(session, r, c)) continue;
            sheetStore.clearCell(r, c);
        }
    }
    sheetStore.clearBordersInRange?.(startRow, endRow, startCol, endCol);
    sheetStore.mergeEngine?.unmergeRange?.(startRow, endRow, startCol, endCol);
}

// ─── Per-cell writers ──────────────────────────────────────────────────────────

function applyValue(sheetStore, cell, row, col, rowOffset, colOffset, isInternal) {
    if (cell.formula) {
        sheetStore.setCellFormula(row, col, adjustByOffset(cell.formula, rowOffset, colOffset));
        return;
    }
    if (!isInternal && cell.isFormula && typeof cell.v === 'string' && cell.v.startsWith('=')) {
        sheetStore.setCellFormula(row, col, adjustByOffset(cell.v, rowOffset, colOffset));
        return;
    }
    if (cell.isFormula && isInternal && cell.v) {
        sheetStore.setCellFormula(row, col, adjustByOffset(cell.v, rowOffset, colOffset));
    } else if (cell.v !== null && cell.v !== undefined) {
        if (cell.tfr) sheetStore.setCellValueWithRuns(row, col, String(cell.v), cell.tfr);
        else sheetStore.setCellValue(row, col, cell.v);
    }
}

function applyValueOnly(sheetStore, cell, row, col) {
    // Formula cell, values-only: paste its cached computed result. If the cache is
    // missing or just mirrors the formula string, clear rather than paste "=…".
    const isFormulaCell = cell.isFormula || cell.formula;
    if (isFormulaCell) {
        const dv = cell.displayValue;
        const formulaStr = cell.formula || (typeof cell.v === 'string' ? cell.v : null);
        const usable = dv !== null && dv !== undefined && dv !== '' && dv !== formulaStr;
        if (usable) sheetStore.setCellValue(row, col, dv);
        else sheetStore.clearCell(row, col);
        return;
    }
    const value = cell.v ?? cell.displayValue;
    if (value !== null && value !== undefined) {
        if (cell.tfr) sheetStore.setCellValueWithRuns(row, col, String(value), cell.tfr);
        else sheetStore.setCellValue(row, col, value);
    }
}

function applyFormulaOnly(sheetStore, cell, row, col, rowOffset, colOffset, isInternal) {
    if (cell.formula) {
        sheetStore.setCellFormula(row, col, adjustByOffset(cell.formula, rowOffset, colOffset));
    } else if (typeof cell.v === 'string' && cell.v.startsWith('=')) {
        sheetStore.setCellFormula(row, col, adjustByOffset(cell.v, rowOffset, colOffset));
    } else if (cell.isFormula && isInternal && cell.v) {
        sheetStore.setCellFormula(row, col, adjustByOffset(cell.v, rowOffset, colOffset));
    }
}

function applyFormatting(sheetStore, cell, row, col, clearAbsentProps) {
    const props = {};
    for (const k of FORMAT_KEYS) {
        if (cell[k] != null && cell[k] !== false) props[k] = cell[k];
        else if (clearAbsentProps) props[k] = null; // null/false flushes the key in SheetStore
    }
    if (Object.keys(props).length > 0) sheetStore.setCellProperties(row, col, props);
    if (cell.ct) sheetStore.setCellTypeConfig(row, col, cell.ct);
    else if (clearAbsentProps) sheetStore.setCellTypeConfig(row, col, null);
}

function applyBorders(sheetStore, region, isSingleCell, destStartRow, destStartCol, destEndRow, destEndCol, clearExisting) {
    const borders = region.borders;
    // Single-cell tile over a larger selection: replicate the source borders into
    // every destination tile (all source borders are at rel 0,0).
    if (isSingleCell && (destEndRow > destStartRow || destEndCol > destStartCol)) {
        if (clearExisting) sheetStore.clearBordersInRange(destStartRow, destEndRow, destStartCol, destEndCol);
        for (let r = destStartRow; r <= destEndRow; r++) {
            for (let c = destStartCol; c <= destEndCol; c++) {
                for (const b of borders) sheetStore.setCellBorder(r, c, b.edge, { style: b.style, width: b.width, color: b.color });
            }
        }
        return;
    }
    if (clearExisting) sheetStore.clearBordersInRange(destStartRow, destEndRow, destStartCol, destEndCol);
    for (const b of borders) {
        const row = destStartRow + b.relRow;
        const col = destStartCol + b.relCol;
        if (row < destStartRow || row > destEndRow || col < destStartCol || col > destEndCol) continue;
        sheetStore.setCellBorder(row, col, b.edge, { style: b.style, width: b.width, color: b.color });
    }
}

function newId() {
    return crypto.randomUUID?.() || Math.random().toString(36).slice(2);
}
