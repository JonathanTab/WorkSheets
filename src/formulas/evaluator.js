/**
 * Formula Evaluator
 *
 * Evaluates an AST produced by the parser and returns a computed value.
 * Requires a cell value getter function to retrieve values from cells.
 */

import { NodeType, parseFormula } from './parser.js';
import { getFunction, isError, FormulaError } from './functions.js';

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

    // Handle errors propagating
    const errorValue = checkForError(ast);
    if (errorValue !== null) {
        return errorValue;
    }

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

        default:
            return FormulaError.VALUE;
    }
}

/**
 * Check if AST contains an error and return it
 * @param {Object} ast
 * @returns {any|null}
 */
function checkForError(ast) {
    // This is called recursively, so we check node types
    return null;
}

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

    // Convert string representations of numbers to actual numbers
    if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
        return Number(value);
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
        if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
            return Number(value);
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
            // Treat null/undefined as 0 for numeric coercion, empty string for string concat
            const leftCoerce = left ?? 0;
            const rightCoerce = right ?? 0;
            // Try to convert string numbers to actual numbers for addition
            const leftNum =
                typeof leftCoerce === 'string' && leftCoerce.trim() !== '' && !isNaN(Number(leftCoerce))
                    ? Number(leftCoerce)
                    : leftCoerce;
            const rightNum =
                typeof rightCoerce === 'string' && rightCoerce.trim() !== '' && !isNaN(Number(rightCoerce))
                    ? Number(rightCoerce)
                    : rightCoerce;

            if (typeof leftNum === 'number' && typeof rightNum === 'number') {
                return leftNum + rightNum;
            }
            // Only concatenate if at least one is a non-numeric string
            if (typeof leftCoerce === 'string' || typeof rightCoerce === 'string') {
                return String(leftCoerce) + String(rightCoerce);
            }
            return FormulaError.VALUE;
        }
        case '&':
            return String(left ?? '') + String(right ?? '');

        case '-': {
            const l = left ?? 0, r = right ?? 0;
            if (typeof l === 'number' && typeof r === 'number') return l - r;
            return FormulaError.VALUE;
        }

        case '*': {
            const l = left ?? 0, r = right ?? 0;
            if (typeof l === 'number' && typeof r === 'number') return l * r;
            return FormulaError.VALUE;
        }

        case '/': {
            const l = left ?? 0, r = right ?? 0;
            if (typeof l === 'number' && typeof r === 'number') {
                if (r === 0) return FormulaError.DIV_ZERO;
                return l / r;
            }
            return FormulaError.VALUE;
        }

        case '^': {
            const l = left ?? 0, r = right ?? 0;
            if (typeof l === 'number' && typeof r === 'number') return Math.pow(l, r);
            return FormulaError.VALUE;
        }

        case '%': {
            const l = left ?? 0, r = right ?? 0;
            if (typeof l === 'number' && typeof r === 'number') {
                if (r === 0) return FormulaError.DIV_ZERO;
                return l % r;
            }
            return FormulaError.VALUE;
        }

        case '=':
            return left === right;

        case '<>':
            return left !== right;

        case '<':
            if (typeof left === 'number' && typeof right === 'number') {
                return left < right;
            }
            if (typeof left === 'string' && typeof right === 'string') {
                return left.localeCompare(right) < 0;
            }
            return FormulaError.VALUE;

        case '>':
            if (typeof left === 'number' && typeof right === 'number') {
                return left > right;
            }
            if (typeof left === 'string' && typeof right === 'string') {
                return left.localeCompare(right) > 0;
            }
            return FormulaError.VALUE;

        case '<=':
            if (typeof left === 'number' && typeof right === 'number') {
                return left <= right;
            }
            if (typeof left === 'string' && typeof right === 'string') {
                return left.localeCompare(right) <= 0;
            }
            return FormulaError.VALUE;

        case '>=':
            if (typeof left === 'number' && typeof right === 'number') {
                return left >= right;
            }
            if (typeof left === 'string' && typeof right === 'string') {
                return left.localeCompare(right) >= 0;
            }
            return FormulaError.VALUE;

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
        case '+':
            if (typeof operand === 'number') return operand;
            return FormulaError.VALUE;

        case '-':
            if (typeof operand === 'number') return -operand;
            return FormulaError.VALUE;

        case '%':
            if (typeof operand === 'number') return operand / 100;
            return FormulaError.VALUE;

        default:
            return FormulaError.VALUE;
    }
}

/**
 * Evaluate a function call
 */
function evaluateFunctionCall(ast, getCellValue, context, customFunctions, getCrossSheetValue) {
    const funcDef = getFunction(ast.name);

    if (!funcDef) {
        // Fall through to custom functions before returning an error
        const customFn = customFunctions?.get(ast.name.toUpperCase());
        if (customFn) {
            const evaluatedArgs = ast.args.map((arg) =>
                evaluate(arg, getCellValue, context, customFunctions, getCrossSheetValue),
            );
            try {
                return customFn(...evaluatedArgs);
            } catch (err) {
                console.error(`Error evaluating custom function ${ast.name}:`, err);
                return FormulaError.ERROR;
            }
        }
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
        console.error(`Error evaluating function ${ast.name}:`, err);
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
        const ast = parseFormula(formula);
        if (!ast) return null;
        return evaluate(ast, getCellValue, context, customFunctions, getCrossSheetValue);
    } catch (err) {
        console.error('Error parsing/evaluating formula:', err);
        return FormulaError.ERROR;
    }
}

export default evaluate;
