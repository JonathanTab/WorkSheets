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
import { spreadsheetSchema, createSheetYMap } from './schema.js';
import { SCHEMA_VERSION, META_KEYS, CELL_KEYS } from './constants.js';
import { FormulaEngine } from '../../formulas/FormulaEngine.svelte.js';

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

    /** @type {SheetStore | null} */
    activeSheetStore = $state.raw(null);

    /** @type {FormulaEngine | null} */
    formulaEngine = $state.raw(null);

    /** @type {Function | null} Cleanup for Yjs observer */
    #cleanupObserver = null;

    /** @type {Function | null} Cleanup for formula engine observer */
    #cleanupFormulaObserver = null;

    /** @type {Function | null} Cleanup for undo manager observer */
    #cleanupUndoObserver = null;

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
            console.log('[SpreadsheetSession] Calling storage.drive.loadFile()...');
            const ydoc = await storage.drive.loadFile(docId);
            console.log('[SpreadsheetSession] storage.drive.loadFile() returned');

            const root = ydoc.getMap('spreadsheet');
            console.log('[SpreadsheetSession] Got root map');

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

                // Initialize undo manager for cells and borders Y.Maps
                const cells = activeSheet.get('cells');
                const borders = activeSheet.get('borders');
                if (cells) {
                    // UndoManager tracks all local changes by default (origin=null)
                    this.undoManager = new Y.UndoManager([cells, borders]);

                    // Set up observer to update reactive undo/redo state
                    this.#setupUndoObserver();
                }

                // Initialize formula engine for the active sheet
                this.#initializeFormulaEngine(activeSheet);
            }
            console.log('[SpreadsheetSession] Undo manager set up');

            // Set up awareness (for collaboration)
            console.log('[SpreadsheetSession] Setting up awareness...');
            const provider = storage.core.runtime.activeDocs.get(docId)?.provider;
            if (provider) {
                this.awareness = provider.awareness;
            }
            console.log('[SpreadsheetSession] Awareness set up');

            // Initialize document title from Storage
            this.#updateDocTitle();

            // Listen for file updates from Storage (via core for full event access)
            const fileUpdatedHandler = (file) => {
                if (file.id === this.docId) {
                    this.#updateDocTitle();
                }
            };
            storage.core.on('file-updated', fileUpdatedHandler);
            this.#cleanupStorageListener = () => {
                storage.core.off('file-updated', fileUpdatedHandler);
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
        const sheetOrder = this.root.get('sheetOrder');
        const sheetsMap = this.root.get('sheets');

        sheetOrder?.observe(structureObserver);
        sheetsMap?.observe(structureObserver);

        // Observe metadata map
        const metadataMap = this.root.get('metadata');
        metadataMap?.observe(metadataObserver);

        // Initial sync
        this.#updateSheetsList();
        this.#updateMetadata();

        this.#cleanupObserver = () => {
            sheetOrder?.unobserve(structureObserver);
            sheetsMap?.unobserve(structureObserver);
            metadataMap?.unobserve(metadataObserver);
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
    #initializeFormulaEngine(sheet) {
        if (!this.ydoc || !this.activeSheetStore) return;

        // Create new formula engine
        this.formulaEngine = new FormulaEngine();

        // Set up cell value getter - returns raw cell values from Yjs
        this.formulaEngine.setCellValueGetter((row, col) => {
            const cell = this.activeSheetStore?.getCell(row, col);
            if (!cell || !cell.exists) return null;
            // Return the raw value (could be a formula string or actual value)
            const v = cell.v;
            // If it's a formula, we should NOT return the formula string for dependency evaluation
            // The formula engine handles this internally
            if (typeof v === 'string' && v.startsWith('=')) {
                return null; // Formula cells have no "raw" value
            }
            return v;
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

            // Second pass: set formulas (this computes values in reactive state)
            for (const { row, col, formula } of formulaCells) {
                this.formulaEngine.setFormula(row, col, formula);
            }
        }

        // Observe cell changes for formula recalculation
        if (cells) {
            const observer = (events) => {
                if (!this.formulaEngine) return;

                // Collect all changes to process
                const formulasToSet = [];
                const formulasToClear = [];
                const valueChanges = [];

                // Process deep changes - events is an array for observeDeep
                for (const event of events) {
                    // Check if this is a change to the cells map itself (add/remove cells)
                    if (event.changes.keys) {
                        event.changes.keys.forEach((change, key) => {
                            if (change.action === 'add' || change.action === 'update') {
                                const cellYMap = cells.get(key);
                                const v = cellYMap?.get?.(CELL_KEYS.VALUE);
                                if (typeof v === 'string' && v.startsWith('=')) {
                                    const [row, col] = key.split(',').map(Number);
                                    formulasToSet.push({ row, col, formula: v });
                                }
                            } else if (change.action === 'delete') {
                                // Cell was deleted, clear from formula engine
                                const [row, col] = key.split(',').map(Number);
                                formulasToClear.push({ row, col });
                            }
                        });
                    }

                    // Check if this is a deep change to a cell's properties (value changes)
                    if (event.path && event.path.length > 0 && event.changes.keys) {
                        const cellKey = event.path[0];
                        const [row, col] = cellKey.split(',').map(Number);
                        const cellYMap = cells.get(cellKey);

                        const hasValueChange = event.changes.keys.has(CELL_KEYS.VALUE);

                        if (hasValueChange) {
                            const v = cellYMap?.get?.(CELL_KEYS.VALUE);
                            if (typeof v === 'string' && v.startsWith('=')) {
                                formulasToSet.push({ row, col, formula: v });
                            } else {
                                // Value changed and it's not a formula
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

                // Trigger dependent recalculation for value changes
                for (const { row, col } of valueChanges) {
                    this.formulaEngine.cellValueChanged(row, col);
                }

                // Note: We do NOT write computed values back to Yjs!
                // The computed values are stored in the reactive formulaEngine.computedValues
            };

            cells.observeDeep(observer);
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

        // Update SheetStore and undo manager for new sheet
        const sheet = sheets.get(sheetId);
        if (sheet && this.ydoc) {
            this.activeSheetStore = new SheetStore(sheet, this.ydoc);

            const cells = sheet.get('cells');
            const borders = sheet.get('borders');
            if (cells) {
                // UndoManager tracks all local changes by default (origin=null)
                this.undoManager = new Y.UndoManager([cells, borders]);

                // Set up observer to update reactive undo/redo state
                this.#setupUndoObserver();
            }

            // Reinitialize formula engine for new sheet
            if (this.#cleanupFormulaObserver) {
                this.#cleanupFormulaObserver();
                this.#cleanupFormulaObserver = null;
            }
            this.#initializeFormulaEngine(sheet);
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
        const cell = this.getCell(row, col);
        if (!cell.exists) return '';

        const rawValue = cell.v;

        // If it's a formula, get computed value from engine
        if (typeof rawValue === 'string' && rawValue.startsWith('=')) {
            const computed = this.formulaEngine?.getComputedValue(row, col);
            return computed ?? '';
        }

        // Otherwise return the raw value
        return rawValue ?? '';
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
     * Clear a cell
     * @param {number} row
     * @param {number} col
     */
    clearCell(row, col) {
        this.activeSheetStore?.clearCell(row, col);
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
     * Rename a sheet
     * @param {string} sheetId
     * @param {string} name
     */
    renameSheet(sheetId, name) {
        if (!this.root) return;

        const sheets = this.root.get('sheets');
        const sheet = sheets?.get(sheetId);

        if (sheet) {
            sheet.set('name', name);
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
            sheetId: this.activeSheetId
        });
    }

    /**
     * Get remote users' selections
     * @returns {Array}
     */
    getRemoteSelections() {
        if (!this.awareness) return [];

        const localClientId = this.awareness.clientID;
        const states = Array.from(this.awareness.getStates().entries());

        return states
            .filter(([clientId]) => clientId !== localClientId)
            .map(([clientId, state]) => ({
                clientId,
                ...state.selection
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
 * @param {string} title
 */
export async function createDocument(title) {
    return storage.drive.createFile({ title, type: 'yjs' });
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
