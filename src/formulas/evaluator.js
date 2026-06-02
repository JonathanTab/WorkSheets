/**
 * Formula Evaluator
 *
 * Evaluates an AST produced by the parser and returns a computed value.
 * Requires a cell value getter function to retrieve values from cells.
 */

import { NodeType, parseFormula } from './parser.js';
import { getFunction, isError, FormulaError, parseNumericString } from './functions.js';
import { coerceToSerial } from './dateCore.js';
import { log } from '../util/log.js';

/**
 * If value is a non-numeric string that looks like a date, return its serial.
 * Plain numeric strings are intentionally excluded — those are handled by
 * parseNumericString before this is called.
 * Returns null if coercion fails.
 * @param {any} v
 * @returns {number|null}
 */
function maybeDateSerial(v) {
    if (typeof v !== 'string') return null;
    if (!isNaN(parseNumericString(v))) return null; // plain number string — not a date
    return coerceToSerial(v);
}

/**
 * Resolve a value for use in arithmetic: number → itself, boolean → 0/1,
 * numeric string → number, date string → serial, other string → original.
 * @param {any} v
 * @returns {any}
 */
function resolveNumeric(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v == null) return 0;
    if (typeof v === 'string') {
        const n = parseNumericString(v);
        if (!isNaN(n)) return n;
        const s = maybeDateSerial(v);
        if (s !== null) return s;
    }
    return v;
}

// Formula string → AST cache. Parsing is expensive; the AST is a pure function
// of the formula string so caching is safe. True LRU: on a hit we delete+set
// the entry to move it to the most-recently-used end of the Map's insertion
// order, so a hot small set isn't evicted by churn through cold formulas.
const _parseCache = new Map();
const _PARSE_CACHE_MAX = 1000;

export function cachedParseFormula(formula) {
    if (_parseCache.has(formula)) {
        const ast = _parseCache.get(formula);
        // Touch — move to MRU end.
        _parseCache.delete(formula);
        _parseCache.set(formula, ast);
        return ast;
    }
    const ast = parseFormula(formula) ?? null;
    _parseCache.set(formula, ast);
    if (_parseCache.size > _PARSE_CACHE_MAX) {
        const firstKey = _parseCache.keys().next().value;
        _parseCache.delete(firstKey);
    }
    return ast;
}

/**
 * Evaluate an AST node
 * @param {Object} ast - The AST node to evaluate
 * @param {Function} getCellValue - Function to get cell value: (row, col) => value
 * @param {Object} context - Evaluation context (e.g. { rep: 2 } for repeaters)
 * @param {Map<string,Function>|null} customFunctions - Extra function registry (TABLE_* etc.)
 * @param {Function|null} getCrossSheetValue - Function to get a value from another sheet: (sheetName, row, col) => value
 * @returns {any} - The computed value
 */
export function evaluate(ast, getCellValue, context = {}, customFunctions = null, getCrossSheetValue = null) {
    if (!ast) return null;

    switch (ast.type) {
        case NodeType.NUMBER:
            return ast.value;

        case NodeType.STRING:
            return ast.value;

        case NodeType.CELL_REF:
            return evaluateCellRef(ast, getCellValue);

        case NodeType.RANGE:
            return evaluateRange(ast, getCellValue);

        case NodeType.BINARY_OP:
            return evaluateBinaryOp(ast, getCellValue, context, customFunctions, getCrossSheetValue);

        case NodeType.UNARY_OP:
            return evaluateUnaryOp(ast, getCellValue, context, customFunctions, getCrossSheetValue);

        case NodeType.FUNCTION_CALL:
            return evaluateFunctionCall(ast, getCellValue, context, customFunctions, getCrossSheetValue);

        case NodeType.SHEET_REF:
            return evaluateSheetRef(ast, getCrossSheetValue);

        case NodeType.REP_VAR:
            // $rep variable – returns the current repetition index (0-based)
            return context?.rep ?? 0;

        case NodeType.ERROR_LITERAL:
            // Literal error token (e.g. =#REF! from a delete-row rewrite) — emit as runtime error.
            return ast.value;

        case 'Missing':
            // Missing optional argument (e.g. trailing comma in IF(A1,1,))
            return undefined;

        default:
            return FormulaError.VALUE;
    }
}

// (checkForError stub was removed — the parser never emits error-literal nodes,
// so per-node pre-checks were always a no-op.  Error propagation happens through
// the evaluators via isError() checks on evaluated sub-expressions.)

/**
 * Evaluate a cell reference
 */
function evaluateCellRef(ast, getCellValue) {
    if (!getCellValue) {
        return FormulaError.REF;
    }

    const value = getCellValue(ast.row, ast.col);

    // If the cell has a formula, this should return the computed value
    // The getCellValue function is responsible for handling that

    // Convert human-readable number strings (e.g. "$1,234", "42%") to actual numbers
    if (typeof value === 'string') {
        const n = parseNumericString(value);
        if (!isNaN(n)) return n;
    }

    return value;
}

/**
 * Evaluate a range, returning a 2D array of values
 */
function evaluateRange(ast, getCellValue) {
    const startRow = ast.start.row;
    const endRow = ast.end.row;
    const startCol = ast.start.col;
    const endCol = ast.end.col;

    // Validate range
    if (startRow > endRow || startCol > endCol) {
        return FormulaError.REF;
    }

    const result = [];

    for (let r = startRow; r <= endRow; r++) {
        const row = [];
        for (let c = startCol; c <= endCol; c++) {
            const value = getCellValue ? getCellValue(r, c) : null;
            row.push(value);
        }
        result.push(row);
    }

    return result;
}

/**
 * Evaluate a cross-sheet reference node (SheetName!CellOrRange)
 */
function evaluateSheetRef(ast, getCrossSheetValue) {
    if (!getCrossSheetValue) return FormulaError.REF;

    const sheetName = ast.sheet;
    const ref = ast.ref;

    if (ref.type === NodeType.CELL_REF) {
        const value = getCrossSheetValue(sheetName, ref.row, ref.col);
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') {
            const n = parseNumericString(value);
            if (!isNaN(n)) return n;
        }
        return value;
    }

    if (ref.type === NodeType.RANGE) {
        const { start, end } = ref;
        if (start.row > end.row || start.col > end.col) return FormulaError.REF;
        const result = [];
        for (let r = start.row; r <= end.row; r++) {
            const row = [];
            for (let c = start.col; c <= end.col; c++) {
                const v = getCrossSheetValue(sheetName, r, c);
                row.push(v);
            }
            result.push(row);
        }
        return result;
    }

    return FormulaError.REF;
}

/**
 * Evaluate a binary operation
 */
function evaluateBinaryOp(ast, getCellValue, context, customFunctions, getCrossSheetValue) {
    const left = evaluate(ast.left, getCellValue, context, customFunctions, getCrossSheetValue);

    // Short-circuit for errors
    if (isError(left)) return left;

    const right = evaluate(ast.right, getCellValue, context, customFunctions, getCrossSheetValue);

    // Short-circuit for errors
    if (isError(right)) return right;

    switch (ast.op) {
        case '+': {
            const lv = resolveNumeric(left  ?? 0);
            const rv = resolveNumeric(right ?? 0);
            if (typeof lv === 'number' && typeof rv === 'number') return lv + rv;
            // `+` is arithmetic-only; use `&` for string concatenation.
            return FormulaError.VALUE;
        }
        case '&':
            return String(left ?? '') + String(right ?? '');

        case '-': {
            const lv = resolveNumeric(left  ?? 0);
            const rv = resolveNumeric(right ?? 0);
            if (typeof lv === 'number' && typeof rv === 'number') return lv - rv;
            return FormulaError.VALUE;
        }

        case '*': {
            const lv = resolveNumeric(left  ?? 0);
            const rv = resolveNumeric(right ?? 0);
            if (typeof lv === 'number' && typeof rv === 'number') return lv * rv;
            return FormulaError.VALUE;
        }

        case '/': {
            const lv = resolveNumeric(left  ?? 0);
            const rv = resolveNumeric(right ?? 0);
            if (typeof lv === 'number' && typeof rv === 'number') {
                if (rv === 0) return FormulaError.DIV_ZERO;
                return lv / rv;
            }
            return FormulaError.VALUE;
        }

        case '^': {
            const lv = resolveNumeric(left  ?? 0);
            const rv = resolveNumeric(right ?? 0);
            if (typeof lv === 'number' && typeof rv === 'number') return Math.pow(lv, rv);
            return FormulaError.VALUE;
        }

        // Binary '%' is not emitted by the parser (% is postfix-only via parsePercent);
        // removed to avoid dead-code confusion.

        case '=': {
            const lv = resolveNumeric(left);
            const rv = resolveNumeric(right);
            if (typeof lv === 'number' && typeof rv === 'number') return lv === rv;
            // Normalise null/undefined to empty string so `=A1=""` is true
            // when A1 is empty (null), matching Excel's behaviour.
            const ls = left == null ? '' : left;
            const rs = right == null ? '' : right;
            if (typeof ls === 'string' && typeof rs === 'string')
                return ls.toLowerCase() === rs.toLowerCase(); // case-insensitive like Excel
            return ls === rs;
        }

        case '<>': {
            const lv = resolveNumeric(left);
            const rv = resolveNumeric(right);
            if (typeof lv === 'number' && typeof rv === 'number') return lv !== rv;
            const ls = left == null ? '' : left;
            const rs = right == null ? '' : right;
            if (typeof ls === 'string' && typeof rs === 'string')
                return ls.toLowerCase() !== rs.toLowerCase();
            return ls !== rs;
        }

        case '<':
        case '>':
        case '<=':
        case '>=': {
            // Excel type ordering for cross-type compare: numbers < text < booleans
            // (FALSE before TRUE within the boolean group). Same-type compares
            // use their natural ordering. resolveNumeric coerces numeric strings
            // and date strings to numbers so "5" and a real 5 compare as numbers.
            const lv = resolveNumeric(left);
            const rv = resolveNumeric(right);
            const rank = (v) => {
                if (typeof v === 'number')  return 0;
                if (typeof v === 'string')  return 1;
                if (typeof v === 'boolean') return 2;
                if (v == null)              return 1; // treat null as empty string
                return 1;
            };
            const lr = rank(lv);
            const rr = rank(rv);
            let cmp;
            if (lr !== rr) {
                cmp = lr - rr;
            } else if (typeof lv === 'number') {
                cmp = lv - rv;
            } else if (typeof lv === 'boolean') {
                cmp = Number(lv) - Number(rv);
            } else {
                // Both strings (or null/undefined → '')
                const ls = String(left ?? '');
                const rs = String(right ?? '');
                cmp = ls.toLowerCase().localeCompare(rs.toLowerCase());
            }
            if (ast.op === '<')  return cmp <  0;
            if (ast.op === '>')  return cmp >  0;
            if (ast.op === '<=') return cmp <= 0;
            return cmp >= 0;
        }

        case 'contains':
            return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());

        default:
            return FormulaError.VALUE;
    }
}

/**
 * Evaluate a unary operation
 */
function evaluateUnaryOp(ast, getCellValue, context, customFunctions, getCrossSheetValue) {
    const operand = evaluate(ast.operand, getCellValue, context, customFunctions, getCrossSheetValue);

    if (isError(operand)) return operand;

    switch (ast.op) {
        case '+': {
            // Coerce numeric strings/booleans so `+"5"` → 5 (Excel-compatible)
            const v = resolveNumeric(operand);
            if (typeof v === 'number') return v;
            return FormulaError.VALUE;
        }

        case '-': {
            // Coerce numeric strings/booleans so `-"5"` → -5 (Excel-compatible)
            const v = resolveNumeric(operand);
            if (typeof v === 'number') return -v;
            return FormulaError.VALUE;
        }

        case '%': {
            const v = resolveNumeric(operand);
            if (typeof v === 'number') return v / 100;
            return FormulaError.VALUE;
        }

        default:
            return FormulaError.VALUE;
    }
}

/**
 * Evaluate a function call.
 * Custom functions are checked FIRST so that table evaluation contexts can
 * override the main registry (e.g. register a row-aware SUM that takes a
 * column name instead of a range).
 */
function evaluateFunctionCall(ast, getCellValue, context, customFunctions, getCrossSheetValue) {
    // Custom functions take precedence over the main registry.
    const customFn = customFunctions?.get(ast.name.toUpperCase());
    if (customFn) {
        const evaluatedArgs = ast.args.map((arg) =>
            evaluate(arg, getCellValue, context, customFunctions, getCrossSheetValue),
        );
        try {
            return customFn(...evaluatedArgs);
        } catch (err) {
            log.debug(`Error evaluating custom function ${ast.name}:`, err);
            return FormulaError.ERROR;
        }
    }

    const funcDef = getFunction(ast.name);

    if (!funcDef) {
        return FormulaError.NAME;
    }

    // Check argument count
    const argCount = ast.args.length;
    if (argCount < funcDef.minArgs) {
        return FormulaError.VALUE;
    }
    if (funcDef.maxArgs !== Infinity && argCount > funcDef.maxArgs) {
        return FormulaError.VALUE;
    }

    // Evaluate arguments
    const evaluatedArgs = ast.args.map((arg) =>
        evaluate(arg, getCellValue, context, customFunctions, getCrossSheetValue),
    );

    // Call the function
    try {
        return funcDef.call(evaluatedArgs, { getCellValue, ...context });
    } catch (err) {
        log.debug(`Error evaluating function ${ast.name}:`, err);
        return FormulaError.ERROR;
    }
}

/**
 * Evaluate a formula string
 * @param {string} formula - The formula string (with or without leading =)
 * @param {Function} getCellValue - Function to get cell value
 * @param {Object} [context] - Optional evaluation context
 * @param {Map<string,Function>|null} [customFunctions] - Optional custom function registry
 * @param {Function|null} [getCrossSheetValue] - Optional cross-sheet getter: (sheetName, row, col) => value
 * @returns {any} - The computed value or error
 */
export function evaluateFormula(formula, getCellValue, context = {}, customFunctions = null, getCrossSheetValue = null) {
    try {
        const ast = cachedParseFormula(formula);
        if (!ast) return null;
        return evaluate(ast, getCellValue, context, customFunctions, getCrossSheetValue);
    } catch (err) {
        log.debug('Error parsing/evaluating formula:', err);
        return FormulaError.ERROR;
    }
}

export default evaluate;
