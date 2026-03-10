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
 *
 * ## Sheet Structure additions (v3):
 * - tables: Y.Map<tableId, Y.Map> - DB-style table regions
 * - repeaters: Y.Map<repeaterId, Y.Map> - Repeated cell template regions
 * - printSettings: Y.Map - Print configuration
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

    // Merges (Y.Array of plain objects: { startRow, startCol, endRow, endCol })
    sheet.set('merges', new Y.Array());

    // Tables (Y.Map<tableId, Y.Map>) - DB-style table regions
    sheet.set('tables', new Y.Map());

    // Repeaters (Y.Map<repeaterId, Y.Map>) - repeated cell template regions
    sheet.set('repeaters', new Y.Map());

    // Print settings (Y.Map)
    sheet.set('printSettings', new Y.Map());

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

    if (initialData.ct !== undefined) {
        cell.set('ct', initialData.ct);
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
 * Create a table Y.Map with initial structure
 * @param {string} id - Table ID
 * @param {string} name - Table name
 * @param {Object} [options]
 * @returns {Y.Map}
 */
export function createTableYMap(id, name, options = {}) {
    const table = new Y.Map();
    table.set('id', id);
    table.set('name', name);
    table.set('mode', options.mode ?? 'inline');

    // Inline mode: the table starts at startRow in the sheet, spans startCol..endCol
    table.set('startRow', options.startRow ?? 0);
    table.set('startCol', options.startCol ?? 0);
    table.set('endCol', options.endCol ?? (options.startCol ?? 0));

    // Viewport mode: anchored to a cell range in the sheet
    if (options.mode === 'viewport') {
        table.set('vpStartRow', options.vpStartRow ?? 0);
        table.set('vpStartCol', options.vpStartCol ?? 0);
        table.set('vpEndRow', options.vpEndRow ?? 10);
        table.set('vpEndCol', options.vpEndCol ?? 5);
    }

    // Column definitions (Y.Array of Y.Maps)
    table.set('columns', new Y.Array());

    // Row data (Y.Array of Y.Maps: colId -> value)
    table.set('rows', new Y.Array());

    // Sort state
    table.set('sortColId', null);
    table.set('sortDir', 'asc');

    // Active filters (Y.Map<colId, Y.Map { type, op, value }>)
    table.set('filters', new Y.Map());

    return table;
}

/**
 * Create a table column definition Y.Map
 * @param {Object} options
 * @returns {Y.Map}
 */
export function createTableColumnYMap(options = {}) {
    const col = new Y.Map();
    col.set('id', options.id ?? `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    col.set('name', options.name ?? '');
    col.set('dataType', options.dataType ?? 'text');
    col.set('required', options.required ?? false);
    col.set('sortOrder', options.sortOrder ?? 0);
    col.set('conditionalFormats', new Y.Array());
    col.set('width', options.width ?? null);
    col.set('formula', options.formula ?? null); // computed column formula (uses $row)

    if (options.dataValidation) {
        const dv = new Y.Map();
        Object.entries(options.dataValidation).forEach(([k, v]) => dv.set(k, v));
        col.set('dataValidation', dv);
    }

    return col;
}

/**
 * Create a repeater Y.Map
 * @param {string} id - Repeater ID
 * @param {string} name - Repeater name
 * @param {Object} [options]
 * @returns {Y.Map}
 */
export function createRepeaterYMap(id, name, options = {}) {
    const rep = new Y.Map();
    rep.set('id', id);
    rep.set('name', name);
    rep.set('mode', options.mode ?? 'inline');

    // Template cell range in the sheet (the "template" is rep 0)
    rep.set('templateStartRow', options.templateStartRow ?? 0);
    rep.set('templateEndRow', options.templateEndRow ?? 0);
    rep.set('templateStartCol', options.templateStartCol ?? 0);
    rep.set('templateEndCol', options.templateEndCol ?? 0);

    rep.set('direction', options.direction ?? 'vertical'); // 'vertical' | 'horizontal'
    rep.set('count', options.count ?? 1);  // total repetitions (including template = rep 0)
    rep.set('gap', options.gap ?? 0);      // empty rows/cols between repetitions

    // Viewport mode: anchored to a cell range in the sheet
    if (options.mode === 'viewport') {
        rep.set('vpStartRow', options.vpStartRow ?? 0);
        rep.set('vpStartCol', options.vpStartCol ?? 0);
        rep.set('vpEndRow', options.vpEndRow ?? 10);
        rep.set('vpEndCol', options.vpEndCol ?? 5);
    }

    return rep;
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
            // Migrate existing sheets to add new fields if missing (v3)
            const sheets = root.get('sheets');
            if (sheets) {
                sheets.forEach((sheet) => {
                    if (!sheet.has('tables')) sheet.set('tables', new Y.Map());
                    if (!sheet.has('repeaters')) sheet.set('repeaters', new Y.Map());
                    if (!sheet.has('printSettings')) sheet.set('printSettings', new Y.Map());
                });
            }
            return;
        }

        initializeDocument(ydoc);
    },
    migrate: async (ydoc) => {
    }
};

export default spreadsheetSchema;
