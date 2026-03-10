/**
 * MergeEngine - Reactive merge state manager
 *
 * Wraps the sheet's merges Y.Array to provide:
 * - Reactive merge list with fast index lookup
 * - Merge/unmerge mutations via Yjs transactions
 * - Span queries for rendering (rowSpan, colSpan)
 *
 * The index covers ALL cells in every merge (not just the primary cell),
 * enabling O(1) "is this cell merged?" queries.
 */
import * as Y from 'yjs';

export class MergeEngine {
    /** @type {Y.Array} */
    #mergesYArray;

    /** @type {Y.Doc} */
    #ydoc;

    /** @type {Function|null} */
    #cleanup = null;

    /** @type {Map<string, Object>} "row,col" → merge object (all cells in all merges) */
    #index = new Map();

    // Reactive merge list (plain objects, not Y.Maps)
    merges = $state([]);

    // Bumped whenever merges change — lets GridVirtualizer / render systems react
    version = $state(0);

    /**
     * @param {Y.Map} sheet - The sheet Y.Map
     * @param {Y.Doc} ydoc
     */
    constructor(sheet, ydoc) {
        this.#mergesYArray = sheet.get('merges');
        this.#ydoc = ydoc;

        // Ensure merges array exists (older documents might not have it)
        if (!this.#mergesYArray) {
            ydoc.transact(() => sheet.set('merges', new Y.Array()));
            this.#mergesYArray = sheet.get('merges');
        }

        this.#rebuildIndex();

        const observer = () => {
            this.#rebuildIndex();
            this.version++;
        };
        this.#mergesYArray.observe(observer);
        this.#cleanup = () => this.#mergesYArray.unobserve(observer);
    }

    // -------------------------------------------------------------------------
    // Private

    #rebuildIndex() {
        this.#index.clear();
        const arr = this.#mergesYArray.toArray();

        // Defensive: filter out any non-plain-object entries
        const valid = arr.filter(m =>
            m &&
            typeof m.startRow === 'number' &&
            typeof m.startCol === 'number' &&
            typeof m.endRow === 'number' &&
            typeof m.endCol === 'number'
        );

        this.merges = valid;

        for (const merge of valid) {
            for (let r = merge.startRow; r <= merge.endRow; r++) {
                for (let c = merge.startCol; c <= merge.endCol; c++) {
                    this.#index.set(`${r},${c}`, merge);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Public query API

    /**
     * Is this cell part of any merge (primary or shadow)?
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isMergeCell(row, col) {
        return this.#index.has(`${row},${col}`);
    }

    /**
     * Is this the top-left (primary) cell of a merge?
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isMergePrimary(row, col) {
        const m = this.#index.get(`${row},${col}`);
        return m !== undefined && m.startRow === row && m.startCol === col;
    }

    /**
     * Get the merge containing this cell, or null
     * @param {number} row
     * @param {number} col
     * @returns {{ startRow, startCol, endRow, endCol } | null}
     */
    getMergeAt(row, col) {
        return this.#index.get(`${row},${col}`) ?? null;
    }

    /**
     * Get rowSpan/colSpan for the primary cell, or null if not a primary
     * @param {number} row
     * @param {number} col
     * @returns {{ rowSpan: number, colSpan: number } | null}
     */
    getMergeSpan(row, col) {
        const m = this.#index.get(`${row},${col}`);
        if (!m || m.startRow !== row || m.startCol !== col) return null;
        return {
            rowSpan: m.endRow - m.startRow + 1,
            colSpan: m.endCol - m.startCol + 1
        };
    }

    // -------------------------------------------------------------------------
    // Mutations

    /**
     * Merge a rectangular range of cells.
     * Any existing merges that overlap this range are removed first.
     * @param {number} startRow
     * @param {number} startCol
     * @param {number} endRow
     * @param {number} endCol
     */
    mergeCells(startRow, startCol, endRow, endCol) {
        if (startRow > endRow || startCol > endCol) return;
        if (startRow === endRow && startCol === endCol) return; // single cell — no-op

        this.#ydoc.transact(() => {
            const arr = this.#mergesYArray.toArray();
            // Find overlapping merges (reverse order for safe deletion)
            const toRemove = [];
            for (let i = 0; i < arr.length; i++) {
                const m = arr[i];
                const overlaps =
                    m.startRow <= endRow && m.endRow >= startRow &&
                    m.startCol <= endCol && m.endCol >= startCol;
                if (overlaps) toRemove.push(i);
            }
            for (let i = toRemove.length - 1; i >= 0; i--) {
                this.#mergesYArray.delete(toRemove[i], 1);
            }
            this.#mergesYArray.push([{ startRow, startCol, endRow, endCol }]);
        });
    }

    /**
     * Remove the merge whose primary cell is at (startRow, startCol).
     * @param {number} startRow
     * @param {number} startCol
     */
    unmergeCells(startRow, startCol) {
        const arr = this.#mergesYArray.toArray();
        const idx = arr.findIndex(m => m.startRow === startRow && m.startCol === startCol);
        if (idx !== -1) {
            this.#ydoc.transact(() => this.#mergesYArray.delete(idx, 1));
        }
    }

    /**
     * Remove all merges that contain any cell in the given range.
     * @param {number} startRow
     * @param {number} endRow
     * @param {number} startCol
     * @param {number} endCol
     */
    unmergeRange(startRow, endRow, startCol, endCol) {
        this.#ydoc.transact(() => {
            const arr = this.#mergesYArray.toArray();
            const toRemove = [];
            for (let i = 0; i < arr.length; i++) {
                const m = arr[i];
                const overlaps =
                    m.startRow <= endRow && m.endRow >= startRow &&
                    m.startCol <= endCol && m.endCol >= startCol;
                if (overlaps) toRemove.push(i);
            }
            for (let i = toRemove.length - 1; i >= 0; i--) {
                this.#mergesYArray.delete(toRemove[i], 1);
            }
        });
    }

    /**
     * Shift merges horizontally or vertically.
     * @param {'row'|'col'} axis
     * @param {number} atIndex
     * @param {number} delta
     */
    shiftAxes(axis, atIndex, delta) {
        const startKey = axis === 'row' ? 'startRow' : 'startCol';
        const endKey = axis === 'row' ? 'endRow' : 'endCol';

        this.#ydoc.transact(() => {
            const arr = this.#mergesYArray.toArray();
            for (let i = 0; i < arr.length; i++) {
                const m = arr[i];
                let changed = false;

                if (delta > 0) {
                    // Insertion
                    if (m[startKey] >= atIndex) {
                        // Shift whole merge
                        m[startKey] += delta;
                        m[endKey] += delta;
                        changed = true;
                    } else if (m[endKey] >= atIndex) {
                        // Expand merge
                        m[endKey] += delta;
                        changed = true;
                    }
                } else if (delta < 0) {
                    // Deletion
                    if (m[startKey] > atIndex) {
                        // Shift whole merge up/left
                        m[startKey] += delta;
                        m[endKey] += delta;
                        changed = true;
                    } else if (m[startKey] <= atIndex && m[endKey] >= atIndex) {
                        // Merge covers deleted index
                        if (m[startKey] === m[endKey]) {
                            // Single row/col merge being deleted
                            this.#mergesYArray.delete(i, 1);
                            arr.splice(i, 1);
                            i--;
                            continue;
                        } else {
                            // Contract merge
                            m[endKey] += delta;
                            changed = true;
                        }
                    }
                }

                if (changed) {
                    this.#mergesYArray.delete(i, 1);
                    this.#mergesYArray.insert(i, [m]);
                }
            }
        });
    }

    // -------------------------------------------------------------------------
    // Lifecycle

    destroy() {
        if (this.#cleanup) {
            this.#cleanup();
            this.#cleanup = null;
        }
    }
}

export default MergeEngine;
