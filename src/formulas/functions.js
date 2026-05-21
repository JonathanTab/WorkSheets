/**
 * Formula Functions Registry — re-export barrel.
 *
 * All function implementations now live in src/formulas/functions/ domain files.
 * This file exists only for backward-compatibility with existing imports.
 */
export {
    functions,
    getFunction,
    hasFunction,
    registerFunction,
    FormulaError,
    isError,
    parseNumericString,
} from './functions/index.js';
