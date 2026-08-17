/**
 * ops/evalOps.js — Document-wide formula evaluation for non-reactive callers.
 *
 * The browser evaluates formulas through FormulaEngine, which stores computed
 * values in Svelte `$state` and therefore cannot be imported outside the app.
 * This module reproduces the same results using the pure parser/evaluator, so
 * the API and MCP server return the values a user actually sees rather than
 * raw formula text.
 *
 * Guarantees:
 *   - memoised per cell for the life of the evaluator
 *   - cycles resolve to '#CIRC!' instead of blowing the stack
 *   - cross-sheet refs ('Sheet2'!A1) resolve by sheet name
 *   - TABLE_* functions resolve via the Node table adapter
 *
 * The evaluator caches aggressively and holds no subscriptions, so build one
 * per request and discard it — a long-lived instance would serve stale values
 * after a concurrent edit.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import { evaluate, cachedParseFormula } from '../../../formulas/evaluator.js';
import { buildTableFunctions } from '../features/tableFormulaEval.js';
import { root, sheetsMap, mkCellValuesKV } from './context.js';
import { findTableByName, buildTableAdapter } from './tableRead.js';

/** Depth cap as a backstop for pathological reference chains. */
const MAX_DEPTH = 256;

/**
 * Create a memoised evaluator bound to a document.
 * @param {import('yjs').Doc} ydoc
 * @returns {{
 *   getValue: (sheetId: string, row: number, col: number) => any,
 *   getRaw: (sheetId: string, row: number, col: number) => any,
 *   evaluateString: (sheetId: string, formula: string) => any,
 *   isFormula: (value: any) => boolean,
 * }}
 */
export function createDocEvaluator(ydoc) {
    /** @type {Map<string, any>} `${sheetId}|${row},${col}` → computed value */
    const cache = new Map();
    /** @type {Set<string>} cells currently being evaluated (cycle detection) */
    const visiting = new Set();
    /** @type {Map<string, import('y-utility/y-keyvalue').YKeyValue|null>} */
    const kvBySheet = new Map();

    // Sheet name → id, rebuilt once per evaluator.
    const nameToId = new Map();
    const sheets = sheetsMap(ydoc);
    if (sheets) {
        for (const [id, sheet] of sheets.entries()) {
            nameToId.set(String(sheet.get('name') ?? '').trim().toLowerCase(), id);
        }
    }

    function valuesKV(sheetId) {
        if (!kvBySheet.has(sheetId)) {
            const sheet = sheets?.get(sheetId);
            kvBySheet.set(sheetId, sheet ? mkCellValuesKV(sheet) : null);
        }
        return kvBySheet.get(sheetId);
    }

    // TABLE_* support: resolve a table by name to a server-side adapter.
    const adapterCache = new Map();
    const resolveTableByName = (name) => {
        const key = String(name ?? '').toLowerCase();
        if (adapterCache.has(key)) return adapterCache.get(key);
        const found = findTableByName(ydoc, name);
        const adapter = found ? buildTableAdapter(found.table) : null;
        adapterCache.set(key, adapter);
        return adapter;
    };
    const customFunctions = root(ydoc).get('tableData')
        ? buildTableFunctions(resolveTableByName)
        : null;

    /** True when a stored value is a formula. */
    const isFormula = (v) => typeof v === 'string' && v.startsWith('=');

    /** Raw stored cell value, no evaluation. */
    function getRaw(sheetId, row, col) {
        return valuesKV(sheetId)?.get(`${row},${col}`)?.v ?? null;
    }

    function getValue(sheetId, row, col, depth = 0) {
        const key = `${sheetId}|${row},${col}`;
        if (cache.has(key)) return cache.get(key);

        const raw = getRaw(sheetId, row, col);
        if (!isFormula(raw)) {
            cache.set(key, raw);
            return raw;
        }

        if (visiting.has(key) || depth > MAX_DEPTH) {
            // Don't cache: the same cell may evaluate cleanly from another path.
            return '#CIRC!';
        }

        visiting.add(key);
        try {
            const value = evalIn(sheetId, raw, depth);
            cache.set(key, value);
            return value;
        } finally {
            visiting.delete(key);
        }
    }

    /** Evaluate a formula string in the context of a sheet. */
    function evalIn(sheetId, formula, depth = 0) {
        try {
            const ast = cachedParseFormula(String(formula).slice(1));
            return evaluate(
                ast,
                (r, c) => getValue(sheetId, r, c, depth + 1),
                {},
                customFunctions,
                (sheetName, r, c) => {
                    const id = nameToId.get(String(sheetName ?? '').trim().toLowerCase());
                    return id ? getValue(id, r, c, depth + 1) : null;
                },
            );
        } catch (err) {
            return `#ERROR!`;
        }
    }

    return {
        getValue: (sheetId, row, col) => getValue(sheetId, row, col, 0),
        getRaw,
        evaluateString: (sheetId, formula) => evalIn(sheetId, formula, 0),
        isFormula,
    };
}
