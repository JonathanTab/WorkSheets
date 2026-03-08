/**
 * Spreadsheet Store - Svelte 5 Runes-based reactive store for spreadsheet documents
 *
 * This module serves as the main entry point for the spreadsheet store.
 * It re-exports from the modular spreadsheet store implementation.
 *
 * ## Architecture Overview
 *
 * The spreadsheet store is now organized into modular components:
 *
 * - **SpreadsheetSession** - Main document session management
 * - **SheetStore** - Reactive facade for sheet data (consolidated)
 * - **SelectionState** - Cell selection state (local, not synced)
 * - **ViewportState** - Viewport virtualization state (local, not synced)
 *
 * ## Key Principles
 *
 * 1. Yjs is the ONLY source of truth for document data
 * 2. UI state (selection, scroll) is local and NOT stored in Yjs
 * 3. Computed values (formulas) are derived locally, never synced
 * 4. All mutations go through Yjs transactions for collaboration
 * 5. No version counters - Svelte 5 fine-grained reactivity handles updates
 *
 * ## Yjs Document Structure (Schema Version 2)
 *
 * ```
 * root = ydoc.getMap('spreadsheet')
 * root = {
 *   metadata: Y.Map,      // Document metadata
 *   sheets: Y.Map<sheetId, Y.Map>,
 *   sheetOrder: Y.Array<string>,
 *   namedRanges: Y.Map<name, Y.Map>
 * }
 *
 * Sheet = Y.Map {
 *   id: string,
 *   name: string,
 *   rowCount: number,
 *   colCount: number,
 *   defaultRowHeight: number?,
 *   defaultColWidth: number?,
 *   frozenRows: number,
 *   frozenColumns: number,
 *   rowMeta: Y.Map<number, Y.Map>,
 *   colMeta: Y.Map<number, Y.Map>,
 *   cells: Y.Map<string, Y.Map>,  // key is "row,col"
 *   merges: Y.Array,
 *   conditionalFormats: Y.Array<Y.Map>,
 *   dataValidations: Y.Array<Y.Map>,
 *   protection: Y.Map?,
 *   hidden: boolean,
 *   tabColor: string?
 * }
 *
 * Cell = Y.Map {
 *   v: any,           // value OR formula string (formulas start with "=")
 *   t?: string,       // type hint
 *   protected?: boolean,
 *   // formatting properties...
 * }
 * ```
 */

// Re-export everything from the modular store
export {
    // Core classes and instances
    SpreadsheetSession,
    spreadsheetSession,
    SheetStore,
    SelectionState,

    // Singleton instances
    selectionState,

    // Virtualization (new architecture)
    AxisMetrics,
    GridVirtualizer,
    PANE,
    AXIS,
    OVERRIDE_SOURCE,

    // Legacy viewportState (deprecated - use GridVirtualizer)
    viewportState,

    // Schema utilities
    spreadsheetSchema,
    createSheetYMap,
    createCellYMap,
    createNamedRangeYMap,
    initializeDocument,

    // Constants
    ROW_HEIGHT,
    COL_WIDTH,
    HEADER_HEIGHT,
    HEADER_WIDTH,
    TOTAL_ROWS,
    TOTAL_COLS,
    BUFFER_ROWS,
    BUFFER_COLS,
    SCHEMA_VERSION,
    DEFAULT_ROW_COUNT,
    DEFAULT_COL_COUNT,
    CELL_KEYS,
    CELL_TYPES,
    H_ALIGN,
    V_ALIGN,
    META_KEYS,
    ROW_META_KEYS,
    COL_META_KEYS,

    // DocManager integration
    initializeSpreadsheet,
    getDocManager,
    getAllDocuments,
    createDocument,
    deleteDocument,
    renameDocument,
    loadDocument,
    unloadDocument,
    cleanupSpreadsheet
} from './spreadsheet/index.js';
