/**
 * AxisMetrics - Efficient Axis Position Calculator
 *
 * Manages position calculations for a single axis (rows or columns).
 * Uses sparse overrides and a flat prefix-sum array for O(1) offset lookups.
 *
 * ## Key Features
 * - Sparse override storage (only non-default sizes stored)
 * - Flat Float64Array for O(1) cumulative offset lookups
 * - Binary search on flat array for O(log N) index lookups
 * - Temporary overrides for resize preview (layered dynamically)
 */
import { createAxisRange, emptyAxisRange } from './types.js';

export class AxisMetrics {
    /** @type {number} Total number of items on this axis */
    #count = 0;

    /** @type {number} Default size for each item */
    #defaultSize = 24;

    /** @type {Map<number, number>} Committed size overrides (from metadata) */
    #committedOverrides = new Map();

    /** @type {Map<number, number>} Temporary size overrides (during resize drag) */
    #tempOverrides = new Map();

    /** @type {Float64Array} Flat array of cumulative offsets. Length is count + 1. */
    #offsets = new Float64Array(0);

    /** @type {number} Cached total size */
    #totalSize = 0;

    /** @type {boolean} Whether offset array needs rebuild */
    #offsetsDirty = true;

    // Reactive state
    count = $state(0);
    defaultSize = $state(24);
    totalSize = $state(0);
    version = $state(0);

    constructor(defaultSize = 24) {
        this.#defaultSize = defaultSize;
        this.defaultSize = defaultSize;
    }

    setCount(count) {
        const newCount = Math.max(0, count);
        if (this.#count !== newCount) {
            this.#count = newCount;
            this.count = newCount;
            this.#offsetsDirty = true;
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    setDefaultSize(size) {
        const newSize = Math.max(1, size);
        if (this.#defaultSize !== newSize) {
            this.#defaultSize = newSize;
            this.defaultSize = newSize;
            this.#offsetsDirty = true;
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    applyCommittedOverride(index, size) {
        if (index < 0 || index >= this.#count) return;
        const effectiveSize = Math.max(1, size);
        if (this.#committedOverrides.get(index) === effectiveSize) return;

        this.#committedOverrides.set(index, effectiveSize);
        this.#offsetsDirty = true;
        this.#updateTotalSize();
        this.#bumpVersion();
    }

    applyCommittedOverrides(indices, sizes) {
        if (indices.length !== sizes.length) return;
        let changed = false;
        for (let i = 0; i < indices.length; i++) {
            const index = indices[i];
            if (index < 0 || index >= this.#count) continue;
            const effectiveSize = Math.max(1, sizes[i]);
            if (this.#committedOverrides.get(index) !== effectiveSize) {
                this.#committedOverrides.set(index, effectiveSize);
                changed = true;
            }
        }
        if (changed) {
            this.#offsetsDirty = true;
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    removeCommittedOverride(index) {
        if (this.#committedOverrides.has(index)) {
            this.#committedOverrides.delete(index);
            this.#offsetsDirty = true;
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    setTempOverride(index, size) {
        if (index < 0 || index >= this.#count) return;
        const effectiveSize = Math.max(1, size);
        if (this.#tempOverrides.get(index) === effectiveSize) return;
        this.#tempOverrides.set(index, effectiveSize);
        this.#updateTotalSize();
        this.#bumpVersion();
    }

    clearTempOverride(index) {
        if (this.#tempOverrides.delete(index)) {
            this.#updateTotalSize();
            this.#bumpVersion();
        }
    }

    clearTempOverrides(indices) {
        let changed = false;
        if (indices) {
            for (const index of indices) {
                if (this.#tempOverrides.delete(index)) changed = true;
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

    sizeOf(index) {
        if (index < 0 || index >= this.#count) return this.#defaultSize;
        if (this.#tempOverrides.has(index)) return this.#tempOverrides.get(index);
        if (this.#committedOverrides.has(index)) return this.#committedOverrides.get(index);
        return this.#defaultSize;
    }

    offsetOf(index) {
        if (index <= 0) return 0;
        if (index >= this.#count) return this.#totalSize;

        this.#ensureOffsets();
        let offset = this.#offsets[index];

        // Apply temporary overrides as a delta
        if (this.#tempOverrides.size > 0) {
            for (const [overrideIndex, tempSize] of this.#tempOverrides) {
                if (overrideIndex < index) {
                    const committedSize = this.#committedOverrides.get(overrideIndex) ?? this.#defaultSize;
                    offset += tempSize - committedSize;
                }
            }
        }

        return offset;
    }

    indexAtOffset(px) {
        if (px <= 0) return 0;
        if (px >= this.#totalSize) return Math.max(0, this.#count - 1);

        this.#ensureOffsets();

        // If no temp overrides, we can binary search the flat array directly
        if (this.#tempOverrides.size === 0) {
            let left = 0;
            let right = this.#count;
            while (left <= right) {
                const mid = (left + right) >> 1;
                const midOffset = this.#offsets[mid];

                if (px < midOffset) {
                    right = mid - 1;
                } else {
                    const nextOffset = this.#offsets[mid + 1];
                    if (px >= nextOffset) {
                        left = mid + 1;
                    } else {
                        return mid;
                    }
                }
            }
            return Math.max(0, left - 1);
        }

        // With temp overrides, use the slower binary search with offsetOf()
        // but this only happens during column/row resizing drag
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
                return mid;
            }
        }
        return Math.max(0, left - 1);
    }

    rangeForViewport(query) {
        const {
            scrollPx = 0,
            viewportPx = 0,
            overscanPx = 0,
            frozenCount = 0,
            axisCount = this.#count
        } = query;

        if (axisCount <= 0) return emptyAxisRange();

        const effectiveScroll = Math.max(0, scrollPx);
        const effectiveViewport = Math.max(1, viewportPx);

        const scrollStart = effectiveScroll - overscanPx;
        const scrollEnd = effectiveScroll + effectiveViewport + overscanPx;

        const startIndex = Math.max(frozenCount, this.indexAtOffset(Math.max(0, scrollStart)));
        const endOffsetIndex = this.indexAtOffset(scrollEnd);
        const endIndex = Math.min(axisCount - 1, endOffsetIndex + 1);

        if (startIndex > endIndex && frozenCount < axisCount) {
            return createAxisRange(frozenCount, frozenCount);
        }

        return createAxisRange(startIndex, endIndex);
    }

    getFrozenOffset(frozenCount) {
        if (frozenCount <= 0) return 0;
        return this.offsetOf(frozenCount);
    }

    clearAll() {
        this.#committedOverrides.clear();
        this.#tempOverrides.clear();
        this.#offsetsDirty = true;
        this.#updateTotalSize();
        this.#bumpVersion();
    }

    loadOverrides(overrides) {
        let changed = false;
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

        this.#offsetsDirty = true;
        this.#updateTotalSize();
        this.#bumpVersion();
    }

    #ensureOffsets() {
        if (!this.#offsetsDirty) return;

        if (this.#offsets.length !== this.#count + 1) {
            this.#offsets = new Float64Array(this.#count + 1);
        }

        let currentOffset = 0;
        const defaultSize = this.#defaultSize;
        const overrides = this.#committedOverrides;

        this.#offsets[0] = 0;
        for (let i = 0; i < this.#count; i++) {
            const size = overrides.get(i) ?? defaultSize;
            currentOffset += size;
            this.#offsets[i + 1] = currentOffset;
        }

        this.#offsetsDirty = false;
    }

    #bumpVersion() {
        this.version += 1;
    }

    #updateTotalSize() {
        let total = this.#count * this.#defaultSize;

        for (const [index, size] of this.#committedOverrides) {
            if (index >= 0 && index < this.#count) {
                total += (size - this.#defaultSize);
            }
        }

        for (const [index, tempSize] of this.#tempOverrides) {
            if (index >= 0 && index < this.#count) {
                const committedSize = this.#committedOverrides.get(index) ?? this.#defaultSize;
                total += (tempSize - committedSize);
            }
        }

        this.#totalSize = Math.max(0, total);
        this.totalSize = this.#totalSize;
    }

    getCommittedOverrides() {
        return new Map(this.#committedOverrides);
    }

    hasTempOverrides() {
        return this.#tempOverrides.size > 0;
    }
}

export default AxisMetrics;
