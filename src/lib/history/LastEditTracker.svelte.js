/**
 * LastEditTracker — watches a Y.Doc for meaningful content changes and
 * notifies the HistoryManager to update the local "last edited by" display.
 *
 * The Yjs server handles authoritative last-edit tracking server-side via
 * its update handler (updateFileLastEdit). This tracker only provides the
 * reactive in-session header update.
 */
export class LastEditTracker {
    /**
     * @param {{
     *   ydoc: import('yjs').Doc,
     *   username: string,
     *   historyManager: import('./HistoryManager.svelte.js').HistoryManager,
     *   isContentChange?: (update: Uint8Array, origin: any) => boolean,
     * }} opts
     */
    constructor({ ydoc, username, historyManager, isContentChange }) {
        this._ydoc = ydoc;
        this._username = username;
        this._historyManager = historyManager;
        this._isContentChange = isContentChange ?? _defaultIsContentChange;
        this._destroyed = false;

        this._handler = (update, origin) => {
            if (this._destroyed) return;
            if (!this._isContentChange(update, origin)) return;
            this._historyManager.notifyLocalEdit(this._username);
        };

        this._ydoc.on('update', this._handler);
    }

    destroy() {
        this._destroyed = true;
        this._ydoc.off('update', this._handler);
    }
}

/**
 * Default content-change filter: accepts all non-null origin updates.
 * Awareness-only updates from y-protocols have origin = null.
 */
function _defaultIsContentChange(_update, origin) {
    return origin !== null;
}
