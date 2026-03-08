/**
 * AxisMetrics - Efficient Axis Position Calculator
 *
 * Manages position calculations for a single axis (rows or columns).
 * Uses sparse overrides and prefix-sum math for O(log M) lookups where M is
 * the number of resized items, avoiding full O(N) rebuilds.
 *
 * ## Key Features
 * - Sparse override storage (only non-default sizes stored)
 * - Binary search for index/offset lookups
 * - Temporary overrides for resize preview (no full invalidation)
 * - Incremental updates when individual sizes change
 *
 * ## Architecture
 * - Base model: defaultSize * index
 * - Sparse overrides: Map<index, size> for custom sizes
 * - Prefix delta arrays for efficient offset calculation
 */
import { createAxisRange, emptyAxisRange } from './types.js';

/**
 * AxisMetrics class
 *
 * Efficiently calculates positions along an axis with variable sizes.
 */
export class AxisMetrics {
    /** @type {number} Total number of items on this axis */
    #count = 0;

    /** @type {number} Default size for each item */
    #defaultSize = 24;

    /** @type {Map<number, number>} Committed size overrides (from metadata) */
    #committedOverrides = new Map();

    /** @type {Map<number, number>} Temporary size overrides (during resize drag) */
    #tempOverrides = new Map();

    /** @type {number[]} Sorted array of override indices for binary search */
    #sortedOverrideIndices = [];

    /** @type {number[]} Prefix sum deltas at each override index */
    #prefixDeltas = [];

    /** @type {number} Cached total size */
    #totalSize = 0;

    /** @type {boolean} Whether prefix arrays need rebuild */
    #prefixDirty = true;

    // Reactive state
    count = $state(0);
    defaultSize = $state(24);
    totalSize = $state(0);
    version = $state(0);

    /**
     * Create an AxisMetrics instance
     * @param {number} defaultSize - Default size for items
     */
    constructor(defaultSize = 24) {
        this.#defaultSize = defaultSize;
        this.defaultSize = defaultSize;
    }

    /**
     * Set the total number of items on this axis
     * @param {number} count
     */
    setCount(count) {
        const newCount = Math.max(0, count);
        if (this.#count !== newCount) {
            this.#count = newCount;
            this.count = newCount;
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    /**
     * Set the default size for items
     * @param {number} size
     */
    setDefaultSize(size) {
        const newSize = Math.max(1, size);
        if (this.#defaultSize !== newSize) {
            this.#defaultSize = newSize;
            this.defaultSize = newSize;
            this.#prefixDirty = true;
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    /**
     * Apply a committed size override (from sheet metadata)
     * @param {number} index
     * @param {number} size
     */
    applyCommittedOverride(index, size) {
        if (index < 0 || index >= this.#count) return;

        const effectiveSize = Math.max(1, size);
        const oldSize = this.#committedOverrides.get(index);

        if (oldSize === effectiveSize) return;

        this.#committedOverrides.set(index, effectiveSize);
        this.#prefixDirty = true;
        this.#updateTotalSize();
        this.#bumpVersion();
    }

    /**
     * Apply multiple committed size overrides at once
     * @param {number[]} indices
     * @param {number[]} sizes
     */
    applyCommittedOverrides(indices, sizes) {
        if (indices.length !== sizes.length) return;

        let changed = false;
        for (let i = 0; i < indices.length; i++) {
            const index = indices[i];
            if (index < 0 || index >= this.#count) continue;

            const effectiveSize = Math.max(1, sizes[i]);
            const oldSize = this.#committedOverrides.get(index);

            if (oldSize !== effectiveSize) {
                this.#committedOverrides.set(index, effectiveSize);
                changed = true;
            }
        }

        if (changed) {
            this.#prefixDirty = true;
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    /**
     * Remove a committed override
     * @param {number} index
     */
    removeCommittedOverride(index) {
        if (this.#committedOverrides.has(index)) {
            this.#committedOverrides.delete(index);
            this.#prefixDirty = true;
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    /**
     * Set a temporary override (during resize drag)
     * Does not affect committed overrides
     * @param {number} index
     * @param {number} size
     */
    setTempOverride(index, size) {
        if (index < 0 || index >= this.#count) return;

        const effectiveSize = Math.max(1, size);
        const oldSize = this.#tempOverrides.get(index);
        if (oldSize === effectiveSize) return;
        this.#tempOverrides.set(index, effectiveSize);

        // Temp overrides don't change prefix arrays (they layer on top)
        // But they do affect total size
        this.#updateTotalSize();
        this.#bumpVersion();
    }

    /**
     * Clear a temporary override
     * @param {number} index
     */
    clearTempOverride(index) {
        if (this.#tempOverrides.has(index)) {
            this.#tempOverrides.delete(index);
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    /**
     * Clear all temporary overrides
     * @param {number[]} [indices] - Optional specific indices to clear
     */
    clearTempOverrides(indices) {
        let changed = false;
        if (indices) {
            for (const index of indices) {
                if (this.#tempOverrides.delete(index)) {
                    changed = true;
                }
            }
        } else {
            changed = this.#tempOverrides.size > 0;
            this.#tempOverrides.clear();
        }
        if (changed) {
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    /**
     * Get the effective size of an item (temp > committed > default)
     * @param {number} index
     * @returns {number}
     */
    sizeOf(index) {
        if (index < 0 || index >= this.#count) return this.#defaultSize;

        // Check temp overrides first
        if (this.#tempOverrides.has(index)) {
            return this.#tempOverrides.get(index);
        }

        // Then committed overrides
        if (this.#committedOverrides.has(index)) {
            return this.#committedOverrides.get(index);
        }

        return this.#defaultSize;
    }

    /**
     * Get the cumulative offset of an item (sum of all previous item sizes)
     * @param {number} index
     * @returns {number}
     */
    offsetOf(index) {
        if (index <= 0) return 0;
        if (index >= this.#count) {
            return this.#totalSize;
        }

        // Ensure prefix arrays are up to date
        this.#ensurePrefixArrays();

        // Base offset: default size * index
        let offset = index * this.#defaultSize;

        // Add prefix delta from binary search
        // Find the largest override index < this index
        const prefixDelta = this.#getPrefixDelta(index);
        offset += prefixDelta;

        // Apply temporary overrides as a delta over committed/default sizes
        // for all indices before the requested offset index.
        if (this.#tempOverrides.size > 0) {
            for (const [overrideIndex, tempSize] of this.#tempOverrides) {
                if (overrideIndex < index) {
                    const committedSize =
                        this.#committedOverrides.get(overrideIndex) ?? this.#defaultSize;
                    offset += tempSize - committedSize;
                }
            }
        }

        return offset;
    }

    /**
     * Find the index at a given pixel offset using binary search
     * @param {number} px - Pixel offset
     * @returns {number} Index at or just before this offset
     */
    indexAtOffset(px) {
        if (px <= 0) return 0;
        if (px >= this.#totalSize) return Math.max(0, this.#count - 1);

        // Ensure prefix arrays are up to date
        this.#ensurePrefixArrays();

        // Binary search using prefix deltas
        let left = 0;
        let right = this.#count;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            const midOffset = this.offsetOf(mid);
            const midSize = this.sizeOf(mid);
            const midEnd = midOffset + midSize;

            if (px < midOffset) {
                right = mid;
            } else if (px >= midEnd) {
                left = mid + 1;
            } else {
                // px is within this item
                return mid;
            }
        }

        return Math.max(0, left - 1);
    }

    /**
     * Calculate the visible range for a viewport
     * @param {Object} query
     * @param {number} query.scrollPx - Scroll position
     * @param {number} query.viewportPx - Viewport size
     * @param {number} query.overscanPx - Overscan buffer
     * @param {number} query.frozenCount - Number of frozen items at start
     * @param {number} query.axisCount - Total items (uses internal count if not provided)
     * @returns {import('./types.js').AxisRange}
     */
    rangeForViewport(query) {
        const {
            scrollPx = 0,
            viewportPx = 0,
            overscanPx = 0,
            frozenCount = 0,
            axisCount = this.#count
        } = query;

        if (axisCount <= 0) {
            return emptyAxisRange();
        }

        const effectiveScroll = Math.max(0, scrollPx);
        const effectiveViewport = Math.max(1, viewportPx);

        // Find visible range in scrollable area
        const scrollStart = effectiveScroll - overscanPx;
        const scrollEnd = effectiveScroll + effectiveViewport + overscanPx;

        // Find indices
        const startIndex = Math.max(frozenCount, this.indexAtOffset(Math.max(0, scrollStart)));
        const endOffsetIndex = this.indexAtOffset(scrollEnd);
        const endIndex = Math.min(axisCount - 1, endOffsetIndex + 1);

        // Ensure we have at least one visible item if possible
        if (startIndex > endIndex && frozenCount < axisCount) {
            return createAxisRange(frozenCount, frozenCount);
        }

        return createAxisRange(startIndex, endIndex);
    }

    /**
     * Get the offset of the frozen area end
     * @param {number} frozenCount
     * @returns {number}
     */
    getFrozenOffset(frozenCount) {
        if (frozenCount <= 0) return 0;
        return this.offsetOf(frozenCount);
    }

    /**
     * Clear all overrides (committed and temp)
     */
    clearAll() {
        this.#committedOverrides.clear();
        this.#tempOverrides.clear();
        this.#sortedOverrideIndices = [];
        this.#prefixDeltas = [];
        this.#prefixDirty = true;
        this.#updateTotalSize();
        this.#bumpVersion();
    }

    /**
     * Load overrides from a map (batch operation)
     * @param {Map<number, number>} overrides
     */
    loadOverrides(overrides) {
        let changed = false;

        // Check if committed overrides actually changed
        const newSize = overrides?.size ?? 0;
        if (newSize !== this.#committedOverrides.size) {
            changed = true;
        } else if (overrides) {
            for (const [index, size] of overrides) {
                if (this.#committedOverrides.get(index) !== Math.max(1, size)) {
                    changed = true;
                    break;
                }
            }
        }

        // Always clear temp overrides on full sync?
        // Let's check if there are temp overrides to clear
        if (this.#tempOverrides.size > 0) {
            changed = true;
            this.#tempOverrides.clear();
        }

        if (!changed) return;

        this.#committedOverrides.clear();
        if (overrides) {
            for (const [index, size] of overrides) {
                if (index >= 0 && index < this.#count) {
                    this.#committedOverrides.set(index, Math.max(1, size));
                }
            }
        }

        this.#prefixDirty = true;
        this.#updateTotalSize();
        this.#bumpVersion();
    }

    // --- Private Methods ---

    /**
     * Ensure prefix arrays are rebuilt if needed
     */
    #ensurePrefixArrays() {
        if (!this.#prefixDirty) return;

        // Sort override indices
        this.#sortedOverrideIndices = Array.from(this.#committedOverrides.keys()).sort((a, b) => a - b);

        // Build prefix delta array
        this.#prefixDeltas = [];
        let cumulativeDelta = 0;

        for (const index of this.#sortedOverrideIndices) {
            const overrideSize = this.#committedOverrides.get(index);
            const delta = overrideSize - this.#defaultSize;
            cumulativeDelta += delta;
            this.#prefixDeltas.push(cumulativeDelta);
        }

        this.#prefixDirty = false;
    }

    /**
     * Get the cumulative delta for all overrides before a given index
     * @param {number} index
     * @returns {number}
     */
    #getPrefixDelta(index) {
        this.#ensurePrefixArrays();

        if (this.#sortedOverrideIndices.length === 0) return 0;

        // Binary search for first override >= index
        let left = 0;
        let right = this.#sortedOverrideIndices.length;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (this.#sortedOverrideIndices[mid] < index) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        // All overrides before 'left' are < index, so use cumulative prefix.
        if (left === 0) return 0;
        return this.#prefixDeltas[left - 1] ?? 0;
    }

    #bumpVersion() {
        this.version += 1;
    }

    /**
     * Update total size cache
     */
    #updateTotalSize() {
        // Base size
        let total = this.#count * this.#defaultSize;

        // Add deltas from committed overrides
        for (const [index, size] of this.#committedOverrides) {
            if (index >= 0 && index < this.#count) {
                total += (size - this.#defaultSize);
            }
        }

        // Add deltas from temp overrides (they layer on top of committed)
        for (const [index, tempSize] of this.#tempOverrides) {
            if (index >= 0 && index < this.#count) {
                const committedSize = this.#committedOverrides.get(index) ?? this.#defaultSize;
                total += (tempSize - committedSize);
            }
        }

        this.#totalSize = Math.max(0, total);
        this.totalSize = this.#totalSize;
    }

    /**
     * Get all committed overrides (for serialization/testing)
     * @returns {Map<number, number>}
     */
    getCommittedOverrides() {
        return new Map(this.#committedOverrides);
    }

    /**
     * Check if there are any temporary overrides
     * @returns {boolean}
     */
    hasTempOverrides() {
        return this.#tempOverrides.size > 0;
    }
}

export default AxisMetrics;
