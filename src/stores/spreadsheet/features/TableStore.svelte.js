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
 *
 * Filters are local session state only (not persisted in Yjs).
 *
 * ## Column definition (Y.Map fields)
 *   id, name, type, required,
 *   hAlign, textColor, bgColor, width,
 *   isNonEntry, defaultFormula,
 *   conditionalFormats (JSON string)
 *
 * ## Column default formulas
 * Any column may have a `defaultFormula`. When a row is inserted the formula is
 * evaluated and its result is stored as a plain value. The user can later edit
 * that cell to override the stored value — the formula is not re-evaluated.
 *
 * `isNonEntry` is an independent toggle. When true the cell is read-only in the
 * grid regardless of whether a defaultFormula is set.
 *
 * Columns with `isNonEntry=true` AND `defaultFormula` behave as pure computed
 * columns (values are never stored, always derived from the formula at read time).
 *
 * ## Formula DSL
 *
 *   {colId} / {column name}   Current row value of a column
 *   ROW / ROW1                0-based / 1-based row index
 *   COUNT                     Total number of rows
 *
 *   — Row reference helpers —
 *   PREV(col)                 Computed value of col in the previous row (0 if none)
 *   PREV(col, default)        Same, with explicit fallback value
 *   NEXT(col)                 Computed value of col in the next row (null if none)
 *   NEXT(col, default)        Same, with explicit fallback
 *   ROWVAL(col, n)            Computed value of col at absolute row index n
 *   WINDOW(col, before)       Array of col values [ROW-before…ROW] — use with AVERAGE()/SUM()
 *   WINDOW(col, before,after) Array of col values [ROW-before…ROW+after]
 *
 *   — Aggregates (all rows) —
 *   SUM(col), AVG(col), MIN(col), MAX(col)
 *
 *   — Conditional aggregates —
 *   SUMIF(sum, filter, op, val), COUNTIF, AVGIF, MINIF, MAXIF
 *   SUMIFS(sum, col1,op1,val1,...), COUNTIFS, AVGIFS
 *
 *   — Running aggregates (up to current row) —
 *   RUNNINGIF(sum, filter, op, val)
 *   RUNNINGIFS(sum, col1,op1,val1,...)
 *
 * ## Examples
 *   {amount} + PREV(balance, 0)       Running balance (cumsum via row formula)
 *   AVERAGE(WINDOW(amount, 2))        3-row sliding average
 *   {price} * {qty}                   Row total
 *   IF({qty} > 0, {price} * {qty}, 0) Row total with guard
 */

import * as Y from "yjs";
import { TableFormulaEvaluator, matchCondition } from './tableFormulaEval.js';

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
     * For view tables: the Y.Map of the source table. Used for Yjs mutations
     * (insertRow, updateCell) and observing source sort/column changes.
     * @type {import('yjs').Map<any> | null}
     */
    #sourceYMap = null;

    /**
     * For view tables: the live TableStore of the source table.
     * Views borrow rows and allColumns from here instead of re-reading Yjs.
     * @type {TableStore | null}
     */
    #sourceStore = null;

    /**
     * For source tables: view TableStores registered to receive row-change
     * notifications. Populated by views calling #addViewStore on their source.
     * @type {TableStore[]}
     */
    #viewStores = [];

    /** @type {Function[]} cleanup callbacks */
    #observers = [];

    // ── Core identity ────────────────────────────────────────────────────────
    id = $state("");
    name = $state("Table");
    mode = $state("inline"); // 'inline' | 'viewport'

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
     *   isNonEntry: boolean, defaultFormula: string|null,
     *   conditionalFormats: Array<{condition:string,value:any,style:{backgroundColor?:string,color?:string,bold?:boolean}}>
     * }>}
     */
    columns = $state([]);

    // rows and allColumns are owned by source tables; views return the source's values
    // via getters so there is only one copy of each in memory per source table.
    #_allColumns = $state([]);
    #_rows = $state([]);

    /** Full parsed column defs including hidden columns. Source tables own the array; views borrow it. */
    get allColumns() { return this.#sourceStore ? this.#sourceStore.allColumns : this.#_allColumns; }
    set allColumns(v) { if (!this.#sourceStore) this.#_allColumns = v; }

    /** Plain-object row array. Source tables own the array; views borrow it. */
    get rows() { return this.#sourceStore ? this.#sourceStore.rows : this.#_rows; }
    set rows(v) { if (!this.#sourceStore) this.#_rows = v; }

    // ── Sort / filter ─────────────────────────────────────────────────────────
    sortColId = $state(null);
    sortDir = $state("asc");

    /**
     * Ad-hoc session filters (not persisted). Applied on top of any view definition
     * filters. Controlled by the filter popover / TableFilterPopover UI.
     * colId → { op, value }
     */
    filters = $state({});

    /**
     * View definition filters (views only). Persisted in the view's `persistedFilters`
     * Y.Map. Applied transparently — the user sees only the matching rows without
     * any explicit "filter active" indicator for these.
     * Managed through DocumentTablesPanel, not the ad-hoc filter UI.
     * colId → { op, value }
     */
    viewDefinitionFilters = $state({});

    // ── Insert sort (sort inserted rows by a column on entry) ─────────────────
    insertSortColId = $state(null);
    insertSortDir = $state("asc");

    // ── Sorted+filtered view (plain $state — updated imperatively) ───────────
    // Using $state instead of $derived.by so that changes always propagate to
    // components regardless of Svelte's cross-boundary reactive graph.
    sortedFilteredRows = $state([]);

    // Set by checkOutOfOrder() after a cell edit — cleared by reorderRow.
    outOfOrderRow = $state(null);

    #rebuildView(rebuildAllRowsEval = true) {
        // Canonical order is always _pos desc (highest = newest = top).
        // Display sort is applied on top of this base as a temporary view layer.
        let result = [...this.rows].sort((a, b) => (b._pos ?? 0) - (a._pos ?? 0));

        // 1. Apply transparent view-definition filters (views only, from persistedFilters)
        for (const [colId, f] of Object.entries(this.viewDefinitionFilters)) {
            result = result.filter(row => matchCondition(row[colId], f.op, f.value));
        }

        // 2. Apply ad-hoc session filters on top
        for (const [colId, f] of Object.entries(this.filters)) {
            result = result.filter(row => matchCondition(row[colId], f.op, f.value));
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
        // Cumulative formulas always accumulate from bottom upward: oldest rows at bottom
        // contribute first. Canonical order is always newest-first, so this never changes.
        const evalColumns = this.allColumns?.length ? this.allColumns : this.columns;

        // Snapshot Svelte proxy rows to plain objects before handing to the formula
        // evaluator. Without this, every this.#rows[i][colId] access inside
        // #buildComputedCache fires the Svelte proxy get handler, adding ~60ms of
        // overhead per evaluation on tables with formula columns.
        const plainRows = result.map(r => ({ ...r }));
        this.#eval = new TableFormulaEvaluator(plainRows, evalColumns, true, this.#tableResolver, this.#sheetFormulaEval);

        // Views delegate getFullValue/getFullRowCount to the source store — no #allRowsEval needed.
        if (!this.#sourceStore && (rebuildAllRowsEval || !this.#allRowsEval)) {
            const plainAllRows = this.rows.map(r => ({ ...r }));
            this.#allRowsEval = new TableFormulaEvaluator(plainAllRows, evalColumns, true, this.#tableResolver, this.#sheetFormulaEval);
        }
    }

    // ── Entry form buffer (local only — not in Yjs until committed) ──────────
    entryBuffer = $state({});
    entryErrors = $state({});

    /**
     * Optional callback provided by SpreadsheetSession to evaluate spreadsheet
     * formulas stored as cell values (e.g. "=10*15" → 150).
     * Set via setSheetFormulaEvaluator() after the formula engine is ready.
     * @type {((formula: string) => any) | null}
     */
    #sheetFormulaEval = null;

    /** @type {((name: string) => import('./TableStore.svelte.js').TableStore|null)|null} */
    #tableResolver = null;

    // ── Formula evaluators (recreated on every #rebuildView) ─────────────────
    /** @type {TableFormulaEvaluator|null} Evaluator for sortedFilteredRows (display API). */
    #eval = null;
    /** @type {TableFormulaEvaluator|null} Evaluator for all rows (sheet formula API). */
    #allRowsEval = null;

    /**
     * @param {import('yjs').Map<any>} tableYMap
     * @param {import('yjs').Doc} ydoc
     * @param {import('yjs').Map<any> | null} [sourceTableYMap]  Source Y.Map for view tables (Yjs mutations + sort/column observers).
     * @param {TableStore | null} [sourceStore]  Live source TableStore for views. When provided, rows and allColumns are borrowed from it.
     * @param {((name: string) => TableStore|null) | null} [tableResolver]  Cross-table resolver. Pass at construction to avoid a second #rebuildView() call from setTableResolver().
     */
    constructor(tableYMap, ydoc, sourceTableYMap = null, sourceStore = null, tableResolver = null) {
        this.#tableYMap = tableYMap;
        this.#ydoc = ydoc;
        this.#sourceYMap = sourceTableYMap;
        this.#sourceStore = sourceStore;
        if (tableResolver) this.#tableResolver = tableResolver;
        this.#migrateColumnsIfNeeded();
        this.#syncFromYjs();
        this.#observeYjs();
    }

    /**
     * One-time migrations:
     * 1. Converts old `columns` Y.Array<Y.Map> to `columnDefs`/`columnOrder`.
     * 2. Renames `formula` → `defaultFormula` on each column def (the old model
     *    coupled formula with isNonEntry=true; the new model separates them).
     */
    #migrateColumnsIfNeeded() {
        // Migration 1: old flat columns array → columnDefs map + columnOrder array
        if (!this.#tableYMap.has("columnDefs") && !this.#tableYMap.has("columnOrder")) {
            const oldCols = this.#tableYMap.get("columns");
            if (oldCols) {
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
        }

        // Migration 2: rename `formula` → `defaultFormula` on each column def
        const src = this.#sourceYMap ?? this.#tableYMap;
        const defsMap = src.get("columnDefs");
        if (defsMap) {
            let needsMigration = false;
            defsMap.forEach((cm) => {
                if (cm && cm.has && cm.has("formula") && !cm.has("defaultFormula")) needsMigration = true;
            });
            if (needsMigration) {
                this.#ydoc.transact(() => {
                    defsMap.forEach((cm) => {
                        if (!cm || !cm.has || !cm.has("formula") || cm.has("defaultFormula")) return;
                        const f = cm.get("formula");
                        if (f) cm.set("defaultFormula", f);
                        cm.delete("formula");
                    });
                });
            }
        }
    }

    // ─── Yjs sync ────────────────────────────────────────────────────────────

    #syncFromYjs() {
        const m = this.#tableYMap;
        // Views inherit sort config from source so both show data in the same order.
        const sortSrc = this.#sourceYMap ?? m;
        this.id = m.get("id") ?? "";
        this.name = m.get("name") ?? "Table";
        this.mode = m.get("mode") ?? "inline";
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
        // Views load persisted filters from their own Y.Map
        if (this.#sourceYMap) this.#loadPersistedFilters();
        this.#syncColumns();
        this.#syncRows();
        // Recompute endCol from columns
        const cols = this.columns;
        this.endCol = cols.length > 0 ? this.startCol + cols.length - 1 : this.startCol;
    }

    /**
     * Read persisted view-definition filters from the view's persistedFilters Y.Map
     * into this.viewDefinitionFilters (NOT into this.filters — keep them separate).
     */
    #loadPersistedFilters() {
        const pf = this.#tableYMap.get("persistedFilters");
        if (!pf) return;
        /** @type {Record<string,{op:string,value:any}>} */
        const loaded = {};
        pf.forEach((/** @type {string} */ jsonStr, /** @type {string} */ colId) => {
            try { loaded[colId] = JSON.parse(jsonStr); } catch { /* ignore */ }
        });
        this.viewDefinitionFilters = loaded;
    }

    /**
     * Ensure the view's persistedFilters Y.Map exists; create it if absent.
     * Only call for view tables (#sourceYMap is set).
     * @returns {import('yjs').Map<any>}
     */
    #getOrCreatePersistedFilters() {
        let pf = this.#tableYMap.get("persistedFilters");
        if (!pf) {
            pf = new Y.Map();
            this.#ydoc.transact(() => { this.#tableYMap.set("persistedFilters", pf); });
        }
        return pf;
    }

    #syncColumns() {
        if (this.#sourceStore) {
            // View: build the visible column subset from the source store's already-parsed
            // allColumns. No Y.Map reads — zero redundant work.
            const allCols = this.#sourceStore.allColumns;
            const visibleArr = this.#tableYMap.get("visibleColumns");
            if (!visibleArr || visibleArr.length === 0) {
                this.columns = allCols;
            } else {
                const byId = new Map(allCols.map(c => [c.id, c]));
                this.columns = visibleArr.toArray().flatMap(id => byId.has(id) ? [byId.get(id)] : []);
            }
            this.endCol = this.startCol + this.columns.length - 1;
            return;
        }

        // Source/legacy table: parse column defs from Y.Map once.
        // allColumns and columns are identical for source tables (no visibleColumns filter).
        const colSrc = this.#sourceYMap ?? this.#tableYMap;
        const defsMap = colSrc.get("columnDefs");
        const orderArr = colSrc.get("columnOrder");
        if (!defsMap || !orderArr) {
            this.#_allColumns = [];
            this.columns = [];
            return;
        }

        const allColumns = orderArr.toArray().flatMap((/** @type {string} */ colId) => {
            const c = defsMap.get(colId);
            if (!c) return [];
            const raw = c.toJSON ? c.toJSON() : { ...c };
            if (typeof raw.conditionalFormats === "string") {
                try { raw.conditionalFormats = JSON.parse(raw.conditionalFormats); }
                catch { raw.conditionalFormats = []; }
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
                bold: raw.bold ?? null,
                italic: raw.italic ?? null,
                underline: raw.underline ?? null,
                fontSize: raw.fontSize ?? null,
                fontFamily: raw.fontFamily ?? null,
                width: raw.width ?? null,
                isNonEntry: raw.isNonEntry ?? false,
                defaultFormula: raw.defaultFormula ?? null,
                conditionalFormats: Array.isArray(raw.conditionalFormats) ? raw.conditionalFormats : [],
            }];
        });
        // Source tables: columns === allColumns (no visibility filter applied here).
        this.#_allColumns = allColumns;
        this.columns = allColumns;
        this.endCol = this.startCol + this.columns.length - 1;
    }

    #syncRows() {
        if (this.#sourceStore) {
            // View: rows are owned by the source store (borrowed via getter).
            // Just rebuild our sorted/filtered view — no Yjs read needed.
            this.#rebuildView();
            return;
        }
        // Source/legacy table: read rows from Y.Map and notify registered views.
        const rowSrc = this.#sourceYMap ?? this.#tableYMap;
        const arr = rowSrc.get("rows");
        if (!arr) {
            this.#_rows = [];
            this.#rebuildView();
            this.#notifyViewStores();
            return;
        }
        this.#_rows = arr.toArray().map((r) => {
            const obj = r.toJSON ? r.toJSON() : { ...r };
            // Parse per-row and per-cell formatting JSON eagerly so paint reads are O(1)
            if (typeof obj._rowFmt === 'string') {
                try { obj._rowFmt = JSON.parse(obj._rowFmt); } catch { obj._rowFmt = undefined; }
            }
            if (typeof obj._fmt === 'string') {
                try { obj._fmt = JSON.parse(obj._fmt); } catch { obj._fmt = undefined; }
            }
            return obj;
        });
        this.#rebuildView();
        this.#notifyViewStores();
    }

    // ── View store notification (source → views) ─────────────────────────────

    /** Register a view store to be notified when this source's rows change. */
    #addViewStore(view) { this.#viewStores.push(view); }

    /** Unregister a view store (called from the view's destroy cleanup). */
    #removeViewStore(view) { this.#viewStores = this.#viewStores.filter(v => v !== view); }

    /** Called by source after #syncRows() to propagate the update to all views. */
    #notifyViewStores() {
        for (const view of this.#viewStores) view.#onSourceRowsChanged();
    }

    /** Called on a view when its source store's rows have been updated. */
    #onSourceRowsChanged() {
        // this.rows (getter) already returns the updated source rows — just rebuild view.
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
                // Only regular tables store sort state on their own map.
                const prevSort = this.sortColId + this.sortDir;
                this.sortColId = m.get("sortColId") ?? null;
                this.sortDir = m.get("sortDir") ?? "asc";
                this.insertSortColId = m.get("insertSortColId") ?? null;
                this.insertSortDir = m.get("insertSortDir") ?? "asc";
                if (prevSort !== this.sortColId + this.sortDir) this.#rebuildView(false);
            } else {
                // Views: re-sync visible-columns ordering when own map changes
                this.#syncColumns();
            }
        };
        m.observe(topObs);
        this.#observers.push(() => m.unobserve(topObs));

        if (src) {
            // View table: observe visibleColumns Y.Array so column subset/order changes
            // propagate immediately (Y.Map.observe does not fire for nested Y.Array edits).
            const visibleArr = m.get("visibleColumns");
            if (visibleArr) {
                const visObs = () => {
                    this.#syncColumns();
                    this._onFilterChange?.();
                };
                visibleArr.observe(visObs);
                this.#observers.push(() => visibleArr.unobserve(visObs));
            }

            // View table: observe persistedFilters Y.Map so filter changes from other
            // sessions (or undo/redo) are picked up and applied to the live view.
            let observedPf = null;
            const pfObs = () => {
                // Reload view definition filters into viewDefinitionFilters
                this.#loadPersistedFilters();
                this.#rebuildView(false);
                this._onFilterChange?.();
            };
            const attachPersistedFiltersObserver = () => {
                const nextPf = m.get("persistedFilters");
                if (observedPf === nextPf) return;
                if (observedPf) observedPf.unobserve(pfObs);
                observedPf = nextPf ?? null;
                if (observedPf) observedPf.observe(pfObs);
            };
            attachPersistedFiltersObserver();
            this.#observers.push(() => {
                if (observedPf) observedPf.unobserve(pfObs);
            });

            // View table: observe source for sort/column/row changes
            const srcTopObs = () => {
                const prevSort = this.sortColId + this.sortDir;
                this.sortColId = src.get("sortColId") ?? null;
                this.sortDir = src.get("sortDir") ?? "asc";
                this.insertSortColId = src.get("insertSortColId") ?? null;
                this.insertSortDir = src.get("insertSortDir") ?? "asc";
                if (prevSort !== this.sortColId + this.sortDir) this.#rebuildView(false);
            };
            src.observe(srcTopObs);
            this.#observers.push(() => src.unobserve(srcTopObs));

            // Catch late creation/replacement of persistedFilters Y.Map.
            const ownTopObs = () => attachPersistedFiltersObserver();
            m.observe(ownTopObs);
            this.#observers.push(() => m.unobserve(ownTopObs));

            // Observe source columns (views rebuild their visible subset when source schema changes).
            const srcDefsMap = src.get("columnDefs");
            const srcOrderArr = src.get("columnOrder");
            if (srcDefsMap && srcOrderArr) {
                const colObs = () => { this.#syncColumns(); this.#rebuildView(); };
                srcDefsMap.observeDeep(colObs);
                srcOrderArr.observe(colObs);
                this.#observers.push(() => {
                    srcDefsMap.unobserveDeep(colObs);
                    srcOrderArr.unobserve(colObs);
                });
            }

            // Row changes: register with the source store so it calls #onSourceRowsChanged()
            // after its own #syncRows(). This replaces the previous srcRowArr.observeDeep,
            // which caused a full duplicate sync (2× TableFormulaEvaluator construction) on
            // every cell edit.
            if (this.#sourceStore) {
                this.#sourceStore.#addViewStore(this);
                this.#observers.push(() => this.#sourceStore.#removeViewStore(this));
            } else {
                // Fallback: no live source store reference — observe Y.Array directly.
                const srcRowArr = src.get("rows");
                if (srcRowArr) {
                    const rowObs = () => this.#syncRows();
                    srcRowArr.observeDeep(rowObs);
                    this.#observers.push(() => srcRowArr.unobserveDeep(rowObs));
                }
            }
        } else {
            // Regular table: observe own columns and rows
            const defsMap = m.get("columnDefs");
            const orderArr = m.get("columnOrder");
            if (defsMap && orderArr) {
                const colObs = () => { this.#syncColumns(); this.#rebuildView(); };
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
     * Assigns a _pos higher than all existing rows so the new entry appears at top,
     * unless insertSort is configured — in that case _pos is computed to place the
     * row at the top of its sort-value group.
     * @param {Object} rowData  colId → value
     */
    insertRow(rowData) {
        // Views write back to the source table's rows
        const rowArr = (this.#sourceYMap ?? this.#tableYMap).get("rows");
        if (!rowArr) return;

        // Evaluate default formulas and merge with user-provided data.
        // isNonEntry columns are never stored; defaultFormula (non-isNonEntry) cols
        // get their formula result stored unless the user already provided a value.
        const withDefaults = { ...rowData };
        if (this.#eval) {
            const computed = this.#eval.applyDefaultFormulas(rowData);
            for (const [colId, val] of computed) {
                const def = this.columns.find(c => c.id === colId);
                if (!def || def.isNonEntry) continue; // isNonEntry: never store
                if (withDefaults[colId] === undefined || withDefaults[colId] === null) {
                    withDefaults[colId] = val;
                }
            }
        }

        this.#ydoc.transact(() => {
            const yRow = new Y.Map();
            // Store all columns except isNonEntry (pure computed, never stored)
            for (const [k, v] of Object.entries(withDefaults)) {
                const colDef = this.columns.find(c => c.id === k);
                if (colDef?.isNonEntry) continue;
                yRow.set(k, v);
            }

            this.#initPos(rowArr);
            const newPos = this.insertSortColId
                ? this.#computeInsertPos(rowArr, rowData[this.insertSortColId])
                : Math.max(0, ...rowArr.toArray().map(r => r?.get?.('_pos') ?? 0)) + 1000;
            yRow.set('_pos', newPos);
            rowArr.push([yRow]);
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

    // ─── Row ordering helpers (private) ──────────────────────────────────────

    /** Generic value comparator used by insertRow and checkOutOfOrder. */
    #cmpValues(a, b) {
        if (a == null && b == null) return 0;
        if (a == null) return -1;
        if (b == null) return 1;
        if (typeof a === "number" && typeof b === "number") return a - b;
        return String(a).localeCompare(String(b));
    }

    /**
     * Assign _pos to any row in the raw Y.Array that is missing it.
     * rawIndex 0 = oldest inserted = lowest _pos (display bottom).
     * rawIndex n-1 = newest inserted = highest _pos (display top).
     * Must be called inside a Yjs transaction.
     * @param {import('yjs').Array} rowArr
     */
    #initPos(rowArr) {
        const n = rowArr.length;
        for (let i = 0; i < n; i++) {
            const r = rowArr.get(i);
            if (r && r.get('_pos') == null) r.set('_pos', (i + 1) * 1000);
        }
    }

    /**
     * Write a new _pos to the row at displayIndex.
     * @param {import('yjs').Array} rowArr
     * @param {number} displayIndex
     * @param {number} newPos
     */
    #setRowPos(rowArr, displayIndex, newPos) {
        const row = this.sortedFilteredRows[displayIndex];
        if (!row) return;
        const rawIndex = this.rows.findIndex(r => r === row);
        if (rawIndex < 0) return;
        const yRow = rowArr.get(rawIndex);
        if (yRow) yRow.set('_pos', newPos);
    }

    /**
     * Compute a _pos value for placing a row at the correct insertSort position.
     * Reads _pos values directly from rowArr (safe to call after #initPos in same transaction).
     * @param {import('yjs').Array} rowArr
     * @param {any} newVal
     * @param {number} [excludeRawIndex]  Raw index of a row to exclude (used when repositioning
     *                                    an existing row so it doesn't interfere with the search).
     * @returns {number}
     */
    #computeInsertPos(rowArr, newVal, excludeRawIndex = -1) {
        const colId = this.insertSortColId;
        const dir = this.insertSortDir === "asc" ? -1 : 1; // asc=ascending=lowest first, desc=highest first

        const sorted = [];
        for (let i = 0; i < rowArr.length; i++) {
            if (i === excludeRawIndex) continue;
            const r = rowArr.get(i);
            sorted.push({ val: r?.get?.(colId), pos: r?.get?.('_pos') ?? 0 });
        }
        sorted.sort((a, b) => b.pos - a.pos); // desc _pos = display order

        if (!sorted.length) return 1000;

        for (let i = 0; i < sorted.length; i++) {
            if (dir * this.#cmpValues(sorted[i].val, newVal) <= 0) {
                const abovePos = i > 0 ? sorted[i - 1].pos : null;
                return abovePos == null ? sorted[i].pos + 1000 : (abovePos + sorted[i].pos) / 2;
            }
        }
        return Math.max(0, sorted[sorted.length - 1].pos - 1000);
    }

    // ─── Row ordering (public) ────────────────────────────────────────────────

    /**
     * Move a row from one display index to another.
     * @param {number} fromDisplayIndex
     * @param {number} toDisplayIndex
     */
    reorderRow(fromDisplayIndex, toDisplayIndex) {
        if (fromDisplayIndex === toDisplayIndex) return;
        const rowArr = (this.#sourceYMap ?? this.#tableYMap).get("rows");
        if (!rowArr) return;

        this.#ydoc.transact(() => {
            this.#initPos(rowArr);

            // Build display list with the moved row removed to find its new neighbours.
            const rows = this.sortedFilteredRows;
            const filtered = rows.filter((_, i) => i !== fromDisplayIndex);

            // Regardless of direction: in the filtered array, target neighbours are
            // filtered[toDisplayIndex - 1] (above) and filtered[toDisplayIndex] (below).
            const aboveIdx = toDisplayIndex - 1;
            const belowIdx = toDisplayIndex;
            const above = filtered[aboveIdx];
            const below = filtered[belowIdx];

            let newPos;
            if (!above && below) {
                newPos = (below._pos ?? 1000) + 1000;          // new top
            } else if (above && !below) {
                newPos = Math.max(0, (above._pos ?? 1000) - 1000); // new bottom
            } else if (above && below) {
                const ap = above._pos ?? 0;
                const bp = below._pos ?? 0;
                newPos = (ap + bp) / 2;
                // Re-normalise if gap collapses (< 1 precision).
                if (Math.abs(ap - bp) < 1) {
                    const n = rows.length;
                    for (let di = 0; di < n; di++) {
                        const r = di === toDisplayIndex ? rows[fromDisplayIndex] : filtered[di < toDisplayIndex ? di : di - 1];
                        const rawIdx = this.rows.findIndex(raw => raw === r);
                        if (rawIdx < 0) continue;
                        const yRow = rowArr.get(rawIdx);
                        if (yRow) yRow.set('_pos', (n - di) * 1000);
                    }
                    return;
                }
            } else {
                newPos = 1000; // single row
            }

            this.#setRowPos(rowArr, fromDisplayIndex, newPos);
        });

        this.outOfOrderRow = null;
    }

    /**
     * Check whether the row at displayIndex is out of insertSort order after an edit.
     * Returns null when the row is in order (or insertSort is not configured).
     * Returns an object with placeInOrder() when the row should be moved.
     * @param {number} displayIndex
     * @returns {{ displayIndex: number, placeInOrder: () => void } | null}
     */
    checkOutOfOrder(displayIndex) {
        if (!this.insertSortColId) return null;
        const colId = this.insertSortColId;
        const dir = this.insertSortDir === "asc" ? -1 : 1;
        const rows = this.sortedFilteredRows;
        const val = rows[displayIndex]?.[colId];
        const prevVal = displayIndex > 0 ? rows[displayIndex - 1]?.[colId] : null;
        const nextVal = displayIndex < rows.length - 1 ? rows[displayIndex + 1]?.[colId] : null;

        const prevOk = prevVal == null || dir * this.#cmpValues(prevVal, val) >= 0;
        const nextOk = nextVal == null || dir * this.#cmpValues(val, nextVal) >= 0;
        if (prevOk && nextOk) return null;

        const result = {
            displayIndex,
            placeInOrder: () => {
                const rowArr = (this.#sourceYMap ?? this.#tableYMap).get("rows");
                if (!rowArr) return;
                // Resolve the target row's raw index now (before the transaction) so
                // we can exclude it from the position search — without exclusion the
                // row's own _pos would be found first and it would barely move.
                const targetRow = this.sortedFilteredRows[displayIndex];
                if (!targetRow) return;
                const rawIndex = this.rows.findIndex(r => r === targetRow);
                if (rawIndex < 0) return;
                this.#ydoc.transact(() => {
                    this.#initPos(rowArr);
                    const newPos = this.#computeInsertPos(rowArr, val, rawIndex);
                    const yRow = rowArr.get(rawIndex);
                    if (yRow) yRow.set('_pos', newPos);
                });
                this.outOfOrderRow = null;
            },
        };
        this.outOfOrderRow = result;
        return result;
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

        // Block updates to non-entry columns (read-only toggle)
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
    /** Returns the Y.Map that owns columnDefs, columnOrder, and rows (source for views, own map otherwise). */
    #getColSource() { return this.#sourceYMap ?? this.#tableYMap; }

    // ─── Per-cell / per-row formatting ────────────────────────────────────────
    // Formatting is stored as JSON strings in each row Y.Map:
    //   _rowFmt: { bold, italic, underline, fontSize, fontFamily, color, backgroundColor, horizontalAlign, verticalAlign, wrapText }
    //   _fmt:    { [colId]: { same keys } }
    // JSON strings are parsed eagerly in #syncRows() so read-path is O(1).
    // Write-path reads from Yjs directly to avoid stale-snapshot races.
    //
    // Property names use the toolbar/sheet convention:
    //   color (text), backgroundColor, horizontalAlign, verticalAlign, bold, italic, ...

    #getRowYMap(displayIndex) {
        const rowArr = (this.#sourceYMap ?? this.#tableYMap).get("rows");
        if (!rowArr) return null;
        const sortedRow = this.sortedFilteredRows[displayIndex];
        if (!sortedRow) return null;
        const rawIndex = this.rows.findIndex(r => r === sortedRow);
        if (rawIndex < 0) return null;
        return rowArr.get(rawIndex) ?? null;
    }

    /** Get the parsed per-cell formatting for a display row + column. Returns {} if none set. */
    getCellFormatting(displayIndex, colId) {
        const row = this.sortedFilteredRows[displayIndex];
        return row?._fmt?.[colId] ?? {};
    }

    /** Get the parsed per-row formatting for a display row. Returns {} if none set. */
    getTableRowFormatting(displayIndex) {
        const row = this.sortedFilteredRows[displayIndex];
        return row?._rowFmt ?? {};
    }

    /**
     * Effective merged formatting for one cell: column-def → row → cell (cell wins).
     * Uses same property names as sheet cells (color, backgroundColor, horizontalAlign…).
     */
    getEffectiveCellFormatting(displayIndex, colId) {
        const colDef = this.columns.find(c => c.id === colId);
        const merged = {
            bold: colDef?.bold ?? null,
            italic: colDef?.italic ?? null,
            underline: colDef?.underline ?? null,
            fontSize: colDef?.fontSize ?? null,
            fontFamily: colDef?.fontFamily ?? null,
            color: colDef?.textColor ?? null,
            backgroundColor: colDef?.bgColor ?? null,
            horizontalAlign: colDef?.hAlign ?? null,
            verticalAlign: null,
            wrapText: null,
        };
        const rowFmt = this.getTableRowFormatting(displayIndex);
        const cellFmt = this.getCellFormatting(displayIndex, colId);
        for (const src of [rowFmt, cellFmt]) {
            for (const [k, v] of Object.entries(src)) {
                if (v != null) merged[k] = v;
            }
        }
        return merged;
    }

    /**
     * Set per-cell formatting for a display-indexed row + column.
     * Pass null for a property to clear it.
     * @param {number} displayIndex
     * @param {string} colId
     * @param {Object} props  e.g. { bold: true, backgroundColor: '#f00' }
     */
    setCellFormatting(displayIndex, colId, props) {
        const yRow = this.#getRowYMap(displayIndex);
        if (!yRow) return;
        this.#ydoc.transact(() => {
            const existing = yRow.get('_fmt');
            const fmt = existing ? JSON.parse(existing) : {};
            if (!fmt[colId]) fmt[colId] = {};
            for (const [k, v] of Object.entries(props)) {
                if (v == null) delete fmt[colId][k];
                else fmt[colId][k] = v;
            }
            if (Object.keys(fmt[colId]).length === 0) delete fmt[colId];
            if (Object.keys(fmt).length === 0) yRow.delete('_fmt');
            else yRow.set('_fmt', JSON.stringify(fmt));
        });
    }

    /**
     * Set per-row formatting for a display-indexed row.
     * Pass null for a property to clear it.
     * @param {number} displayIndex
     * @param {Object} props
     */
    setTableRowFormatting(displayIndex, props) {
        const yRow = this.#getRowYMap(displayIndex);
        if (!yRow) return;
        this.#ydoc.transact(() => {
            const existing = yRow.get('_rowFmt');
            const fmt = existing ? JSON.parse(existing) : {};
            for (const [k, v] of Object.entries(props)) {
                if (v == null) delete fmt[k];
                else fmt[k] = v;
            }
            if (Object.keys(fmt).length === 0) yRow.delete('_rowFmt');
            else yRow.set('_rowFmt', JSON.stringify(fmt));
        });
    }

    /**
     * Clear all per-cell formatting for a specific column in a display row.
     * @param {number} displayIndex
     * @param {string} colId
     */
    clearCellFormatting(displayIndex, colId) {
        const yRow = this.#getRowYMap(displayIndex);
        if (!yRow) return;
        const existing = yRow.get('_fmt');
        if (!existing) return;
        this.#ydoc.transact(() => {
            try {
                const fmt = JSON.parse(existing);
                delete fmt[colId];
                if (Object.keys(fmt).length === 0) yRow.delete('_fmt');
                else yRow.set('_fmt', JSON.stringify(fmt));
            } catch { /* malformed JSON — just delete */ yRow.delete('_fmt'); }
        });
    }

    renameColumn(colId, newName) {
        const defsMap = this.#getColSource().get("columnDefs");
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
        const defsMap = this.#getColSource().get("columnDefs");
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
     * Set or clear the default formula for a column.
     * Setting a formula does NOT automatically set isNonEntry — use setColumnIsNonEntry
     * separately if you want the column to be read-only.
     * @param {string} colId
     * @param {string|null} formula  null to clear
     */
    setColumnDefaultFormula(colId, formula) {
        this.updateColumnDef(colId, { defaultFormula: formula ?? null });
    }

    /**
     * Set or clear the isNonEntry (read-only) flag for a column.
     * @param {string} colId
     * @param {boolean} isNonEntry
     */
    setColumnIsNonEntry(colId, isNonEntry) {
        this.updateColumnDef(colId, { isNonEntry: !!isNonEntry });
    }

    /**
     * @deprecated Use setColumnDefaultFormula / setColumnIsNonEntry instead.
     * Kept for backward compatibility with any callers that haven't migrated.
     * @param {string} colId
     * @param {string|null} formula
     */
    setColumnFormula(colId, formula) {
        if (formula) {
            this.updateColumnDef(colId, { defaultFormula: formula });
        } else {
            this.updateColumnDef(colId, { defaultFormula: null });
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
        const src = this.#getColSource();
        const defsMap = src.get("columnDefs");
        const orderArr = src.get("columnOrder");
        if (!defsMap || !orderArr) return "";

        const colId = colDef.id ?? `col${Date.now()}`;

        this.#ydoc.transact(() => {
            const cm = new Y.Map();
            cm.set("id", colId);
            cm.set("name", colDef.name ?? "Column");
            cm.set("type", colDef.type ?? "text");
            cm.set("required", colDef.required ?? false);
            cm.set("isNonEntry", colDef.isNonEntry ?? false);
            if (colDef.defaultFormula) cm.set("defaultFormula", colDef.defaultFormula);
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
        const src = this.#getColSource();
        const defsMap = src.get("columnDefs");
        const orderArr = src.get("columnOrder");
        const rowArr = src.get("rows");
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
        const orderArr = this.#getColSource().get("columnOrder");
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

    // ─── Sort / filter ────────────────────────────────────────────────────────

    setSort(colId, dir = "asc") {
        const sortMap = this.#sourceYMap ?? this.#tableYMap;
        this.#ydoc.transact(() => {
            sortMap.set("sortColId", colId);
            sortMap.set("sortDir", dir);
        });
    }

    clearSort() {
        const sortMap = this.#sourceYMap ?? this.#tableYMap;
        this.#ydoc.transact(() => {
            sortMap.set("sortColId", null);
            sortMap.set("sortDir", "asc");
        });
    }

    setInsertSort(colId, dir = "desc") {
        const sortMap = this.#sourceYMap ?? this.#tableYMap;
        this.#ydoc.transact(() => {
            sortMap.set("insertSortColId", colId);
            sortMap.set("insertSortDir", dir);
        });
    }

    clearInsertSort() {
        const sortMap = this.#sourceYMap ?? this.#tableYMap;
        this.#ydoc.transact(() => {
            sortMap.set("insertSortColId", null);
            sortMap.set("insertSortDir", "asc");
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

    // ── Ad-hoc session filters (not persisted) ───────────────────────────────

    setFilter(colId, op, value) {
        this.filters = { ...this.filters, [colId]: { op, value } };
        this.#rebuildView(false);
        this._onFilterChange?.();
    }

    clearFilter(colId) {
        const f = { ...this.filters };
        delete f[colId];
        this.filters = f;
        this.#rebuildView(false);
        this._onFilterChange?.();
    }

    clearAllFilters() {
        this.filters = {};
        this.#rebuildView(false);
        this._onFilterChange?.();
    }

    // ── View definition filters (views only, persisted in Yjs) ───────────────
    // These are transparent — the view always shows only matching rows.
    // Managed from DocumentTablesPanel, not the ad-hoc filter UI.

    /**
     * Set a view definition filter. Persisted in Yjs. No-op for non-view tables.
     * @param {string} colId
     * @param {string} op
     * @param {any} value
     */
    setViewFilter(colId, op, value) {
        if (!this.#sourceYMap) return;
        const pf = this.#getOrCreatePersistedFilters();
        this.#ydoc.transact(() => { pf.set(colId, JSON.stringify({ op, value })); });
        this.viewDefinitionFilters = { ...this.viewDefinitionFilters, [colId]: { op, value } };
        this.#rebuildView(false);
        this._onFilterChange?.();
    }

    /**
     * Clear a single view definition filter.
     * @param {string} colId
     */
    clearViewFilter(colId) {
        if (!this.#sourceYMap) return;
        const pf = this.#tableYMap.get("persistedFilters");
        if (pf) this.#ydoc.transact(() => { pf.delete(colId); });
        const vdf = { ...this.viewDefinitionFilters };
        delete vdf[colId];
        this.viewDefinitionFilters = vdf;
        this.#rebuildView(false);
        this._onFilterChange?.();
    }

    /** Clear all view definition filters. */
    clearAllViewFilters() {
        if (!this.#sourceYMap) return;
        const pf = this.#tableYMap.get("persistedFilters");
        if (pf) this.#ydoc.transact(() => {
            for (const k of [...pf.keys()]) pf.delete(k);
        });
        this.viewDefinitionFilters = {};
        this.#rebuildView(false);
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
            if (col.isNonEntry) continue; // read-only columns never require entry
            // For required columns with a defaultFormula, the formula will fill the value
            // at insert time, so only error if there's no formula and no user value.
            if (col.required && !col.defaultFormula && (this.entryBuffer[col.id] === undefined || this.entryBuffer[col.id] === "")) {
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

        // Pre-filter to know how many rows will actually be inserted so we can assign
        // _pos values that place the first pasted row at the top of the pasted group.
        const nonBlankRows = dataRows.filter(
            srcRow => !srcRow.every(cell => !String(cell ?? '').trim())
        );
        skipped = dataRows.length - nonBlankRows.length;

        this.#ydoc.transact(() => {
            this.#initPos(rowArr);
            const basePos = Math.max(0, ...rowArr.toArray().map(r => r?.get?.('_pos') ?? 0));
            const n = nonBlankRows.length;

            nonBlankRows.forEach((srcRow, ri) => {
                const yRow = new Y.Map();
                for (let i = 0; i < srcRow.length; i++) {
                    const colDef = colMap[i];
                    if (!colDef) continue;
                    const raw = String(srcRow[i] ?? '').trim();
                    if (!raw) continue;
                    yRow.set(colDef.id, this.#parseValueForType(raw, colDef.type));
                }
                // First pasted row gets the highest _pos (top of pasted group).
                yRow.set('_pos', basePos + (n - ri) * 1000);
                rowArr.push([yRow]);
                inserted++;
            });
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

    #isTableDslFormula(formula) {
        return /\{[^}]+\}/.test(formula) || /\b(PREV|NEXT|ROWVAL|WINDOW|RUNNINGIF|RUNNINGIFS)\s*\(/i.test(formula);
    }

    getValue(displayIndex, colId) {
        const raw = this.#eval
            ? this.#eval.getValue(displayIndex, colId)
            : this.sortedFilteredRows[displayIndex]?.[colId];
        if (typeof raw === 'string' && raw.startsWith('=')) {
            if (this.#isTableDslFormula(raw) && this.#eval) {
                const result = this.#eval.evaluateFormula(raw, displayIndex);
                return result ?? raw;
            }
            if (this.#sheetFormulaEval) {
                const result = this.#sheetFormulaEval(raw);
                return result ?? raw;
            }
        }
        return raw ?? null;
    }

    getColumn(colId) {
        return this.sortedFilteredRows.map((_, i) => this.getValue(i, colId));
    }

    getRowCount() {
        return this.sortedFilteredRows.length;
    }

    // ── Full (unfiltered) row access — used by TABLE_* sheet formula functions ─
    // Filters are a display-time concept. Sheet formulas reference a table by name
    // and must always see all rows regardless of what filter any session has active.
    // Views delegate these methods to the source store — they share rows and have
    // no #allRowsEval of their own.

    getFullRowCount() {
        if (this.#sourceStore) return this.#sourceStore.getFullRowCount();
        return this.rows.length;
    }

    /** Rebuild the formula evaluator — called when an external table this one references changes. */
    invalidate() {
        this.#rebuildView();
    }

    getFullValue(rawIndex, colId) {
        if (this.#sourceStore) return this.#sourceStore.getFullValue(rawIndex, colId);
        const raw = this.#allRowsEval
            ? this.#allRowsEval.getValue(rawIndex, colId)
            : this.rows[rawIndex]?.[colId];
        if (typeof raw === 'string' && raw.startsWith('=')) {
            if (this.#isTableDslFormula(raw) && this.#allRowsEval) {
                const result = this.#allRowsEval.evaluateFormula(raw, rawIndex);
                return result ?? raw;
            }
            if (this.#sheetFormulaEval) {
                return this.#sheetFormulaEval(raw) ?? raw;
            }
        }
        return raw ?? null;
    }

    getFullColumn(colId) {
        if (this.#sourceStore) return this.#sourceStore.getFullColumn(colId);
        return this.rows.map((_, i) => this.getFullValue(i, colId));
    }

    getCumulativeSum(colId, upToDisplayIndex) {
        return this.#eval ? this.#eval.getCumulativeSum(colId, upToDisplayIndex) : 0;
    }

    evaluateFormula(formula, rowIndex) {
        return this.#eval ? this.#eval.evaluateFormula(formula, rowIndex) : null;
    }

    /**
     * Provide a callback that evaluates spreadsheet formula strings stored as
     * cell values (e.g. "=10*15" → 150, "=A1+B1" → sum of those cells).
     * Called by SpreadsheetSession after the formula engine is initialised.
     * @param {((formula: string) => any) | null} fn
     */
    setSheetFormulaEvaluator(fn) {
        this.#sheetFormulaEval = fn;
        if (this.#eval) this.#rebuildView();
    }

    /**
     * Provide a callback that resolves another table by name.
     * Enables TABLE_* cross-table functions in computed column formulas.
     * Called by DocumentTableRegistry after the store is created.
     * @param {((name: string) => any) | null} fn
     */
    setTableResolver(fn) {
        if (this.#tableResolver === fn) return;
        this.#tableResolver = fn;
        if (this.#eval) this.#rebuildView();
    }

    /**
     * Return the raw stored value for a cell without evaluating formula strings.
     * Used by editors so they receive "=10*15" rather than 150.
     * @param {number} displayIndex
     * @param {string} colId
     * @returns {any}
     */
    getRawValue(displayIndex, colId) {
        const def = this.columns.find(c => c.id === colId);
        // isNonEntry columns are never stored — no raw value to edit
        if (def?.isNonEntry) return null;
        return this.sortedFilteredRows[displayIndex]?.[colId] ?? null;
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
     * The Y.Map that owns rows, columnDefs, and columnOrder for this store.
     * For views this is the source Y.Map; for source/legacy tables it is the table's own Y.Map.
     * Used by TableManager to attach row/column change observers.
     */
    get sourceYMapForObservation() { return this.#sourceYMap ?? this.#tableYMap; }

    /**
     * True when this is a source-only table (data + schema, not displayed on grid).
     * Source-only tables are skipped in the row index and never rendered as grid cells.
     */
    get isSourceOnly() { return this.#tableYMap.get('isSourceOnly') === true; }

    /**
     * Set the visible columns for a view (replaces the visibleColumns Y.Array).
     * No-op for non-view tables.
     * @param {string[]} colIds  Ordered list of column IDs to show.
     */
    setVisibleColumns(colIds) {
        if (!this.#sourceYMap) return;
        const arr = this.#tableYMap.get("visibleColumns");
        if (!arr) return;
        this.#ydoc.transact(() => {
            if (arr.length > 0) arr.delete(0, arr.length);
            if (colIds.length > 0) arr.push(colIds);
        });
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
