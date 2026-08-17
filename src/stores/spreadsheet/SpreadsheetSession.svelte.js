/**
 * SpreadsheetSession - Main spreadsheet document session
 *
 * Manages a single spreadsheet document session with reactive state.
 * Uses Svelte 5 runes for reactivity.
 *
 * ## Key Principles
 * 1. Yjs is the ONLY source of truth for document data
 * 2. UI state (selection, scroll) is local and NOT stored in Yjs
 * 3. Computed values (formulas) are derived locally, never synced
 * 4. All mutations go through Yjs transactions for collaboration
 * 5. No version counters - Svelte 5 fine-grained reactivity handles updates
 * 6. Single `v` field stores value OR formula (formulas start with "=")
 */
import * as Y from 'yjs';
import { log } from '../../util/log.js';
import { YJS_ORIGIN } from './yjsOrigins.js';
import { storage } from '../storage.js';
import { authStore } from '../authStore.js';
import { get } from 'svelte/store';
import { SheetStore } from './SheetStore.svelte.js';
import { spreadsheetSchema, spreadsheetAppSchema, createSheetYMap, initializeDocument } from './schema.js';
import { prepareDocForUse } from '../../lib/FileRegistry/yjsDocLifecycle.js';
import { SCHEMA_VERSION, META_KEYS, CELL_KEYS } from './constants.js';
import { APP_SHEETS } from '../../lib/appTypes.js';
import { YKeyValue } from 'y-utility/y-keyvalue';
import { FormulaEngine } from '../../formulas/FormulaEngine.svelte.js';
import { FormulaError } from '../../formulas/functions.js';
import { ExternalDocManager } from './ExternalDocManager.js';
import {
    rewriteSheetRefsInFormula,
    rewriteTableRefsInFormula,
    rewriteSheetRefsInDslColumn,
    rewriteTableRefsInDslColumn,
} from '../../formulas/refRewriter.js';
import { SheetRenderContext } from './features/SheetRenderContext.svelte.js';
import { TableManager } from './features/TableManager.svelte.js';
import { DocumentTableRegistry } from './features/DocumentTableRegistry.svelte.js';
import { RepeaterEngine } from './features/RepeaterEngine.svelte.js';
// NOTE: ./index.js re-imports from this file, but ES module live bindings
// resolve the cycle — the binding is defined by the time the structural-op
// wrappers below are actually called.
import { selectionState } from './index.js';

/**
 * Walk the Y.YEvents fired on a table's row Y.Array and classify what changed.
 * Returns:
 *   structural  - rows were added/deleted, or a row's _pos (sort key) changed
 *   cellChanges - per-cell value updates: (rawIndex, colId) pairs where
 *                 rawIndex is the position in the source row Y.Array
 * Formatting-only changes (_fmt, _rowFmt) are ignored — they don't affect formulas.
 *
 * The rawIndex comes from `event.path[0]`; we deliberately do NOT capture
 * `event.target` (the row Y.Map) because TableStore.sortedFilteredRows stores
 * plain-object snapshots (from `.toJSON()`), not the Y.Maps themselves —
 * an identity-based lookup against the Y.Map would always miss.
 *
 * @param {import('yjs').YEvent<any>[]} events
 * @param {import('yjs').Array<any>} rowArr
 * @returns {{ structural: boolean, cellChanges: Array<{ rawIndex: number, colId: string }> }}
 */
function classifyTableRowEvents(events, rowArr) {
    let structural = false;
    const cellChanges = [];
    for (const e of events) {
        if (e.target === rowArr) {
            if (e.changes?.added?.size > 0 || e.changes?.deleted?.size > 0) structural = true;
            continue;
        }
        // Direct row Y.Map change has path = [rowIndex] (number); nested (_fmt, …) is deeper.
        if (e.path?.length !== 1 || typeof e.path[0] !== 'number' || !e.changes?.keys) continue;
        const rawIndex = e.path[0];
        for (const [key] of e.changes.keys) {
            if (key === '_fmt' || key === '_rowFmt') continue;
            if (key === '_pos') { structural = true; continue; }
            cellChanges.push({ rawIndex, colId: key });
        }
    }
    return { structural, cellChanges };
}

/**
 * SpreadsheetSession class
 *
 * Manages a single spreadsheet document session with reactive state.
 */
export class SpreadsheetSession {
    /** @type {string | null} */
    docId = $state(null);

    /** @type {Y.Doc | null} */
    ydoc = $state.raw(null);

    /** @type {Y.Map | null} */
    root = $state.raw(null);

    /** @type {string | null} */
    activeSheetId = $state(null);

    /** @type {boolean} */
    isLoading = $state(false);

    /** @type {string | null} */
    error = $state(null);

    /**
     * True when the loaded doc was written under a schema version newer
     * than this client's SCHEMA_VERSION. The UI surfaces a banner and
     * mutation paths consult this to block writes.
     * @type {boolean}
     */
    readOnly = $state(false);

    /**
     * Reason for read-only mode, suitable for displaying in the UI.
     * @type {string | null}
     */
    readOnlyReason = $state(null);

    /**
     * Transient notices the UI should surface as a dismissible banner.
     * Populated by lifecycle events (auto-init recovery, missed rotation).
     * @type {Array<{ id: string, severity: 'info'|'warn', message: string }>}
     */
    notices = $state([]);

    /** @type {Function | null} Cleanup for missed-rotation listener */
    #cleanupMissedRotation = null;

    /** @type {Y.UndoManager | null} */
    undoManager = $state.raw(null);

    /** @type {Object | null} */
    awareness = $state.raw(null);

    /** @type {Array} Remote user selections (reactive for UI) */
    remoteSelections = $state([]);

    /** @type {Function | null} Cleanup for awareness observer */
    #cleanupAwarenessObserver = null;

    /** @type {SheetStore | null} */
    activeSheetStore = $state.raw(null);

    /** @type {FormulaEngine | null} */
    formulaEngine = $state.raw(null);

    /** @type {Function | null} Cleanup for Yjs observer */
    #cleanupObserver = null;

    /**
     * Per-view-store memo of the last seen data-row count.
     * Lets the table change handler dirty cells that USED to be table data but
     * are no longer (e.g. after a row delete) — we'd otherwise lose track of the
     * old extent. WeakMap keyed by view store so entries die with the view.
     * @type {WeakMap<import('./features/TableStore.svelte.js').TableStore, number>}
     */
    #lastTableDataExtent = new WeakMap();

    /** @type {Function | null} Cleanup for formula engine observer */
    #cleanupFormulaObserver = null;

    /** @type {SheetRenderContext | null} */
    renderContext = $state.raw(null);

    /** Callback registered by Grid to trigger a canvas repaint from outside. */
    requestGridRepaint = null;

    /** @type {TableManager | null} */
    tableManager = $state.raw(null);

    /**
     * Document-level live cache of all table stores across all sheets.
     * Created once per document load. TableManager borrows stores from here.
     * @type {DocumentTableRegistry | null}
     */
    tableRegistry = $state.raw(null);

    /** @type {RepeaterEngine | null} */
    repeaterEngine = $state.raw(null);

    /** @type {Function | null} Cleanup for undo manager observer */
    #cleanupUndoObserver = null;

    /** @type {ExternalDocManager | null} Manages external doc loading for IMPORTRANGE */
    #externalDocManager = null;

    /**
     * Per-sheet YKeyValue cache for cross-sheet formula reads. Creating a
     * fresh YKeyValue per cell read (which is what SUM(Sheet2!A1:A1000) would
     * trigger) is expensive — y-utility's YKeyValue keeps internal state, and
     * its construction walks the Y.Array. One stable wrapper per sheet
     * lifetime is the right cost model.
     * @type {Map<string, import('y-utility/y-keyvalue').YKeyValue<any>>}
     */
    #crossSheetKVCache = new Map();

    /** @type {Promise | null} Lock for preventing concurrent loads */
    #loadPromise = null;

    /**
     * LRU cache of sheet engines keyed by sheetId.
     * Avoids re-constructing SheetStore + feature engines on every sheet switch.
     * Engines are kept alive (observers remain attached) so cached sheets stay fresh.
     * @type {Map<string, {sheetStore: SheetStore, tableManager: any, renderContext: any, repeaterEngine: any, undoManager: any, formulaEngine: any, cleanupFormulaObserver: Function|null}>}
     */
    #sheetEngineCache = new Map();
    /** Insertion-order list for LRU eviction (oldest first). @type {string[]} */
    #sheetEngineCacheOrder = [];
    static #MAX_CACHED_SHEETS = 3;

    /**
     * On-demand cache of real FormulaEngines for NON-active sheets, used to resolve
     * cross-sheet references (Sheet2!A1 in a formula, cross-sheet dropdown ranges).
     * Each is a genuine FormulaEngine (full spill/cycle/TABLE_* parity with the active
     * one) reading that sheet's cellValues, kept current by a formula observer. This
     * replaces both the per-call throwaway engine in computeSheetRange and the
     * lightweight makeSheetCellEvaluator path — one warmed engine per referenced sheet.
     * @type {Map<string, {engine: any, clearColumnCache: (() => void)|null, cleanup: (() => void)|null}>}
     */
    #crossSheetEngineCache = new Map();
    /** Insertion-order list for cross-sheet engine LRU eviction. @type {string[]} */
    #crossSheetEngineOrder = [];
    /** Sheets whose cross-sheet engine is mid-build (nested cross-sheet refs) — never
     *  evicted while on the build stack. @type {Set<string>} */
    #crossSheetBuilding = new Set();
    static #MAX_CROSS_SHEET_ENGINES = 4;

    // Reactive undo/redo state (updated by observer)
    #canUndo = $state(false);
    #canRedo = $state(false);

    // Reactive list of sheets (updated by observer, not derived from version)
    sheets = $state([]);

    // Reactive metadata (updated by observer)
    metadata = $state({});

    // Reactive document title (from Storage, not Yjs)
    docTitle = $state('');

    /** @type {Function | null} Cleanup for storage event listener */
    #cleanupStorageListener = null;

    // Derived state - active sheet
    get activeSheet() {
        if (!this.root || !this.activeSheetId) return null;
        const sheets = this.root.get('sheets');
        return sheets?.get(this.activeSheetId) || null;
    }

    /**
     * Load a document by ID
     * @param {string} docId
     */
    async load(docId) {
        if (this.#loadPromise) await this.#loadPromise;
        if (this.docId === docId && this.ydoc) return;

        // Start new load with lock
        this.#loadPromise = this.#doLoad(docId);
        try {
            await this.#loadPromise;
        } finally {
            this.#loadPromise = null;
        }
    }

    /**
     * Force a full teardown and reload of the current document.
     * Used after a history restore: YjsRuntime.clearAndSwitchRoom() has already
     * destroyed the old Y.Doc and loaded a fresh one under the new roomId.
     * We must tear down session state without touching YjsRuntime, then
     * re-initialize from the already-live new doc.
     */
    async reload() {
        const docId = this.docId;
        if (!docId) return;
        if (this.#loadPromise) {
            await this.#loadPromise;
        }
        // Use #teardownSession (not unload) so we don't destroy the new Yjs doc
        // that clearAndSwitchRoom already loaded into the runtime.
        this.#teardownSession();
        this.#loadPromise = this.#doLoad(docId);
        try {
            await this.#loadPromise;
        } finally {
            this.#loadPromise = null;
        }
    }

    /**
     * Internal load implementation
     * @param {string} docId
     */
    async #doLoad(docId) {
        this.isLoading = true;
        this.error = null;
        performance.mark('ss:load:start');

        try {
            await this.unload();

            performance.mark('ss:yjsLoad:start');
            const ydoc = await storage.drive.loadDoc(docId);
            performance.mark('ss:yjsLoad:end');
            performance.measure('ss:yjsLoad', 'ss:yjsLoad:start', 'ss:yjsLoad:end');

            const root = ydoc.getMap('spreadsheet');

            // Generic lifecycle: handles missing-structure recovery, schema
            // version check (read-only on newer-than-client), and migrations
            // with skip-when-stamped-current. The actual app-specific shape
            // is provided by spreadsheetAppSchema.
            const prep = await prepareDocForUse({
                ydoc,
                waitForServerSync: () => storage.drive.waitForServerSync(docId),
                schema: spreadsheetAppSchema,
                log,
            });
            this.readOnly = prep.readOnly;
            this.readOnlyReason = prep.readOnlyReason;
            this.notices = [];
            if (prep.recovery === 'auto-initialized') {
                this.#pushNotice('warn',
                    'This file was empty on the server and has been re-initialized with a blank spreadsheet.');
            }

            // Surface missed-rotation events for the currently loaded doc.
            this.#cleanupMissedRotation?.();
            const handleMissedRotation = (payload) => {
                if (payload?.fileId !== docId) return;
                this.#pushNotice('warn',
                    'This document was restored from a snapshot while you were offline. ' +
                    'Any edits you made offline have been discarded — the restored version is now active.');
            };
            storage.on('missed-rotation', handleMissedRotation);
            this.#cleanupMissedRotation = () => storage.off('missed-rotation', handleMissedRotation);

            this.docId = docId;
            this.ydoc = ydoc;
            this.root = root;

            this.#setupObservers();

            const sheets = root.get('sheets');
            const sheetOrder = root.get('sheetOrder');
            const firstSheetId = sheetOrder?.get(0) || 'sheet-1';

            this.activeSheetId = firstSheetId;

            // Create SheetStore for active sheet
            const activeSheet = sheets?.get(firstSheetId);
            if (activeSheet) {
                // Bulk-initialise any missing sub-collections on EVERY sheet in
                // a single MIGRATION-origin transaction. This both:
                //   (a) avoids per-sheet untagged writes the first time each sheet
                //       is activated, and
                //   (b) lets the document-level UndoManager pre-register every
                //       sheet's Y types at construction time.
                this.#ensureSheetSubCollections(ydoc, sheets);

                performance.mark('ss:sheetStore:start');
                this.activeSheetStore = new SheetStore(activeSheet, ydoc);
                performance.mark('ss:sheetStore:end');
                performance.measure('ss:sheetStore', 'ss:sheetStore:start', 'ss:sheetStore:end');
                // Create document-wide table registry before the undo manager so
                // its migration (which creates root.tables) runs first, ensuring
                // root.tables exists when we hand it to Y.UndoManager.
                performance.mark('ss:tableRegistry:start');
                this.tableRegistry = new DocumentTableRegistry(root, ydoc);
                performance.mark('ss:tableRegistry:end');
                performance.measure('ss:tableRegistry', 'ss:tableRegistry:start', 'ss:tableRegistry:end');
                // When a table's row data changes, surgically dirty:
                //   (a) formulas that name the table via TABLE_* (by-name index)
                //   (b) formulas that reference the affected grid cells (by coordinate)
                // Single recalc batch handles both.
                // When tables themselves are added/removed/renamed (structural),
                // every engine's TABLE_* formulas may be stale: a deleted table no
                // longer resolves, a freshly-added table now resolves, etc. Mark
                // all formulas in every active+cached engine that depend on any
                // table (or wildcard) dirty and recalc.
                this.tableRegistry.onTableStructureChange = () => {
                    const names = this.tableRegistry?.getAllTableNames?.() ?? [];
                    // Every live engine (active, cached, warmed cross-sheet): drop the
                    // stale TABLE_* column cache and re-dirty wildcard + direct-name deps.
                    this.#forEachLiveEngine((engine, clearColumnCache) => {
                        clearColumnCache?.();
                        engine.markTableDependentsDirty('*');
                        for (const n of names) engine.markTableDependentsDirty(n);
                        engine.recalculateDirty();
                    });
                };

                this.tableRegistry.onTableChange = ({ sourceTableId, events, rowArr }) => {
                    const engine = this.formulaEngine;
                    if (!engine) return;

                    // Classify events first so we know whether anything that
                    // could affect formula results actually changed. _fmt /
                    // _rowFmt changes are filtered out — they don't dirty
                    // TABLE_* deps.
                    const { structural, cellChanges } = classifyTableRowEvents(events, rowArr);
                    if (!structural && cellChanges.length === 0) return;

                    // (a) Name-based refresh: drop each live engine's stale TABLE_*
                    // column cache and re-dirty its =TABLE_*() formulas. Covers the
                    // active engine, cached (inactive) sheet engines, AND warmed
                    // cross-sheet engines — all keep their caches for their lifetime, so
                    // without this their =TABLE_SUM('Ledger') cells keep the pre-change
                    // value until reactivated/rebuilt.
                    const sourceStore = this.tableRegistry.getById(sourceTableId);
                    const upperName = sourceStore?.name ? sourceStore.name.toUpperCase() : null;
                    this.#forEachLiveEngine((eng, clearColumnCache) => {
                        clearColumnCache?.();
                        if (upperName) eng.markTableDependentsDirty(upperName);
                    });

                    // (b) Coordinate-based: map to grid cells per view.
                    const dirtyCells = [];

                    for (const { store: view } of this.tableRegistry.getViewsForTable(sourceTableId)) {
                        if (view.mode !== 'inline') continue;
                        const newExtent = view.sortedFilteredRows.length;
                        const oldExtent = this.#lastTableDataExtent.get(view) ?? newExtent;
                        this.#lastTableDataExtent.set(view, newExtent);

                        if (structural) {
                            // Cover both old and new extents so cells that used to be
                            // table data (now empty after a delete) get dirtied too.
                            const span = Math.max(oldExtent, newExtent);
                            const dataStart = view.startRow + 2;
                            for (let i = 0; i < span; i++) {
                                const r = dataStart + i;
                                for (let c = view.startCol; c <= view.endCol; c++) {
                                    dirtyCells.push({ row: r, col: c });
                                }
                            }
                        } else {
                            for (const { rawIndex, colId } of cellChanges) {
                                const di = view.displayIndexOfRawRow(rawIndex);
                                if (di < 0) continue; // filtered out of this view
                                const gc = view.gridColForColumnId(colId);
                                if (gc < 0) continue; // column not visible in this view
                                dirtyCells.push({ row: view.gridRowForDisplayIndex(di), col: gc });
                            }
                        }
                    }

                    if (dirtyCells.length > 0) {
                        engine.notifyCellsChanged(dirtyCells);
                    }
                    // Always flush name-based deps (TABLE_* formulas): notifyCellsChanged
                    // only calls recalculateDirty() when it finds coordinate-based dependents,
                    // so name-based dirty cells can be left pending when no grid formula
                    // references the table by coordinate. Flush every live engine we may
                    // have re-dirtied (a no-op where the dirty set is empty).
                    this.#forEachLiveEngine((eng) => eng.recalculateDirty());
                };

                // Single document-level UndoManager: tracks every sheet's Y types
                // plus document-level state (rootTables, namedRanges, metadata,
                // sheetOrder). Survives sheet switches.
                this.undoManager = new Y.UndoManager(
                    this.#collectAllTrackedTypes(),
                    { trackedOrigins: new Set([YJS_ORIGIN.UI]) }
                );
                this.#setupUndoObserver();

                // Create TableManager before formula engine so TABLE_* functions are
                // registered before formulas are evaluated on first load.
                performance.mark('ss:tableManager:start');
                this.tableManager = new TableManager(activeSheet, ydoc, this.tableRegistry, root);
                performance.mark('ss:tableManager:end');
                performance.measure('ss:tableManager', 'ss:tableManager:start', 'ss:tableManager:end');

                // Initialize formula engine for the active sheet (registers tableManager functions first)
                performance.mark('ss:formulaEngine:start');
                this.#initializeFormulaEngine(activeSheet, this.tableManager);
                performance.mark('ss:formulaEngine:end');
                performance.measure('ss:formulaEngine', 'ss:formulaEngine:start', 'ss:formulaEngine:end');

                // Create SheetRenderContext (after formula engine is ready)
                this.renderContext = new SheetRenderContext(this.activeSheetStore, ydoc, this);
                this.renderContext.tableManager = this.tableManager;

                // Initialize RepeaterEngine and wire into renderContext
                this.repeaterEngine = new RepeaterEngine(activeSheet, ydoc);
                this.renderContext.repeaterEngine = this.repeaterEngine;
            }
            const provider = storage._runtime?.activeDocs?.get(docId)?.provider;
            if (provider) {
                this.awareness = provider.awareness;
                this.#setupAwarenessObserver();
            }

            // Initialize document title from Storage
            this.#updateDocTitle();

            // Listen for file updates from Storage (via core for full event access)
            const fileUpdatedHandler = () => {
                this.#updateDocTitle();
            };
            storage.on('change', fileUpdatedHandler);
            this.#cleanupStorageListener = () => {
                storage.off('change', fileUpdatedHandler);
            };

        } catch (err) {
            console.error('[SpreadsheetSession] Failed to load document:', err);
            this.error = err.message;
        } finally {
            performance.mark('ss:load:end');
            performance.measure('ss:load:total', 'ss:load:start', 'ss:load:end');
            this.isLoading = false;
        }
    }

    /**
     * Tear down all session-level state (observers, engines, stores) without
     * touching the YjsRuntime. Called by both unload() and reload().
     */
    #teardownSession() {
        if (this.#cleanupAwarenessObserver) {
            this.#cleanupAwarenessObserver();
            this.#cleanupAwarenessObserver = null;
        }
        this.remoteSelections = [];

        if (this.#cleanupUndoObserver) {
            this.#cleanupUndoObserver();
            this.#cleanupUndoObserver = null;
        }

        if (this.#cleanupFormulaObserver) {
            this.#cleanupFormulaObserver();
            this.#cleanupFormulaObserver = null;
        }
        if (this.formulaEngine) {
            this.formulaEngine.clear();
            this.formulaEngine = null;
        }

        if (this.#externalDocManager) {
            this.#externalDocManager.destroy();
            this.#externalDocManager = null;
        }

        if (this.tableManager) {
            this.tableManager.destroy();
            this.tableManager = null;
        }

        if (this.tableRegistry) {
            this.tableRegistry.destroy();
            this.tableRegistry = null;
        }

        if (this.repeaterEngine) {
            this.repeaterEngine.destroy();
            this.repeaterEngine = null;
        }

        if (this.renderContext) {
            this.renderContext.destroy();
            this.renderContext = null;
        }

        if (this.activeSheetStore) {
            this.activeSheetStore.destroy();
            this.activeSheetStore = null;
        }

        this.#clearSheetEngineCache();
        this.#clearCrossSheetEngineCache();

        if (this.#cleanupObserver) {
            this.#cleanupObserver();
            this.#cleanupObserver = null;
        }

        if (this.#cleanupStorageListener) {
            this.#cleanupStorageListener();
            this.#cleanupStorageListener = null;
        }

        if (this.#cleanupMissedRotation) {
            this.#cleanupMissedRotation();
            this.#cleanupMissedRotation = null;
        }

        // Y.UndoManager.destroy() unobserves all tracked types so it stops
        // accumulating stack items after teardown.
        this.undoManager?.destroy?.();

        this.#crossSheetKVCache.clear();

        this.docId = null;
        this.ydoc = null;
        this.root = null;
        this.activeSheetId = null;
        this.undoManager = null;
        this.awareness = null;
        this.sheets = [];
        this.metadata = {};
        this.docTitle = '';
        this.readOnly = false;
        this.readOnlyReason = null;
        this.notices = [];
        this.#canUndo = false;
        this.#canRedo = false;
    }

    /**
     * Append a transient notice for the UI to surface as a banner.
     * @param {'info'|'warn'} severity
     * @param {string} message
     */
    #pushNotice(severity, message) {
        this.notices = [
            ...this.notices,
            { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, severity, message },
        ];
    }

    /**
     * Dismiss a notice by id. Public so banner components can call it.
     * @param {string} id
     */
    dismissNotice(id) {
        this.notices = this.notices.filter(n => n.id !== id);
    }

    /**
     * Unload the current document, releasing YjsRuntime resources.
     */
    async unload() {
        const unloadingDocId = this.docId;
        this.#teardownSession();
        // Release the Yjs runtime document (providers, IndexedDB) now that all
        // local observers are detached.
        if (unloadingDocId) {
            storage._runtime?.unload(unloadingDocId);
        }
    }

    /**
     * Set up observers for Yjs changes
     */
    #setupObservers() {
        if (!this.root) return;

        // Observer for document structure (Sheets list)
        const structureObserver = () => {
            this.#updateSheetsList();
            // Recovery: if the doc's structure wasn't fully synced at load time,
            // activeSheetStore can be left null (the initial sheets.get(firstSheetId)
            // lookup missed because the sheet entry hadn't arrived yet). Unlike
            // rootObserver below (which only fires when root's own top-level keys
            // change), this fires when sheetOrder/sheets receive their delayed
            // entries — exactly when the retry below can actually succeed.
            if (!this.activeSheetStore && this.activeSheetId &&
                this.root?.get('sheets')?.has(this.activeSheetId)) {
                this.setActiveSheet(this.activeSheetId);
            }
        };

        // Observer for metadata changes
        const metadataObserver = () => {
            this.#updateMetadata();
        };

        // Observe the sheetOrder array and sheets map
        let sheetOrder = this.root.get('sheetOrder');
        let sheetsMap = this.root.get('sheets');

        sheetOrder?.observe(structureObserver);

        // Shallow observe on sheets map — fires only for add/remove/replace of
        // a sheet, NOT for every cell mutation inside a sheet. Per-sheet name
        // changes are picked up by individual sheet observers below.
        sheetsMap?.observe(structureObserver);

        // Per-sheet observers for name changes — keyed by sheetId so we can
        // attach/detach when sheets are added/removed.
        /** @type {Map<string, Function>} */
        const perSheetCleanups = new Map();
        const attachSheetNameObserver = (sheetId) => {
            if (perSheetCleanups.has(sheetId)) return;
            const sheet = sheetsMap?.get(sheetId);
            if (!sheet) return;
            const nameObs = (event) => {
                if (event.keysChanged?.has('name')) this.#updateSheetsList();
            };
            sheet.observe(nameObs);
            perSheetCleanups.set(sheetId, () => sheet.unobserve(nameObs));
        };
        const detachSheetNameObserver = (sheetId) => {
            const fn = perSheetCleanups.get(sheetId);
            if (fn) { fn(); perSheetCleanups.delete(sheetId); }
        };
        // Initial attach for existing sheets
        sheetsMap?.forEach((_, sheetId) => attachSheetNameObserver(sheetId));
        // Reconcile attachments when sheets are added/removed
        const sheetsMapKeyObs = (event) => {
            event.keysChanged?.forEach((sheetId) => {
                if (sheetsMap.has(sheetId)) attachSheetNameObserver(sheetId);
                else detachSheetNameObserver(sheetId);
            });
        };
        sheetsMap?.observe(sheetsMapKeyObs);

        // Observe metadata map
        const metadataMap = this.root.get('metadata');
        metadataMap?.observe(metadataObserver);

        // Fallback for an extreme edge case: if the WS sync timed out and we
        // initialized locally, then WS later delivers the server state that replaces
        // root keys, the sub-observer closures above become stale. Observing root
        // lets us re-attach and re-activate the active sheet.
        const rootObserver = () => {
            const newSheets = this.root?.get('sheets');
            if (!newSheets || this.activeSheetStore) return;

            // Attach sub-observers that couldn't be set up before
            const newSheetOrder = this.root?.get('sheetOrder');
            if (!sheetsMap) {
                sheetsMap = newSheets;
                sheetsMap.observe(structureObserver);
                sheetsMap.observe(sheetsMapKeyObs);
                sheetsMap.forEach((_, sheetId) => attachSheetNameObserver(sheetId));
            }
            if (!sheetOrder && newSheetOrder) {
                sheetOrder = newSheetOrder;
                sheetOrder.observe(structureObserver);
            }
            this.#updateSheetsList();
            const firstId = newSheetOrder?.get(0) || this.activeSheetId || 'sheet-1';
            this.activeSheetId = firstId;
            this.setActiveSheet(firstId);
        };
        this.root.observe(rootObserver);

        // Initial sync
        this.#updateSheetsList();
        this.#updateMetadata();

        this.#cleanupObserver = () => {
            sheetOrder?.unobserve(structureObserver);
            sheetsMap?.unobserve(structureObserver);
            sheetsMap?.unobserve(sheetsMapKeyObs);
            for (const fn of perSheetCleanups.values()) fn();
            perSheetCleanups.clear();
            metadataMap?.unobserve(metadataObserver);
            this.root?.unobserve(rootObserver);
        };
    }

    /**
     * Update the sheets list from Yjs
     */
    #updateSheetsList() {
        if (!this.root) return;
        const sheetOrder = this.root.get('sheetOrder');
        const sheetsMap = this.root.get('sheets');

        if (!sheetOrder || !sheetsMap) {
            this.sheets = [];
            return;
        }

        // Map order array to simple objects for UI
        this.sheets = sheetOrder.toArray().map(id => {
            const sheet = sheetsMap.get(id);
            // Only return if sheet exists
            return sheet ? { id, name: sheet.get('name') } : null;
        }).filter(Boolean);
    }

    /**
     * Update metadata from Yjs
     */
    #updateMetadata() {
        if (!this.root) return;
        const metadataMap = this.root.get('metadata');
        this.metadata = metadataMap ? metadataMap.toJSON() : {};
    }

    /**
     * Update document title from Storage
     */
    #updateDocTitle() {
        if (!this.docId) return;
        const file = storage.drive.getFile(this.docId);
        this.docTitle = file?.title || '';
    }

    /**
     * Force every sheet to have rowMeta/colMeta/tableViews/repeaters/merges sub-
     * collections. Run in a single MIGRATION-origin transaction so the writes
     * are never undoable. Idempotent.
     * @param {import('yjs').Doc} ydoc
     * @param {import('yjs').Map<any> | undefined | null} sheetsMap
     */
    #ensureSheetSubCollections(ydoc, sheetsMap) {
        if (!ydoc || !sheetsMap) return;
        let needsTxn = false;
        sheetsMap.forEach((sheet) => {
            if (!sheet.get('rowMeta'))   needsTxn = true;
            if (!sheet.get('colMeta'))   needsTxn = true;
            if (!sheet.get('tableViews'))    needsTxn = true;
            if (!sheet.get('repeaters')) needsTxn = true;
            if (!sheet.get('merges'))    needsTxn = true;
        });
        if (!needsTxn) return;
        ydoc.transact(() => {
            sheetsMap.forEach((sheet) => {
                if (!sheet.get('rowMeta'))   sheet.set('rowMeta',   new Y.Array());
                if (!sheet.get('colMeta'))   sheet.set('colMeta',   new Y.Array());
                if (!sheet.get('tableViews'))    sheet.set('tableViews',    new Y.Map());
                if (!sheet.get('repeaters')) sheet.set('repeaters', new Y.Map());
                if (!sheet.get('merges'))    sheet.set('merges',    new Y.Array());
            });
        }, YJS_ORIGIN.MIGRATION);
    }

    /**
     * Build the array of every Y type that the single document-level UndoManager
     * should track. Includes:
     *   - per-sheet: the sheet Y.Map itself and each of its mutable sub-collections
     *   - document-level: rootTables, namedRanges, metadata, sheetOrder
     * @returns {Array<any>}
     */
    #collectAllTrackedTypes() {
        const out = [];
        const root = this.root;
        if (!root) return out;
        const sheetsMap = root.get('sheets');
        sheetsMap?.forEach((sheet) => {
            out.push(sheet);
            for (const k of ['cellValues', 'cellStyles', 'borders', 'rowMeta', 'colMeta', 'tableViews', 'repeaters', 'merges']) {
                const v = sheet.get(k);
                if (v) out.push(v);
            }
        });
        for (const k of ['tableData', 'namedRanges', 'metadata', 'sheetOrder']) {
            const v = root.get(k);
            if (v) out.push(v);
        }
        return out;
    }

    /**
     * Initialize the formula engine for a sheet
     * @param {Y.Map} sheet
     */
    #initializeFormulaEngine(sheet, tableManager = null) {
        if (!this.ydoc || !this.activeSheetStore) return;

        // Create (or reuse) the external doc manager. It persists across sheet switches
        // so that already-loaded docs don't need to be re-fetched.
        if (!this.#externalDocManager) {
            this.#externalDocManager = new ExternalDocManager(
                storage,
                (_fileId) => {
                    // A referenced external doc just finished loading — recalculate
                    // all formulas so IMPORTRANGE cells get their real values.
                    this.formulaEngine?.recalculateAll();
                }
            );
        }

        // Create new formula engine
        this.formulaEngine = new FormulaEngine();

        // Register TABLE_* functions immediately so they are available when existing
        // formulas are evaluated below (prevents #NAME? on first load).
        // trackForInvalidation: this is the persistent engine, so its TABLE_* column
        // cache must be dropped on table data changes (see onTableChange).
        tableManager?.registerFunctions(this.formulaEngine, this, { trackForInvalidation: true });

        // Register IMPORTRANGE as a custom function, closing over the manager.
        const extMgr = this.#externalDocManager;
        this.formulaEngine.registerFunction('IMPORTRANGE', (fileIdOrUrl, rangeStr) => {
            if (typeof fileIdOrUrl !== 'string' && typeof fileIdOrUrl !== 'number') return FormulaError.VALUE;
            if (typeof rangeStr !== 'string') return FormulaError.VALUE;
            return extMgr.getRange(String(fileIdOrUrl), rangeStr);
        });

        // Set up cell value getter - returns raw cell values from Yjs
        this.formulaEngine.setCellValueGetter((row, col) => {
            // Check table cells first — they store data in TableStore rows, not sheet cells.
            // table.getValue() evaluates formula strings via the injected sheet evaluator,
            // so sheet formulas that reference table cells by grid coords get the right value.
            if (this.tableManager) {
                const info = this.tableManager.getCellInfo(row, col);
                if (info?.table && info.rowType === 'data' && info.colDef) {
                    return info.table.getValue(info.dataIndex, info.colDef.id) ?? null;
                }
            }
            const cell = this.activeSheetStore?.getCell(row, col);
            if (!cell || !cell.exists) return null;
            const v = cell.v;
            if (typeof v === 'string' && v.startsWith('=')) {
                return null; // Formula cells have no "raw" value
            }
            return v;
        });

        // Set up cross-sheet getter — resolves SheetName!CellRef at eval time via a
        // real, current FormulaEngine for the target sheet (active, cached, or warmed
        // on demand). Multi-hop refs work because each warmed engine's own cross-sheet
        // getter routes back here; a cross-sheet cycle terminates because a cell whose
        // engine is mid-build reads as not-yet-computed rather than looping.
        this.formulaEngine.setCrossSheetGetter((sheetName, row, col) =>
            this.getCrossSheetValue(sheetName, row, col)
        );

        // Wire formula evaluator into all table stores so that table cell values
        // like "=10*15" are evaluated on-demand through table.getValue().
        // Delegates to the engine's evaluateString() so cross-sheet refs and
        // TABLE_* / IMPORTRANGE all work inside table cells, identical to
        // grid cells. Must happen before the first recalculateDirty() so
        // TABLE_* functions already get evaluated values during the initial
        // formula pass.
        if (tableManager) {
            const engineRef = this.formulaEngine;
            const evalFn = (formula) => engineRef.evaluateString(formula);
            tableManager.setSheetFormulaEvaluator(evalFn);
        }

        // Load existing formulas from the sheet and compute initial values
        const cellValuesKV = this.activeSheetStore?.cellValuesKV
            ?? (sheet.get('cellValues') instanceof Y.Array ? new YKeyValue(sheet.get('cellValues')) : null);

        if (cellValuesKV) {
            // Register all formulas into the dependency graph without evaluating them,
            // then recalculate once in topological order. This avoids the O(2N) double-
            // evaluation that occurs when setFormula() eagerly evaluates each formula as
            // it's registered (before all dependencies exist).
            for (const [key, { val: data }] of cellValuesKV.map) {
                const v = data?.v;
                if (typeof v === 'string' && v.startsWith('=')) {
                    const [row, col] = key.split(',').map(Number);
                    this.formulaEngine.registerFormula(row, col, v);
                }
            }
            // Single evaluation pass in correct dependency order.
            this.formulaEngine.recalculateDirty();

            // Capture the engine and sheetId at observer creation. We
            // intentionally do NOT capture the sheet name here — it can change
            // via renameSheet, and a stale name would break cross-sheet
            // invalidation. The name is resolved per-invocation below.
            const capturedEngine = this.formulaEngine;
            const capturedSheetId = this.activeSheetId;
            const currentSheetName = () =>
                this.sheets.find(s => s.id === capturedSheetId)?.name
                ?? this.root?.get('sheets')?.get(capturedSheetId)?.get('name')
                ?? '';

            // Observe cellValues YKeyValue for formula recalculation on changes.
            // Batched: marks all dependents dirty in one pass, then runs ONE
            // recalculateDirty(). Previously this looped cellValueChanged()
            // per cell, each call doing a full recalc — N changes meant N×N.
            const formulaObserver = (changes) => {
                const formulasToSet  = [];
                const formulasToClear = [];
                const valueChanges   = [];

                for (const [key, change] of changes) {
                    const [row, col] = key.split(',').map(Number);
                    if (change.action === 'delete') {
                        formulasToClear.push({ row, col });
                        valueChanges.push({ row, col });
                    } else {
                        const newV = change.newValue?.v;
                        const oldV = change.oldValue?.v;
                        if (typeof newV === 'string' && newV.startsWith('=')) {
                            formulasToSet.push({ row, col, formula: newV });
                        } else {
                            if (typeof oldV === 'string' && oldV.startsWith('=')) {
                                formulasToClear.push({ row, col });
                            }
                            valueChanges.push({ row, col });
                        }
                    }
                }

                for (const { row, col } of formulasToClear) {
                    capturedEngine.clearFormula(row, col);
                }
                for (const { row, col, formula } of formulasToSet) {
                    capturedEngine.setFormula(row, col, formula);
                }
                // Batched value-change notification — single recalc pass.
                if (valueChanges.length > 0) {
                    capturedEngine.notifyCellsChanged(valueChanges);
                } else if (formulasToSet.length > 0 || formulasToClear.length > 0) {
                    capturedEngine.recalculateDirty();
                }

                // Propagate this sheet's changes to every other live engine (active,
                // cached, or warmed cross-sheet) that references this sheet.
                if (valueChanges.length > 0 || formulasToClear.length > 0 || formulasToSet.length > 0) {
                    const sheetName = currentSheetName();
                    if (!sheetName) return;
                    this.#propagateCrossSheetChange(sheetName, capturedEngine);
                }
            };

            cellValuesKV.on('change', formulaObserver);

            this.#cleanupFormulaObserver = () => {
                cellValuesKV.off('change', formulaObserver);
            };
        }
    }

    /**
     * Save the current sheet's engines to the LRU cache without destroying them.
     * Engines stay alive (Yjs observers remain attached) so cached sheets stay fresh.
     * Nulls out all this.* references so subsequent destroy-guards are no-ops.
     * @param {string} sheetId
     */
    #cacheCurrentSheet(sheetId) {
        if (!this.activeSheetStore) return;

        // NOTE: undoManager is document-level and not cached per sheet — it
        // stays alive on `this` across sheet switches.
        this.#sheetEngineCache.set(sheetId, {
            sheetStore: this.activeSheetStore,
            tableManager: this.tableManager,
            renderContext: this.renderContext,
            repeaterEngine: this.repeaterEngine,
            formulaEngine: this.formulaEngine,
            // Keep the formula observer alive in the background so formula
            // results stay current even while this sheet is not active.
            cleanupFormulaObserver: this.#cleanupFormulaObserver,
        });

        // Track LRU order and evict oldest if over limit
        this.#sheetEngineCacheOrder = this.#sheetEngineCacheOrder.filter(id => id !== sheetId);
        this.#sheetEngineCacheOrder.push(sheetId);
        while (this.#sheetEngineCacheOrder.length > SpreadsheetSession.#MAX_CACHED_SHEETS) {
            const evictId = this.#sheetEngineCacheOrder.shift();
            if (!evictId) break;
            const evicted = this.#sheetEngineCache.get(evictId);
            if (evicted) {
                evicted.cleanupFormulaObserver?.();
                evicted.sheetStore.destroy();
                evicted.tableManager?.destroy();
                evicted.renderContext?.destroy();
                evicted.repeaterEngine?.destroy();
                this.#sheetEngineCache.delete(evictId);
            }
        }

        // Null all references so destroy checks in setActiveSheet are no-ops.
        // NOTE: undoManager intentionally preserved — it is document-level.
        this.activeSheetStore = null;
        this.tableManager = null;
        this.renderContext = null;
        this.repeaterEngine = null;
        this.formulaEngine = null;
        this.#cleanupFormulaObserver = null;
    }

    /**
     * Restore a sheet from the engine cache if available.
     * @param {string} sheetId
     * @returns {boolean} true if restored from cache
     */
    #restoreSheetFromCache(sheetId) {
        const cached = this.#sheetEngineCache.get(sheetId);
        if (!cached) return false;

        this.#sheetEngineCache.delete(sheetId);
        this.#sheetEngineCacheOrder = this.#sheetEngineCacheOrder.filter(id => id !== sheetId);

        this.activeSheetStore = cached.sheetStore;
        this.tableManager = cached.tableManager;
        this.renderContext = cached.renderContext;
        this.repeaterEngine = cached.repeaterEngine;
        this.formulaEngine = cached.formulaEngine;
        this.#cleanupFormulaObserver = cached.cleanupFormulaObserver;
        // undoManager is document-level — already alive and tracking.
        return true;
    }

    /**
     * Destroy all cached sheet engines (called on document unload).
     */
    #clearSheetEngineCache() {
        for (const [, cached] of this.#sheetEngineCache) {
            cached.cleanupFormulaObserver?.();
            cached.sheetStore.destroy();
            cached.tableManager?.destroy();
            cached.renderContext?.destroy();
            cached.repeaterEngine?.destroy();
        }
        this.#sheetEngineCache.clear();
        this.#sheetEngineCacheOrder = [];
    }

    /**
     * Switch to a different sheet
     * @param {string} sheetId
     */
    setActiveSheet(sheetId) {
        if (!this.root) return;

        const sheets = this.root.get('sheets');
        if (!sheets?.has(sheetId)) return;

        const _switchT = performance.now();

        // NOTE: undoManager is document-level and survives sheet switches —
        // no observer re-attachment needed here.

        // Save current sheet to LRU cache instead of destroying it.
        // #cacheCurrentSheet nulls all this.* refs so destroy-guards below are no-ops.
        const oldSheetId = this.activeSheetId;
        if (oldSheetId && oldSheetId !== sheetId) {
            this.#cacheCurrentSheet(oldSheetId);
        } else if (this.activeSheetStore) {
            // Same sheet re-activation (shouldn't normally happen) — just destroy
            this.activeSheetStore.destroy();
            this.activeSheetStore = null;
        }

        this.activeSheetId = sheetId;
        // This sheet is now backed by the active engine; drop any warmed cross-sheet
        // engine for it so we don't keep a duplicate observer + recompute in parallel.
        this.#dropCrossSheetEngine(sheetId);

        // Refresh remote selections immediately — the awareness observer only
        // fires on awareness changes, not on local sheet switches, so stale
        // highlights from the previous sheet would linger otherwise.
        this.remoteSelections = this.getRemoteSelections();

        // ── Try cache first ───────────────────────────────────────────────────
        if (this.#restoreSheetFromCache(sheetId)) {
            log.debug(`[SpreadsheetSession] Sheet switch (cache hit): ${(performance.now() - _switchT).toFixed(1)}ms`);
            return;
        }

        // ── Cache miss: construct engines for new sheet ───────────────────────
        const sheet = sheets.get(sheetId);
        if (sheet && this.ydoc) {
            this.activeSheetStore = new SheetStore(sheet, this.ydoc);

            // Ensure missing sub-collections exist and the document-level
            // UndoManager is tracking them. This is typically a no-op now
            // because #ensureSheetSubCollections runs at doc load for every
            // sheet, but #addSheet may have created a fresh sheet that needs
            // its types added to the manager's scope.
            this.#ensureSheetSubCollections(this.ydoc, this.root?.get('sheets'));
            if (this.undoManager) {
                const newTypes = [
                    sheet, sheet.get('cellValues'), sheet.get('cellStyles'),
                    sheet.get('borders'), sheet.get('rowMeta'), sheet.get('colMeta'),
                    sheet.get('tableViews'), sheet.get('repeaters'), sheet.get('merges'),
                ].filter(Boolean);
                for (const t of newTypes) {
                    try { this.undoManager.addToScope(t); } catch { /* already in scope */ }
                }
                this.#setupUndoObserver();
            }

            // #cleanupFormulaObserver and engines are already null (from #cacheCurrentSheet)
            // Create TableManager before formula engine so TABLE_* functions are
            // registered before formulas are evaluated on sheet switch.
            this.tableManager = new TableManager(sheet, this.ydoc, this.tableRegistry, this.root);
            this.#initializeFormulaEngine(sheet, this.tableManager);

            this.renderContext = new SheetRenderContext(this.activeSheetStore, this.ydoc, this);
            this.repeaterEngine = new RepeaterEngine(sheet, this.ydoc);
            this.renderContext.tableManager = this.tableManager;
            this.renderContext.repeaterEngine = this.repeaterEngine;
        }
        log.debug(`[SpreadsheetSession] Sheet switch (cache miss): ${(performance.now() - _switchT).toFixed(1)}ms`);
    }

    // ========================================================================
    // CELL OPERATIONS (convenience methods delegating to SheetStore)
    // ========================================================================

    /**
     * Get a cell's raw data from Yjs
     * @param {number} row
     * @param {number} col
     * @returns {Object} Cell object with { v, exists, ...formatting }
     */
    getCell(row, col) {
        return this.activeSheetStore?.getCell(row, col) ?? { v: undefined, exists: false };
    }

    /**
     * Get cell display value (computed value for formula cells, raw value otherwise)
     * This is the main method for UI components to get cell values.
     * @param {number} row
     * @param {number} col
     * @returns {any}
     */
    getCellDisplayValue(row, col) {
        // Always check the formula engine first.
        // It holds both formula-computed values (for cells with '=' formulas)
        // and spill values (for neighbouring cells filled by array formulas like
        // FILTER, IMPORTRANGE, etc.).  The engine's computedValues map is the
        // single source of truth for any formula-derived display value.
        if (this.formulaEngine) {
            const key = `${row},${col}`;
            if (key in this.formulaEngine.computedValues) {
                return this.formulaEngine.computedValues[key] ?? '';
            }
        }

        // Table cells store their data in TableStore rows, not in the sheet cell map.
        if (this.tableManager) {
            const info = this.tableManager.getCellInfo(row, col);
            if (info?.table) {
                if (info.rowType === 'header') return info.colDef?.name ?? '';
                if (info.rowType === 'data')   return this.tableManager.getCellDisplayValue(row, col);
            }
        }

        const cell = this.getCell(row, col);
        if (!cell.exists) return '';
        return cell.v ?? '';
    }

    /**
     * Get a cell value from another sheet by name.
     * Used for cross-sheet references in formulas (e.g., Sheet2!A1).
     * @param {string} sheetName
     * @param {number} row
     * @param {number} col
     * @returns {any}
     */
    getCrossSheetValue(sheetName, row, col) {
        const targetSheet = this.sheets.find(s => s.name === sheetName);
        if (!targetSheet) return FormulaError.REF;
        // Resolve through a real, current FormulaEngine for the target sheet (active,
        // cached, or warmed on demand) — full spill/cycle/TABLE_* parity.
        const engine = this.#getCrossSheetEngine(targetSheet.id);
        if (!engine) return FormulaError.REF;
        return engine.getDisplayValue(row, col) ?? null;
    }

    /**
     * Lazily build / return a cached YKeyValue wrapper for a sheet's
     * cellValues Y.Array. Entries are invalidated only on sheet delete or
     * doc teardown — the YKeyValue mirrors the Y.Array reactively so it
     * stays current across edits.
     * @param {string} sheetId
     * @param {import('yjs').Array<any>} cvArr
     * @returns {import('y-utility/y-keyvalue').YKeyValue<any>}
     */
    #getOrCreateCrossSheetKV(sheetId, cvArr) {
        let kv = this.#crossSheetKVCache.get(sheetId);
        if (!kv) {
            kv = new YKeyValue(cvArr);
            this.#crossSheetKVCache.set(sheetId, kv);
        }
        return kv;
    }

    // ─── Cross-sheet engine warming ─────────────────────────────────────────────
    // A single mechanism for cross-sheet reads: get a real, current FormulaEngine
    // for any sheet (the active one, a recently-active cached one, or a warmed-on-
    // demand one) and read computed values from it. Replaces both the per-call
    // throwaway engine in computeSheetRange and the lightweight makeSheetCellEvaluator
    // path, giving full spill/cycle/TABLE_* parity for cross-sheet references.

    /** Iterate every live FormulaEngine (active + cached bundles + warmed cross-sheet)
     *  with a hook that clears its TABLE_* column cache. */
    #forEachLiveEngine(fn) {
        if (this.formulaEngine) fn(this.formulaEngine, () => this.tableManager?.clearFormulaColumnCache());
        for (const [, e] of this.#sheetEngineCache) {
            if (e.formulaEngine) fn(e.formulaEngine, () => e.tableManager?.clearFormulaColumnCache());
        }
        for (const [, e] of this.#crossSheetEngineCache) {
            if (e.engine) fn(e.engine, e.clearColumnCache);
        }
    }

    /** Propagate a sheet's changes to every other live engine that references it
     *  cross-sheet, so their Sheet!Ref formulas recompute. */
    #propagateCrossSheetChange(sheetName, exceptEngine) {
        if (!sheetName) return;
        this.#forEachLiveEngine((engine) => {
            if (engine !== exceptEngine) engine.invalidateCrossSheetDependencies(sheetName);
        });
    }

    /**
     * Return a current FormulaEngine for any sheet, building + caching one on demand.
     * @param {string} sheetId
     * @returns {any|null}
     */
    #getCrossSheetEngine(sheetId) {
        if (!sheetId) return null;
        if (sheetId === this.activeSheetId) return this.formulaEngine;
        const full = this.#sheetEngineCache.get(sheetId);
        if (full?.formulaEngine) return full.formulaEngine;
        const existing = this.#crossSheetEngineCache.get(sheetId);
        if (existing) return existing.engine;
        return this.#buildCrossSheetEngine(sheetId);
    }

    /** Build, cache, and start observing a FormulaEngine for a non-active sheet. */
    #buildCrossSheetEngine(sheetId) {
        const sheetYMap = this.root?.get('sheets')?.get(sheetId);
        if (!sheetYMap) return null;
        const cvArr = sheetYMap.get('cellValues');
        if (!cvArr) return null;
        const cvKV = this.#getOrCreateCrossSheetKV(sheetId, cvArr);

        const eng = new FormulaEngine();
        const extMgr = this.#externalDocManager;
        if (extMgr) {
            eng.registerFunction('IMPORTRANGE', (fileIdOrUrl, rangeStr) => {
                if (typeof fileIdOrUrl !== 'string' && typeof fileIdOrUrl !== 'number') return FormulaError.VALUE;
                if (typeof rangeStr !== 'string') return FormulaError.VALUE;
                return extMgr.getRange(String(fileIdOrUrl), rangeStr);
            });
        }
        // Capture the TABLE_* cache-clear hook so table data changes can drop it.
        const clearColumnCache = this.tableManager?.registerFunctions(eng, this) ?? null;
        // Cross-sheet refs FROM this sheet route back through the same resolver, so
        // multi-hop refs work and a cross-sheet cycle terminates (a cell mid-build is
        // read as not-yet-computed rather than looping forever).
        eng.setCrossSheetGetter((sheetName, row, col) => this.getCrossSheetValue(sheetName, row, col));
        eng.setCellValueGetter((r, c) => {
            const data = cvKV.get(`${r},${c}`);
            if (!data) return null;
            const v = data.v;
            if (typeof v === 'string' && v.startsWith('=')) return null;
            if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
            return v ?? null;
        });

        // Publish BEFORE loading/recalc so a re-entrant cross-sheet ref back to this
        // sheet finds the in-progress engine instead of building a second one.
        const entry = { engine: eng, clearColumnCache, cleanup: null };
        this.#crossSheetEngineCache.set(sheetId, entry);
        this.#crossSheetEngineOrder = this.#crossSheetEngineOrder.filter(id => id !== sheetId);
        this.#crossSheetEngineOrder.push(sheetId);

        this.#crossSheetBuilding.add(sheetId);
        try {
            for (const [key, { val: data }] of cvKV.map) {
                const v = data?.v;
                if (typeof v === 'string' && v.startsWith('=')) {
                    const [row, col] = key.split(',').map(Number);
                    eng.registerFormula(row, col, v);
                }
            }
            eng.recalculateDirty();
        } finally {
            this.#crossSheetBuilding.delete(sheetId);
        }

        // Keep current: on this sheet's cellValues changes, update its formulas +
        // recalc, then propagate to any other engine that references this sheet.
        const observer = (changes) => this.#applyCrossSheetChanges(eng, sheetId, changes);
        cvKV.on('change', observer);
        entry.cleanup = () => cvKV.off('change', observer);

        // Evict the oldest cross-sheet engine over the cap, never one that is the
        // active target or still mid-build (a nested cross-sheet ref could be using it).
        const protectedIds = new Set([sheetId, ...this.#crossSheetBuilding]);
        while (this.#crossSheetEngineCache.size > SpreadsheetSession.#MAX_CROSS_SHEET_ENGINES) {
            const evictId = this.#crossSheetEngineOrder.find(id => !protectedIds.has(id));
            if (!evictId) break;
            this.#dropCrossSheetEngine(evictId);
        }
        return eng;
    }

    /** Formula observer body for a warmed cross-sheet engine (mirrors the active
     *  engine's formulaObserver). */
    #applyCrossSheetChanges(engine, sheetId, changes) {
        const formulasToSet = [];
        const formulasToClear = [];
        const valueChanges = [];
        for (const [key, change] of changes) {
            const [row, col] = key.split(',').map(Number);
            if (change.action === 'delete') {
                formulasToClear.push({ row, col });
                valueChanges.push({ row, col });
            } else {
                const newV = change.newValue?.v;
                const oldV = change.oldValue?.v;
                if (typeof newV === 'string' && newV.startsWith('=')) {
                    formulasToSet.push({ row, col, formula: newV });
                } else {
                    if (typeof oldV === 'string' && oldV.startsWith('=')) formulasToClear.push({ row, col });
                    valueChanges.push({ row, col });
                }
            }
        }
        for (const { row, col } of formulasToClear) engine.clearFormula(row, col);
        for (const { row, col, formula } of formulasToSet) engine.setFormula(row, col, formula);
        if (valueChanges.length > 0) engine.notifyCellsChanged(valueChanges);
        else if (formulasToSet.length > 0 || formulasToClear.length > 0) engine.recalculateDirty();

        if (valueChanges.length > 0 || formulasToSet.length > 0 || formulasToClear.length > 0) {
            const sheetName = this.sheets.find(s => s.id === sheetId)?.name
                ?? this.root?.get('sheets')?.get(sheetId)?.get('name') ?? '';
            this.#propagateCrossSheetChange(sheetName, engine);
        }
    }

    /** Tear down and remove one warmed cross-sheet engine. */
    #dropCrossSheetEngine(sheetId) {
        const entry = this.#crossSheetEngineCache.get(sheetId);
        if (!entry) return;
        entry.cleanup?.();
        entry.engine?.clear?.();
        this.#crossSheetEngineCache.delete(sheetId);
        this.#crossSheetEngineOrder = this.#crossSheetEngineOrder.filter(id => id !== sheetId);
    }

    /** Tear down all warmed cross-sheet engines (doc unload / teardown). */
    #clearCrossSheetEngineCache() {
        for (const [, entry] of this.#crossSheetEngineCache) {
            entry.cleanup?.();
            entry.engine?.clear?.();
        }
        this.#crossSheetEngineCache.clear();
        this.#crossSheetEngineOrder = [];
    }

    /**
     * Compute values for a range on any sheet, evaluating all formulas (including
     * IMPORTRANGE) using a temporary FormulaEngine. Used for cross-sheet dropdown
     * option resolution where spill values would otherwise be invisible.
     * @param {string} sheetId
     * @param {number} startRow
     * @param {number} startCol
     * @param {number} endRow
     * @param {number} endCol
     * @returns {Array<any>} flat array of values in row-major order
     */
    computeSheetRange(sheetId, startRow, startCol, endRow, endCol) {
        const out = [];
        if (sheetId === this.activeSheetId) {
            for (let r = startRow; r <= endRow; r++)
                for (let c = startCol; c <= endCol; c++)
                    out.push(this.getCellDisplayValue(r, c));
            return out;
        }
        // Non-active sheet: read from its warmed FormulaEngine (built + cached on
        // demand, kept current). getDisplayValue surfaces spilled values just like
        // the active engine, so this replaces the former per-call throwaway engine.
        const engine = this.#getCrossSheetEngine(sheetId);
        if (!engine) return [];
        for (let r = startRow; r <= endRow; r++)
            for (let c = startCol; c <= endCol; c++)
                out.push(engine.getDisplayValue(r, c) ?? null);
        return out;
    }

    /**
     * Get the raw value for editing (shows formula if present)
     * @param {number} row
     * @param {number} col
     * @returns {any}
     */
    getCellEditValue(row, col) {
        const cell = this.getCell(row, col);
        if (!cell.exists) return '';
        return cell.v ?? '';
    }

    /**
     * Set a cell's value
     * @param {number} row
     * @param {number} col
     * @param {any} value
     */
    setCell(row, col, value) {
        this.activeSheetStore?.setCellValue(row, col, value);
    }

    /**
     * Set a cell's formula
     * @param {number} row
     * @param {number} col
     * @param {string} formula
     */
    setCellFormula(row, col, formula) {
        this.activeSheetStore?.setCellFormula(row, col, formula);
    }

    /**
     * Get the display name of a sheet by ID.
     * @param {string} sheetId
     * @returns {string}
     */
    getSheetName(sheetId) {
        return this.sheets.find(s => s.id === sheetId)?.name ?? sheetId;
    }

    /**
     * Return metadata for all tables across all sheets: name, sheetId, sheetName, columns[].
     * Reads directly from Yjs — no reactive TableStore instantiation.
     */
    getAllTableDescriptors() {
        if (!this.root) return /** @type {{ tableName: string, sheetId: string, sheetName: string, columns: { id: string, name: string }[] }[]} */ ([]);

        /** @type {{ tableName: string, sheetId: string, sheetName: string, columns: { id: string, name: string }[] }[]} */
        const result = [];

        const tableData = this.root.get('tableData');
        tableData?.forEach((tableYMap) => {
            const tableName = tableYMap.get('name') ?? 'Table';
            const defsMap = tableYMap.get('columnDefs');
            const orderArr = tableYMap.get('columnOrder');
            const columns = [];
            if (defsMap && orderArr) {
                for (const colId of orderArr.toArray()) {
                    const c = defsMap.get(colId);
                    if (c) columns.push({ id: colId, name: c.get?.('name') ?? colId });
                }
            }
            result.push({ tableName, sheetId: '', sheetName: '', columns });
        });

        return result;
    }

    /**
     * Read raw column values for a named table across all sheets.
     * Accepts column name or column ID (case-insensitive match).
     * @param {string} tableName
     * @param {string} columnId  column name or id
     * @returns {string[]}
     */
    getTableColumnValues(tableName, columnId) {
        const store = this.getCrossSheetTable(tableName);
        if (!store) return [];
        const colId = store.resolveColId(String(columnId));
        const seen = new Set();
        return store.getColumn(colId)
            .filter(v => v != null && v !== '')
            .map(String)
            .filter(v => { if (seen.has(v)) return false; seen.add(v); return true; });
    }

    /**
     * Return a live TableStore for any named table across all sheets.
     * Uses DocumentTableRegistry when available — no create/destroy per call.
     * @param {string} tableName
     * @returns {import('./features/TableStore.svelte.js').TableStore | null}
     */
    getCrossSheetTable(tableName) {
        // Fast path: registry provides a live, reactive store — no snapshot needed.
        if (this.tableRegistry) {
            return this.tableRegistry.getByName(tableName);
        }
        return null;
    }

    /**
     * Create a view of a source table on a target sheet.
     * The view entry lives in sheet.tableViews and references the source via `tableId`.
     *
     * @param {{
     *   tableId: string,
     *   targetSheetId: string,
     *   name?: string,
     *   startRow?: number,
     *   startCol?: number,
     *   visibleColumns?: string[]
     * }} opts
     * @returns {string} new view ID, or "" on failure
     */
    createTableViewOnSheet(opts) {
        if (!this.root || !this.ydoc) return "";
        const sheetsMap = this.root.get('sheets');
        const targetSheet = sheetsMap?.get(opts.targetSheetId);
        if (!targetSheet) return "";

        let viewsMap = targetSheet.get('tableViews');
        if (!viewsMap) {
            viewsMap = new Y.Map();
            targetSheet.set('tableViews', viewsMap);
        }

        const viewId = `view-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        this.ydoc.transact(() => {
            const vm = new Y.Map();
            vm.set('id', viewId);
            vm.set('name', opts.name ?? 'View');
            vm.set('mode', 'inline');
            vm.set('startRow', opts.startRow ?? 0);
            vm.set('startCol', opts.startCol ?? 0);
            vm.set('sortColId', null);
            vm.set('sortDir', 'asc');
            vm.set('tableId', opts.tableId);
            const visArr = new Y.Array();
            if (opts.visibleColumns?.length) visArr.push(opts.visibleColumns);
            vm.set('visibleColumns', visArr);
            vm.set('persistedFilters', new Y.Map());
            viewsMap.set(viewId, vm);
        }, YJS_ORIGIN.UI);
        return viewId;
    }

    /**
     * Set a cell's formula on any sheet (not just the active one).
     * Used when committing a formula that was edited while viewing a different sheet.
     * @param {string} sheetId
     * @param {number} row
     * @param {number} col
     * @param {string} formula
     */
    setCellFormulaOnSheet(sheetId, row, col, formula) {
        if (sheetId === this.activeSheetId || !sheetId) {
            this.activeSheetStore?.setCellFormula(row, col, formula);
            return;
        }
        const sheetsMap = this.root?.get('sheets');
        const sheet = sheetsMap?.get(sheetId);
        if (!sheet || !this.ydoc) return;
        const cvArr = sheet.get('cellValues');
        if (!cvArr) return;
        const cvKV = new YKeyValue(cvArr);
        const key = `${row},${col}`;
        const normalized = formula.startsWith('=') ? formula : '=' + formula;
        this.ydoc.transact(() => {
            cvKV.set(key, { ...(cvKV.get(key) ?? {}), v: normalized });
        }, YJS_ORIGIN.UI);
    }

    /**
     * Set a cell's plain value on any sheet (not just the active one).
     * @param {string} sheetId
     * @param {number} row
     * @param {number} col
     * @param {any} value
     */
    setCellValueOnSheet(sheetId, row, col, value) {
        if (sheetId === this.activeSheetId || !sheetId) {
            this.activeSheetStore?.setCellValue(row, col, value);
            return;
        }
        const sheetsMap = this.root?.get('sheets');
        const sheet = sheetsMap?.get(sheetId);
        if (!sheet || !this.ydoc) return;
        const cvArr = sheet.get('cellValues');
        if (!cvArr) return;
        const cvKV = new YKeyValue(cvArr);
        const key = `${row},${col}`;
        this.ydoc.transact(() => {
            if (value === '' || value === null || value === undefined) {
                cvKV.delete(key);
            } else {
                cvKV.set(key, { ...(cvKV.get(key) ?? {}), v: value });
            }
        }, YJS_ORIGIN.UI);
    }

    /**
     * Clear a cell
     * @param {number} row
     * @param {number} col
     */
    clearCell(row, col) {
        this.activeSheetStore?.clearCell(row, col);
    }

    /**
     * Classify a sheet row against the active sheet's tables.
     *   table-data   → row sits inside a table's data range (delete-row should
     *                  delete the table row, not shift sheet rows)
     *   table-fixed  → row is a table header or entry (delete should be blocked
     *                  to avoid orphaning the table; user must delete the table)
     *   sheet        → row isn't owned by any table; normal sheet behavior
     * @param {number} row
     * @returns {{ kind:'sheet'} | { kind:'table-data', table:any, dataIndex:number } | { kind:'table-fixed' }}
     */
    #classifyRowForStructuralOp(row) {
        const owners = this.tableManager?.getRowOwners?.(row) ?? [];
        for (const o of owners) {
            if (o.rowType === 'header' || o.rowType === 'entry') return { kind: 'table-fixed' };
            if (o.rowType === 'data') return { kind: 'table-data', table: o.table, dataIndex: o.dataIndex };
        }
        return { kind: 'sheet' };
    }

    /** Insert a blank row before rowIndex */
    insertRowAt(rowIndex) {
        // Inserting INSIDE a table's data range should be a no-op at the sheet
        // level (table rows are managed via the table's entry form / pasteRows).
        // Inserting at the table header/entry row would orphan the table, so
        // also block. Inserting outside a table behaves normally.
        const cls = this.#classifyRowForStructuralOp(rowIndex);
        if (cls.kind !== 'sheet') return;
        this.activeSheetStore?.insertRowAt(rowIndex);
        selectionState.shiftForStructuralOp('row', rowIndex, +1);
    }

    /** Delete the row at rowIndex */
    deleteRowAt(rowIndex) {
        const cls = this.#classifyRowForStructuralOp(rowIndex);
        if (cls.kind === 'table-fixed') return; // refuse: would orphan the table
        if (cls.kind === 'table-data') {
            // Delete the table row instead of touching the sheet's row grid.
            // No sheet shift → no selection shift.
            cls.table.deleteRow(cls.dataIndex);
            return;
        }
        this.activeSheetStore?.deleteRowAt(rowIndex);
        selectionState.shiftForStructuralOp('row', rowIndex, -1);
    }

    /** Delete multiple rows in one transaction */
    deleteRowsAt(rowIndices) {
        // Partition into table-data rows (deleted from their tables) vs sheet
        // rows (deleted via the sheet store). Skip table-fixed rows.
        const tableTargets = new Map(); // table → number[] dataIndices
        const sheetRows = [];
        for (const r of rowIndices) {
            const cls = this.#classifyRowForStructuralOp(r);
            if (cls.kind === 'table-fixed') continue;
            if (cls.kind === 'table-data') {
                if (!tableTargets.has(cls.table)) tableTargets.set(cls.table, []);
                tableTargets.get(cls.table).push(cls.dataIndex);
            } else {
                sheetRows.push(r);
            }
        }
        // Delete table rows first — order independent because table.deleteRows
        // handles dedupe + descending sort internally.
        for (const [table, dataIndices] of tableTargets) {
            table.deleteRows(dataIndices);
        }
        if (sheetRows.length > 0) {
            this.activeSheetStore?.deleteRowsAt(sheetRows);
            const sorted = [...new Set(sheetRows)].sort((a, b) => b - a);
            for (const r of sorted) selectionState.shiftForStructuralOp('row', r, -1);
        }
    }

    /** Insert a blank column before colIndex */
    insertColumnAt(colIndex) {
        this.activeSheetStore?.insertColumnAt(colIndex);
        selectionState.shiftForStructuralOp('col', colIndex, +1);
    }

    /** Delete the column at colIndex */
    deleteColumnAt(colIndex) {
        this.activeSheetStore?.deleteColumnAt(colIndex);
        selectionState.shiftForStructuralOp('col', colIndex, -1);
    }

    /**
     * Get a range of cells for rendering
     * @param {number} startRow
     * @param {number} startCol
     * @param {number} endRow
     * @param {number} endCol
     * @returns {Map<string, Object>}
     */
    getCellRange(startRow, startCol, endRow, endCol) {
        const result = new Map();
        if (!this.activeSheetStore) return result;

        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                const cell = this.activeSheetStore.getCell(r, c);
                if (cell.exists) {
                    result.set(`${r},${c}`, cell);
                }
            }
        }

        return result;
    }

    // ========================================================================
    // SHEET OPERATIONS
    // ========================================================================

    /**
     * Add a new sheet
     * @param {string} name
     * @returns {string} New sheet ID
     */
    addSheet(name) {
        if (!this.root || !this.ydoc) return null;

        const sheets = this.root.get('sheets');
        const sheetOrder = this.root.get('sheetOrder');

        // Generate unique ID
        const id = `sheet-${Date.now()}`;

        let newSheet = null;
        this.ydoc.transact(() => {
            newSheet = createSheetYMap(this.ydoc, id, name);
            sheets.set(id, newSheet);
            sheetOrder.push([id]);
        }, YJS_ORIGIN.UI);

        // Extend the document-level UndoManager's scope to include the new
        // sheet's Y types so subsequent edits to this sheet are undoable.
        if (this.undoManager && newSheet) {
            const types = [
                newSheet,
                newSheet.get('cellValues'), newSheet.get('cellStyles'),
                newSheet.get('borders'),    newSheet.get('rowMeta'),
                newSheet.get('colMeta'),    newSheet.get('tableViews'),
                newSheet.get('repeaters'),  newSheet.get('merges'),
            ].filter(Boolean);
            for (const t of types) {
                try { this.undoManager.addToScope(t); } catch { /* already in scope */ }
            }
        }

        return id;
    }

    /**
     * Duplicate an existing sheet, inserting the copy immediately after the source.
     * @param {string} sheetId
     * @returns {string|null} New sheet ID
     */
    duplicateSheet(sheetId) {
        if (!this.root || !this.ydoc) return null;

        const sheets = this.root.get('sheets');
        const sheetOrder = this.root.get('sheetOrder');
        const srcSheet = sheets.get(sheetId);
        if (!srcSheet) return null;

        const srcName = srcSheet.get('name') ?? 'Sheet';
        const newName = `${srcName} (copy)`;
        const newId = `sheet-${Date.now()}`;

        // Copy Y.Array-backed YKeyValue stores by cloning their raw entries
        const copyArray = (srcKey) => {
            const src = srcSheet.get(srcKey);
            const dst = new (src.constructor)();
            if (src instanceof Y.Array && src.length > 0) {
                dst.insert(0, src.toArray());
            }
            return dst;
        };

        // Copy a Y.Map containing only primitive values (e.g. printSettings)
        const copyPrimitiveMap = (srcKey) => {
            const src = srcSheet.get(srcKey);
            const dst = new Y.Map();
            if (src instanceof Y.Map) {
                for (const [k, v] of src.entries()) {
                    if (typeof v !== 'object' || v === null) dst.set(k, v);
                }
            }
            return dst;
        };

        let newSheet = null;
        this.ydoc.transact(() => {
            newSheet = new Y.Map();
            newSheet.set('id',           newId);
            newSheet.set('name',         newName);
            newSheet.set('rowCount',     srcSheet.get('rowCount'));
            newSheet.set('colCount',     srcSheet.get('colCount'));
            newSheet.set('frozenRows',   srcSheet.get('frozenRows')   ?? 0);
            newSheet.set('frozenColumns',srcSheet.get('frozenColumns') ?? 0);
            newSheet.set('hidden',       srcSheet.get('hidden')        ?? false);

            const defRowH = srcSheet.get('defaultRowHeight');
            if (defRowH !== undefined) newSheet.set('defaultRowHeight', defRowH);
            const defColW = srcSheet.get('defaultColWidth');
            if (defColW !== undefined) newSheet.set('defaultColWidth', defColW);
            const tabColor = srcSheet.get('tabColor');
            if (tabColor !== undefined) newSheet.set('tabColor', tabColor);

            newSheet.set('cellValues',        copyArray('cellValues'));
            newSheet.set('cellStyles',        copyArray('cellStyles'));
            newSheet.set('borders',           copyArray('borders'));
            newSheet.set('rowMeta',           copyArray('rowMeta'));
            newSheet.set('colMeta',           copyArray('colMeta'));
            newSheet.set('merges',            copyArray('merges'));
            newSheet.set('conditionalFormats',copyArray('conditionalFormats'));
            newSheet.set('dataValidations',   copyArray('dataValidations'));
            newSheet.set('printSettings',     copyPrimitiveMap('printSettings'));
            newSheet.set('tableViews',        new Y.Map());
            newSheet.set('repeaters',         new Y.Map());
            newSheet.set('plugins',           new Y.Map());

            sheets.set(newId, newSheet);

            // Insert immediately after the source sheet
            const srcIndex = sheetOrder.toArray().indexOf(sheetId);
            sheetOrder.insert(srcIndex + 1, [newId]);
        }, YJS_ORIGIN.UI);

        if (this.undoManager && newSheet) {
            const types = [
                newSheet,
                newSheet.get('cellValues'), newSheet.get('cellStyles'),
                newSheet.get('borders'),    newSheet.get('rowMeta'),
                newSheet.get('colMeta'),    newSheet.get('tableViews'),
                newSheet.get('repeaters'),  newSheet.get('merges'),
            ].filter(Boolean);
            for (const t of types) {
                try { this.undoManager.addToScope(t); } catch { /* already in scope */ }
            }
        }

        return newId;
    }

    /**
     * Delete a sheet
     * @param {string} sheetId
     */
    deleteSheet(sheetId) {
        if (!this.root || !this.ydoc) return;

        const sheets = this.root.get('sheets');
        const sheetOrder = this.root.get('sheetOrder');

        // Don't delete the last sheet
        if (sheetOrder.length <= 1) return;

        const wasActive = this.activeSheetId === sheetId;

        // If deleting the active sheet, switch away FIRST so the engines/observers
        // for the deleted sheet are torn down (or cached) cleanly. Otherwise the
        // active SheetStore + formula engine would keep observing a detached Y.Map.
        if (wasActive) {
            const idx = sheetOrder.toArray().indexOf(sheetId);
            const fallbackIdx = idx === 0 ? 1 : 0;
            const fallbackId = sheetOrder.get(fallbackIdx);
            if (fallbackId) this.setActiveSheet(fallbackId);
        }

        // Evict the deleted sheet's cross-sheet YKeyValue wrapper so a future
        // sheet created with the same id (unlikely but harmless) starts fresh.
        this.#crossSheetKVCache.delete(sheetId);
        // Tear down any warmed cross-sheet engine for the deleted sheet.
        this.#dropCrossSheetEngine(sheetId);

        // Evict the deleted sheet from the engine cache so its dangling
        // SheetStore/formulaEngine/etc. are destroyed.
        const cached = this.#sheetEngineCache.get(sheetId);
        if (cached) {
            cached.cleanupFormulaObserver?.();
            cached.sheetStore.destroy();
            cached.tableManager?.destroy();
            cached.renderContext?.destroy();
            cached.repeaterEngine?.destroy();
            this.#sheetEngineCache.delete(sheetId);
            this.#sheetEngineCacheOrder = this.#sheetEngineCacheOrder.filter(id => id !== sheetId);
        }

        this.ydoc.transact(() => {
            sheets.delete(sheetId);
            const index = sheetOrder.toArray().indexOf(sheetId);
            if (index !== -1) sheetOrder.delete(index, 1);
        }, YJS_ORIGIN.UI);
    }

    /**
     * Move a sheet to a new index in sheetOrder.
     * @param {string} sheetId
     * @param {number} toIndex
     */
    moveSheet(sheetId, toIndex) {
        if (!this.root || !this.ydoc) return;

        const sheetOrder = this.root.get('sheetOrder');
        if (!sheetOrder) return;

        const arr = sheetOrder.toArray();
        const fromIndex = arr.indexOf(sheetId);
        if (fromIndex === -1 || fromIndex === toIndex) return;

        const clampedTo = Math.max(0, Math.min(toIndex, arr.length - 1));

        this.ydoc.transact(() => {
            sheetOrder.delete(fromIndex, 1);
            sheetOrder.insert(clampedTo, [sheetId]);
        }, YJS_ORIGIN.UI);
    }

    /**
     * Rename a sheet, atomically rewriting all formulas that reference it
     * (cross-sheet refs in cell values AND in table column DSL formulas).
     * @param {string} sheetId
     * @param {string} name
     */
    renameSheet(sheetId, name) {
        if (!this.root || !this.ydoc) return;

        const sheets = this.root.get('sheets');
        const sheet = sheets?.get(sheetId);
        if (!sheet) return;

        const oldName = sheet.get('name');
        if (oldName === name) return;

        this.ydoc.transact(() => {
            sheet.set('name', name);
            if (!oldName) return;
            this.#rewriteSheetRefsAcrossDoc(oldName, name);
        }, YJS_ORIGIN.UI);
    }

    /**
     * Walk every cellValues map on every sheet, and every table column's
     * defaultFormula/formula, rewriting cross-sheet references that match
     * `oldName`. Called inside a Yjs transaction by renameSheet so the entire
     * rewrite is one atomic update.
     * @param {string} oldName
     * @param {string} newName
     */
    #rewriteSheetRefsAcrossDoc(oldName, newName) {
        const sheetsMap = this.root?.get('sheets');
        sheetsMap?.forEach((s) => {
            const cvArr = s.get('cellValues');
            if (!cvArr) return;
            const cvKV = new YKeyValue(cvArr);
            for (const [key, { val: data }] of cvKV.map) {
                const v = data?.v;
                if (typeof v !== 'string' || !v.startsWith('=')) continue;
                const rewritten = rewriteSheetRefsInFormula(v, oldName, newName);
                if (rewritten !== v) cvKV.set(key, { ...data, v: rewritten });
            }
        });

        // Table column formulas (defaultFormula + formula): these are DSL strings
        // that may embed sheet refs. Rewrite both source tables and the
        // historical pre-tableData column defs on view tables.
        const tableData = this.root?.get('tableData');
        tableData?.forEach((tableYMap) => this.#rewriteTableColumnRefs(tableYMap, oldName, newName, 'sheet'));
        sheetsMap?.forEach((s) => {
            const views = s.get('tableViews');
            views?.forEach((tableYMap) => this.#rewriteTableColumnRefs(tableYMap, oldName, newName, 'sheet'));
        });
    }

    /**
     * Rewrite column-level DSL formulas inside one table Y.Map.
     * @param {import('yjs').Map<any>} tableYMap
     * @param {string} oldName
     * @param {string} newName
     * @param {'sheet'|'table'} kind
     */
    #rewriteTableColumnRefs(tableYMap, oldName, newName, kind) {
        const defsMap = tableYMap.get('columnDefs');
        if (!defsMap) return;
        const rewriteFn = kind === 'sheet' ? rewriteSheetRefsInDslColumn : rewriteTableRefsInDslColumn;
        defsMap.forEach((colYMap) => {
            for (const field of ['defaultFormula', 'formula']) {
                const cur = colYMap.get(field);
                if (typeof cur !== 'string' || !cur) continue;
                const next = rewriteFn(cur, oldName, newName);
                if (next !== cur) colYMap.set(field, next);
            }
        });
    }

    // ========================================================================
    // METADATA OPERATIONS
    // ========================================================================

    /**
     * Get document metadata
     * @returns {Object}
     */
    getMetadata() {
        return this.metadata;
    }

    /**
     * Set document metadata field
     * @param {string} key
     * @param {any} value
     */
    setMetadata(key, value) {
        if (!this.root || !this.ydoc) return;
        const metadata = this.root.get('metadata');
        if (!metadata) return;
        this.ydoc.transact(() => metadata.set(key, value), YJS_ORIGIN.UI);
    }

    // ========================================================================
    // NAMED RANGES
    // ========================================================================

    /**
     * Get all named ranges
     * @returns {Object}
     */
    getNamedRanges() {
        if (!this.root) return {};
        const namedRanges = this.root.get('namedRanges');
        return namedRanges ? namedRanges.toJSON() : {};
    }

    /**
     * Add a named range
     * @param {string} name
     * @param {Object} range
     */
    addNamedRange(name, range) {
        if (!this.root || !this.ydoc) return;
        const namedRanges = this.root.get('namedRanges');
        if (!namedRanges) return;
        this.ydoc.transact(() => {
            const rangeMap = new Y.Map();
            rangeMap.set('sheetId', range.sheetId);
            rangeMap.set('startRow', range.startRow);
            rangeMap.set('startCol', range.startCol);
            rangeMap.set('endRow', range.endRow);
            rangeMap.set('endCol', range.endCol);
            if (range.comment) rangeMap.set('comment', range.comment);
            namedRanges.set(name, rangeMap);
        }, YJS_ORIGIN.UI);
    }

    /**
     * Delete a named range
     * @param {string} name
     */
    deleteNamedRange(name) {
        if (!this.root || !this.ydoc) return;
        const namedRanges = this.root.get('namedRanges');
        if (!namedRanges) return;
        this.ydoc.transact(() => namedRanges.delete(name), YJS_ORIGIN.UI);
    }

    /**
     * Set up observer for awareness state changes (remote cursors)
     */
    #setupAwarenessObserver() {
        if (!this.awareness) return;

        const observer = () => {
            this.remoteSelections = this.getRemoteSelections();
        };

        this.awareness.on('change', observer);

        // Periodically evict stale entries (e.g. crashed tabs that never sent
        // a clean disconnect and whose awareness state is past the expiry window).
        const staleSweepInterval = setInterval(observer, 10_000);

        // Initial sync
        observer();

        this.#cleanupAwarenessObserver = () => {
            this.awareness?.off('change', observer);
            clearInterval(staleSweepInterval);
        };
    }

    /**
     * Set up observer for undo manager state changes
     */
    #setupUndoObserver() {
        if (!this.undoManager) return;

        // Update reactive state immediately
        this.#canUndo = this.undoManager.canUndo();
        this.#canRedo = this.undoManager.canRedo();

        // Listen for stack changes
        const observer = () => {
            this.#canUndo = this.undoManager?.canUndo() || false;
            this.#canRedo = this.undoManager?.canRedo() || false;
        };

        this.undoManager.on('stack-item-added', observer);
        this.undoManager.on('stack-item-popped', observer);
        this.undoManager.on('stack-item-updated', observer);
        this.undoManager.on('stack-cleared', observer);

        this.#cleanupUndoObserver = () => {
            this.undoManager?.off('stack-item-added', observer);
            this.undoManager?.off('stack-item-popped', observer);
            this.undoManager?.off('stack-item-updated', observer);
            this.undoManager?.off('stack-cleared', observer);
        };
    }

    // ========================================================================
    // UNDO/REDO
    // ========================================================================

    get canUndo() {
        return this.#canUndo;
    }

    get canRedo() {
        return this.#canRedo;
    }

    undo() {
        this.undoManager?.undo();
    }

    redo() {
        this.undoManager?.redo();
    }

    // ========================================================================
    // COLLABORATION
    // ========================================================================

    /**
     * Set local user's cursor/selection in awareness
     * @param {Object} selection
     */
    setLocalSelection(selection) {
        if (!this.awareness) return;

        this.awareness.setLocalStateField('selection', {
            ...selection,
            user: get(authStore).user?.username || 'anonymous',
            sheetId: this.activeSheetId,
            ts: Date.now(),
        });
    }

    /**
     * Get remote users' selections, filtered to the active sheet.
     * Entries older than AWARENESS_EXPIRY_MS are treated as stale and dropped,
     * so crashed tabs eventually disappear even without a clean disconnect.
     * @returns {Array}
     */
    getRemoteSelections() {
        if (!this.awareness) return [];

        const EXPIRY_MS = 30_000;
        const now = Date.now();
        const localClientId = this.awareness.clientID;
        const states = Array.from(this.awareness.getStates().entries());

        return states
            .filter(([clientId, state]) => {
                if (clientId === localClientId) return false;
                const sel = state?.selection;
                if (!sel?.sheetId) return false;
                // Drop entries with no timestamp or that are too old
                if (sel.ts != null && now - sel.ts > EXPIRY_MS) return false;
                return true;
            })
            .map(([clientId, state]) => ({
                clientId,
                color: state.user?.color,
                ...state.selection,
            }))
            .filter(s => s.sheetId === this.activeSheetId);
    }
}

// ============================================================================
// SINGLETON INSTANCES
// ============================================================================

export const spreadsheetSession = new SpreadsheetSession();

// ============================================================================
// STORAGE INTEGRATION
// ============================================================================

let isInitialized = false;
let initPromise = null;

/**
 * Initialize the spreadsheet store
 */
export async function initializeSpreadsheet() {
    if (initPromise) return initPromise;
    if (isInitialized) return true;

    initPromise = (async () => {
        await storage.init();

        storage.on('auth-error', () => {
            authStore.logout();
        });

        isInitialized = true;
        return true;
    })();

    try {
        return await initPromise;
    } finally {
        initPromise = null;
    }
}

/**
 * Get the Storage instance
 */
export function getStorage() {
    return storage;
}

/**
 * Get all documents (Yjs files belonging to this app)
 */
export function getAllDocuments() {
    // Filter to only Yjs files belonging to the scriptorium app
    return storage.drive.listFiles().filter(f => f.type === 'yjs');
}

/**
 * Create a new spreadsheet document
 * Explicitly initializes the Yjs document structure at creation time,
 * preventing race conditions with offline clients.
 *
 * Tags app: APP_SHEETS explicitly, matching DriveBrowser's "+ New Spreadsheet"
 * button (the actual live creation path) — without it, router.svelte.js#openFile
 * still resolves the file correctly via DEFAULT_APP, but anything that lists
 * files by app id (e.g. spreadsheet-api's file listing) would miss it. This
 * function has no current call sites but is exported through the public
 * barrel, so it's worth keeping correct rather than a latent gap.
 * @param {string} title
 */
export async function createDocument(title) {
    return storage.drive.createAndInitializeFile({
        title,
        app: APP_SHEETS,
        initializer: (ydoc) => {
            initializeDocument(ydoc);
        }
    });
}

/**
 * Delete a document
 * @param {string} docId
 */
export async function deleteDocument(docId) {
    return storage.drive.deleteFile(docId);
}

/**
 * Rename a document
 * @param {string} docId
 * @param {string} title
 */
export async function renameDocument(docId, title) {
    return storage.drive.renameFile(docId, title);
}

/**
 * Load a document into the session
 * @param {string} docId
 */
export async function loadDocument(docId) {
    return spreadsheetSession.load(docId);
}

/**
 * Unload the current document
 */
export async function unloadDocument() {
    return spreadsheetSession.unload();
}

/**
 * Cleanup on app shutdown
 */
export function cleanupSpreadsheet() {
    spreadsheetSession.unload();
    storage.shutdown();
    // Reset initialization state so next init actually runs storage.init()
    isInitialized = false;
    initPromise = null;
}

export default SpreadsheetSession;
