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
 *   tableYMap.get('accentColor') → string  (CSS hex, e.g. '#3b82f6')
 *
 * ## Column definition (Y.Map fields)
 *   id, name, type, required,
 *   hAlign, textColor, bgColor, width,
 *   isNonEntry, formula,
 *   conditionalFormats (JSON string)
 *
 * ## Cumulative-sum cache
 *   getCumulativeSum(colId, upToIndex) uses a per-column Float64Array.
 *   Mark dirty from index i with #markCumDirty(colId, i).
 *
 * ## Formula columns
 *   A column with isNonEntry=true and a formula string is a computed column.
 *   Supported formulas:
 *     CUMSUM(colId)   → running sum up to current row
 *     SUM(colId)      → total sum of column
 *     AVG(colId)      → average of column
 *     ROW             → 0-based display index
 *     ROW1            → 1-based display index
 *     {colId}         → value of another column in same row (for arithmetic)
 *   Complex formulas: {price} * {qty} — arithmetic over column values
 */

import * as Y from "yjs";

/** Accent color palette (cycles by table count) */
export const TABLE_ACCENT_COLORS = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#8b5cf6', // violet
    '#ef4444', // red
    '#06b6d4', // cyan
    '#ec4899', // pink
    '#84cc16', // lime
];

/** Maps column type → display icon glyph */
export const COLUMN_TYPE_ICONS = {
    text: 'A',
    number: '#',
    currency: '$',
    percent: '%',
    date: '📅',
    checkbox: '✓',
    rating: '★',
    url: '🔗',
};

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
    accentColor = $state("#3b82f6");

    // ── Inline position ──────────────────────────────────────────────────────
    startRow = $state(0); // row of header
    startCol = $state(0); // first col
    endCol = $state(0);   // last col  (derived from column count on init)

    // ── Viewport position (viewport mode only) ───────────────────────────────
    vpStartRow = $state(0);
    vpStartCol = $state(0);
    vpEndRow = $state(0);
    vpEndCol = $state(0);

    // ── Schema & data ────────────────────────────────────────────────────────
    /**
     * @type {Array<{
     *   id: string, name: string, type: string, required: boolean,
     *   hAlign: 'left'|'center'|'right',
     *   textColor: string|null, bgColor: string|null,
     *   width: number|null,
     *   isNonEntry: boolean, formula: string|null,
     *   conditionalFormats: Array<{condition:string,value:any,style:{backgroundColor?:string,color?:string,bold?:boolean}}>
     * }>}
     */
    columns = $state([]);
    rows = $state([]); // plain objects: colId → value

    // ── Sort / filter ─────────────────────────────────────────────────────────
    sortColId = $state(null);
    sortDir = $state("asc");
    filters = $state({}); // colId → { op: '='|'>'|'<'|'contains'|..., value }

    // ── Insert sort (sort inserted rows by a column on entry) ─────────────────
    insertSortColId = $state(null);
    insertSortDir = $state("asc");

    // ── Derived sorted+filtered view ──────────────────────────────────────────
    // Raw rows are appended at the end (O(1) efficiency).
    // For display, we reverse so newest rows appear at top.
    // "Bottom" of raw array = oldest = bottom of display.
    // "Top" of raw array (end) = newest = top of display.
    sortedFilteredRows = $derived.by(() => {
        // Reverse raw rows so newest (last appended) appears first
        let result = [...this.rows].reverse();

        // Apply filters
        for (const [colId, f] of Object.entries(this.filters)) {
            result = result.filter((row) => {
                const v = row[colId];
                switch (f.op) {
                    case "=": return v == f.value;
                    case "<>": return v != f.value;
                    case ">": return Number(v) > Number(f.value);
                    case "<": return Number(v) < Number(f.value);
                    case ">=": return Number(v) >= Number(f.value);
                    case "<=": return Number(v) <= Number(f.value);
                    case "contains": return String(v ?? "").toLowerCase().includes(String(f.value).toLowerCase());
                    case "notcontains": return !String(v ?? "").toLowerCase().includes(String(f.value).toLowerCase());
                    case "startswith": return String(v ?? "").toLowerCase().startsWith(String(f.value).toLowerCase());
                    case "empty": return v == null || v === "";
                    case "notempty": return v != null && v !== "";
                    default: return true;
                }
            });
        }

        // Apply sort (overrides the default newest-first order)
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
    #cumCache = new Map();     // colId → Float64Array
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
        this.accentColor = m.get("accentColor") ?? "#3b82f6";
        this.startRow = m.get("startRow") ?? 0;
        this.startCol = m.get("startCol") ?? 0;
        this.vpStartRow = m.get("vpStartRow") ?? 0;
        this.vpStartCol = m.get("vpStartCol") ?? 0;
        this.vpEndRow = m.get("vpEndRow") ?? 0;
        this.vpEndCol = m.get("vpEndCol") ?? 0;
        this.sortColId = m.get("sortColId") ?? null;
        this.sortDir = m.get("sortDir") ?? "asc";
        this.insertSortColId = m.get("insertSortColId") ?? null;
        this.insertSortDir = m.get("insertSortDir") ?? "asc";
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
        this.columns = arr.toArray().map((c) => {
            const raw = c.toJSON ? c.toJSON() : { ...c };
            // Parse conditionalFormats if stored as JSON string
            if (typeof raw.conditionalFormats === "string") {
                try { raw.conditionalFormats = JSON.parse(raw.conditionalFormats); } catch { raw.conditionalFormats = []; }
            }
            // Ensure defaults
            return {
                id: raw.id ?? "",
                name: raw.name ?? "",
                type: raw.type ?? "text",
                required: raw.required ?? false,
                hAlign: raw.hAlign ?? null,
                textColor: raw.textColor ?? null,
                bgColor: raw.bgColor ?? null,
                width: raw.width ?? null,
                isNonEntry: raw.isNonEntry ?? false,
                formula: raw.formula ?? null,
                conditionalFormats: Array.isArray(raw.conditionalFormats) ? raw.conditionalFormats : [],
            };
        });
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

        // Top-level map observer (id, name, mode, position, sort fields, accentColor)
        const topObs = () => {
            this.id = m.get("id") ?? this.id;
            this.name = m.get("name") ?? this.name;
            this.mode = m.get("mode") ?? this.mode;
            this.accentColor = m.get("accentColor") ?? this.accentColor;
            this.startRow = m.get("startRow") ?? this.startRow;
            this.startCol = m.get("startCol") ?? this.startCol;
            this.vpStartRow = m.get("vpStartRow") ?? this.vpStartRow;
            this.vpStartCol = m.get("vpStartCol") ?? this.vpStartCol;
            this.vpEndRow = m.get("vpEndRow") ?? this.vpEndRow;
            this.vpEndCol = m.get("vpEndCol") ?? this.vpEndCol;
            this.sortColId = m.get("sortColId") ?? null;
            this.sortDir = m.get("sortDir") ?? "asc";
            this.insertSortColId = m.get("insertSortColId") ?? null;
            this.insertSortDir = m.get("insertSortDir") ?? "asc";
        };
        m.observe(topObs);
        this.#observers.push(() => m.unobserve(topObs));

        // Columns observer
        const colArr = m.get("columns");
        if (colArr) {
            const colObs = () => this.#syncColumns();
            colArr.observeDeep(colObs);
            this.#observers.push(() => colArr.unobserveDeep(colObs));
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
     * Appends to end of raw array (O(1)) - newest rows appear at top of display.
     * If insertSort is configured, finds the position closest to display-top that
     * maintains sort order (i.e., the highest raw index where value fits).
     * @param {Object} rowData  colId → value
     */
    insertRow(rowData) {
        const rowArr = this.#tableYMap.get("rows");
        if (!rowArr) return;

        this.#ydoc.transact(() => {
            const yRow = new Y.Map();
            // Only store user-entry columns (skip formula columns)
            for (const [k, v] of Object.entries(rowData)) {
                const colDef = this.columns.find(c => c.id === k);
                if (colDef?.isNonEntry) continue; // don't store computed values
                yRow.set(k, v);
            }

            // Default: append to end (O(1)) - newest appears at display top
            let insertAt = rowArr.length;

            // If insertSort is configured, find position closest to display-top
            // that maintains sort order. Since display is reversed, "display top"
            // means the highest raw index that satisfies the sort condition.
            if (this.insertSortColId) {
                const colId = this.insertSortColId;
                const dir = this.insertSortDir === "desc" ? -1 : 1;
                const newVal = rowData[colId];

                // Scan from beginning (oldest/bottom) to find where new value fits.
                // We want the highest index where sort order is maintained.
                // For ascending: insert after all values <= newVal
                // For descending: insert after all values >= newVal
                for (let i = 0; i < rowArr.length; i++) {
                    const rv = rowArr.get(i)?.get?.(colId);
                    const cmp = (() => {
                        if (rv == null && newVal == null) return 0;
                        if (rv == null) return 1;
                        if (newVal == null) return -1;
                        if (typeof rv === "number" && typeof newVal === "number")
                            return rv - newVal;
                        return String(rv).localeCompare(String(newVal));
                    })();
                    // For ascending (dir=1): stop when existing > new (cmp > 0)
                    // For descending (dir=-1): stop when existing < new (cmp < 0, so dir*cmp > 0)
                    if (dir * cmp > 0) {
                        insertAt = i;
                        break;
                    }
                    // Otherwise, this position is valid, keep looking for a higher index
                }
            }

            if (insertAt >= 0 && insertAt < rowArr.length) {
                rowArr.insert(insertAt, [yRow]);
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

        // Block updates to formula columns
        const colDef = this.columns.find(c => c.id === colId);
        if (colDef?.isNonEntry) return;

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

    // ─── Schema mutation API ──────────────────────────────────────────────────

    /**
     * Rename a column.
     * @param {string} colId
     * @param {string} newName
     */
    renameColumn(colId, newName) {
        const colArr = this.#tableYMap.get("columns");
        if (!colArr) return;
        this.#ydoc.transact(() => {
            for (let i = 0; i < colArr.length; i++) {
                const cm = colArr.get(i);
                if (cm?.get?.("id") === colId) {
                    cm.set("name", newName);
                    break;
                }
            }
        });
    }

    /**
     * Update multiple properties of a column at once.
     * @param {string} colId
     * @param {Object} changes - Partial column definition
     */
    updateColumnDef(colId, changes) {
        const colArr = this.#tableYMap.get("columns");
        if (!colArr) return;
        this.#ydoc.transact(() => {
            for (let i = 0; i < colArr.length; i++) {
                const cm = colArr.get(i);
                if (cm?.get?.("id") === colId) {
                    for (const [key, value] of Object.entries(changes)) {
                        if (key === "conditionalFormats") {
                            // Store arrays as JSON string
                            cm.set(key, JSON.stringify(value));
                        } else if (value === null || value === undefined) {
                            cm.delete(key);
                        } else {
                            cm.set(key, value);
                        }
                    }
                    break;
                }
            }
        });
    }

    /**
     * Set or clear a column formula (makes it a computed non-entry column).
     * @param {string} colId
     * @param {string|null} formula  null to clear
     */
    setColumnFormula(colId, formula) {
        if (formula) {
            this.updateColumnDef(colId, { isNonEntry: true, formula });
        } else {
            this.updateColumnDef(colId, { isNonEntry: false, formula: null });
        }
    }

    /**
     * Insert a new column at a given index.
     * @param {number} atIndex
     * @param {{ id?: string, name: string, type?: string, required?: boolean }} colDef
     * @returns {string} the new column's id
     */
    insertColumn(atIndex, colDef) {
        const colArr = this.#tableYMap.get("columns");
        if (!colArr) return "";

        const colId = colDef.id ?? `col${Date.now()}`;

        this.#ydoc.transact(() => {
            const cm = new Y.Map();
            cm.set("id", colId);
            cm.set("name", colDef.name ?? "Column");
            cm.set("type", colDef.type ?? "text");
            cm.set("required", colDef.required ?? false);
            cm.set("isNonEntry", colDef.isNonEntry ?? false);
            if (colDef.formula) cm.set("formula", colDef.formula);
            if (colDef.hAlign) cm.set("hAlign", colDef.hAlign);

            const insertAt = Math.max(0, Math.min(atIndex, colArr.length));
            colArr.insert(insertAt, [cm]);
        });

        return colId;
    }

    /**
     * Delete a column by ID.
     * @param {string} colId
     */
    deleteColumn(colId) {
        const colArr = this.#tableYMap.get("columns");
        const rowArr = this.#tableYMap.get("rows");
        if (!colArr) return;

        this.#ydoc.transact(() => {
            // Find and remove the column definition
            for (let i = 0; i < colArr.length; i++) {
                const cm = colArr.get(i);
                if (cm?.get?.("id") === colId) {
                    colArr.delete(i, 1);
                    break;
                }
            }
            // Remove that column's data from all rows
            if (rowArr) {
                for (let i = 0; i < rowArr.length; i++) {
                    const row = rowArr.get(i);
                    if (row?.has?.(colId)) {
                        row.delete(colId);
                    }
                }
            }
        });
    }

    /**
     * Move a column from one index to another.
     * @param {number} fromIndex
     * @param {number} toIndex
     */
    reorderColumns(fromIndex, toIndex) {
        const colArr = this.#tableYMap.get("columns");
        if (!colArr || fromIndex === toIndex) return;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= colArr.length || toIndex >= colArr.length) return;

        this.#ydoc.transact(() => {
            // Read all column maps
            const colMaps = [];
            for (let i = 0; i < colArr.length; i++) {
                colMaps.push(colArr.get(i));
            }
            // Remove and re-insert
            const [moved] = colMaps.splice(fromIndex, 1);
            colMaps.splice(toIndex, 0, moved);
            // Delete all and re-push in new order
            colArr.delete(0, colArr.length);
            colArr.push(colMaps);
        });
    }

    /**
     * Rename the table itself.
     * @param {string} newName
     */
    rename(newName) {
        this.#ydoc.transact(() => {
            this.#tableYMap.set("name", newName);
        });
    }

    /**
     * Set the accent color of the table.
     * @param {string} color  CSS hex string
     */
    setAccentColor(color) {
        this.#ydoc.transact(() => {
            this.#tableYMap.set("accentColor", color);
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

    setInsertSort(colId, dir = "asc") {
        this.#ydoc.transact(() => {
            this.#tableYMap.set("insertSortColId", colId);
            this.#tableYMap.set("insertSortDir", dir);
        });
    }

    clearInsertSort() {
        this.#ydoc.transact(() => {
            this.#tableYMap.set("insertSortColId", null);
            this.#tableYMap.set("insertSortDir", "asc");
        });
    }

    /** Update startRow and startCol (move table to new grid position). */
    moveTo(startRow, startCol) {
        this.#ydoc.transact(() => {
            this.#tableYMap.set("startRow", startRow);
            this.#tableYMap.set("startCol", startCol);
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

    clearAllFilters() {
        const fm = this.#tableYMap.get("filters");
        if (!fm) return;
        this.#ydoc.transact(() => {
            const keys = [...fm.keys()];
            for (const k of keys) fm.delete(k);
        });
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
            if (col.isNonEntry) continue; // skip formula columns
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

    /**
     * Get value at display index for a column.
     * For formula columns, evaluates the formula.
     * @param {number} displayIndex
     * @param {string} colId
     * @returns {any}
     */
    getValue(displayIndex, colId) {
        const colDef = this.columns.find(c => c.id === colId);
        if (colDef?.isNonEntry && colDef.formula) {
            return this.#evaluateFormula(colDef.formula, displayIndex);
        }
        return this.sortedFilteredRows[displayIndex]?.[colId];
    }

    getColumn(colId) {
        return this.sortedFilteredRows.map((_, i) => this.getValue(i, colId));
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
                // Use raw row value (not getValue which could recurse for formula cols)
                running += Number(rows[i]?.[colId]) || 0;
                cache[i] = running;
            }
            this.#cumCache.set(colId, cache);
            this.#cumDirtyFrom.set(colId, n);
        }

        return cache[clampedIdx] ?? 0;
    }

    // ─── Formula evaluation ───────────────────────────────────────────────────

    /**
     * Evaluate a column formula for a specific row.
     * Supported:
     *   CUMSUM(colId)    → running sum up to rowIndex
     *   SUM(colId)       → total sum of column
     *   AVG(colId)       → average of column
     *   COUNT            → total row count
     *   ROW              → 0-based index
     *   ROW1             → 1-based index
     *   {colId}          → value of another column in same row
     *   Arithmetic: {price} * {qty}, {amount} + 10, etc.
     *
     * @param {string} formula
     * @param {number} rowIndex  display index
     * @returns {any}
     */
    #evaluateFormula(formula, rowIndex) {
        try {
            let expr = formula.trim();

            // CUMSUM(colId) shorthand
            const cumsumMatch = expr.match(/^CUMSUM\(([^)]+)\)$/i);
            if (cumsumMatch) {
                return this.getCumulativeSum(cumsumMatch[1].trim(), rowIndex);
            }

            // SUM(colId)
            const sumMatch = expr.match(/^SUM\(([^)]+)\)$/i);
            if (sumMatch) {
                return this.getColumn(sumMatch[1].trim()).reduce((a, v) => a + (Number(v) || 0), 0);
            }

            // AVG(colId)
            const avgMatch = expr.match(/^AVG\(([^)]+)\)$/i);
            if (avgMatch) {
                const col = this.getColumn(avgMatch[1].trim());
                const nums = col.map(v => Number(v)).filter(v => !isNaN(v));
                return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : 0;
            }

            // COUNT
            if (/^COUNT$/i.test(expr)) {
                return this.getRowCount();
            }

            // ROW1 (1-based)
            expr = expr.replace(/\bROW1\b/g, String(rowIndex + 1));
            // ROW (0-based)
            expr = expr.replace(/\bROW\b/g, String(rowIndex));

            // {colId} → column value
            expr = expr.replace(/\{([^}]+)\}/g, (_match, colId) => {
                const val = this.sortedFilteredRows[rowIndex]?.[colId.trim()];
                return val == null ? '0' : String(Number(val) || 0);
            });

            // Evaluate arithmetic expression
            // eslint-disable-next-line no-new-func
            const result = new Function(`"use strict"; return (${expr});`)();
            return typeof result === 'number' && !isNaN(result) ? result : null;
        } catch {
            return null;
        }
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

    /**
     * Export table data as a CSV string.
     * @returns {string}
     */
    exportCSV() {
        const rows = this.sortedFilteredRows;
        const cols = this.columns;
        const escape = (v) => {
            const s = v == null ? '' : String(v);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };
        const header = cols.map(c => escape(c.name)).join(',');
        const body = rows.map(r =>
            cols.map(c => escape(this.getValue(rows.indexOf(r), c.id))).join(',')
        ).join('\n');
        return header + '\n' + body;
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
