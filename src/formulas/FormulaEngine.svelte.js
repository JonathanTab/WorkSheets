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

    /**
     * Optional getter for cells on other sheets.
     * Signature: (sheetName: string, row: number, col: number) => any
     * @type {Function|null}
     */
    #getCrossSheetValue = null;

    /** @type {boolean} */
    #isRecalculating = false;

    /** @type {Set<string>} */
    #pendingChanges = new Set();

    /** @type {Map<string, Function>} Custom function registry (e.g. TABLE_* functions) */
    #customFunctions = new Map();

    /**
     * Spill ranges: anchorKey -> { anchorRow, anchorCol, rows, cols }
     * Tracks which cells were spilled by each array-formula anchor.
     * @type {Map<string, {anchorRow: number, anchorCol: number, rows: number, cols: number}>}
     */
    #spillRanges = new Map();

    /**
     * Reverse spill lookup: spillCellKey -> anchorKey
     * Used to find which formula generated a spill cell (e.g. for formula bar display).
     * @type {Map<string, string>}
     */
    #spillSources = new Map();

    // Reactive computed values - key: "row,col" -> value: computed result
    // This is Svelte 5 reactive state, so UI updates automatically
    // Includes both formula anchor values and spill cell values.
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
     * Set the cross-sheet cell value getter.
     * Called when a formula references cells on a different sheet (e.g. Sheet2!A1).
     * @param {Function|null} fn - Function: (sheetName, row, col) => value
     */
    setCrossSheetGetter(fn) {
        this.#getCrossSheetValue = fn;
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

    // =========================================================================
    // Spill helpers
    // =========================================================================

    /**
     * Store a formula result, handling array/spill output.
     * If result is a 2D (or 1D) array the values are distributed into
     * neighbouring cells (spill range) and stored in computedValues.
     * The anchor cell always gets the top-left scalar value.
     *
     * @param {number} row  - anchor row
     * @param {number} col  - anchor col
     * @param {any}    rawResult - value returned by evaluate()
     * @returns {any} the display value for the anchor cell
     */
    #storeResult(row, col, rawResult) {
        const anchorKey = cellKey(row, col);
        // Always clear any previous spill from this anchor first
        this.#clearSpill(anchorKey);

        if (!Array.isArray(rawResult)) {
            this.computedValues[anchorKey] = rawResult;
            return rawResult;
        }

        // Normalise to 2D: [[v, ...], ...]
        const arr2d = Array.isArray(rawResult[0])
            ? rawResult
            : rawResult.map(v => [v]);

        const rows = arr2d.length;
        const cols = arr2d[0]?.length ?? 0;

        if (rows === 0 || cols === 0) {
            this.computedValues[anchorKey] = null;
            return null;
        }

        // Record the spill range for cleanup later
        this.#spillRanges.set(anchorKey, { anchorRow: row, anchorCol: col, rows, cols });

        // Distribute individual cell values
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const k = cellKey(row + r, col + c);
                if (r === 0 && c === 0) continue; // anchor handled below
                this.#spillSources.set(k, anchorKey);
                this.computedValues[k] = arr2d[r][c] ?? null;
            }
        }

        const topLeft = arr2d[0][0] ?? null;
        this.computedValues[anchorKey] = topLeft;
        return topLeft;
    }

    /**
     * Remove all spill cells that were generated by the given anchor.
     * @param {string} anchorKey
     */
    #clearSpill(anchorKey) {
        const spill = this.#spillRanges.get(anchorKey);
        if (!spill) return;

        const { anchorRow, anchorCol, rows, cols } = spill;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (r === 0 && c === 0) continue;
                const k = cellKey(anchorRow + r, anchorCol + c);
                this.#spillSources.delete(k);
                delete this.computedValues[k];
            }
        }
        this.#spillRanges.delete(anchorKey);
    }

    /**
     * True if this cell is a spill output cell (not the formula anchor).
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isSpillCell(row, col) {
        return this.#spillSources.has(cellKey(row, col));
    }

    /**
     * If this cell is a spill output, return the anchor cell key.
     * @param {number} row
     * @param {number} col
     * @returns {string|null}
     */
    getSpillAnchorKey(row, col) {
        return this.#spillSources.get(cellKey(row, col)) ?? null;
    }

    /**
     * Return the spill range info for an anchor cell, or null.
     * @param {number} row
     * @param {number} col
     * @returns {{anchorRow:number, anchorCol:number, rows:number, cols:number}|null}
     */
    getSpillInfo(row, col) {
        return this.#spillRanges.get(cellKey(row, col)) ?? null;
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
        return evaluate(formulaInfo.ast, getCellValueWithComputed, context, this.#customFunctions, this.#getCrossSheetValue);
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

            // Compute the value and store (handles array/spill output)
            const rawResult = this.evaluateCell(row, col, ast);
            const value = this.#storeResult(row, col, rawResult);

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
        this.#clearSpill(key);
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

        return evaluate(ast, getCellValueWithComputed, {}, this.#customFunctions, this.#getCrossSheetValue);
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

                // Re-evaluate and store (handles array/spill output)
                const rawResult = this.evaluateCell(row, col);
                const value = this.#storeResult(row, col, rawResult);

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
        this.#spillRanges.clear();
        this.#spillSources.clear();
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
