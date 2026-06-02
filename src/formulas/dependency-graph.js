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
 * Two-tier range-index thresholds:
 *   - Ranges with span ≤ MAX_RANGE_INDEX_ROWS register every covered row in the
 *     per-row #rangeRowIndex (precise — one entry per row in the range).
 *   - Larger ranges register in #rangeSuperBucketIndex, where each entry covers
 *     SUPER_BUCKET_ROWS contiguous rows. A SUM(A1:A100000) range that would
 *     once fall back to a doc-wide linear scan now lands in ~400 super-buckets.
 *
 * markDependentsDirty consults both indices; the precise-range filter inside
 * the loop discards super-bucket false positives.
 */
const MAX_RANGE_INDEX_ROWS = 256;
const SUPER_BUCKET_ROWS = 256;
const superBucket = (row) => Math.floor(row / SUPER_BUCKET_ROWS);

/**
 * DependencyGraph class
 */
export class DependencyGraph {
    /** Per-row buckets for ranges spanning ≤ MAX_RANGE_INDEX_ROWS rows. */
    /** @type {Map<number, Set<string>>} */
    #rangeRowIndex = new Map();
    /**
     * Super-buckets (SUPER_BUCKET_ROWS rows each) for ranges spanning more than
     * MAX_RANGE_INDEX_ROWS rows. Lets SUM(A:A) over 100K+ rows still be O(1)
     * per changed cell instead of degenerating to a linear scan.
     * @type {Map<number, Set<string>>}
     */
    #rangeSuperBucketIndex = new Map();

    constructor() {
        // Map from cell key -> Set of cell keys it depends on (individual cells)
        /** @type {Map<string, Set<string>>} */
        this.dependencies = new Map();

        // Map from cell key -> Set of cell keys that depend on it (dependents)
        /** @type {Map<string, Set<string>>} */
        this.dependents = new Map();

        // Map from formula cell key -> Array of range descriptors it depends on.
        // Ranges are stored as {startRow,endRow,startCol,endCol} — O(1) per range
        // rather than O(rangeSize) cell entries.
        /** @type {Map<string, Array<{startRow:number,endRow:number,startCol:number,endCol:number}>>} */
        this.rangeDependencies = new Map();

        // #rangeRowIndex and #rangeSuperBucketIndex are initialised by class field declarations.

        // Map from cell key -> parsed AST (for re-evaluation)
        /** @type {Map<string, Object>} */
        this.formulas = new Map();

        // Set of dirty cells that need recalculation
        /** @type {Set<string>} */
        this.dirtyCells = new Set();

        /**
         * Keys found to be in a circular dependency during the last
         * getDirtyCellsOrdered() call. FormulaEngine reads this to mark them
         * with #CIRC! instead of evaluating them.
         * @type {Set<string>}
         */
        this.circularCells = new Set();
    }

    // ── Row-index helpers ─────────────────────────────────────────────────────

    #addRangeToRowIndex(formulaKey, range) {
        const span = range.endRow - range.startRow;
        if (span > MAX_RANGE_INDEX_ROWS) {
            const lo = superBucket(range.startRow);
            const hi = superBucket(range.endRow);
            for (let b = lo; b <= hi; b++) {
                if (!this.#rangeSuperBucketIndex.has(b)) this.#rangeSuperBucketIndex.set(b, new Set());
                this.#rangeSuperBucketIndex.get(b).add(formulaKey);
            }
            return;
        }
        for (let r = range.startRow; r <= range.endRow; r++) {
            if (!this.#rangeRowIndex.has(r)) this.#rangeRowIndex.set(r, new Set());
            this.#rangeRowIndex.get(r).add(formulaKey);
        }
    }

    #removeRangeFromRowIndex(formulaKey, range) {
        const span = range.endRow - range.startRow;
        if (span > MAX_RANGE_INDEX_ROWS) {
            const lo = superBucket(range.startRow);
            const hi = superBucket(range.endRow);
            for (let b = lo; b <= hi; b++) {
                const set = this.#rangeSuperBucketIndex.get(b);
                if (set) {
                    set.delete(formulaKey);
                    if (set.size === 0) this.#rangeSuperBucketIndex.delete(b);
                }
            }
            return;
        }
        for (let r = range.startRow; r <= range.endRow; r++) {
            const set = this.#rangeRowIndex.get(r);
            if (set) {
                set.delete(formulaKey);
                if (set.size === 0) this.#rangeRowIndex.delete(r);
            }
        }
    }

    /**
     * Set a cell's formula and update the dependency graph.
     * @param {number} row
     * @param {number} col
     * @param {string|null} formula - The formula string, or null to clear
     * @param {Object|null} ast - The parsed AST
     * @param {Array<{row:number,col:number}|{startRow:number,endRow:number,startCol:number,endCol:number}>} refs
     *   Mixed array of individual cell refs and range descriptors from extractCellRefs().
     */
    setFormula(row, col, formula, ast, refs) {
        const key = cellKey(row, col);

        // Remove old dependencies
        this.clearDependencies(key);

        if (formula && ast) {
            // Store the formula and AST
            this.formulas.set(key, { formula, ast });

            // Partition refs into individual cells vs ranges
            const deps = new Set();
            const ranges = [];

            for (const ref of refs) {
                if ('startRow' in ref) {
                    // Range descriptor — store as-is, don't enumerate
                    ranges.push(ref);
                } else {
                    // Individual cell ref
                    const depKey = cellKey(ref.row, ref.col);
                    deps.add(depKey);
                    if (!this.dependents.has(depKey)) {
                        this.dependents.set(depKey, new Set());
                    }
                    this.dependents.get(depKey).add(key);
                }
            }

            this.dependencies.set(key, deps);
            if (ranges.length > 0) {
                this.rangeDependencies.set(key, ranges);
                for (const r of ranges) this.#addRangeToRowIndex(key, r);
            }

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
            for (const depKey of oldDeps) {
                const dependents = this.dependents.get(depKey);
                if (dependents) {
                    dependents.delete(key);
                    if (dependents.size === 0) this.dependents.delete(depKey);
                }
            }
            this.dependencies.delete(key);
        }

        // Clear range deps and their row-index entries.
        const oldRanges = this.rangeDependencies.get(key);
        if (oldRanges) {
            for (const r of oldRanges) this.#removeRangeFromRowIndex(key, r);
            this.rangeDependencies.delete(key);
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
     * Recursively mark dependents as dirty, including formulas whose range
     * dependencies contain the given changed cell.
     * @param {string} key  - key of the changed cell ("row,col")
     * @returns {Set<string>} - Set of cells that need recalculation
     */
    markDependentsDirty(key) {
        const toRecalculate = new Set();
        const visited = new Set();

        // Collect initial set: point deps + range-dep candidates.
        const initial = new Set(this.dependents.get(key) ?? []);
        const { row, col } = parseCellKey(key);

        // Tier 1: precise per-row index (ranges spanning ≤ MAX_RANGE_INDEX_ROWS).
        const rowCandidates = this.#rangeRowIndex.get(row);
        if (rowCandidates) {
            for (const formulaKey of rowCandidates) {
                const ranges = this.rangeDependencies.get(formulaKey);
                if (!ranges) continue;
                for (const r of ranges) {
                    if (r.endRow - r.startRow <= MAX_RANGE_INDEX_ROWS &&
                        row >= r.startRow && row <= r.endRow &&
                        col >= r.startCol && col <= r.endCol) {
                        initial.add(formulaKey);
                        break;
                    }
                }
            }
        }

        // Tier 2: super-bucket index for large ranges. The bucket is a row
        // filter only; the precise (row, col) check inside the range descriptor
        // discards false positives.
        const bucket = this.#rangeSuperBucketIndex.get(superBucket(row));
        if (bucket) {
            for (const formulaKey of bucket) {
                if (initial.has(formulaKey)) continue;
                const ranges = this.rangeDependencies.get(formulaKey);
                if (!ranges) continue;
                for (const r of ranges) {
                    if (r.endRow - r.startRow > MAX_RANGE_INDEX_ROWS &&
                        row >= r.startRow && row <= r.endRow &&
                        col >= r.startCol && col <= r.endCol) {
                        initial.add(formulaKey);
                        break;
                    }
                }
            }
        }

        const stack = [...initial];
        for (const k of initial) toRecalculate.add(k);

        while (stack.length > 0) {
            const current = stack.pop();
            if (visited.has(current)) continue;
            visited.add(current);

            const dependents = this.dependents.get(current);
            if (dependents) {
                for (const depKey of dependents) {
                    if (!toRecalculate.has(depKey)) {
                        toRecalculate.add(depKey);
                        stack.push(depKey);
                    }
                }
            }
        }

        for (const k of toRecalculate) this.dirtyCells.add(k);
        return toRecalculate;
    }

    /**
     * Get all dirty cells in topological order.
     *
     * Range dependencies (stored in rangeDependencies) must be included in the
     * sort — otherwise a formula like B1=SUM(A1:A10) whose range contains a
     * dirty formula cell A5 would be evaluated BEFORE A5 and see a stale value.
     *
     * For each dirty formula cell K we check both its point deps (dependencies)
     * and any dirty formula cells that fall inside its range deps
     * (rangeDependencies). Only dirty cells matter for ordering since
     * non-dirty formula cells already have correct values in computedValues.
     *
     * @returns {Array<string>} - Cell keys in evaluation order (deps before dependents)
     */
    getDirtyCellsOrdered() {
        this.circularCells.clear();
        const result = [];
        const visited = new Set();
        const visiting = new Set();

        // Pre-parse every dirty cell key so we don't re-parse inside inner loops.
        const dirtyParsed = new Map();
        for (const key of this.dirtyCells) {
            dirtyParsed.set(key, parseCellKey(key));
        }

        const visit = (key) => {
            if (visited.has(key)) return;
            if (visiting.has(key)) {
                // Circular dependency — record it; FormulaEngine will mark #CIRC!
                this.circularCells.add(key);
                return;
            }

            visiting.add(key);

            // 1. Point dependencies (individual cell refs).
            const deps = this.dependencies.get(key);
            if (deps) {
                for (const depKey of deps) {
                    if (this.formulas.has(depKey)) visit(depKey);
                }
            }

            // 2. Range dependencies: check whether any OTHER dirty formula cell
            //    falls inside one of this formula's ranges. If so, that cell
            //    must be evaluated first.
            const ranges = this.rangeDependencies.get(key);
            if (ranges && ranges.length > 0) {
                for (const [otherKey, { row, col }] of dirtyParsed) {
                    if (otherKey === key) continue;
                    if (!this.formulas.has(otherKey)) continue;
                    for (const r of ranges) {
                        if (row >= r.startRow && row <= r.endRow &&
                            col >= r.startCol && col <= r.endCol) {
                            visit(otherKey);
                            break;
                        }
                    }
                }
            }

            visiting.delete(key);
            visited.add(key);
            result.push(key);
        };

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
        this.rangeDependencies.clear();
        this.#rangeRowIndex.clear();
        this.#rangeSuperBucketIndex.clear();
        this.formulas.clear();
        this.dirtyCells.clear();
        this.circularCells.clear();
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
