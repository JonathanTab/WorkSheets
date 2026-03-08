/**
 * Spreadsheet Schema
 *
 * Defines the Yjs document structure for spreadsheet documents.
 * This schema follows the specification precisely.
 *
 * ## Document Root Structure (Y.Map):
 * - metadata: Y.Map - Document-level metadata
 * - sheets: Y.Map<sheetId, Y.Map> - Collection of sheets
 * - sheetOrder: Y.Array<string> - Ordered list of sheet IDs
 * - namedRanges: Y.Map<name, Y.Map> - Named range definitions
 */
import * as Y from 'yjs';
import {
    SCHEMA_VERSION,
    DEFAULT_ROW_COUNT,
    DEFAULT_COL_COUNT,
    META_KEYS
} from './constants.js';

/**
 * Create a new Y.Map for a sheet with the full schema structure
 * @param {Y.Doc} ydoc
 * @param {string} id - Sheet ID
 * @param {string} name - Sheet name
 * @param {Object} [options] - Optional sheet configuration
 * @returns {Y.Map}
 */
export function createSheetYMap(ydoc, id, name, options = {}) {
    const sheet = new Y.Map();

    // Basic properties (plain values)
    sheet.set('id', id);
    sheet.set('name', name);
    sheet.set('rowCount', options.rowCount ?? DEFAULT_ROW_COUNT);
    sheet.set('colCount', options.colCount ?? DEFAULT_COL_COUNT);

    // Optional size defaults
    if (options.defaultRowHeight !== undefined) {
        sheet.set('defaultRowHeight', options.defaultRowHeight);
    }
    if (options.defaultColWidth !== undefined) {
        sheet.set('defaultColWidth', options.defaultColWidth);
    }

    // Frozen rows/columns (default 0)
    sheet.set('frozenRows', options.frozenRows ?? 0);
    sheet.set('frozenColumns', options.frozenColumns ?? 0);

    // Row metadata (Y.Map<number, Y.Map>)
    sheet.set('rowMeta', new Y.Map());

    // Column metadata (Y.Map<number, Y.Map>)
    sheet.set('colMeta', new Y.Map());

    // Cells storage using Y.Map for direct key-value access
    // Key: "row,col" string, Value: Y.Map with cell properties
    const cells = new Y.Map();
    sheet.set('cells', cells);

    // Borders storage using Y.Map for edge-based borders
    // Key: "h,row,col" for horizontal edge below cell(row,col)
    // Key: "v,row,col" for vertical edge right of cell(row,col)
    // Value: { style, width, color }
    sheet.set('borders', new Y.Map());

    // Merges (Y.Array of plain objects)
    sheet.set('merges', new Y.Array());

    // Conditional formatting rules (Y.Array<Y.Map>)
    sheet.set('conditionalFormats', new Y.Array());

    // Data validation rules (Y.Array<Y.Map>)
    sheet.set('dataValidations', new Y.Array());

    // Protection settings (optional Y.Map)
    // Only create if protection options provided
    if (options.protection) {
        const protection = new Y.Map();
        Object.entries(options.protection).forEach(([key, value]) => {
            protection.set(key, value);
        });
        sheet.set('protection', protection);
    }

    // Hidden state (default false)
    sheet.set('hidden', options.hidden ?? false);

    // Tab color (optional)
    if (options.tabColor !== undefined) {
        sheet.set('tabColor', options.tabColor);
    }

    return sheet;
}


/**
 * Create a new cell Y.Map with initial properties
 * Note: Formulas are stored in 'v' field with '=' prefix
 * @param {Object} [initialData] - Initial cell data
 * @returns {Y.Map}
 */
export function createCellYMap(initialData = {}) {
    const cell = new Y.Map();

    // Value - can be a raw value or a formula string (starting with '=')
    if (initialData.v !== undefined) {
        cell.set('v', initialData.v);
    }
    if (initialData.t !== undefined) {
        cell.set('t', initialData.t);
    }
    if (initialData.protected !== undefined) {
        cell.set('protected', initialData.protected);
    }

    // Formatting properties
    const formattingKeys = [
        'fontFamily', 'fontSize', 'bold', 'italic', 'underline',
        'strikethrough', 'color', 'backgroundColor', 'border',
        'horizontalAlign', 'verticalAlign', 'wrapText', 'numberFormat'
    ];

    formattingKeys.forEach(key => {
        if (initialData[key] !== undefined) {
            cell.set(key, initialData[key]);
        }
    });

    return cell;
}

/**
 * Create a named range Y.Map
 * @param {Object} range - Range definition
 * @returns {Y.Map}
 */
export function createNamedRangeYMap(range) {
    const namedRange = new Y.Map();
    namedRange.set('sheetId', range.sheetId);
    namedRange.set('startRow', range.startRow);
    namedRange.set('startCol', range.startCol);
    namedRange.set('endRow', range.endRow);
    namedRange.set('endCol', range.endCol);
    if (range.comment !== undefined) {
        namedRange.set('comment', range.comment);
    }
    return namedRange;
}

/**
 * Initialize a new spreadsheet document
 * @param {Y.Doc} ydoc
 * @param {Object} [metadata] - Optional initial metadata
 */
export function initializeDocument(ydoc, metadata = {}) {
    ydoc.transact(() => {
        const root = ydoc.getMap('spreadsheet');

        // Initialize metadata Y.Map
        // Note: Title is stored in DocManager, not in Yjs metadata
        const metadataMap = new Y.Map();
        if (metadata.description) metadataMap.set(META_KEYS.DESCRIPTION, metadata.description);
        metadataMap.set(META_KEYS.CREATED, Date.now());
        if (metadata.creator) metadataMap.set(META_KEYS.CREATOR, metadata.creator);
        metadataMap.set(META_KEYS.MODIFIED, Date.now());
        if (metadata.lastModifiedBy) metadataMap.set(META_KEYS.LAST_MODIFIED_BY, metadata.lastModifiedBy);
        if (metadata.locale) metadataMap.set(META_KEYS.LOCALE, metadata.locale);
        if (metadata.timezone) metadataMap.set(META_KEYS.TIMEZONE, metadata.timezone);
        if (metadata.defaultCurrency) metadataMap.set(META_KEYS.DEFAULT_CURRENCY, metadata.defaultCurrency);
        root.set('metadata', metadataMap);

        // Initialize sheets Y.Map
        root.set('sheets', new Y.Map());

        // Initialize sheet order Y.Array
        root.set('sheetOrder', new Y.Array());

        // Initialize named ranges Y.Map
        root.set('namedRanges', new Y.Map());

        // Create default sheet
        const sheets = root.get('sheets');
        const sheetOrder = root.get('sheetOrder');
        const defaultSheet = createSheetYMap(ydoc, 'sheet-1', 'Sheet 1');
        sheets.set('sheet-1', defaultSheet);
        sheetOrder.push(['sheet-1']);
    });
}

/**
 * Schema definition for DocManager
 */
export const spreadsheetSchema = {
    version: SCHEMA_VERSION,
    initialize: (ydoc) => {
        const root = ydoc.getMap('spreadsheet');

        // Check if already initialized
        if (root.has('metadata') && root.has('sheets')) {
            return; // Already initialized
        }

        initializeDocument(ydoc);
    },
    migrate: async (ydoc) => {
    }
};

export default spreadsheetSchema;
