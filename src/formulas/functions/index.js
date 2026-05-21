/**
 * Formula function registry — barrel index.
 *
 * Imports all domain files and exports a merged `functions` object plus the
 * public utilities (FormulaError, isError, parseNumericString, getFunction, etc.)
 * that callers historically imported from the top-level functions.js.
 */

export { FormulaError, isError, parseNumericString } from './_helpers.js';

import { mathFunctions }      from './math.js';
import { logicFunctions }     from './logic.js';
import { textFunctions }      from './text.js';
import { dateFunctions }      from './date.js';
import { lookupFunctions }    from './lookup.js';
import { infoFunctions }      from './info.js';
import { aggregateFunctions } from './aggregate.js';
import { arrayFunctions }     from './array.js';

/**
 * Merged function registry.
 * TABLE_* functions are NOT included here — they are registered at runtime
 * by TableManager via FormulaEngine.registerFunction().
 */
export const functions = {
    ...mathFunctions,
    ...logicFunctions,
    ...textFunctions,
    ...dateFunctions,
    ...lookupFunctions,
    ...infoFunctions,
    ...aggregateFunctions,
    ...arrayFunctions,
};

/**
 * Get a function definition by name (case-insensitive).
 * @param {string} name
 * @returns {object|null}
 */
export function getFunction(name) {
    return functions[name.toUpperCase()] ?? null;
}

/**
 * Check if a function exists.
 * @param {string} name
 * @returns {boolean}
 */
export function hasFunction(name) {
    return name.toUpperCase() in functions;
}

/**
 * Register a custom function at runtime (e.g. TABLE_* injected by TableManager).
 * @param {string} name
 * @param {object} def
 */
export function registerFunction(name, def) {
    functions[name.toUpperCase()] = def;
}
