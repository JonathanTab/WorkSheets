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
import { TableStore, TABLE_ACCENT_COLORS } from "./TableStore.svelte.js";
import { CELL_TYPE } from "./SheetRenderContext.svelte.js";

/** Extra buffer rows below the last data row so the table feels "infinite" */
const BUFFER_ROWS = 10;

/**
 * Match a row field value against a filter condition.
 * Supports date-aware ISO string comparison, numeric comparison, and string ops.
 */
function matchCond(rowVal, op, filterVal) {
    const rv = rowVal;
    const fv = filterVal;

    // Date-aware comparison
    if (typeof rv === 'string' && typeof fv === 'string' &&
        rv.includes('-') && fv.includes('-')) {
        const rvDate = Date.parse(rv);
        const fvDate = Date.parse(fv);
        if (!isNaN(rvDate) && !isNaN(fvDate)) {
            switch (op) {
                case '=': return rvDate === fvDate;
                case '<>': case '!=': return rvDate !== fvDate;
                case '>': return rvDate > fvDate;
                case '<': return rvDate < fvDate;
                case '>=': return rvDate >= fvDate;
                case '<=': return rvDate <= fvDate;
            }
        }
    }

    // Numeric comparison
    if (['>', '<', '>=', '<='].includes(op)) {
        const rvNum = Number(rv);
        const fvNum = Number(fv);
        if (!isNaN(rvNum) && !isNaN(fvNum)) {
            switch (op) {
                case '>': return rvNum > fvNum;
                case '<': return rvNum < fvNum;
                case '>=': return rvNum >= fvNum;
                case '<=': return rvNum <= fvNum;
            }
        }
    }

    switch (op) {
        case '=': case '==': return String(rv ?? '') === String(fv ?? '');
        case '<>': case '!=': return String(rv ?? '') !== String(fv ?? '');
        case '>': return String(rv ?? '') > String(fv ?? '');
        case '<': return String(rv ?? '') < String(fv ?? '');
        case '>=': return String(rv ?? '') >= String(fv ?? '');
        case '<=': return String(rv ?? '') <= String(fv ?? '');
        case 'contains': return String(rv ?? '').toLowerCase().includes(String(fv ?? '').toLowerCase());
        case 'startswith': return String(rv ?? '').toLowerCase().startsWith(String(fv ?? '').toLowerCase());
        case 'notcontains': return !String(rv ?? '').toLowerCase().includes(String(fv ?? '').toLowerCase());
        default: return false;
    }
}

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
     * Incremented every time #rebuildRowIndex() runs.
     * Grid tracks this to trigger repaints when table data changes.
     */
    tableVersion = $state(0);

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
        // Observe filters Y.Map for filter changes that affect sortedFilteredRows.length
        const filtersYMap = tableYMap.get("filters");
        if (filtersYMap) {
            filtersYMap.observeDeep(rebuildOnChange);
            this.#observers.push(() => filtersYMap.unobserveDeep(rebuildOnChange));
        }
        // Also observe top-level for startRow/startCol changes
        // This fires after TableStore's top-level observer (same attachment order)
        tableYMap.observe(rebuildOnChange);
        this.#observers.push(() => tableYMap.unobserve(rebuildOnChange));
        // Observe column definition changes (type, name, typeConfig, etc.) so the
        // canvas repaints when column metadata changes. Column changes don't affect
        // row structure, so we just bump tableVersion without rebuilding the index.
        const colArr = tableYMap.get("columns");
        if (colArr) {
            const bumpOnColChange = () => { this.tableVersion++; };
            colArr.observeDeep(bumpOnColChange);
            this.#observers.push(() => colArr.unobserveDeep(bumpOnColChange));
        }
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
     * Create a new inline table.
     * @param {{ name?: string, accentColor?: string, startRow: number, startCol: number, columns: Array<{id:string, name:string, type?:string, required?:boolean, hAlign?:string, isNonEntry?:boolean, formula?:string}> }} opts
     * @returns {string} tableId
     */
    createTable(opts) {
        if (!this.#tablesYMap) return "";
        const tableId = `table-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        // Auto-assign accent color from palette based on current table count
        const accentColor = opts.accentColor ??
            TABLE_ACCENT_COLORS[this.tableList.length % TABLE_ACCENT_COLORS.length];

        this.#ydoc.transact(() => {
            const tm = new Y.Map();
            tm.set("id", tableId);
            tm.set("name", opts.name ?? "Table");
            tm.set("mode", "inline");
            tm.set("startRow", opts.startRow);
            tm.set("startCol", opts.startCol);
            tm.set("sortColId", null);
            tm.set("sortDir", "asc");
            tm.set("accentColor", accentColor);

            const colArr = new Y.Array();
            for (const c of opts.columns ?? []) {
                const cm = new Y.Map();
                cm.set("id", c.id);
                cm.set("name", c.name);
                cm.set("type", c.type ?? "text");
                cm.set("required", c.required ?? false);
                if (c.hAlign) cm.set("hAlign", c.hAlign);
                if (c.isNonEntry) cm.set("isNonEntry", true);
                if (c.formula) cm.set("formula", c.formula);
                colArr.push([cm]);
            }
            tm.set("columns", colArr);
            tm.set("rows", new Y.Array());
            tm.set("filters", new Y.Map());

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
        const byName = (name) => {
            const upper = String(name).toUpperCase();
            for (const t of this.stores.values()) {
                if (t.name.toUpperCase() === upper) return t;
            }
            return null;
        };

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
        // TABLE_SUMIF(tableName, sumColId, filterColId, op, filterValue) → conditional sum
        formulaEngine.registerFunction("TABLE_SUMIF", (tableName, sumColId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const sId = t.resolveColId(String(sumColId));
            const fId = t.resolveColId(String(filterColId));
            return t.sortedFilteredRows.reduce((acc, row) =>
                acc + (matchCond(row[fId], String(op), filterValue) ? (Number(row[sId]) || 0) : 0), 0);
        });

        // TABLE_SUMIFS(tableName, sumColId, col1, op1, val1, ...) → multi-condition sum
        formulaEngine.registerFunction("TABLE_SUMIFS", (tableName, sumColId, ...triplets) => {
            const t = byName(tableName);
            if (!t || triplets.length < 3) return 0;
            const sId = t.resolveColId(String(sumColId));
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            return t.sortedFilteredRows.reduce((acc, row) => {
                const allMatch = conds.every(c => matchCond(row[c.col], c.op, c.val));
                return acc + (allMatch ? (Number(row[sId]) || 0) : 0);
            }, 0);
        });

        // TABLE_COUNTIF(tableName, filterColId, op, filterValue) → conditional count
        formulaEngine.registerFunction("TABLE_COUNTIF", (tableName, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const fId = t.resolveColId(String(filterColId));
            return t.sortedFilteredRows.filter(row =>
                matchCond(row[fId], String(op), filterValue)).length;
        });

        // TABLE_COUNTIFS(tableName, col1, op1, val1, ...) → multi-condition count
        formulaEngine.registerFunction("TABLE_COUNTIFS", (tableName, ...triplets) => {
            const t = byName(tableName);
            if (!t || triplets.length < 3) return 0;
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            return t.sortedFilteredRows.filter(row =>
                conds.every(c => matchCond(row[c.col], c.op, c.val))).length;
        });

        // TABLE_AVGIF(tableName, sumColId, filterColId, op, filterValue) → conditional average
        formulaEngine.registerFunction("TABLE_AVGIF", (tableName, sumColId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const sId = t.resolveColId(String(sumColId));
            const fId = t.resolveColId(String(filterColId));
            const matching = t.sortedFilteredRows.filter(row =>
                matchCond(row[fId], String(op), filterValue));
            if (!matching.length) return 0;
            return matching.reduce((acc, row) => acc + (Number(row[sId]) || 0), 0) / matching.length;
        });

        // TABLE_MINIF(tableName, colId, filterColId, op, filterValue) → conditional min
        formulaEngine.registerFunction("TABLE_MINIF", (tableName, colId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const cId = t.resolveColId(String(colId));
            const fId = t.resolveColId(String(filterColId));
            const vals = t.sortedFilteredRows
                .filter(row => matchCond(row[fId], String(op), filterValue))
                .map(row => Number(row[cId])).filter(v => !isNaN(v));
            return vals.length ? Math.min(...vals) : 0;
        });

        // TABLE_MAXIF(tableName, colId, filterColId, op, filterValue) → conditional max
        formulaEngine.registerFunction("TABLE_MAXIF", (tableName, colId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return 0;
            const cId = t.resolveColId(String(colId));
            const fId = t.resolveColId(String(filterColId));
            const vals = t.sortedFilteredRows
                .filter(row => matchCond(row[fId], String(op), filterValue))
                .map(row => Number(row[cId])).filter(v => !isNaN(v));
            return vals.length ? Math.max(...vals) : 0;
        });

        // TABLE_FILTER (legacy — use TABLE_COUNTIF instead)
        // TABLE_FILTER(tableName, colId, op, value) → count of matching rows
        formulaEngine.registerFunction("TABLE_FILTER", (tableName, colId, op, value) => {
            const t = byName(tableName);
            if (!t) return 0;
            const cId = t.resolveColId(String(colId));
            return t.sortedFilteredRows.filter(row =>
                matchCond(row[cId], String(op), value)).length;
        });

        // ── Array-returning queries ────────────────────────────────────────────

        // TABLE_FILTERCOL(tableName, colId, filterColId, op, filterValue)
        // → flat array of values from colId for rows matching the condition.
        // The result can be passed to SUM, AVERAGE, COUNT, MAX, etc.
        // Example: =SUM(TABLE_FILTERCOL("Sales", "amount", "region", "=", "West"))
        formulaEngine.registerFunction("TABLE_FILTERCOL", (tableName, colId, filterColId, op, filterValue) => {
            const t = byName(tableName);
            if (!t) return [];
            const cId = t.resolveColId(String(colId));
            const fId = t.resolveColId(String(filterColId));
            return t.sortedFilteredRows
                .filter(row => matchCond(row[fId], String(op), filterValue))
                .map(row => row[cId] ?? null);
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
            return t.sortedFilteredRows
                .filter(row => conds.every(c => matchCond(row[c.col], c.op, c.val)))
                .map(row => row[cId] ?? null);
        });

        // TABLE_LOOKUP(tableName, lookupColId, lookupValue, returnColId)
        // → value from returnColId in the first row where lookupColId equals lookupValue.
        // Returns #N/A if no match. Case-insensitive string comparison.
        // Example: =TABLE_LOOKUP("Products", "sku", A1, "price")
        formulaEngine.registerFunction("TABLE_LOOKUP", (tableName, lookupColId, lookupValue, returnColId) => {
            const t = byName(tableName);
            if (!t) return '#N/A';
            const lId = t.resolveColId(String(lookupColId));
            const rId = t.resolveColId(String(returnColId));
            const row = t.sortedFilteredRows.find(r => matchCond(r[lId], '=', lookupValue));
            return row ? (row[rId] ?? null) : '#N/A';
        });

        // TABLE_AVGIFS(tableName, sumColId, col1, op1, val1, ...) → conditional average (multiple conditions)
        // Example: =TABLE_AVGIFS("Sales", "amount", "region", "=", "West", "year", "=", 2024)
        formulaEngine.registerFunction("TABLE_AVGIFS", (tableName, sumColId, ...triplets) => {
            const t = byName(tableName);
            if (!t || triplets.length < 3) return 0;
            const sId = t.resolveColId(String(sumColId));
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            const matching = t.sortedFilteredRows.filter(row => conds.every(c => matchCond(row[c.col], c.op, c.val)));
            if (!matching.length) return 0;
            return matching.reduce((acc, row) => acc + (Number(row[sId]) || 0), 0) / matching.length;
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
