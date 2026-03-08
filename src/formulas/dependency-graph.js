/**
 * Dependency Graph for Formula Cells
 *
 * Tracks dependencies between cells for formula recalculation.
 * When a cell changes, we can find all cells that depend on it
 * and recalculate them in the correct order (topological sort).
 */

/**
 * Create a cell key from row and column
 * @param {number} row
 * @param {number} col
 * @returns {string}
 */
export function cellKey(row, col) {
    return `${row},${col}`;
}

/**
 * Parse a cell key back to row and column
 * @param {string} key
 * @returns {{row: number, col: number}}
 */
export function parseCellKey(key) {
    const [row, col] = key.split(',').map(Number);
    return { row, col };
}

/**
 * DependencyGraph class
 */
export class DependencyGraph {
    constructor() {
        // Map from cell key -> Set of cell keys it depends on (dependencies)
        /** @type {Map<string, Set<string>>} */
        this.dependencies = new Map();

        // Map from cell key -> Set of cell keys that depend on it (dependents)
        /** @type {Map<string, Set<string>>} */
        this.dependents = new Map();

        // Map from cell key -> parsed AST (for re-evaluation)
        /** @type {Map<string, Object>} */
        this.formulas = new Map();

        // Set of dirty cells that need recalculation
        /** @type {Set<string>} */
        this.dirtyCells = new Set();

        // Expose for external access
        this.dependencies = this.dependencies;
        this.dependents = this.dependents;
    }

    /**
     * Set a cell's formula and update the dependency graph
     * @param {number} row
     * @param {number} col
     * @param {string|null} formula - The formula string, or null to clear
     * @param {Object|null} ast - The parsed AST
     * @param {Array<{row: number, col: number}>} refs - Cell references extracted from the formula
     */
    setFormula(row, col, formula, ast, refs) {
        const key = cellKey(row, col);

        // Remove old dependencies
        this.clearDependencies(key);

        if (formula && ast) {
            // Store the formula and AST
            this.formulas.set(key, { formula, ast });

            // Add new dependencies
            const deps = new Set();
            for (const ref of refs) {
                const depKey = cellKey(ref.row, ref.col);
                deps.add(depKey);

                // Add to dependents map
                if (!this.dependents.has(depKey)) {
                    this.dependents.set(depKey, new Set());
                }
                this.dependents.get(depKey).add(key);
            }

            this.dependencies.set(key, deps);

            // Mark this cell as dirty
            this.dirtyCells.add(key);
        } else {
            // Clear formula
            this.formulas.delete(key);
        }
    }

    /**
     * Clear all dependencies for a cell
     * @param {string} key
     */
    clearDependencies(key) {
        const oldDeps = this.dependencies.get(key);
        if (oldDeps) {
            // Remove this cell from dependents of its old dependencies
            for (const depKey of oldDeps) {
                const dependents = this.dependents.get(depKey);
                if (dependents) {
                    dependents.delete(key);
                    if (dependents.size === 0) {
                        this.dependents.delete(depKey);
                    }
                }
            }
            this.dependencies.delete(key);
        }
    }

    /**
     * Mark a cell as changed and add its dependents to dirty set
     * @param {number} row
     * @param {number} col
     * @returns {Set<string>} - Set of cells that need recalculation
     */
    cellChanged(row, col) {
        const key = cellKey(row, col);
        return this.markDependentsDirty(key);
    }

    /**
     * Recursively mark dependents as dirty
     * @param {string} key
     * @returns {Set<string>} - Set of cells that need recalculation
     */
    markDependentsDirty(key) {
        const toRecalculate = new Set();
        const visited = new Set();
        const stack = [key];

        while (stack.length > 0) {
            const current = stack.pop();
            if (visited.has(current)) continue;
            visited.add(current);

            const dependents = this.dependents.get(current);
            if (dependents) {
                for (const depKey of dependents) {
                    toRecalculate.add(depKey);
                    stack.push(depKey);
                }
            }
        }

        // Add all to dirty set
        for (const cellKey of toRecalculate) {
            this.dirtyCells.add(cellKey);
        }

        return toRecalculate;
    }

    /**
     * Get all dirty cells in topological order
     * @returns {Array<string>} - Cell keys in dependency order
     */
    getDirtyCellsOrdered() {
        // Topological sort of dirty cells
        const result = [];
        const visited = new Set();
        const visiting = new Set();

        const visit = (key) => {
            if (visited.has(key)) return;
            if (visiting.has(key)) {
                // Circular dependency detected
                console.warn(`Circular dependency detected involving cell ${key}`);
                return;
            }

            visiting.add(key);

            const deps = this.dependencies.get(key);
            if (deps) {
                for (const depKey of deps) {
                    if (this.formulas.has(depKey)) {
                        visit(depKey);
                    }
                }
            }

            visiting.delete(key);
            visited.add(key);
            result.push(key);
        };

        // Visit all dirty cells
        for (const key of this.dirtyCells) {
            visit(key);
        }

        return result;
    }

    /**
     * Clear the dirty set after recalculation
     */
    clearDirty() {
        this.dirtyCells.clear();
    }

    /**
     * Check if a cell has a formula
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    hasFormula(row, col) {
        return this.formulas.has(cellKey(row, col));
    }

    /**
     * Get a cell's formula info
     * @param {number} row
     * @param {number} col
     * @returns {{formula: string, ast: Object}|null}
     */
    getFormula(row, col) {
        return this.formulas.get(cellKey(row, col)) || null;
    }

    /**
     * Get all formula cells
     * @returns {Array<string>}
     */
    getAllFormulaCells() {
        return Array.from(this.formulas.keys());
    }

    /**
     * Get dependencies of a cell
     * @param {number} row
     * @param {number} col
     * @returns {Array<{row: number, col: number}>}
     */
    getDependencies(row, col) {
        const deps = this.dependencies.get(cellKey(row, col));
        if (!deps) return [];
        return Array.from(deps).map(parseCellKey);
    }

    /**
     * Get dependents of a cell
     * @param {number} row
     * @param {number} col
     * @returns {Array<{row: number, col: number}>}
     */
    getDependents(row, col) {
        const dependents = this.dependents.get(cellKey(row, col));
        if (!dependents) return [];
        return Array.from(dependents).map(parseCellKey);
    }

    /**
     * Clear all formulas and dependencies
     */
    clear() {
        this.dependencies.clear();
        this.dependents.clear();
        this.formulas.clear();
        this.dirtyCells.clear();
    }

    /**
     * Detect circular references
     * @returns {Array<Array<string>>} - Array of circular reference chains
     */
    detectCircularReferences() {
        const cycles = [];
        const visited = new Set();
        const recursionStack = new Set();

        const dfs = (key, path) => {
            visited.add(key);
            recursionStack.add(key);
            path.push(key);

            const deps = this.dependencies.get(key);
            if (deps) {
                for (const depKey of deps) {
                    if (!visited.has(depKey)) {
                        const cycle = dfs(depKey, [...path]);
                        if (cycle) cycles.push(cycle);
                    } else if (recursionStack.has(depKey)) {
                        // Found a cycle
                        const cycleStart = path.indexOf(depKey);
                        return path.slice(cycleStart);
                    }
                }
            }

            recursionStack.delete(key);
            return null;
        };

        for (const key of this.formulas.keys()) {
            if (!visited.has(key)) {
                dfs(key, []);
            }
        }

        return cycles;
    }
}

export default DependencyGraph;
