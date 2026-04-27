/**
 * tableFormulaEval.js — pure JS (no Svelte runes), importable in Node.js.
 *
 * Exports TableFormulaEvaluator: given a snapshot of sorted/filtered rows and
 * column definitions, evaluates computed column formulas including all aggregates,
 * running sums, and the {colRef} / ROW / COUNT DSL.
 *
 * Used by:
 *   - TableStore.svelte.js  (browser, delegates getValue / getCumulativeSum)
 *   - operations.js         (Node.js / server, evaluates formula columns from Yjs data)
 */

import { parseFormula } from '../../../formulas/parser.js';
import { evaluate } from '../../../formulas/evaluator.js';

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
    if (typeof rv === 'string' && typeof fv === 'string' && rv.includes('-') && fv.includes('-')) {
        const rvD = Date.parse(rv), fvD = Date.parse(fv);
        if (!isNaN(rvD) && !isNaN(fvD)) {
            switch (op) {
                case '=': case '==': return rvD === fvD;
                case '<>': case '!=': return rvD !== fvD;
                case '>': return rvD > fvD; case '<': return rvD < fvD;
                case '>=': return rvD >= fvD; case '<=': return rvD <= fvD;
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
        default: return false;
    }
}

// ─── TableFormulaEvaluator ────────────────────────────────────────────────────

/**
 * Stateful evaluator for a table's computed columns.
 *
 * @param {object[]} rows      Sorted/filtered rows (plain objects, colId → value).
 * @param {object[]} columns   Column defs: [{id, name, isNonEntry, formula, ...}].
 * @param {boolean}  cumReverse  True when display is newest-first (no sort or desc sort).
 */
export class TableFormulaEvaluator {
    /** @type {object[]} */ #rows;
    /** @type {object[]} */ #cols;
    /** @type {boolean}  */ #cumReverse;
    /** @type {Map<string,string>} lowercase name/id → canonical id */ #nameToId;
    /** @type {Map<string,Function>|null} */ #customFunctions = null;
    #cumCache        = new Map();
    #cumDirtyFrom    = new Map();
    #runningIfCache  = new Map();
    #runningIfDirty  = new Map();

    /**
     * @param {object[]} rows         Sorted/filtered rows (plain objects, colId → value).
     * @param {object[]} columns      Column defs: [{id, name, isNonEntry, formula, ...}].
     * @param {boolean}  cumReverse   True when display is newest-first.
     * @param {((name: string) => {getValue,getRowCount,resolveColId,getColumn}|null)|null} tableResolver
     *   Optional: resolves another table by name for TABLE_* cross-table functions.
     */
    constructor(rows, columns, cumReverse = false, tableResolver = null) {
        this.#rows       = rows;
        this.#cols       = columns;
        this.#cumReverse = cumReverse;
        this.#nameToId   = new Map();
        for (const col of columns) {
            this.#nameToId.set(col.id.toLowerCase(), col.id);
            if (col.name) this.#nameToId.set(col.name.toLowerCase(), col.id);
        }
        if (tableResolver) this.#buildCustomFunctions(tableResolver);
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    resolveColId(nameOrId) {
        if (!nameOrId) return String(nameOrId);
        return this.#nameToId.get(String(nameOrId).toLowerCase()) ?? String(nameOrId);
    }

    getRowCount() { return this.#rows.length; }

    getValue(rowIndex, colId) {
        const def = this.#cols.find(c => c.id === colId);
        if (def?.isNonEntry && def.formula) return this.evaluateFormula(def.formula, rowIndex);
        return this.#rows[rowIndex]?.[colId];
    }

    getColumn(colId) {
        return this.#rows.map((_, i) => this.getValue(i, colId));
    }

    getCumulativeSum(colId, upToIndex) {
        const rows = this.#rows, n = rows.length;
        if (n === 0) return 0;
        const idx = Math.min(upToIndex, n - 1);

        if (this.#cumReverse) {
            let cache = this.#cumCache.get(colId);
            if (!cache || cache.length < n) {
                cache = new Float64Array(n);
                let running = 0;
                for (let i = n - 1; i >= 0; i--) { running += Number(rows[i]?.[colId]) || 0; cache[i] = running; }
                this.#cumCache.set(colId, cache);
            }
            return cache[idx] ?? 0;
        }

        let cache = this.#cumCache.get(colId);
        const dirtyFrom = this.#cumDirtyFrom.get(colId) ?? 0;
        if (!cache || cache.length < n || dirtyFrom <= idx) {
            if (!cache || cache.length < n) cache = new Float64Array(n);
            let running = dirtyFrom > 0 ? cache[dirtyFrom - 1] : 0;
            for (let i = dirtyFrom; i < n; i++) { running += Number(rows[i]?.[colId]) || 0; cache[i] = running; }
            this.#cumCache.set(colId, cache);
            this.#cumDirtyFrom.set(colId, n);
        }
        return cache[idx] ?? 0;
    }

    evaluateFormula(formula, rowIndex) {
        try {
            let expr = formula.trim();
            if (expr.startsWith('=')) expr = expr.slice(1).trimStart();
            expr = expr.replace(/\bROW1\s*(?:\(\s*\))?/g, String(rowIndex + 1));
            expr = expr.replace(/\bROW\s*(?:\(\s*\))?(?!\s*\w)/g, String(rowIndex));
            expr = expr.replace(/\bCOUNT\b(?!IF)/gi, String(this.getRowCount()));
            expr = this.#substituteColRefs(expr, rowIndex);
            expr = this.#substituteTableFuncs(expr, rowIndex);
            return this.#evalExpression(expr);
        } catch { return null; }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    #substituteColRefs(expr, rowIndex) {
        return expr.replace(/\{([^}]+)\}/g, (_m, rawRef) => {
            const colId = this.resolveColId(rawRef.trim());
            const val   = this.#rows[rowIndex]?.[colId];
            if (val === null || val === undefined || val === '') return '""';
            if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
            if (typeof val === 'string') return JSON.stringify(val);
            const num = Number(val);
            return !isNaN(num) ? String(num) : JSON.stringify(String(val));
        });
    }

    #substituteTableFuncs(expr, rowIndex) {
        const KNOWN = ['RUNNINGIFS', 'RUNNINGIF', 'SUMIFS', 'SUMIF',
                       'AVGIF', 'MINIF', 'MAXIF', 'COUNTIF',
                       'CUMSUM', 'AVG', 'MIN', 'MAX', 'SUM'];
        for (let pass = 0; pass < 20; pass++) {
            let replaced = false;
            for (const fn of KNOWN) {
                const m = new RegExp(`\\b${fn}\\s*\\(`, 'i').exec(expr);
                if (!m) continue;
                replaced = true;
                const openIdx  = m.index + m[0].length - 1;
                const closeIdx = findCloseParen(expr, openIdx);
                if (closeIdx === -1) continue;
                const result = this.#callTableFunc(fn.toUpperCase(), splitArgs(expr.slice(openIdx + 1, closeIdx)), rowIndex);
                expr = expr.slice(0, m.index) + resultToExpr(result) + expr.slice(closeIdx + 1);
                break;
            }
            if (!replaced) break;
        }
        return expr;
    }

    #callTableFunc(fn, rawArgs, rowIndex) {
        const args = rawArgs.map(a => this.#evalArg(a.trim()));
        const col  = (i) => this.resolveColId(String(args[i] ?? ''));
        switch (fn) {
            case 'CUMSUM': return this.getCumulativeSum(col(0), rowIndex);
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
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) return arg.slice(1, -1);
        const num = Number(arg);
        if (arg !== '' && !isNaN(num)) return num;
        return arg;
    }

    #evalExpression(expr) {
        const t = expr.trim();
        if (!t || t === '""') return null;
        const num = Number(t);
        if (t !== '' && !isNaN(num)) return num;
        try { return evaluate(parseFormula('=' + t), () => null, {}, this.#customFunctions); } catch { return null; }
    }

    #buildCustomFunctions(tableResolver) {
        const fns = new Map();
        const tbl = (name) => tableResolver(String(name ?? ''));

        fns.set('TABLE_GET', (tableName, rowIndex, colId) => {
            const t = tbl(tableName); if (!t) return null;
            return t.getValue(Number(rowIndex), t.resolveColId(String(colId))) ?? null;
        });

        fns.set('TABLE_COL', (tableName, colId) => {
            const t = tbl(tableName); if (!t) return [];
            return t.getColumn(t.resolveColId(String(colId)));
        });

        fns.set('TABLE_COUNT', (tableName) => {
            const t = tbl(tableName); return t ? t.getRowCount() : 0;
        });

        fns.set('TABLE_SUM', (tableName, colId) => {
            const t = tbl(tableName); if (!t) return 0;
            return t.getColumn(t.resolveColId(String(colId))).reduce((acc, v) => acc + (Number(v) || 0), 0);
        });

        fns.set('TABLE_AVG', (tableName, colId) => {
            const t = tbl(tableName); if (!t) return 0;
            const vals = t.getColumn(t.resolveColId(String(colId))).map(Number).filter(v => !isNaN(v));
            return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
        });

        fns.set('TABLE_MIN', (tableName, colId) => {
            const t = tbl(tableName); if (!t) return 0;
            const vals = t.getColumn(t.resolveColId(String(colId))).map(Number).filter(v => !isNaN(v));
            return vals.length ? Math.min(...vals) : 0;
        });

        fns.set('TABLE_MAX', (tableName, colId) => {
            const t = tbl(tableName); if (!t) return 0;
            const vals = t.getColumn(t.resolveColId(String(colId))).map(Number).filter(v => !isNaN(v));
            return vals.length ? Math.max(...vals) : 0;
        });

        fns.set('TABLE_CUMSUM', (tableName, colId, upToIndex) => {
            const t = tbl(tableName); if (!t) return 0;
            return t.getCumulativeSum(t.resolveColId(String(colId)), Number(upToIndex));
        });

        fns.set('TABLE_SUMIF', (tableName, sumColId, filterColId, op, filterValue) => {
            const t = tbl(tableName); if (!t) return 0;
            const sId = t.resolveColId(String(sumColId)), fId = t.resolveColId(String(filterColId));
            let sum = 0;
            for (let i = 0; i < t.getRowCount(); i++)
                if (matchCondition(t.getValue(i, fId), String(op), filterValue))
                    sum += Number(t.getValue(i, sId)) || 0;
            return sum;
        });

        fns.set('TABLE_SUMIFS', (tableName, sumColId, ...triplets) => {
            const t = tbl(tableName); if (!t || triplets.length < 3) return 0;
            const sId = t.resolveColId(String(sumColId));
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            let sum = 0;
            for (let i = 0; i < t.getRowCount(); i++)
                if (conds.every(c => matchCondition(t.getValue(i, c.col), c.op, c.val)))
                    sum += Number(t.getValue(i, sId)) || 0;
            return sum;
        });

        fns.set('TABLE_COUNTIF', (tableName, filterColId, op, filterValue) => {
            const t = tbl(tableName); if (!t) return 0;
            const fId = t.resolveColId(String(filterColId));
            let count = 0;
            for (let i = 0; i < t.getRowCount(); i++)
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) count++;
            return count;
        });

        fns.set('TABLE_COUNTIFS', (tableName, ...triplets) => {
            const t = tbl(tableName); if (!t || triplets.length < 3) return 0;
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            let count = 0;
            for (let i = 0; i < t.getRowCount(); i++)
                if (conds.every(c => matchCondition(t.getValue(i, c.col), c.op, c.val))) count++;
            return count;
        });

        fns.set('TABLE_AVGIF', (tableName, sumColId, filterColId, op, filterValue) => {
            const t = tbl(tableName); if (!t) return 0;
            const sId = t.resolveColId(String(sumColId)), fId = t.resolveColId(String(filterColId));
            let sum = 0, count = 0;
            for (let i = 0; i < t.getRowCount(); i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) { sum += Number(t.getValue(i, sId)) || 0; count++; }
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
            for (let i = 0; i < t.getRowCount(); i++) {
                if (conds.every(c => matchCondition(t.getValue(i, c.col), c.op, c.val))) { sum += Number(t.getValue(i, sId)) || 0; count++; }
            }
            return count ? sum / count : 0;
        });

        fns.set('TABLE_MINIF', (tableName, colId, filterColId, op, filterValue) => {
            const t = tbl(tableName); if (!t) return 0;
            const cId = t.resolveColId(String(colId)), fId = t.resolveColId(String(filterColId));
            let min = Infinity;
            for (let i = 0; i < t.getRowCount(); i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) { const v = Number(t.getValue(i, cId)); if (!isNaN(v) && v < min) min = v; }
            }
            return isFinite(min) ? min : 0;
        });

        fns.set('TABLE_MAXIF', (tableName, colId, filterColId, op, filterValue) => {
            const t = tbl(tableName); if (!t) return 0;
            const cId = t.resolveColId(String(colId)), fId = t.resolveColId(String(filterColId));
            let max = -Infinity;
            for (let i = 0; i < t.getRowCount(); i++) {
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) { const v = Number(t.getValue(i, cId)); if (!isNaN(v) && v > max) max = v; }
            }
            return isFinite(max) ? max : 0;
        });

        fns.set('TABLE_FILTERCOL', (tableName, colId, filterColId, op, filterValue) => {
            const t = tbl(tableName); if (!t) return [];
            const cId = t.resolveColId(String(colId)), fId = t.resolveColId(String(filterColId));
            const result = [];
            for (let i = 0; i < t.getRowCount(); i++)
                if (matchCondition(t.getValue(i, fId), String(op), filterValue)) result.push(t.getValue(i, cId) ?? null);
            return result;
        });

        fns.set('TABLE_FILTERCOLIFS', (tableName, colId, ...triplets) => {
            const t = tbl(tableName); if (!t || triplets.length < 3) return [];
            const cId = t.resolveColId(String(colId));
            const conds = [];
            for (let i = 0; i + 2 < triplets.length; i += 3)
                conds.push({ col: t.resolveColId(String(triplets[i])), op: String(triplets[i + 1]), val: triplets[i + 2] });
            const result = [];
            for (let i = 0; i < t.getRowCount(); i++)
                if (conds.every(c => matchCondition(t.getValue(i, c.col), c.op, c.val))) result.push(t.getValue(i, cId) ?? null);
            return result;
        });

        fns.set('TABLE_LOOKUP', (tableName, lookupColId, lookupValue, returnColId) => {
            const t = tbl(tableName); if (!t) return '#N/A';
            const lId = t.resolveColId(String(lookupColId)), rId = t.resolveColId(String(returnColId));
            for (let i = 0; i < t.getRowCount(); i++)
                if (matchCondition(t.getValue(i, lId), '=', lookupValue)) return t.getValue(i, rId) ?? null;
            return '#N/A';
        });

        fns.set('TABLE_FILTER', (tableName, colId, op, value) => {
            const t = tbl(tableName); if (!t) return 0;
            const cId = t.resolveColId(String(colId));
            let count = 0;
            for (let i = 0; i < t.getRowCount(); i++)
                if (matchCondition(t.getValue(i, cId), String(op), value)) count++;
            return count;
        });

        this.#customFunctions = fns;
    }

    #getRunningIf(sumCol, filterCol, op, filterVal, upToIndex) {
        const key = `${sumCol}|${filterCol}|${op}|${String(filterVal)}`;
        const rows = this.#rows, n = rows.length;
        if (n === 0) return 0;
        const idx = Math.min(upToIndex, n - 1);

        if (this.#cumReverse) {
            let cache = this.#runningIfCache.get(key);
            if (!cache || cache.length < n) {
                cache = new Float64Array(n); let running = 0;
                for (let i = n - 1; i >= 0; i--) { running += matchCondition(rows[i][filterCol], op, filterVal) ? (Number(rows[i][sumCol]) || 0) : 0; cache[i] = running; }
                this.#runningIfCache.set(key, cache);
            }
            return cache[idx] ?? 0;
        }

        let cache = this.#runningIfCache.get(key);
        const dirtyFrom = this.#runningIfDirty.get(key) ?? 0;
        if (!cache || cache.length < n || dirtyFrom <= idx) {
            if (!cache || cache.length < n) cache = new Float64Array(n);
            let running = dirtyFrom > 0 ? cache[dirtyFrom - 1] : 0;
            for (let i = dirtyFrom; i < n; i++) { running += matchCondition(rows[i][filterCol], op, filterVal) ? (Number(rows[i][sumCol]) || 0) : 0; cache[i] = running; }
            this.#runningIfCache.set(key, cache); this.#runningIfDirty.set(key, n);
        }
        return cache[idx] ?? 0;
    }

    #getRunningIfs(sumCol, conditions, upToIndex) {
        const key = `${sumCol}||${conditions.map(c => `${c.col}|${c.op}|${String(c.val)}`).join('||')}`;
        const rows = this.#rows, n = rows.length;
        if (n === 0) return 0;
        const idx = Math.min(upToIndex, n - 1);

        if (this.#cumReverse) {
            let cache = this.#runningIfCache.get(key);
            if (!cache || cache.length < n) {
                cache = new Float64Array(n); let running = 0;
                for (let i = n - 1; i >= 0; i--) { running += conditions.every(c => matchCondition(rows[i][c.col], c.op, c.val)) ? (Number(rows[i][sumCol]) || 0) : 0; cache[i] = running; }
                this.#runningIfCache.set(key, cache);
            }
            return cache[idx] ?? 0;
        }

        let cache = this.#runningIfCache.get(key);
        const dirtyFrom = this.#runningIfDirty.get(key) ?? 0;
        if (!cache || cache.length < n || dirtyFrom <= idx) {
            if (!cache || cache.length < n) cache = new Float64Array(n);
            let running = dirtyFrom > 0 ? cache[dirtyFrom - 1] : 0;
            for (let i = dirtyFrom; i < n; i++) { running += conditions.every(c => matchCondition(rows[i][c.col], c.op, c.val)) ? (Number(rows[i][sumCol]) || 0) : 0; cache[i] = running; }
            this.#runningIfCache.set(key, cache); this.#runningIfDirty.set(key, n);
        }
        return cache[idx] ?? 0;
    }

    #getSumIf(sumCol, filterCol, op, filterVal) {
        return this.#rows.reduce((acc, row) => acc + (matchCondition(row[filterCol], op, filterVal) ? (Number(row[sumCol]) || 0) : 0), 0);
    }
    #getSumIfs(sumCol, conditions) {
        return this.#rows.reduce((acc, row) => acc + (conditions.every(c => matchCondition(row[c.col], c.op, c.val)) ? (Number(row[sumCol]) || 0) : 0), 0);
    }
    #getCountIf(filterCol, op, filterVal) {
        return this.#rows.filter(row => matchCondition(row[filterCol], op, filterVal)).length;
    }
    #getAvgIf(sumCol, filterCol, op, filterVal) {
        const matching = this.#rows.filter(row => matchCondition(row[filterCol], op, filterVal));
        return matching.length ? matching.reduce((acc, row) => acc + (Number(row[sumCol]) || 0), 0) / matching.length : 0;
    }
    #getMinIf(colId, filterCol, op, filterVal) {
        const vals = this.#rows.filter(row => matchCondition(row[filterCol], op, filterVal)).map(row => Number(row[colId])).filter(v => !isNaN(v));
        return vals.length ? Math.min(...vals) : 0;
    }
    #getMaxIf(colId, filterCol, op, filterVal) {
        const vals = this.#rows.filter(row => matchCondition(row[filterCol], op, filterVal)).map(row => Number(row[colId])).filter(v => !isNaN(v));
        return vals.length ? Math.max(...vals) : 0;
    }
}
