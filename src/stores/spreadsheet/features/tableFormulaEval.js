/**
 * tableFormulaEval.js — pure JS (no Svelte runes), importable in Node.js.
 *
 * Exports TableFormulaEvaluator: given a snapshot of sorted/filtered rows and
 * column definitions, evaluates column default formulas with full dependency
 * resolution, cross-row helpers (PREV/NEXT/ROWVAL/WINDOW), and cycle detection.
 *
 * ## Formula model
 *
 * Every column may have a `defaultFormula`. When a row is *inserted* the formula
 * is evaluated and its result is stored as a plain value. Later edits to that cell
 * override the stored value; the formula is not re-applied automatically.
 *
 * The evaluator is also used at *read time* for `isNonEntry` columns (never stored)
 * and for the live-preview in the column config panel.
 *
 * ## Dependency resolution
 *
 * Before evaluating, the evaluator analyses each column's formula to build a
 * dependency graph, then topologically sorts columns for each row. Columns that
 * reference other rows via PREV/NEXT/ROWVAL/WINDOW are flagged as "cross-row" and
 * evaluated sequentially row-by-row so that PREV(col) reads the freshly-computed
 * value from the previous row. Results are cached in a 2-D grid so PREV always
 * gets the computed (not stored) value.
 *
 * ## DSL tokens (substituted before formula eval)
 *
 *   {colId} / {column name}     Current row value of a column
 *   ROW / ROW1                  0-based / 1-based row index
 *   COUNT                       Total row count
 *
 * ## Row-reference helpers (resolved by the evaluator, not formula engine)
 *
 *   PREV(col)                   Computed value of col in row ROW-1. Returns 0 if no prior row.
 *   PREV(col, default)          Same, with explicit fallback.
 *   NEXT(col)                   Computed value of col in row ROW+1. Returns null if no next row.
 *   NEXT(col, default)          Same, with explicit fallback.
 *   ROWVAL(col, n)              Computed value of col at absolute row index n.
 *   WINDOW(col, before)         Array of col values in rows [ROW-before … ROW]. For AVERAGE(), SUM() etc.
 *   WINDOW(col, before, after)  Array of col values in rows [ROW-before … ROW+after].
 *
 * ## Aggregate helpers (whole-column or conditional)
 *
 *   SUM(col), AVG(col), MIN(col), MAX(col)
 *   SUMIF(sum, filter, op, val), COUNTIF, AVGIF, MINIF, MAXIF
 *   SUMIFS(sum, col1,op1,val1,...), COUNTIFS, AVGIFS
 *   RUNNINGIF(sum, filter, op, val)   Running sum matching condition up to current row
 *   RUNNINGIFS(sum, col1,op1,val1,...)
 *
 * ## Cross-table functions (when tableResolver is provided)
 *
 *   TABLE_GET, TABLE_COL, TABLE_COUNT, TABLE_SUM, TABLE_AVG, TABLE_MIN, TABLE_MAX,
 *   TABLE_CUMSUM, TABLE_SUMIF, TABLE_SUMIFS, TABLE_COUNTIF, TABLE_COUNTIFS,
 *   TABLE_AVGIF, TABLE_AVGIFS, TABLE_MINIF, TABLE_MAXIF,
 *   TABLE_FILTERCOL, TABLE_FILTERCOLIFS, TABLE_LOOKUP, TABLE_FILTER
 *
 * Used by:
 *   - TableStore.svelte.js  (browser, delegates getValue / applyDefaultFormulas)
 *   - operations.js         (Node.js / server, evaluates formula columns from Yjs data)
 */

import { parseFormula } from '../../../formulas/parser.js';
import { evaluate } from '../../../formulas/evaluator.js';
import { parseLocalDate } from '../cellTypes/types/date.js';

// ─── Shared formula helpers ───────────────────────────────────────────────────

/**
 * Find the closing ')' index matching the '(' at openPos.
 * Handles nested parens and quoted strings.
 */
export function findCloseParen(str, openPos) {
    let depth = 0, inStr = false, strChar = null;
    for (let i = openPos; i < str.length; i++) {
        const ch = str[i];
        if (inStr) { if (ch === strChar) inStr = false; }
        else if (ch === '"' || ch === "'") { inStr = true; strChar = ch; }
        else if (ch === '(') { depth++; }
        else if (ch === ')') { if (--depth === 0) return i; }
    }
    return -1;
}

/**
 * Split a comma-separated argument string respecting quoted strings and nested parens.
 */
export function splitArgs(str) {
    const args = [];
    let current = '', depth = 0, inStr = false, strChar = null;
    for (const ch of str) {
        if (inStr) { current += ch; if (ch === strChar) inStr = false; }
        else if (ch === '"' || ch === "'") { inStr = true; strChar = ch; current += ch; }
        else if (ch === '(') { depth++; current += ch; }
        else if (ch === ')') { depth--; current += ch; }
        else if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; }
        else { current += ch; }
    }
    if (current.trim()) args.push(current.trim());
    return args;
}

/** Serialize a computed value back into a formula fragment. */
export function resultToExpr(val) {
    if (val === null || val === undefined) return '0';
    if (typeof val === 'number') return isNaN(val) ? '0' : String(val);
    if (typeof val === 'string') return JSON.stringify(val);
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return '0';
}

/** Compare a row value against a filter condition. */
export function matchCondition(rowVal, op, filterVal) {
    const rv = rowVal, fv = filterVal;
    if (typeof rv === 'string' && typeof fv === 'string') {
        const rvDate = parseLocalDate(rv), fvDate = parseLocalDate(fv);
        if (rvDate && fvDate) {
            const rvT = rvDate.getTime(), fvT = fvDate.getTime();
            switch (op) {
                case '=': case '==': return rvT === fvT;
                case '<>': case '!=': return rvT !== fvT;
                case '>': return rvT > fvT; case '<': return rvT < fvT;
                case '>=': return rvT >= fvT; case '<=': return rvT <= fvT;
            }
        }
    }
    if (['>', '<', '>=', '<='].includes(op)) {
        const rvN = Number(rv), fvN = Number(fv);
        if (!isNaN(rvN) && !isNaN(fvN)) {
            switch (op) {
                case '>': return rvN > fvN; case '<': return rvN < fvN;
                case '>=': return rvN >= fvN; case '<=': return rvN <= fvN;
            }
        }
    }
    switch (op) {
        case '=': case '==':  return String(rv ?? '') === String(fv ?? '');
        case '<>': case '!=': return String(rv ?? '') !== String(fv ?? '');
        case '>':  return String(rv ?? '') >  String(fv ?? '');
        case '<':  return String(rv ?? '') <  String(fv ?? '');
        case '>=': return String(rv ?? '') >= String(fv ?? '');
        case '<=': return String(rv ?? '') <= String(fv ?? '');
        case 'contains':    return String(rv ?? '').toLowerCase().includes(String(fv ?? '').toLowerCase());
        case 'startswith':  return String(rv ?? '').toLowerCase().startsWith(String(fv ?? '').toLowerCase());
        case 'notcontains': return !String(rv ?? '').toLowerCase().includes(String(fv ?? '').toLowerCase());
        case 'empty':    return rv == null || rv === '' || rv === false;
        case 'notempty': return rv != null && rv !== '' && rv !== false;
        default: return false;
    }
}

// ─── Shared TABLE_* function factory ─────────────────────────────────────────

/**
 * Build a Map of all TABLE_* formula functions that operate on the full
 * (unfiltered) row set of each table. Used by both:
 *   - TableFormulaEvaluator  (column formulas referencing other tables)
 *   - TableManager.registerFunctions  (sheet-level FormulaEngine)
 *
 * TABLE_CUMSUM is the sole exception — its upToIndex is a display-order index,
 * so it intentionally uses the filtered evaluator (getCumulativeSum).
 *
 * @param {(name: string) => import('./TableStore.svelte.js').TableStore|null} resolveTableByName
 * @returns {Map<string, Function>}
 */
export function buildTableFunctions(resolveTableByName) {
    const tbl = (name) => resolveTableByName(String(name ?? ''));
    const wantsFiltered = (flag) =>
        flag === true || String(flag ?? '').toLowerCase() === 'filtered' || String(flag ?? '').toLowerCase() === 'view';
    const rowCountOf = (t, filtered) => filtered ? t.getRowCount() : t.getFullRowCount();
    const valueAt = (t, idx, colId, filtered) =>
        filtered ? t.getValue(idx, colId) : t.getFullValue(idx, colId);
    const colOf = (t, colId, filtered) =>
        filtered ? t.getColumn(colId) : t.getFullColumn(colId);
    const fns = new Map();

    fns.set('TABLE_GET', (tableName, rowIndex, colId, filtered = false) => {
        const t = tbl(tableName); if (!t) return null;
        const resolvedCol = t.resolveColId(String(colId));
        return valueAt(t, Number(rowIndex), resolvedCol, wantsFiltered(filtered)) ?? null;
    });
    fns.set('TABLE_COL', (tableName, colId, filtered = false) => {
        const t = tbl(tableName); if (!t) return [];
        return colOf(t, t.resolveColId(String(colId)), wantsFiltered(filtered));
    });
    fns.set('TABLE_COUNT', (tableName, filtered = false) => {
        const t = tbl(tableName); return t ? rowCountOf(t, wantsFiltered(filtered)) : 0;
    });
    fns.set('TABLE_SUM', (tableName, colId, filtered = false) => {
        const t = tbl(tableName); if (!t) return 0;
        return colOf(t, t.resolveColId(String(colId)), wantsFiltered(filtered)).reduce((acc, v) => acc + (Number(v) || 0), 0);
    });
    fns.set('TABLE_AVG', (tableName, colId, filtered = false) => {
        const t = tbl(tableName); if (!t) return 0;
        const vals = colOf(t, t.resolveColId(String(colId)), wantsFiltered(filtered)).map(Number).filter(v => !isNaN(v));
        return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
    });
    fns.set('TABLE_MIN', (tableName, colId, filtered = false) => {
        const t = tbl(tableName); if (!t) return 0;
        const vals = colOf(t, t.resolveColId(String(colId)), wantsFiltered(filtered)).map(Number).filter(v => !isNaN(v));
        return vals.length ? Math.min(...vals) : 0;
    });
    fns.set('TABLE_MAX', (tableName, colId, filtered = false) => {
        const t = tbl(tableName); if (!t) return 0;
        const vals = colOf(t, t.resolveColId(String(colId)), wantsFiltered(filtered)).map(Number).filter(v => !isNaN(v));
        return vals.length ? Math.max(...vals) : 0;
    });
    // TABLE_CUMSUM intentionally uses the filtered evaluator (display-order running sum).
    fns.set('TABLE_CUMSUM', (tableName, colId, upToIndex) => {
        const t = tbl(tableName); if (!t) return 0;
        return t.getCumulativeSum(t.resolveColId(String(colId)), Number(upToIndex));
    });
    fns.set('TABLE_SUMIF', (tableName, sumColId, filterColId, op, filterValue) => {
        const t = tbl(tableName); if (!t) return 0;
        const sId = t.resolveColId(String(sumColId)), fId = t.resolveColId(String(filterColId));
        let sum = 0;
        for (let i = 0; i < t.getFullRowCount(); i++)
            if (matchCondition(t.getFullValue(i, fId), String(op), filterValue)) sum += Number(t.getFullValue(i, sId)) || 0;
        return sum;
    });
    fns.set('TABLE_SUMIFS', (tableName, sumColId, ...triplets) => {
        const t = tbl(tableName); if (!t || triplets.length < 3) return 0;
        const sId = t.resolveColId(String(sumColId));
        const conds = [];
        for (let i = 0; i + 2 < triplets.length; i += 3)
            conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
        let sum = 0;
        for (let i = 0; i < t.getFullRowCount(); i++)
            if (conds.every(c => matchCondition(t.getFullValue(i, c.col), c.op, c.val))) sum += Number(t.getFullValue(i, sId)) || 0;
        return sum;
    });
    fns.set('TABLE_COUNTIF', (tableName, filterColId, op, filterValue) => {
        const t = tbl(tableName); if (!t) return 0;
        const fId = t.resolveColId(String(filterColId));
        let count = 0;
        for (let i = 0; i < t.getFullRowCount(); i++)
            if (matchCondition(t.getFullValue(i, fId), String(op), filterValue)) count++;
        return count;
    });
    fns.set('TABLE_COUNTIFS', (tableName, ...triplets) => {
        const t = tbl(tableName); if (!t || triplets.length < 3) return 0;
        const conds = [];
        for (let i = 0; i + 2 < triplets.length; i += 3)
            conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
        let count = 0;
        for (let i = 0; i < t.getFullRowCount(); i++)
            if (conds.every(c => matchCondition(t.getFullValue(i, c.col), c.op, c.val))) count++;
        return count;
    });
    fns.set('TABLE_AVGIF', (tableName, sumColId, filterColId, op, filterValue) => {
        const t = tbl(tableName); if (!t) return 0;
        const sId = t.resolveColId(String(sumColId)), fId = t.resolveColId(String(filterColId));
        let sum = 0, count = 0;
        for (let i = 0; i < t.getFullRowCount(); i++) {
            if (matchCondition(t.getFullValue(i, fId), String(op), filterValue)) { sum += Number(t.getFullValue(i, sId)) || 0; count++; }
        }
        return count ? sum / count : 0;
    });
    fns.set('TABLE_AVGIFS', (tableName, sumColId, ...triplets) => {
        const t = tbl(tableName); if (!t || triplets.length < 3) return 0;
        const sId = t.resolveColId(String(sumColId));
        const conds = [];
        for (let i = 0; i + 2 < triplets.length; i += 3)
            conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
        let sum = 0, count = 0;
        for (let i = 0; i < t.getFullRowCount(); i++) {
            if (conds.every(c => matchCondition(t.getFullValue(i, c.col), c.op, c.val))) { sum += Number(t.getFullValue(i, sId)) || 0; count++; }
        }
        return count ? sum / count : 0;
    });
    fns.set('TABLE_MINIF', (tableName, colId, filterColId, op, filterValue) => {
        const t = tbl(tableName); if (!t) return 0;
        const cId = t.resolveColId(String(colId)), fId = t.resolveColId(String(filterColId));
        let min = Infinity;
        for (let i = 0; i < t.getFullRowCount(); i++) {
            if (matchCondition(t.getFullValue(i, fId), String(op), filterValue)) { const v = Number(t.getFullValue(i, cId)); if (!isNaN(v) && v < min) min = v; }
        }
        return isFinite(min) ? min : 0;
    });
    fns.set('TABLE_MAXIF', (tableName, colId, filterColId, op, filterValue) => {
        const t = tbl(tableName); if (!t) return 0;
        const cId = t.resolveColId(String(colId)), fId = t.resolveColId(String(filterColId));
        let max = -Infinity;
        for (let i = 0; i < t.getFullRowCount(); i++) {
            if (matchCondition(t.getFullValue(i, fId), String(op), filterValue)) { const v = Number(t.getFullValue(i, cId)); if (!isNaN(v) && v > max) max = v; }
        }
        return isFinite(max) ? max : 0;
    });
    fns.set('TABLE_FILTERCOL', (tableName, colId, filterColId, op, filterValue) => {
        const t = tbl(tableName); if (!t) return [];
        const cId = t.resolveColId(String(colId)), fId = t.resolveColId(String(filterColId));
        const result = [];
        for (let i = 0; i < t.getFullRowCount(); i++)
            if (matchCondition(t.getFullValue(i, fId), String(op), filterValue)) result.push(t.getFullValue(i, cId) ?? null);
        return result;
    });
    fns.set('TABLE_FILTERCOLIFS', (tableName, colId, ...triplets) => {
        const t = tbl(tableName); if (!t || triplets.length < 3) return [];
        const cId = t.resolveColId(String(colId));
        const conds = [];
        for (let i = 0; i + 2 < triplets.length; i += 3)
            conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
        const result = [];
        for (let i = 0; i < t.getFullRowCount(); i++)
            if (conds.every(c => matchCondition(t.getFullValue(i, c.col), c.op, c.val))) result.push(t.getFullValue(i, cId) ?? null);
        return result;
    });
    fns.set('TABLE_LOOKUP', (tableName, lookupColId, lookupValue, returnColId, filtered = false) => {
        const t = tbl(tableName); if (!t) return '#N/A';
        const useFiltered = wantsFiltered(filtered);
        const lId = t.resolveColId(String(lookupColId)), rId = t.resolveColId(String(returnColId));
        for (let i = 0; i < rowCountOf(t, useFiltered); i++)
            if (matchCondition(valueAt(t, i, lId, useFiltered), '=', lookupValue)) return valueAt(t, i, rId, useFiltered) ?? null;
        return '#N/A';
    });
    fns.set('TABLE_FILTER', (tableName, colId, op, value, filtered = false) => {
        const t = tbl(tableName); if (!t) return 0;
        const useFiltered = wantsFiltered(filtered);
        const cId = t.resolveColId(String(colId));
        let count = 0;
        for (let i = 0; i < rowCountOf(t, useFiltered); i++)
            if (matchCondition(valueAt(t, i, cId, useFiltered), String(op), value)) count++;
        return count;
    });

    return fns;
}

// ─── Dependency analysis ──────────────────────────────────────────────────────

const CROSS_ROW_PATTERN = /\b(PREV|NEXT|ROWVAL|WINDOW)\s*\(/i;
const COL_REF_PATTERN   = /\{([^}]+)\}/g;

// Pre-compiled regex patterns for row helpers and aggregate functions.
// These were previously created with `new RegExp(...)` inside hot loops
// (per-row × per-function × up to 20 passes), which is slow when a browser
// extension intercepts RegExp construction. Using module-level literals avoids
// repeated object creation and extension overhead entirely.
const ROW_HELPER_RE = /** @type {Record<string, RegExp>} */ ({
    WINDOW:    /\bWINDOW\s*\(/i,
    ROWVAL:    /\bROWVAL\s*\(/i,
    PREV:      /\bPREV\s*\(/i,
    NEXT:      /\bNEXT\s*\(/i,
});

const AGGREGATE_RE = /** @type {Record<string, RegExp>} */ ({
    RUNNINGIFS: /\bRUNNINGIFS\s*\(/i,
    RUNNINGIF:  /\bRUNNINGIF\s*\(/i,
    SUMIFS:     /\bSUMIFS\s*\(/i,
    SUMIF:      /\bSUMIF\s*\(/i,
    AVGIF:      /\bAVGIF\s*\(/i,
    MINIF:      /\bMINIF\s*\(/i,
    MAXIF:      /\bMAXIF\s*\(/i,
    COUNTIF:    /\bCOUNTIF\s*\(/i,
    AVG:        /\bAVG\s*\(/i,
    MIN:        /\bMIN\s*\(/i,
    MAX:        /\bMAX\s*\(/i,
    SUM:        /\bSUM\s*\(/i,
});

// Module-level cache for evaluation plans.
// Key: column fingerprint string (ids + formulas).
// Bounded at 100 entries (LRU-style eviction of oldest).
// Sorting/filtering changes rows but not columns, so the plan stays valid
// across many #rebuildView() calls on the same table schema.
const _evalPlanCache = new Map();

/**
 * Extract column references from a formula string.
 * Returns an array of raw ref strings (id or name, not yet resolved).
 */
function extractColRefs(formula) {
    const refs = [];
    let m;
    COL_REF_PATTERN.lastIndex = 0;
    while ((m = COL_REF_PATTERN.exec(formula)) !== null) refs.push(m[1].trim());
    return refs;
}

/**
 * Build an evaluation plan from column definitions.
 *
 * Returns { order: string[], crossRowCols: Set<string> }
 *   order         — column IDs in evaluation order (topo sort, deps before dependents)
 *   crossRowCols  — IDs of columns that use PREV/NEXT/ROWVAL/WINDOW (must be evaluated row-by-row)
 *
 * Columns without a defaultFormula are placed first in the order (they are inputs).
 * Cycles are detected; cyclic columns get '#CYCLE' as their value.
 */
function buildEvalPlan(columns, nameToId) {
    const formulaCols = new Set(
        columns.filter(c => c.defaultFormula || (c.isNonEntry && c.formula)).map(c => c.id)
    );
    const crossRowCols = new Set();

    // Build adjacency: colId → Set<colId it depends on (within same row)>
    const deps = new Map(); // colId → Set<colId>
    for (const col of columns) {
        const formula = col.defaultFormula ?? (col.isNonEntry ? col.formula : null);
        if (!formula) { deps.set(col.id, new Set()); continue; }
        if (CROSS_ROW_PATTERN.test(formula)) crossRowCols.add(col.id);
        const rawRefs = extractColRefs(formula);
        const resolved = new Set(
            rawRefs.map(r => nameToId.get(r.toLowerCase()) ?? r).filter(id => id !== col.id)
        );
        deps.set(col.id, resolved);
    }

    // Kahn's algorithm for topo sort with cycle detection
    const inDegree = new Map(columns.map(c => [c.id, 0]));
    // Only count in-edges from formula columns (non-formula cols are always available)
    for (const [id, depSet] of deps) {
        for (const dep of depSet) {
            if (formulaCols.has(dep)) {
                inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
            }
        }
    }

    const queue = columns.filter(c => (inDegree.get(c.id) ?? 0) === 0).map(c => c.id);
    const order = [];
    const visited = new Set();

    while (queue.length) {
        const id = queue.shift();
        if (visited.has(id)) continue;
        visited.add(id);
        order.push(id);
        // Find columns that depend on `id` and decrement their in-degree
        for (const [otherId, depSet] of deps) {
            if (depSet.has(id) && formulaCols.has(id)) {
                const deg = (inDegree.get(otherId) ?? 1) - 1;
                inDegree.set(otherId, deg);
                if (deg === 0 && !visited.has(otherId)) queue.push(otherId);
            }
        }
    }

    // Any column not visited is in a cycle
    const cyclic = new Set(columns.map(c => c.id).filter(id => !visited.has(id)));

    return { order, crossRowCols, cyclic };
}

/**
 * Return a cached evaluation plan for the given column definitions.
 * The plan only depends on column ids, formulas, and isNonEntry flags — not on
 * row data — so the same plan is safe to reuse across sort/filter rebuilds.
 */
function _getCachedEvalPlan(columns, nameToId) {
    // Fingerprint includes all inputs that affect buildEvalPlan output.
    const fingerprint = columns.map(c => {
        const f = c.defaultFormula ?? (c.isNonEntry && c.formula ? c.formula : '') ?? '';
        return `${c.id}:${c.isNonEntry ? '1' : '0'}:${f}`;
    }).join('|');

    if (_evalPlanCache.has(fingerprint)) return _evalPlanCache.get(fingerprint);

    const plan = buildEvalPlan(columns, nameToId);

    // Simple LRU: evict the oldest entry when the cache is full.
    if (_evalPlanCache.size >= 100) _evalPlanCache.delete(_evalPlanCache.keys().next().value);
    _evalPlanCache.set(fingerprint, plan);
    return plan;
}

// ─── TableFormulaEvaluator ────────────────────────────────────────────────────

/**
 * Stateful evaluator for a table's formula columns.
 *
 * @param {object[]} rows         Sorted/filtered rows (plain objects, colId → value).
 * @param {object[]} columns      Column defs: [{id, name, isNonEntry, formula, defaultFormula, ...}].
 * @param {boolean}  cumReverse   True when cumulative functions accumulate from bottom upward (always pass true).
 * @param {((name: string) => {getValue,getRowCount,resolveColId,getColumn}|null)|null} tableResolver
 * @param {((formula: string) => any)|null} sheetValueEval
 */
export class TableFormulaEvaluator {
    /** @type {object[]} */ #rows;
    /** @type {object[]} */ #cols;
    /** @type {boolean}  */ #cumReverse;
    /** @type {Map<string,string>} lowercase name/id → canonical id */ #nameToId;
    /** @type {Map<string,Function>|null} */ #customFunctions = null;
    /** @type {((formula: string) => any)|null} */ #sheetValueEval = null;

    // Evaluation plan
    /** @type {string[]} */ #evalOrder = [];
    /** @type {Set<string>} */ #crossRowCols = new Set();
    /** @type {Set<string>} */ #cyclicCols = new Set();

    // 2-D computed value cache: #computed[rowIndex][colId] = value
    // Populated during #buildComputedCache(). PREV/NEXT/ROWVAL read from here.
    /** @type {Array<Map<string,any>>|null} */ #computed = null;

    // O(1) column def lookup by id — avoids Array.find() in hot paths.
    /** @type {Map<string,object>} */ #colById = new Map();

    // Legacy running caches (for RUNNINGIF/RUNNINGIFS which are whole-column ops)
    #runningIfCache  = new Map();
    #runningIfDirty  = new Map();

    constructor(rows, columns, cumReverse = false, tableResolver = null, sheetValueEval = null) {
        this.#rows       = rows;
        this.#cols       = columns;
        this.#cumReverse = cumReverse;
        this.#sheetValueEval = sheetValueEval;
        this.#nameToId   = new Map();
        this.#colById    = new Map();
        for (const col of columns) {
            this.#nameToId.set(col.id.toLowerCase(), col.id);
            if (col.name) this.#nameToId.set(col.name.toLowerCase(), col.id);
            this.#colById.set(col.id, col);
        }
        if (tableResolver) this.#buildCustomFunctions(tableResolver);

        const plan = _getCachedEvalPlan(columns, this.#nameToId);
        this.#evalOrder   = plan.order;
        this.#crossRowCols = plan.crossRowCols;
        this.#cyclicCols  = plan.cyclic;

        // Skip the O(rows × cols) cache build when no column has a formula.
        const hasForms = columns.some(c => c.defaultFormula || (c.isNonEntry && c.formula));
        if (hasForms) this.#buildComputedCache();
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    resolveColId(nameOrId) {
        if (!nameOrId) return String(nameOrId);
        return this.#nameToId.get(String(nameOrId).toLowerCase()) ?? String(nameOrId);
    }

    getRowCount() { return this.#rows.length; }

    /**
     * Get the computed value for a cell. For isNonEntry columns or defaultFormula
     * columns where the stored value is absent, reads from the computed cache.
     * For regular columns (or overridden cells), reads the stored row value.
     */
    getValue(rowIndex, colId) {
        const def = this.#colById.get(colId);
        if (!def) return this.#resolveMaybeFormula(this.#rows[rowIndex]?.[colId]);

        // isNonEntry: always return computed value (never stored)
        if (def.isNonEntry && (def.defaultFormula || def.formula)) {
            return this.#getComputed(rowIndex, colId);
        }

        // defaultFormula column: return stored value if present (user override),
        // otherwise return computed value
        if (def.defaultFormula) {
            const stored = this.#rows[rowIndex]?.[colId];
            if (stored !== undefined && stored !== null) return this.#resolveMaybeFormula(stored);
            return this.#resolveMaybeFormula(this.#getComputed(rowIndex, colId));
        }

        return this.#resolveMaybeFormula(this.#rows[rowIndex]?.[colId]);
    }

    getColumn(colId) {
        return this.#rows.map((_, i) => this.getValue(i, colId));
    }

    /**
     * Evaluate a formula string for a given row index.
     * Uses the computed cache for PREV/NEXT/ROWVAL so cross-row references
     * see freshly-computed values rather than stored row data.
     */
    evaluateFormula(formula, rowIndex) {
        try {
            return this.#evalFormula(formula, rowIndex);
        } catch { return null; }
    }

    /**
     * Compute default formula values for all columns that have a defaultFormula,
     * for a hypothetical new row being inserted.
     * Returns a map of colId → computed value for formula columns only.
     * The caller merges this with the user-provided entry buffer.
     * @param {object} entryData  colId → value (user-provided values so far)
     * @returns {Map<string, any>}
     */
    applyDefaultFormulas(entryData) {
        // Build a synthetic "row" from entryData so {colRef} substitution works
        const syntheticRowIndex = this.#rows.length; // will be appended at end
        const result = new Map();

        // We need to evaluate in topo order using the synthetic row.
        // Build a temporary row object that merges stored data with results so far.
        const tempRow = { ...entryData };

        for (const colId of this.#evalOrder) {
            const def = this.#colById.get(colId);
            if (!def) continue;
            const formula = def.defaultFormula ?? (def.isNonEntry ? def.formula : null);
            if (!formula) continue;
            // Skip if user already provided a value and column is not isNonEntry
            if (!def.isNonEntry && entryData[colId] !== undefined && entryData[colId] !== null) continue;

            try {
                // For cross-row helpers PREV/NEXT/ROWVAL: use last row of existing data
                const val = this.#evalFormulaWithTempRow(formula, syntheticRowIndex, tempRow);
                result.set(colId, val);
                tempRow[colId] = val;
            } catch {
                // Leave unset — don't break the insert
            }
        }

        return result;
    }

    // kept for callers that do `store.evaluateFormula(formula, rowIndex)` directly
    getCumulativeSum(colId, upToDisplayIndex) {
        // Build running sum from computed values
        const n = this.#rows.length;
        if (n === 0) return 0;
        const idx = Math.min(upToDisplayIndex, n - 1);
        let sum = 0;
        if (this.#cumReverse) {
            for (let i = n - 1; i >= idx; i--) sum += Number(this.getValue(i, colId)) || 0;
        } else {
            for (let i = 0; i <= idx; i++) sum += Number(this.getValue(i, colId)) || 0;
        }
        return sum;
    }

    // ─── Computed cache ────────────────────────────────────────────────────────

    /**
     * Build the full 2-D computed cache. Must be called once after construction.
     *
     * Strategy:
     * - Pure same-row formula columns: computed per-row using #evalOrder
     * - Cross-row columns: evaluated row-by-row sequentially (PREV reads prior row's cache)
     * - All columns are evaluated together per row in topo order
     */
    #buildComputedCache() {
        const n = this.#rows.length;
        this.#computed = Array.from({ length: n }, () => new Map());

        for (let i = 0; i < n; i++) {
            for (const colId of this.#evalOrder) {
                const def = this.#colById.get(colId);
                if (!def) continue;
                const formula = def.defaultFormula ?? (def.isNonEntry ? def.formula : null);
                if (!formula) {
                    // No formula: just cache the stored value
                    this.#computed[i].set(colId, this.#resolveMaybeFormula(this.#rows[i]?.[colId]));
                    continue;
                }
                if (this.#cyclicCols.has(colId)) {
                    this.#computed[i].set(colId, '#CYCLE');
                    continue;
                }
                if (def.isNonEntry) {
                    // Always computed
                    const val = this.#evalFormula(formula, i);
                    this.#computed[i].set(colId, val);
                } else {
                    // defaultFormula: use stored value if present (override), else compute
                    const stored = this.#rows[i]?.[colId];
                    if (stored !== undefined && stored !== null) {
                        this.#computed[i].set(colId, this.#resolveMaybeFormula(stored));
                    } else {
                        const val = this.#evalFormula(formula, i);
                        this.#computed[i].set(colId, val);
                    }
                }
            }
        }
    }

    /** Read from computed cache (falls back to stored row value). */
    #getComputed(rowIndex, colId) {
        if (!this.#computed || rowIndex < 0 || rowIndex >= this.#computed.length) {
            return this.#resolveMaybeFormula(this.#rows[rowIndex]?.[colId]);
        }
        const cached = this.#computed[rowIndex].get(colId);
        return cached !== undefined
            ? this.#resolveMaybeFormula(cached)
            : this.#resolveMaybeFormula(this.#rows[rowIndex]?.[colId]);
    }

    #resolveMaybeFormula(val) {
        if (typeof val === 'string' && val.startsWith('=') && this.#sheetValueEval) {
            const result = this.#sheetValueEval(val);
            return result ?? val;
        }
        return val;
    }

    // ─── Formula evaluation ───────────────────────────────────────────────────

    #evalFormula(formula, rowIndex) {
        let expr = formula.trim();
        if (expr.startsWith('=')) expr = expr.slice(1).trimStart();
        expr = expr.replace(/\bROW1\s*(?:\(\s*\))?/g, String(rowIndex + 1));
        expr = expr.replace(/\bROW\s*(?:\(\s*\))?(?!\s*\w)/g, String(rowIndex));
        expr = expr.replace(/\bCOUNT\b(?!IF)/gi, String(this.getRowCount()));
        expr = this.#substituteColRefs(expr, rowIndex);
        expr = this.#substituteRowHelpers(expr, rowIndex);
        expr = this.#substituteAggregateFuncs(expr, rowIndex);
        return this.#evalExpression(expr);
    }

    /** Evaluate formula with a temporary row object (used for new-row default formulas). */
    #evalFormulaWithTempRow(formula, rowIndex, tempRow) {
        let expr = formula.trim();
        if (expr.startsWith('=')) expr = expr.slice(1).trimStart();
        // ROW for a new row is `rows.length` (0-based)
        expr = expr.replace(/\bROW1\s*(?:\(\s*\))?/g, String(rowIndex + 1));
        expr = expr.replace(/\bROW\s*(?:\(\s*\))?(?!\s*\w)/g, String(rowIndex));
        expr = expr.replace(/\bCOUNT\b(?!IF)/gi, String(this.getRowCount() + 1));
        // Substitute col refs from the temp row
        expr = expr.replace(/\{([^}]+)\}/g, (_m, rawRef) => {
            const colId = this.resolveColId(rawRef.trim());
            const val = tempRow[colId];
            return this.#valToExpr(val);
        });
        // Cross-row helpers in new-row context: PREV reads last existing row
        expr = this.#substituteRowHelpersForNewRow(expr);
        expr = this.#substituteAggregateFuncs(expr, rowIndex);
        return this.#evalExpression(expr);
    }

    #substituteColRefs(expr, rowIndex) {
        return expr.replace(/\{([^}]+)\}/g, (_m, rawRef) => {
            const colId = this.resolveColId(rawRef.trim());
            // Read from computed cache so dependencies see freshly-computed values
            const val = this.#getComputed(rowIndex, colId) ?? this.#rows[rowIndex]?.[colId];
            return this.#valToExpr(val);
        });
    }

    #valToExpr(val) {
        if (val === null || val === undefined || val === '') return '""';
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        if (typeof val === 'string') return JSON.stringify(val);
        const num = Number(val);
        return !isNaN(num) ? String(num) : JSON.stringify(String(val));
    }

    // ─── Row reference helpers ────────────────────────────────────────────────

    #substituteRowHelpers(expr, rowIndex) {
        const ROW_HELPERS = ['WINDOW', 'ROWVAL', 'PREV', 'NEXT'];
        for (let pass = 0; pass < 20; pass++) {
            let replaced = false;
            for (const fn of ROW_HELPERS) {
                const m = ROW_HELPER_RE[fn].exec(expr);
                if (!m) continue;
                replaced = true;
                const openIdx  = m.index + m[0].length - 1;
                const closeIdx = findCloseParen(expr, openIdx);
                if (closeIdx === -1) continue;
                const args = splitArgs(expr.slice(openIdx + 1, closeIdx));
                const result = this.#callRowHelper(fn.toUpperCase(), args, rowIndex);
                expr = expr.slice(0, m.index) + resultToExpr(result) + expr.slice(closeIdx + 1);
                break;
            }
            if (!replaced) break;
        }
        return expr;
    }

    #substituteRowHelpersForNewRow(expr) {
        // For new-row context, PREV reads the last existing row; NEXT returns null.
        const lastIdx = this.#rows.length - 1;
        const ROW_HELPERS = ['WINDOW', 'ROWVAL', 'PREV', 'NEXT'];
        for (let pass = 0; pass < 20; pass++) {
            let replaced = false;
            for (const fn of ROW_HELPERS) {
                const m = ROW_HELPER_RE[fn].exec(expr);
                if (!m) continue;
                replaced = true;
                const openIdx  = m.index + m[0].length - 1;
                const closeIdx = findCloseParen(expr, openIdx);
                if (closeIdx === -1) continue;
                const args = splitArgs(expr.slice(openIdx + 1, closeIdx));
                let result;
                if (fn.toUpperCase() === 'PREV') {
                    result = this.#callRowHelper('PREV', args, this.#rows.length);
                } else if (fn.toUpperCase() === 'NEXT') {
                    const def = args[1] !== undefined ? this.#evalArg(args[1]) : null;
                    result = def;
                } else {
                    result = this.#callRowHelper(fn.toUpperCase(), args, this.#rows.length);
                }
                expr = expr.slice(0, m.index) + resultToExpr(result) + expr.slice(closeIdx + 1);
                break;
            }
            if (!replaced) break;
        }
        return expr;
    }

    #callRowHelper(fn, rawArgs, rowIndex) {
        const colId = this.resolveColId(String(this.#evalArg(rawArgs[0] ?? '') ?? ''));
        switch (fn) {
            case 'PREV': {
                const prevIdx = rowIndex - 1;
                if (prevIdx < 0) {
                    return rawArgs[1] !== undefined ? this.#evalArg(rawArgs[1]) : 0;
                }
                return this.#getComputed(prevIdx, colId) ?? (rawArgs[1] !== undefined ? this.#evalArg(rawArgs[1]) : 0);
            }
            case 'NEXT': {
                const nextIdx = rowIndex + 1;
                if (nextIdx >= this.#rows.length) {
                    return rawArgs[1] !== undefined ? this.#evalArg(rawArgs[1]) : null;
                }
                return this.#getComputed(nextIdx, colId) ?? (rawArgs[1] !== undefined ? this.#evalArg(rawArgs[1]) : null);
            }
            case 'ROWVAL': {
                const n = Number(this.#evalArg(rawArgs[1] ?? '0'));
                if (isNaN(n) || n < 0 || n >= this.#rows.length) return null;
                return this.#getComputed(n, colId);
            }
            case 'WINDOW': {
                const before = Number(this.#evalArg(rawArgs[1] ?? '0'));
                const after  = rawArgs[2] !== undefined ? Number(this.#evalArg(rawArgs[2])) : 0;
                const start  = Math.max(0, rowIndex - (isNaN(before) ? 0 : before));
                const end    = Math.min(this.#rows.length - 1, rowIndex + (isNaN(after) ? 0 : after));
                const vals   = [];
                for (let i = start; i <= end; i++) {
                    const v = this.#getComputed(i, colId);
                    if (v !== null && v !== undefined) vals.push(Number(v) || 0);
                }
                return vals;
            }
            default: return null;
        }
    }

    // ─── Aggregate function substitution ─────────────────────────────────────

    #substituteAggregateFuncs(expr, rowIndex) {
        const KNOWN = ['RUNNINGIFS', 'RUNNINGIF', 'SUMIFS', 'SUMIF',
                       'AVGIF', 'MINIF', 'MAXIF', 'COUNTIF',
                       'AVG', 'MIN', 'MAX', 'SUM'];
        for (let pass = 0; pass < 20; pass++) {
            let replaced = false;
            for (const fn of KNOWN) {
                const m = AGGREGATE_RE[fn].exec(expr);
                if (!m) continue;
                replaced = true;
                const openIdx  = m.index + m[0].length - 1;
                const closeIdx = findCloseParen(expr, openIdx);
                if (closeIdx === -1) continue;
                const result = this.#callAggregateFunc(fn.toUpperCase(), splitArgs(expr.slice(openIdx + 1, closeIdx)), rowIndex);
                expr = expr.slice(0, m.index) + resultToExpr(result) + expr.slice(closeIdx + 1);
                break;
            }
            if (!replaced) break;
        }
        return expr;
    }

    #callAggregateFunc(fn, rawArgs, rowIndex) {
        const args = rawArgs.map(a => this.#evalArg(a.trim()));
        const col  = (i) => this.resolveColId(String(args[i] ?? ''));
        switch (fn) {
            case 'SUM':    return this.getColumn(col(0)).reduce((a, v) => a + (Number(v) || 0), 0);
            case 'AVG': { const nums = this.getColumn(col(0)).map(Number).filter(v => !isNaN(v)); return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : 0; }
            case 'MIN': { const nums = this.getColumn(col(0)).map(Number).filter(v => !isNaN(v)); return nums.length ? Math.min(...nums) : 0; }
            case 'MAX': { const nums = this.getColumn(col(0)).map(Number).filter(v => !isNaN(v)); return nums.length ? Math.max(...nums) : 0; }
            case 'RUNNINGIF': return args.length >= 4 ? this.#getRunningIf(col(0), col(1), String(args[2]), args[3], rowIndex) : 0;
            case 'RUNNINGIFS': {
                if (args.length < 4) return 0;
                const conds = []; for (let i = 1; i + 2 < args.length; i += 3) conds.push({ col: this.resolveColId(String(args[i])), op: String(args[i + 1]), val: args[i + 2] });
                return this.#getRunningIfs(col(0), conds, rowIndex);
            }
            case 'SUMIF':  return args.length >= 4 ? this.#getSumIf(col(0), col(1), String(args[2]), args[3]) : 0;
            case 'SUMIFS': {
                if (args.length < 4) return 0;
                const conds = []; for (let i = 1; i + 2 < args.length; i += 3) conds.push({ col: this.resolveColId(String(args[i])), op: String(args[i + 1]), val: args[i + 2] });
                return this.#getSumIfs(col(0), conds);
            }
            case 'COUNTIF': return args.length >= 3 ? this.#getCountIf(col(0), String(args[1]), args[2]) : 0;
            case 'AVGIF':   return args.length >= 4 ? this.#getAvgIf(col(0), col(1), String(args[2]), args[3]) : 0;
            case 'MINIF':   return args.length >= 4 ? this.#getMinIf(col(0), col(1), String(args[2]), args[3]) : 0;
            case 'MAXIF':   return args.length >= 4 ? this.#getMaxIf(col(0), col(1), String(args[2]), args[3]) : 0;
            default: return 0;
        }
    }

    #evalArg(arg) {
        if (typeof arg !== 'string') return arg;
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) return arg.slice(1, -1);
        const num = Number(arg);
        if (arg !== '' && !isNaN(num)) return num;
        return arg;
    }

    #evalExpression(expr) {
        const t = expr.trim();
        if (!t || t === '""') return null;
        // Arrays (from WINDOW) — pass through for the formula engine to handle
        if (Array.isArray(t)) return t;
        const num = Number(t);
        if (t !== '' && !isNaN(num)) return num;
        try { return evaluate(parseFormula('=' + t), () => null, {}, this.#customFunctions); } catch { return null; }
    }

    // ─── Running / conditional aggregates ────────────────────────────────────

    #getRunningIf(sumCol, filterCol, op, filterVal, upToIndex) {
        const key = `${sumCol}|${filterCol}|${op}|${String(filterVal)}`;
        const n = this.#rows.length;
        if (n === 0) return 0;
        const idx = Math.min(upToIndex, n - 1);
        // Use computed values for both sum and filter columns
        if (this.#cumReverse) {
            let cache = this.#runningIfCache.get(key);
            if (!cache || cache.length < n) {
                cache = new Float64Array(n); let running = 0;
                for (let i = n - 1; i >= 0; i--) {
                    running += matchCondition(this.getValue(i, filterCol), op, filterVal) ? (Number(this.getValue(i, sumCol)) || 0) : 0;
                    cache[i] = running;
                }
                this.#runningIfCache.set(key, cache);
            }
            return cache[idx] ?? 0;
        }
        let cache = this.#runningIfCache.get(key);
        const dirtyFrom = this.#runningIfDirty.get(key) ?? 0;
        if (!cache || cache.length < n || dirtyFrom <= idx) {
            if (!cache || cache.length < n) cache = new Float64Array(n);
            let running = dirtyFrom > 0 ? cache[dirtyFrom - 1] : 0;
            for (let i = dirtyFrom; i < n; i++) {
                running += matchCondition(this.getValue(i, filterCol), op, filterVal) ? (Number(this.getValue(i, sumCol)) || 0) : 0;
                cache[i] = running;
            }
            this.#runningIfCache.set(key, cache); this.#runningIfDirty.set(key, n);
        }
        return cache[idx] ?? 0;
    }

    #getRunningIfs(sumCol, conditions, upToIndex) {
        const key = `${sumCol}||${conditions.map(c => `${c.col}|${c.op}|${String(c.val)}`).join('||')}`;
        const n = this.#rows.length;
        if (n === 0) return 0;
        const idx = Math.min(upToIndex, n - 1);
        if (this.#cumReverse) {
            let cache = this.#runningIfCache.get(key);
            if (!cache || cache.length < n) {
                cache = new Float64Array(n); let running = 0;
                for (let i = n - 1; i >= 0; i--) {
                    running += conditions.every(c => matchCondition(this.getValue(i, c.col), c.op, c.val)) ? (Number(this.getValue(i, sumCol)) || 0) : 0;
                    cache[i] = running;
                }
                this.#runningIfCache.set(key, cache);
            }
            return cache[idx] ?? 0;
        }
        let cache = this.#runningIfCache.get(key);
        const dirtyFrom = this.#runningIfDirty.get(key) ?? 0;
        if (!cache || cache.length < n || dirtyFrom <= idx) {
            if (!cache || cache.length < n) cache = new Float64Array(n);
            let running = dirtyFrom > 0 ? cache[dirtyFrom - 1] : 0;
            for (let i = dirtyFrom; i < n; i++) {
                running += conditions.every(c => matchCondition(this.getValue(i, c.col), c.op, c.val)) ? (Number(this.getValue(i, sumCol)) || 0) : 0;
                cache[i] = running;
            }
            this.#runningIfCache.set(key, cache); this.#runningIfDirty.set(key, n);
        }
        return cache[idx] ?? 0;
    }

    #getSumIf(sumCol, filterCol, op, filterVal) {
        return this.#rows.reduce((acc, _, i) => acc + (matchCondition(this.getValue(i, filterCol), op, filterVal) ? (Number(this.getValue(i, sumCol)) || 0) : 0), 0);
    }
    #getSumIfs(sumCol, conditions) {
        return this.#rows.reduce((acc, _, i) => acc + (conditions.every(c => matchCondition(this.getValue(i, c.col), c.op, c.val)) ? (Number(this.getValue(i, sumCol)) || 0) : 0), 0);
    }
    #getCountIf(filterCol, op, filterVal) {
        return this.#rows.filter((_, i) => matchCondition(this.getValue(i, filterCol), op, filterVal)).length;
    }
    #getAvgIf(sumCol, filterCol, op, filterVal) {
        const indices = this.#rows.map((_, i) => i).filter(i => matchCondition(this.getValue(i, filterCol), op, filterVal));
        return indices.length ? indices.reduce((acc, i) => acc + (Number(this.getValue(i, sumCol)) || 0), 0) / indices.length : 0;
    }
    #getMinIf(colId, filterCol, op, filterVal) {
        const vals = this.#rows.map((_, i) => i).filter(i => matchCondition(this.getValue(i, filterCol), op, filterVal)).map(i => Number(this.getValue(i, colId))).filter(v => !isNaN(v));
        return vals.length ? Math.min(...vals) : 0;
    }
    #getMaxIf(colId, filterCol, op, filterVal) {
        const vals = this.#rows.map((_, i) => i).filter(i => matchCondition(this.getValue(i, filterCol), op, filterVal)).map(i => Number(this.getValue(i, colId))).filter(v => !isNaN(v));
        return vals.length ? Math.max(...vals) : 0;
    }

    // ─── Cross-table functions ────────────────────────────────────────────────

    #buildCustomFunctions(tableResolver) {
        this.#customFunctions = buildTableFunctions(tableResolver);
    }
}
