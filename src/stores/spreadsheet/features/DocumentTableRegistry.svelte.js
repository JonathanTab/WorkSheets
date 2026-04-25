/**
 * DocumentTableRegistry - Document-wide live table store cache.
 *
 * Keeps one TableStore instance per table across ALL sheets in the document,
 * eliminating the repeated create/destroy cycle that getCrossSheetTable() used
 * to perform on every call.
 *
 * ## Why this exists
 * Previously, cross-sheet TABLE_* formula functions (TABLE_SUM, TABLE_FILTERCOL,
 * etc.) called getCrossSheetTable() which spun up a temporary TableStore, snapped
 * all column values (evaluating formula columns), then destroyed the store.
 * For large tables or many formula cells this was O(rows × columns) per call.
 *
 * The registry maintains live stores for every table. Formula functions get the
 * same reactive TableStore that the active-sheet TableManager uses — one object,
 * one Yjs observer set.
 *
 * ## Cross-sheet reactivity
 * When any table (on any sheet) changes its row data, the registry fires
 * onTableChange(). SpreadsheetSession wires this to
 * formulaEngine.recalculateTableDependents() so TABLE_* cells in the active
 * sheet update automatically even when the referenced table is on another sheet.
 *
 * ## Lifecycle
 * One instance per open document. Created before TableManager so the manager can
 * borrow stores instead of owning them. Destroyed when the document is unloaded.
 *
 * ## Ownership
 * The registry owns all TableStore instances. TableManager borrows (references)
 * them. TableManager.destroy() must NOT call store.destroy() for registry stores.
 */

import { TableStore } from './TableStore.svelte.js';

export class DocumentTableRegistry {
    /** @type {import('yjs').Doc} */
    #ydoc;

    /** @type {import('yjs').Map} root spreadsheet Y.Map */
    #root;

    /** tableId → TableStore */
    #stores = new Map();

    /** tableName.toUpperCase() → tableId  (last-wins on duplicate names) */
    #nameIndex = new Map();

    /** Y.Map objects we've already attached table-level observers to */
    #watchedTablesMap = new WeakSet();

    /** Set of sheet Y.Maps we've already attached observers to */
    #watchedSheets = new WeakSet();

    /** rowArr Y.Array objects already tracked for onTableChange — avoids double-firing
     *  when both a source table and a view of it are registered (they share the same rowArr). */
    #trackedRowArrs = new WeakSet();

    /** cleanup callbacks (unobserve fns) */
    #observers = [];

    /**
     * Called whenever any table's row data changes.
     * SpreadsheetSession wires this to trigger formula recalculation.
     * @type {(() => void) | null}
     */
    onTableChange = null;

    /**
     * @param {import('yjs').Map} root  ydoc.getMap('spreadsheet')
     * @param {import('yjs').Doc}  ydoc
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

        // First pass: load all existing tables from all sheets
        for (const sheetId of sheetOrder.toArray()) {
            const sheetYMap = sheetsMap.get(sheetId);
            if (sheetYMap) this.#watchSheet(sheetYMap);
        }

        // Watch for sheets being added (new sheets or late WS sync)
        const orderObs = () => {
            for (const sheetId of sheetOrder.toArray()) {
                const sheetYMap = sheetsMap.get(sheetId);
                if (sheetYMap) this.#watchSheet(sheetYMap);
            }
        };
        sheetOrder.observe(orderObs);
        this.#observers.push(() => sheetOrder.unobserve(orderObs));
    }

    #watchSheet(sheetYMap) {
        if (this.#watchedSheets.has(sheetYMap)) return;
        this.#watchedSheets.add(sheetYMap);

        const tablesMap = sheetYMap.get('tables');
        if (!tablesMap) return;

        // Load existing tables
        tablesMap.forEach((tableYMap, tableId) => {
            this.#addStore(tableId, tableYMap);
        });

        // Watch for additions / deletions
        const tablesObs = (event) => {
            event.changes.keys.forEach((change, tableId) => {
                if (change.action === 'add') {
                    const tableYMap = tablesMap.get(tableId);
                    if (tableYMap) this.#addStore(tableId, tableYMap);
                } else if (change.action === 'delete') {
                    this.#removeStore(tableId);
                }
            });
        };
        tablesMap.observe(tablesObs);
        this.#observers.push(() => tablesMap.unobserve(tablesObs));
    }

    // ─── Store management ─────────────────────────────────────────────────────

    #addStore(tableId, tableYMap) {
        if (this.#stores.has(tableId)) return;
        if (this.#watchedTablesMap.has(tableYMap)) return;
        this.#watchedTablesMap.add(tableYMap);

        // Resolve source Y.Map for view tables (sourceTableId present)
        const sourceTableId = tableYMap.get('sourceTableId');
        let sourceTableYMap = null;
        if (sourceTableId) {
            sourceTableYMap = this.#resolveTableYMap(sourceTableId);
        }

        const store = new TableStore(tableYMap, this.#ydoc, sourceTableYMap);
        this.#stores.set(tableId, store);
        this.#nameIndex.set((store.name ?? '').toUpperCase(), tableId);

        // Track name changes so the index stays current
        const nameObs = () => {
            for (const [k, id] of this.#nameIndex) {
                if (id === tableId) { this.#nameIndex.delete(k); break; }
            }
            this.#nameIndex.set((store.name ?? '').toUpperCase(), tableId);
        };
        tableYMap.observe(nameObs);
        this.#observers.push(() => tableYMap.unobserve(nameObs));

        // Notify formula engine when row data changes on any sheet.
        // Use the source rowArr for views (same object as the source table's rowArr),
        // but only attach one observer per rowArr instance to avoid double-firing.
        const rowArr = (sourceTableYMap ?? tableYMap).get('rows');
        if (rowArr && !this.#trackedRowArrs.has(rowArr)) {
            this.#trackedRowArrs.add(rowArr);
            const rowObs = () => this.onTableChange?.();
            rowArr.observeDeep(rowObs);
            this.#observers.push(() => rowArr.unobserveDeep(rowObs));
        }
    }

    #removeStore(tableId) {
        const store = this.#stores.get(tableId);
        if (!store) return;
        store.destroy();
        this.#stores.delete(tableId);
        for (const [k, id] of this.#nameIndex) {
            if (id === tableId) { this.#nameIndex.delete(k); break; }
        }
    }

    /**
     * Navigate the Yjs doc to find a table's Y.Map by its tableId.
     * Searches all sheets.
     * @param {string} tableId
     * @returns {import('yjs').Map | null}
     */
    #resolveTableYMap(tableId) {
        const sheetOrder = this.#root.get('sheetOrder');
        const sheetsMap  = this.#root.get('sheets');
        if (!sheetOrder || !sheetsMap) return null;
        for (const sheetId of sheetOrder.toArray()) {
            const sheetYMap  = sheetsMap.get(sheetId);
            const tablesMap  = sheetYMap?.get('tables');
            if (!tablesMap) continue;
            const tableYMap  = tablesMap.get(tableId);
            if (tableYMap) return tableYMap;
        }
        return null;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Get a TableStore by its tableId. Returns null if not found.
     * @param {string} tableId
     * @returns {TableStore | null}
     */
    getById(tableId) {
        return this.#stores.get(tableId) ?? null;
    }

    /**
     * Get a TableStore by table name (case-insensitive). Returns null if not found.
     * When two tables share a name across sheets, the last-registered one wins.
     * @param {string} name
     * @returns {TableStore | null}
     */
    getByName(name) {
        const id = this.#nameIndex.get(String(name ?? '').toUpperCase());
        return id ? (this.#stores.get(id) ?? null) : null;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    destroy() {
        for (const cleanup of this.#observers) cleanup();
        this.#observers = [];
        for (const store of this.#stores.values()) store.destroy();
        this.#stores.clear();
        this.#nameIndex.clear();
    }
}

export default DocumentTableRegistry;
