/**
 * FormulaEngine - Main formula calculation engine
 *
 * Coordinates parsing, dependency tracking, and evaluation of formulas.
 * Designed to work with the SheetStore for reactive updates.
 *
 * ## Key Principles
 * 1. Computed values are stored locally in reactive state (never synced to Yjs)
 * 2. Formulas are detected by checking if value starts with "="
 * 3. UI components get display values through getDisplayValue()
 */

import { parseFormula, extractCellRefs, NodeType } from './parser.js';
import { evaluate } from './evaluator.js';
import { DependencyGraph, cellKey, parseCellKey } from './dependency-graph.js';
import { FormulaError, isError } from './functions.js';

/**
 * FormulaEngine class
 *
 * Manages formula parsing, dependency tracking, and evaluation for a sheet.
 * Uses Svelte 5 reactive state for computed values.
 */
export class FormulaEngine {
    /** @type {DependencyGraph} */
    #graph;

    /** @type {Function} */
    #getCellValue;

    /** @type {boolean} */
    #isRecalculating = false;

    /** @type {Set<string>} */
    #pendingChanges = new Set();

    /** @type {Map<string, Function>} Custom function registry (e.g. TABLE_* functions) */
    #customFunctions = new Map();

    // Reactive computed values - key: "row,col" -> value: computed result
    // This is Svelte 5 reactive state, so UI updates automatically
    computedValues = $state({});

    constructor() {
        this.#graph = new DependencyGraph();
    }

    /**
     * Set the cell value getter function
     * @param {Function} fn - Function: (row, col) => value
     */
    setCellValueGetter(fn) {
        this.#getCellValue = fn;
    }

    /**
     * Register a custom function (e.g. TABLE_GET, TABLE_CUMSUM)
     * @param {string} name - Function name (case-insensitive)
     * @param {Function} fn - Implementation function(...args): any
     */
    registerFunction(name, fn) {
        this.#customFunctions.set(name.toUpperCase(), fn);
    }

    /**
     * Unregister a custom function
     * @param {string} name
     */
    unregisterFunction(name) {
        this.#customFunctions.delete(name.toUpperCase());
    }

    /**
     * Evaluate a cell's formula with an optional context (e.g. $rep value for repeaters)
     * @param {number} row
     * @param {number} col
     * @param {Object} [context] - Context object: { rep?: number }
     * @returns {any}
     */
    evaluateWithContext(row, col, context = {}) {
        const formulaInfo = this.#graph.getFormula(row, col);
        if (!formulaInfo?.ast) {
            return this.#getCellValue ? this.#getCellValue(row, col) : null;
        }
        const getCellValueWithComputed = (r, c) => {
            const k = cellKey(r, c);
            if (k in this.computedValues) return this.computedValues[k];
            return this.#getCellValue ? this.#getCellValue(r, c) : null;
        };
        return evaluate(formulaInfo.ast, getCellValueWithComputed, context, this.#customFunctions);
    }

    /**
     * Process a cell formula
     * Parses the formula, updates dependency graph, and computes the value
     * @param {number} row
     * @param {number} col
     * @param {string} formula - The formula string (with or without leading =)
     * @returns {{value: any, error: string|null, refs: Array}}
     */
    setFormula(row, col, formula) {
        const key = cellKey(row, col);

        try {
            // Parse the formula
            const ast = parseFormula(formula);

            if (!ast) {
                // Not a formula, clear from graph
                this.#graph.setFormula(row, col, null, null, []);
                delete this.computedValues[key];
                return { value: null, error: null, refs: [] };
            }

            // Extract cell references
            const refs = extractCellRefs(ast);

            // Update dependency graph
            this.#graph.setFormula(row, col, formula, ast, refs);

            // Compute the value
            const value = this.evaluateCell(row, col, ast);

            // Store computed value in reactive state
            this.computedValues[key] = value;

            return { value, error: isError(value) ? value : null, refs };
        } catch (err) {
            console.error(`Error parsing formula at ${key}:`, err);
            this.#graph.setFormula(row, col, null, null, []);
            const errorValue = FormulaError.ERROR;
            this.computedValues[key] = errorValue;
            return { value: errorValue, error: errorValue, refs: [] };
        }
    }

    /**
     * Clear a formula from the engine
     * @param {number} row
     * @param {number} col
     */
    clearFormula(row, col) {
        const key = cellKey(row, col);
        this.#graph.setFormula(row, col, null, null, []);
        delete this.computedValues[key];
    }

    /**
     * Get computed value for a cell
     * @param {number} row
     * @param {number} col
     * @returns {any}
     */
    getComputedValue(row, col) {
        const key = cellKey(row, col);
        return this.computedValues[key];
    }

    /**
     * Get display value for a cell (main API for UI)
     * If the cell has a formula, returns the computed value.
     * Otherwise, returns the raw value from the getter.
     * @param {number} row
     * @param {number} col
     * @param {any} rawValue - The raw value from the cell (optional, will use getter if not provided)
     * @returns {any}
     */
    getDisplayValue(row, col, rawValue = undefined) {
        const key = cellKey(row, col);

        // If we have a computed value for this cell, return it
        if (key in this.computedValues) {
            return this.computedValues[key];
        }

        // Otherwise return the raw value
        if (rawValue !== undefined) {
            return rawValue;
        }

        // Fall back to getter
        return this.#getCellValue ? this.#getCellValue(row, col) : null;
    }

    /**
     * Evaluate a cell's formula
     * @param {number} row
     * @param {number} col
     * @param {Object} ast - Optional pre-parsed AST
     * @returns {any}
     */
    evaluateCell(row, col, ast = null) {
        const key = cellKey(row, col);

        if (!ast) {
            const formulaInfo = this.#graph.getFormula(row, col);
            if (!formulaInfo) {
                return this.#getCellValue ? this.#getCellValue(row, col) : null;
            }
            ast = formulaInfo.ast;
        }

        // Create a getter that uses computed values for formula cells
        const getCellValueWithComputed = (r, c) => {
            const k = cellKey(r, c);

            // If this cell has a computed value, use it
            if (k in this.computedValues) {
                return this.computedValues[k];
            }

            // Otherwise, get from the raw getter
            return this.#getCellValue ? this.#getCellValue(r, c) : null;
        };

        return evaluate(ast, getCellValueWithComputed);
    }

    /**
     * Handle a cell value change
     * Marks dependents as dirty and schedules recalculation
     * @param {number} row
     * @param {number} col
     * @returns {Array<{row: number, col: number, value: any}>} - Updated cells
     */
    cellValueChanged(row, col) {
        const key = cellKey(row, col);

        // If this cell has a formula, its value was computed, not changed
        // The formula should have been set via setFormula
        if (this.#graph.hasFormula(row, col)) {
            return [];
        }

        // Mark dependents as dirty
        const dirtyCells = this.#graph.cellChanged(row, col);

        if (dirtyCells.size === 0) {
            return [];
        }

        // Recalculate dirty cells
        return this.recalculateDirty();
    }

    /**
     * Recalculate all dirty cells
     * @returns {Array<{row: number, col: number, value: any}>}
     */
    recalculateDirty() {
        if (this.#isRecalculating) {
            return [];
        }

        this.#isRecalculating = true;
        const updated = [];

        try {
            // Get dirty cells in topological order
            const dirtyCells = this.#graph.getDirtyCellsOrdered();

            for (const key of dirtyCells) {
                const { row, col } = parseCellKey(key);

                // Re-evaluate
                const value = this.evaluateCell(row, col);

                // Store computed value in reactive state
                this.computedValues[key] = value;

                updated.push({ row, col, value });
            }

            // Clear dirty set
            this.#graph.clearDirty();
        } finally {
            this.#isRecalculating = false;
        }

        return updated;
    }

    /**
     * Recalculate all formulas
     * @returns {Array<{row: number, col: number, value: any}>}
     */
    recalculateAll() {
        const allCells = this.#graph.getAllFormulaCells();

        // Mark all as dirty
        for (const key of allCells) {
            this.#graph.dirtyCells.add(key);
        }

        return this.recalculateDirty();
    }

    /**
     * Check if a cell has a formula
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    hasFormula(row, col) {
        return this.#graph.hasFormula(row, col);
    }

    /**
     * Get formula string for a cell
     * @param {number} row
     * @param {number} col
     * @returns {string|null}
     */
    getFormula(row, col) {
        const info = this.#graph.getFormula(row, col);
        return info ? info.formula : null;
    }

    /**
     * Get dependencies of a cell
     * @param {number} row
     * @param {number} col
     * @returns {Array<{row: number, col: number}>}
     */
    getDependencies(row, col) {
        return this.#graph.getDependencies(row, col);
    }

    /**
     * Get cells that depend on this cell
     * @param {number} row
     * @param {number} col
     * @returns {Array<{row: number, col: number}>}
     */
    getDependents(row, col) {
        return this.#graph.getDependents(row, col);
    }

    /**
     * Detect circular references
     * @returns {Array<Array<{row: number, col: number}>>}
     */
    detectCircularReferences() {
        const cycles = this.#graph.detectCircularReferences();
        return cycles.map(cycle => cycle.map(parseCellKey));
    }

    /**
     * Clear all formulas and computed values
     */
    clear() {
        this.#graph.clear();
        this.computedValues = {};
        this.#pendingChanges.clear();
    }

    /**
     * Get statistics about the formula engine
     * @returns {Object}
     */
    getStats() {
        return {
            formulaCount: this.#graph.formulas.size,
            computedValueCount: Object.keys(this.computedValues).length,
            dependencyCount: this.#graph.dependencies.size,
            dependentCount: this.#graph.dependents.size
        };
    }
}

export default FormulaEngine;
