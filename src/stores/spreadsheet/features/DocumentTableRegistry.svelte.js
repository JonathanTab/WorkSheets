/**
 * DocumentTableRegistry - Document-wide live table store cache.
 *
 * One instance per open document. Keeps one TableStore per table across ALL
 * sheets, eliminating the repeated create/destroy that getCrossSheetTable()
 * previously performed on every TABLE_* formula call.
 *
 * ## Storage model
 * - Source tables (data + schema, isSourceOnly) live in `root.tables` (document-level Y.Map).
 *   They are not tied to any specific sheet.
 * - Views live in `sheet.tables` (per-sheet Y.Map) and reference a source via `sourceTableId`.
 * - Legacy tables (no isSourceOnly, no sourceTableId) are migrated on first load:
 *   the data is moved to `root.tables` and a view entry is written into `sheet.tables`.
 *
 * ## Querying
 * - getById(tableId)        → live TableStore or null
 * - getByName(name)         → live TableStore or null (cross-sheet, case-insensitive)
 * - getSourceTables()       → [{tableId,sheetId,store}] — non-view tables only
 * - getViewsForTable(id)    → [{viewId,sheetId,store}] — views of a specific table
 *
 * ## Reactivity
 * tableVersion ($state) increments on any structural change so UI can re-derive.
 * onTableChange fires when any table's row data changes → wired to formula recalc.
 */

import * as Y from 'yjs';
import { TableStore } from './TableStore.svelte.js';
import { YJS_ORIGIN } from '../yjsOrigins.js';

export class DocumentTableRegistry {
    /** @type {import('yjs').Doc} */
    #ydoc;

    /** @type {import('yjs').Map<any>} root spreadsheet Y.Map */
    #root;

    /** @type {import('yjs').Map<any> | null} document-level source tables map */
    #globalTablesMap = null;

    /** tableId → TableStore */
    #stores = new Map();

    /** tableName.toUpperCase() → tableId  (last-wins on duplicate names) */
    #nameIndex = new Map();

    /** tableId → sheetId — which sheet each view lives on; '' for global sources */
    #sheetOf = new Map();

    /**
     * sourceTableId → Set<viewId>
     * Lets getViewsForTable() work in O(views) without scanning all stores.
     */
    #viewsOf = new Map();

    /** WeakSets to guard against double-registering */
    #watchedTablesMap = new WeakSet();
    #watchedSheets    = new WeakSet();

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
     * Fired when any table's row data mutates.
     * SpreadsheetSession wires this to formulaEngine.recalculateTableDependents().
     * @type {(() => void) | null}
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
        // Run migration first (converts legacy tables, moves isSourceOnly to root.tables)
        // before setting up any observers so stores see the final state.
        this.#migrate();

        // Watch document-level source tables
        this.#globalTablesMap = this.#getOrCreateGlobalTables();
        this.#watchGlobalTables(this.#globalTablesMap);

        // Watch per-sheet tables (views only after migration)
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
     * Get or create the document-level tables map at root.tables.
     * @returns {import('yjs').Map<any>}
     */
    #getOrCreateGlobalTables() {
        let gmap = this.#root.get('tables');
        if (!gmap) {
            gmap = new Y.Map();
            this.#ydoc.transact(() => { this.#root.set('tables', gmap); }, YJS_ORIGIN.MIGRATION);
        }
        return gmap;
    }

    /**
     * Migrate legacy tables and isSourceOnly-in-sheet tables to root.tables.
     * Runs once at init inside a Yjs transaction before any observers are attached.
     */
    #migrate() {
        const sheetOrder = this.#root.get('sheetOrder');
        const sheetsMap  = this.#root.get('sheets');
        if (!sheetOrder || !sheetsMap) return;

        // Ensure root.tables exists — must be inside a transaction
        let globalTables = this.#root.get('tables');
        if (!globalTables) {
            globalTables = new Y.Map();
            this.#ydoc.transact(() => { this.#root.set('tables', globalTables); }, YJS_ORIGIN.MIGRATION);
        }

        this.#ydoc.transact(() => {
            for (const sheetId of sheetOrder.toArray()) {
                const sheetYMap = sheetsMap.get(sheetId);
                const tablesMap = sheetYMap?.get('tables');
                if (!tablesMap) continue;

                /** @type {[string, import('yjs').Map<any>][]} */
                const entries = [];
                tablesMap.forEach((tableYMap, tableId) => entries.push([tableId, tableYMap]));

                for (const [tableId, tableYMap] of entries) {
                    const isSourceOnly  = tableYMap.get('isSourceOnly') === true;
                    const sourceTableId = tableYMap.get('sourceTableId');

                    if (sourceTableId) {
                        // Already a proper view — no migration needed.
                        continue;
                    }

                    if (isSourceOnly) {
                        // Source table in sheet.tables → move to root.tables.
                        if (globalTables.has(tableId)) continue; // already migrated
                        const src = this.#cloneSourceYMap(tableYMap);
                        globalTables.set(tableId, src);
                        tablesMap.delete(tableId);
                    } else {
                        // Legacy combined table → split into source + view.
                        if (globalTables.has(tableId)) continue; // already migrated

                        const sourceId = tableId;
                        const viewId   = `view-${tableId}`;

                        // Source: data + schema in root.tables
                        const src = this.#cloneSourceYMap(tableYMap);
                        globalTables.set(sourceId, src);

                        // View: positioning + sourceTableId in sheet.tables
                        const vm = new Y.Map();
                        vm.set('id', viewId);
                        vm.set('name', tableYMap.get('name') ?? '');
                        vm.set('mode', 'inline');
                        vm.set('startRow', tableYMap.get('startRow') ?? 0);
                        vm.set('startCol', tableYMap.get('startCol') ?? 0);
                        vm.set('sortColId', null);
                        vm.set('sortDir', 'asc');
                        vm.set('sourceTableId', sourceId);
                        vm.set('visibleColumns', new Y.Array()); // [] = show all
                        // Copy any persisted filters (legacy tables may not have them)
                        const legacyPF = tableYMap.get('persistedFilters');
                        const pf = new Y.Map();
                        if (legacyPF) legacyPF.forEach((v, k) => pf.set(k, v));
                        vm.set('persistedFilters', pf);
                        tablesMap.set(viewId, vm);

                        // Remove legacy entry
                        tablesMap.delete(tableId);
                    }
                }
            }
        }, YJS_ORIGIN.MIGRATION);
    }

    /**
     * Deep-copy a source/legacy table Y.Map into a new Y.Map suitable for root.tables.
     * Copies scalar fields, columnDefs, columnOrder, and rows.
     * @param {import('yjs').Map<any>} tableYMap
     * @returns {import('yjs').Map<any>}
     */
    #cloneSourceYMap(tableYMap) {
        const src = new Y.Map();
        // Scalar fields
        for (const k of ['id', 'name', 'sortColId', 'sortDir', 'insertSortColId', 'insertSortDir']) {
            const v = tableYMap.get(k);
            if (v !== undefined) src.set(k, v);
        }
        src.set('isSourceOnly', true);

        // columnDefs: Y.Map<colId → Y.Map>
        const srcDefs = tableYMap.get('columnDefs');
        const newDefs = new Y.Map();
        if (srcDefs) {
            srcDefs.forEach((colMap, colId) => {
                const newCol = new Y.Map();
                if (colMap?.forEach) colMap.forEach((v, k) => newCol.set(k, v));
                newDefs.set(colId, newCol);
            });
        }
        src.set('columnDefs', newDefs);

        // columnOrder: Y.Array<string>
        const srcOrder = tableYMap.get('columnOrder');
        const newOrder = new Y.Array();
        if (srcOrder?.length) newOrder.push(srcOrder.toArray());
        src.set('columnOrder', newOrder);

        // rows: Y.Array<Y.Map>
        const srcRows = tableYMap.get('rows');
        const newRows = new Y.Array();
        if (srcRows?.length) {
            const rowMaps = srcRows.toArray().map(rowMap => {
                const nr = new Y.Map();
                if (rowMap?.forEach) rowMap.forEach((v, k) => nr.set(k, v));
                return nr;
            });
            if (rowMaps.length) newRows.push(rowMaps);
        }
        src.set('rows', newRows);

        // filters (reserved, carry along as empty)
        src.set('filters', new Y.Map());

        return src;
    }

    #watchGlobalTables(gmap) {
        if (this.#watchedTablesMap.has(gmap)) return;
        this.#watchedTablesMap.add(gmap);

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

        const tablesMap = sheetYMap.get('tables');
        if (!tablesMap) return;

        tablesMap.forEach((tableYMap, tableId) => {
            this.#addStore(sheetId, tableId, tableYMap);
        });

        const tablesObs = (event) => {
            event.changes.keys.forEach((change, tableId) => {
                if (change.action === 'add') {
                    const tYMap = tablesMap.get(tableId);
                    if (tYMap) this.#addStore(sheetId, tableId, tYMap);
                } else if (change.action === 'delete') {
                    this.#removeStore(tableId);
                }
            });
        };
        tablesMap.observe(tablesObs);
        this.#observers.push(() => tablesMap.unobserve(tablesObs));
    }

    // ─── Store management ─────────────────────────────────────────────────────

    /**
     * @param {string | null} sheetId  null for document-level source tables
     */
    #addStore(sheetId, tableId, tableYMap) {
        if (this.#stores.has(tableId)) return;

        const sourceTableId = tableYMap.get('sourceTableId') ?? null;
        const sourceTableYMap = sourceTableId
            ? this.#resolveTableYMap(sourceTableId)
            : null;
        // Pass the live source store so the view can borrow rows/allColumns directly
        // instead of re-reading and re-parsing from Yjs on every change.
        const sourceStore = sourceTableId ? (this.#stores.get(sourceTableId) ?? null) : null;

        const tableResolver = (name) => this.getByName(name);
        const store = new TableStore(tableYMap, this.#ydoc, sourceTableYMap, sourceStore, tableResolver);
        this.#stores.set(tableId, store);
        this.#sheetOf.set(tableId, sheetId ?? '');
        this.#nameIndex.set((store.name ?? '').toUpperCase(), tableId);

        // Track view membership.
        if (sourceTableId) {
            // New-style view: points to a separate source table.
            if (!this.#viewsOf.has(sourceTableId)) this.#viewsOf.set(sourceTableId, new Set());
            this.#viewsOf.get(sourceTableId).add(tableId);
        } else if (!store.isSourceOnly) {
            // Legacy combined table (shouldn't appear after migration, but handle defensively).
            if (!this.#viewsOf.has(tableId)) this.#viewsOf.set(tableId, new Set());
            this.#viewsOf.get(tableId).add(tableId);
        }

        // Keep name index current
        const nameObs = () => {
            for (const [k, id] of this.#nameIndex) {
                if (id === tableId) { this.#nameIndex.delete(k); break; }
            }
            this.#nameIndex.set((store.name ?? '').toUpperCase(), tableId);
        };
        tableYMap.observe(nameObs);
        this.#observers.push(() => tableYMap.unobserve(nameObs));

        // Row-change → formula recalc (one observer per unique rowArr)
        const rowArr = (sourceTableYMap ?? tableYMap).get('rows');
        if (rowArr && !this.#trackedRowArrs.has(rowArr)) {
            this.#trackedRowArrs.add(rowArr);
            const rowObs = () => {
                this.#invalidateNonEntryEvals();
                this.onTableChange?.();
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
        for (const [k, id] of this.#nameIndex) {
            if (id === tableId) { this.#nameIndex.delete(k); break; }
        }
        // Remove from view membership index (covers both views-of-others and self-referential legacy)
        for (const views of this.#viewsOf.values()) views.delete(tableId);
        this.#viewsOf.delete(tableId);
        this.tableVersion++;
    }

    /**
     * Resolve a source table's Y.Map by ID.
     * Checks root.tables first, then falls back to scanning sheet tables (backward compat).
     * @param {string} tableId
     * @returns {import('yjs').Map<any> | null}
     */
    #resolveTableYMap(tableId) {
        // Check document-level tables first
        const globalTables = this.#root.get('tables');
        if (globalTables) {
            const tYMap = globalTables.get(tableId);
            if (tYMap) return tYMap;
        }
        // Fallback: scan per-sheet tables (for any pre-migration sources)
        const sheetOrder = this.#root.get('sheetOrder');
        const sheetsMap  = this.#root.get('sheets');
        if (!sheetOrder || !sheetsMap) return null;
        for (const sheetId of sheetOrder.toArray()) {
            const sheetYMap = sheetsMap.get(sheetId);
            const tablesMap = sheetYMap?.get('tables');
            if (!tablesMap) continue;
            const tYMap = tablesMap.get(tableId);
            if (tYMap) return tYMap;
        }
        return null;
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

    /**
     * Get a TableStore by name (case-insensitive). Returns null if not found.
     * @param {string} name
     * @returns {TableStore | null}
     */
    getByName(name) {
        const id = this.#nameIndex.get(String(name ?? '').toUpperCase());
        return id ? (this.#stores.get(id) ?? null) : null;
    }

    /**
     * All source tables across the document.
     * Includes:
     *   - Document-level source tables (isSourceOnly: true in root.tables)
     *   - Legacy tables that are their own source+view (no isSourceOnly, no sourceTableId)
     * @returns {{ tableId: string, sheetId: string, store: TableStore }[]}
     */
    getSourceTables() {
        const result = [];
        for (const [tableId, store] of this.#stores) {
            if (store.isSourceOnly || !store.isView) {
                result.push({ tableId, sheetId: this.#sheetOf.get(tableId) ?? '', store });
            }
        }
        return result;
    }

    /**
     * All views whose sourceTableId matches the given table.
     * For legacy combined tables (no isSourceOnly, no sourceTableId), returns the
     * table itself as a single self-referential view with `isLegacy: true`.
     * @param {string} sourceTableId
     * @returns {{ viewId: string, sheetId: string, store: TableStore, isLegacy: boolean }[]}
     */
    getViewsForTable(sourceTableId) {
        const viewIds = this.#viewsOf.get(sourceTableId);
        if (!viewIds) return [];
        const result = [];
        for (const viewId of viewIds) {
            const store = this.#stores.get(viewId);
            if (store) result.push({
                viewId,
                sheetId: this.#sheetOf.get(viewId) ?? '',
                store,
                isLegacy: viewId === sourceTableId,
            });
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
     * The document-level source tables Y.Map (root.tables).
     * Used by TableManager to create new source tables.
     * @returns {import('yjs').Map<any>}
     */
    getGlobalTablesMap() {
        return this.#globalTablesMap ?? this.#getOrCreateGlobalTables();
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /** Rebuild formula evaluators for all tables that have isNonEntry formula columns. */
    #invalidateNonEntryEvals() {
        for (const store of this.#stores.values()) {
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
