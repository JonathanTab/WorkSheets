/**
 * tableCreate.js — Canonical builders for source tables and table views.
 *
 * A table is two objects: a SOURCE (schema + rows, in root.tableData, belonging
 * to no sheet) and one or more VIEWS (position + visible-column subset, in
 * sheet.tableViews, pointing back at the source by `tableId`). Creating only the
 * source produces data no one can see; creating only a view produces a
 * dangling reference. Building both correctly is easy to get subtly wrong, so
 * it lives here and is shared by TableManager (browser) and ops/tableOps.js
 * (API), the same way tableRowHelpers.js is shared.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import * as Y from 'yjs';

/** Generate an id with a readable prefix. */
export function makeId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Build a column-definition Y.Map.
 *
 * `typeConfig` is stored as a JSON STRING because that is what TableStore
 * expects to parse; passing an object through unserialised makes dropdown
 * options silently unreadable.
 *
 * @param {{ id: string, name: string, type?: string, required?: boolean,
 *           hAlign?: string, isNonEntry?: boolean, defaultFormula?: string,
 *           typeConfig?: object|string }} c
 * @returns {Y.Map<any>}
 */
export function buildColumnDef(c) {
    const cm = new Y.Map();
    cm.set('id', c.id);
    cm.set('name', c.name ?? '');
    cm.set('type', c.type ?? 'text');
    cm.set('required', c.required ?? false);
    if (c.hAlign) cm.set('hAlign', c.hAlign);
    if (c.isNonEntry) cm.set('isNonEntry', true);
    if (c.defaultFormula) cm.set('defaultFormula', c.defaultFormula);
    if (c.typeConfig != null) {
        cm.set('typeConfig', typeof c.typeConfig === 'string'
            ? c.typeConfig
            : JSON.stringify(c.typeConfig));
    }
    return cm;
}

/**
 * Build a source-table Y.Map (schema + empty row set).
 * @param {string} sourceId
 * @param {string} name
 * @param {Array<object>} columns  Each needs at least an `id` and `name`
 * @returns {Y.Map<any>}
 */
export function buildSourceTable(sourceId, name, columns = []) {
    const src = new Y.Map();
    src.set('id', sourceId);
    src.set('name', name);
    src.set('sortColId', null);
    src.set('sortDir', 'asc');
    src.set('insertSortColId', null);
    src.set('insertSortDir', 'asc');

    const defsMap = new Y.Map();
    const orderArr = new Y.Array();
    for (const c of columns) {
        defsMap.set(c.id, buildColumnDef(c));
        orderArr.push([c.id]);
    }
    src.set('columnDefs', defsMap);
    src.set('columnOrder', orderArr);
    src.set('rows', new Y.Array());
    src.set('filters', new Y.Map());
    return src;
}

/**
 * Build a table-view Y.Map that renders a source table on a sheet.
 * @param {string} viewId
 * @param {{ tableId: string, name?: string, startRow?: number, startCol?: number,
 *           visibleColumns?: string[] }} opts
 * @returns {Y.Map<any>}
 */
export function buildTableView(viewId, opts) {
    const vm = new Y.Map();
    vm.set('id', viewId);
    vm.set('name', opts.name ?? 'Table');
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
    return vm;
}

/**
 * Create a source table plus its view in one transaction.
 *
 * @param {Y.Doc} ydoc
 * @param {{
 *   tableDataMap: Y.Map<any>,
 *   viewsMap: Y.Map<any>,
 *   name: string,
 *   columns: Array<object>,
 *   startRow?: number,
 *   startCol?: number,
 *   origin?: any,
 * }} opts
 * @returns {{ sourceId: string, viewId: string }}
 */
export function createTableWithView(ydoc, opts) {
    const sourceId = makeId('table');
    const viewId = makeId('view');
    const name = opts.name ?? 'Table';

    ydoc.transact(() => {
        opts.tableDataMap.set(sourceId, buildSourceTable(sourceId, name, opts.columns ?? []));
        opts.viewsMap.set(viewId, buildTableView(viewId, {
            tableId: sourceId,
            name,
            startRow: opts.startRow ?? 0,
            startCol: opts.startCol ?? 0,
        }));
    }, opts.origin);

    return { sourceId, viewId };
}
