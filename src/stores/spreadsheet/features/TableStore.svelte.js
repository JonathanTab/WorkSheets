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
 *   tableYMap.get('accentColor') → string  (CSS hex, e.g. '#3b82f6')
 *
 * Filters are local session state only (not persisted in Yjs).
 *
 * ## Column definition (Y.Map fields)
 *   id, name, type, required,
 *   hAlign, textColor, bgColor, width,
 *   isNonEntry, formula,
 *   conditionalFormats (JSON string)
 *
 * ## Computed column formulas
 * A column with isNonEntry=true uses the `formula` field to derive its value.
 * The formula DSL supports:
 *
 *   {colId}            Current row's value for that column
 *   ROW / ROW1         0-based or 1-based row index
 *   COUNT              Total number of rows
 *
 *   — Aggregates (all rows) —
 *   SUM(colId)         Sum of all values in a column
 *   AVG(colId)         Average of all values
 *   MIN(colId)         Minimum value
 *   MAX(colId)         Maximum value
 *
 *   — Conditional aggregates (all rows, filtered) —
 *   SUMIF(sumCol, filterCol, op, filterVal)   Sum where condition is met
 *   COUNTIF(filterCol, op, filterVal)          Count where condition is met
 *   AVGIF(sumCol, filterCol, op, filterVal)   Average where condition is met
 *   MINIF(colId, filterCol, op, filterVal)    Min where condition is met
 *   MAXIF(colId, filterCol, op, filterVal)    Max where condition is met
 *   SUMIFS(sumCol, col1,op1,val1, ...)         Sum with multiple conditions
 *
 *   — Running / position-aware (up to current row) —
 *   CUMSUM(colId)                             Running total up to current row
 *   RUNNINGIF(sumCol, filterCol, op, filterVal)  Running sum matching condition
 *   RUNNINGIFS(sumCol, col1,op1,val1, ...)       Running sum with multiple conditions
 *
 *   — Operators supported in op argument —
 *   "="  "<>"  ">"  "<"  ">="  "<="  "contains"  "startswith"  "notcontains"
 *
 *   — Arithmetic & logic —
 *   {price} * {qty}                   Arithmetic over column values
 *   IF({status} = "done", 1, 0)       Conditional expression (full formula syntax)
 *   {amount} * IF({type}="income",1,-1)   Combined formula and arithmetic
 *
 * ## Examples
 *   CUMSUM(amount)                    Running balance
 *   RUNNINGIF(amount, account, "=", {account})   Balance per account up to this row
 *   SUMIF(amount, category, "=", "Food")          Total food spending
 *   IF({qty} > 0, {price} * {qty}, 0)             Row total (zero if no qty)
 *   COUNTIF(status, "=", "done")                  Count completed items
 */

import * as Y from "yjs";
import { parseFormula } from '../../../formulas/parser.js';
import { evaluate } from '../../../formulas/evaluator.js';

// ─── Formula evaluation helpers (module-level) ─────────────────────────────

/**
 * Find the index of the closing ')' that matches the '(' at openPos.
 * Handles nested parens and quoted strings.
 */
function findCloseParen(str, openPos) {
    let depth = 0;
    let inStr = false;
    let strChar = null;
    for (let i = openPos; i < str.length; i++) {
        const ch = str[i];
        if (inStr) {
            if (ch === strChar) inStr = false;
        } else if (ch === '"' || ch === "'") {
            inStr = true; strChar = ch;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * Split a comma-separated argument string, respecting quoted strings and nested parens.
 * e.g. 'amount, account, "=", "Chase"' → ['amount', 'account', '"="', '"Chase"']
 */
function splitArgs(str) {
    const args = [];
    let current = '';
    let depth = 0;
    let inStr = false;
    let strChar = null;
    for (const ch of str) {
        if (inStr) {
            current += ch;
            if (ch === strChar) inStr = false;
        } else if (ch === '"' || ch === "'") {
            inStr = true; strChar = ch; current += ch;
        } else if (ch === '(') {
            depth++; current += ch;
        } else if (ch === ')') {
            depth--; current += ch;
        } else if (ch === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) args.push(current.trim());
    return args;
}

/**
 * Convert a result value to an expression string safe for embedding in a formula.
 */
function resultToExpr(val) {
    if (val === null || val === undefined) return '0';
    if (typeof val === 'number') return isNaN(val) ? '0' : String(val);
    if (typeof val === 'string') return JSON.stringify(val);
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return '0';
}

/**
 * Match a row value against a filter condition.
 * Supports date-aware ISO string comparisons, numeric comparisons, and string ops.
 */
function matchCondition(rowVal, op, filterVal) {
    const rv = rowVal;
    const fv = filterVal;

    // Date-aware comparison: if both values look like ISO date strings
    if (typeof rv === 'string' && typeof fv === 'string' &&
        rv.includes('-') && fv.includes('-')) {
        const rvDate = Date.parse(rv);
        const fvDate = Date.parse(fv);
        if (!isNaN(rvDate) && !isNaN(fvDate)) {
            switch (op) {
                case '=': case '==': return rvDate === fvDate;
                case '<>': case '!=': return rvDate !== fvDate;
                case '>': return rvDate > fvDate;
                case '<': return rvDate < fvDate;
                case '>=': return rvDate >= fvDate;
                case '<=': return rvDate <= fvDate;
            }
        }
    }

    // Numeric comparison for ordered operators
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

    // String / equality comparison
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
    date: 'D',
    checkbox: '✓',
    rating: '★',
    url: '↗',
    dropdown: '▾',
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

    // ── Cumulative direction ───────────────────────────────────────────────────
    // When true, cumulative functions accumulate from the bottom of the display
    // upward (suffix sum: oldest rows at bottom contribute first). This matches
    // the default newest-first display and any desc sort, so that CUMSUM(amount)
    // at a given row always means "total of this row and all chronologically
    // earlier (older) rows below it."
    cumReverse = $derived(this.sortColId === null || this.sortDir === "desc");

    // ── Sorted+filtered view (plain $state — updated imperatively) ───────────
    // Using $state instead of $derived.by so that changes always propagate to
    // components regardless of Svelte's cross-boundary reactive graph.
    sortedFilteredRows = $state([]);

    #rebuildView() {
        let result = [...this.rows].reverse();

        for (const [colId, f] of Object.entries(this.filters)) {
            result = result.filter((row) => {
                const v = row[colId];
                const fv = f.value;
                switch (f.op) {
                    case "=":  return v == fv;
                    case "<>": return v != fv;
                    case ">": case "<": case ">=": case "<=": {
                        const vd = Date.parse(v), fd = Date.parse(fv);
                        const lv = (!isNaN(vd) && !isNaN(fd)) ? vd : Number(v);
                        const lf = (!isNaN(vd) && !isNaN(fd)) ? fd : Number(fv);
                        if (f.op === ">")  return lv > lf;
                        if (f.op === "<")  return lv < lf;
                        if (f.op === ">=") return lv >= lf;
                        return lv <= lf;
                    }
                    case "contains":    return String(v ?? "").toLowerCase().includes(String(fv).toLowerCase());
                    case "notcontains": return !String(v ?? "").toLowerCase().includes(String(fv).toLowerCase());
                    case "startswith":  return String(v ?? "").toLowerCase().startsWith(String(fv).toLowerCase());
                    case "empty":    return v == null || v === "" || v === false;
                    case "notempty": return v != null && v !== "" && v !== false;
                    default: return true;
                }
            });
        }

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

        this.#cumCache.clear();
        this.#cumDirtyFrom.clear();
        this.#runningIfCache.clear();
        this.#runningIfDirtyFrom.clear();

        this.sortedFilteredRows = result;
    }

    // ── Entry form buffer (local only — not in Yjs until committed) ──────────
    entryBuffer = $state({});
    entryErrors = $state({});

    // ── Cumulative sum cache ──────────────────────────────────────────────────
    #cumCache = new Map();     // colId → Float64Array
    #cumDirtyFrom = new Map(); // colId → first dirty index

    #runningIfCache = new Map();     // key → Float64Array (keyed by sumCol|filterCol|op|filterVal)
    #runningIfDirtyFrom = new Map(); // key → first dirty index

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
            // Parse typeConfig if stored as JSON string
            let typeConfig = null;
            if (typeof raw.typeConfig === "string") {
                try { typeConfig = JSON.parse(raw.typeConfig); } catch { typeConfig = null; }
            }
            // Ensure defaults
            return {
                id: raw.id ?? "",
                name: raw.name ?? "",
                type: typeConfig?.type ?? raw.type ?? "text",
                typeConfig,
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
            this.#rebuildView();
            return;
        }
        this.rows = arr.toArray().map((r) => (r.toJSON ? r.toJSON() : { ...r }));
        this.#rebuildView();
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
            const prevSort = this.sortColId + this.sortDir;
            this.sortColId = m.get("sortColId") ?? null;
            this.sortDir = m.get("sortDir") ?? "asc";
            this.insertSortColId = m.get("insertSortColId") ?? null;
            this.insertSortDir = m.get("insertSortDir") ?? "asc";
            if (prevSort !== this.sortColId + this.sortDir) this.#rebuildView();
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
     * Update a column's full type config (type + options like subFormat, decimals, dropdown options, etc.).
     * Stores the config as a JSON string in typeConfig and syncs the top-level `type` field.
     * @param {string} colId
     * @param {Object|null} config - Full config like { type: 'number', subFormat: 'currency', ... }
     */
    updateColumnTypeConfig(colId, config) {
        const type = config?.type ?? 'text';
        this.updateColumnDef(colId, {
            type,
            typeConfig: config ? JSON.stringify(config) : null,
        });
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
        this.filters = { ...this.filters, [colId]: { op, value } };
        this.#rebuildView();
    }

    clearFilter(colId) {
        const f = { ...this.filters };
        delete f[colId];
        this.filters = f;
        this.#rebuildView();
    }

    clearAllFilters() {
        this.filters = {};
        this.#rebuildView();
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

        const clampedIdx = Math.min(upToDisplayIndex, n - 1);

        if (this.cumReverse) {
            // Suffix sum: display is newest-first, so row 0 is newest and row n-1
            // is oldest. cache[i] = sum of rows[i..n-1] = "this row + all older rows".
            // Newest row (i=0) shows the grand total; oldest row (i=n-1) shows just itself.
            let cache = this.#cumCache.get(colId);
            if (!cache || cache.length < n) {
                cache = new Float64Array(n);
                let running = 0;
                for (let i = n - 1; i >= 0; i--) {
                    running += Number(rows[i]?.[colId]) || 0;
                    cache[i] = running;
                }
                this.#cumCache.set(colId, cache);
            }
            return cache[clampedIdx] ?? 0;
        }

        // Prefix sum: display is oldest-first (asc sort). cache[i] = sum of rows[0..i].
        let cache = this.#cumCache.get(colId);
        const dirtyFrom = this.#cumDirtyFrom.get(colId) ?? 0;

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

    // ─── Formula evaluation ───────────────────────────────────────────────────

    /**
     * Resolve a column reference to its internal ID.
     * Accepts either an exact column ID or a column name (case-insensitive).
     * This lets formulas use human-readable column names like CUMSUM(amount)
     * instead of internal IDs like CUMSUM(col1712345678).
     * @param {string} nameOrId
     * @returns {string} resolved column ID
     */
    #resolveColId(nameOrId) {
        if (!nameOrId) return nameOrId;
        const s = String(nameOrId);
        // Exact ID match — fastest path
        if (this.columns.some(c => c.id === s)) return s;
        // Case-insensitive name match
        const col = this.columns.find(c => c.name.toLowerCase() === s.toLowerCase());
        return col ? col.id : s;
    }

    /**
     * Public wrapper for column ID resolution — used by TableManager cross-table functions.
     * Accepts either an exact column ID or a column name (case-insensitive).
     * @param {string} nameOrId
     * @returns {string}
     */
    resolveColId(nameOrId) {
        return this.#resolveColId(nameOrId);
    }

    /**
     * Public wrapper for formula evaluation — used for live preview in UI.
     * @param {string} formula
     * @param {number} rowIndex  display index
     * @returns {any}
     */
    evaluateFormula(formula, rowIndex) {
        return this.#evaluateFormula(formula, rowIndex);
    }

    /**
     * Evaluate a column formula for a specific row.
     *
     * Pipeline:
     *   1. Substitute ROW / ROW1 / COUNT tokens (meta-tokens first, before cell values are injected)
     *   2. Substitute {colId} references with the current row's values
     *   3. Substitute table-specific function calls (CUMSUM, RUNNINGIF, etc.)
     *   4. Evaluate the remaining expression with the formula parser/evaluator
     *
     * Column references accept either the internal column ID or the human-readable
     * column name (case-insensitive), in both {ref} syntax and function arguments.
     *
     * See the class-level docstring for the full list of supported formulas.
     *
     * @param {string} formula
     * @param {number} rowIndex  display index
     * @returns {any}
     */
    #evaluateFormula(formula, rowIndex) {
        try {
            let expr = formula.trim();

            // Step 1: substitute meta-tokens BEFORE injecting cell string values,
            // so cell values containing "ROW" or "COUNT" text are never misinterpreted.
            expr = expr.replace(/\bROW1\s*(?:\(\s*\))?/g, String(rowIndex + 1));
            expr = expr.replace(/\bROW\s*(?:\(\s*\))?(?!\s*\w)/g, String(rowIndex));
            // COUNT (but not COUNTIF) → total row count
            expr = expr.replace(/\bCOUNT\b(?!IF)/gi, String(this.getRowCount()));

            // Step 2: substitute {colRef} with current row values (accepts name or ID)
            expr = this.#substituteColRefs(expr, rowIndex);

            // Step 3: substitute table-specific function calls
            expr = this.#substituteTableFuncs(expr, rowIndex);

            // Step 4: evaluate the remaining expression
            return this.#evalExpression(expr);
        } catch {
            return null;
        }
    }

    /**
     * Substitute {colRef} references with the current row's values.
     * colRef may be a column ID or a human-readable column name.
     * Strings are JSON-escaped; numbers become numeric literals.
     */
    #substituteColRefs(expr, rowIndex) {
        return expr.replace(/\{([^}]+)\}/g, (_match, rawRef) => {
            const colId = this.#resolveColId(rawRef.trim());
            const val = this.sortedFilteredRows[rowIndex]?.[colId];
            if (val === null || val === undefined || val === '') return '""';
            if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
            if (typeof val === 'string') return JSON.stringify(val);
            const num = Number(val);
            return !isNaN(num) ? String(num) : JSON.stringify(String(val));
        });
    }

    /**
     * Replace table-specific function calls in the expression with their computed values.
     * Processes multiple calls and handles them left-to-right (non-nested).
     */
    #substituteTableFuncs(expr, rowIndex) {
        const KNOWN = ['RUNNINGIFS', 'RUNNINGIF', 'SUMIFS', 'SUMIF',
                       'AVGIF', 'MINIF', 'MAXIF', 'COUNTIF',
                       'CUMSUM', 'AVG', 'MIN', 'MAX', 'SUM'];

        // Make up to 20 passes to replace all occurrences
        for (let pass = 0; pass < 20; pass++) {
            let replaced = false;
            for (const fn of KNOWN) {
                const re = new RegExp(`\\b${fn}\\s*\\(`, 'i');
                const m = re.exec(expr);
                if (!m) continue;
                replaced = true;
                const openIdx = m.index + m[0].length - 1;
                const closeIdx = findCloseParen(expr, openIdx);
                if (closeIdx === -1) continue;

                const argsStr = expr.slice(openIdx + 1, closeIdx);
                const rawArgs = splitArgs(argsStr);
                const result = this.#callTableFunc(fn.toUpperCase(), rawArgs, rowIndex);

                expr = expr.slice(0, m.index) + resultToExpr(result) + expr.slice(closeIdx + 1);
                break; // restart loop after replacement
            }
            if (!replaced) break;
        }
        return expr;
    }

    /**
     * Dispatch to the appropriate table aggregate function.
     * Column arguments are resolved by name or ID via #resolveColId.
     */
    #callTableFunc(fn, rawArgs, rowIndex) {
        const args = rawArgs.map(a => this.#evalArg(a.trim()));
        // Helper: resolve first n positional column arguments
        const col = (i) => this.#resolveColId(String(args[i] ?? ''));
        switch (fn) {
            case 'CUMSUM':
                return this.getCumulativeSum(col(0), rowIndex);
            case 'SUM': {
                const vals = this.getColumn(col(0));
                return vals.reduce((a, v) => a + (Number(v) || 0), 0);
            }
            case 'AVG': {
                const vals = this.getColumn(col(0));
                const nums = vals.map(Number).filter(v => !isNaN(v));
                return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : 0;
            }
            case 'MIN': {
                const vals = this.getColumn(col(0));
                const nums = vals.map(Number).filter(v => !isNaN(v));
                return nums.length ? Math.min(...nums) : 0;
            }
            case 'MAX': {
                const vals = this.getColumn(col(0));
                const nums = vals.map(Number).filter(v => !isNaN(v));
                return nums.length ? Math.max(...nums) : 0;
            }
            case 'RUNNINGIF':
                if (args.length >= 4)
                    return this.#getRunningIf(col(0), col(1), String(args[2]), args[3], rowIndex);
                return 0;
            case 'RUNNINGIFS': {
                if (args.length < 4) return 0;
                const [, ...rest] = args;
                const conds = [];
                for (let i = 0; i + 2 < rest.length; i += 3)
                    conds.push({ col: this.#resolveColId(String(rest[i])), op: String(rest[i + 1]), val: rest[i + 2] });
                return this.#getRunningIfs(col(0), conds, rowIndex);
            }
            case 'SUMIF':
                if (args.length >= 4)
                    return this.#getSumIf(col(0), col(1), String(args[2]), args[3]);
                return 0;
            case 'SUMIFS': {
                if (args.length < 4) return 0;
                const [, ...rest] = args;
                const conds = [];
                for (let i = 0; i + 2 < rest.length; i += 3)
                    conds.push({ col: this.#resolveColId(String(rest[i])), op: String(rest[i + 1]), val: rest[i + 2] });
                return this.#getSumIfs(col(0), conds);
            }
            case 'COUNTIF':
                if (args.length >= 3)
                    return this.#getCountIf(col(0), String(args[1]), args[2]);
                return 0;
            case 'AVGIF':
                if (args.length >= 4)
                    return this.#getAvgIf(col(0), col(1), String(args[2]), args[3]);
                return 0;
            case 'MINIF':
                if (args.length >= 4)
                    return this.#getMinIf(col(0), col(1), String(args[2]), args[3]);
                return 0;
            case 'MAXIF':
                if (args.length >= 4)
                    return this.#getMaxIf(col(0), col(1), String(args[2]), args[3]);
                return 0;
            default:
                return 0;
        }
    }

    /**
     * Parse a raw argument string to its JavaScript value.
     * Quoted strings are unquoted; numeric strings become numbers; bare identifiers stay as strings.
     */
    #evalArg(arg) {
        if ((arg.startsWith('"') && arg.endsWith('"')) ||
            (arg.startsWith("'") && arg.endsWith("'"))) {
            return arg.slice(1, -1);
        }
        const num = Number(arg);
        if (arg !== '' && !isNaN(num)) return num;
        return arg; // bare column ID or other identifier
    }

    /**
     * Evaluate the final expression (after all substitutions) using the formula parser.
     * Falls back to simple numeric parse for plain numbers.
     */
    #evalExpression(expr) {
        const trimmed = expr.trim();
        if (!trimmed || trimmed === '""') return null;

        // Fast path for plain numbers
        const num = Number(trimmed);
        if (trimmed !== '' && !isNaN(num)) return num;

        // Use the formula parser/evaluator for everything else (IF, AND, arithmetic, etc.)
        try {
            const ast = parseFormula('=' + trimmed);
            const result = evaluate(ast, () => null, {});
            return result;
        } catch {
            return null;
        }
    }

    // ─── Position-aware aggregates (cached running sums) ─────────────────────

    /**
     * Running conditional sum: sum of `sumCol` for rows where `filterCol op filterVal`,
     * from row 0 up to `upToIndex` (inclusive). Cached per condition key.
     */
    #getRunningIf(sumCol, filterCol, op, filterVal, upToIndex) {
        const key = `${sumCol}|${filterCol}|${op}|${String(filterVal)}`;
        const rows = this.sortedFilteredRows;
        const n = rows.length;
        if (n === 0) return 0;

        const clampedIdx = Math.min(upToIndex, n - 1);

        if (this.cumReverse) {
            let cache = this.#runningIfCache.get(key);
            if (!cache || cache.length < n) {
                cache = new Float64Array(n);
                let running = 0;
                for (let i = n - 1; i >= 0; i--) {
                    running += matchCondition(rows[i][filterCol], op, filterVal) ? (Number(rows[i][sumCol]) || 0) : 0;
                    cache[i] = running;
                }
                this.#runningIfCache.set(key, cache);
            }
            return cache[clampedIdx] ?? 0;
        }

        let cache = this.#runningIfCache.get(key);
        const dirtyFrom = this.#runningIfDirtyFrom.get(key) ?? 0;

        if (!cache || cache.length < n || dirtyFrom <= clampedIdx) {
            if (!cache || cache.length < n) cache = new Float64Array(n);
            const startVal = dirtyFrom > 0 ? cache[dirtyFrom - 1] : 0;
            let running = startVal;
            for (let i = dirtyFrom; i < n; i++) {
                const row = rows[i];
                running += matchCondition(row[filterCol], op, filterVal) ? (Number(row[sumCol]) || 0) : 0;
                cache[i] = running;
            }
            this.#runningIfCache.set(key, cache);
            this.#runningIfDirtyFrom.set(key, n);
        }

        return cache[clampedIdx] ?? 0;
    }

    /**
     * Running conditional sum with multiple conditions (all must match).
     */
    #getRunningIfs(sumCol, conditions, upToIndex) {
        const key = `${sumCol}||${conditions.map(c => `${c.col}|${c.op}|${String(c.val)}`).join('||')}`;
        const rows = this.sortedFilteredRows;
        const n = rows.length;
        if (n === 0) return 0;

        const clampedIdx = Math.min(upToIndex, n - 1);

        if (this.cumReverse) {
            let cache = this.#runningIfCache.get(key);
            if (!cache || cache.length < n) {
                cache = new Float64Array(n);
                let running = 0;
                for (let i = n - 1; i >= 0; i--) {
                    const row = rows[i];
                    const allMatch = conditions.every(c => matchCondition(row[c.col], c.op, c.val));
                    running += allMatch ? (Number(row[sumCol]) || 0) : 0;
                    cache[i] = running;
                }
                this.#runningIfCache.set(key, cache);
            }
            return cache[clampedIdx] ?? 0;
        }

        let cache = this.#runningIfCache.get(key);
        const dirtyFrom = this.#runningIfDirtyFrom.get(key) ?? 0;

        if (!cache || cache.length < n || dirtyFrom <= clampedIdx) {
            if (!cache || cache.length < n) cache = new Float64Array(n);
            const startVal = dirtyFrom > 0 ? cache[dirtyFrom - 1] : 0;
            let running = startVal;
            for (let i = dirtyFrom; i < n; i++) {
                const row = rows[i];
                const allMatch = conditions.every(c => matchCondition(row[c.col], c.op, c.val));
                running += allMatch ? (Number(row[sumCol]) || 0) : 0;
                cache[i] = running;
            }
            this.#runningIfCache.set(key, cache);
            this.#runningIfDirtyFrom.set(key, n);
        }

        return cache[clampedIdx] ?? 0;
    }

    // ─── Total conditional aggregates ─────────────────────────────────────────

    #getSumIf(sumCol, filterCol, op, filterVal) {
        return this.sortedFilteredRows.reduce((acc, row) =>
            acc + (matchCondition(row[filterCol], op, filterVal) ? (Number(row[sumCol]) || 0) : 0), 0);
    }

    #getSumIfs(sumCol, conditions) {
        return this.sortedFilteredRows.reduce((acc, row) => {
            const allMatch = conditions.every(c => matchCondition(row[c.col], c.op, c.val));
            return acc + (allMatch ? (Number(row[sumCol]) || 0) : 0);
        }, 0);
    }

    #getCountIf(filterCol, op, filterVal) {
        return this.sortedFilteredRows.filter(row =>
            matchCondition(row[filterCol], op, filterVal)).length;
    }

    #getAvgIf(sumCol, filterCol, op, filterVal) {
        const matching = this.sortedFilteredRows.filter(row =>
            matchCondition(row[filterCol], op, filterVal));
        if (!matching.length) return 0;
        return matching.reduce((acc, row) => acc + (Number(row[sumCol]) || 0), 0) / matching.length;
    }

    #getMinIf(colId, filterCol, op, filterVal) {
        const vals = this.sortedFilteredRows
            .filter(row => matchCondition(row[filterCol], op, filterVal))
            .map(row => Number(row[colId])).filter(v => !isNaN(v));
        return vals.length ? Math.min(...vals) : 0;
    }

    #getMaxIf(colId, filterCol, op, filterVal) {
        const vals = this.sortedFilteredRows
            .filter(row => matchCondition(row[filterCol], op, filterVal))
            .map(row => Number(row[colId])).filter(v => !isNaN(v));
        return vals.length ? Math.max(...vals) : 0;
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
