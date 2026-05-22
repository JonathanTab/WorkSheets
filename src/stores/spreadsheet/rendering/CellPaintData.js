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
 * For scrollable columns:                 canvasX = colMetrics.offsetOf(col) - scrollLeft
 *
 * Same pattern applies for rows.
 */

import { CELL_TYPE } from '../features/SheetRenderContext.svelte.js';
import { CellTypeRegistry } from '../cellTypes/index.js';
import { buildRenderRuns } from '../textFormatRuns.js';

const TABLE_HEADER_BORDER_WIDTH = 1.5; // px — default bottom border on table header cells

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
 * @property {'text'|'checkbox'|'rating'|'image'|'dropdown'} renderType
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
 * @property {{colName?:string,sortIcon?:string,hasFilter?:boolean,filterActive?:boolean,typeIcon?:string,isFormula?:boolean,isFirstCol?:boolean,isLastCol?:boolean}} [tableHeaderInfo]
 * @property {string} [placeholderText] For entry cells or empty typed cells — shown in placeholder style
 * @property {boolean} [isNonEntryCol]  For table entry cells — formula columns
 * @property {{top?,right?,bottom?,left?}} [borders]
 * @property {string} [formulaHighlight] Formula edit mode reference highlight color
 * @property {boolean} [isFirstTableCol] True for the leftmost column in a table
 * @property {boolean} [isFormulaCol]   True for computed/formula columns
 * @property {boolean} [zebraRow]       True for even data rows (zebra striping)
 * @property {boolean} [isRepeaterCopy] True for non-template repeater cells (visual dimming)
 * @property {Array|null} [richTextRuns] Rich-text run array when cell value is rich text
 * @property {boolean} [clipContent]    True when cell content needs ctx.save/clip/restore
 * @property {any} [dropdownOptions]    Options array for dropdown cells
 * @property {any} [_descriptor]        Pre-resolved CellTypeRegistry descriptor for paint
 * @property {boolean} [gridlineOnly]   True for overflow-shadow cells (gridlines only, no content)
 * @property {number} [naturalWidth]    Original column width before overflow extension
 * @property {boolean} [dvInvalid]      True when cell value fails data validation
 */

/**
 * Apply a parsed table formatting object (per-row or per-cell) onto a CellPaintItem.
 * Uses the toolbar/sheet naming convention (color, backgroundColor, horizontalAlign…).
 * @param {import('./CellPaintData.js').CellPaintItem} item
 * @param {Object|null|undefined} fmt
 */
function applyTableFmt(item, fmt) {
    if (!fmt) return;
    if (fmt.backgroundColor != null) item.bgColor = fmt.backgroundColor;
    if (fmt.color != null) item.textColor = fmt.color;
    if (fmt.bold != null) item.bold = fmt.bold;
    if (fmt.italic != null) item.italic = fmt.italic;
    if (fmt.underline != null) item.underline = fmt.underline;
    if (fmt.strikethrough != null) item.strikethrough = fmt.strikethrough;
    if (fmt.fontSize != null) item.fontSize = fmt.fontSize;
    if (fmt.fontFamily != null) item.fontFamily = fmt.fontFamily;
    if (fmt.horizontalAlign != null) item.hAlign = fmt.horizontalAlign;
    if (fmt.verticalAlign != null) item.vAlign = fmt.verticalAlign;
    if (fmt.wrapText != null) item.wrapText = fmt.wrapText;
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
        scrollLeft,
        scrollTop,
        showFormulas = false,
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
    /** @type {any[]|null} */
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

    // Index into `cells` where the current row's items begin.
    // Used to retroactively mark left-overflow shadow cells (right-aligned spill).
    let rowStartCellIdx = 0;

    // Merge primaries whose primary row/col is outside the current range (scrolled off-screen).
    // These are collected from MERGE_SHADOW cells and painted after the main loop so that
    // merged cells remain visible even when their primary row is above the viewport.
    // key = "pr,pc" → full merge record { startRow, startCol, endRow, endCol }
    const reanchoredPrimaries = new Map();

    for (let r = rowRange.start; r <= rowRange.end; r++) {
        const isFrozenRow = r < frozenRows;
        const y = isFrozenRow
            ? rowMetrics.offsetOf(r)
            : rowMetrics.offsetOf(r) - scrollTop;
        const height = rowMetrics.sizeOf(r);

        // Track the rightmost overflow edge seen so far in this row.
        // Cells whose left edge falls within this boundary are overflow shadows.
        let rowOverflowRightX = -Infinity;

        // Record start of this row's items for retroactive left-overflow shadow marking.
        rowStartCellIdx = cells.length;

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
                : colMetrics.offsetOf(c) - scrollLeft;
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

            // ── Table cell: fetch info for later use in unified path ──────────
            // TABLE_HEADER / TABLE_ENTRY / TABLE_DATA now route through the same
            // pipeline as regular cells.  Display value and cell-type config come
            // from SheetRenderContext (delegating to TableManager), so CellTypeRegistry,
            // toolbar formatting, conditional formats, borders, etc. all work
            // identically to regular spreadsheet cells.
            let tableCellInfo = null;
            if (
                cellType === CELL_TYPE.TABLE_HEADER ||
                cellType === CELL_TYPE.TABLE_ENTRY ||
                cellType === CELL_TYPE.TABLE_DATA
            ) {
                tableCellInfo = renderContext?.tableManager?.getCellInfo(r, c);
                if (!tableCellInfo?.table) continue; // safety: skip if not found
            }

            // ── Regular / Merge / Repeater / Table cells ──────────────────────
            const repeaterCtx = cellType === CELL_TYPE.REPEATER
                ? renderContext?.repeaterEngine?.getCellRepeaterContext(r, c)
                : null;
            const isRepeaterCopy = !!(repeaterCtx && repeaterCtx.repIndex > 0);
            const mappedRow = repeaterCtx ? repeaterCtx.templateRow : r;
            const mappedCol = repeaterCtx ? repeaterCtx.templateCol : c;

            const sheetCell = effectiveSheetStore?.getCell(mappedRow, mappedCol);

            // Cell type config — for repeater cells use template cell coords;
            // for table cells use (r, c) directly so SheetRenderContext can route
            // to the column type definition (or sheet override if the toolbar set one).
            const ctRow = tableCellInfo ? r : mappedRow;
            const ctCol = tableCellInfo ? c : mappedCol;
            const ct = renderContext?.getCellTypeConfig(ctRow, ctCol);

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
            // Formula view mode: show raw formula text instead of computed value
            if (showFormulas) {
                const rawV = sheetCell?.v;
                if (typeof rawV === 'string' && rawV.startsWith('=')) dispV = rawV;
            }

            // Resolve descriptor. Untyped cells default to the text descriptor so the
            // smart-display logic (numeric grouping, value-dependent right-align,
            // date-string reformatting) applies uniformly to plain cells.
            const descriptor = CellTypeRegistry.get(ct?.type ?? 'text');

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
                // Table-specific fields (set below for TABLE_* cells)
                tableHeaderInfo: undefined,
                zebraRow: undefined,
                isFormulaCol: undefined,
                placeholderText: undefined,
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

            // For table cells (DATA/ENTRY), the authoritative value is in dispV (from
            // TableManager / entryBuffer), not in sheetCell.v.  For regular cells,
            // sheetCell.v is used for checkbox/rating/image raw values as before.
            const isTableDataOrEntry = cellType === CELL_TYPE.TABLE_DATA || cellType === CELL_TYPE.TABLE_ENTRY;
            const cellRawValue = isTableDataOrEntry ? dispV : (sheetCell?.v ?? null);

            // ── Render-type dispatch via descriptor ───────────────────────────
            // Descriptors declare a renderType ('text' | 'checkbox' | 'rating' |
            // 'dropdown' | 'image' | 'file'); the descriptor itself handles
            // formatValue and provides defaultStyle / valueAlign hints below.
            const renderType = descriptor?.renderType ?? 'text';
            item.renderType = renderType;

            if (renderType === 'checkbox') {
                item.rawValue = !!cellRawValue;
                item.hAlign = 'center';
            } else if (renderType === 'rating') {
                item.rawValue = Number(cellRawValue) || 0;
                item.ratingMax = ct?.max || 5;
                item.hAlign = 'center';
            } else if (renderType === 'dropdown') {
                item.displayValue = dispV != null ? String(dispV) : '';
                item.dropdownOptions = ct?.options || [];
            } else if (renderType === 'image') {
                item.rawValue = cellRawValue ?? null; // blob ID string
                item.ctConfig = ct;
                item.clipContent = true;
                item.hAlign = 'center';
                item.vAlign = 'middle';
            } else if (renderType === 'file') {
                item.rawValue = cellRawValue ?? null; // blob ID string
                item.ctConfig = ct;
                item.clipContent = true;
            } else {
                // Plain text rendering path — applies to text, number, date, url, and
                // any future text-rendered type.
                let formattedValue = dispV;
                if (dispV != null && dispV !== '') {
                    formattedValue = CellTypeRegistry.formatValue(ct, dispV);
                }

                const cellTfr = sheetCell?.tfr;
                if (cellTfr?.length) {
                    const plainText = formattedValue != null ? String(formattedValue) : '';
                    item.richTextRuns = buildRenderRuns(plainText, cellTfr);
                    item.displayValue = plainText;
                    item.clipContent  = true;
                } else {
                    item.displayValue = formattedValue != null ? String(formattedValue) : '';
                }

                // Type-level default style (alignment, underline, link color, …).
                // Cell-level / row-level / col-level formatting applied below still wins.
                const defStyle = descriptor?.defaultStyle?.(ct);
                if (defStyle) {
                    if (defStyle.horizontalAlign) item.hAlign = defStyle.horizontalAlign;
                    if (defStyle.verticalAlign)   item.vAlign = defStyle.verticalAlign;
                    if (defStyle.underline)       item.underline = true;
                    if (defStyle.color && !sheetCell?.color) item.textColor = defStyle.color;
                }

                // Value-dependent alignment override (numbers right-align even when
                // sitting in an untyped cell with a numeric stored value).
                const valueAlign = descriptor?.valueAlign?.(cellRawValue ?? dispV, ct);
                if (valueAlign) item.hAlign = valueAlign;

                // Value-dependent color (e.g. red negatives). Set before user-style
                // cascade so explicit colors still override.
                const typeColor = descriptor?.getTextColor?.(cellRawValue ?? dispV, ct);
                if (typeColor) item.textColor = typeColor;
            }

            // ── Table-specific defaults (applied before sheet/row/col formatting) ──
            // These establish baseline style for table cells; sheet formatting always wins.
            if (tableCellInfo) {
                const colDef = tableCellInfo.colDef;

                if (cellType === CELL_TYPE.TABLE_HEADER) {
                    // Default: bold header with subtle background and bottom border
                    item.bold = true;
                    if (!item.bgColor) item.bgColor = '#f1f5f9';
                    item.borders = { bottom: { color: '#94a3b8', width: TABLE_HEADER_BORDER_WIDTH } };
                    item.clipContent = true;
                    // Filter-icon info for CanvasRenderer
                    item.tableHeaderInfo = {
                        filterActive: !!(colDef?.id && tableCellInfo.table.filters?.[colDef.id]),
                    };
                    // Column-level formatting overrides for header
                    if (colDef?.bgColor) item.bgColor = colDef.bgColor;
                    if (colDef?.textColor) item.textColor = colDef.textColor;
                    // @ts-ignore — new colDef fields not in JSDoc Object type
                    if (colDef?.bold === false) item.bold = false;
                    // @ts-ignore
                    if (colDef?.italic) item.italic = true;
                    // @ts-ignore
                    if (colDef?.underline) item.underline = true;
                    // @ts-ignore
                    if (colDef?.fontSize) item.fontSize = colDef.fontSize;
                    // @ts-ignore
                    if (colDef?.fontFamily) item.fontFamily = colDef.fontFamily;
                    if (colDef?.hAlign) item.hAlign = colDef.hAlign;

                } else if (cellType === CELL_TYPE.TABLE_DATA) {
                    // Column-level color overrides (lower priority than sheet formatting applied below)
                    if (colDef?.bgColor) item.bgColor = colDef.bgColor;
                    if (colDef?.textColor) item.textColor = colDef.textColor;
                    // @ts-ignore — new colDef fields not in JSDoc Object type
                    if (colDef?.bold) item.bold = true;
                    // @ts-ignore
                    if (colDef?.italic) item.italic = true;
                    // @ts-ignore
                    if (colDef?.underline) item.underline = true;
                    // @ts-ignore
                    if (colDef?.fontSize) item.fontSize = colDef.fontSize;
                    // @ts-ignore
                    if (colDef?.fontFamily) item.fontFamily = colDef.fontFamily;
                    if (colDef?.isNonEntry) item.isFormulaCol = true;
                    // Subtle zebra striping — only when no explicit bg set
                    if (tableCellInfo.dataIndex % 2 === 0 && !item.bgColor) item.zebraRow = true;
                    // Column-level alignment override
                    if (colDef?.hAlign) item.hAlign = colDef.hAlign;
                    // Column-level conditional formatting
                    if (colDef?.conditionalFormats?.length && dispV != null) {
                        for (const fmt of colDef.conditionalFormats) {
                            if (matchesCondition(dispV, fmt.condition, fmt.value)) {
                                if (fmt.style?.backgroundColor) item.bgColor = fmt.style.backgroundColor;
                                if (fmt.style?.color) item.textColor = fmt.style.color;
                                if (fmt.style?.bold) item.bold = true;
                                break;
                            }
                        }
                    }
                    // Per-row then per-cell formatting (overrides column and conditional)
                    if (tableCellInfo.dataIndex >= 0) {
                        const tableRow = tableCellInfo.table.sortedFilteredRows[tableCellInfo.dataIndex];
                        applyTableFmt(item, tableRow?._rowFmt);
                        applyTableFmt(item, tableRow?._fmt?.[colDef?.id]);
                    }

                } else if (cellType === CELL_TYPE.TABLE_ENTRY) {
                    if (colDef?.isNonEntry) {
                        // Formula/computed column — show 'fx' placeholder, non-editable
                        item.displayValue = '';
                        item.renderType = 'text';
                        item.placeholderText = 'fx';
                        item.isFormulaCol = true;
                    }
                    // Column-level formatting overrides
                    if (colDef?.bgColor) item.bgColor = colDef.bgColor;
                    if (colDef?.textColor) item.textColor = colDef.textColor;
                    // @ts-ignore — new colDef fields not in JSDoc Object type
                    if (colDef?.bold) item.bold = true;
                    // @ts-ignore
                    if (colDef?.italic) item.italic = true;
                    // @ts-ignore
                    if (colDef?.underline) item.underline = true;
                    // @ts-ignore
                    if (colDef?.fontSize) item.fontSize = colDef.fontSize;
                    // @ts-ignore
                    if (colDef?.fontFamily) item.fontFamily = colDef.fontFamily;
                    // @ts-ignore — hAlign is in CellPaintItem typedef; TS JSDoc checker false positive
                    if (colDef?.hAlign) item.hAlign = colDef.hAlign;
                }
            }

            // Apply sheet formatting: col-level → row-level → cell-level (cell wins).
            // TABLE_DATA and TABLE_ENTRY skip this — only borders bleed through from the
            // underlying sheet into table cells (applied separately below).
            const applySheetFmt = !(tableCellInfo &&
                (cellType === CELL_TYPE.TABLE_DATA || cellType === CELL_TYPE.TABLE_ENTRY));

            // Col-level formatting (lowest priority) — use pre-built cache (populated above)
            const colFmt = applySheetFmt ? (colFmtCache[mappedCol] ?? null) : null;
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
                if (colFmt.wrapText) item.wrapText = colFmt.wrapText;
            }
            // Row-level formatting (overrides col)
            // Use pre-cached value for non-repeater cells; re-fetch for repeater rows
            const rowFmt = applySheetFmt
                ? ((mappedRow === r) ? rowFmtCache : effectiveSheetStore?.getRowFormatting?.(mappedRow))
                : null;
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
                if (rowFmt.wrapText) item.wrapText = rowFmt.wrapText;
            }
            // Cell-level formatting (highest priority, overrides row/col)
            if (applySheetFmt && sheetCell?.exists) {
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
                if (sheetCell.wrapText) item.wrapText = sheetCell.wrapText;
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
                    if (!rule.wholeCol && (r < rule.startRow || r > rule.endRow)) continue;
                    if (!rule.wholeRow && (c < rule.startCol || c > rule.endCol)) continue;
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
            // Bordered cells skip overflow: extending their x/width would drag the border
            // into adjacent cells, drawing a top border on the wrong cell visually.
            if (
                cellType === CELL_TYPE.REGULAR &&
                item.renderType === 'text' &&
                (!item.wrapText || item.wrapText === 'overflow') &&
                !item.richTextRuns &&
                !item.borders &&
                item.displayValue &&
                renderContext
            ) {
                if (item.hAlign === 'right') {
                    // Right-aligned: spill LEFT into preceding empty cells.
                    const leftOverflow = renderContext.getLeftOverflowExtent(r, c, colRange.start, colMetrics, item.displayValue, sheetCell);
                    if (leftOverflow > 0) {
                        const originalX = x;
                        item.x -= leftOverflow;
                        item.width += leftOverflow;
                        // Retroactively mark already-processed cells in this row as overflow
                        // shadows so they suppress their content and intermediate gridlines.
                        for (let si = rowStartCellIdx; si < cells.length; si++) {
                            const prev = cells[si];
                            if (!prev.gridlineOnly && prev.x >= item.x && prev.x < originalX) {
                                prev.gridlineOnly = true;
                            }
                        }
                    }
                } else {
                    // Left/center-aligned: spill RIGHT into following empty cells.
                    const overflowExtent = renderContext.getOverflowExtent(r, c, colRange.end, colMetrics, item.displayValue, sheetCell);
                    if (overflowExtent > 0) {
                        item.naturalWidth = width;
                        item.width += overflowExtent;
                        // Track the furthest overflow edge so subsequent cells can detect shadows
                        const overflowRightX = item.x + item.width;
                        if (overflowRightX > rowOverflowRightX) rowOverflowRightX = overflowRightX;
                    }
                }
            }

            // Mark cells that need content clipping (ctx.save/clip/restore in renderer).
            // wrapText and merged cells need clipping; so do table headers (complex layout).
            // Plain single-line text cells that don't overflow are left as clipContent:false.
            // "overflow" mode explicitly allows text to spill into adjacent cells — no clip.
            // Bordered cells clip so their content stays inside the border boundary.
            if ((item.wrapText && item.wrapText !== 'overflow') || cellType === CELL_TYPE.MERGE_PRIMARY || item.borders) {
                item.clipContent = true;
            }
            // Non-text render types have their own internal layout that can overflow
            if (item.renderType !== 'text' && item.renderType !== 'dropdown') {
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
            : rowMetrics.offsetOf(pr) - scrollTop;
        const isFrozenCol = pc < frozenCols;
        const rx = isFrozenCol
            ? colMetrics.offsetOf(pc)
            : colMetrics.offsetOf(pc) - scrollLeft;

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

        // Content — same tfr-based path as regular cells
        const mergeTfr = sheetCell?.tfr;
        if (mergeTfr?.length) {
            const plainText = dispV != null ? String(dispV) : '';
            item.richTextRuns = buildRenderRuns(plainText, mergeTfr);
            item.displayValue = plainText;
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
            if (raColFmt.wrapText) item.wrapText = raColFmt.wrapText;
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
            if (raRowFmt.wrapText) item.wrapText = raRowFmt.wrapText;
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
            if (sheetCell.wrapText) item.wrapText = sheetCell.wrapText;
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
