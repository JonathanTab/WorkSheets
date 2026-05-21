/**
 * YjsSyncCoordinator - Cross-app, cross-tab background Yjs sync manager.
 *
 * Problem: When a Yjs document is edited offline and that tab is later closed,
 * no WebSocket provider is connected to push those IndexedDB-stored changes to
 * the server. This coordinator ensures any open app belonging to the same user
 * can take responsibility for syncing outstanding rooms.
 *
 * Mechanism:
 *   1. Leader election via Web Locks API. Exactly one tab across all apps holds
 *      the "leader" lock at any time and is responsible for processing the queue.
 *   2. BroadcastChannel for cross-tab signalling (e.g. notifying others of sync
 *      completion or forwarding 'online' events to the current leader).
 *   3. For each pending room, a temporary Y.Doc + WebsocketProvider is created
 *      just long enough to push IndexedDB changes to the server, then destroyed.
 *      Yjs's CRDT guarantees this is always safe and idempotent.
 *
 * Usage:
 *   const coord = new YjsSyncCoordinator({ username, pendingStore, api, runtime });
 *   coord.start();
 *   // ...
 *   coord.shutdown();
 */

import * as Y from 'yjs';
import { log } from '../../../util/log.js';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

const PERSISTENCE_TIMEOUT = 5_000;   // ms to wait for IndexedDB load
const WS_SYNC_TIMEOUT     = 30_000;  // ms to wait for WebSocket sync
const POLL_INTERVAL       = 60_000;  // ms between leader polling cycles
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // expire pending entries after 7 days

export class YjsSyncCoordinator {
    /**
     * @param {object} opts
     * @param {string}                opts.username
     * @param {import('./OfflineSyncStore.js').OfflineSyncStore} opts.pendingStore
     * @param {import('../api/StorageAPI.js').StorageAPI}        opts.api
     * @param {import('./YjsRuntime.js').YjsRuntime}             opts.runtime  - this tab's runtime
     * @param {(() => string|null)|null} [opts.getApiKey] - Returns Bearer token for WebSocket auth
     */
    constructor({ username, pendingStore, api, runtime, getApiKey = null }) {
        this.username      = username;
        this._pendingStore = pendingStore;
        this._api          = api;
        this._runtime      = runtime;
        this._getApiKey    = getApiKey;

        // True if we believe we have network connectivity — uses both navigator.onLine
        // and the runtime's per-doc WS liveness to avoid false "online" readings.
        this._isOnline = () => navigator.onLine || (this._runtime?.isAnyLive() ?? false);

        // Optional error sink. Wire this up in FileRegistry to surface sync failures
        // in DevTools / logging rather than swallowing them silently.
        /** @type {((scope: string, err: Error) => void)|null} */
        this.onError = null;

        this._isLeader      = false;
        this._channel       = null;
        this._pollInterval  = null;
        this._lockAbort     = null;
        this._leaderResolve = null;
        this._onOnline      = null;
    }

    // -------------------------------------------------------
    // Public
    // -------------------------------------------------------

    start() {
        if (typeof window === 'undefined') return;

        // Cross-tab communication channel
        if (typeof BroadcastChannel !== 'undefined') {
            this._channel = new BroadcastChannel(`fileregistry_sync_${this.username}`);
            this._channel.onmessage = (e) => this._onChannelMessage(e.data);
        }

        // Forward 'online' events to the leader (or handle directly if we are leader)
        this._onOnline = () => {
            if (this._isLeader) {
                this._processPending().catch(() => {});
            } else {
                this._channel?.postMessage({ type: 'online' });
            }
        };
        window.addEventListener('online', this._onOnline);

        // Also sweep on visibility restore — catches laptop resume and tab re-focus
        // where 'online' doesn't fire but network is available again.
        this._onVisible = () => {
            if (document.visibilityState !== 'visible') return;
            if (this._isLeader) {
                this._processPending().catch(() => {});
            } else {
                this._channel?.postMessage({ type: 'online' });
            }
        };
        document.addEventListener('visibilitychange', this._onVisible);

        // Compete for leader lock. If Web Locks API unavailable, every tab acts as
        // leader independently (safe due to Yjs CRDT idempotency).
        if ('locks' in navigator) {
            this._lockAbort = new AbortController();
            navigator.locks.request(
                `fileregistry_leader_${this.username}`,
                { signal: this._lockAbort.signal },
                () => this._runLeaderLoop()
            ).catch(err => {
                if (err.name !== 'AbortError') {
                    console.warn('[YjsSyncCoordinator] Lock request failed:', err);
                    this.onError?.('lock', err);
                    // Fall back to running as leader without coordination
                    this._runLeaderLoop().catch(e => this.onError?.('leader-loop', e));
                }
            });
        } else {
            // No Web Locks support - run inline (all tabs will process, harmless)
            this._runLeaderLoop().catch(e => this.onError?.('leader-loop', e));
        }
    }

    /**
     * Mark a Yjs file as needing sync. Call this whenever a local (offline) edit occurs.
     * @param {string} fileId
     * @param {string} roomId
     * @param {string} wsUrl
     * @param {string|null} [appType]
     */
    async markNeedsSync(fileId, roomId, wsUrl, appType = null) {
        await this._pendingStore.addPending({
            fileId,
            roomId,
            wsUrl,
            appType: appType ?? null,
            mtime: new Date().toISOString(),
        });
    }

    /**
     * Queue a server-side mtime bump for a file.
     * @param {string} fileId
     */
    async queueTouch(fileId) {
        await this._pendingStore.addToTouchQueue({
            fileId,
            mtime: new Date().toISOString(),
        });
        // Process immediately if we're online and leading
        if (this._isOnline() && this._isLeader) {
            this._processTouchQueue().catch(() => {});
        }
    }

    shutdown() {
        if (this._onOnline) window.removeEventListener('online', this._onOnline);
        if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
        // Release the leader lock by resolving the promise returned to locks.request
        this._leaderResolve?.();
        // Cancel any pending lock acquisition
        this._lockAbort?.abort();
        clearInterval(this._pollInterval);
        this._channel?.close();
        this._channel      = null;
        this._isLeader     = false;
        this._leaderResolve = null;
    }

    // -------------------------------------------------------
    // Leader loop
    // -------------------------------------------------------

    async _runLeaderLoop() {
        this._isLeader = true;
        log.debug('[YjsSyncCoordinator] Became sync leader');

        // Initial pass
        if (this._isOnline()) {
            await this._processPending().catch(e => this.onError?.('initial-pass', e));
        }

        // Hold the lock / keep running until shutdown()
        await new Promise(resolve => {
            this._leaderResolve = resolve;
            this._pollInterval = setInterval(async () => {
                if (this._isOnline()) await this._processPending().catch(e => this.onError?.('poll', e));
            }, POLL_INTERVAL);
        });

        clearInterval(this._pollInterval);
        this._pollInterval = null;
        this._isLeader = false;
        log.debug('[YjsSyncCoordinator] Released leader role');
    }

    _onChannelMessage(data) {
        if (data.type === 'online' && this._isLeader) {
            this._processPending().catch(e => this.onError?.('channel-trigger', e));
        }
    }

    // -------------------------------------------------------
    // Pending sync processing
    // -------------------------------------------------------

    async _processPending() {
        const pending = await this._pendingStore.getAllPending();
        if (pending.length === 0) {
            await this._processTouchQueue();
            return;
        }

        log.debug(`[YjsSyncCoordinator] Processing ${pending.length} pending sync item(s)`);
        const now = Date.now();

        for (const entry of pending) {
            if (!this._isOnline()) break;

            // Expire stale entries (file likely deleted or permanently offline)
            if (entry.mtime && now - new Date(entry.mtime).getTime() > MAX_AGE_MS) {
                log.debug(`[YjsSyncCoordinator] Expiring stale pending entry for ${entry.fileId}`);
                await this._pendingStore.removePending(entry.fileId);
                continue;
            }

            // If the room is already connected in this tab's runtime, the runtime's
            // reconnect already pushed the changes. Clean up the pending entry.
            const activeDoc = this._runtime?.activeDocs.get(entry.fileId);
            if (activeDoc?.provider?.wsconnected) {
                await this._pendingStore.removePending(entry.fileId);
                continue;
            }

            try {
                await this._syncRoom(entry.fileId, entry.roomId, entry.wsUrl, entry);
                await this._pendingStore.removePending(entry.fileId);
                this._channel?.postMessage({ type: 'synced', fileId: entry.fileId });
                log.debug(`[YjsSyncCoordinator] Synced room ${entry.roomId}`);
            } catch (err) {
                console.warn(`[YjsSyncCoordinator] Failed to sync ${entry.fileId}: ${err.message}`);
                // Leave in queue for next poll
            }
        }

        await this._processTouchQueue();
    }

    /**
     * Open a temporary Yjs connection to flush IndexedDB offline edits to the server.
     * Safe to call concurrently with other connections to the same room (CRDT merge).
     * @param {string} fileId @param {string} roomId @param {string} wsUrl
     * @param {{appType?: string|null}} [entry] - pending store entry (for appType)
     */
    async _syncRoom(fileId, roomId, wsUrl, entry = null) {
        const doc = new Y.Doc();
        const persistence = new IndexeddbPersistence(roomId, doc);

        // Load local IndexedDB state first
        await new Promise(resolve => {
            if (persistence.synced) { resolve(); return; }
            const t = setTimeout(resolve, PERSISTENCE_TIMEOUT);
            persistence.once('synced', () => { clearTimeout(t); resolve(); });
        });

        // Connect WebSocket and wait for bidirectional sync
        const wsParams = {};
        const apiKey = this._getApiKey?.();
        if (apiKey) wsParams['auth'] = apiKey;
        wsParams['fileId'] = fileId; // needed for server-side file_meta + snapshot attribution
        if (entry?.appType) wsParams['appType'] = entry.appType;
        const provider = new WebsocketProvider(wsUrl, roomId, doc, { params: wsParams });
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(
                    () => reject(new Error(`Sync timeout for room ${roomId}`)),
                    WS_SYNC_TIMEOUT
                );
                provider.once('sync', isSynced => {
                    clearTimeout(t);
                    isSynced ? resolve() : reject(new Error(`Sync failed for room ${roomId}`));
                });
            });
        } finally {
            provider.disconnect();
            provider.destroy();
            persistence.destroy();
            doc.destroy();
        }
    }

    // -------------------------------------------------------
    // Touch queue (server updatedAt)
    // -------------------------------------------------------

    async _processTouchQueue() {
        if (!this._api) return;
        const queue = await this._pendingStore.getAllTouchQueue();
        for (const entry of queue) {
            if (!this._isOnline()) break;
            try {
                await this._api.touchFile(entry.fileId);
                await this._pendingStore.removeFromTouchQueue(entry.fileId);
            } catch (err) {
                console.warn(`[YjsSyncCoordinator] Touch failed for ${entry.fileId}: ${err.message}`);
            }
        }
    }
}
