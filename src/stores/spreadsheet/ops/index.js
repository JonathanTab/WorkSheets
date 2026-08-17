/**
 * ops/ — Shared spreadsheet operations layer.
 *
 * One implementation of every document mutation and query, imported by BOTH
 * the browser client and the Node API/MCP server. Nothing in here touches
 * Svelte, the DOM, or Node-only modules, so it runs unchanged in either.
 *
 * Why it exists: the Node API used to re-implement operations against the raw
 * Yjs schema. That duplication drifted — most visibly when schema v9 interned
 * cell styles into a palette and the API kept writing (and returning) the old
 * inline shape. Shared code makes that class of drift impossible: a schema
 * change lands in one place and both consumers move together.
 *
 * Layout:
 *   context.js     document traversal, sheet resolution, schema-lockstep guard
 *   cellOps.js     cells and ranges in A1 notation (values, formulas, styles)
 *   formatOps.js   the design surface — widths, merges, borders, freeze, rules
 *   sheetOps.js    sheet lifecycle and structural row/column edits
 *   tableOps.js    structured tables: creation, schema, validated row CRUD
 *   docOps.js      whole-document describe + atomic batches
 *   inspectOps.js  diagnostics for repair workflows
 *   evalOps.js     formula evaluation without the reactive engine
 *   tableRead.js   pure table read helpers
 */

export * from './context.js';
export * from './cellOps.js';
export * from './sheetOps.js';
export * from './docOps.js';
export * from './inspectOps.js';
export { createDocEvaluator } from './evalOps.js';

// Namespaced to avoid collisions between same-named helpers across modules
// (e.g. formatOps.listMerges vs tableOps.listTables both being "list*").
export * as formatOps from './formatOps.js';
export * as tableOps from './tableOps.js';
export * as tableRead from './tableRead.js';
