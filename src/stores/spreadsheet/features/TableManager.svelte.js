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
import { matchCondition } from "./tableFormulaEval.js";
import { CELL_TYPE } from "./SheetRenderContext.svelte.js";
import { perfMon } from "../perf/PerfMonitor.js";

/** Extra buffer rows below the last data row so the table feels "infinite" */
const BUFFER_ROWS = 10;

export class TableManager {
    /** @type {import('yjs').Map<any>} tablesYMap from sheet */
    #tablesYMap;

    /** @type {import('yjs').Doc} */
    #ydoc;

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

    /**
     * @param {import('yjs').Map<any>} sheet
     * @param {import('yjs').Doc} ydoc
     * @param {import('./DocumentTableRegistry.svelte.js').DocumentTableRegistry | null} [registry]
     */
    constructor(sheet, ydoc, registry = null) {
        this.#ydoc = ydoc;
        this.#registry = registry;
        this.#tablesYMap = sheet.get("tables");

        if (!this.#tablesYMap) {
            // Older documents without tables support — no-op
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
        const rowArr = tableYMap.get("rows");
        if (rowArr) {
            rowArr.observeDeep(rebuildOnChange);
            this.#observers.push(() => rowArr.unobserveDeep(rebuildOnChange));
        }
        // Observe filters Y.Map for filter changes that affect sortedFilteredRows.length.
        // Note: local (session-only) filters are handled via store._onFilterChange below.
        const filtersYMap = tableYMap.get("filters");
        if (filtersYMap) {
            filtersYMap.observeDeep(rebuildOnChange);
            this.#observers.push(() => filtersYMap.unobserveDeep(rebuildOnChange));
        }
        // Wire local filter changes (not persisted in Yjs) so that setFilter /
        // clearFilter / clearAllFilters trigger a row-index rebuild and canvas repaint.
        store._onFilterChange = rebuildOnChange;
        this.#observers.push(() => { store._onFilterChange = null; });
        // Also observe top-level for startRow/startCol changes
        // This fires after TableStore's top-level observer (same attachment order)
        tableYMap.observe(rebuildOnChange);
        this.#observers.push(() => tableYMap.unobserve(rebuildOnChange));
        // Observe column definition/order changes so the canvas repaints when
        // column metadata changes. These don't affect row structure so we just bump tableVersion.
        const defsMap = tableYMap.get("columnDefs");
        const orderArr = tableYMap.get("columnOrder");
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
            // Source-only tables (isSourceOnly = true) hold data + schema but are not
            // displayed on the grid — skip them in the row index.
            if (table.isSourceOnly) continue;
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
     * Returns true if the cell is in the buffer zone below a table's data rows —
     * visually part of the table but not an actual header/entry/data row.
     * Editing these cells should be blocked.
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isTableShadowCell(row, col) {
        for (const table of this.stores.values()) {
            if (table.isSourceOnly) continue;
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
            if (table.isSourceOnly) continue;
            const last = table.startRow + 2 + table.sortedFilteredRows.length + BUFFER_ROWS;
            if (last > max) max = last;
        }
        return max;
    }

    // ─── Table CRUD ───────────────────────────────────────────────────────────

    /**
     * Create a new table: a source-only entity (schema + data) plus a default view
     * positioned on the grid. The view has `visibleColumns = []` which means "show
     * all source columns" — new columns added later automatically appear.
     *
     * @param {{ name?: string, startRow: number, startCol: number,
     *           columns: Array<{id:string, name:string, type?:string, required?:boolean,
     *                           hAlign?:string, isNonEntry?:boolean, formula?:string}>,
     *           sheetId?: string }} opts
     * @returns {{ sourceId: string, viewId: string }}
     */
    createTable(opts) {
        if (!this.#tablesYMap) return { sourceId: '', viewId: '' };
        const sourceId = `table-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const viewId   = `view-${Date.now() + 1}-${Math.random().toString(36).slice(2, 7)}`;

        this.#ydoc.transact(() => {
            // ── Source table (data + schema, not rendered on grid) ────────────────
            const src = new Y.Map();
            src.set("id", sourceId);
            src.set("name", opts.name ?? "Table");
            src.set("isSourceOnly", true);
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
                if (c.hAlign)      cm.set("hAlign", c.hAlign);
                if (c.isNonEntry)  cm.set("isNonEntry", true);
                if (c.formula)     cm.set("formula", c.formula);
                defsMap.set(c.id, cm);
                orderArr.push([c.id]);
            }
            src.set("columnDefs", defsMap);
            src.set("columnOrder", orderArr);
            src.set("rows", new Y.Array());
            this.#tablesYMap.set(sourceId, src);

            // ── Default view (positioned on grid, shows all columns) ──────────────
            const vm = new Y.Map();
            vm.set("id", viewId);
            vm.set("name", opts.name ?? "Table");
            vm.set("mode", "inline");
            vm.set("startRow", opts.startRow);
            vm.set("startCol", opts.startCol);
            vm.set("sortColId", null);
            vm.set("sortDir", "asc");
            vm.set("sourceTableId", sourceId);
            vm.set("sourceSheetId", opts.sheetId ?? "");
            vm.set("visibleColumns", new Y.Array()); // [] = show all columns
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
     * Create a view of an existing table on this sheet.
     * The view shares the source table's rows and column definitions but can show
     * a different subset/ordering of columns and sits at its own grid position.
     *
     * @param {{
     *   sourceSheetId: string,
     *   sourceTableId: string,
     *   name?: string,
     *   startRow: number,
     *   startCol: number,
     *   visibleColumns?: string[]  ordered subset of source column IDs; all if omitted
     * }} opts
     * @returns {string} new view's tableId
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
            vm.set("sourceSheetId", opts.sourceSheetId);
            vm.set("sourceTableId", opts.sourceTableId);
            const visArr = new Y.Array();
            if (opts.visibleColumns?.length) visArr.push(opts.visibleColumns);
            vm.set("visibleColumns", visArr);
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
    registerFunctions(formulaEngine, session) {
        const byName = (name) => this.getTableByName(name) ?? session?.getCrossSheetTable(name) ?? null;

        // ── Single-cell access ─────────────────────────────────────────────────
        // TABLE_GET(tableName, rowIndex, colId) → value at display index
        formulaEngine.registerFunction("TABLE_GET", (tableName, rowIndex, colId) => {
            const t = byName(tableName);
            if (!t) return null;
            return t.getValue(Number(rowIndex), t.resolveColId(String(colId))) ?? null;
        });

        // ── Column access ─────────────────────────────────────────────────────
        // TABLE_COL(tableName, colId) → flat array of all values
        formulaEngine.registerFunction("TABLE_COL", (tableName, colId) => {
            const t = byName(tableName);
            if (!t) return [];
            return t.getColumn(t.resolveColId(String(colId)));
        });

        // ── Row count ─────────────────────────────────────────────────────────
        // TABLE_COUNT(tableName) → number of rows
        formulaEngine.registerFunction("TABLE_COUNT", (tableName) => {
            const t = byName(tableName);
            return t ? t.getRowCount() : 0;
        });

        // ── Simple aggregates ─────────────────────────────────────────────────
        // TABLE_SUM(tableName, colId) → sum of all values
        formulaEngine.registerFunction("TABLE_SUM", (tableName, colId) => {
            const t = byName(tableName);
            if (!t) return 0;
            return t.getColumn(t.resolveColId(String(colId))).reduce((acc, v) => acc + (Number(v) || 0), 0);
        });

        // TABLE_AVG(tableName, colId) → average
        formulaEngine.registerFunction("TABLE_AVG", (tableName, colId) => {
            const t = byName(tableName);
            if (!t) return 0;
            const vals = t.getColumn(t.resolveColId(String(colId))).map(Number).filter(v => !isNaN(v));
            return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
        });

        // TABLE_MIN(tableName, colId) → minimum
        formulaEngine.registerFunction("TABLE_MIN", (tableName, colId) => {
            const t = byName(tableName);
            if (!t) return 0;
            const vals = t.getColumn(t.resolveColId(String(colId))).map(Number).filter(v => !isNaN(v));
            return vals.length ? Math.min(...vals) : 0;
        });

        // TABLE_MAX(tableName, colId) → maximum
        formulaEngine.registerFunction("TABLE_MAX", (tableName, colId) => {
            const t = byName(tableName);
            if (!t) return 0;
            const vals = t.getColumn(t.resolveColId(String(colId))).map(Number).filter(v => !isNaN(v));
            return vals.length ? Math.max(...vals) : 0;
        });

        // ── Running / cumulative ───────────────────────────────────────────────
        // TABLE_CUMSUM(tableName, colId, upToIndex) → cumulative sum
        formulaEngine.registerFunction("TABLE_CUMSUM", (tableName, colId, upToIndex) => {
            const t = byName(tableName);
            if (!t) return 0;
            return t.getCumulativeSum(t.resolveColId(String(colId)), Number(upToIndex));
        });

        // ── Conditional aggregates ────────────────────────────────────────────
        // All conditional functions use t.getValue(i, colId) so that computed
        // (formula) columns are correctly evaluated rather than returning null.

        // TABLE_SUMIF(tableName, sumColId, filterColId, op, filterValue) → conditional sum
        formulaEngine.registerFunction("TABLE_SUMIF", (tableName, sumColId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const sId = t.resolveColId(String(sumColId));
            const fId = t.resolveColId(String(filterColId));
            const n = t.getRowCount();
            let sum = 0;
            for (let i = 0; i < n; i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue))
                    sum += Number(t.getValue(i, sId)) || 0;
            }
            return sum;
        });

        // TABLE_SUMIFS(tableName, sumColId, col1, op1, val1, ...) → multi-condition sum
        formulaEngine.registerFunction("TABLE_SUMIFS", (tableName, sumColId, ...triplets) => {
            const t = byName(tableName);
            if (!t || triplets.length < 3) return 0;
            const sId = t.resolveColId(String(sumColId));
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            const n = t.getRowCount();
            let sum = 0;
            for (let i = 0; i < n; i++) {
                if (conds.every(c => matchCondition(t.getValue(i, c.col), c.op, c.val)))
                    sum += Number(t.getValue(i, sId)) || 0;
            }
            return sum;
        });

        // TABLE_COUNTIF(tableName, filterColId, op, filterValue) → conditional count
        formulaEngine.registerFunction("TABLE_COUNTIF", (tableName, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const fId = t.resolveColId(String(filterColId));
            const n = t.getRowCount();
            let count = 0;
            for (let i = 0; i < n; i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) count++;
            }
            return count;
        });

        // TABLE_COUNTIFS(tableName, col1, op1, val1, ...) → multi-condition count
        formulaEngine.registerFunction("TABLE_COUNTIFS", (tableName, ...triplets) => {
            const t = byName(tableName);
            if (!t || triplets.length < 3) return 0;
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            const n = t.getRowCount();
            let count = 0;
            for (let i = 0; i < n; i++) {
                if (conds.every(c => matchCondition(t.getValue(i, c.col), c.op, c.val))) count++;
            }
            return count;
        });

        // TABLE_AVGIF(tableName, sumColId, filterColId, op, filterValue) → conditional average
        formulaEngine.registerFunction("TABLE_AVGIF", (tableName, sumColId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const sId = t.resolveColId(String(sumColId));
            const fId = t.resolveColId(String(filterColId));
            const n = t.getRowCount();
            let sum = 0, count = 0;
            for (let i = 0; i < n; i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) {
                    sum += Number(t.getValue(i, sId)) || 0;
                    count++;
                }
            }
            return count ? sum / count : 0;
        });

        // TABLE_MINIF(tableName, colId, filterColId, op, filterValue) → conditional min
        formulaEngine.registerFunction("TABLE_MINIF", (tableName, colId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const cId = t.resolveColId(String(colId));
            const fId = t.resolveColId(String(filterColId));
            const n = t.getRowCount();
            let min = Infinity;
            for (let i = 0; i < n; i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) {
                    const v = Number(t.getValue(i, cId));
                    if (!isNaN(v) && v < min) min = v;
                }
            }
            return isFinite(min) ? min : 0;
        });

        // TABLE_MAXIF(tableName, colId, filterColId, op, filterValue) → conditional max
        formulaEngine.registerFunction("TABLE_MAXIF", (tableName, colId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const cId = t.resolveColId(String(colId));
            const fId = t.resolveColId(String(filterColId));
            const n = t.getRowCount();
            let max = -Infinity;
            for (let i = 0; i < n; i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) {
                    const v = Number(t.getValue(i, cId));
                    if (!isNaN(v) && v > max) max = v;
                }
            }
            return isFinite(max) ? max : 0;
        });

        // TABLE_FILTER (legacy — use TABLE_COUNTIF instead)
        // TABLE_FILTER(tableName, colId, op, value) → count of matching rows
        formulaEngine.registerFunction("TABLE_FILTER", (tableName, colId, op, value) => {
            const t = byName(tableName);
            if (!t) return 0;
            const cId = t.resolveColId(String(colId));
            const n = t.getRowCount();
            let count = 0;
            for (let i = 0; i < n; i++) {
                if (matchCondition(t.getValue(i, cId), String(op), value)) count++;
            }
            return count;
        });

        // ── Array-returning queries ────────────────────────────────────────────

        // TABLE_FILTERCOL(tableName, colId, filterColId, op, filterValue)
        // → flat array of values from colId for rows matching the condition.
        // Example: =SUM(TABLE_FILTERCOL("Sales", "amount", "region", "=", "West"))
        formulaEngine.registerFunction("TABLE_FILTERCOL", (tableName, colId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return [];
            const cId = t.resolveColId(String(colId));
            const fId = t.resolveColId(String(filterColId));
            const n = t.getRowCount();
            const result = [];
            for (let i = 0; i < n; i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue))
                    result.push(t.getValue(i, cId) ?? null);
            }
            return result;
        });

        // TABLE_FILTERCOLIFS(tableName, colId, col1, op1, val1, col2, op2, val2, ...)
        // → flat array of values from colId for rows matching ALL conditions.
        // Example: =AVERAGE(TABLE_FILTERCOLIFS("Sales","amount","region","=","West","year","=",2024))
        formulaEngine.registerFunction("TABLE_FILTERCOLIFS", (tableName, colId, ...triplets) => {
            const t = byName(tableName);
            if (!t || triplets.length < 3) return [];
            const cId = t.resolveColId(String(colId));
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            const n = t.getRowCount();
            const result = [];
            for (let i = 0; i < n; i++) {
                if (conds.every(c => matchCondition(t.getValue(i, c.col), c.op, c.val)))
                    result.push(t.getValue(i, cId) ?? null);
            }
            return result;
        });

        // TABLE_LOOKUP(tableName, lookupColId, lookupValue, returnColId)
        // → value from returnColId in the first row where lookupColId equals lookupValue.
        // Returns #N/A if no match.
        // Example: =TABLE_LOOKUP("Products", "sku", A1, "price")
        formulaEngine.registerFunction("TABLE_LOOKUP", (tableName, lookupColId, lookupValue, returnColId) => {
            const t = byName(tableName);
            if (!t) return '#N/A';
            const lId = t.resolveColId(String(lookupColId));
            const rId = t.resolveColId(String(returnColId));
            const n = t.getRowCount();
            for (let i = 0; i < n; i++) {
                if (matchCondition(t.getValue(i, lId), '=', lookupValue))
                    return t.getValue(i, rId) ?? null;
            }
            return '#N/A';
        });

        // TABLE_AVGIFS(tableName, sumColId, col1, op1, val1, ...) → conditional average
        // Example: =TABLE_AVGIFS("Sales", "amount", "region", "=", "West", "year", "=", 2024)
        formulaEngine.registerFunction("TABLE_AVGIFS", (tableName, sumColId, ...triplets) => {
            const t = byName(tableName);
            if (!t || triplets.length < 3) return 0;
            const sId = t.resolveColId(String(sumColId));
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            const n = t.getRowCount();
            let sum = 0, count = 0;
            for (let i = 0; i < n; i++) {
                if (conds.every(c => matchCondition(t.getValue(i, c.col), c.op, c.val))) {
                    sum += Number(t.getValue(i, sId)) || 0;
                    count++;
                }
            }
            return count ? sum / count : 0;
        });
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
