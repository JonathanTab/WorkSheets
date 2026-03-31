/**
 * NodeYjsRuntime - WebSocket-only Yjs runtime for Node.js CLI usage.
 *
 * Skips IndexedDB (browser-only). Connects via WebSocket and waits for initial
 * sync before resolving, so callers can immediately read/write consistent data.
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const SYNC_TIMEOUT_MS = 15_000;

export class NodeYjsRuntime {
    /**
     * @param {string} wsUrl
     * @param {string|null} [apiKey]  Bearer token passed as ?auth= query param
     */
    constructor(wsUrl, apiKey = null) {
        this.wsUrl  = wsUrl;
        this.apiKey = apiKey;
        /** @type {Map<string, { ydoc: Y.Doc, provider: WebsocketProvider }>} */
        this._active = new Map();
    }

    /**
     * Load a document and wait for the initial WebSocket sync.
     * Returns the same instance if already loaded.
     * @param {string} docId
     * @param {string} roomId
     * @returns {Promise<Y.Doc>}
     */
    async load(docId, roomId) {
        if (this._active.has(docId)) {
            return this._active.get(docId).ydoc;
        }

        const ydoc = new Y.Doc();

        const wsOpts = this.apiKey ? { params: { auth: this.apiKey } } : {};
        const provider = new WebsocketProvider(this.wsUrl, roomId, ydoc, wsOpts);

        await new Promise((resolve, reject) => {
            if (provider.synced) { resolve(); return; }

            const timer = setTimeout(() => {
                reject(new Error(`Yjs sync timeout for room "${roomId}" after ${SYNC_TIMEOUT_MS}ms`));
            }, SYNC_TIMEOUT_MS);

            provider.once('synced', () => {
                clearTimeout(timer);
                resolve();
            });
        });

        this._active.set(docId, { ydoc, provider });
        return ydoc;
    }

    /**
     * Wait a brief moment for outgoing updates to be flushed over WebSocket.
     * Call this after making mutations before calling shutdown().
     * @param {number} [ms=1000]
     */
    flush(ms = 1000) {
        return new Promise(r => setTimeout(r, ms));
    }

    /** @param {string} docId */
    unload(docId) {
        const entry = this._active.get(docId);
        if (entry) {
            entry.provider.disconnect();
            entry.provider.destroy();
            entry.ydoc.destroy();
            this._active.delete(docId);
        }
    }

    shutdown() {
        for (const docId of [...this._active.keys()]) this.unload(docId);
    }
}
