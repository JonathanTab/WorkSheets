/**
 * Spreadsheet Store Module
 *
 * Main entry point for spreadsheet state management.
 * Re-exports all components for easy importing.
 *
 * ## Storage Integration
 *
 * All document metadata access and mutation goes through the new Storage facade.
 * Use the exported functions or access `storage.drive` directly.
 */

// Core classes
export { SpreadsheetSession, spreadsheetSession } from './SpreadsheetSession.svelte.js';
export { SheetStore } from './SheetStore.svelte.js';
export { SelectionState } from './SelectionState.svelte.js';
export { FormulaEditState, formulaEditState } from './FormulaEditState.svelte.js';
export { EditSessionState, editSessionState } from './EditSessionState.svelte.js';
export { clipboardManager } from './ClipboardManager.svelte.js';
export { CellTypeRegistry } from './cellTypes/index.js';

// Feature engines
export { MergeEngine } from './features/MergeEngine.svelte.js';
export { SheetRenderContext, CELL_TYPE } from './features/SheetRenderContext.svelte.js';
export { TableStore, createTableStore } from './features/TableStore.svelte.js';
export { TableManager } from './features/TableManager.svelte.js';
export { RepeaterStore, RepeaterEngine } from './features/RepeaterEngine.svelte.js';
export { PrintEngine } from './features/PrintEngine.js';

// Virtualization (new architecture)
export { AxisMetrics } from './virtualization/AxisMetrics.svelte.js';
export { GridVirtualizer } from './virtualization/GridVirtualizer.svelte.js';
export * from './virtualization/types.js';

// Schema
export {
    spreadsheetSchema,
    createSheetYMap,
    createCellYMap,
    createNamedRangeYMap,
    createTableYMap,
    createTableColumnYMap,
    createRepeaterYMap,
    initializeDocument
} from './schema.js';

// Constants
export * from './constants.js';

// Storage integration (new API)
export {
    initializeSpreadsheet,
    getStorage,
    getAllDocuments,
    createDocument,
    deleteDocument,
    renameDocument,
    loadDocument,
    unloadDocument,
    cleanupSpreadsheet
} from './SpreadsheetSession.svelte.js';

// Re-export storage for direct access
export { storage } from '../storage.js';

// Legacy alias for backward compatibility
export { getStorage as getDocManager } from './SpreadsheetSession.svelte.js';

// Singleton instances for UI state
import { SelectionState } from './SelectionState.svelte.js';
import { setSelectionState } from './ClipboardManager.svelte.js';

export const selectionState = new SelectionState();

// Legacy viewportState - now using GridVirtualizer
// This is kept as a null placeholder for backward compatibility during transition
export const viewportState = null;

// Inject selectionState into ClipboardManager to avoid circular dependency
setSelectionState(selectionState);
