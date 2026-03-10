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
 *   TABLE_HEADER      - inline table column-header row (Phase 2)
 *   TABLE_ENTRY       - inline table entry row (Phase 2)
 *   TABLE_DATA        - inline table data row (Phase 2)
 *   REPEATER          - cell produced by an inline repeater (Phase 3)
 *   VIEWPORT_OCCUPIED - cell inside a viewport-mode table/repeater anchor (Phase 2/3)
 *
 * ## Growth plan
 * Phases 2 and 3 set `this.tableManager` and `this.repeaterEngine` after
 * construction. `getCellType()`, `getDisplayValue()`, and `effectiveRowCount`
 * will automatically pick them up.
 */
import * as Y from 'yjs';
import { MergeEngine } from './MergeEngine.svelte.js';
import { CellTypeRegistry } from '../cellTypes/index.js';

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
        return textMeasurementCache.get(cacheKey);
    }

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

// ─── Cell type constants (exported so VirtualPane can switch on them) ────────

export const CELL_TYPE = Object.freeze({
    REGULAR: 'REGULAR',
    MERGE_PRIMARY: 'MERGE_PRIMARY',
    MERGE_SHADOW: 'MERGE_SHADOW',
    TABLE_HEADER: 'TABLE_HEADER',
    TABLE_ENTRY: 'TABLE_ENTRY',
    TABLE_DATA: 'TABLE_DATA',
    REPEATER: 'REPEATER',
    VIEWPORT_OCCUPIED: 'VIEWPORT_OCCUPIED'
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
        // ── Phase 2+: viewport-mode panels occupy cell ranges ─────────────
        if (this.tableManager?.isViewportCell(row, col)) {
            return CELL_TYPE.VIEWPORT_OCCUPIED;
        }
        if (this.repeaterEngine?.isViewportCell(row, col)) {
            return CELL_TYPE.VIEWPORT_OCCUPIED;
        }

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

        // ── Phase 2+: table data ──────────────────────────────────────────
        if (type === CELL_TYPE.TABLE_DATA && this.tableManager) {
            rawValue = this.tableManager.getCellDisplayValue(row, col);
        }
        // ── Phase 3+: repeater cells with $rep context ────────────────────
        else if (type === CELL_TYPE.REPEATER && this.repeaterEngine) {
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
    getOverflowExtent(row, col, visibleColEnd, colMetrics) {
        const cell = this.#sheetStore.getCell(row, col);
        if (!cell.exists || cell.v === undefined || cell.v === null || cell.v === '') return 0;
        if (cell.wrapText) return 0;

        // Only REGULAR cells can overflow (not table/repeater/merge)
        const type = this.getCellType(row, col);
        if (type !== CELL_TYPE.REGULAR) return 0;

        // Get the display value and measure its width
        const displayValue = this.getDisplayValue(row, col);
        const textWidth = measureTextWidth(displayValue, cell);

        // Get the column width (with padding)
        const colWidth = colMetrics.sizeOf(col);
        const padding = 8; // 4px padding on each side
        const availableWidth = colWidth - padding;

        // If content fits, no overflow needed
        if (textWidth <= availableWidth) return 0;

        // Calculate how much extra width we need
        const neededExtra = textWidth - availableWidth;

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

        // Return only what we need, capped at what's available
        return Math.min(neededExtra, availableExtra);
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
     * Get effective cell type config
     * @param {number} row
     * @param {number} col
     * @returns {Object|null}
     */
    getCellTypeConfig(row, col) {
        return this.#sheetStore.getCellTypeConfig(row, col);
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

    // ─── Viewport panels (Phase 2+) ──────────────────────────────────────────

    /**
     * Descriptors for all viewport-mode table/repeater panels to render
     * as overlays in Grid.svelte.
     * @returns {Array<{ type: 'table'|'repeater', store: any, startRow: number, startCol: number, endRow: number, endCol: number }>}
     */
    get viewportPanels() {
        /** @type {Array<{ type: 'table'|'repeater', store: any, startRow: number, startCol: number, endRow: number, endCol: number }>} */
        const panels = [];
        if (this.tableManager) {
            for (const table of this.tableManager.viewportTables) {
                panels.push({
                    type: 'table',
                    store: table,
                    startRow: table.vpStartRow,
                    startCol: table.vpStartCol,
                    endRow: table.vpEndRow,
                    endCol: table.vpEndCol
                });
            }
        }
        if (this.repeaterEngine) {
            for (const rep of this.repeaterEngine.viewportRepeaters) {
                panels.push({
                    type: 'repeater',
                    store: rep,
                    startRow: rep.vpStartRow,
                    startCol: rep.vpStartCol,
                    endRow: rep.vpEndRow,
                    endCol: rep.vpEndCol
                });
            }
        }
        return panels;
    }

    /**
     * Inline table headers that have scrolled off the top and need a sticky overlay.
     * Returns descriptors for Grid.svelte to render sticky header elements.
     *
     * @param {number} scrollTop - current vertical scroll offset in px
     * @param {number} frozenHeight - height of frozen rows in px
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} rowMetrics
     * @param {import('../virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
     * @returns {Array<{ table, leftPx, widthPx, heightPx }>}
     */
    getStickyTableHeaders(scrollTop, frozenHeight, rowMetrics, colMetrics) {
        if (!this.tableManager) return [];
        return this.tableManager.getStickyHeaders(scrollTop, frozenHeight, rowMetrics, colMetrics);
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
