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
import { storage } from '../storage.js';
import { authStore } from '../authStore.js';
import { get } from 'svelte/store';
import { SheetStore } from './SheetStore.svelte.js';
import { spreadsheetSchema, createSheetYMap, initializeDocument } from './schema.js';
import { SCHEMA_VERSION, META_KEYS, CELL_KEYS } from './constants.js';
import { FormulaEngine } from '../../formulas/FormulaEngine.svelte.js';
import { parseFormula } from '../../formulas/parser.js';
import { evaluate } from '../../formulas/evaluator.js';
import { FormulaError } from '../../formulas/functions.js';
import { ExternalDocManager } from './ExternalDocManager.js';
import { SheetRenderContext } from './features/SheetRenderContext.svelte.js';
import { TableManager } from './features/TableManager.svelte.js';
import { DocumentTableRegistry } from './features/DocumentTableRegistry.svelte.js';
import { RepeaterEngine } from './features/RepeaterEngine.svelte.js';

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

    /** @type {Function | null} Cleanup for formula engine observer */
    #cleanupFormulaObserver = null;

    /** @type {SheetRenderContext | null} */
    renderContext = $state.raw(null);

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

    /** @type {Promise | null} Lock for preventing concurrent loads */
    #loadPromise = null;

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
        console.log('[SpreadsheetSession] load() called with docId:', docId);

        // Wait for any existing load to complete
        if (this.#loadPromise) {
            console.log('[SpreadsheetSession] Waiting for existing load to complete...');
            await this.#loadPromise;
        }

        if (this.docId === docId && this.ydoc) {
            console.log('[SpreadsheetSession] Already loaded, returning early');
            return; // Already loaded
        }

        // Start new load with lock
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

        console.log('[SpreadsheetSession] Starting document load...');

        try {
            // Cleanup previous session
            console.log('[SpreadsheetSession] Unloading previous session...');
            await this.unload();
            console.log('[SpreadsheetSession] Previous session unloaded');

            // Load the document using the new Storage facade
            console.log('[SpreadsheetSession] Calling storage.drive.loadDoc()...');
            const ydoc = await storage.drive.loadDoc(docId);
            console.log('[SpreadsheetSession] storage.drive.loadDoc() returned');

            const root = ydoc.getMap('spreadsheet');
            console.log('[SpreadsheetSession] Got root map');

            // Ensure document structure exists (idempotent — skips if already initialized).
            // This handles documents loaded on a fresh client before sync, or documents
            // created with an older API that didn't explicitly initialize the schema.
            spreadsheetSchema.initialize(ydoc);

            this.docId = docId;
            this.ydoc = ydoc;
            this.root = root;
            console.log('[SpreadsheetSession] Set docId, ydoc, root');

            // Set up observers for reactivity
            this.#setupObservers();

            // Set up undo manager and active sheet
            console.log('[SpreadsheetSession] Setting up undo manager...');
            const sheets = root.get('sheets');
            const sheetOrder = root.get('sheetOrder');
            const firstSheetId = sheetOrder?.get(0) || 'sheet-1';
            console.log('[SpreadsheetSession] First sheet ID:', firstSheetId);

            this.activeSheetId = firstSheetId;

            // Create SheetStore for active sheet
            const activeSheet = sheets?.get(firstSheetId);
            if (activeSheet) {
                this.activeSheetStore = new SheetStore(activeSheet, ydoc);

                // Initialize undo manager — track all mutable Y types for this sheet.
                // Ensure rowMeta/colMeta/tables/repeaters exist (older docs may lack them).
                const cells = activeSheet.get('cells');
                const borders = activeSheet.get('borders');
                let rowMeta0 = activeSheet.get('rowMeta');
                if (!rowMeta0) { rowMeta0 = new Y.Map(); activeSheet.set('rowMeta', rowMeta0); }
                let colMeta0 = activeSheet.get('colMeta');
                if (!colMeta0) { colMeta0 = new Y.Map(); activeSheet.set('colMeta', colMeta0); }
                let tables0 = activeSheet.get('tables');
                if (!tables0) { tables0 = new Y.Map(); activeSheet.set('tables', tables0); }
                let repeaters0 = activeSheet.get('repeaters');
                if (!repeaters0) { repeaters0 = new Y.Map(); activeSheet.set('repeaters', repeaters0); }
                if (cells) {
                    // UndoManager tracks all local changes by default (origin=null)
                    this.undoManager = new Y.UndoManager([cells, borders, rowMeta0, colMeta0, tables0, repeaters0]);

                    // Set up observer to update reactive undo/redo state
                    this.#setupUndoObserver();
                }

                // Create document-wide table registry before TableManager so the
                // manager can borrow stores instead of creating duplicates.
                this.tableRegistry = new DocumentTableRegistry(root, ydoc);
                // When any table (any sheet) changes → recalculate TABLE_* formula cells.
                this.tableRegistry.onTableChange = () => {
                    this.formulaEngine?.recalculateTableDependents();
                };

                // Create TableManager before formula engine so TABLE_* functions are
                // registered before formulas are evaluated on first load.
                this.tableManager = new TableManager(activeSheet, ydoc, this.tableRegistry);

                // Initialize formula engine for the active sheet (registers tableManager functions first)
                this.#initializeFormulaEngine(activeSheet, this.tableManager);

                // Create SheetRenderContext (after formula engine is ready)
                this.renderContext = new SheetRenderContext(this.activeSheetStore, ydoc, this);
                this.renderContext.tableManager = this.tableManager;

                // Initialize RepeaterEngine and wire into renderContext
                this.repeaterEngine = new RepeaterEngine(activeSheet, ydoc);
                this.renderContext.repeaterEngine = this.repeaterEngine;
            }
            console.log('[SpreadsheetSession] Undo manager set up');

            // Set up awareness (for collaboration)
            console.log('[SpreadsheetSession] Setting up awareness...');
            const provider = storage._runtime?.activeDocs?.get(docId)?.provider;
            if (provider) {
                this.awareness = provider.awareness;
                this.#setupAwarenessObserver();
            }
            console.log('[SpreadsheetSession] Awareness set up');

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
            console.log('[SpreadsheetSession] Setting isLoading=false');
            this.isLoading = false;
            console.log('[SpreadsheetSession] Document load complete');
        }
    }

    /**
     * Unload the current document
     */
    async unload() {
        // Cleanup awareness observer
        if (this.#cleanupAwarenessObserver) {
            this.#cleanupAwarenessObserver();
            this.#cleanupAwarenessObserver = null;
        }
        this.remoteSelections = [];

        // Cleanup undo observer
        if (this.#cleanupUndoObserver) {
            this.#cleanupUndoObserver();
            this.#cleanupUndoObserver = null;
        }

        // Cleanup formula engine
        if (this.#cleanupFormulaObserver) {
            this.#cleanupFormulaObserver();
            this.#cleanupFormulaObserver = null;
        }
        if (this.formulaEngine) {
            this.formulaEngine.clear();
            this.formulaEngine = null;
        }

        // Cleanup external doc manager
        if (this.#externalDocManager) {
            this.#externalDocManager.destroy();
            this.#externalDocManager = null;
        }

        // Cleanup TableManager
        if (this.tableManager) {
            this.tableManager.destroy();
            this.tableManager = null;
        }

        // Cleanup TableRegistry (after TableManager so borrowed stores are released first)
        if (this.tableRegistry) {
            this.tableRegistry.destroy();
            this.tableRegistry = null;
        }

        // Cleanup RepeaterEngine
        if (this.repeaterEngine) {
            this.repeaterEngine.destroy();
            this.repeaterEngine = null;
        }

        // Cleanup SheetRenderContext
        if (this.renderContext) {
            this.renderContext.destroy();
            this.renderContext = null;
        }

        // Cleanup SheetStore
        if (this.activeSheetStore) {
            this.activeSheetStore.destroy();
            this.activeSheetStore = null;
        }

        // Cleanup observers
        if (this.#cleanupObserver) {
            this.#cleanupObserver();
            this.#cleanupObserver = null;
        }

        // Cleanup storage listener
        if (this.#cleanupStorageListener) {
            this.#cleanupStorageListener();
            this.#cleanupStorageListener = null;
        }

        // Reset state
        this.docId = null;
        this.ydoc = null;
        this.root = null;
        this.activeSheetId = null;
        this.undoManager = null;
        this.awareness = null;
        this.sheets = [];
        this.metadata = {};
        this.docTitle = '';
        this.#canUndo = false;
        this.#canRedo = false;
    }

    /**
     * Set up observers for Yjs changes
     */
    #setupObservers() {
        if (!this.root) return;

        // Observer for document structure (Sheets list)
        const structureObserver = () => {
            this.#updateSheetsList();
        };

        // Observer for metadata changes
        const metadataObserver = () => {
            this.#updateMetadata();
        };

        // Observe the sheetOrder array and sheets map
        let sheetOrder = this.root.get('sheetOrder');
        let sheetsMap = this.root.get('sheets');

        sheetOrder?.observe(structureObserver);
        sheetsMap?.observeDeep(structureObserver);

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
                sheetsMap.observeDeep(structureObserver);
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
            sheetsMap?.unobserveDeep(structureObserver);
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
        tableManager?.registerFunctions(this.formulaEngine, this);

        // Register IMPORTRANGE as a custom function, closing over the manager.
        const extMgr = this.#externalDocManager;
        this.formulaEngine.registerFunction('IMPORTRANGE', (fileIdOrUrl, rangeStr) => {
            if (typeof fileIdOrUrl !== 'string' && typeof fileIdOrUrl !== 'number') return FormulaError.VALUE;
            if (typeof rangeStr !== 'string') return FormulaError.VALUE;
            return extMgr.getRange(String(fileIdOrUrl), rangeStr);
        });

        // Set up cell value getter - returns raw cell values from Yjs
        this.formulaEngine.setCellValueGetter((row, col) => {
            // Check table cells first — they store data in TableStore rows, not sheet cells
            if (this.tableManager) {
                const info = this.tableManager.getCellInfo(row, col);
                if (info?.table && info.rowType === 'data' && info.colDef) {
                    const rawVal = info.table.sortedFilteredRows[info.dataIndex]?.[info.colDef?.['id']];
                    if (typeof rawVal === 'string' && rawVal.startsWith('=')) return null;
                    return rawVal ?? null;
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

        // Set up cross-sheet getter — resolves SheetName!CellRef references at eval time.
        // Reads raw Yjs data from the target sheet and recursively evaluates formula chains.
        // extMgr is captured from the enclosing scope (registered above).
        const crossSheetCustomFns = extMgr ? new Map([['IMPORTRANGE', (fileIdOrUrl, rangeStr) => {
            if (typeof fileIdOrUrl !== 'string' && typeof fileIdOrUrl !== 'number') return FormulaError.VALUE;
            if (typeof rangeStr !== 'string') return FormulaError.VALUE;
            return extMgr.getRange(String(fileIdOrUrl), rangeStr);
        }]]) : null;

        this.formulaEngine.setCrossSheetGetter((sheetName, row, col) => {
            const targetSheet = this.sheets.find(s => s.name === sheetName);
            if (!targetSheet) return FormulaError.REF;

            const sheetsMap = this.root?.get('sheets');
            const sheetYMap = sheetsMap?.get(targetSheet.id);
            if (!sheetYMap) return FormulaError.REF;

            const cells = sheetYMap.get('cells');
            if (!cells) return null;

            // Recursive evaluator with cycle detection via visited set.
            // Handles arbitrary-depth formula chains within the target sheet,
            // including IMPORTRANGE (available via crossSheetCustomFns).
            const evalCell = (r, c, visited) => {
                const k = `${r},${c}`;
                if (visited.has(k)) return FormulaError.REF; // Circular ref
                const cm = cells.get(k);
                if (!cm) {
                    // No Yjs data — may be a spill cell from an array formula anchor.
                    return findSpillValue(r, c, visited);
                }
                const v = cm.get?.(CELL_KEYS.VALUE);
                if (v === undefined || v === null) return null;
                if (typeof v === 'string' && v.startsWith('=')) {
                    const nextVisited = new Set(visited);
                    nextVisited.add(k);
                    try {
                        const ast = parseFormula(v);
                        if (!ast) return null;
                        const result = evaluate(ast, (gr, gc) => evalCell(gr, gc, nextVisited), {}, crossSheetCustomFns, null);
                        // Array results (e.g. IMPORTRANGE) — return the scalar at the anchor position [0][0].
                        // Spill cells are handled separately by findSpillValue.
                        if (Array.isArray(result)) {
                            const arr2d = Array.isArray(result[0]) ? result : result.map(x => [x]);
                            return arr2d[0]?.[0] ?? null;
                        }
                        return result;
                    } catch {
                        return FormulaError.ERROR;
                    }
                }
                if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
                    return Number(v);
                }
                return v;
            };

            // Scan the target sheet for an array-formula anchor (e.g. IMPORTRANGE) whose
            // spill range covers (r,c), and return the element at the correct offset.
            // extMgr.getRange() returns cached data synchronously after the initial load.
            const findSpillValue = (r, c, visited) => {
                let found = null;
                cells.forEach((cm, anchorKey) => {
                    if (found !== null) return;
                    const parts = anchorKey.split(',');
                    const ar = Number(parts[0]);
                    const ac = Number(parts[1]);
                    if (ar > r || ac > c) return; // anchor must be at or before target cell
                    const v = cm.get?.(CELL_KEYS.VALUE);
                    if (typeof v !== 'string' || !v.startsWith('=')) return;
                    if (visited.has(anchorKey)) return;
                    try {
                        const ast = parseFormula(v);
                        if (!ast) return;
                        const nextVisited = new Set(visited);
                        nextVisited.add(anchorKey);
                        const result = evaluate(ast, (gr, gc) => evalCell(gr, gc, nextVisited), {}, crossSheetCustomFns, null);
                        if (!Array.isArray(result)) return;
                        const arr2d = Array.isArray(result[0]) ? result : result.map(x => [x]);
                        const dr = r - ar;
                        const dc = c - ac;
                        if (dr === 0 && dc === 0) return; // anchor itself — handled by evalCell directly
                        if (dr < arr2d.length && dc < (arr2d[0]?.length ?? 0)) {
                            found = arr2d[dr][dc] ?? null;
                        }
                    } catch {
                        // ignore errors from non-array formulas
                    }
                });
                return found;
            };

            return evalCell(row, col, new Set());
        });

        // Load existing formulas from the sheet and compute initial values
        const cells = sheet.get('cells');
        if (cells) {
            // First pass: load all formulas into the engine
            const formulaCells = [];
            cells.forEach((cellYMap, key) => {
                const v = cellYMap.get?.(CELL_KEYS.VALUE);
                if (typeof v === 'string' && v.startsWith('=')) {
                    const [row, col] = key.split(',').map(Number);
                    formulaCells.push({ key, row, col, formula: v });
                }
            });

            // Second pass: register all formulas and build the dependency graph.
            // setFormula evaluates each formula immediately, but in arbitrary order —
            // dependent cells may not be in computedValues yet, producing stale values.
            for (const { row, col, formula } of formulaCells) {
                this.formulaEngine.setFormula(row, col, formula);
            }

            // Third pass: recalculate all formula cells in topological (dependency) order
            // so that chains like A1=10, B1=A1+5, C1=B1*2 all resolve correctly.
            // graph.setFormula marks every cell dirty, so recalculateDirty covers them all.
            this.formulaEngine.recalculateDirty();
        }

        // Scan table cells for formula values stored in table row data
        if (tableManager) {
            for (const table of tableManager.stores.values()) {
                const dataStart = table.startRow + 2;
                const rows = table.sortedFilteredRows;
                for (let i = 0; i < rows.length; i++) {
                    table.columns.forEach((colDef, colIdx) => {
                        if (colDef.isNonEntry) return;
                        const val = rows[i]?.[colDef.id];
                        if (typeof val === 'string' && val.startsWith('=')) {
                            this.formulaEngine.setFormula(dataStart + i, table.startCol + colIdx, val);
                        }
                    });
                }
            }
            this.formulaEngine.recalculateDirty();
        }

        // Observe cell changes for formula recalculation
        if (cells) {
            const observer = (events) => {
                if (!this.formulaEngine) return;

                // Collect all changes to process
                const formulasToSet = [];
                const formulasToClear = [];
                const valueChanges = [];

                // Track cell keys handled by top-level events so deep events don't double-process
                // them. When a new cell Y.Map is added to the cells map, Yjs fires BOTH a
                // top-level 'add' event on cells AND a deep 'v add' event on the inner Y.Map.
                // We process the top-level event and skip the redundant deep one.
                const topLevelHandled = new Set();

                for (const event of events) {
                    // Top-level: change to the cells Y.Map itself (cell added/deleted/replaced)
                    if (!event.path || event.path.length === 0) {
                        if (event.changes.keys) {
                            event.changes.keys.forEach((change, key) => {
                                if (change.action === 'add' || change.action === 'update') {
                                    topLevelHandled.add(key);
                                    const cellYMap = cells.get(key);
                                    const v = cellYMap?.get?.(CELL_KEYS.VALUE);
                                    if (typeof v === 'string' && v.startsWith('=')) {
                                        const [row, col] = key.split(',').map(Number);
                                        formulasToSet.push({ row, col, formula: v });
                                    }
                                } else if (change.action === 'delete') {
                                    topLevelHandled.add(key);
                                    const [row, col] = key.split(',').map(Number);
                                    formulasToClear.push({ row, col });
                                }
                            });
                        }
                    }

                    // Deep: change to a property inside an existing cell Y.Map
                    if (event.path && event.path.length > 0 && event.changes.keys) {
                        const cellKey = event.path[0];
                        // Skip if the top-level event already handled this cell (e.g. new cell creation)
                        if (topLevelHandled.has(cellKey)) continue;

                        const hasValueChange = event.changes.keys.has(CELL_KEYS.VALUE);
                        if (hasValueChange) {
                            const [row, col] = cellKey.split(',').map(Number);
                            const cellYMap = cells.get(cellKey);
                            const v = cellYMap?.get?.(CELL_KEYS.VALUE);
                            if (typeof v === 'string' && v.startsWith('=')) {
                                formulasToSet.push({ row, col, formula: v });
                            } else {
                                // Value changed to a non-formula
                                formulasToClear.push({ row, col });
                                valueChanges.push({ row, col });
                            }
                        }
                    }
                }

                // Apply all formula changes
                for (const { row, col } of formulasToClear) {
                    this.formulaEngine.clearFormula(row, col);
                }

                for (const { row, col, formula } of formulasToSet) {
                    this.formulaEngine.setFormula(row, col, formula);
                }

                // Trigger dependent recalculation for non-formula value changes
                for (const { row, col } of valueChanges) {
                    this.formulaEngine.cellValueChanged(row, col);
                }

                // Re-evaluate all dirty formula cells in topological order. This ensures
                // correct results when e.g. IMPORTRANGE fills spill cells that other
                // formulas depend on, or when a batch paste brings in many interdependent
                // formulas at once.
                if (formulasToSet.length > 0) {
                    this.formulaEngine.recalculateDirty();
                }

                // Note: We do NOT write computed values back to Yjs!
                // The computed values are stored in the reactive formulaEngine.computedValues
            };

            cells.observeDeep(observer);

            // TABLE_* reactivity is now handled by DocumentTableRegistry.onTableChange,
            // which covers all sheets (not just the active one). No per-sheet observer needed.

            this.#cleanupFormulaObserver = () => {
                cells.unobserveDeep(observer);
            };
        }
    }

    /**
     * Switch to a different sheet
     * @param {string} sheetId
     */
    setActiveSheet(sheetId) {
        if (!this.root) return;

        const sheets = this.root.get('sheets');
        if (!sheets?.has(sheetId)) return;

        // Cleanup old undo observer
        if (this.#cleanupUndoObserver) {
            this.#cleanupUndoObserver();
            this.#cleanupUndoObserver = null;
        }

        // Cleanup old SheetStore
        if (this.activeSheetStore) {
            this.activeSheetStore.destroy();
            this.activeSheetStore = null;
        }

        this.activeSheetId = sheetId;

        // Refresh remote selections immediately — the awareness observer only
        // fires on awareness changes, not on local sheet switches, so stale
        // highlights from the previous sheet would linger otherwise.
        this.remoteSelections = this.getRemoteSelections();

        // Update SheetStore and undo manager for new sheet
        const sheet = sheets.get(sheetId);
        if (sheet && this.ydoc) {
            this.activeSheetStore = new SheetStore(sheet, this.ydoc);

            const cells = sheet.get('cells');
            const borders = sheet.get('borders');
            // Ensure all mutable Y types exist (older docs may lack some of them).
            let rowMeta = sheet.get('rowMeta');
            if (!rowMeta) { rowMeta = new Y.Map(); sheet.set('rowMeta', rowMeta); }
            let colMeta = sheet.get('colMeta');
            if (!colMeta) { colMeta = new Y.Map(); sheet.set('colMeta', colMeta); }
            let tables = sheet.get('tables');
            if (!tables) { tables = new Y.Map(); sheet.set('tables', tables); }
            let repeaters = sheet.get('repeaters');
            if (!repeaters) { repeaters = new Y.Map(); sheet.set('repeaters', repeaters); }

            if (cells) {
                // UndoManager tracks all local changes by default (origin=null)
                this.undoManager = new Y.UndoManager([cells, borders, rowMeta, colMeta, tables, repeaters]);

                // Set up observer to update reactive undo/redo state
                this.#setupUndoObserver();
            }

            // Reinitialize formula engine for new sheet
            if (this.#cleanupFormulaObserver) {
                this.#cleanupFormulaObserver();
                this.#cleanupFormulaObserver = null;
            }

            // Recreate feature engines for the new sheet
            if (this.tableManager) { this.tableManager.destroy(); }
            if (this.repeaterEngine) { this.repeaterEngine.destroy(); }
            if (this.renderContext) { this.renderContext.destroy(); }

            // Create TableManager before formula engine so TABLE_* functions are
            // registered before formulas are evaluated on sheet switch.
            this.tableManager = new TableManager(sheet, this.ydoc, this.tableRegistry);
            this.#initializeFormulaEngine(sheet, this.tableManager);

            this.renderContext = new SheetRenderContext(this.activeSheetStore, this.ydoc, this);
            this.repeaterEngine = new RepeaterEngine(sheet, this.ydoc);
            this.renderContext.tableManager = this.tableManager;
            this.renderContext.repeaterEngine = this.repeaterEngine;
        }
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

        const sheetsMap = this.root?.get('sheets');
        const sheetYMap = sheetsMap?.get(targetSheet.id);
        if (!sheetYMap) return FormulaError.REF;

        const cells = sheetYMap.get('cells');
        if (!cells) return null;

        const extMgr = this.#externalDocManager;
        const customFns = extMgr ? new Map([['IMPORTRANGE', (fileIdOrUrl, rangeStr) => {
            if (typeof fileIdOrUrl !== 'string' && typeof fileIdOrUrl !== 'number') return FormulaError.VALUE;
            if (typeof rangeStr !== 'string') return FormulaError.VALUE;
            return extMgr.getRange(String(fileIdOrUrl), rangeStr);
        }]]) : null;

        // Recursive evaluator with cycle detection via visited set.
        // Handles arbitrary-depth formula chains within the target sheet,
        // including IMPORTRANGE.
        const evalCell = (r, c, visited) => {
            const k = `${r},${c}`;
            if (visited.has(k)) return FormulaError.REF; // Circular ref
            const cm = cells.get(k);
            if (!cm) {
                // No Yjs data — may be a spill cell from an array formula anchor.
                return findSpillValue(r, c, visited);
            }
            const v = cm.get?.(CELL_KEYS.VALUE);
            if (v === undefined || v === null) return null;
            if (typeof v === 'string' && v.startsWith('=')) {
                const nextVisited = new Set(visited);
                nextVisited.add(k);
                try {
                    const ast = parseFormula(v);
                    if (!ast) return null;
                    const result = evaluate(ast, (gr, gc) => evalCell(gr, gc, nextVisited), {}, customFns, null);
                    if (Array.isArray(result)) {
                        const arr2d = Array.isArray(result[0]) ? result : result.map(x => [x]);
                        return arr2d[0]?.[0] ?? null;
                    }
                    return result;
                } catch {
                    return FormulaError.ERROR;
                }
            }
            if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
                return Number(v);
            }
            return v;
        };

        const findSpillValue = (r, c, visited) => {
            let found = null;
            cells.forEach((cm, anchorKey) => {
                if (found !== null) return;
                const parts = anchorKey.split(',');
                const ar = Number(parts[0]);
                const ac = Number(parts[1]);
                if (ar > r || ac > c) return;
                const v = cm.get?.(CELL_KEYS.VALUE);
                if (typeof v !== 'string' || !v.startsWith('=')) return;
                if (visited.has(anchorKey)) return;
                try {
                    const ast = parseFormula(v);
                    if (!ast) return;
                    const nextVisited = new Set(visited);
                    nextVisited.add(anchorKey);
                    const result = evaluate(ast, (gr, gc) => evalCell(gr, gc, nextVisited), {}, customFns, null);
                    if (!Array.isArray(result)) return;
                    const arr2d = Array.isArray(result[0]) ? result : result.map(x => [x]);
                    const dr = r - ar;
                    const dc = c - ac;
                    if (dr === 0 && dc === 0) return;
                    if (dr < arr2d.length && dc < (arr2d[0]?.length ?? 0)) {
                        found = arr2d[dr][dc] ?? null;
                    }
                } catch {
                    // ignore
                }
            });
            return found;
        };

        return evalCell(row, col, new Set());
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
        if (sheetId === this.activeSheetId) {
            const out = [];
            for (let r = startRow; r <= endRow; r++)
                for (let c = startCol; c <= endCol; c++)
                    out.push(this.getCellDisplayValue(r, c));
            return out;
        }

        const sheetYMap = this.root?.get('sheets')?.get(sheetId);
        if (!sheetYMap) return [];
        const cells = sheetYMap.get('cells');
        if (!cells) return [];

        // Temporary engine with the same IMPORTRANGE handler so cached data is reused
        const eng = new FormulaEngine();
        if (this.#externalDocManager) {
            const extMgr = this.#externalDocManager;
            eng.registerFunction('IMPORTRANGE', (fileIdOrUrl, rangeStr) => {
                if (typeof fileIdOrUrl !== 'string' && typeof fileIdOrUrl !== 'number') return FormulaError.VALUE;
                if (typeof rangeStr !== 'string') return FormulaError.VALUE;
                return extMgr.getRange(String(fileIdOrUrl), rangeStr);
            });
        }
        eng.setCellValueGetter((r, c) => {
            const cm = cells.get(`${r},${c}`);
            if (!cm) return null;
            const v = cm.get(CELL_KEYS.VALUE);
            if (typeof v === 'string' && v.startsWith('=')) return null;
            if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
            return v ?? null;
        });

        // Load all formula cells from this sheet
        cells.forEach((cm, key) => {
            const v = cm.get?.(CELL_KEYS.VALUE);
            if (typeof v === 'string' && v.startsWith('=')) {
                const [rs, cs] = key.split(',');
                eng.setFormula(parseInt(rs), parseInt(cs), v);
            }
        });
        eng.recalculateAll();

        // Extract the requested range
        const out = [];
        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                const key = `${r},${c}`;
                if (key in eng.computedValues) {
                    out.push(eng.computedValues[key]);
                } else {
                    const cm = cells.get(key);
                    const v = cm?.get?.(CELL_KEYS.VALUE);
                    if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) out.push(Number(v));
                    else out.push(v ?? null);
                }
            }
        }
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
        const sheetsMap = this.root.get('sheets');
        /** @type {{ tableName: string, sheetId: string, sheetName: string, columns: { id: string, name: string }[] }[]} */
        const result = [];
        for (const { id: sheetId, name: sheetName } of this.sheets) {
            const sheetYMap = sheetsMap?.get(sheetId);
            const tablesMap = sheetYMap?.get('tables');
            if (!tablesMap) continue;
            tablesMap.forEach((/** @type {import('yjs').Map<any>} */ tableYMap) => {
                // Skip view tables — they have no own column defs and shouldn't appear as
                // independent table sources in the configurator.
                if (tableYMap.get('sourceTableId')) return;
                const tableName = tableYMap.get('name') ?? 'Table';
                const defsMap = tableYMap.get('columnDefs');
                const orderArr = tableYMap.get('columnOrder');
                /** @type {{ id: string, name: string }[]} */
                const columns = [];
                if (defsMap && orderArr) {
                    for (const colId of orderArr.toArray()) {
                        const c = defsMap.get(colId);
                        if (c) columns.push({ id: colId, name: c.get?.('name') ?? colId });
                    }
                }
                result.push({ tableName, sheetId, sheetName, columns });
            });
        }
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
        // Use getColumn so formula columns are evaluated; deduplicate for dropdown use
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
     * The view is a new table entry that reads rows/columns from the source
     * but can show a different column subset and lives at its own grid position.
     *
     * @param {{
     *   sourceSheetId: string,
     *   sourceTableId: string,
     *   targetSheetId: string,
     *   name?: string,
     *   startRow?: number,
     *   startCol?: number,
     *   visibleColumns?: string[]
     * }} opts
     * @returns {string} new view tableId, or "" on failure
     */
    createTableViewOnSheet(opts) {
        if (!this.root || !this.ydoc) return "";
        const sheetsMap = this.root.get('sheets');
        const targetSheet = sheetsMap?.get(opts.targetSheetId);
        if (!targetSheet) return "";

        let tablesMap = targetSheet.get('tables');
        if (!tablesMap) {
            tablesMap = new Y.Map();
            targetSheet.set('tables', tablesMap);
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
            vm.set('sourceSheetId', opts.sourceSheetId);
            vm.set('sourceTableId', opts.sourceTableId);
            const visArr = new Y.Array();
            if (opts.visibleColumns?.length) visArr.push(opts.visibleColumns);
            vm.set('visibleColumns', visArr);
            tablesMap.set(viewId, vm);
        });
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
        const cells = sheet.get('cells');
        if (!cells) return;
        const key = `${row},${col}`;
        const normalized = formula.startsWith('=') ? formula : '=' + formula;
        this.ydoc.transact(() => {
            let cellMap = cells.get(key);
            if (!cellMap) {
                const newCell = new Y.Map();
                newCell.set('v', normalized);
                cells.set(key, newCell);
            } else {
                cellMap.set('v', normalized);
            }
        });
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
        const cells = sheet.get('cells');
        if (!cells) return;
        const key = `${row},${col}`;
        this.ydoc.transact(() => {
            if (value === '' || value === null || value === undefined) {
                const cellMap = cells.get(key);
                if (cellMap) cells.delete(key);
            } else {
                let cellMap = cells.get(key);
                if (!cellMap) {
                    const newCell = new Y.Map();
                    newCell.set('v', value);
                    cells.set(key, newCell);
                } else {
                    cellMap.set('v', value);
                }
            }
        });
    }

    /**
     * Clear a cell
     * @param {number} row
     * @param {number} col
     */
    clearCell(row, col) {
        this.activeSheetStore?.clearCell(row, col);
    }

    /** Insert a blank row before rowIndex */
    insertRowAt(rowIndex) {
        this.activeSheetStore?.insertRowAt(rowIndex);
    }

    /** Delete the row at rowIndex */
    deleteRowAt(rowIndex) {
        this.activeSheetStore?.deleteRowAt(rowIndex);
    }

    /** Insert a blank column before colIndex */
    insertColumnAt(colIndex) {
        this.activeSheetStore?.insertColumnAt(colIndex);
    }

    /** Delete the column at colIndex */
    deleteColumnAt(colIndex) {
        this.activeSheetStore?.deleteColumnAt(colIndex);
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

        this.ydoc.transact(() => {
            const newSheet = createSheetYMap(this.ydoc, id, name);
            sheets.set(id, newSheet);
            sheetOrder.push([id]);
        });

        return id;
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

        this.ydoc.transact(() => {
            sheets.delete(sheetId);

            // Remove from order
            const index = sheetOrder.toArray().indexOf(sheetId);
            if (index !== -1) {
                sheetOrder.delete(index, 1);
            }
        });

        // Switch to first sheet if deleted active
        if (this.activeSheetId === sheetId) {
            this.activeSheetId = sheetOrder.get(0);
        }
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
        });
    }

    /**
     * Rename a sheet
     * @param {string} sheetId
     * @param {string} name
     */
    renameSheet(sheetId, name) {
        if (!this.root || !this.ydoc) return;

        const sheets = this.root.get('sheets');
        const sheet = sheets?.get(sheetId);

        if (sheet) {
            this.ydoc.transact(() => {
                sheet.set('name', name);
            });
        }
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
        if (!this.root) return;
        const metadata = this.root.get('metadata');
        if (metadata) {
            metadata.set(key, value);
        }
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
        if (namedRanges) {
            const rangeMap = new Y.Map();
            rangeMap.set('sheetId', range.sheetId);
            rangeMap.set('startRow', range.startRow);
            rangeMap.set('startCol', range.startCol);
            rangeMap.set('endRow', range.endRow);
            rangeMap.set('endCol', range.endCol);
            if (range.comment) rangeMap.set('comment', range.comment);
            namedRanges.set(name, rangeMap);
        }
    }

    /**
     * Delete a named range
     * @param {string} name
     */
    deleteNamedRange(name) {
        if (!this.root) return;
        const namedRanges = this.root.get('namedRanges');
        if (namedRanges) {
            namedRanges.delete(name);
        }
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
        console.log('[SpreadsheetStore] Starting initialization...');
        const startTime = performance.now();

        await storage.init();

        // Subscribe to auth errors after initialization
        storage.on('auth-error', () => {
            authStore.logout();
        });

        isInitialized = true;

        console.log(`[SpreadsheetStore] Initialization complete in ${Math.round(performance.now() - startTime)}ms`);
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
    // Filter to only Yjs files belonging to the worksheets app
    return storage.drive.listFiles().filter(f => f.type === 'yjs');
}

/**
 * Create a new spreadsheet document
 * Explicitly initializes the Yjs document structure at creation time,
 * preventing race conditions with offline clients.
 * @param {string} title
 */
export async function createDocument(title) {
    return storage.drive.createAndInitializeFile({
        title,
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
