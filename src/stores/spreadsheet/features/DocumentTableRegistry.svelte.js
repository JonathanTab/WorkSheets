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
import { YJS_ORIGIN } from '../yjsOrigins.js';

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
        this.tableVersion++;
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
     * sheetId for a given tableId (source or view).
     * Returns '' for document-level source tables.
     * @param {string} tableId
     * @returns {string}
     */
    getSheetId(tableId) {
        return this.#sheetOf.get(tableId) ?? '';
    }

    /**
     * The document-level source tables Y.Map (root.tableData).
     * Used by TableManager to create new source tables.
     * @returns {import('yjs').Map<any>}
     */
    getTableDataMap() {
        return this.#tableDataMap ?? this.#getOrCreateTableData();
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Rebuild formula evaluators for tables affected by row changes in `sourceTableId`.
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
        for (const store of affected) {
            if (store.columns.some(c => c.isNonEntry && c.defaultFormula)) {
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
    }
}

export default DocumentTableRegistry;
