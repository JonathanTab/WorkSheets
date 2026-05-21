/**
 * PaintInvalidator — Named-channel canvas invalidation bus.
 *
 * Replaces the brittle $effect blocks in Grid.svelte that read 8–10 reactive
 * deps and call `renderScheduler.invalidateAll()` unconditionally. With named
 * channels, a hover-row change invalidates only the hover overlay layer, not
 * every cell on the grid.
 *
 * ## Channels
 *   'data'        Cell values, formulas, type configs — triggers full body repaint
 *   'selection'   Selection range change — triggers selection canvas repaint only
 *   'viewOptions' Freeze lines, gridline toggle, zoom — triggers body repaint
 *   'viewport'    Scroll position / virtualization change — triggers body repaint
 *   'hover'       Hover state (table grip, link) — triggers overlay repaint only
 *
 * ## Usage (in Grid.svelte, once wired in Phase 4)
 *
 *   import { PaintInvalidator } from './PaintInvalidator.js';
 *   const invalidator = new PaintInvalidator();
 *
 *   // Subscribe per scheduler:
 *   invalidator.on('data',      () => bodyScheduler.invalidateAll());
 *   invalidator.on('selection', () => selectionScheduler.invalidateAll());
 *   invalidator.on('hover',     () => bodyScheduler.invalidateDirty()); // cheap
 *
 *   // Emit from $effects (one dep per channel, no cross-channel coupling):
 *   $effect(() => { void sheetStore.cellsVersion; invalidator.emit('data'); });
 *   $effect(() => { void selectionState.range;    invalidator.emit('selection'); });
 *
 * The bus is intentionally synchronous and non-buffering — emitting during a
 * Svelte reactive cycle schedules the next rAF frame via the scheduler's queue,
 * so no double-paint occurs within a single microtask.
 */

/** @typedef {'data'|'selection'|'viewOptions'|'viewport'|'hover'} InvalidationChannel */

export class PaintInvalidator {
    /** @type {Map<InvalidationChannel, Set<() => void>>} */
    #listeners = new Map();

    /**
     * Register a listener for a channel.
     * Returns an unsubscribe function.
     * @param {InvalidationChannel} channel
     * @param {() => void} fn
     * @returns {() => void}
     */
    on(channel, fn) {
        if (!this.#listeners.has(channel)) this.#listeners.set(channel, new Set());
        this.#listeners.get(channel).add(fn);
        return () => this.off(channel, fn);
    }

    /**
     * Remove a listener.
     * @param {InvalidationChannel} channel
     * @param {() => void} fn
     */
    off(channel, fn) {
        this.#listeners.get(channel)?.delete(fn);
    }

    /**
     * Emit an invalidation signal on the given channel.
     * All registered listeners are called synchronously.
     * @param {InvalidationChannel} channel
     */
    emit(channel) {
        const fns = this.#listeners.get(channel);
        if (fns) for (const fn of fns) fn();
    }

    /**
     * Emit 'data' and 'selection' together — convenience for changes that
     * affect both cell content and selection rendering (e.g. paste, clear).
     */
    emitFull() {
        this.emit('data');
        this.emit('selection');
    }

    /** Remove all listeners (for cleanup on component destroy). */
    destroy() {
        this.#listeners.clear();
    }
}
