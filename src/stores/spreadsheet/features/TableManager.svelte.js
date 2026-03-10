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
import { CELL_TYPE } from "./SheetRenderContext.svelte.js";

/** Extra buffer rows below the last data row so the table feels "infinite" */
const BUFFER_ROWS = 10;

export class TableManager {
    /** @type {import('yjs').Map} tablesYMap from sheet */
    #tablesYMap;

    /** @type {import('yjs').Doc} */
    #ydoc;

    /** @type {Function[]} */
    #observers = [];

    /** tableId → TableStore */
    stores = new Map();

    /** Reactive list of all table IDs (for iteration in templates) */
    tableList = $state([]);

    /**
     * O(1) lookup: row → { table: TableStore, rowType: string, dataIndex: number }
     * Built by #rebuildRowIndex(). Rebuilt whenever any table's row count changes.
     */
    #rowIndex = new Map();

    constructor(sheet, ydoc) {
        this.#ydoc = ydoc;
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
        const store = new TableStore(tableYMap, this.#ydoc);
        this.stores.set(tableId, store);
        this.tableList = [...this.tableList, tableId];
        // Rebuild index when this table's row count changes
        // Using a micro-effect pattern via store observers
        const rebuildOnChange = () => this.#rebuildRowIndex();
        // We observe the rows Y.Array of this table for simplicity
        const rowArr = tableYMap.get("rows");
        if (rowArr) {
            rowArr.observe(rebuildOnChange);
            this.#observers.push(() => rowArr.unobserve(rebuildOnChange));
        }
        // Also observe top-level for startRow/startCol changes
        tableYMap.observe(rebuildOnChange);
        this.#observers.push(() => tableYMap.unobserve(rebuildOnChange));
    }

    #removeTableStore(tableId) {
        const store = this.stores.get(tableId);
        if (store) {
            store.destroy();
            this.stores.delete(tableId);
            this.tableList = this.tableList.filter((id) => id !== tableId);
        }
    }

    #rebuildRowIndex() {
        this.#rowIndex.clear();
        for (const table of this.stores.values()) {
            if (table.mode !== "inline") continue;
            const headerRow = table.startRow;
            const entryRow = table.startRow + 1;
            const dataStart = table.startRow + 2;
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
     * Whether this (row, col) is inside a viewport-mode table's anchor area.
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isViewportCell(row, col) {
        for (const table of this.stores.values()) {
            if (table.mode !== "viewport") continue;
            if (
                row >= table.vpStartRow &&
                row <= table.vpEndRow &&
                col >= table.vpStartCol &&
                col <= table.vpEndCol
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * For Grid.svelte sticky headers: return descriptors for inline table headers
     * that have scrolled past the top.
     */
    getStickyHeaders(scrollTop, frozenHeight, rowMetrics, colMetrics) {
        const result = [];
        for (const table of this.stores.values()) {
            if (table.mode !== "inline") continue;
            if (!rowMetrics || !colMetrics) continue;
            const headerY = rowMetrics.offsetOf(table.startRow);
            if (scrollTop + frozenHeight > headerY + rowMetrics.sizeOf(table.startRow)) {
                const leftPx = colMetrics.offsetOf(table.startCol);
                const rightPx = colMetrics.offsetOf(table.endCol + 1);
                result.push({
                    table,
                    leftPx,
                    widthPx: rightPx - leftPx,
                    heightPx: rowMetrics.sizeOf(table.startRow),
                });
            }
        }
        return result;
    }

    /**
     * Maximum sheet row occupied by any inline table (used for effectiveRowCount).
     */
    get maxInlineTableRow() {
        let max = 0;
        for (const table of this.stores.values()) {
            if (table.mode !== "inline") continue;
            const last = table.startRow + 2 + table.sortedFilteredRows.length + BUFFER_ROWS;
            if (last > max) max = last;
        }
        return max;
    }

    /**
     * All viewport-mode tables (for overlay rendering in Grid.svelte).
     */
    get viewportTables() {
        return [...this.stores.values()].filter((t) => t.mode === "viewport");
    }

    // ─── Table CRUD ───────────────────────────────────────────────────────────

    /**
     * Create a new inline table.
     * @param {{ name?: string, startRow: number, startCol: number, columns: Array<{id,name,type?,required?}>, mode?: string, vpStartRow?: number, vpStartCol?: number, vpEndRow?: number, vpEndCol?: number }} opts
     * @returns {string} tableId
     */
    createTable(opts) {
        if (!this.#tablesYMap) return "";
        const tableId = `table-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        this.#ydoc.transact(() => {
            const tm = new Y.Map();
            tm.set("id", tableId);
            tm.set("name", opts.name ?? "Table");
            tm.set("mode", opts.mode ?? "inline");
            tm.set("startRow", opts.startRow);
            tm.set("startCol", opts.startCol);
            tm.set("sortColId", null);
            tm.set("sortDir", "asc");

            const colArr = new Y.Array();
            for (const c of opts.columns ?? []) {
                const cm = new Y.Map();
                cm.set("id", c.id);
                cm.set("name", c.name);
                cm.set("type", c.type ?? "text");
                cm.set("required", c.required ?? false);
                colArr.push([cm]);
            }
            tm.set("columns", colArr);
            tm.set("rows", new Y.Array());
            tm.set("filters", new Y.Map());

            if (opts.mode === "viewport") {
                tm.set("vpStartRow", opts.vpStartRow ?? opts.startRow);
                tm.set("vpStartCol", opts.vpStartCol ?? opts.startCol);
                tm.set("vpEndRow", opts.vpEndRow ?? opts.startRow + 10);
                tm.set("vpEndCol", opts.vpEndCol ?? opts.startCol + (opts.columns?.length ?? 1));
            }

            this.#tablesYMap.set(tableId, tm);
        });

        return tableId;
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

    // ─── Formula function registration ────────────────────────────────────────

    /**
     * Register TABLE_* formula functions into a FormulaEngine.
     * Functions look up the first table by name or use the "active" table heuristic.
     * @param {import('../../../formulas/FormulaEngine.svelte.js').FormulaEngine} formulaEngine
     */
    registerFunctions(formulaEngine) {
        /**
         * Find a table store by name (case-insensitive).
         * @param {string} name
         */
        const byName = (name) => {
            const upper = String(name).toUpperCase();
            for (const t of this.stores.values()) {
                if (t.name.toUpperCase() === upper) return t;
            }
            return null;
        };

        // TABLE_GET(tableName, rowIndex, colId) → value at display index
        formulaEngine.registerFunction("TABLE_GET", (tableName, rowIndex, colId) => {
            const t = byName(tableName);
            if (!t) return null;
            return t.getValue(Number(rowIndex), String(colId)) ?? null;
        });

        // TABLE_SUM(tableName, colId) → sum of all values in colId
        formulaEngine.registerFunction("TABLE_SUM", (tableName, colId) => {
            const t = byName(tableName);
            if (!t) return 0;
            return t
                .getColumn(String(colId))
                .reduce((acc, v) => acc + (Number(v) || 0), 0);
        });

        // TABLE_COUNT(tableName) → number of rows
        formulaEngine.registerFunction("TABLE_COUNT", (tableName) => {
            const t = byName(tableName);
            return t ? t.getRowCount() : 0;
        });

        // TABLE_COL(tableName, colId) → flat array of all values
        formulaEngine.registerFunction("TABLE_COL", (tableName, colId) => {
            const t = byName(tableName);
            if (!t) return [];
            return t.getColumn(String(colId));
        });

        // TABLE_CUMSUM(tableName, colId, upToIndex) → cumulative sum
        formulaEngine.registerFunction("TABLE_CUMSUM", (tableName, colId, upToIndex) => {
            const t = byName(tableName);
            if (!t) return 0;
            return t.getCumulativeSum(String(colId), Number(upToIndex));
        });

        // TABLE_FILTER(tableName, colId, op, value) → count of matching rows
        formulaEngine.registerFunction("TABLE_FILTER", (tableName, colId, op, value) => {
            const t = byName(tableName);
            if (!t) return 0;
            const col = String(colId);
            const v = value;
            const opStr = String(op);
            return t.sortedFilteredRows.filter((row) => {
                const rv = row[col];
                switch (opStr) {
                    case "=": return rv == v;
                    case "<>": return rv != v;
                    case ">": return Number(rv) > Number(v);
                    case "<": return Number(rv) < Number(v);
                    case ">=": return Number(rv) >= Number(v);
                    case "<=": return Number(rv) <= Number(v);
                    case "contains": return String(rv ?? "").toLowerCase().includes(String(v).toLowerCase());
                    default: return false;
                }
            }).length;
        });
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    destroy() {
        for (const cleanup of this.#observers) cleanup();
        this.#observers = [];
        for (const store of this.stores.values()) store.destroy();
        this.stores.clear();
        this.tableList = [];
    }
}

export default TableManager;
