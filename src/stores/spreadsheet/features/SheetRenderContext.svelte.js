/**
 * SheetRenderContext - Unified rendering API for a single sheet
 *
 * Sits between data stores and VirtualPane. VirtualPane asks this single
 * object what to render at each (row, col) — the context coordinates all
 * feature engines (merges, tables, repeaters) and returns one answer.
 *
 * ## Cell types returned by getCellType():
 *   REGULAR           - ordinary spreadsheet cell
 *   MERGE_PRIMARY     - top-left cell of a merged region (render with span)
 *   MERGE_SHADOW      - non-primary cell inside a merge (skip rendering)
 *   TABLE_HEADER      - inline table column-header row
 *   TABLE_ENTRY       - inline table entry row
 *   TABLE_DATA        - inline table data row
 *   REPEATER          - cell produced by an inline repeater
 *
 * ## Growth plan
 * Phases 2 and 3 set `this.tableManager` and `this.repeaterEngine` after
 * construction. `getCellType()`, `getDisplayValue()`, and `effectiveRowCount`
 * will automatically pick them up.
 */
import * as Y from 'yjs';
import { MergeEngine } from './MergeEngine.svelte.js';
import { CellTypeRegistry } from '../cellTypes/index.js';
import { perfMon } from '../perf/PerfMonitor.js';

// ─── Text measurement cache ──────────────────────────────────────────────────

/** @type {CanvasRenderingContext2D | null} */
let measureCanvasCtx = null;
const textMeasurementCache = new Map();

/**
 * Measure text width using a canvas context.
 * Cached for performance.
 * @param {string} text - The text to measure
 * @param {Object} cell - Cell object with optional fontSize, fontFamily, bold
 * @returns {number} Width in pixels
 */
function measureTextWidth(text, cell = {}) {
    if (!text) return 0;

    // Build font string
    const fontSize = cell.fontSize || 12;
    const fontFamily = cell.fontFamily || 'system-ui, -apple-system, sans-serif';
    const fontWeight = cell.bold ? 'bold' : 'normal';
    const font = `${fontWeight} ${fontSize}px ${fontFamily}`;

    const cacheKey = `${text}|${font}`;
    if (textMeasurementCache.has(cacheKey)) {
        perfMon.count('text.measureHit');
        return textMeasurementCache.get(cacheKey);
    }
    perfMon.count('text.measureMiss');

    if (!measureCanvasCtx) {
        const canvas = document.createElement('canvas');
        measureCanvasCtx = canvas.getContext('2d');
    }
    if (!measureCanvasCtx) return 0;

    measureCanvasCtx.font = font;

    const metrics = measureCanvasCtx.measureText(String(text));
    const width = metrics.width;

    textMeasurementCache.set(cacheKey, width);
    if (textMeasurementCache.size > 10000) {
        // Prevent unbounded growth
        const keys = Array.from(textMeasurementCache.keys());
        for (let i = 0; i < 5000; i++) {
            textMeasurementCache.delete(keys[i]);
        }
    }

    return width;
}

// ─── Type inference ──────────────────────────────────────────────────────────

/**
 * Infer a display-only cell type config from a raw value.
 * Never stored in Yjs — used only for rendering.
 *
 * Rules (conservative — only when we're confident):
 *   boolean        → checkbox
 *   http(s):// URL → url
 *
 * Numbers and dates are NOT auto-inferred here to avoid unintended formatting
 * changes; alignment for raw numbers is handled separately in CellPaintData.
 *
 * @param {any} value
 * @returns {{ type: string } | null}
 */
function inferCellType(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'boolean') return { type: 'checkbox' };
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return { type: 'url' };
    return null;
}

// ─── Cell type constants (exported so VirtualPane can switch on them) ────────

export const CELL_TYPE = Object.freeze({
    REGULAR: 'REGULAR',
    MERGE_PRIMARY: 'MERGE_PRIMARY',
    MERGE_SHADOW: 'MERGE_SHADOW',
    TABLE_HEADER: 'TABLE_HEADER',
    TABLE_ENTRY: 'TABLE_ENTRY',
    TABLE_DATA: 'TABLE_DATA',
    REPEATER: 'REPEATER',
});

export class SheetRenderContext {
    /** @type {import('../SheetStore.svelte.js').SheetStore} */
    #sheetStore;

    /** @type {import('../SpreadsheetSession.svelte.js').SpreadsheetSession} */
    #session;

    // ── Feature engines (set post-construction for Phase 2 / 3) ──────────────

    /** @type {MergeEngine} */
    mergeEngine;

    /**
     * Set by Phase 2 (TableManager). Once set, getCellType() and
     * effectiveRowCount will include table logic.
     * @type {import('./TableManager.svelte.js').TableManager | null}
     */
    tableManager = null;

    /**
     * Set by Phase 3 (RepeaterEngine).
     * @type {import('./RepeaterEngine.svelte.js').RepeaterEngine | null}
     */
    repeaterEngine = null;

    /**
     * @param {import('../SheetStore.svelte.js').SheetStore} sheetStore
     * @param {Y.Doc} ydoc
     * @param {import('../SpreadsheetSession.svelte.js').SpreadsheetSession} session
     */
    constructor(sheetStore, ydoc, session) {
        this.#sheetStore = sheetStore;
        this.#session = session;

        // Phase 1: only the merge engine
        this.mergeEngine = new MergeEngine(sheetStore.getYMap(), ydoc);
    }

    // ─── Core rendering API ──────────────────────────────────────────────────

    /**
     * Returns the rendering type for (row, col).
     * VirtualPane switches on this value.
     * @param {number} row
     * @param {number} col
     * @returns {string} One of CELL_TYPE.*
     */
    getCellType(row, col) {
        // ── Phase 2+: inline table regions ───────────────────────────────
        if (this.tableManager) {
            const tt = this.tableManager.getCellTableType(row, col);
            if (tt) return tt; // TABLE_HEADER | TABLE_ENTRY | TABLE_DATA
        }

        // ── Phase 3+: inline repeater regions ────────────────────────────
        if (this.repeaterEngine?.getCellRepeaterContext(row, col)) {
            return CELL_TYPE.REPEATER;
        }

        // ── Phase 1: merges ───────────────────────────────────────────────
        if (this.mergeEngine.isMergeCell(row, col)) {
            return this.mergeEngine.isMergePrimary(row, col)
                ? CELL_TYPE.MERGE_PRIMARY
                : CELL_TYPE.MERGE_SHADOW;
        }

        return CELL_TYPE.REGULAR;
    }

    /**
     * Unified display-value getter.
     * Handles formula cells, table data cells, and repeater cells.
     * @param {number} row
     * @param {number} col
     * @returns {any}
     */
    getDisplayValue(row, col) {
        const type = this.getCellType(row, col);
        let rawValue;

        // ── Phase 2+: table cells ─────────────────────────────────────────
        if (this.tableManager) {
            if (type === CELL_TYPE.TABLE_HEADER) {
                const info = this.tableManager.getCellInfo(row, col);
                rawValue = info?.colDef?.name ?? '';
            } else if (type === CELL_TYPE.TABLE_DATA) {
                rawValue = this.#session.getCellDisplayValue(row, col);
            } else if (type === CELL_TYPE.TABLE_ENTRY) {
                const info = this.tableManager.getCellInfo(row, col);
                rawValue = (info?.colDef && !info.colDef.isNonEntry)
                    ? (info.table.entryBuffer?.[info.colDef.id] ?? null)
                    : null;
            }
            if (rawValue !== undefined) {
                const ct = this.getCellTypeConfig(row, col);
                if (ct) return CellTypeRegistry.formatValue(ct, rawValue);
                return rawValue;
            }
        }
        // ── Phase 3+: repeater cells with $rep context ────────────────────
        if (type === CELL_TYPE.REPEATER && this.repeaterEngine) {
            rawValue = this.repeaterEngine.getCellDisplayValue(row, col, this.#session);
        }
        // ── Phase 1 / REGULAR / MERGE_PRIMARY: standard formula engine path
        else {
            rawValue = this.#session.getCellDisplayValue(row, col);
        }

        // Apply cell type formatting
        const ct = this.getCellTypeConfig(row, col);
        if (ct) {
            return CellTypeRegistry.formatValue(ct, rawValue);
        }

        return rawValue;
    }

    /**
     * Raw display-value getter for buildPaneData — avoids redundant getCellType
     * lookup when the caller already knows the cell type. Does NOT apply
     * CellTypeRegistry formatting (caller handles that).
     * @param {number} row
     * @param {number} col
     * @param {string} cellType - already-resolved CELL_TYPE value
     * @returns {any}
     */
    getRawDisplayValue(row, col, cellType) {
        if (this.tableManager) {
            if (cellType === CELL_TYPE.TABLE_HEADER) {
                const info = this.tableManager.getCellInfo(row, col);
                return info?.colDef?.name ?? '';
            }
            if (cellType === CELL_TYPE.TABLE_DATA) {
                return this.#session.getCellDisplayValue(row, col);
            }
            if (cellType === CELL_TYPE.TABLE_ENTRY) {
                const info = this.tableManager.getCellInfo(row, col);
                if (info?.colDef && !info.colDef.isNonEntry) {
                    return info.table.entryBuffer?.[info.colDef.id] ?? null;
                }
                return null; // formula (non-entry) columns have no editable value
            }
        }
        if (cellType === CELL_TYPE.REPEATER && this.repeaterEngine) {
            return this.repeaterEngine.getCellDisplayValue(row, col, this.#session);
        }
        return this.#session.getCellDisplayValue(row, col);
    }

    /**
     * Overflow extent: extra pixel width beyond the cell's own column width
     * when content spills into adjacent empty cells.
     *
     * Only returns overflow if the content actually needs more space than
     * the column provides.
     *
     * @param {number} row
     * @param {number} col
     * @param {number} visibleColEnd - last visible col in this pane
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
     * @returns {number} extra pixels (0 = no overflow needed)
     */
    getOverflowExtent(row, col, visibleColEnd, colMetrics, displayValue, sheetCell) {
        const cell = sheetCell ?? this.#sheetStore.getCell(row, col);
        if (!cell.exists || cell.v === undefined || cell.v === null || cell.v === '') return 0;
        if (cell.wrapText) return 0;
        // Rich text cells always clip; HTML string width can't be measured as plain text
        if (typeof cell.v === 'string' && /<(?:span|b|strong|i|em|u|s|strike|div|br)\b/i.test(cell.v)) return 0;

        // Get the display value and measure its width
        const dv = displayValue ?? this.getDisplayValue(row, col);
        const textWidth = measureTextWidth(dv, cell);

        // Get the column width (with padding)
        const colWidth = colMetrics.sizeOf(col);
        const padding = 8; // 4px padding on each side
        const availableWidth = colWidth - padding;

        // If content fits, no overflow needed
        // Add 0.5px tolerance for sub-pixel rendering precision
        if (textWidth <= availableWidth + 0.5) return 0;

        // Calculate how much extra width we need
        const neededExtra = Math.max(0, textWidth - availableWidth);

        // Scan adjacent empty cells to see how much we can use
        let availableExtra = 0;
        let c = col + 1;
        while (c <= visibleColEnd && availableExtra < neededExtra) {
            const adjType = this.getCellType(row, c);
            // Stop if the adjacent cell is not a plain REGULAR cell
            if (adjType !== CELL_TYPE.REGULAR) break;
            const adj = this.#sheetStore.getCell(row, c);
            // Stop if the adjacent cell has a value
            if (adj.exists && adj.v !== undefined && adj.v !== null && adj.v !== '') break;
            availableExtra += colMetrics.sizeOf(c);
            c++;
        }

        // Return the total width of consumed cells (snapped to full cell boundaries).
        // This ensures overspill happens in increments of one cell width.
        return availableExtra;
    }

    /**
     * Left overflow extent: extra pixel width when right-aligned text spills leftward
     * into adjacent empty cells.
     *
     * @param {number} row
     * @param {number} col
     * @param {number} visibleColStart - first visible col in this pane
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
     * @param {string} [displayValue]
     * @param {object} [sheetCell]
     * @returns {number} extra pixels (0 = no overflow needed)
     */
    getLeftOverflowExtent(row, col, visibleColStart, colMetrics, displayValue, sheetCell) {
        const cell = sheetCell ?? this.#sheetStore.getCell(row, col);
        if (!cell.exists || cell.v === undefined || cell.v === null || cell.v === '') return 0;
        if (cell.wrapText) return 0;
        if (typeof cell.v === 'string' && /<(?:span|b|strong|i|em|u|s|strike|div|br)\b/i.test(cell.v)) return 0;

        const dv = displayValue ?? this.getDisplayValue(row, col);
        const textWidth = measureTextWidth(dv, cell);

        const colWidth = colMetrics.sizeOf(col);
        const padding = 8;
        const availableWidth = colWidth - padding;

        if (textWidth <= availableWidth + 0.5) return 0;

        const neededExtra = Math.max(0, textWidth - availableWidth);

        let availableExtra = 0;
        let c = col - 1;
        while (c >= visibleColStart && availableExtra < neededExtra) {
            const adjType = this.getCellType(row, c);
            if (adjType !== CELL_TYPE.REGULAR) break;
            const adj = this.#sheetStore.getCell(row, c);
            if (adj.exists && adj.v !== undefined && adj.v !== null && adj.v !== '') break;
            availableExtra += colMetrics.sizeOf(c);
            c--;
        }

        return availableExtra;
    }

    /**
     * Compute editor overflow extents for a given draft text value.
     * Returns how many extra pixels the editor should extend left and right.
     *
     * @param {number} row
     * @param {number} col
     * @param {string} draft
     * @param {'left'|'center'|'right'} hAlign
     * @param {{start:number, end:number}} colRange  visible col range to limit scanning
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
     * @returns {{leftExtra: number, rightExtra: number}}
     */
    getEditorOverflow(row, col, draft, hAlign, colRange, colMetrics) {
        if (!draft) return { leftExtra: 0, rightExtra: 0 };

        const cell = this.#sheetStore.getCell(row, col);
        if (cell.wrapText) return { leftExtra: 0, rightExtra: 0 };

        const textWidth = measureTextWidth(draft, cell);
        const colWidth = colMetrics.sizeOf(col);
        const padding = 8;
        const availableWidth = colWidth - padding;

        if (textWidth <= availableWidth + 0.5) return { leftExtra: 0, rightExtra: 0 };

        const neededExtra = textWidth - availableWidth;

        if (hAlign === 'right') {
            let extra = 0;
            let c = col - 1;
            while (c >= (colRange.start ?? 0) && extra < neededExtra) {
                const adjType = this.getCellType(row, c);
                if (adjType !== CELL_TYPE.REGULAR) break;
                const adj = this.#sheetStore.getCell(row, c);
                if (adj.exists && adj.v != null && adj.v !== '') break;
                extra += colMetrics.sizeOf(c);
                c--;
            }
            return { leftExtra: extra, rightExtra: 0 };
        } else {
            let extra = 0;
            let c = col + 1;
            while (c <= (colRange.end ?? 9999) && extra < neededExtra) {
                const adjType = this.getCellType(row, c);
                if (adjType !== CELL_TYPE.REGULAR) break;
                const adj = this.#sheetStore.getCell(row, c);
                if (adj.exists && adj.v != null && adj.v !== '') break;
                extra += colMetrics.sizeOf(c);
                c++;
            }
            return { leftExtra: 0, rightExtra: extra };
        }
    }

    /**
     * Merge span for a primary cell.
     * @param {number} row
     * @param {number} col
     * @returns {{ rowSpan: number, colSpan: number } | null}
     */
    getMergeSpan(row, col) {
        return this.mergeEngine.getMergeSpan(row, col);
    }

    /**
     * Get effective cell type config — explicit first, then table column type,
     * then inferred from value. For table cells, the column definition provides
     * the default type; a sheet-level override (set via toolbar) takes priority.
     * @param {number} row
     * @param {number} col
     * @returns {Object|null}
     */
    getCellTypeConfig(row, col) {
        // Table cells: header cells are plain text; data/entry cells use column type
        if (this.tableManager) {
            const info = this.tableManager.getCellInfo(row, col);
            if (info) {
                if (info.rowType === 'header') {
                    // Header cells are always plain text (no type formatting)
                    return null;
                }
                // data / entry: sheet-level override takes highest priority
                // (allows toolbar CellTypeConfigurator to work on table cells)
                const sheetOverride = this.#sheetStore.getCellTypeConfig(row, col);
                if (sheetOverride) return sheetOverride;
                // Column default type (full typeConfig takes priority over bare type string)
                const typeConfig = info.colDef?.typeConfig ?? null;
                if (typeConfig) return typeConfig;
                const colType = info.colDef?.type ?? 'text';
                return colType !== 'text' ? { type: colType } : null;
            }
        }
        const explicit = this.#sheetStore.getCellTypeConfig(row, col);
        if (explicit) return explicit;
        const cell = this.#sheetStore.getCell(row, col);
        return cell.exists ? inferCellType(cell.v) : null;
    }

    /**
     * Cell style object for conditional formatting.
     * Phase 1: just passes through the cell's stored style.
     * Phase 2+: also applies table conditional formats.
     * @param {number} row
     * @param {number} col
     * @returns {Object} Plain style object (keys match cell properties)
     */
    getCellStyle(row, col) {
        const cell = this.#sheetStore.getCell(row, col);
        const ct = this.getCellTypeConfig(row, col);

        if (!ct) return cell;

        // Merge type defaults with cell-level formatting
        const typeDefaults = CellTypeRegistry.getDefaultStyle(ct);
        return {
            ...typeDefaults,
            ...cell
        };
    }

    // ─── Virtualizer helpers ─────────────────────────────────────────────────

    /**
     * Effective row count for the virtualizer.
     * In Phase 1 = sheet.rowCount.
     * Phase 2+ inflates for inline table data rows.
     * Phase 3+ inflates for inline repeater instances.
     * @returns {number}
     */
    get effectiveRowCount() {
        let count = this.#sheetStore.rowCount;
        if (this.tableManager) {
            count = Math.max(count, this.tableManager.maxInlineTableRow);
        }
        if (this.repeaterEngine) {
            count = Math.max(count, this.repeaterEngine.maxInlineExtentRow);
        }
        return count;
    }

    /**
     * Effective column count (currently just sheet.colCount).
     * @returns {number}
     */
    get effectiveColCount() {
        return this.#sheetStore.colCount;
    }

    // ─── Sticky table headers ────────────────────────────────────────────────

    /**
     * Returns data for table header/entry rows that should be rendered as
     * sticky overlays at the top of the scrollable area when they've been
     * scrolled past. Semantics are like CSS position:sticky — rows stick to
     * the top while any part of their table is still visible, and disappear
     * when the table has fully scrolled out of view.
     *
     * @param {number} scrollTop
     * @param {number} frozenHeight - height of the frozen-rows band
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} rowMetrics
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
     * @returns {Array<{table, leftPx, widthPx, headerHeightPx, entryHeightPx, showEntry, colWidths}>}
     */
    getStickyTableHeaders(scrollTop, frozenHeight, rowMetrics, colMetrics) {
        if (!this.tableManager) return [];

        const result = [];

        for (const table of this.tableManager.stores.values()) {
            if (table.mode !== 'inline') continue;

            const headerRow = table.startRow;
            const entryRow  = table.startRow + 1;
            const dataStart = table.startRow + 2;
            const dataCount = table.sortedFilteredRows.length;

            const headerTop  = rowMetrics.offsetOf(headerRow);
            const entryTop   = rowMetrics.offsetOf(entryRow);
            const tableEndTop = rowMetrics.offsetOf(dataStart + dataCount);

            // Effective viewport top accounts for frozen rows band
            const viewportTop = scrollTop + frozenHeight;

            // Header not yet scrolled past — table renders normally
            if (headerTop >= viewportTop) continue;

            // Entire table scrolled above viewport — nothing to stick
            if (tableEndTop <= viewportTop) continue;

            const headerHeight = rowMetrics.sizeOf(headerRow);
            const entryHeight  = rowMetrics.sizeOf(entryRow);

            // Show entry row sticky only if it has also scrolled past
            const showEntry = entryTop < viewportTop;

            const leftPx = colMetrics.offsetOf(table.startCol);
            let widthPx = 0;
            const colWidths = [];
            for (let c = table.startCol; c <= table.endCol; c++) {
                const w = colMetrics.sizeOf(c);
                widthPx += w;
                colWidths.push(w);
            }

            result.push({
                table,
                leftPx,
                widthPx,
                headerHeightPx: headerHeight,
                entryHeightPx:  entryHeight,
                showEntry,
                colWidths,
            });
        }

        return result;
    }

    // ─── Sheetstore passthrough (for components that need raw cell data) ──────

    /** @returns {import('../SheetStore.svelte.js').SheetStore} */
    get sheetStore() {
        return this.#sheetStore;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    destroy() {
        this.mergeEngine?.destroy();
        this.tableManager?.destroy();
        this.repeaterEngine?.destroy();
    }
}

export default SheetRenderContext;
