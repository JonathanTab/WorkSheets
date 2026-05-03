/**
 * sheetCellEval.js — shared cross-sheet cell evaluation.
 *
 * Provides makeSheetCellEvaluator(), which builds an evalCell + findSpillValue
 * pair for reading values out of a Yjs cells Y.Map.  Three callers previously
 * each had their own copy of this logic:
 *
 *   - SpreadsheetSession.#initializeFormulaEngine  (setCrossSheetGetter closure)
 *   - SpreadsheetSession.getCrossSheetValue
 *   - ExternalDocManager.#evalCell / #readRange
 *
 * All three now delegate here so formula-chain resolution, cycle detection, and
 * spill-cell handling are implemented exactly once.
 */

import { parseFormula } from '../../formulas/parser.js';
import { evaluate } from '../../formulas/evaluator.js';
import { FormulaError } from '../../formulas/functions.js';

/**
 * Build a cell evaluator pair for a Yjs cells Y.Map.
 *
 * @param {import('yjs').Map} cells
 *   Y.Map keyed by "row,col" → Y.Map with a 'v' field holding the raw value or
 *   formula string.
 * @param {Map<string,Function>|null} customFns
 *   Custom formula functions (e.g. IMPORTRANGE) forwarded to evaluate().
 *   Pass null when no custom functions are needed.
 * @returns {{ evalCell: (r: number, c: number, visited: Set<string>) => any }}
 *   evalCell  — returns the resolved value for cell (r,c), following formula
 *               chains with cycle detection via the visited Set.
 */
export function makeSheetCellEvaluator(cells, customFns) {
    /**
     * Recursively evaluate a cell, following formula strings.
     * Returns null for missing/blank cells; FormulaError.REF on cycles.
     */
    const evalCell = (r, c, visited) => {
        const k = `${r},${c}`;
        if (visited.has(k)) return FormulaError.REF;

        const cm = cells.get(k);
        if (!cm) {
            // No direct data — may be a spill cell from an array-formula anchor.
            return findSpillValue(r, c, visited);
        }

        const v = cm.get?.('v');
        if (v === undefined || v === null) return null;

        if (typeof v === 'string' && v.startsWith('=')) {
            const nextVisited = new Set(visited);
            nextVisited.add(k);
            try {
                const ast = parseFormula(v);
                if (!ast) return null;
                const result = evaluate(
                    ast,
                    (gr, gc) => evalCell(gr, gc, nextVisited),
                    {},
                    customFns,
                    null,
                );
                // Array results (e.g. IMPORTRANGE) — return the scalar at [0][0].
                // Spill cells at other offsets are resolved by findSpillValue.
                if (Array.isArray(result)) {
                    const arr2d = Array.isArray(result[0]) ? result : result.map(x => [x]);
                    return arr2d[0]?.[0] ?? null;
                }
                return result;
            } catch {
                return FormulaError.ERROR;
            }
        }

        // Coerce numeric strings to numbers (matches SheetStore convention).
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
        return v;
    };

    /**
     * Scan the cells map for an array-formula anchor whose spill range covers
     * (r,c), and return the element at the correct row/col offset.
     * This handles cases where (r,c) has no own cell entry but is part of a
     * spill from a nearby IMPORTRANGE / array formula.
     */
    const findSpillValue = (r, c, visited) => {
        let found = null;
        cells.forEach((cm, anchorKey) => {
            if (found !== null) return;
            const [arStr, acStr] = anchorKey.split(',');
            const ar = Number(arStr);
            const ac = Number(acStr);
            // Anchor must be at or before the target cell.
            if (ar > r || ac > c) return;
            const v = cm.get?.('v');
            if (typeof v !== 'string' || !v.startsWith('=')) return;
            if (visited.has(anchorKey)) return;
            try {
                const ast = parseFormula(v);
                if (!ast) return;
                const nextVisited = new Set(visited);
                nextVisited.add(anchorKey);
                const result = evaluate(
                    ast,
                    (gr, gc) => evalCell(gr, gc, nextVisited),
                    {},
                    customFns,
                    null,
                );
                if (!Array.isArray(result)) return;
                const arr2d = Array.isArray(result[0]) ? result : result.map(x => [x]);
                const dr = r - ar;
                const dc = c - ac;
                // dr=0,dc=0 is the anchor itself — evalCell already handles it.
                if (dr === 0 && dc === 0) return;
                if (dr < arr2d.length && dc < (arr2d[0]?.length ?? 0)) {
                    found = arr2d[dr][dc] ?? null;
                }
            } catch {
                // Non-array formula or eval error — not this anchor's spill.
            }
        });
        return found;
    };

    return { evalCell };
}
