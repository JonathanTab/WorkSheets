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
import { COLUMN_TYPE_ICONS } from '../features/TableStore.svelte.js';
import { isRichText, isRichTextArray, richTextToPlain, htmlStringToRuns } from '../richText.js';

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
 * @property {{colName:string,sortIcon:string,hasFilter:boolean,filterActive:boolean,typeIcon?:string,isFormula?:boolean,accentColor?:string,isFirstCol?:boolean,isLastCol?:boolean}} [tableHeaderInfo]
 * @property {string} [placeholderText] For table entry cells
 * @property {boolean} [isNonEntryCol]  For table entry cells — formula columns
 * @property {{top?,right?,bottom?,left?}} [borders]
 * @property {string} [formulaHighlight] Formula edit mode reference highlight color
 * @property {boolean} [isFirstTableCol] True for the leftmost column in a table
 * @property {string} [tableAccentColor] Table's accent color
 * @property {boolean} [isFormulaCol]   True for computed/formula columns
 * @property {boolean} [zebraRow]       True for even data rows (zebra striping)
 * @property {boolean} [isRepeaterCopy] True for non-template repeater cells (visual dimming)
 * @property {Array|null} [richTextRuns] Rich-text run array when cell value is rich text
 */

/**
 * Whether a cell is within the selection (supports all selectionMode values).
 * @param {number} row
 * @param {number} col
 * @param {import('../SelectionState.svelte.js').SelectionState|null} selectionState
 * @param {number} rowCount
 * @param {number} colCount
 */
function isInSelection(row, col, selectionState, rowCount, colCount) {
    if (!selectionState) return false;
    return selectionState.isSelected(row, col, rowCount, colCount);
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
    const anchor = selectionState?.anchor ?? null;
    const rowCount = effectiveSheetStore?.rowCount ?? 0;
    const colCount = effectiveSheetStore?.colCount ?? 0;

    /** @type {CellPaintItem[]} */
    const cells = [];

    // Track overflow extents for each row to skip shadow cells
    // Map of row -> { cellCol: overflowRightX }
    const overflowMap = new Map();

    for (let r = rowRange.start; r <= rowRange.end; r++) {
        const isFrozenRow = r < frozenRows;
        const y = isFrozenRow
            ? rowMetrics.offsetOf(r)
            : rowMetrics.offsetOf(r) - scrollTop + frozenHeight;
        const height = rowMetrics.sizeOf(r);

        // Reset overflow tracker for this row
        const rowOverflowMap = new Map();

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

            // Check for overflow-shadowed cells (same row, previous cols had overflow)
            let isOverflowShadow = false;
            for (const prevCol of rowOverflowMap.keys()) {
                if (prevCol < c) {
                    const overflowRightX = rowOverflowMap.get(prevCol);
                    if (x < overflowRightX) {
                        isOverflowShadow = true;
                        break;
                    }
                }
            }

            // Skip rendering cells that are shadowed by overflow (they'll be covered by the overflow cell)
            if (isOverflowShadow && cellType === CELL_TYPE.REGULAR) {
                continue;
            }

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

            const selected = isInSelection(r, c, selectionState, rowCount, colCount);
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

                // Build a ct-compatible config object from column type string
                const colCt = colDef?.type ? { type: colDef.type } : null;

                // Column index within the table (first col = 0)
                const isFirstCol = colIndex === 0;
                const isLastCol = colIndex === (info.table.columns.length - 1);
                const accentColor = info.table.accentColor ?? '#3b82f6';

                /** @type {CellPaintItem} */
                const item = {
                    row: r, col: c,
                    x, y, width, height: spanHeight,
                    selected, isAnchor,
                    renderType: 'text',
                    bgColor: null,
                    borders: null,
                    isFirstTableCol: isFirstCol,
                    tableAccentColor: accentColor,
                };

                if (cellType === CELL_TYPE.TABLE_HEADER) {
                    item.renderType = 'table_header';
                    item.bgColor = '#f1f5f9';
                    item.tableHeaderInfo = {
                        colName: colDef?.name ?? '',
                        sortIcon: info.table.sortColId === colDef?.id
                            ? (info.table.sortDir === 'asc' ? '▲' : '▼')
                            : '',
                        hasFilter: !!(colDef?.id && info.table.filters?.[colDef.id]),
                        filterActive: !!(colDef?.id && info.table.filters?.[colDef.id]),
                        typeIcon: colDef?.type ? (COLUMN_TYPE_ICONS[colDef.type] ?? 'A') : 'A',
                        isFormula: colDef?.isNonEntry ?? false,
                        accentColor,
                        isFirstCol,
                        isLastCol,
                    };
                } else if (cellType === CELL_TYPE.TABLE_ENTRY) {
                    item.renderType = 'table_entry';
                    item.bgColor = '#f8fafc';
                    item.placeholderText = colDef?.isNonEntry ? '=' : (colDef?.name ?? '');
                    item.isNonEntryCol = colDef?.isNonEntry ?? false;
                } else {
                    // TABLE_DATA
                    const rawValue = (colDef && info.dataIndex >= 0)
                        ? info.table.getValue(info.dataIndex, colDef.id)
                        : null;

                    const colType = colDef?.type ?? 'text';

                    if (colType === 'checkbox') {
                        item.renderType = 'checkbox';
                        item.rawValue = !!rawValue;
                    } else if (colType === 'rating') {
                        item.renderType = 'rating';
                        item.rawValue = Number(rawValue) || 0;
                        item.ratingMax = 5; // default; can be extended per-column
                    } else {
                        item.renderType = 'text';
                        const dispV = colCt
                            ? CellTypeRegistry.formatValue(colCt, rawValue)
                            : (rawValue != null ? String(rawValue) : '');
                        item.displayValue = dispV;
                        // Column-level alignment (column def overrides type default)
                        if (colDef?.hAlign) {
                            item.hAlign = colDef.hAlign;
                        } else if (colType === 'number' || colType === 'currency' || colType === 'percent') {
                            item.hAlign = 'right';
                        } else {
                            item.hAlign = 'left';
                        }
                    }

                    // Column-level color overrides
                    if (colDef?.bgColor) item.bgColor = colDef.bgColor;
                    if (colDef?.textColor) item.textColor = colDef.textColor;

                    // Formula column indicator
                    item.isFormulaCol = colDef?.isNonEntry ?? false;

                    // Zebra striping (even rows get a subtle tint)
                    if (info.dataIndex % 2 === 0 && !item.bgColor) {
                        item.zebraRow = true;
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
            const repeaterCtx = cellType === CELL_TYPE.REPEATER
                ? renderContext?.repeaterEngine?.getCellRepeaterContext(r, c)
                : null;
            const isRepeaterCopy = !!(repeaterCtx && repeaterCtx.repIndex > 0);
            const mappedRow = repeaterCtx ? repeaterCtx.templateRow : r;
            const mappedCol = repeaterCtx ? repeaterCtx.templateCol : c;

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

            // Cell type config — for repeater cells use template cell coords
            const ct = renderContext?.getCellTypeConfig(mappedRow, mappedCol);
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
                isRepeaterCopy,
            };

            // For merged primary cells, default to top vertical alignment (supports paragraph-style text)
            // This can be overridden by explicit formatting
            if (cellType === CELL_TYPE.MERGE_PRIMARY) {
                item.vAlign = 'top';
            }

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

                // Apply cell type formatting
                let formattedValue = dispV;
                if (ct && dispV != null && dispV !== '') {
                    formattedValue = CellTypeRegistry.formatValue(ct, dispV);
                }

                if (isRichText(formattedValue)) {
                    // New format: HTML string — convert to runs for canvas renderer
                    item.richTextRuns = htmlStringToRuns(formattedValue);
                    item.displayValue = richTextToPlain(formattedValue);
                } else if (isRichTextArray(formattedValue)) {
                    // Legacy format: run array — use directly
                    item.richTextRuns = formattedValue;
                    item.displayValue = richTextToPlain(formattedValue);
                } else {
                    item.displayValue = formattedValue != null ? String(formattedValue) : '';
                }

                // Apply type-level alignment defaults
                if (ct?.type === 'number' || ct?.type === 'currency' || ct?.type === 'percent') {
                    item.hAlign = 'right';
                } else if (!ct) {
                    // No explicit type — infer right-align for raw numeric values
                    const rawVal = sheetCell?.v;
                    if (typeof rawVal === 'number') {
                        item.hAlign = 'right';
                    }
                }
                // Underline for URL type default
                if (descriptor?.defaultStyle?.()) {
                    const defStyle = descriptor.defaultStyle(ct);
                    if (defStyle.underline) item.underline = true;
                    if (defStyle.color && !sheetCell?.color) item.textColor = defStyle.color;
                }
            }

            // Apply formatting: col-level → row-level → cell-level (cell wins)
            // Col-level formatting (lowest priority)
            const colFmt = effectiveSheetStore?.getColFormatting?.(mappedCol);
            if (colFmt) {
                if (colFmt.backgroundColor) item.bgColor = colFmt.backgroundColor;
                if (colFmt.color) item.textColor = colFmt.color;
                if (colFmt.bold) item.bold = true;
                if (colFmt.italic) item.italic = true;
                if (colFmt.underline) item.underline = true;
                if (colFmt.strikethrough) item.strikethrough = true;
                if (colFmt.fontSize) item.fontSize = colFmt.fontSize;
                if (colFmt.fontFamily) item.fontFamily = colFmt.fontFamily;
                if (colFmt.horizontalAlign) item.hAlign = colFmt.horizontalAlign;
                if (colFmt.verticalAlign) item.vAlign = colFmt.verticalAlign;
                if (colFmt.wrapText) item.wrapText = true;
            }
            // Row-level formatting (overrides col)
            const rowFmt = effectiveSheetStore?.getRowFormatting?.(mappedRow);
            if (rowFmt) {
                if (rowFmt.backgroundColor) item.bgColor = rowFmt.backgroundColor;
                if (rowFmt.color) item.textColor = rowFmt.color;
                if (rowFmt.bold) item.bold = true;
                if (rowFmt.italic) item.italic = true;
                if (rowFmt.underline) item.underline = true;
                if (rowFmt.strikethrough) item.strikethrough = true;
                if (rowFmt.fontSize) item.fontSize = rowFmt.fontSize;
                if (rowFmt.fontFamily) item.fontFamily = rowFmt.fontFamily;
                if (rowFmt.horizontalAlign) item.hAlign = rowFmt.horizontalAlign;
                if (rowFmt.verticalAlign) item.vAlign = rowFmt.verticalAlign;
                if (rowFmt.wrapText) item.wrapText = true;
            }
            // Cell-level formatting (highest priority, overrides row/col)
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
            // For merged cells, get borders from the exterior edges of the merged region
            if (effectiveSheetStore) {
                let borderRow = mappedRow;
                let borderCol = mappedCol;
                let endBorderRow = mappedRow;
                let endBorderCol = mappedCol;

                // For merged cells, adjust to exterior edges
                if (cellType === CELL_TYPE.MERGE_PRIMARY && renderContext) {
                    const span = renderContext.getMergeSpan(r, c);
                    if (span) {
                        // Exterior edges: use first row/col for top/left, last row/col for bottom/right
                        endBorderRow = mappedRow + span.rowSpan - 1;
                        endBorderCol = mappedCol + span.colSpan - 1;
                    }
                }

                // Get borders from exterior edges
                const borders = {
                    top: effectiveSheetStore.getCellBorders(borderRow, borderCol).top,
                    bottom: effectiveSheetStore.getCellBorders(endBorderRow, borderCol).bottom,
                    left: effectiveSheetStore.getCellBorders(borderRow, borderCol).left,
                    right: effectiveSheetStore.getCellBorders(borderRow, endBorderCol).right,
                };

                if (borders.top || borders.right || borders.bottom || borders.left) {
                    item.borders = borders;
                }
            }

            // Formula highlight color (for formula edit mode reference visualization)
            const hlColor = formulaEditState?.getCellHighlightColor(r, c);
            if (hlColor) item.formulaHighlight = hlColor;

            // Cell spillover: extend width into adjacent empty cells for text cells without wrapping
            if (
                cellType === CELL_TYPE.REGULAR &&
                item.renderType === 'text' &&
                !item.wrapText &&
                item.displayValue &&
                renderContext
            ) {
                const overflowExtent = renderContext.getOverflowExtent(r, c, colRange.end, colMetrics);
                if (overflowExtent > 0) {
                    item.width += overflowExtent;
                    // Track this overflow so we can skip shadow cells
                    const overflowRightX = item.x + item.width;
                    rowOverflowMap.set(c, overflowRightX);
                }
            }

            cells.push(item);
        }
    }

    return cells;
}

export { CELL_TYPE };
