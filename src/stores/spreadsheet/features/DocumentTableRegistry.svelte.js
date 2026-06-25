/**
 * DocumentTableRegistry - Document-wide live table store cache.
 *
 * One instance per open document. Keeps one TableStore per table across ALL
 * sheets, eliminating the repeated create/destroy that getCrossSheetTable()
 * previously performed on every TABLE_* formula call.
 *
 * ## Storage model
 * - Source tables (data + schema) live in `root.tableData` (document-level Y.Map).
 *   They are not tied to any specific sheet and are never rendered directly on a grid.
 * - Views live in `sheet.tableViews` (per-sheet Y.Map) and reference a source via `tableId`.
 *
 * ## Querying
 * - getById(tableId)        → live TableStore or null
 * - getByName(name)         → live TableStore or null (cross-sheet, case-insensitive)
 * - getSourceTables()       → [{tableId,sheetId,store}] — source tables only
 * - getViewsForTable(id)    → [{viewId,sheetId,store}] — views of a specific source
 *
 * ## Reactivity
 * tableVersion ($state) increments on any structural change so UI can re-derive.
 * onTableChange fires with the source table's id and the Y.YEvent[] from the deep
 * observer; SpreadsheetSession parses the events for surgical formula recalc.
 */

import * as Y from 'yjs';
import { TableStore } from './TableStore.svelte.js';
import { extractTableRefsFromColumnFormula } from './tableFormulaEval.js';
import { YJS_ORIGIN } from '../yjsOrigins.js';
import { YKeyValue } from 'y-utility/y-keyvalue';
import {
    rewriteTableRefsInFormula,
    rewriteTableRefsInDslColumn,
} from '../../../formulas/refRewriter.js';

export class DocumentTableRegistry {
    /** @type {import('yjs').Doc} */
    #ydoc;

    /** @type {import('yjs').Map<any>} root spreadsheet Y.Map */
    #root;

    /** @type {import('yjs').Map<any> | null} root.tableData */
    #tableDataMap = null;

    /** tableId → TableStore */
    #stores = new Map();

    /**
     * tableName.toUpperCase() → Set<tableId>
     *
     * Tracks ALL tables sharing a given (uppercased) name so that when the
     * "winning" table is deleted or renamed, the index can recover the next
     * candidate rather than leaving a ghost entry. getByName() returns the
     * store for the first (insertion-order) tableId in the set.
     */
    #nameIndex = new Map();

    /** tableId → sheetId — '' for global source tables */
    #sheetOf = new Map();

    /**
     * sourceTableId → Set<viewId>
     * Lets getViewsForTable() work in O(views) without scanning all stores.
     */
    #viewsOf = new Map();

    /**
     * Cross-table reference index for column formulas.
     * upperName → Set<storeId>  (stores whose column formulas reference that table)
     * Also a wildcard set for dynamic-first-arg TABLE_* calls.
     * @type {Map<string, Set<string>>}
     */
    #storesByTableRef = new Map();
    /** @type {Set<string>} */
    #wildcardRefStores = new Set();
    /**
     * Per-store snapshot of the table refs we last indexed, so we can remove
     * stale entries cleanly when a store's columns change.
     * @type {Map<string, { names: Set<string>, wildcard: boolean }>}
     */
    #refsByStore = new Map();

    /** WeakSets to guard against double-registering */
    #watchedTableDataMap = new WeakSet();
    #watchedSheets       = new WeakSet();

    /**
     * rowArr objects already given an onTableChange observer.
     * Prevents double-firing when a source table and a view share the same rowArr.
     */
    #trackedRowArrs = new WeakSet();

    /** cleanup callbacks */
    #observers = [];

    /**
     * Incremented on structural changes (tables/views added or removed).
     * Svelte components can derive from this to re-render.
     */
    tableVersion = $state(0);

    /**
     * Fired when any table's row data mutates. The callback receives:
     *   sourceTableId - the table ID whose row Y.Array changed
     *   events        - Y.YEvent[] from the deep observer
     *   rowArr        - the source Y.Array<Y.Map> that changed
     * SpreadsheetSession parses the events for surgical formula recalc.
     * @type {((info: { sourceTableId: string, events: import('yjs').YEvent<any>[], rowArr: import('yjs').Array<import('yjs').Map<any>> }) => void) | null}
     */
    onTableChange = null;

    /**
     * Fired when the set of tables (source or view) changes — i.e. a table is
     * added or removed. SpreadsheetSession uses this to dirty grid formulas
     * that reference tables by name and to recalculate.
     * @type {(() => void) | null}
     */
    onTableStructureChange = null;

    /**
     * @param {import('yjs').Map<any>} root  ydoc.getMap('spreadsheet')
     * @param {import('yjs').Doc} ydoc
     */
    constructor(root, ydoc) {
        this.#ydoc = ydoc;
        this.#root = root;
        this.#init();
    }

    // ─── Initialisation ───────────────────────────────────────────────────────

    #init() {
        // Watch document-level source tables (root.tableData).
        this.#tableDataMap = this.#getOrCreateTableData();
        this.#watchTableData(this.#tableDataMap);

        // Watch per-sheet view tables (sheet.tableViews).
        const sheetOrder = this.#root.get('sheetOrder');
        const sheetsMap  = this.#root.get('sheets');
        if (!sheetOrder || !sheetsMap) return;

        for (const sheetId of sheetOrder.toArray()) {
            const sheetYMap = sheetsMap.get(sheetId);
            if (sheetYMap) this.#watchSheet(sheetId, sheetYMap);
        }

        const orderObs = () => {
            for (const sheetId of sheetOrder.toArray()) {
                const sheetYMap = sheetsMap.get(sheetId);
                if (sheetYMap) this.#watchSheet(sheetId, sheetYMap);
            }
        };
        sheetOrder.observe(orderObs);
        this.#observers.push(() => sheetOrder.unobserve(orderObs));
    }

    /**
     * Get or create the document-level tableData map at root.tableData.
     * @returns {import('yjs').Map<any>}
     */
    #getOrCreateTableData() {
        let gmap = this.#root.get('tableData');
        if (!gmap) {
            gmap = new Y.Map();
            this.#ydoc.transact(() => { this.#root.set('tableData', gmap); }, YJS_ORIGIN.MIGRATION);
        }
        return gmap;
    }

    #watchTableData(gmap) {
        if (this.#watchedTableDataMap.has(gmap)) return;
        this.#watchedTableDataMap.add(gmap);

        gmap.forEach((tableYMap, tableId) => {
            this.#addStore(null, tableId, tableYMap);
        });

        const obs = (event) => {
            event.changes.keys.forEach((change, tableId) => {
                if (change.action === 'add') {
                    const tYMap = gmap.get(tableId);
                    if (tYMap) this.#addStore(null, tableId, tYMap);
                } else if (change.action === 'delete') {
                    this.#removeStore(tableId);
                }
            });
        };
        gmap.observe(obs);
        this.#observers.push(() => gmap.unobserve(obs));
    }

    #watchSheet(sheetId, sheetYMap) {
        if (this.#watchedSheets.has(sheetYMap)) return;
        this.#watchedSheets.add(sheetYMap);

        /** @type {import('yjs').Map<any> | null} */
        let observedViewsMap = null;

        const attachViewsMap = (viewsMap) => {
            if (!viewsMap || observedViewsMap === viewsMap) return;
            observedViewsMap = viewsMap;

            viewsMap.forEach((tableYMap, tableId) => {
                this.#addStore(sheetId, tableId, tableYMap);
            });

            const viewsObs = (event) => {
                event.changes.keys.forEach((change, tableId) => {
                    if (change.action === 'add') {
                        const tYMap = viewsMap.get(tableId);
                        if (tYMap) this.#addStore(sheetId, tableId, tYMap);
                    } else if (change.action === 'delete') {
                        this.#removeStore(tableId);
                    }
                });
            };
            viewsMap.observe(viewsObs);
            this.#observers.push(() => viewsMap.unobserve(viewsObs));
        };

        attachViewsMap(sheetYMap.get('tableViews'));

        // Catch lazy creation of tableViews (e.g. SpreadsheetSession writing it
        // after DocumentTableRegistry has already called #watchSheet).
        const sheetTopObs = (event) => {
            if (event.keysChanged?.has('tableViews')) {
                attachViewsMap(sheetYMap.get('tableViews'));
            }
        };
        sheetYMap.observe(sheetTopObs);
        this.#observers.push(() => sheetYMap.unobserve(sheetTopObs));
    }

    // ─── Store management ─────────────────────────────────────────────────────

    /**
     * @param {string | null} sheetId  null for document-level source tables
     */
    #addStore(sheetId, tableId, tableYMap) {
        if (this.#stores.has(tableId)) return;

        const sourceTableId = tableYMap.get('tableId') ?? null;
        const sourceTableYMap = sourceTableId
            ? this.#resolveTableYMap(sourceTableId)
            : null;
        const sourceStore = sourceTableId ? (this.#stores.get(sourceTableId) ?? null) : null;

        const tableResolver = (name) => this.getByName(name);
        const store = new TableStore(tableYMap, this.#ydoc, sourceTableYMap, sourceStore, tableResolver);
        // Atomic-rename rewriter: when this table is renamed via store.rename(),
        // walk every cell formula + column DSL formula in the doc and rewrite
        // TABLE_*("OldName", …) → TABLE_*("NewName", …), inside the same Yjs
        // transaction as the name set.
        store.setRenameRewriter((oldName, newName) => this.#rewriteTableRefsAcrossDoc(oldName, newName));
        this.#stores.set(tableId, store);
        this.#sheetOf.set(tableId, sheetId ?? '');
        this.#nameIndexAdd((store.name ?? '').toUpperCase(), tableId);

        // Track view membership.
        if (sourceTableId) {
            if (!this.#viewsOf.has(sourceTableId)) this.#viewsOf.set(sourceTableId, new Set());
            this.#viewsOf.get(sourceTableId).add(tableId);
        }

        // Keep name index current when the table is renamed.
        let lastObservedName = (store.name ?? '').toUpperCase();
        const nameObs = () => {
            const newName = (store.name ?? '').toUpperCase();
            if (newName === lastObservedName) return;
            this.#nameIndexRemove(lastObservedName, tableId);
            lastObservedName = newName;
            this.#nameIndexAdd(newName, tableId);
        };
        tableYMap.observe(nameObs);
        this.#observers.push(() => tableYMap.unobserve(nameObs));

        // Build / refresh the cross-table ref index for this store. Index is
        // refreshed whenever the store's columns change (defaultFormula or
        // formula edits) so cross-table dirty propagation stays accurate.
        this.#rebuildRefIndex(tableId, store);
        const colSrc = sourceTableYMap ?? tableYMap;
        const defsMap = colSrc.get('columnDefs');
        if (defsMap) {
            const colsObs = () => this.#rebuildRefIndex(tableId, store);
            defsMap.observeDeep(colsObs);
            this.#observers.push(() => defsMap.unobserveDeep(colsObs));
        }

        // Row-change → formula recalc. One observer per unique rowArr.
        // For views, effectiveSourceId points at the shared source table.
        const rowArr = (sourceTableYMap ?? tableYMap).get('rows');
        const effectiveSourceId = sourceTableId ?? tableId;
        if (rowArr && !this.#trackedRowArrs.has(rowArr)) {
            this.#trackedRowArrs.add(rowArr);
            const rowObs = (events) => {
                this.#invalidateNonEntryEvals(effectiveSourceId);
                this.onTableChange?.({ sourceTableId: effectiveSourceId, events, rowArr });
            };
            rowArr.observeDeep(rowObs);
            this.#observers.push(() => rowArr.unobserveDeep(rowObs));
        }

        this.tableVersion++;
        this.onTableStructureChange?.();
    }

    #removeStore(tableId) {
        const store = this.#stores.get(tableId);
        if (!store) return;
        store.destroy();
        this.#stores.delete(tableId);
        this.#sheetOf.delete(tableId);
        this.#nameIndexRemove((store.name ?? '').toUpperCase(), tableId);
        for (const views of this.#viewsOf.values()) views.delete(tableId);
        this.#viewsOf.delete(tableId);
        this.#removeRefIndex(tableId);
        this.tableVersion++;
        this.onTableStructureChange?.();
    }

    /**
     * Refresh the cross-table ref index for one store. Walks every column's
     * defaultFormula and formula strings, extracts TABLE_* references, and
     * updates #storesByTableRef + #wildcardRefStores.
     * @param {string} tableId
     * @param {TableStore} store
     */
    #rebuildRefIndex(tableId, store) {
        this.#removeRefIndex(tableId);
        const names = new Set();
        let wildcard = false;
        for (const col of store.columns ?? []) {
            for (const formula of [col.defaultFormula, col.formula]) {
                if (!formula) continue;
                const refs = extractTableRefsFromColumnFormula(formula);
                for (const n of refs.names) names.add(n);
                if (refs.wildcard) wildcard = true;
            }
        }
        this.#refsByStore.set(tableId, { names, wildcard });
        for (const n of names) {
            if (!this.#storesByTableRef.has(n)) this.#storesByTableRef.set(n, new Set());
            this.#storesByTableRef.get(n).add(tableId);
        }
        if (wildcard) this.#wildcardRefStores.add(tableId);
    }

    /**
     * Remove this store's entries from the cross-table ref index.
     * @param {string} tableId
     */
    #removeRefIndex(tableId) {
        const prev = this.#refsByStore.get(tableId);
        if (!prev) return;
        for (const n of prev.names) {
            const set = this.#storesByTableRef.get(n);
            if (set) {
                set.delete(tableId);
                if (set.size === 0) this.#storesByTableRef.delete(n);
            }
        }
        if (prev.wildcard) this.#wildcardRefStores.delete(tableId);
        this.#refsByStore.delete(tableId);
    }

    /**
     * Resolve a source table's Y.Map by ID from root.tableData.
     * @param {string} tableId
     * @returns {import('yjs').Map<any> | null}
     */
    #resolveTableYMap(tableId) {
        return this.#root.get('tableData')?.get(tableId) ?? null;
    }

    // ─── Public query API ─────────────────────────────────────────────────────

    /**
     * Get a TableStore by tableId. Returns null if not found.
     * @param {string} tableId
     * @returns {TableStore | null}
     */
    getById(tableId) {
        return this.#stores.get(tableId) ?? null;
    }

    #nameIndexAdd(upperName, tableId) {
        if (!upperName) return;
        if (!this.#nameIndex.has(upperName)) this.#nameIndex.set(upperName, new Set());
        this.#nameIndex.get(upperName).add(tableId);
    }

    #nameIndexRemove(upperName, tableId) {
        if (!upperName) return;
        const set = this.#nameIndex.get(upperName);
        if (!set) return;
        set.delete(tableId);
        if (set.size === 0) this.#nameIndex.delete(upperName);
    }

    /**
     * Get a TableStore by name (case-insensitive). Returns null if not found.
     * When multiple tables share a name the first-registered one is returned.
     * @param {string} name
     * @returns {TableStore | null}
     */
    getByName(name) {
        const set = this.#nameIndex.get(String(name ?? '').toUpperCase());
        if (!set) return null;
        for (const id of set) {
            const store = this.#stores.get(id);
            if (store) return store;
        }
        return null;
    }

    /**
     * All source tables across the document (those in root.tableData, not views).
     * @returns {{ tableId: string, sheetId: string, store: TableStore }[]}
     */
    getSourceTables() {
        const result = [];
        for (const [tableId, store] of this.#stores) {
            if (!store.isView) {
                result.push({ tableId, sheetId: this.#sheetOf.get(tableId) ?? '', store });
            }
        }
        return result;
    }

    /**
     * All views whose source table ID matches the given ID.
     * @param {string} sourceTableId
     * @returns {{ viewId: string, sheetId: string, store: TableStore }[]}
     */
    getViewsForTable(sourceTableId) {
        const viewIds = this.#viewsOf.get(sourceTableId);
        if (!viewIds) return [];
        const result = [];
        for (const viewId of viewIds) {
            const store = this.#stores.get(viewId);
            if (store) result.push({ viewId, sheetId: this.#sheetOf.get(viewId) ?? '', store });
        }
        return result;
    }

    /**
     * Every known table name (uppercased) currently registered. Used by
     * SpreadsheetSession to mark all by-name formula deps dirty on
     * structural change.
     * @returns {string[]}
     */
    getAllTableNames() {
        return Array.from(this.#nameIndex.keys());
    }

    /**
     * sheetId for a given tableId (source or view).
     * Returns '' for document-level source tables.
     * @param {string} tableId
     * @returns {string}
     */
    getSheetId(tableId) {
        return this.#sheetOf.get(tableId) ?? '';
    }

    /**
     * Resolve any table/view id to its source table id, plus the view id if
     * the input id was itself a view. Used by UI entry points (grid outline
     * buttons, context menu, "Configure" actions) so that opening config
     * from a view always lands on the right source table — and, when
     * relevant, the right view — instead of silently falling back to
     * whichever table happens to be listed first.
     * @param {string | null} id
     * @returns {{ sourceId: string | null, viewId: string | null }}
     */
    resolveSourceId(id) {
        if (!id) return { sourceId: null, viewId: null };
        const store = this.#stores.get(id);
        if (store?.isView) return { sourceId: store.sourceTableId, viewId: id };
        return { sourceId: id, viewId: null };
    }

    /**
     * The document-level source tables Y.Map (root.tableData).
     * Used by TableManager to create new source tables.
     * @returns {import('yjs').Map<any>}
     */
    getTableDataMap() {
        return this.#tableDataMap ?? this.#getOrCreateTableData();
    }

    /**
     * Walk every formula in every sheet (cell values + table column DSL
     * formulas) and rewrite TABLE_*("oldName", …) → TABLE_*("newName", …).
     * Must be called inside a Yjs transaction (TableStore.rename does that
     * via #transact, so all writes — including the name set — coalesce into
     * one atomic update).
     * @param {string} oldName
     * @param {string} newName
     */
    #rewriteTableRefsAcrossDoc(oldName, newName) {
        if (!oldName || !newName || oldName === newName) return;

        const sheetsMap = this.#root?.get('sheets');
        sheetsMap?.forEach((s) => {
            const cvArr = s.get('cellValues');
            if (!cvArr) return;
            const cvKV = new YKeyValue(cvArr);
            for (const [key, { val: data }] of cvKV.map) {
                const v = data?.v;
                if (typeof v !== 'string' || !v.startsWith('=')) continue;
                const rewritten = rewriteTableRefsInFormula(v, oldName, newName);
                if (rewritten !== v) cvKV.set(key, { ...data, v: rewritten });
            }
        });

        // Column DSL formulas: source tables (root.tableData) own the column defs.
        const tableData = this.#root?.get('tableData');
        tableData?.forEach((tableYMap) => {
            const defsMap = tableYMap.get('columnDefs');
            if (!defsMap) return;
            defsMap.forEach((colYMap) => {
                for (const field of ['defaultFormula', 'formula']) {
                    const cur = colYMap.get(field);
                    if (typeof cur !== 'string' || !cur) continue;
                    const next = rewriteTableRefsInDslColumn(cur, oldName, newName);
                    if (next !== cur) colYMap.set(field, next);
                }
            });
        });
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Rebuild formula evaluators for stores affected by row changes in
     * `sourceTableId`. Includes:
     *   (a) the source table itself
     *   (b) any view of the source table
     *   (c) any OTHER store whose column formulas reference the source table
     *       by name via TABLE_*(...)  — these have a stale computed cache
     *       until their #rebuildView fires
     *   (d) any store with at least one TABLE_*(<dynamic>, …) column formula
     *       (wildcard — we can't know if it references this table without
     *       evaluating, so be safe and invalidate)
     * @param {string} sourceTableId
     */
    #invalidateNonEntryEvals(sourceTableId) {
        const affected = new Set();
        const src = this.#stores.get(sourceTableId);
        if (src) affected.add(src);
        const viewIds = this.#viewsOf.get(sourceTableId);
        if (viewIds) {
            for (const id of viewIds) {
                const s = this.#stores.get(id);
                if (s) affected.add(s);
            }
        }

        // Cross-table dependents: stores whose column formulas mention this
        // source table by name (or use a dynamic name we can't resolve).
        if (src) {
            const upperName = (src.name ?? '').toUpperCase();
            const byName = this.#storesByTableRef.get(upperName);
            if (byName) {
                for (const id of byName) {
                    const s = this.#stores.get(id);
                    if (s) affected.add(s);
                }
            }
        }
        for (const id of this.#wildcardRefStores) {
            const s = this.#stores.get(id);
            if (s) affected.add(s);
        }

        for (const store of affected) {
            // Any column whose value can change with row data: isNonEntry
            // formulas (never stored), or defaultFormulas (computed value is
            // shown when the stored cell is empty).
            if (store.columns.some(c => (c.isNonEntry && (c.defaultFormula || c.formula)) || c.defaultFormula)) {
                store.invalidate();
            }
        }
    }

    destroy() {
        for (const cleanup of this.#observers) cleanup();
        this.#observers = [];
        for (const store of this.#stores.values()) store.destroy();
        this.#stores.clear();
        this.#nameIndex.clear();
        this.#sheetOf.clear();
        this.#viewsOf.clear();
        this.#storesByTableRef.clear();
        this.#wildcardRefStores.clear();
        this.#refsByStore.clear();
    }
}

export default DocumentTableRegistry;
