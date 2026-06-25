/**
 * Custom-formula conditional formatting.
 *
 * Evaluates a user-authored formula (e.g. =AND($I2<0, NOT(ISERROR(MATCH(F2,$A$4:$A$14,0)))))
 * for each cell in a rule's range, using the currently-*displayed* grid values —
 * so it transparently reads table cells (which render at grid coordinates) as well
 * as ordinary cells.
 *
 * The formula is written relative to the rule's top-left anchor; for every other
 * cell in the range its relative references are shifted (absolute $refs stay put),
 * matching spreadsheet semantics.
 */

import { parseFormula } from '../../formulas/parser.js';
import evaluate, { offsetRefs } from '../../formulas/evaluator.js';
import { isError } from '../../formulas/functions.js';

// Parsed-AST cache keyed by formula string (parsing is the expensive part and the
// same handful of CF formulas are evaluated across many cells, every repaint).
const astCache = new Map();

function getAst(formula) {
    if (astCache.has(formula)) return astCache.get(formula);
    let ast = null;
    try {
        ast = parseFormula(formula.trim().startsWith('=') ? formula.trim() : '=' + formula.trim());
    } catch {
        ast = null;
    }
    astCache.set(formula, ast);
    return ast;
}

/** Coerce a formula result to a pass/fail boolean (Sheets-style). */
function toBool(v) {
    if (isError(v)) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        return s === 'true';
    }
    return false;
}

/**
 * Evaluate a custom-formula CF rule for one cell.
 * @param {string} formula      the rule's formula
 * @param {number} anchorRow    rule range's top-left row (relative-ref origin)
 * @param {number} anchorCol    rule range's top-left col
 * @param {number} cellRow      the cell being tested
 * @param {number} cellCol
 * @param {import('./SpreadsheetSession.svelte.js').SpreadsheetSession} session
 * @returns {boolean} true if the rule's style should apply to this cell
 */
export function evalFormulaRule(formula, anchorRow, anchorCol, cellRow, cellCol, session) {
    if (!formula || !session) return false;
    const baseAst = getAst(formula);
    if (!baseAst) return false;

    const shifted = offsetRefs(baseAst, cellRow - anchorRow, cellCol - anchorCol);

    const getCellValue = (r, c) => session.getCellDisplayValue(r, c);
    const getCrossSheetValue = (name, r, c) => session.getCrossSheetValue(name, r, c);

    try {
        const result = evaluate(shifted, getCellValue, {}, null, getCrossSheetValue);
        return toBool(result);
    } catch {
        return false;
    }
}
