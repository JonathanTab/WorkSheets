/**
 * RenderScheduler - Batches and deduplicates canvas paint requests via requestAnimationFrame.
 *
 * Multiple reactive effects may fire synchronously when data changes.
 * The scheduler coalesces them into a single RAF paint call to avoid redundant repaints.
 */
export class RenderScheduler {
    /** @type {Set<string>} Panes that need repainting: 'body','top','left','corner' */
    #dirty = new Set();

    /** @type {number|null} */
    #rafId = null;

    /** @type {(panes: Set<string>) => void} */
    #paintCallback = null;

    /**
     * @param {(panes: Set<string>) => void} paintCallback - Called on each RAF with the set of dirty panes
     */
    constructor(paintCallback) {
        this.#paintCallback = paintCallback;
    }

    /**
     * Mark one or all panes as needing repaint and schedule a RAF.
     * @param {'body'|'top'|'left'|'corner'|'all'} [pane='all']
     */
    invalidate(pane = 'all') {
        if (pane === 'all') {
            this.#dirty.add('body');
            this.#dirty.add('top');
            this.#dirty.add('left');
            this.#dirty.add('corner');
        } else {
            this.#dirty.add(pane);
        }
        this.#scheduleFrame();
    }

    /** Convenience: mark all panes dirty */
    invalidateAll() {
        this.invalidate('all');
    }

    /**
     * Force an immediate synchronous paint (for PDF export / testing).
     * Cancels any pending RAF.
     */
    flush() {
        if (this.#rafId !== null) {
            cancelAnimationFrame(this.#rafId);
            this.#rafId = null;
        }
        if (this.#dirty.size > 0) {
            const panes = new Set(this.#dirty);
            this.#dirty.clear();
            this.#paintCallback(panes);
        }
    }

    /**
     * Cancel any pending frame and stop scheduling.
     */
    destroy() {
        if (this.#rafId !== null) {
            cancelAnimationFrame(this.#rafId);
            this.#rafId = null;
        }
        this.#dirty.clear();
    }

    #scheduleFrame() {
        if (this.#rafId !== null) return; // already scheduled
        this.#rafId = requestAnimationFrame(() => {
            this.#rafId = null;
            const panes = new Set(this.#dirty);
            this.#dirty.clear();
            this.#paintCallback(panes);
        });
    }
}

export default RenderScheduler;
