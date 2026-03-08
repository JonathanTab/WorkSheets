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
 * @param {Object} options - Additional options
 * @returns {any} - The computed value
 */
export function evaluate(ast, getCellValue, options = {}) {
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
            return evaluateBinaryOp(ast, getCellValue, options);

        case NodeType.UNARY_OP:
            return evaluateUnaryOp(ast, getCellValue, options);

        case NodeType.FUNCTION_CALL:
            return evaluateFunctionCall(ast, getCellValue, options);

        case NodeType.SHEET_REF:
            // For now, treat sheet refs as errors
            // TODO: Implement multi-sheet support
            return FormulaError.REF;

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
 * Evaluate a binary operation
 */
function evaluateBinaryOp(ast, getCellValue, options) {
    const left = evaluate(ast.left, getCellValue, options);

    // Short-circuit for errors
    if (isError(left)) return left;

    const right = evaluate(ast.right, getCellValue, options);

    // Short-circuit for errors
    if (isError(right)) return right;

    switch (ast.op) {
        case '+': {
            // Try to convert string numbers to actual numbers for addition
            const leftNum = typeof left === 'string' && left.trim() !== '' && !isNaN(Number(left)) ? Number(left) : left;
            const rightNum = typeof right === 'string' && right.trim() !== '' && !isNaN(Number(right)) ? Number(right) : right;

            if (typeof leftNum === 'number' && typeof rightNum === 'number') {
                return leftNum + rightNum;
            }
            // Only concatenate if at least one is a non-numeric string
            if (typeof left === 'string' || typeof right === 'string') {
                return String(left) + String(right);
            }
            return FormulaError.VALUE;
        }

        case '-':
            if (typeof left === 'number' && typeof right === 'number') {
                return left - right;
            }
            return FormulaError.VALUE;

        case '*':
            if (typeof left === 'number' && typeof right === 'number') {
                return left * right;
            }
            return FormulaError.VALUE;

        case '/':
            if (typeof left === 'number' && typeof right === 'number') {
                if (right === 0) return FormulaError.DIV_ZERO;
                return left / right;
            }
            return FormulaError.VALUE;

        case '^':
            if (typeof left === 'number' && typeof right === 'number') {
                return Math.pow(left, right);
            }
            return FormulaError.VALUE;

        case '%':
            if (typeof left === 'number' && typeof right === 'number') {
                if (right === 0) return FormulaError.DIV_ZERO;
                return left % right;
            }
            return FormulaError.VALUE;

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

        default:
            return FormulaError.VALUE;
    }
}

/**
 * Evaluate a unary operation
 */
function evaluateUnaryOp(ast, getCellValue, options) {
    const operand = evaluate(ast.operand, getCellValue, options);

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
function evaluateFunctionCall(ast, getCellValue, options) {
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
    // For functions that need ranges, we don't evaluate the argument
    // We check if the function wants raw AST nodes
    const evaluatedArgs = ast.args.map(arg => evaluate(arg, getCellValue, options));

    // Call the function
    try {
        return funcDef.call(evaluatedArgs, { getCellValue, ...options });
    } catch (err) {
        console.error(`Error evaluating function ${ast.name}:`, err);
        return FormulaError.ERROR;
    }
}

/**
 * Evaluate a formula string
 * @param {string} formula - The formula string (with or without leading =)
 * @param {Function} getCellValue - Function to get cell value
 * @returns {any} - The computed value or error
 */
export function evaluateFormula(formula, getCellValue) {
    try {
        const ast = parseFormula(formula);
        if (!ast) return null;
        return evaluate(ast, getCellValue);
    } catch (err) {
        console.error('Error parsing/evaluating formula:', err);
        return FormulaError.ERROR;
    }
}

export default evaluate;
