/**
 * TableManager - Per-sheet coordinator for all DB-style tables
 *
 * Manages all TableStore instances for a sheet and answers SheetRenderContext
 * queries about which (row, col) belongs to which table and what type it is.
 *
 * ## Row-index design
 * For each inline table:
 *   - header row  = table.startRow
 *   - entry row   = table.startRow + 1
 *   - data rows   = table.startRow + 2 … table.startRow + 1 + sortedFilteredRows.length
 *
 * The #rowIndex Map<row, { table, rowType, dataIndex }> is rebuilt on any
 * change via a $effect that watches each table's sortedFilteredRows.length.
 *
 * ## TABLE_* formula functions
 * registerFunctions(formulaEngine) wires up TABLE_GET, TABLE_SUM, TABLE_COUNT,
 * TABLE_COL, TABLE_CUMSUM, TABLE_FILTER using the local table store API.
 */

import * as Y from "yjs";
import { TableStore } from "./TableStore.svelte.js";
import { buildTableFunctions } from "./tableFormulaEval.js";
import { CELL_TYPE } from "./SheetRenderContext.svelte.js";
import { perfMon } from "../perf/PerfMonitor.js";

/** Extra buffer rows below the last data row so the table feels "infinite" */
const BUFFER_ROWS = 10;

export class TableManager {
    /** @type {import('yjs').Map<any>} tablesYMap from sheet */
    #tablesYMap;

    /** @type {import('yjs').Doc} */
    #ydoc;

    /** @type {import('yjs').Map<any> | null} root spreadsheet Y.Map (for source table creation) */
    #root = null;

    /** @type {Function[]} */
    #observers = [];

    /**
     * Optional document-level registry. When provided, TableManager borrows
     * stores from it instead of creating new ones — one TableStore per table.
     * @type {import('./DocumentTableRegistry.svelte.js').DocumentTableRegistry | null}
     */
    #registry = null;

    /**
     * tableIds for which THIS manager created the store (not from registry).
     * Only these are destroyed in destroy().
     * @type {Set<string>}
     */
    #ownedStores = new Set();

    /** tableId → TableStore */
    stores = new Map();

    /** Reactive list of all table IDs (for iteration in templates) */
    tableList = $state([]);

    /**
     * Incremented every time #rebuildRowIndex() runs.
     * Grid tracks this to trigger repaints when table data changes.
     */
    tableVersion = $state(0);

    /**
     * O(1) lookup: row → { table: TableStore, rowType: string, dataIndex: number }
     * Built by #rebuildRowIndex(). Rebuilt whenever any table's row count changes.
     */
    #rowIndex = new Map();

    /** @type {((formula: string) => any) | null} */
    #sheetFormulaEval = null;

    /** @type {(() => void) | null} Clears the registered TABLE_* functions' cached
     *  source columns; set in registerFunctions(), invoked on any table data change. */
    #clearFormulaColumnCache = null;

    /**
     * @param {import('yjs').Map<any>} sheet
     * @param {import('yjs').Doc} ydoc
     * @param {import('./DocumentTableRegistry.svelte.js').DocumentTableRegistry | null} [registry]
     * @param {import('yjs').Map<any> | null} [root]  root spreadsheet Y.Map, for source table creation
     */
    constructor(sheet, ydoc, registry = null, root = null) {
        this.#ydoc = ydoc;
        this.#registry = registry;
        this.#root = root;
        this.#tablesYMap = sheet.get("tableViews");

        if (!this.#tablesYMap) {
            return;
        }

        // Create TableStore for each existing table
        this.#tablesYMap.forEach((tableYMap, tableId) => {
            this.#addTableStore(tableId, tableYMap);
        });

        // Observe additions / deletions
        const tablesObs = (event) => {
            event.changes.keys.forEach((change, tableId) => {
                if (change.action === "add") {
                    const tableYMap = this.#tablesYMap.get(tableId);
                    if (tableYMap) this.#addTableStore(tableId, tableYMap);
                } else if (change.action === "delete") {
                    this.#removeTableStore(tableId);
                }
            });
            this.#rebuildRowIndex();
        };
        this.#tablesYMap.observe(tablesObs);
        this.#observers.push(() => this.#tablesYMap.unobserve(tablesObs));

        this.#rebuildRowIndex();
    }

    // ─── Internal store management ────────────────────────────────────────────

    #addTableStore(tableId, tableYMap) {
        if (this.stores.has(tableId)) return;
        // Borrow from registry when available; fall back to creating a new store.
        let store = this.#registry?.getById(tableId) ?? null;
        if (!store) {
            store = new TableStore(tableYMap, this.#ydoc);
            this.#ownedStores.add(tableId);
        }
        if (this.#sheetFormulaEval) store.setSheetFormulaEvaluator(this.#sheetFormulaEval);
        this.stores.set(tableId, store);
        this.tableList = [...this.tableList, tableId];
        // Rebuild index when this table's row count changes.
        // CRITICAL: use observeDeep for rows so this fires AFTER TableStore's own
        // observeDeep (which updates store.rows / sortedFilteredRows). Since TableStore
        // attaches its observeDeep first (in its constructor), ours fires second,
        // ensuring sortedFilteredRows is up-to-date when we rebuild the index.
        const rebuildOnChange = () => this.#rebuildRowIndex();
        // For views, rows/columns live on the SOURCE Y.Map (not tableYMap).
        // sourceYMapForObservation returns the source Y.Map for views, own map for source tables.
        const obsYMap = store.sourceYMapForObservation;
        const rowArr = obsYMap.get("rows");
        if (rowArr) {
            rowArr.observeDeep(rebuildOnChange);
            this.#observers.push(() => rowArr.unobserveDeep(rebuildOnChange));
        }
        // Observe filters Y.Map for filter changes that affect sortedFilteredRows.length.
        // Note: local (session-only) filters are handled via store._onFilterChange below.
        const filtersYMap = obsYMap.get("filters");
        if (filtersYMap) {
            filtersYMap.observeDeep(rebuildOnChange);
            this.#observers.push(() => filtersYMap.unobserveDeep(rebuildOnChange));
        }
        // Wire local filter changes (not persisted in Yjs) so that setFilter /
        // clearFilter / clearAllFilters trigger a row-index rebuild and canvas repaint.
        store._onFilterChange = rebuildOnChange;
        this.#observers.push(() => { store._onFilterChange = null; });
        // Also observe top-level for startRow/startCol changes (own view Y.Map)
        tableYMap.observe(rebuildOnChange);
        this.#observers.push(() => tableYMap.unobserve(rebuildOnChange));
        // Observe column definition/order changes so the canvas repaints when
        // column metadata changes. These don't affect row structure so we just bump tableVersion.
        const defsMap = obsYMap.get("columnDefs");
        const orderArr = obsYMap.get("columnOrder");
        if (defsMap) {
            const bumpOnColChange = () => { this.tableVersion++; };
            defsMap.observeDeep(bumpOnColChange);
            this.#observers.push(() => defsMap.unobserveDeep(bumpOnColChange));
        }
        if (orderArr) {
            const bumpOnOrderChange = () => { this.tableVersion++; };
            orderArr.observe(bumpOnOrderChange);
            this.#observers.push(() => orderArr.unobserve(bumpOnOrderChange));
        }
        // View-only: visibleColumns is a nested Y.Array, so top-level observe on
        // tableYMap won't fire when a view's column subset/order changes.
        // Rebuild so col bounds, hit-testing and paint all refresh immediately.
        const visibleArr = tableYMap.get("visibleColumns");
        if (visibleArr) {
            visibleArr.observe(rebuildOnChange);
            this.#observers.push(() => visibleArr.unobserve(rebuildOnChange));
        }
    }

    #removeTableStore(tableId) {
        const store = this.stores.get(tableId);
        if (store) {
            // Only destroy if we created the store (not borrowed from registry)
            if (this.#ownedStores.has(tableId)) {
                store.destroy();
                this.#ownedStores.delete(tableId);
            }
            this.stores.delete(tableId);
            this.tableList = this.tableList.filter((id) => id !== tableId);
        }
    }

    #rebuildRowIndex() {
        const _perfT = perfMon.enabled ? performance.now() : 0;
        this.#rowIndex.clear();
        for (const table of this.stores.values()) {
            const headerRow = table.startRow;
            const entryRow = table.startRow + 1;
            const dataStart = table.startRow + 2;
            // sortedFilteredRows is $derived — always up-to-date when read here
            const dataCount = table.sortedFilteredRows.length;

            const addEntry = (row, entry) => {
                let existing = this.#rowIndex.get(row);
                if (!existing) {
                    existing = [];
                    this.#rowIndex.set(row, existing);
                }
                existing.push(entry);
            };

            // Header row (spans all table columns)
            addEntry(headerRow, { table, rowType: "header", dataIndex: -1 });

            // Entry row
            addEntry(entryRow, { table, rowType: "entry", dataIndex: -1 });

            // Data rows
            for (let i = 0; i < dataCount; i++) {
                addEntry(dataStart + i, {
                    table,
                    rowType: "data",
                    dataIndex: i,
                });
            }
        }
        this.tableVersion++;
        if (perfMon.enabled) perfMon.record('table.rebuildRowIndex', performance.now() - _perfT);
    }

    /**
     * Provide a formula evaluator to all table stores (current and future).
     * Called by SpreadsheetSession after the formula engine is ready.
     * @param {((formula: string) => any) | null} fn
     */
    setSheetFormulaEvaluator(fn) {
        this.#sheetFormulaEval = fn;
        for (const store of this.stores.values()) {
            store.setSheetFormulaEvaluator(fn);
        }
    }

    // ─── SheetRenderContext API ───────────────────────────────────────────────

    /**
     * Returns CELL_TYPE.TABLE_HEADER / TABLE_ENTRY / TABLE_DATA, or null.
     * @param {number} row
     * @param {number} col
     * @returns {string|null}
     */
    getCellTableType(row, col) {
        const entries = this.#rowIndex.get(row);
        if (!entries) return null;

        for (const entry of entries) {
            const { table, rowType } = entry;
            // Check that col is within the table's column range
            if (col >= table.startCol && col <= table.endCol) {
                switch (rowType) {
                    case "header":
                        return CELL_TYPE.TABLE_HEADER;
                    case "entry":
                        return CELL_TYPE.TABLE_ENTRY;
                    case "data":
                        return CELL_TYPE.TABLE_DATA;
                    default:
                        return null;
                }
            }
        }
        return null;
    }

    /**
     * Get display value for a TABLE_DATA cell.
     * @param {number} row
     * @param {number} col
     * @returns {any}
     */
    getCellDisplayValue(row, col) {
        const entries = this.#rowIndex.get(row);
        if (!entries) return "";

        for (const entry of entries) {
            if (entry.rowType !== "data") continue;
            const { table, dataIndex } = entry;
            if (col >= table.startCol && col <= table.endCol) {
                const colDef = table.columnForSheetCol(col);
                if (!colDef) return "";
                return table.getValue(dataIndex, colDef.id) ?? "";
            }
        }
        return "";
    }

    /**
     * Get the table + metadata for a cell.
     * @param {number} row
     * @param {number} col
     * @returns {{ table: TableStore, rowType: string, dataIndex: number, colDef: Object } | null}
     */
    getCellInfo(row, col) {
        const entries = this.#rowIndex.get(row);
        if (!entries) return null;

        for (const entry of entries) {
            const { table } = entry;
            if (col >= table.startCol && col <= table.endCol) {
                const colDef = table.columnForSheetCol(col);
                return { ...entry, colDef };
            }
        }
        return null;
    }

    /**
     * Return all table-ownership entries for a sheet row. An entry is
     * `{ table, rowType, dataIndex }` where rowType is 'header'|'entry'|'data'
     * and dataIndex is the position in the table's sortedFilteredRows (or -1
     * for non-data rows). Used by SpreadsheetSession to route row-delete /
     * row-insert through the table when a structural op falls inside one.
     * @param {number} row
     * @returns {Array<{ table: TableStore, rowType: 'header'|'entry'|'data', dataIndex: number }>}
     */
    getRowOwners(row) {
        return this.#rowIndex.get(row) ?? [];
    }

    /**
     * Returns true if the cell is in the buffer zone below a table's data rows —
     * visually part of the table but not an actual header/entry/data row.
     * Editing these cells should be blocked.
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isTableShadowCell(row, col) {
        for (const table of this.stores.values()) {

            if (col < table.startCol || col > table.endCol) continue;
            const lastDataRow = table.startRow + 1 + table.sortedFilteredRows.length;
            const bufferEnd = lastDataRow + BUFFER_ROWS;
            if (row > lastDataRow && row <= bufferEnd) return true;
        }
        return false;
    }

    /**
     * Maximum sheet row occupied by any inline table (used for effectiveRowCount).
     */
    get maxInlineTableRow() {
        let max = 0;
        for (const table of this.stores.values()) {

            const last = table.startRow + 2 + table.sortedFilteredRows.length + BUFFER_ROWS;
            if (last > max) max = last;
        }
        return max;
    }

    // ─── Table CRUD ───────────────────────────────────────────────────────────

    /**
     * Create a new table: a source entry (schema + data) in root.tableData, plus a
     * default view entry in sheet.tableViews positioned on the grid.
     * The view has `visibleColumns = []` which means "show all source columns" —
     * new columns added later automatically appear.
     *
     * @param {{ name?: string, startRow: number, startCol: number,
     *           columns: Array<{id:string, name:string, type?:string, required?:boolean,
     *                           hAlign?:string, isNonEntry?:boolean, defaultFormula?:string}>,
     *           sheetId?: string }} opts
     * @returns {{ sourceId: string, viewId: string }}
     */
    createTable(opts) {
        if (!this.#tablesYMap) return { sourceId: '', viewId: '' };
        const sourceId = `table-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const viewId   = `view-${Date.now() + 1}-${Math.random().toString(36).slice(2, 7)}`;

        const tableDataMap = this.#root?.get('tableData') ?? this.#registry?.getTableDataMap() ?? this.#tablesYMap;

        this.#ydoc.transact(() => {
            // ── Source table in root.tableData (data + schema, not rendered on any grid) ──
            const src = new Y.Map();
            src.set("id", sourceId);
            src.set("name", opts.name ?? "Table");
            src.set("sortColId", null);
            src.set("sortDir", "asc");
            src.set("insertSortColId", null);
            src.set("insertSortDir", "asc");

            const defsMap = new Y.Map();
            const orderArr = new Y.Array();
            for (const c of opts.columns ?? []) {
                const cm = new Y.Map();
                cm.set("id", c.id);
                cm.set("name", c.name);
                cm.set("type", c.type ?? "text");
                cm.set("required", c.required ?? false);
                if (c.hAlign)         cm.set("hAlign", c.hAlign);
                if (c.isNonEntry)     cm.set("isNonEntry", true);
                if (c.defaultFormula) cm.set("defaultFormula", c.defaultFormula);
                defsMap.set(c.id, cm);
                orderArr.push([c.id]);
            }
            src.set("columnDefs", defsMap);
            src.set("columnOrder", orderArr);
            src.set("rows", new Y.Array());
            src.set("filters", new Y.Map());
            tableDataMap.set(sourceId, src);

            // ── View entry in sheet.tableViews (position + column subset) ────────
            const vm = new Y.Map();
            vm.set("id", viewId);
            vm.set("name", opts.name ?? "Table");
            vm.set("mode", "inline");
            vm.set("startRow", opts.startRow);
            vm.set("startCol", opts.startCol);
            vm.set("sortColId", null);
            vm.set("sortDir", "asc");
            vm.set("tableId", sourceId);
            vm.set("visibleColumns", new Y.Array()); // [] = show all columns
            vm.set("persistedFilters", new Y.Map());
            this.#tablesYMap.set(viewId, vm);
        });

        return { sourceId, viewId };
    }

    /**
     * Delete a table by ID.
     * @param {string} tableId
     */
    deleteTable(tableId) {
        if (!this.#tablesYMap) return;
        this.#ydoc.transact(() => {
            this.#tablesYMap.delete(tableId);
        });
    }

    /**
     * Create a view of an existing source table on this sheet.
     * The view shares the source table's rows and column definitions but can show
     * a different subset/ordering of columns and sits at its own grid position.
     *
     * @param {{
     *   tableId: string,
     *   name?: string,
     *   startRow: number,
     *   startCol: number,
     *   visibleColumns?: string[]  ordered subset of source column IDs; all if omitted
     * }} opts
     * @returns {string} new view ID
     */
    createTableView(opts) {
        if (!this.#tablesYMap) return "";
        const viewId = `view-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        this.#ydoc.transact(() => {
            const vm = new Y.Map();
            vm.set("id", viewId);
            vm.set("name", opts.name ?? "View");
            vm.set("mode", "inline");
            vm.set("startRow", opts.startRow);
            vm.set("startCol", opts.startCol);
            vm.set("sortColId", null);
            vm.set("sortDir", "asc");
            vm.set("tableId", opts.tableId);
            const visArr = new Y.Array();
            if (opts.visibleColumns?.length) visArr.push(opts.visibleColumns);
            vm.set("visibleColumns", visArr);
            vm.set("persistedFilters", new Y.Map());
            this.#tablesYMap.set(viewId, vm);
        });

        return viewId;
    }

    // ─── Table lookup ─────────────────────────────────────────────────────────

    getTableByName(name) {
        const upper = String(name).toUpperCase();
        for (const t of this.stores.values()) {
            if (t.name.toUpperCase() === upper) return t;
        }
        return null;
    }

    // ─── Formula function registration ────────────────────────────────────────

    /**
     * Register TABLE_* formula functions into a FormulaEngine.
     * Functions look up the first table by name or use the "active" table heuristic.
     * @param {import('../../../formulas/FormulaEngine.svelte.js').FormulaEngine} formulaEngine
     * @param {any} [session] SpreadsheetSession — used for cross-sheet table fallback
     */
    registerFunctions(formulaEngine, session, { trackForInvalidation = false } = {}) {
        const byName = (name) => this.getTableByName(name) ?? session?.getCrossSheetTable(name) ?? null;
        const fns = buildTableFunctions(byName);
        const clear = fns.clearColumnCache ?? null;
        // The persistent engine registers these functions once for its lifetime but
        // they cache materialised source columns; retain the cache-clear hook so table
        // data changes can drop it (otherwise =TABLE_*() grid cells return stale
        // results). Callers that own a longer-lived engine of their own (e.g. warmed
        // cross-sheet engines) capture the returned hook instead of setting this flag.
        if (trackForInvalidation) this.#clearFormulaColumnCache = clear;
        for (const [name, fn] of fns) {
            formulaEngine.registerFunction(name, fn);
        }
        return clear;
    }

    /**
     * Drop the registered TABLE_* functions' cached source columns so grid formulas
     * (=TABLE_SUM('Ledger',…) etc.) recompute against current rows. Call whenever a
     * table's data changes — see SpreadsheetSession's onTableChange handler.
     */
    clearFormulaColumnCache() {
        this.#clearFormulaColumnCache?.();
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    destroy() {
        for (const cleanup of this.#observers) cleanup();
        this.#observers = [];
        for (const [tableId, store] of this.stores) {
            if (this.#ownedStores.has(tableId)) store.destroy();
        }
        this.stores.clear();
        this.#ownedStores.clear();
        this.tableList = [];
    }
}

export default TableManager;
