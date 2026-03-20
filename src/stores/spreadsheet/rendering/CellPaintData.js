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
import { isRichText, htmlStringToRuns, runsToPlainText } from '../richText.js';

/**
 * @typedef {Object} CellPaintItem
 * @property {number} row
 * @property {number} col
 * @property {number} x          Canvas-relative CSS X
 * @property {number} y          Canvas-relative CSS Y
 * @property {number} width      CSS width
 * @property {number} height     CSS height
 * @property {boolean} [selected]  @deprecated  Selection is now on the SelectionRenderer canvas
 * @property {boolean} [isAnchor]  @deprecated  Selection is now on the SelectionRenderer canvas
 * @property {'text'|'checkbox'|'rating'|'url'|'image'|'table_header'|'table_entry'|'table_data'} renderType
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
 * @property {any} [rawValue]          For checkbox (boolean), rating (number), image (string blobId)
 * @property {number} [ratingMax]      For rating cells
 * @property {any} [ctConfig]          Raw cell type config object (used by image type for fit mode)
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
 * Check if a cell value passes a data validation rule.
 * @param {*} value
 * @param {Object} rule
 * @returns {boolean} true = valid
 */
function checkDvRule(value, rule) {
    if (rule.type === 'list') {
        const opts = rule.options || [];
        return opts.length === 0 || opts.includes(String(value));
    }
    const num = Number(value);
    if (rule.type === 'number') {
        if (isNaN(num)) return false;
        return matchesCondition(num, rule.condition, rule.min) &&
            (rule.condition !== 'between' || num <= Number(rule.max));
    }
    if (rule.type === 'text') {
        const len = String(value).length;
        return matchesCondition(len, rule.condition, rule.min) &&
            (rule.condition !== 'between' || len <= Number(rule.max));
    }
    return true;
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

    /** @type {CellPaintItem[]} */
    const cells = [];

    // Hoist sheet-level rule lookups outside the cell loops — same value for every cell
    const cfRules = effectiveSheetStore?.getConditionalFormats?.() ?? null;
    const dvRules = effectiveSheetStore?.getDataValidations?.() ?? null;

    // Pre-fetch column formatting once per visible column (not once per cell).
    // getColFormatting hits Yjs Y.Map on every call, so calling it per-cell in a
    // rows×cols loop dominates buildPaneData cost.
    const colFmtCache = new Array(colRange.end + 1);
    if (effectiveSheetStore?.getColFormatting) {
        for (let c = colRange.start; c <= colRange.end; c++) {
            colFmtCache[c] = effectiveSheetStore.getColFormatting(c);
        }
    }

    // Track overflow extents for each row to skip shadow cells
    // Map of row -> { cellCol: overflowRightX }
    const overflowMap = new Map();

    // Merge primaries whose primary row/col is outside the current range (scrolled off-screen).
    // These are collected from MERGE_SHADOW cells and painted after the main loop so that
    // merged cells remain visible even when their primary row is above the viewport.
    // key = "pr,pc" → full merge record { startRow, startCol, endRow, endCol }
    const reanchoredPrimaries = new Map();

    for (let r = rowRange.start; r <= rowRange.end; r++) {
        const isFrozenRow = r < frozenRows;
        const y = isFrozenRow
            ? rowMetrics.offsetOf(r)
            : rowMetrics.offsetOf(r) - scrollTop + frozenHeight;
        const height = rowMetrics.sizeOf(r);

        // Track the rightmost overflow edge seen so far in this row.
        // Cells whose left edge falls within this boundary are overflow shadows.
        let rowOverflowRightX = -Infinity;

        // Cache row-level formatting once per row (shared by all columns in this row)
        // mappedRow for repeaters is resolved per-cell, but for non-repeater rows it's always r
        // We cache the non-repeater case here; repeater cells will re-fetch inside the loop
        const rowFmtCache = effectiveSheetStore?.getRowFormatting?.(r);

        for (let c = colRange.start; c <= colRange.end; c++) {
            // ── Cell type dispatch ────────────────────────────────────────────
            const cellType = renderContext?.getCellType(r, c) ?? CELL_TYPE.REGULAR;

            // Skip viewport-occupied cells (no rendering)
            if (cellType === CELL_TYPE.VIEWPORT_OCCUPIED) {
                continue;
            }

            // Merge shadow cells have no content of their own — their primary renders them.
            // But if the primary is outside the current row/col range (scrolled off-screen),
            // queue it so the merged region stays visible via re-anchoring below.
            if (cellType === CELL_TYPE.MERGE_SHADOW) {
                if (renderContext?.mergeEngine) {
                    const merge = renderContext.mergeEngine.getMergeAt(r, c);
                    if (merge) {
                        const pr = merge.startRow, pc = merge.startCol;
                        const key = `${pr},${pc}`;
                        if (!reanchoredPrimaries.has(key) &&
                            (pr < rowRange.start || pc < colRange.start)) {
                            reanchoredPrimaries.set(key, merge);
                        }
                    }
                }
                continue;
            }

            const isFrozenCol = c < frozenCols;
            const x = isFrozenCol
                ? colMetrics.offsetOf(c)
                : colMetrics.offsetOf(c) - scrollLeft + frozenWidth;
            let width = colMetrics.sizeOf(c);

            // Check for overflow-shadowed cells: left edge is within a prior cell's overflow
            const isOverflowShadow = x < rowOverflowRightX;

            // Overflow-shadow cells: skip content but include for gridlines only
            if (isOverflowShadow && cellType === CELL_TYPE.REGULAR) {
                cells.push({
                    row: r, col: c,
                    x, y, width, height,
                    renderType: 'text',
                    gridlineOnly: true,
                });
                continue;
            }

            // Merge span adjustments — fetch span once and apply to both width and height
            let spanHeight = height;
            if (cellType === CELL_TYPE.MERGE_PRIMARY && renderContext) {
                const span = renderContext.getMergeSpan(r, c);
                if (span) {
                    width = colMetrics.offsetOf(c + span.colSpan) - colMetrics.offsetOf(c);
                    spanHeight = rowMetrics.offsetOf(r + span.rowSpan) - rowMetrics.offsetOf(r);
                }
            }

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
                    item.bgColor = '#ffffff'; /* White like regular cells */
                    item.isNonEntryCol = colDef?.isNonEntry ?? false;
                    // Show already-typed entry buffer value if present; otherwise placeholder.
                    const entryVal = colDef && !colDef.isNonEntry
                        ? info.table.entryBuffer?.[colDef.id]
                        : undefined;
                    if (entryVal !== undefined && entryVal !== null && entryVal !== '') {
                        item.displayValue = String(entryVal);
                    } else {
                        item.placeholderText = colDef?.isNonEntry ? '=' : (colDef?.name ?? '');
                    }
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

            // Cell type config — for repeater cells use template cell coords
            const ct = renderContext?.getCellTypeConfig(mappedRow, mappedCol);

            // Get display value — use fast path that avoids redundant
            // getCellType lookup (caller already resolved it)
            let dispV;
            if (renderContext) {
                dispV = renderContext.getRawDisplayValue(r, c, cellType);
            } else if (session) {
                dispV = session.getCellDisplayValue(r, c);
            } else {
                dispV = sheetCell?.v ?? '';
            }
            const descriptor = ct ? CellTypeRegistry.get(ct.type) : null;

            /** @type {CellPaintItem} */
            const item = {
                row: r, col: c,
                x, y, width, height: spanHeight,
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
                _descriptor: null, // pre-resolved CellTypeRegistry descriptor for paint
                // clipContent: set to true below only for cells that actually need clipping
                // (rich text, wrap, overflow, table headers). Plain text cells skip
                // ctx.save()/ctx.restore() entirely — that call is expensive in Chrome.
                clipContent: false,
            };

            // For merged primary cells, default to top vertical alignment (supports paragraph-style text)
            // This can be overridden by explicit formatting
            if (cellType === CELL_TYPE.MERGE_PRIMARY) {
                item.vAlign = 'top';
            }

            // Pre-resolve descriptor for custom paint during rendering
            if (descriptor?.paintCell) {
                item._descriptor = descriptor;
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
            } else if (ct?.type === 'dropdown') {
                item.renderType = 'dropdown';
                item.displayValue = dispV != null ? String(dispV) : '';
                item.dropdownOptions = ct.options || [];
            } else if (ct?.type === 'image') {
                item.renderType = 'image';
                item.rawValue = sheetCell?.v ?? null; // blob ID string
                item.ctConfig = ct;
                item.clipContent = true;
                item.hAlign = 'center';
                item.vAlign = 'middle';
            } else {
                item.renderType = 'text';

                // Apply cell type formatting
                let formattedValue = dispV;
                if (ct && dispV != null && dispV !== '') {
                    formattedValue = CellTypeRegistry.formatValue(ct, dispV);
                }

                if (isRichText(formattedValue)) {
                    const runs = htmlStringToRuns(formattedValue);
                    item.richTextRuns = runs;
                    item.displayValue = runsToPlainText(runs);
                    item.clipContent = true;
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
            // Col-level formatting (lowest priority) — use pre-built cache (populated above)
            const colFmt = colFmtCache[mappedCol] ?? null;
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
            // Use pre-cached value for non-repeater cells; re-fetch for repeater rows
            const rowFmt = (mappedRow === r) ? rowFmtCache : effectiveSheetStore?.getRowFormatting?.(mappedRow);
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

                // Get borders from exterior edges — cache the top-left lookup to avoid double call
                const tlBorders = effectiveSheetStore.getCellBorders(borderRow, borderCol);
                const borders = {
                    top: tlBorders.top,
                    left: tlBorders.left,
                    bottom: effectiveSheetStore.getCellBorders(endBorderRow, borderCol).bottom,
                    right: effectiveSheetStore.getCellBorders(borderRow, endBorderCol).right,
                };

                if (borders.top || borders.right || borders.bottom || borders.left) {
                    item.borders = borders;
                }
            }

            // Sheet-level conditional formatting — uses computed display value (dispV)
            // so formula cells compare their result rather than the formula string
            // (cfRules hoisted above the loops for performance)
            if (cfRules?.length) {
                const cfVal = dispV ?? sheetCell?.v;
                for (const rule of cfRules) {
                    if (r < rule.startRow || r > rule.endRow) continue;
                    if (c < rule.startCol || c > rule.endCol) continue;
                    if (matchesCondition(cfVal, rule.condition, rule.threshold)) {
                        if (rule.style?.backgroundColor) item.bgColor = rule.style.backgroundColor;
                        if (rule.style?.color) item.textColor = rule.style.color;
                        if (rule.style?.bold) item.bold = true;
                        if (rule.style?.italic) item.italic = true;
                        break; // First matching rule wins
                    }
                }
            }

            // Data validation — mark cells with invalid values for red-outline rendering
            // (dvRules hoisted above the loops for performance)
            if (dvRules?.length) {
                const cellVal = sheetCell?.v;
                if (cellVal != null && cellVal !== '') {
                    for (const rule of dvRules) {
                        if (r < rule.startRow || r > rule.endRow) continue;
                        if (c < rule.startCol || c > rule.endCol) continue;
                        if (!checkDvRule(cellVal, rule)) {
                            item.dvInvalid = true;
                        }
                        break;
                    }
                }
            }

            // Cell spillover: extend width into adjacent empty cells for plain text only.
            // Rich text cells always clip, and their HTML string would give wrong measurements.
            if (
                cellType === CELL_TYPE.REGULAR &&
                item.renderType === 'text' &&
                !item.wrapText &&
                !item.richTextRuns &&
                item.displayValue &&
                renderContext
            ) {
                const overflowExtent = renderContext.getOverflowExtent(r, c, colRange.end, colMetrics, item.displayValue, sheetCell);
                if (overflowExtent > 0) {
                    // Preserve natural column width so gridlines stay at column boundaries
                    item.naturalWidth = width;
                    item.width += overflowExtent;
                    // Track the furthest overflow edge so subsequent cells can detect shadows
                    const overflowRightX = item.x + item.width;
                    if (overflowRightX > rowOverflowRightX) rowOverflowRightX = overflowRightX;
                }
            }

            // Mark cells that need content clipping (ctx.save/clip/restore in renderer).
            // wrapText and merged cells need clipping; so do table headers (complex layout).
            // Plain single-line text cells that don't overflow are left as clipContent:false.
            if (item.wrapText || cellType === CELL_TYPE.MERGE_PRIMARY) {
                item.clipContent = true;
            }
            // Non-text render types have their own internal layout that can overflow
            if (item.renderType !== 'text' && item.renderType !== 'url' && item.renderType !== 'dropdown') {
                item.clipContent = true;
            }

            cells.push(item);
        }
    }

    // ── Re-anchor merge primaries that scrolled outside the visible range ─────
    // For each queued merge, build a paint item at the primary's true canvas
    // position (which may be negative / above viewport). The pane's outer clip
    // rect will crop the content to the visible area automatically.
    for (const [, merge] of reanchoredPrimaries) {
        const pr = merge.startRow, pc = merge.startCol;

        const isFrozenRow = pr < frozenRows;
        const ry = isFrozenRow
            ? rowMetrics.offsetOf(pr)
            : rowMetrics.offsetOf(pr) - scrollTop + frozenHeight;
        const isFrozenCol = pc < frozenCols;
        const rx = isFrozenCol
            ? colMetrics.offsetOf(pc)
            : colMetrics.offsetOf(pc) - scrollLeft + frozenWidth;

        // Full merged span dimensions
        const rw = colMetrics.offsetOf(merge.endCol + 1) - colMetrics.offsetOf(pc);
        const rSpanH = rowMetrics.offsetOf(merge.endRow + 1) - rowMetrics.offsetOf(pr);

        if (rw <= 0 || rSpanH <= 0) continue;

        // Fetch cell data for the primary
        const sheetCell = effectiveSheetStore?.getCell(pr, pc);
        let dispV;
        if (renderContext) {
            dispV = renderContext.getRawDisplayValue(pr, pc, CELL_TYPE.MERGE_PRIMARY);
        } else if (session) {
            dispV = session.getCellDisplayValue(pr, pc);
        } else {
            dispV = sheetCell?.v ?? '';
        }

        const item = {
            row: pr, col: pc,
            x: rx, y: ry, width: rw, height: rSpanH,
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
            vAlign: 'top',
            wrapText: false,
            borders: null,
            isRepeaterCopy: false,
            _descriptor: null,
            clipContent: true,
        };

        // Content (rich text or plain)
        if (isRichText(dispV)) {
            const runs = htmlStringToRuns(dispV);
            item.richTextRuns = runs;
            item.displayValue = runsToPlainText(runs);
        } else {
            item.displayValue = dispV != null ? String(dispV) : '';
        }

        // Apply formatting: col → row → cell (same priority order as main loop)
        const raColFmt = effectiveSheetStore?.getColFormatting?.(pc) ?? null;
        if (raColFmt) {
            if (raColFmt.backgroundColor) item.bgColor = raColFmt.backgroundColor;
            if (raColFmt.color) item.textColor = raColFmt.color;
            if (raColFmt.bold) item.bold = true;
            if (raColFmt.italic) item.italic = true;
            if (raColFmt.underline) item.underline = true;
            if (raColFmt.strikethrough) item.strikethrough = true;
            if (raColFmt.fontSize) item.fontSize = raColFmt.fontSize;
            if (raColFmt.fontFamily) item.fontFamily = raColFmt.fontFamily;
            if (raColFmt.horizontalAlign) item.hAlign = raColFmt.horizontalAlign;
            if (raColFmt.verticalAlign) item.vAlign = raColFmt.verticalAlign;
            if (raColFmt.wrapText) item.wrapText = true;
        }
        const raRowFmt = effectiveSheetStore?.getRowFormatting?.(pr) ?? null;
        if (raRowFmt) {
            if (raRowFmt.backgroundColor) item.bgColor = raRowFmt.backgroundColor;
            if (raRowFmt.color) item.textColor = raRowFmt.color;
            if (raRowFmt.bold) item.bold = true;
            if (raRowFmt.italic) item.italic = true;
            if (raRowFmt.underline) item.underline = true;
            if (raRowFmt.strikethrough) item.strikethrough = true;
            if (raRowFmt.fontSize) item.fontSize = raRowFmt.fontSize;
            if (raRowFmt.fontFamily) item.fontFamily = raRowFmt.fontFamily;
            if (raRowFmt.horizontalAlign) item.hAlign = raRowFmt.horizontalAlign;
            if (raRowFmt.verticalAlign) item.vAlign = raRowFmt.verticalAlign;
            if (raRowFmt.wrapText) item.wrapText = true;
        }
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

        // Merged cells always default to top alignment when vAlign not explicitly set
        if (!sheetCell?.verticalAlign && !raRowFmt?.verticalAlign && !raColFmt?.verticalAlign) {
            item.vAlign = 'top';
        }

        cells.push(item);
    }

    return cells;
}

export { CELL_TYPE };
