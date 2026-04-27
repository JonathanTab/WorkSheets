/**
 * DocumentTableRegistry - Document-wide live table store cache.
 *
 * One instance per open document. Keeps one TableStore per table across ALL
 * sheets, eliminating the repeated create/destroy that getCrossSheetTable()
 * previously performed on every TABLE_* formula call.
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

import { TableStore } from './TableStore.svelte.js';

export class DocumentTableRegistry {
    /** @type {import('yjs').Doc} */
    #ydoc;

    /** @type {import('yjs').Map<any>} root spreadsheet Y.Map */
    #root;

    /** tableId → TableStore */
    #stores = new Map();

    /** tableName.toUpperCase() → tableId  (last-wins on duplicate names) */
    #nameIndex = new Map();

    /** tableId → sheetId — which sheet each table/view lives on */
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

    #addStore(sheetId, tableId, tableYMap) {
        if (this.#stores.has(tableId)) return;
        if (this.#watchedTablesMap.has(tableYMap)) return;
        this.#watchedTablesMap.add(tableYMap);

        const sourceTableId = tableYMap.get('sourceTableId') ?? null;
        const sourceTableYMap = sourceTableId
            ? this.#resolveTableYMap(sourceTableId)
            : null;

        const store = new TableStore(tableYMap, this.#ydoc, sourceTableYMap);
        this.#stores.set(tableId, store);
        this.#sheetOf.set(tableId, sheetId);
        this.#nameIndex.set((store.name ?? '').toUpperCase(), tableId);

        // Track view membership.
        if (sourceTableId) {
            // New-style view: points to a separate source table.
            if (!this.#viewsOf.has(sourceTableId)) this.#viewsOf.set(sourceTableId, new Set());
            this.#viewsOf.get(sourceTableId).add(tableId);
        } else if (!store.isSourceOnly) {
            // Legacy combined table: no separate source, the table IS its own view.
            // Register it as a view of itself so getViewsForTable() returns it.
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
            const rowObs = () => this.onTableChange?.();
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
        this.#viewsOf.delete(tableId); // also remove any set where this table was the source key
        this.tableVersion++;
    }

    #resolveTableYMap(tableId) {
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
     * All source tables across all sheets.
     * Includes:
     *   - New-style source tables (isSourceOnly: true)
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
                // Legacy combined table: the source table IS the view (same ID)
                isLegacy: viewId === sourceTableId,
            });
        }
        return result;
    }

    /**
     * sheetId for a given tableId (source or view).
     * @param {string} tableId
     * @returns {string}
     */
    getSheetId(tableId) {
        return this.#sheetOf.get(tableId) ?? '';
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

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
