/**
 * Spreadsheet Schema
 *
 * Defines the Yjs document structure for spreadsheet documents.
 *
 * ## Document Root Structure (Y.Map):
 * - metadata: Y.Map - Document-level metadata
 * - sheets: Y.Map<sheetId, Y.Map> - Collection of sheets
 * - sheetOrder: Y.Array<string> - Ordered list of sheet IDs
 * - namedRanges: Y.Map<name, Y.Map> - Named range definitions
 *
 * ## Sheet cell storage (v4):
 * - cellValues: Y.Array (YKeyValue) — { v, t } per "row,col" key
 * - cellStyles: Y.Array (YKeyValue) — { ct, protected, formatting props } per "row,col" key
 * - rowMeta:   Y.Array (YKeyValue) — { height, hidden, formatting } per row index key
 * - colMeta:   Y.Array (YKeyValue) — { width, hidden, formatting } per col index key
 * - borders:   Y.Array (YKeyValue) — { style, width, color } per "h|v,row,col" edge key
 */
import * as Y from 'yjs';
import { YKeyValue } from 'y-utility/y-keyvalue';
import {
    SCHEMA_VERSION,
    DEFAULT_ROW_COUNT,
    DEFAULT_COL_COUNT,
    META_KEYS,
    CELL_VALUE_KEYS,
} from './constants.js';

// ─── Public helpers ────────────────────────────────────────────────────────────

/**
 * Return a YKeyValue wrapping the cellValues Y.Array for a sheet.
 * Returns null if the sheet hasn't been migrated to v4 yet.
 * @param {Y.Map} sheetYMap
 * @returns {YKeyValue|null}
 */
export function mkCellValuesKV(sheetYMap) {
    const arr = sheetYMap?.get('cellValues');
    return arr instanceof Y.Array ? new YKeyValue(arr) : null;
}

/**
 * Return a YKeyValue wrapping the cellStyles Y.Array for a sheet.
 * @param {Y.Map} sheetYMap
 * @returns {YKeyValue|null}
 */
export function mkCellStylesKV(sheetYMap) {
    const arr = sheetYMap?.get('cellStyles');
    return arr instanceof Y.Array ? new YKeyValue(arr) : null;
}

// ─── Schema initialisation ─────────────────────────────────────────────────────

/**
 * Create a new Y.Map for a sheet with the full v4 schema structure.
 * @param {Y.Doc} ydoc
 * @param {string} id
 * @param {string} name
 * @param {Object} [options]
 * @returns {Y.Map}
 */
export function createSheetYMap(ydoc, id, name, options = {}) {
    const sheet = new Y.Map();

    sheet.set('id', id);
    sheet.set('name', name);
    sheet.set('rowCount', options.rowCount ?? DEFAULT_ROW_COUNT);
    sheet.set('colCount', options.colCount ?? DEFAULT_COL_COUNT);

    if (options.defaultRowHeight !== undefined) sheet.set('defaultRowHeight', options.defaultRowHeight);
    if (options.defaultColWidth  !== undefined) sheet.set('defaultColWidth',  options.defaultColWidth);

    sheet.set('frozenRows',    options.frozenRows    ?? 0);
    sheet.set('frozenColumns', options.frozenColumns ?? 0);

    // v4: row/col metadata as YKeyValue (Y.Array backing)
    // Values: plain objects { height?, hidden?, ...formatting }
    sheet.set('rowMeta', new Y.Array());
    sheet.set('colMeta', new Y.Array());

    // v4: cell data split into values + styles, both as YKeyValue (Y.Array backing)
    // cellValues: { v, t } per "row,col"
    // cellStyles: { ct, protected, fontFamily, fontSize, bold, ... } per "row,col"
    sheet.set('cellValues', new Y.Array());
    sheet.set('cellStyles', new Y.Array());

    // v3: borders as YKeyValue (Y.Array backing)
    // Values: { style, width, color } per "h|v,row,col" edge key
    sheet.set('borders', new Y.Array());

    sheet.set('merges',            new Y.Array());
    sheet.set('tables',            new Y.Map());
    sheet.set('repeaters',         new Y.Map());
    sheet.set('printSettings',     new Y.Map());
    sheet.set('conditionalFormats',new Y.Array());
    sheet.set('dataValidations',   new Y.Array());

    if (options.protection) {
        const protection = new Y.Map();
        Object.entries(options.protection).forEach(([k, v]) => protection.set(k, v));
        sheet.set('protection', protection);
    }

    sheet.set('hidden', options.hidden ?? false);
    if (options.tabColor !== undefined) sheet.set('tabColor', options.tabColor);

    return sheet;
}

/**
 * Initialize a new spreadsheet document. Idempotent.
 * @param {Y.Doc} ydoc
 * @param {Object} [metadata]
 */
export function initializeDocument(ydoc, metadata = {}) {
    const root = ydoc.getMap('spreadsheet');
    if (root.get('sheets')) return;

    ydoc.transact(() => {
        const metadataMap = new Y.Map();
        if (metadata.description)      metadataMap.set(META_KEYS.DESCRIPTION,       metadata.description);
        metadataMap.set(META_KEYS.CREATED, Date.now());
        if (metadata.creator)          metadataMap.set(META_KEYS.CREATOR,           metadata.creator);
        metadataMap.set(META_KEYS.MODIFIED, Date.now());
        if (metadata.lastModifiedBy)   metadataMap.set(META_KEYS.LAST_MODIFIED_BY,  metadata.lastModifiedBy);
        if (metadata.locale)           metadataMap.set(META_KEYS.LOCALE,            metadata.locale);
        if (metadata.timezone)         metadataMap.set(META_KEYS.TIMEZONE,          metadata.timezone);
        if (metadata.defaultCurrency)  metadataMap.set(META_KEYS.DEFAULT_CURRENCY,  metadata.defaultCurrency);
        root.set('metadata', metadataMap);

        root.set('sheets',      new Y.Map());
        root.set('sheetOrder',  new Y.Array());
        root.set('namedRanges', new Y.Map());

        const sheets     = root.get('sheets');
        const sheetOrder = root.get('sheetOrder');
        sheets.set('sheet-1', createSheetYMap(ydoc, 'sheet-1', 'Sheet 1'));
        sheetOrder.push(['sheet-1']);
    });
}

// ─── Table / repeater / named-range helpers (unchanged) ───────────────────────

export function createTableYMap(id, name, options = {}) {
    const table = new Y.Map();
    table.set('id', id);
    table.set('name', name);
    table.set('mode', options.mode ?? 'inline');
    table.set('startRow', options.startRow ?? 0);
    table.set('startCol', options.startCol ?? 0);
    table.set('endCol',   options.endCol   ?? (options.startCol ?? 0));
    if (options.mode === 'viewport') {
        table.set('vpStartRow', options.vpStartRow ?? 0);
        table.set('vpStartCol', options.vpStartCol ?? 0);
        table.set('vpEndRow',   options.vpEndRow   ?? 10);
        table.set('vpEndCol',   options.vpEndCol   ?? 5);
    }
    table.set('columns',   new Y.Array());
    table.set('rows',      new Y.Array());
    table.set('sortColId', null);
    table.set('sortDir',   'asc');
    return table;
}

export function createTableColumnYMap(options = {}) {
    const col = new Y.Map();
    col.set('id',           options.id ?? `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    col.set('name',         options.name     ?? '');
    col.set('dataType',     options.dataType ?? 'text');
    col.set('required',     options.required ?? false);
    col.set('sortOrder',    options.sortOrder ?? 0);
    col.set('conditionalFormats', new Y.Array());
    col.set('width',         options.width  ?? null);
    col.set('defaultFormula', options.defaultFormula ?? options.formula ?? null);
    if (options.dataValidation) {
        const dv = new Y.Map();
        Object.entries(options.dataValidation).forEach(([k, v]) => dv.set(k, v));
        col.set('dataValidation', dv);
    }
    return col;
}

export function createRepeaterYMap(id, name, options = {}) {
    const rep = new Y.Map();
    rep.set('id',   id);
    rep.set('name', name);
    rep.set('mode', options.mode ?? 'inline');
    rep.set('templateStartRow', options.templateStartRow ?? 0);
    rep.set('templateEndRow',   options.templateEndRow   ?? 0);
    rep.set('templateStartCol', options.templateStartCol ?? 0);
    rep.set('templateEndCol',   options.templateEndCol   ?? 0);
    rep.set('direction', options.direction ?? 'vertical');
    rep.set('count', options.count ?? 1);
    rep.set('gap',   options.gap   ?? 0);
    if (options.mode === 'viewport') {
        rep.set('vpStartRow', options.vpStartRow ?? 0);
        rep.set('vpStartCol', options.vpStartCol ?? 0);
        rep.set('vpEndRow',   options.vpEndRow   ?? 10);
        rep.set('vpEndCol',   options.vpEndCol   ?? 5);
    }
    return rep;
}

export function createNamedRangeYMap(range) {
    const nr = new Y.Map();
    nr.set('sheetId',  range.sheetId);
    nr.set('startRow', range.startRow);
    nr.set('startCol', range.startCol);
    nr.set('endRow',   range.endRow);
    nr.set('endCol',   range.endCol);
    if (range.comment !== undefined) nr.set('comment', range.comment);
    return nr;
}

// ─── Schema definition for DocManager ─────────────────────────────────────────

export const spreadsheetSchema = {
    version: SCHEMA_VERSION,
    /**
     * Run schema migrations against an EXISTING document.
     *
     * IMPORTANT: This must never create the root `sheets` structure. If `sheets`
     * is missing it means either:
     *   (a) the doc is a brand-new file (which is initialized exclusively by
     *       createDocument() via initializeDocument()), or
     *   (b) the local copy hasn't synced the structure yet from the server.
     *
     * In case (b), creating a default Sheet 1 here would race with the
     * server's real `sheets` map — the local write gets a higher Yjs
     * lamport clock and wins via Y.Map LWW, overwriting the user's data.
     * Callers must wait for server sync BEFORE invoking migrate() when
     * they suspect (b).
     */
    migrate: (ydoc) => {
        const root   = ydoc.getMap('spreadsheet');
        const sheets = root.get('sheets');

        if (!sheets) return;

        // Add sub-fields missing from pre-v3 docs.
        sheets.forEach((sheet) => {
            if (!sheet.has('tables'))       sheet.set('tables',       new Y.Map());
            if (!sheet.has('repeaters'))    sheet.set('repeaters',    new Y.Map());
            if (!sheet.has('printSettings'))sheet.set('printSettings',new Y.Map());
        });

        // v3: borders Y.Map → Y.Array (YKeyValue backing).
        sheets.forEach((sheet) => {
            const existing = sheet.get('borders');
            if (existing instanceof Y.Map) {
                ydoc.transact(() => {
                    const arr   = new Y.Array();
                    const items = [];
                    existing.forEach((value, key) => items.push({ key, val: value }));
                    if (items.length > 0) arr.push(items);
                    sheet.set('borders', arr);
                });
            }
        });

        // v4a: cells Y.Map<Y.Map> → cellValues + cellStyles Y.Arrays (YKeyValue).
        sheets.forEach((sheet) => {
            if (sheet.has('cells') && !sheet.has('cellValues')) {
                ydoc.transact(() => {
                    const oldCells = sheet.get('cells');
                    const cvItems  = [];
                    const csItems  = [];

                    oldCells.forEach((cellYMap, key) => {
                        const raw = cellYMap instanceof Y.Map ? cellYMap.toJSON() : (cellYMap ?? {});
                        const valData = {};
                        const styData = {};
                        for (const [k, v] of Object.entries(raw)) {
                            if (CELL_VALUE_KEYS.has(k)) valData[k] = v;
                            else styData[k] = v;
                        }
                        if (Object.keys(valData).length > 0) cvItems.push({ key, val: valData });
                        if (Object.keys(styData).length > 0) csItems.push({ key, val: styData });
                    });

                    const cvArr = new Y.Array();
                    const csArr = new Y.Array();
                    if (cvItems.length > 0) cvArr.push(cvItems);
                    if (csItems.length > 0) csArr.push(csItems);
                    sheet.set('cellValues', cvArr);
                    sheet.set('cellStyles', csArr);
                    // Remove old key to reclaim space (CRDT-safe: new code never reads it)
                    sheet.delete('cells');
                });
            }
        });

        // v4b: rowMeta / colMeta  Y.Map<Y.Map> → Y.Array (YKeyValue).
        sheets.forEach((sheet) => {
            for (const metaKey of ['rowMeta', 'colMeta']) {
                const existing = sheet.get(metaKey);
                if (existing instanceof Y.Map) {
                    ydoc.transact(() => {
                        const arr   = new Y.Array();
                        const items = [];
                        existing.forEach((metaYMap, key) => {
                            const data = metaYMap instanceof Y.Map ? metaYMap.toJSON() : (metaYMap ?? {});
                            if (Object.keys(data).length > 0) items.push({ key, val: data });
                        });
                        if (items.length > 0) arr.push(items);
                        sheet.set(metaKey, arr);
                    });
                }
            }
        });
    },
};

export default spreadsheetSchema;
