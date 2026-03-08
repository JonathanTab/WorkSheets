/**
 * Formula Engine Module
 *
 * Provides formula parsing, evaluation, and dependency tracking
 * for spreadsheet cells.
 */

// Core exports
export { FormulaEngine } from './FormulaEngine.svelte.js';
export { DependencyGraph, cellKey, parseCellKey } from './dependency-graph.js';

// Parser exports
export { parseFormula, extractCellRefs, NodeType, Parser } from './parser.js';

// Evaluator exports
export { evaluate } from './evaluator.js';

// Function registry exports
export {
    functions,
    getFunction,
    hasFunction,
    registerFunction,
    FormulaError,
    isError
} from './functions.js';

// Default export
export { FormulaEngine as default } from './FormulaEngine.svelte.js';
