/**
 * CellPaintData - Builds the flat cell descriptor array used by CanvasRenderer.
 *
 * For each visible cell in a pane, produces an object with all information
 * needed to paint it: position (in canvas-relative CSS pixels), size,
 * content, style, selection state, and cell-type-specific data.
 *
 * Called once per render frame per pane (body, top, left, corner).
 *
 * ## Coordinate system
 * Canvas X/Y are relative to the top-left of the `<canvas>` element, which is
 * positioned at (HEADER_WIDTH, HEADER_HEIGHT) within the grid container.
 *
 * For frozen columns (col < frozenCols):  canvasX = colMetrics.offsetOf(col)
 * For scrollable columns:                 canvasX = colMetrics.offsetOf(col) - scrollLeft + frozenWidth
 *
 * Same pattern applies for rows.
 */

import { CELL_TYPE } from '../features/SheetRenderContext.svelte.js';
import { CellTypeRegistry } from '../cellTypes/index.js';

/**
 * @typedef {Object} CellPaintItem
 * @property {number} row
 * @property {number} col
 * @property {number} x          Canvas-relative CSS X
 * @property {number} y          Canvas-relative CSS Y
 * @property {number} width      CSS width
 * @property {number} height     CSS height
 * @property {boolean} selected
 * @property {boolean} isAnchor
 * @property {'text'|'checkbox'|'rating'|'url'|'table_header'|'table_entry'|'table_data'} renderType
 * @property {string} [displayValue]
 * @property {string|null} [bgColor]
 * @property {string|null} [textColor]
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [underline]
 * @property {boolean} [strikethrough]
 * @property {number|null} [fontSize]
 * @property {string|null} [fontFamily]
 * @property {'left'|'center'|'right'} [hAlign]
 * @property {'top'|'middle'|'bottom'} [vAlign]
 * @property {boolean} [wrapText]
 * @property {any} [rawValue]          For checkbox (boolean), rating (number)
 * @property {number} [ratingMax]      For rating cells
 * @property {{colName:string,sortIcon:string,hasFilter:boolean,filterActive:boolean}} [tableHeaderInfo]
 * @property {string} [placeholderText] For table entry cells
 * @property {{top?,right?,bottom?,left?}} [borders]
 */

/**
 * Whether a cell is within a selection range.
 * @param {number} row
 * @param {number} col
 * @param {{startRow:number,endRow:number,startCol:number,endCol:number}|null} selection
 */
function isInSelection(row, col, selection) {
    if (!selection) return false;
    return (
        row >= selection.startRow &&
        row <= selection.endRow &&
        col >= selection.startCol &&
        col <= selection.endCol
    );
}

/**
 * Match a conditional format condition.
 */
function matchesCondition(v, cond, threshold) {
    const n = Number(v);
    const t = Number(threshold);
    switch (cond) {
        case 'gt': return n > t;
        case 'lt': return n < t;
        case 'gte': return n >= t;
        case 'lte': return n <= t;
        case 'eq': return v == threshold;
        case 'neq': return v != threshold;
        case 'contains':
            return String(v).toLowerCase().includes(String(threshold).toLowerCase());
        default: return false;
    }
}

/**
 * Build a flat array of CellPaintItem objects for a single pane.
 *
 * @param {Object} params
 * @param {{start:number,end:number,count:number}} params.rowRange
 * @param {{start:number,end:number,count:number}} params.colRange
 * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} params.rowMetrics
 * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} params.colMetrics
 * @param {import('../features/SheetRenderContext.svelte.js').SheetRenderContext|null} params.renderContext
 * @param {import('../SheetStore.svelte.js').SheetStore|null} params.sheetStore
 * @param {import('../SpreadsheetSession.svelte.js').SpreadsheetSession|null} params.session
 * @param {import('../SelectionState.svelte.js').SelectionState|null} params.selectionState
 * @param {import('../FormulaEditState.svelte.js').FormulaEditState|null} params.formulaEditState
 * @param {number} params.frozenRows
 * @param {number} params.frozenCols
 * @param {number} params.frozenHeight  Frozen pane height in CSS px
 * @param {number} params.frozenWidth   Frozen pane width in CSS px
 * @param {number} params.scrollLeft    Horizontal scroll offset in CSS px
 * @param {number} params.scrollTop     Vertical scroll offset in CSS px
 * @returns {CellPaintItem[]}
 */
export function buildPaneData(params) {
    const {
        rowRange,
        colRange,
        rowMetrics,
        colMetrics,
        renderContext,
        sheetStore,
        session,
        selectionState,
        formulaEditState,
        frozenRows,
        frozenCols,
        frozenHeight,
        frozenWidth,
        scrollLeft,
        scrollTop,
    } = params;

    if (
        !rowRange || rowRange.count <= 0 ||
        !colRange || colRange.count <= 0 ||
        !rowMetrics || !colMetrics
    ) {
        return [];
    }

    const effectiveSheetStore = renderContext?.sheetStore ?? sheetStore;
    const selection = selectionState?.range ?? null;
    const anchor = selectionState?.anchor ?? null;

    /** @type {CellPaintItem[]} */
    const cells = [];

    for (let r = rowRange.start; r <= rowRange.end; r++) {
        const isFrozenRow = r < frozenRows;
        const y = isFrozenRow
            ? rowMetrics.offsetOf(r)
            : rowMetrics.offsetOf(r) - scrollTop + frozenHeight;
        const height = rowMetrics.sizeOf(r);

        for (let c = colRange.start; c <= colRange.end; c++) {
            // ── Cell type dispatch ────────────────────────────────────────────
            const cellType = renderContext?.getCellType(r, c) ?? CELL_TYPE.REGULAR;

            // Skip shadow and viewport-occupied cells (no rendering)
            if (
                cellType === CELL_TYPE.MERGE_SHADOW ||
                cellType === CELL_TYPE.VIEWPORT_OCCUPIED
            ) {
                continue;
            }

            const isFrozenCol = c < frozenCols;
            const x = isFrozenCol
                ? colMetrics.offsetOf(c)
                : colMetrics.offsetOf(c) - scrollLeft + frozenWidth;
            let width = colMetrics.sizeOf(c);

            // Merge span adjustments
            if (cellType === CELL_TYPE.MERGE_PRIMARY && renderContext) {
                const span = renderContext.getMergeSpan(r, c);
                if (span) {
                    width = colMetrics.offsetOf(c + span.colSpan) - colMetrics.offsetOf(c);
                    // height also needs to span rows
                    // (height is overwritten below using span)
                }
            }

            let spanHeight = height;
            if (cellType === CELL_TYPE.MERGE_PRIMARY && renderContext) {
                const span = renderContext.getMergeSpan(r, c);
                if (span) {
                    spanHeight = rowMetrics.offsetOf(r + span.rowSpan) - rowMetrics.offsetOf(r);
                    width = colMetrics.offsetOf(c + span.colSpan) - colMetrics.offsetOf(c);
                }
            }

            const selected = isInSelection(r, c, selection);
            const isAnchor = anchor?.row === r && anchor?.col === c;

            // ── Table cell types ──────────────────────────────────────────────
            if (
                cellType === CELL_TYPE.TABLE_HEADER ||
                cellType === CELL_TYPE.TABLE_ENTRY ||
                cellType === CELL_TYPE.TABLE_DATA
            ) {
                const info = renderContext?.tableManager?.getCellInfo(r, c);
                if (!info?.table) continue;

                const colIndex = info.table.colIndexForSheetCol(c);
                const colDef = info.table.columns?.[colIndex] ?? null;

                /** @type {CellPaintItem} */
                const item = {
                    row: r, col: c,
                    x, y, width, height: spanHeight,
                    selected, isAnchor,
                    renderType: 'text',
                    bgColor: null,
                    borders: null,
                };

                if (cellType === CELL_TYPE.TABLE_HEADER) {
                    item.renderType = 'table_header';
                    item.bgColor = '#f1f5f9';
                    item.tableHeaderInfo = {
                        colName: colDef?.name ?? '',
                        sortIcon: info.table.sortColId === colDef?.id
                            ? (info.table.sortDir === 'asc' ? '▲' : '▼')
                            : '',
                        hasFilter: !!(colDef?.id && info.table.filters?.get?.(colDef.id)),
                        filterActive: !!(colDef?.id && info.table.filters?.get?.(colDef.id)),
                    };
                } else if (cellType === CELL_TYPE.TABLE_ENTRY) {
                    item.renderType = 'table_entry';
                    item.bgColor = '#f8fafc';
                    item.placeholderText = colDef?.name ?? '';
                } else {
                    // TABLE_DATA
                    const ct = colDef?.ct;
                    const rawValue = (colDef && info.dataIndex >= 0)
                        ? info.table.getValue(info.dataIndex, colDef.id)
                        : null;

                    if (ct?.type === 'checkbox') {
                        item.renderType = 'checkbox';
                        item.rawValue = !!rawValue;
                    } else if (ct?.type === 'rating') {
                        item.renderType = 'rating';
                        item.rawValue = Number(rawValue) || 0;
                        item.ratingMax = ct.max || 5;
                    } else {
                        item.renderType = 'text';
                        const dispV = ct
                            ? CellTypeRegistry.formatValue(ct, rawValue)
                            : (rawValue != null ? String(rawValue) : '');
                        item.displayValue = dispV;
                        // Default alignment for numbers
                        if (ct?.type === 'number' || ct?.type === 'currency' || ct?.type === 'percent') {
                            item.hAlign = 'right';
                        } else {
                            item.hAlign = 'left';
                        }
                    }

                    // Conditional formatting for table data cells
                    if (colDef?.conditionalFormats?.length && rawValue != null) {
                        for (const fmt of colDef.conditionalFormats) {
                            if (matchesCondition(rawValue, fmt.condition, fmt.value)) {
                                if (fmt.style?.backgroundColor) item.bgColor = fmt.style.backgroundColor;
                                if (fmt.style?.color) item.textColor = fmt.style.color;
                                if (fmt.style?.bold) item.bold = true;
                                break;
                            }
                        }
                    }
                }

                cells.push(item);
                continue;
            }

            // ── Regular / Merge / Repeater cells ──────────────────────────────
            const mappedRow = cellType === CELL_TYPE.REPEATER
                ? (renderContext?.repeaterEngine?.getCellRepeaterContext(r, c)?.templateRow ?? r)
                : r;
            const mappedCol = cellType === CELL_TYPE.REPEATER
                ? (renderContext?.repeaterEngine?.getCellRepeaterContext(r, c)?.templateCol ?? c)
                : c;

            const sheetCell = effectiveSheetStore?.getCell(mappedRow, mappedCol);

            // Get display value
            let dispV;
            if (renderContext) {
                dispV = renderContext.getDisplayValue(r, c);
            } else if (session) {
                dispV = session.getCellDisplayValue(r, c);
            } else {
                dispV = sheetCell?.v ?? '';
            }

            // Cell type config
            const ct = renderContext?.getCellTypeConfig(r, c);
            const descriptor = ct ? CellTypeRegistry.get(ct.type) : null;

            /** @type {CellPaintItem} */
            const item = {
                row: r, col: c,
                x, y, width, height: spanHeight,
                selected, isAnchor,
                renderType: 'text',
                displayValue: '',
                bgColor: null,
                textColor: null,
                bold: false,
                italic: false,
                underline: false,
                strikethrough: false,
                fontSize: null,
                fontFamily: null,
                hAlign: 'left',
                vAlign: 'middle',
                wrapText: false,
                borders: null,
            };

            // Determine render type
            if (ct?.type === 'checkbox') {
                item.renderType = 'checkbox';
                item.rawValue = !!sheetCell?.v;
                item.hAlign = 'center';
            } else if (ct?.type === 'rating') {
                item.renderType = 'rating';
                item.rawValue = Number(sheetCell?.v) || 0;
                item.ratingMax = ct.max || 5;
                item.hAlign = 'center';
            } else if (ct?.type === 'url') {
                item.renderType = 'url';
                item.displayValue = dispV != null ? String(dispV) : '';
            } else {
                item.renderType = 'text';
                item.displayValue = dispV != null ? String(dispV) : '';

                // Apply type-level alignment defaults
                if (ct?.type === 'number' || ct?.type === 'currency' || ct?.type === 'percent') {
                    item.hAlign = 'right';
                }
                // Underline for URL type default
                if (descriptor?.defaultStyle?.()) {
                    const defStyle = descriptor.defaultStyle(ct);
                    if (defStyle.underline) item.underline = true;
                    if (defStyle.color && !sheetCell?.color) item.textColor = defStyle.color;
                }
            }

            // Apply cell formatting from SheetStore
            if (sheetCell?.exists) {
                if (sheetCell.backgroundColor) item.bgColor = sheetCell.backgroundColor;
                if (sheetCell.color) item.textColor = sheetCell.color;
                if (sheetCell.bold) item.bold = true;
                if (sheetCell.italic) item.italic = true;
                if (sheetCell.underline) item.underline = true;
                if (sheetCell.strikethrough) item.strikethrough = true;
                if (sheetCell.fontSize) item.fontSize = sheetCell.fontSize;
                if (sheetCell.fontFamily) item.fontFamily = sheetCell.fontFamily;
                if (sheetCell.horizontalAlign) item.hAlign = sheetCell.horizontalAlign;
                if (sheetCell.verticalAlign) item.vAlign = sheetCell.verticalAlign;
                if (sheetCell.wrapText) item.wrapText = true;
            }

            // Custom borders (sparse)
            if (effectiveSheetStore) {
                const b = effectiveSheetStore.getCellBorders(mappedRow, mappedCol);
                if (b && (b.top || b.right || b.bottom || b.left)) {
                    item.borders = b;
                }
            }

            // Formula highlight color (for formula edit mode reference visualization)
            const hlColor = formulaEditState?.getCellHighlightColor(r, c);
            if (hlColor) item.formulaHighlight = hlColor;

            cells.push(item);
        }
    }

    return cells;
}

export { CELL_TYPE };
