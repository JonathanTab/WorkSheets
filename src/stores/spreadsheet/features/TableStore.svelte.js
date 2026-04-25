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
 *   tableYMap.get('columnOrder') → Y.Array<string>  (column IDs in display order)
 *   tableYMap.get('columnDefs')  → Y.Map<colId, Y.Map>  (column definitions keyed by ID)
 *   tableYMap.get('rows')        → Y.Array<Y.Map>  (data rows, each colId→value)
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
import { TableFormulaEvaluator } from './tableFormulaEval.js';

/**
 * View mode: when a TableStore is created with a sourceTableYMap, it acts as a
 * "view" of the source table — reading rows and column definitions from the
 * source while keeping its own position and visibleColumns list.
 *
 * Data flows:
 *   Reads:  source rows + columns (filtered by view's visibleColumns)
 *   Writes: insertRow / updateCell / deleteRow → source rows Y.Array
 *   Own Y.Map stores: id, name, mode, startRow, startCol,
 *                     sourceSheetId, sourceTableId, visibleColumns (Y.Array)
 */

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

    /**
     * For view tables: the Y.Map of the source table.
     * Null for regular tables.
     * @type {import('yjs').Map<any> | null}
     */
    #sourceYMap = null;

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
     *   id: string, name: string, type: string, typeConfig: Object|null, required: boolean,
     *   hAlign: 'left'|'center'|'right',
     *   textColor: string|null, bgColor: string|null,
     *   bold: boolean|null, italic: boolean|null, underline: boolean|null,
     *   fontSize: number|null, fontFamily: string|null,
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
                        const tryDate = typeof v === 'string' && typeof fv === 'string' && v.includes('-') && fv.includes('-');
                        const vd = tryDate ? Date.parse(v) : NaN;
                        const fd = tryDate ? Date.parse(fv) : NaN;
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

        this.sortedFilteredRows = result;
        this.#eval = new TableFormulaEvaluator(
            result,
            this.columns,
            this.sortColId === null || this.sortDir === 'desc',
        );
    }

    // ── Entry form buffer (local only — not in Yjs until committed) ──────────
    entryBuffer = $state({});
    entryErrors = $state({});

    // ── Formula evaluator (recreated on every #rebuildView) ───────────────────
    /** @type {TableFormulaEvaluator|null} */
    #eval = null;

    /**
     * @param {import('yjs').Map<any>} tableYMap
     * @param {import('yjs').Doc} ydoc
     * @param {import('yjs').Map<any> | null} [sourceTableYMap]  Provide for view tables.
     */
    constructor(tableYMap, ydoc, sourceTableYMap = null) {
        this.#tableYMap = tableYMap;
        this.#ydoc = ydoc;
        this.#sourceYMap = sourceTableYMap;
        this.#migrateColumnsIfNeeded();
        this.#syncFromYjs();
        this.#observeYjs();
    }

    /**
     * One-time migration: converts old `columns` Y.Array<Y.Map> to
     * `columnDefs` Y.Map<colId,Y.Map> + `columnOrder` Y.Array<string>.
     * Safe to call on already-migrated docs (no-ops if new keys exist).
     */
    #migrateColumnsIfNeeded() {
        if (this.#tableYMap.has("columnDefs") || this.#tableYMap.has("columnOrder")) return;
        const oldCols = this.#tableYMap.get("columns");
        if (!oldCols) return;
        this.#ydoc.transact(() => {
            const defsMap = new Y.Map();
            const orderArr = new Y.Array();
            for (let i = 0; i < oldCols.length; i++) {
                const old = oldCols.get(i);
                const colId = old.get("id");
                if (!colId) continue;
                const cm = new Y.Map();
                for (const [k, v] of old.entries()) cm.set(k, v);
                defsMap.set(colId, cm);
                orderArr.push([colId]);
            }
            this.#tableYMap.set("columnDefs", defsMap);
            this.#tableYMap.set("columnOrder", orderArr);
            this.#tableYMap.delete("columns");
        });
    }

    // ─── Yjs sync ────────────────────────────────────────────────────────────

    #syncFromYjs() {
        const m = this.#tableYMap;
        // For views, sort config comes from the source table so both views and their
        // source always show data in the same order (prevents confusing divergence).
        const sortSrc = this.#sourceYMap ?? m;
        this.id = m.get("id") ?? "";
        this.name = m.get("name") ?? "Table";
        this.mode = m.get("mode") ?? "inline";
        this.accentColor = (this.#sourceYMap ?? m).get("accentColor") ?? "#3b82f6";
        this.startRow = m.get("startRow") ?? 0;
        this.startCol = m.get("startCol") ?? 0;
        this.vpStartRow = m.get("vpStartRow") ?? 0;
        this.vpStartCol = m.get("vpStartCol") ?? 0;
        this.vpEndRow = m.get("vpEndRow") ?? 0;
        this.vpEndCol = m.get("vpEndCol") ?? 0;
        this.sortColId = sortSrc.get("sortColId") ?? null;
        this.sortDir = sortSrc.get("sortDir") ?? "asc";
        this.insertSortColId = sortSrc.get("insertSortColId") ?? null;
        this.insertSortDir = sortSrc.get("insertSortDir") ?? "asc";
        this.#syncColumns();
        this.#syncRows();
        // Recompute endCol from columns
        const cols = this.columns;
        this.endCol = cols.length > 0 ? this.startCol + cols.length - 1 : this.startCol;
    }

    #syncColumns() {
        // Views read column definitions from the source table, then filter to
        // only the columns listed in visibleColumns (in that order).
        const colSrc = this.#sourceYMap ?? this.#tableYMap;
        const defsMap = colSrc.get("columnDefs");
        const orderArr = colSrc.get("columnOrder");
        if (!defsMap || !orderArr) {
            this.columns = [];
            return;
        }

        // For view tables, respect the visibleColumns ordering/subset.
        const visibleArr = this.#sourceYMap ? this.#tableYMap.get("visibleColumns") : null;
        const orderedIds = visibleArr && visibleArr.length > 0
            ? visibleArr.toArray()
            : orderArr.toArray();

        this.columns = orderedIds.flatMap((/** @type {string} */ colId) => {
            const c = defsMap.get(colId);
            if (!c) return [];
            const raw = c.toJSON ? c.toJSON() : { ...c };
            if (typeof raw.conditionalFormats === "string") {
                try { raw.conditionalFormats = JSON.parse(raw.conditionalFormats); } catch { raw.conditionalFormats = []; }
            }
            let typeConfig = null;
            if (typeof raw.typeConfig === "string") {
                try { typeConfig = JSON.parse(raw.typeConfig); } catch { typeConfig = null; }
            }
            return [{
                id: raw.id ?? colId,
                name: raw.name ?? "",
                type: typeConfig?.type ?? raw.type ?? "text",
                typeConfig,
                required: raw.required ?? false,
                hAlign: raw.hAlign ?? null,
                textColor: raw.textColor ?? null,
                bgColor: raw.bgColor ?? null,
                width: raw.width ?? null,
                bold: raw.bold ?? null,
                italic: raw.italic ?? null,
                underline: raw.underline ?? null,
                fontSize: raw.fontSize ?? null,
                fontFamily: raw.fontFamily ?? null,
                isNonEntry: raw.isNonEntry ?? false,
                formula: raw.formula ?? null,
                conditionalFormats: Array.isArray(raw.conditionalFormats) ? raw.conditionalFormats : [],
            }];
        });
        this.endCol = this.startCol + this.columns.length - 1;
    }

    #syncRows() {
        // Views read rows from the source table, not their own Y.Map.
        const rowSrc = this.#sourceYMap ?? this.#tableYMap;
        const arr = rowSrc.get("rows");
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
        const src = this.#sourceYMap; // non-null for view tables

        // Top-level map observer for own Y.Map (id, name, mode, position)
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
            if (!src) {
                // Only regular tables store sort/accentColor on their own map
                this.accentColor = m.get("accentColor") ?? this.accentColor;
                const prevSort = this.sortColId + this.sortDir;
                this.sortColId = m.get("sortColId") ?? null;
                this.sortDir = m.get("sortDir") ?? "asc";
                this.insertSortColId = m.get("insertSortColId") ?? null;
                this.insertSortDir = m.get("insertSortDir") ?? "asc";
                if (prevSort !== this.sortColId + this.sortDir) this.#rebuildView();
            } else {
                // Views: re-sync visible-columns ordering when own map changes
                this.#syncColumns();
            }
        };
        m.observe(topObs);
        this.#observers.push(() => m.unobserve(topObs));

        if (src) {
            // View table: observe source for sort/accentColor/column/row changes
            const srcTopObs = () => {
                this.accentColor = src.get("accentColor") ?? this.accentColor;
                const prevSort = this.sortColId + this.sortDir;
                this.sortColId = src.get("sortColId") ?? null;
                this.sortDir = src.get("sortDir") ?? "asc";
                this.insertSortColId = src.get("insertSortColId") ?? null;
                this.insertSortDir = src.get("insertSortDir") ?? "asc";
                if (prevSort !== this.sortColId + this.sortDir) this.#rebuildView();
            };
            src.observe(srcTopObs);
            this.#observers.push(() => src.unobserve(srcTopObs));

            // Observe source columns
            const srcDefsMap = src.get("columnDefs");
            const srcOrderArr = src.get("columnOrder");
            if (srcDefsMap && srcOrderArr) {
                const colObs = () => this.#syncColumns();
                srcDefsMap.observeDeep(colObs);
                srcOrderArr.observe(colObs);
                this.#observers.push(() => {
                    srcDefsMap.unobserveDeep(colObs);
                    srcOrderArr.unobserve(colObs);
                });
            }

            // Observe source rows
            const srcRowArr = src.get("rows");
            if (srcRowArr) {
                const rowObs = () => this.#syncRows();
                srcRowArr.observeDeep(rowObs);
                this.#observers.push(() => srcRowArr.unobserveDeep(rowObs));
            }
        } else {
            // Regular table: observe own columns and rows
            const defsMap = m.get("columnDefs");
            const orderArr = m.get("columnOrder");
            if (defsMap && orderArr) {
                const colObs = () => this.#syncColumns();
                defsMap.observeDeep(colObs);
                orderArr.observe(colObs);
                this.#observers.push(() => {
                    defsMap.unobserveDeep(colObs);
                    orderArr.unobserve(colObs);
                });
            }

            const rowArr = m.get("rows");
            if (rowArr) {
                const rowObs = () => this.#syncRows();
                rowArr.observeDeep(rowObs);
                this.#observers.push(() => rowArr.unobserveDeep(rowObs));
            }
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
        // Views write back to the source table's rows
        const rowArr = (this.#sourceYMap ?? this.#tableYMap).get("rows");
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
        });
    }

    /**
     * Delete the row at display index (in sortedFilteredRows).
     * @param {number} displayIndex
     */
    deleteRow(displayIndex) {
        this.deleteRows([displayIndex]);
    }

    /**
     * Delete multiple rows by their display indices (in sortedFilteredRows).
     * All deletions happen in a single Yjs transaction.
     * @param {number[]} displayIndices
     */
    deleteRows(displayIndices) {
        const rowArr = (this.#sourceYMap ?? this.#tableYMap).get("rows");
        if (!rowArr || !displayIndices.length) return;

        // Map display indices → raw row objects, then raw row objects → raw indices.
        // Collecting objects first avoids index-shift problems when mapping back.
        const rowObjects = displayIndices
            .map((di) => this.sortedFilteredRows[di])
            .filter(Boolean);

        const rawIndices = rowObjects
            .map((r) => this.rows.findIndex((raw) => raw === r))
            .filter((i) => i >= 0);

        // Deduplicate and sort descending so each deletion doesn't shift later indices.
        const sorted = [...new Set(rawIndices)].sort((a, b) => b - a);

        this.#ydoc.transact(() => {
            for (const rawIndex of sorted) {
                rowArr.delete(rawIndex, 1);
            }
        });
    }

    /**
     * Update a single cell in a display-indexed row.
     * @param {number} displayIndex
     * @param {string} colId
     * @param {any} value
     */
    updateCell(displayIndex, colId, value) {
        const rowArr = (this.#sourceYMap ?? this.#tableYMap).get("rows");
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
        const defsMap = this.#tableYMap.get("columnDefs");
        if (!defsMap) return;
        this.#ydoc.transact(() => {
            const cm = defsMap.get(colId);
            if (cm) cm.set("name", newName);
        });
    }

    /**
     * Update multiple properties of a column at once.
     * @param {string} colId
     * @param {Object} changes - Partial column definition
     */
    updateColumnDef(colId, changes) {
        const defsMap = this.#tableYMap.get("columnDefs");
        if (!defsMap) return;
        this.#ydoc.transact(() => {
            const cm = defsMap.get(colId);
            if (!cm) return;
            for (const [key, value] of Object.entries(changes)) {
                if (key === "conditionalFormats") {
                    cm.set(key, JSON.stringify(value));
                } else if (value === null || value === undefined) {
                    cm.delete(key);
                } else {
                    cm.set(key, value);
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
        const defsMap = this.#tableYMap.get("columnDefs");
        const orderArr = this.#tableYMap.get("columnOrder");
        if (!defsMap || !orderArr) return "";

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

            defsMap.set(colId, cm);
            const insertAt = Math.max(0, Math.min(atIndex, orderArr.length));
            orderArr.insert(insertAt, [colId]);
        });

        return colId;
    }

    /**
     * Delete a column by ID.
     * @param {string} colId
     */
    deleteColumn(colId) {
        const defsMap = this.#tableYMap.get("columnDefs");
        const orderArr = this.#tableYMap.get("columnOrder");
        const rowArr = this.#tableYMap.get("rows");
        if (!defsMap || !orderArr) return;

        this.#ydoc.transact(() => {
            defsMap.delete(colId);
            const idx = orderArr.toArray().indexOf(colId);
            if (idx >= 0) orderArr.delete(idx, 1);
            if (rowArr) {
                for (let i = 0; i < rowArr.length; i++) {
                    const row = rowArr.get(i);
                    if (row?.has?.(colId)) row.delete(colId);
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
        const orderArr = this.#tableYMap.get("columnOrder");
        if (!orderArr || fromIndex === toIndex) return;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= orderArr.length || toIndex >= orderArr.length) return;

        this.#ydoc.transact(() => {
            const colId = orderArr.get(fromIndex);
            orderArr.delete(fromIndex, 1);
            orderArr.insert(toIndex, [colId]);
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

    /**
     * Callback registered by TableManager to rebuild the row index when
     * filters change. Filters are local state (not Yjs), so Yjs observers
     * won't fire — we must call this manually.
     * @type {(() => void) | null}
     */
    _onFilterChange = null;

    setFilter(colId, op, value) {
        this.filters = { ...this.filters, [colId]: { op, value } };
        this.#rebuildView();
        this._onFilterChange?.();
    }

    clearFilter(colId) {
        const f = { ...this.filters };
        delete f[colId];
        this.filters = f;
        this.#rebuildView();
        this._onFilterChange?.();
    }

    clearAllFilters() {
        this.filters = {};
        this.#rebuildView();
        this._onFilterChange?.();
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

    /**
     * Paste external rows (from Excel / Google Sheets / CSV) into this table.
     *
     * Column mapping:
     *  - Header detection: if the first row matches ≥ half the non-empty cells
     *    against column names (case-insensitive), treat it as a header row and
     *    map by name. Column order in the clipboard doesn't matter.
     *  - Otherwise map positionally from startColOffset into the editable columns.
     *
     * Entirely blank rows are skipped. Required-field validation is not enforced
     * (bulk import — user can clean up after). Empty cells in a row are omitted
     * from the Y.Map so they don't overwrite existing values when updating.
     *
     * @param {string[][]} rows2D          2D array of raw string values
     * @param {number}     [startColOffset] 0-based index into editable columns (default 0)
     * @returns {{ inserted: number, skipped: number }}
     */
    pasteRows(rows2D, startColOffset = 0) {
        if (!rows2D?.length) return { inserted: 0, skipped: 0 };

        const entryCols = this.columns.filter(c => !c.isNonEntry);
        if (!entryCols.length) return { inserted: 0, skipped: 0 };

        // ── Column mapping ────────────────────────────────────────────────────
        const firstRow  = rows2D[0].map(v => String(v ?? '').trim());
        const colNames  = entryCols.map(c => c.name.toLowerCase().trim());
        const nonBlank  = firstRow.filter(Boolean);
        const nameHits  = nonBlank.filter(h => colNames.includes(h.toLowerCase())).length;
        const hasHeaders = nonBlank.length > 0 && nameHits >= Math.ceil(nonBlank.length / 2);

        // colMap[i] = colDef for source column i, or null if unmapped
        let colMap;
        if (hasHeaders) {
            colMap = firstRow.map(h =>
                entryCols.find(c => c.name.toLowerCase().trim() === h.toLowerCase()) ?? null
            );
        } else {
            const offsetCols = entryCols.slice(startColOffset);
            colMap = rows2D[0].map((_, i) => offsetCols[i] ?? null);
        }

        const dataRows = hasHeaders ? rows2D.slice(1) : rows2D;
        const rowArr   = (this.#sourceYMap ?? this.#tableYMap).get("rows");
        if (!rowArr) return { inserted: 0, skipped: 0 };

        let inserted = 0, skipped = 0;

        this.#ydoc.transact(() => {
            for (const srcRow of dataRows) {
                // Skip entirely blank rows (common with Excel trailing selections)
                if (srcRow.every(cell => !String(cell ?? '').trim())) {
                    skipped++;
                    continue;
                }

                const yRow = new Y.Map();
                for (let i = 0; i < srcRow.length; i++) {
                    const colDef = colMap[i];
                    if (!colDef) continue;
                    const raw = String(srcRow[i] ?? '').trim();
                    if (!raw) continue; // leave cell absent rather than storing ""
                    yRow.set(colDef.id, this.#parseValueForType(raw, colDef.type));
                }
                rowArr.push([yRow]);
                inserted++;
            }
        });

        return { inserted, skipped };
    }

    /**
     * Parse a raw string to a typed value suitable for storing in this column.
     * @param {string} raw
     * @param {string} type
     * @returns {any}
     */
    #parseValueForType(raw, type) {
        switch (type) {
            case 'number':
            case 'currency': {
                const n = parseFloat(raw.replace(/[$,\s]/g, ''));
                return isNaN(n) ? raw : n;
            }
            case 'checkbox':
                return ['true', 'yes', '1', 'x', '✓', 'on'].includes(raw.toLowerCase());
            case 'date': {
                const d = new Date(raw);
                return isNaN(d.getTime()) ? raw : d.toISOString().split('T')[0];
            }
            default:
                return raw;
        }
    }

    /**
     * Paste into existing data rows, overwriting cells in place.
     *
     * Maps source columns positionally from startColOffset into ALL table columns
     * (including formula columns). Formula columns map to null and are skipped,
     * so pasting across a formula column naturally fills the next entry column.
     * Rows that extend past the last data row are appended as new rows.
     *
     * Delegates per-cell updates to updateCell() so the code path is identical
     * to keyboard editing (same Yjs mutation, same cumsum invalidation).
     *
     * @param {string[][]} rows2D
     * @param {number}     startDisplayIndex  display index of the first target row
     * @param {number}     [startColOffset]   absolute offset into this.columns (0 = first col)
     */
    updateRows(rows2D, startDisplayIndex, startColOffset = 0) {
        if (!rows2D?.length) return;

        // Build colMap using ALL columns (inc. formula) so positions align with
        // what the user clicked. Formula columns resolve to null and are skipped.
        const tableColsFromOffset = this.columns.slice(startColOffset);
        const colMap = rows2D[0].map((_, i) => {
            const col = tableColsFromOffset[i];
            return (col && !col.isNonEntry) ? col : null;
        });

        const rowArr = (this.#sourceYMap ?? this.#tableYMap).get("rows");
        if (!rowArr) return;

        for (let i = 0; i < rows2D.length; i++) {
            const srcRow = rows2D[i];
            if (srcRow.every(cell => !String(cell ?? '').trim())) continue;

            const displayIndex = startDisplayIndex + i;

            if (displayIndex < this.sortedFilteredRows.length) {
                // Update existing row via updateCell — same path as keyboard editing
                for (let j = 0; j < srcRow.length; j++) {
                    const colDef = colMap[j];
                    if (!colDef) continue;
                    const raw = String(srcRow[j] ?? '').trim();
                    if (!raw) continue;
                    this.updateCell(displayIndex, colDef.id, this.#parseValueForType(raw, colDef.type));
                }
            } else {
                // Overflow row — append as new
                this.#ydoc.transact(() => {
                    const yRow = new Y.Map();
                    for (let j = 0; j < srcRow.length; j++) {
                        const colDef = colMap[j];
                        if (!colDef) continue;
                        const raw = String(srcRow[j] ?? '').trim();
                        if (!raw) continue;
                        yRow.set(colDef.id, this.#parseValueForType(raw, colDef.type));
                    }
                    rowArr.push([yRow]);
                });
            }
        }
    }

    // ─── Query API ────────────────────────────────────────────────────────────

    getValue(displayIndex, colId) {
        return this.#eval
            ? this.#eval.getValue(displayIndex, colId)
            : this.sortedFilteredRows[displayIndex]?.[colId];
    }

    getColumn(colId) {
        return this.sortedFilteredRows.map((_, i) => this.getValue(i, colId));
    }

    getRowCount() {
        return this.sortedFilteredRows.length;
    }

    getCumulativeSum(colId, upToDisplayIndex) {
        return this.#eval ? this.#eval.getCumulativeSum(colId, upToDisplayIndex) : 0;
    }

    // kept for callers that do `store.evaluateFormula(formula, rowIndex)` directly
    evaluateFormula(formula, rowIndex) {
        return this.#eval ? this.#eval.evaluateFormula(formula, rowIndex) : null;
    }

    resolveColId(/** @type {string} */ nameOrId) {
        return this.#eval ? this.#eval.resolveColId(nameOrId) : String(nameOrId ?? '');
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

    /** True when this store is a view of another table. */
    get isView() { return this.#sourceYMap !== null; }

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
        // Use index directly to avoid O(n²) indexOf calls
        const body = rows.map((_, i) =>
            cols.map(c => escape(this.getValue(i, c.id))).join(',')
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
