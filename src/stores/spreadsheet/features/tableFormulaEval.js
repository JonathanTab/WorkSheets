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

import { parseFormula, NodeType } from '../../../formulas/parser.js';
import { evaluate } from '../../../formulas/evaluator.js';
import { FormulaError } from '../../../formulas/functions.js';
import { parseLocalDate } from '../cellTypes/types/date.js';

/**
 * Cross-table recursion-depth counter. Used by buildTableFunctions() to bail
 * out of runaway recursion (e.g. Table A → TABLE_SUM("B") → B's column
 * formula → TABLE_SUM("A") → … ) with #CIRC! before blowing the JS stack.
 *
 * We can't simply forbid same-table re-entry: TABLE_GET("A", priorRow, "col")
 * from inside a column on A is a legitimate running-total pattern. A depth
 * cap is the lightest correct guard short of full per-(table,column) cycle
 * tracking.
 *
 * JS is single-threaded; this module-level counter is safe.
 * Always paired with try/finally so a throw unwinds the counter correctly.
 */
let _tableEvalDepth = 0;
const _TABLE_EVAL_MAX_DEPTH = 64;

/**
 * Validate a column DSL formula. Column formulas are table-scoped: they may
 * reference other columns via `{colName}`, call functions (including TABLE_*),
 * and use the row-helper DSL (PREV/NEXT/ROWVAL/WINDOW), but they MAY NOT
 * reference sheet cells (A1) or cross-sheet (Sheet2!A1) — those refs evaluate
 * to null at insert time and silently produce wrong values.
 *
 * Returns `{ok: true}` for a valid formula, or
 *        `{ok: false, error: 'human-readable reason'}`.
 *
 * Used by the column-config UI to refuse bad formulas at edit time. The
 * evaluator also surfaces #REF! at runtime when it encounters a CellRef node.
 *
 * @param {string} formula
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateColumnFormula(formula) {
    if (typeof formula !== 'string' || !formula.trim()) return { ok: true };
    // Strip DSL markers ({col}, ROW, ROW1, COUNT) → placeholder so parseFormula
    // doesn't choke on them.
    let stripped = formula.trim();
    if (stripped.startsWith('=')) stripped = stripped.slice(1);
    stripped = stripped.replace(/\{[^}]+\}/g, '0');
    stripped = stripped.replace(/\bROW1?\b\s*(?:\(\s*\))?/g, '0');
    stripped = stripped.replace(/\bCOUNT\b(?!IF)/gi, '0');
    let ast;
    try { ast = parseFormula('=' + stripped); }
    catch (e) { return { ok: false, error: `Syntax: ${e.message}` }; }
    if (!ast) return { ok: true };
    let badRef = null;
    const visit = (node) => {
        if (!node || badRef) return;
        if (node.type === NodeType.CELL_REF) {
            badRef = `Column formulas can't reference sheet cells (got ${node.ref}).`;
            return;
        }
        if (node.type === NodeType.RANGE) {
            badRef = 'Column formulas can\'t reference sheet ranges (e.g. A1:B5).';
            return;
        }
        if (node.type === NodeType.SHEET_REF) {
            badRef = `Column formulas can't reference other sheets (got ${node.sheet}!).`;
            return;
        }
        if (node.left)    visit(node.left);
        if (node.right)   visit(node.right);
        if (node.operand) visit(node.operand);
        if (node.args)    for (const a of node.args) visit(a);
        if (node.ref)     visit(node.ref);
    };
    visit(ast);
    if (badRef) return { ok: false, error: badRef };
    return { ok: true };
}

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

    // Wrap every TABLE_* function with a recursion-depth guard so that
    // cross-table cycles (A → B → A → …) surface as #CIRC! instead of blowing
    // the JS stack. Same-table re-entry (e.g. TABLE_GET("A", prevRow, "x")
    // inside a column on A) is intentionally allowed up to the depth cap.
    const wrapped = new Map();
    for (const [name, fn] of fns) {
        wrapped.set(name, (...args) => {
            if (_tableEvalDepth >= _TABLE_EVAL_MAX_DEPTH) return FormulaError.CIRC;
            _tableEvalDepth++;
            try { return fn(...args); }
            finally { _tableEvalDepth--; }
        });
    }
    return wrapped;
}

// ─── Dependency analysis ──────────────────────────────────────────────────────

const CROSS_ROW_PATTERN = /\b(PREV|NEXT|ROWVAL|WINDOW)\s*\(/i;
const COL_REF_PATTERN   = /\{([^}]+)\}/g;

// Matches TABLE_<FUNC>(<firstArg>, ...) capturing the literal name (group 1/2) or
// signalling a dynamic first arg via group 3. The name is intentionally permissive:
// any quoted string or any token up to the first comma / closing paren.
const TABLE_FN_PATTERN = /\bTABLE_[A-Z_]+\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^,)]+))/gi;

/**
 * Scan a column DSL formula string for TABLE_*("name", ...) references.
 * Used by DocumentTableRegistry to know which stores must be invalidated when a
 * given source table's rows change.
 *
 * @param {string} formula
 * @returns {{ names: Set<string>, wildcard: boolean }}
 *   names    - uppercased table names referenced with a literal first arg
 *   wildcard - true if any TABLE_* call uses a non-literal (dynamic) first arg
 */
export function extractTableRefsFromColumnFormula(formula) {
    const names = new Set();
    let wildcard = false;
    if (typeof formula !== 'string' || !formula) return { names, wildcard };
    TABLE_FN_PATTERN.lastIndex = 0;
    let m;
    while ((m = TABLE_FN_PATTERN.exec(formula)) !== null) {
        if (m[1] !== undefined)      names.add(m[1].toUpperCase());
        else if (m[2] !== undefined) names.add(m[2].toUpperCase());
        else                          wildcard = true;
    }
    return { names, wildcard };
}


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
                    const val = this.#evalFormula(formula, i, colId);
                    this.#computed[i].set(colId, val);
                } else {
                    // defaultFormula: use stored value if present (override), else compute
                    const stored = this.#rows[i]?.[colId];
                    if (stored !== undefined && stored !== null) {
                        this.#computed[i].set(colId, this.#resolveMaybeFormula(stored));
                    } else {
                        const val = this.#evalFormula(formula, i, colId);
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

    #evalFormula(formula, rowIndex, colId = null) {
        let expr = formula.trim();
        if (expr.startsWith('=')) expr = expr.slice(1).trimStart();
        if (expr.includes('ROW')) {
            expr = expr.replace(/\bROW1\s*(?:\(\s*\))?/g, String(rowIndex + 1));
            expr = expr.replace(/\bROW\s*(?:\(\s*\))?(?!\s*\w)/g, String(rowIndex));
        }
        if (expr.includes('COUNT')) {
            expr = expr.replace(/\bCOUNT\b(?!IF)/gi, String(this.getRowCount()));
        }
        if (expr.includes('{')) {
            expr = this.#substituteColRefs(expr, rowIndex);
        }
        expr = this.#substituteTableFunctions(expr, rowIndex, false);
        return this.#evalExpression(expr);
    }

    /** Evaluate formula with a temporary row object (used for new-row default formulas). */
    #evalFormulaWithTempRow(formula, rowIndex, tempRow) {
        let expr = formula.trim();
        if (expr.startsWith('=')) expr = expr.slice(1).trimStart();
        expr = expr.replace(/\bROW1\s*(?:\(\s*\))?/g, String(rowIndex + 1));
        expr = expr.replace(/\bROW\s*(?:\(\s*\))?(?!\s*\w)/g, String(rowIndex));
        expr = expr.replace(/\bCOUNT\b(?!IF)/gi, String(this.getRowCount() + 1));
        expr = expr.replace(/\{([^}]+)\}/g, (_m, rawRef) => {
            const colId = this.resolveColId(rawRef.trim());
            const val = tempRow[colId];
            return this.#valToExpr(val);
        });
        expr = this.#substituteTableFunctions(expr, rowIndex, true);
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

    // ─── Single-pass table function substitution ───────────────────────────────

    /**
     * Replace all row-helper (PREV/NEXT/ROWVAL/WINDOW) and column-aggregate
     * (SUM/AVG/MIN/MAX/RUNNINGIF/SUMIF/…) calls in a single O(n) left-to-right
     * scan. Nested calls are handled via recursion on each function's arg string.
     *
     * Replaces the former pair of 20-pass regex loops, which were O(n²) in the
     * number of function calls.
     *
     * @param {string}  expr      - Expression to process (no leading '=')
     * @param {number}  rowIndex  - Current row index (0-based)
     * @param {boolean} isNewRow  - True when evaluating default formulas for a new row
     */
    #substituteTableFunctions(expr, rowIndex, isNewRow) {
        // Quick exit: none of the substitutable keywords present
        if (!expr.includes('PREV') && !expr.includes('NEXT') &&
            !expr.includes('ROWVAL') && !expr.includes('WINDOW') &&
            !expr.includes('SUM') && !expr.includes('AVG') &&
            !expr.includes('MIN') && !expr.includes('MAX') &&
            !expr.includes('COUNT') && !expr.includes('RUNNING')) return expr;

        // New RegExp per call so recursive calls don't share `lastIndex` state.
        const RE = new RegExp(
            '\\b(WINDOW|ROWVAL|PREV|NEXT|RUNNINGIFS|RUNNINGIF|SUMIFS|SUMIF|AVGIF|MINIF|MAXIF|COUNTIF|AVG|MIN|MAX|SUM)\\s*\\(',
            'gi'
        );

        let result = '';
        let lastEnd = 0;
        let m;

        while ((m = RE.exec(expr)) !== null) {
            const fnName  = m[1].toUpperCase();
            const openIdx = m.index + m[0].length - 1; // index of '('
            const closeIdx = findCloseParen(expr, openIdx);
            if (closeIdx === -1) continue;

            // Recursively substitute any nested table functions inside the args
            const innerRaw = expr.slice(openIdx + 1, closeIdx);
            const innerSub = this.#substituteTableFunctions(innerRaw, rowIndex, isNewRow);
            const rawArgs  = splitArgs(innerSub);

            let callResult;
            if (fnName === 'PREV' || fnName === 'NEXT' || fnName === 'ROWVAL' || fnName === 'WINDOW') {
                if (isNewRow) {
                    // New-row context: PREV reads last existing row, NEXT returns default/null
                    if (fnName === 'PREV') {
                        const colId = this.resolveColId(String(this.#evalArg(rawArgs[0] ?? '') ?? ''));
                        callResult = this.#rows.length > 0
                            ? this.#getComputed(this.#rows.length - 1, colId) ?? (rawArgs[1] !== undefined ? this.#evalArg(rawArgs[1]) : 0)
                            : (rawArgs[1] !== undefined ? this.#evalArg(rawArgs[1]) : 0);
                    } else if (fnName === 'NEXT') {
                        callResult = rawArgs[1] !== undefined ? this.#evalArg(rawArgs[1]) : null;
                    } else {
                        callResult = this.#callRowHelper(fnName, rawArgs, this.#rows.length);
                    }
                } else {
                    callResult = this.#callRowHelper(fnName, rawArgs, rowIndex);
                }
            } else {
                callResult = this.#callAggregateFunc(fnName, rawArgs, rowIndex);
            }

            result += expr.slice(lastEnd, m.index) + resultToExpr(callResult);
            lastEnd = closeIdx + 1;
            RE.lastIndex = lastEnd;
        }

        return result + expr.slice(lastEnd);
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
        // CellRef ('A1') and SheetRef ('Sheet1!A1') inside column DSL formulas
        // are scoped errors — surface #REF! at runtime so the user sees an
        // obvious problem instead of silent 0/null. validateColumnFormula
        // catches these at edit time when the UI uses it.
        try { return evaluate(parseFormula('=' + t), () => '#REF!', {}, this.#customFunctions); } catch { return null; }
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
