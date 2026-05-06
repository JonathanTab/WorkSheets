/**
 * sheetCellEval.js — shared cross-sheet cell evaluation.
 *
 * Provides makeSheetCellEvaluator(), which builds an evalCell + findSpillValue
 * pair for reading values out of a cellValues YKeyValue store. Three callers:
 *
 *   - SpreadsheetSession.#initializeFormulaEngine  (setCrossSheetGetter closure)
 *   - SpreadsheetSession.getCrossSheetValue
 *   - ExternalDocManager.#evalCell / #readRange
 *
 * The first argument is a YKeyValue (from y-utility) wrapping the cellValues
 * Y.Array.  Each entry is a plain object { v, t } keyed by "row,col".
 */

import { parseFormula } from '../../formulas/parser.js';
import { evaluate } from '../../formulas/evaluator.js';
import { FormulaError } from '../../formulas/functions.js';

/**
 * Build a cell evaluator pair for a cellValues YKeyValue store.
 *
 * @param {import('y-utility/y-keyvalue').YKeyValue<any>} cellValuesKV
 *   YKeyValue keyed by "row,col" → plain object { v, t }.
 * @param {Map<string,Function>|null} customFns
 *   Custom formula functions (e.g. IMPORTRANGE). Pass null when not needed.
 * @returns {{ evalCell: (r: number, c: number, visited: Set<string>) => any }}
 */
export function makeSheetCellEvaluator(cellValuesKV, customFns) {
    /** @param {number} r @param {number} c @param {Set<string>} visited */
    const evalCell = (r, c, visited) => {
        const k = `${r},${c}`;
        if (visited.has(k)) return FormulaError.REF;

        const data = cellValuesKV?.get(k);
        if (!data) {
            return findSpillValue(r, c, visited);
        }

        const v = data.v;
        if (v === undefined || v === null) return null;

        if (typeof v === 'string' && v.startsWith('=')) {
            const nextVisited = new Set(visited);
            nextVisited.add(k);
            try {
                const ast = parseFormula(v);
                if (!ast) return null;
                const result = evaluate(
                    ast,
                    /** @param {number} gr @param {number} gc */ (gr, gc) => evalCell(gr, gc, nextVisited),
                    {},
                    customFns,
                    null,
                );
                if (Array.isArray(result)) {
                    const arr2d = Array.isArray(result[0]) ? result : result.map(x => [x]);
                    return arr2d[0]?.[0] ?? null;
                }
                return result;
            } catch {
                return FormulaError.ERROR;
            }
        }

        if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
        return v;
    };

    /** @param {number} r @param {number} c @param {Set<string>} visited */
    const findSpillValue = (r, c, visited) => {
        if (!cellValuesKV) return null;
        let found = null;
        for (const [anchorKey, { val: data }] of cellValuesKV.map) {
            if (found !== null) break;
            const [arStr, acStr] = anchorKey.split(',');
            const ar = Number(arStr);
            const ac = Number(acStr);
            if (ar > r || ac > c) continue;
            const v = data?.v;
            if (typeof v !== 'string' || !v.startsWith('=')) continue;
            if (visited.has(anchorKey)) continue;
            try {
                const ast = parseFormula(v);
                if (!ast) continue;
                const nextVisited = new Set(visited);
                nextVisited.add(anchorKey);
                const result = evaluate(
                    ast,
                    /** @param {number} gr @param {number} gc */ (gr, gc) => evalCell(gr, gc, nextVisited),
                    {},
                    customFns,
                    null,
                );
                if (!Array.isArray(result)) continue;
                const arr2d = Array.isArray(result[0]) ? result : result.map(x => [x]);
                const dr = r - ar;
                const dc = c - ac;
                if (dr === 0 && dc === 0) continue;
                if (dr < arr2d.length && dc < (arr2d[0]?.length ?? 0)) {
                    found = arr2d[dr][dc] ?? null;
                }
            } catch {
                // not this anchor's spill
            }
        }
        return found;
    };

    return { evalCell };
}
