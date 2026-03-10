/**
 * TableStore - Reactive state for a single DB-style table
 *
 * Each table's data lives in a Y.Array of Y.Maps (not in sheet cells) so that
 * rows can be freely inserted/deleted without affecting cell addresses.
 *
 * ## Modes
 *   inline   — header/entry/data rows are rendered inside the grid at startRow
 *   viewport — table is rendered as an overlay panel covering vpStartRow..vpEndRow
 *
 * ## Data layout in Yjs
 *   tableYMap.get('columns')  → Y.Array<Y.Map>  (column definitions)
 *   tableYMap.get('rows')     → Y.Array<Y.Map>  (data rows, each colId→value)
 *   tableYMap.get('sortColId')   → string|null
 *   tableYMap.get('sortDir')     → 'asc'|'desc'
 *   tableYMap.get('filters')     → Y.Map<colId, { op, value }>
 *
 * ## Cumulative-sum cache
 *   getCumulativeSum(colId, upToIndex) uses a per-column Float64Array.
 *   Mark dirty from index i with #markCumDirty(colId, i).
 */

import * as Y from "yjs";

export class TableStore {
    /** @type {import('yjs').Map} */
    #tableYMap;

    /** @type {import('yjs').Doc} */
    #ydoc;

    /** @type {Function[]} cleanup callbacks */
    #observers = [];

    // ── Core identity ────────────────────────────────────────────────────────
    id = $state("");
    name = $state("Table");
    mode = $state("inline"); // 'inline' | 'viewport'

    // ── Inline position ──────────────────────────────────────────────────────
    startRow = $state(0); // row of header
    startCol = $state(0); // first col
    endCol = $state(0); // last col  (derived from column count on init)

    // ── Viewport position (viewport mode only) ───────────────────────────────
    vpStartRow = $state(0);
    vpStartCol = $state(0);
    vpEndRow = $state(0);
    vpEndCol = $state(0);

    // ── Schema & data ────────────────────────────────────────────────────────
    columns = $state([]); // plain objects: { id, name, type, required }
    rows = $state([]); // plain objects: colId → value

    // ── Sort / filter ─────────────────────────────────────────────────────────
    sortColId = $state(null);
    sortDir = $state("asc");
    filters = $state({}); // colId → { op: '='|'>'|'<'|'contains'|..., value }

    // ── Derived sorted+filtered view ──────────────────────────────────────────
    sortedFilteredRows = $derived.by(() => {
        let result = [...this.rows];

        // Apply filters
        for (const [colId, f] of Object.entries(this.filters)) {
            result = result.filter((row) => {
                const v = row[colId];
                switch (f.op) {
                    case "=":
                        return v == f.value;
                    case "<>":
                        return v != f.value;
                    case ">":
                        return Number(v) > Number(f.value);
                    case "<":
                        return Number(v) < Number(f.value);
                    case ">=":
                        return Number(v) >= Number(f.value);
                    case "<=":
                        return Number(v) <= Number(f.value);
                    case "contains":
                        return String(v ?? "")
                            .toLowerCase()
                            .includes(String(f.value).toLowerCase());
                    default:
                        return true;
                }
            });
        }

        // Apply sort
        if (this.sortColId) {
            const col = this.sortColId;
            const dir = this.sortDir === "desc" ? -1 : 1;
            result = result.slice().sort((a, b) => {
                const av = a[col];
                const bv = b[col];
                if (av == null && bv == null) return 0;
                if (av == null) return dir;
                if (bv == null) return -dir;
                if (typeof av === "number" && typeof bv === "number")
                    return dir * (av - bv);
                return dir * String(av).localeCompare(String(bv));
            });
        }

        // Invalidate cumulative cache when the view changes
        this.#cumCache.clear();
        this.#cumDirtyFrom.clear();

        return result;
    });

    // ── Entry form buffer (local only — not in Yjs until committed) ──────────
    entryBuffer = $state({});
    entryErrors = $state({});

    // ── Cumulative sum cache ──────────────────────────────────────────────────
    #cumCache = new Map(); // colId → Float64Array
    #cumDirtyFrom = new Map(); // colId → first dirty index

    /**
     * @param {import('yjs').Map} tableYMap
     * @param {import('yjs').Doc} ydoc
     */
    constructor(tableYMap, ydoc) {
        this.#tableYMap = tableYMap;
        this.#ydoc = ydoc;
        this.#syncFromYjs();
        this.#observeYjs();
    }

    // ─── Yjs sync ────────────────────────────────────────────────────────────

    #syncFromYjs() {
        const m = this.#tableYMap;
        this.id = m.get("id") ?? "";
        this.name = m.get("name") ?? "Table";
        this.mode = m.get("mode") ?? "inline";
        this.startRow = m.get("startRow") ?? 0;
        this.startCol = m.get("startCol") ?? 0;
        this.vpStartRow = m.get("vpStartRow") ?? 0;
        this.vpStartCol = m.get("vpStartCol") ?? 0;
        this.vpEndRow = m.get("vpEndRow") ?? 0;
        this.vpEndCol = m.get("vpEndCol") ?? 0;
        this.sortColId = m.get("sortColId") ?? null;
        this.sortDir = m.get("sortDir") ?? "asc";
        this.#syncColumns();
        this.#syncRows();
        this.#syncFilters();
        // Recompute endCol from columns
        const cols = this.columns;
        this.endCol = cols.length > 0 ? this.startCol + cols.length - 1 : this.startCol;
    }

    #syncColumns() {
        const arr = this.#tableYMap.get("columns");
        if (!arr) {
            this.columns = [];
            return;
        }
        this.columns = arr.toArray().map((c) => (c.toJSON ? c.toJSON() : { ...c }));
        this.endCol = this.startCol + this.columns.length - 1;
    }

    #syncRows() {
        const arr = this.#tableYMap.get("rows");
        if (!arr) {
            this.rows = [];
            return;
        }
        this.rows = arr.toArray().map((r) => (r.toJSON ? r.toJSON() : { ...r }));
        this.#cumCache.clear();
        this.#cumDirtyFrom.clear();
    }

    #syncFilters() {
        const fm = this.#tableYMap.get("filters");
        this.filters = fm ? fm.toJSON() : {};
    }

    #observeYjs() {
        const m = this.#tableYMap;

        // Top-level map observer (id, name, mode, position, sort fields)
        const topObs = () => {
            this.id = m.get("id") ?? this.id;
            this.name = m.get("name") ?? this.name;
            this.mode = m.get("mode") ?? this.mode;
            this.startRow = m.get("startRow") ?? this.startRow;
            this.startCol = m.get("startCol") ?? this.startCol;
            this.vpStartRow = m.get("vpStartRow") ?? this.vpStartRow;
            this.vpStartCol = m.get("vpStartCol") ?? this.vpStartCol;
            this.vpEndRow = m.get("vpEndRow") ?? this.vpEndRow;
            this.vpEndCol = m.get("vpEndCol") ?? this.vpEndCol;
            this.sortColId = m.get("sortColId") ?? null;
            this.sortDir = m.get("sortDir") ?? "asc";
        };
        m.observe(topObs);
        this.#observers.push(() => m.unobserve(topObs));

        // Columns observer
        const colArr = m.get("columns");
        if (colArr) {
            const colObs = () => this.#syncColumns();
            colArr.observe(colObs);
            this.#observers.push(() => colArr.unobserve(colObs));
        }

        // Rows observer (deep – catches cell-level edits too)
        const rowArr = m.get("rows");
        if (rowArr) {
            const rowObs = () => this.#syncRows();
            rowArr.observeDeep(rowObs);
            this.#observers.push(() => rowArr.unobserveDeep(rowObs));
        }

        // Filters observer
        const fm = m.get("filters");
        if (fm) {
            const fObs = () => this.#syncFilters();
            fm.observe(fObs);
            this.#observers.push(() => fm.unobserve(fObs));
        }
    }

    // ─── Mutation API ─────────────────────────────────────────────────────────

    /**
     * Insert a row of data.
     * If table is sorted, insert at the correct sorted position.
     * @param {Object} rowData  colId → value
     */
    insertRow(rowData) {
        const rowArr = this.#tableYMap.get("rows");
        if (!rowArr) return;

        this.#ydoc.transact(() => {
            const yRow = new Y.Map();
            for (const [k, v] of Object.entries(rowData)) {
                yRow.set(k, v);
            }
            // If sorted, find insertion position via binary search
            if (this.sortColId) {
                const sorted = this.sortedFilteredRows;
                const col = this.sortColId;
                const val = rowData[col];
                let lo = 0;
                let hi = sorted.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    const mv = sorted[mid][col];
                    const cmp =
                        typeof val === "number" && typeof mv === "number"
                            ? val - mv
                            : String(val).localeCompare(String(mv));
                    if ((this.sortDir === "asc" ? cmp : -cmp) <= 0) hi = mid;
                    else lo = mid + 1;
                }
                // lo is the position in sorted view; map back to raw row index
                // For simplicity, just push to end (sort derived view handles order)
                rowArr.push([yRow]);
            } else {
                rowArr.push([yRow]);
            }
            // Mark cum cache dirty
            for (const c of this.columns) {
                this.#markCumDirty(c.id, Math.max(0, rowArr.length - 2));
            }
        });
    }

    /**
     * Delete the row at display index (in sortedFilteredRows).
     * @param {number} displayIndex
     */
    deleteRow(displayIndex) {
        const rowArr = this.#tableYMap.get("rows");
        if (!rowArr) return;

        // We need to find the raw index in rows[] that matches the sorted row
        const sortedRow = this.sortedFilteredRows[displayIndex];
        if (!sortedRow) return;

        const rawIndex = this.rows.findIndex((r) => r === sortedRow);
        if (rawIndex < 0) return;

        this.#ydoc.transact(() => {
            rowArr.delete(rawIndex, 1);
        });
    }

    /**
     * Update a single cell in a display-indexed row.
     * @param {number} displayIndex
     * @param {string} colId
     * @param {any} value
     */
    updateCell(displayIndex, colId, value) {
        const rowArr = this.#tableYMap.get("rows");
        if (!rowArr) return;

        const sortedRow = this.sortedFilteredRows[displayIndex];
        if (!sortedRow) return;

        const rawIndex = this.rows.findIndex((r) => r === sortedRow);
        if (rawIndex < 0) return;

        this.#ydoc.transact(() => {
            const yRow = rowArr.get(rawIndex);
            if (yRow) {
                yRow.set(colId, value);
                this.#markCumDirty(colId, displayIndex);
            }
        });
    }

    // ─── Sort / filter ────────────────────────────────────────────────────────

    setSort(colId, dir = "asc") {
        this.#ydoc.transact(() => {
            this.#tableYMap.set("sortColId", colId);
            this.#tableYMap.set("sortDir", dir);
        });
    }

    clearSort() {
        this.#ydoc.transact(() => {
            this.#tableYMap.set("sortColId", null);
            this.#tableYMap.set("sortDir", "asc");
        });
    }

    setFilter(colId, op, value) {
        const fm = this.#tableYMap.get("filters");
        if (!fm) return;
        this.#ydoc.transact(() => {
            const fMap = new Y.Map();
            fMap.set("op", op);
            fMap.set("value", value);
            fm.set(colId, fMap);
        });
    }

    clearFilter(colId) {
        const fm = this.#tableYMap.get("filters");
        if (!fm) return;
        this.#ydoc.transact(() => fm.delete(colId));
    }

    // ─── Entry form ───────────────────────────────────────────────────────────

    setEntryValue(colId, value) {
        this.entryBuffer = { ...this.entryBuffer, [colId]: value };
        // Clear error for this column
        const errs = { ...this.entryErrors };
        delete errs[colId];
        this.entryErrors = errs;
    }

    commitEntry() {
        const errors = {};
        for (const col of this.columns) {
            if (col.required && (this.entryBuffer[col.id] === undefined || this.entryBuffer[col.id] === "")) {
                errors[col.id] = "Required";
            }
        }
        if (Object.keys(errors).length > 0) {
            this.entryErrors = errors;
            return false;
        }
        this.insertRow({ ...this.entryBuffer });
        this.entryBuffer = {};
        this.entryErrors = {};
        return true;
    }

    clearEntry() {
        this.entryBuffer = {};
        this.entryErrors = {};
    }

    // ─── Query API ────────────────────────────────────────────────────────────

    getValue(displayIndex, colId) {
        return this.sortedFilteredRows[displayIndex]?.[colId];
    }

    getColumn(colId) {
        return this.sortedFilteredRows.map((r) => r[colId]);
    }

    getRowCount() {
        return this.sortedFilteredRows.length;
    }

    /**
     * Cumulative sum of colId values from index 0 up to upToDisplayIndex (inclusive).
     * Uses a lazy Float64Array cache, rebuilt from the first dirty index.
     */
    getCumulativeSum(colId, upToDisplayIndex) {
        const rows = this.sortedFilteredRows;
        const n = rows.length;
        if (n === 0) return 0;

        let cache = this.#cumCache.get(colId);
        const dirtyFrom = this.#cumDirtyFrom.get(colId) ?? 0;
        const clampedIdx = Math.min(upToDisplayIndex, n - 1);

        if (!cache || cache.length < n || dirtyFrom <= clampedIdx) {
            if (!cache || cache.length < n) {
                cache = new Float64Array(n);
            }
            const startVal = dirtyFrom > 0 ? cache[dirtyFrom - 1] : 0;
            let running = startVal;
            for (let i = dirtyFrom; i < n; i++) {
                running += Number(rows[i]?.[colId]) || 0;
                cache[i] = running;
            }
            this.#cumCache.set(colId, cache);
            this.#cumDirtyFrom.set(colId, n);
        }

        return cache[clampedIdx] ?? 0;
    }

    #markCumDirty(colId, fromIndex) {
        const current = this.#cumDirtyFrom.get(colId) ?? Infinity;
        this.#cumDirtyFrom.set(colId, Math.min(fromIndex, current));
    }

    // ─── Utilities ────────────────────────────────────────────────────────────

    /** Get column index offset for a sheet column number */
    colIndexForSheetCol(sheetCol) {
        return sheetCol - this.startCol;
    }

    /** Get column definition for a sheet column */
    columnForSheetCol(sheetCol) {
        const idx = sheetCol - this.startCol;
        return this.columns[idx] ?? null;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    destroy() {
        for (const cleanup of this.#observers) cleanup();
        this.#observers = [];
    }
}

/**
 * Create a TableStore from an existing Yjs Y.Map.
 * @param {import('yjs').Map} tableYMap
 * @param {import('yjs').Doc} ydoc
 * @returns {TableStore}
 */
export function createTableStore(tableYMap, ydoc) {
    return new TableStore(tableYMap, ydoc);
}

export default TableStore;
