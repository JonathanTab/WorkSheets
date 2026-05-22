/**
 * Spreadsheet Schema
 *
 * Defines the Yjs document structure for spreadsheet documents.
 *
 * ## Document Root Structure (Y.Map):
 * - metadata:   Y.Map  — document-level metadata
 * - sheets:     Y.Map<sheetId, Y.Map>  — collection of sheets
 * - sheetOrder: Y.Array<string>  — ordered list of sheet IDs
 * - namedRanges: Y.Map<name, Y.Map>  — named range definitions
 * - tableData:  Y.Map<tableId, Y.Map>  — source tables (data + schema, not tied to any sheet)
 *
 * ## Sheet structure:
 * - cellValues:  Y.Array (YKeyValue) — { v, t } per "row,col" key
 * - cellStyles:  Y.Array (YKeyValue) — { ct, protected, formatting props } per "row,col" key
 * - rowMeta:     Y.Array (YKeyValue) — { height, hidden, formatting } per row index key
 * - colMeta:     Y.Array (YKeyValue) — { width, hidden, formatting } per col index key
 * - borders:     Y.Array (YKeyValue) — { style, width, color } per "h|v,row,col" edge key
 * - tableViews:  Y.Map<viewId, Y.Map>  — table views positioned on this sheet, each referencing
 *                                        a source table via `tableId`
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
import { YJS_ORIGIN } from './yjsOrigins.js';

/** Shorthand: run a Yjs transaction tagged as a migration (never undoable). */
const migrateTransact = (ydoc, fn) => ydoc.transact(fn, YJS_ORIGIN.MIGRATION);

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
    sheet.set('tableViews',        new Y.Map());
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

    migrateTransact(ydoc, () => {
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
        root.set('tableData',   new Y.Map());

        const sheets     = root.get('sheets');
        const sheetOrder = root.get('sheetOrder');
        sheets.set('sheet-1', createSheetYMap(ydoc, 'sheet-1', 'Sheet 1'));
        sheetOrder.push(['sheet-1']);
    });
}

// ─── Table / repeater / named-range helpers ───────────────────────────────────

/**
 * Create a source-table Y.Map for storage in root.tableData.
 *   columnDefs:  Y.Map<colId, Y.Map>  — column definitions
 *   columnOrder: Y.Array<string>       — ordered column IDs
 *   rows:        Y.Array<Y.Map>        — data rows
 *
 * @param {string} id
 * @param {string} name
 * @param {Object} [options]
 * @param {Array<{id?:string, name:string, type?:string, required?:boolean, isNonEntry?:boolean, defaultFormula?:string}>} [options.columns]
 * @returns {import('yjs').Map<any>}
 */
export function createTableYMap(id, name, options = {}) {
    const table = new Y.Map();
    table.set('id', id);
    table.set('name', name);
    table.set('mode', options.mode ?? 'inline');
    table.set('startRow', options.startRow ?? 0);
    table.set('startCol', options.startCol ?? 0);
    if (options.mode === 'viewport') {
        table.set('vpStartRow', options.vpStartRow ?? 0);
        table.set('vpStartCol', options.vpStartCol ?? 0);
        table.set('vpEndRow',   options.vpEndRow   ?? 10);
        table.set('vpEndCol',   options.vpEndCol   ?? 5);
    }

    // Modern column storage: columnDefs map + columnOrder array.
    const defsMap  = new Y.Map();
    const orderArr = new Y.Array();
    if (Array.isArray(options.columns)) {
        for (const c of options.columns) {
            const colId = c.id ?? `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const cm = new Y.Map();
            cm.set('id',           colId);
            cm.set('name',         c.name         ?? '');
            cm.set('type',         c.type         ?? 'text');
            cm.set('required',     c.required     ?? false);
            cm.set('isNonEntry',   c.isNonEntry   ?? false);
            if (c.defaultFormula) cm.set('defaultFormula', c.defaultFormula);
            if (c.hAlign) cm.set('hAlign', c.hAlign);
            defsMap.set(colId, cm);
            orderArr.push([colId]);
        }
    }
    table.set('columnDefs',  defsMap);
    table.set('columnOrder', orderArr);

    table.set('rows',         new Y.Array());
    table.set('filters',      new Y.Map());
    table.set('sortColId',    null);
    table.set('sortDir',      'asc');
    table.set('insertSortColId', null);
    table.set('insertSortDir',   'asc');
    return table;
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

        // v6: rename table storage keys — must run before v3 so the v3 "ensure
        // sub-collections" pass doesn't create an empty tableViews first and
        // cause the rename guard to short-circuit.
        //   root.tables         → root.tableData
        //   sheet.tables        → sheet.tableViews
        //   view.sourceTableId  → view.tableId
        //   source.isSourceOnly  (flag removed — location is identity)
        // Y types cannot be re-parented in Yjs — setting an existing Y.Map under a
        // new key corrupts the CRDT tree. We deep-copy into fresh Y types instead.
        migrateTransact(ydoc, () => {
            // root.tables → root.tableData
            const oldTableData = root.get('tables');
            if (oldTableData instanceof Y.Map && oldTableData.size > 0) {
                let tableData = root.get('tableData');
                if (!(tableData instanceof Y.Map)) {
                    tableData = new Y.Map();
                    root.set('tableData', tableData);
                }
                oldTableData.forEach((tbl, id) => {
                    if (!tableData.has(id)) tableData.set(id, _v6CloneSourceTable(tbl));
                });
                root.delete('tables');
            }

            // sheet.tables → sheet.tableViews  +  sourceTableId → tableId
            sheets.forEach((sheet) => {
                const oldViews = sheet.get('tables');
                if (oldViews instanceof Y.Map && oldViews.size > 0) {
                    let tableViews = sheet.get('tableViews');
                    if (!(tableViews instanceof Y.Map)) {
                        tableViews = new Y.Map();
                        sheet.set('tableViews', tableViews);
                    }
                    oldViews.forEach((entry, id) => {
                        if (!tableViews.has(id)) tableViews.set(id, _v6CloneViewEntry(entry));
                    });
                    sheet.delete('tables');
                }
            });
        });

        // v3: ensure sub-collections exist on every sheet.
        migrateTransact(ydoc, () => {
            sheets.forEach((sheet) => {
                if (!sheet.has('tableViews'))   sheet.set('tableViews',   new Y.Map());
                if (!sheet.has('repeaters'))    sheet.set('repeaters',    new Y.Map());
                if (!sheet.has('printSettings'))sheet.set('printSettings',new Y.Map());
            });
        });

        // v3: borders Y.Map → Y.Array (YKeyValue backing).
        sheets.forEach((sheet) => {
            const existing = sheet.get('borders');
            if (existing instanceof Y.Map) {
                migrateTransact(ydoc, () => {
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
                migrateTransact(ydoc, () => {
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
                    migrateTransact(ydoc, () => {
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

        // v5: rewrite legacy cell type ids ('currency', 'percent', 'automatic') into
        // their modern equivalents. Idempotent — re-running is a no-op once done.
        migrateLegacyCellTypes(ydoc, sheets);
    },
};

// ── v5 helpers ────────────────────────────────────────────────────────────────

/** Legacy ct.type → modern config patch. */
const LEGACY_CT_REMAP = {
    currency:  { type: 'number', subFormat: 'currency' },
    percent:   { type: 'number', subFormat: 'percent'  },
    automatic: { type: 'text' },
};

/**
 * Return a modernised ct, or null if no remap is needed.
 * @param {any} ct
 * @returns {object|null}
 */
function remapCt(ct) {
    if (!ct || typeof ct !== 'object') return null;
    const patch = LEGACY_CT_REMAP[ct.type];
    return patch ? { ...ct, ...patch } : null;
}

/**
 * Walk every place a cell type config lives and rewrite legacy ids in place.
 * @param {Y.Doc} ydoc
 * @param {Y.Map} sheets
 */
function migrateLegacyCellTypes(ydoc, sheets) {
    migrateTransact(ydoc, () => {
        sheets.forEach((sheet) => {
            // 1. cellStyles entries — { ct, ...formatting }
            for (const ykvKey of ['cellStyles', 'rowMeta', 'colMeta']) {
                const arr = sheet.get(ykvKey);
                if (!(arr instanceof Y.Array)) continue;
                const kv = new YKeyValue(arr);
                for (const [key, { val: data }] of kv.map) {
                    const newCt = remapCt(data?.ct);
                    if (newCt) kv.set(key, { ...data, ct: newCt });
                }
            }

            // 2. Table column definitions (in source tables at root.tableData)
            const tables = sheet.get('tableViews');
            if (tables instanceof Y.Map) {
                tables.forEach((table) => {
                    if (!(table instanceof Y.Map)) return;
                    const defsMap = table.get('columnDefs');
                    if (!(defsMap instanceof Y.Map)) return;
                    defsMap.forEach((colDef) => {
                        if (!(colDef instanceof Y.Map)) return;
                        const t = colDef.get('type');
                        const patch = LEGACY_CT_REMAP[t];
                        if (!patch) return;
                        colDef.set('type', patch.type);
                        // Update typeConfig JSON if present
                        const tc = colDef.get('typeConfig');
                        if (typeof tc === 'string') {
                            try {
                                const parsed = JSON.parse(tc);
                                colDef.set('typeConfig', JSON.stringify({ ...parsed, ...patch }));
                            } catch { /* ignore malformed JSON */ }
                        } else {
                            // No prior typeConfig — write one capturing the subFormat
                            colDef.set('typeConfig', JSON.stringify(patch));
                        }
                    });
                });
            }
        });
    });
}

// ── v6 helpers — deep-copy Y types for the table key rename migration ─────────
// Yjs types cannot be re-parented (setting an existing Y type under a new key
// corrupts the tree). These functions create structurally identical fresh types.

function _v6CloneSourceTable(src) {
    const t = new Y.Map();
    for (const k of ['id', 'name', 'sortColId', 'sortDir', 'insertSortColId', 'insertSortDir']) {
        const v = src.get(k);
        if (v !== undefined) t.set(k, v);
    }

    const defsMap = new Y.Map();
    src.get('columnDefs')?.forEach((col, colId) => {
        const c = new Y.Map();
        col?.forEach?.((v, k) => { if (!(v instanceof Y.Map) && !(v instanceof Y.Array)) c.set(k, v); });
        defsMap.set(colId, c);
    });
    t.set('columnDefs', defsMap);

    const order = new Y.Array();
    const oa = src.get('columnOrder');
    if (oa?.length) order.push(oa.toArray());
    t.set('columnOrder', order);

    const rows = new Y.Array();
    const ra = src.get('rows');
    if (ra?.length) rows.push(ra.toArray().map(_v6CloneRow));
    t.set('rows', rows);

    t.set('filters', new Y.Map());
    return t;
}

function _v6CloneRow(src) {
    const r = new Y.Map();
    if (!src?.forEach) return r;
    src.forEach((v, k) => {
        if (v instanceof Y.Map) {
            // _fmt / _rowFmt — one or two levels of nesting
            const m = new Y.Map();
            v.forEach((vv, kk) => {
                if (vv instanceof Y.Map) {
                    const m2 = new Y.Map();
                    vv.forEach((vvv, kkk) => m2.set(kkk, vvv));
                    m.set(kk, m2);
                } else {
                    m.set(kk, vv);
                }
            });
            r.set(k, m);
        } else {
            r.set(k, v);
        }
    });
    return r;
}

function _v6CloneViewEntry(src) {
    const v = new Y.Map();
    for (const k of ['id', 'name', 'mode', 'startRow', 'startCol', 'sortColId', 'sortDir']) {
        const val = src.get(k);
        if (val !== undefined) v.set(k, val);
    }
    // sourceTableId was the old name; tableId is the new name
    const srcId = src.get('sourceTableId') ?? src.get('tableId');
    if (srcId) v.set('tableId', srcId);

    const vc = new Y.Array();
    const vca = src.get('visibleColumns');
    if (vca?.length) vc.push(vca.toArray());
    v.set('visibleColumns', vc);

    const pf = new Y.Map();
    src.get('persistedFilters')?.forEach((val, key) => pf.set(key, val));
    v.set('persistedFilters', pf);
    return v;
}

export default spreadsheetSchema;
