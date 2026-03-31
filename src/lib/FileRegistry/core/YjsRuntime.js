import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

// Timeout for IndexedDB persistence sync (in milliseconds)
const PERSISTENCE_TIMEOUT = 5000;
// Timeout for initial WebSocket sync (in milliseconds)
// This is the max wait for the server to deliver its document state on first load.
const WS_SYNC_TIMEOUT = 5000;

/**
 * YjsRuntime - Manages the lifecycle of active Y.Doc instances.
 *
 * This class handles the low-level Yjs plumbing:
 * 1. Creating Y.Doc instances.
 * 2. Connecting them to IndexedDB for local persistence (offline-first).
 * 3. Connecting them to WebSocket for synchronization.
 * 4. Cleaning up resources when a document is unloaded.
 * 5. Handling offline/online transitions to manage WebSocket connections.
 */
export class YjsRuntime {
    /**
     * @param {string} wsUrl - The WebSocket server URL.
     * @param {function(string, {offline: boolean}): void} [onDocUpdate] - Called on local doc changes.
     *   docId is the logical file ID; offline indicates whether the edit happened while offline.
     * @param {object} [options]
     * @param {() => string|null} [options.getApiKey] - Returns Bearer token for WebSocket auth.
     * @param {() => {username: string, color: string}|null} [options.getUserInfo] - Returns user info for awareness.
     */
    constructor(wsUrl, onDocUpdate, options = {}) {
        this.wsUrl = wsUrl;
        /** @type {Map<string, {ydoc: Y.Doc, provider: WebsocketProvider, persistence: IndexeddbPersistence}>} */
        this.activeDocs = new Map();
        /** @type {Map<string, Promise<import('yjs').Doc>>} In-progress document loads */
        this.loadingDocs = new Map();

        /** Called whenever a local (non-remote) update arrives on any active doc. */
        this.onDocUpdate = onDocUpdate ?? null;

        /** @type {() => string|null} */
        this.getApiKey = options.getApiKey ?? null;
        /** @type {() => {username: string, color: string}|null} */
        this.getUserInfo = options.getUserInfo ?? null;

        // Track offline state
        this.isOffline = typeof navigator !== 'undefined' ? !navigator.onLine : false;

        // Set up offline/online listeners
        this._setupNetworkListeners();
    }

    /**
     * Set up listeners for online/offline events to manage WebSocket connections.
     */
    _setupNetworkListeners() {
        if (typeof window === 'undefined') return;

        this._handleOnline = () => {
            console.log('[YjsRuntime] Network connection restored');
            this.isOffline = false;
            this._reconnectAll();
        };

        this._handleOffline = () => {
            console.log('[YjsRuntime] Network connection lost');
            this.isOffline = true;
            this._disconnectAll();
        };

        window.addEventListener('online', this._handleOnline);
        window.addEventListener('offline', this._handleOffline);
    }

    /**
     * Disconnect all WebSocket providers when going offline.
     * This prevents constant reconnection attempts.
     */
    _disconnectAll() {
        console.log('[YjsRuntime] Disconnecting all WebSocket providers due to offline state');
        for (const [docId, active] of this.activeDocs) {
            if (active.provider && active.provider.wsconnected) {
                console.log(`[YjsRuntime] Disconnecting WebSocket for ${docId}`);
                active.provider.disconnect();
            }
        }
    }

    /**
     * Reconnect all WebSocket providers when coming back online.
     */
    _reconnectAll() {
        console.log('[YjsRuntime] Reconnecting all WebSocket providers due to online state');
        for (const [docId, active] of this.activeDocs) {
            if (active.provider && !active.provider.wsconnected) {
                console.log(`[YjsRuntime] Reconnecting WebSocket for ${docId}`);
                active.provider.connect();
            }
        }
    }

    /**
     * Loads a Y.Doc and connects its persistence and network providers.
     *
     * This method is deduplicated - if a load is already in progress for the same
     * docId, it will return the existing promise rather than creating duplicate
     * providers.
     *
     * @param {string} docId - The logical document ID.
     * @param {string} roomId - The physical room ID on the Yjs server.
     * @returns {Promise<import('yjs').Doc>}
     */
    async load(docId, roomId) {
        // Check if already loaded
        if (this.activeDocs.has(docId)) {
            const active = this.activeDocs.get(docId);
            // If roomId is the same, return existing. If different, we need to switch (shouldn't happen via loadDoc)
            if (active.provider.roomname === roomId) {
                console.log(`[YjsRuntime] Document ${docId} already loaded, reusing`);
                return active.ydoc;
            }
            console.log(`[YjsRuntime] Room ID changed for ${docId}, unloading old`);
            this.unload(docId);
        }

        // Check if load is already in progress - return existing promise to deduplicate
        if (this.loadingDocs.has(docId)) {
            console.log(`[YjsRuntime] Document ${docId} load already in progress, waiting...`);
            return this.loadingDocs.get(docId);
        }

        // Start a new load
        const loadPromise = this._doLoad(docId, roomId);
        this.loadingDocs.set(docId, loadPromise);

        try {
            return await loadPromise;
        } finally {
            this.loadingDocs.delete(docId);
        }
    }

    /**
     * Internal load implementation
     */
    async _doLoad(docId, roomId) {
        console.log(`[YjsRuntime] Loading document ${docId} (room: ${roomId})...`);
        const startTime = performance.now();

        const ydoc = new Y.Doc();

        // 1. Persistence first (Offline-first)
        console.log(`[YjsRuntime] Initializing IndexedDB persistence for ${roomId}...`);
        const persistence = new IndexeddbPersistence(roomId, ydoc);

        // Wait for persistence to load local data with timeout
        await new Promise((resolve) => {
            if (persistence.synced) {
                console.log(`[YjsRuntime] Persistence already synced for ${roomId}`);
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                console.warn(`[YjsRuntime] Persistence sync timeout for ${roomId}, proceeding anyway`);
                resolve();
            }, PERSISTENCE_TIMEOUT);

            persistence.once('synced', () => {
                clearTimeout(timeout);
                console.log(`[YjsRuntime] Persistence synced for ${roomId}`);
                resolve();
            });
        });

        // 2. WebSocket second
        console.log(`[YjsRuntime] Connecting WebSocket for ${roomId}...`);
        /** @type {Record<string, string>} */
        const wsParams = {};
        const apiKey = this.getApiKey?.();
        if (apiKey) wsParams['auth'] = apiKey;
        wsParams['fileId'] = docId; // server uses this to group snapshots by file

        const provider = new WebsocketProvider(this.wsUrl, roomId, ydoc, {
            params: wsParams,
        });

        // Set local awareness state so remote users can see who is editing
        const userInfo = this.getUserInfo?.();
        if (userInfo && provider.awareness) {
            provider.awareness.setLocalStateField('user', {
                name: userInfo.username,
                color: userInfo.color,
            });
        }

        this.activeDocs.set(docId, { ydoc, provider, persistence });

        // Fire onDocUpdate for local (non-remote) changes so the registry can update
        // the file's updatedAt and queue an offline sync if needed.
        if (this.onDocUpdate) {
            ydoc.on('update', (_update, origin) => {
                const active = this.activeDocs.get(docId);
                const isRemote = active && origin === active.provider;
                if (!isRemote) {
                    this.onDocUpdate(docId, { offline: this.isOffline });
                }
            });
        }

        // 3. If IndexedDB was empty (first time this client opens this doc),
        // wait for the WebSocket to deliver the server's state before returning.
        //
        // Why: if the caller initializes the doc structure on an empty doc and
        // the server's state arrives moments later, CRDT conflict resolution may
        // displace the client-created structures, leaving the UI watching orphaned
        // objects and showing a blank document until reload.
        //
        // If IndexedDB already had data we return immediately — normal
        // offline-first path, no waiting needed.
        const hasLocalData = ydoc.store.clients.size > 0;
        if (!hasLocalData && navigator.onLine) {
            await new Promise((resolve) => {
                if (provider.synced) {
                    resolve();
                    return;
                }
                const timeout = setTimeout(() => {
                    console.warn(`[YjsRuntime] WebSocket sync timeout for ${roomId}, proceeding with empty doc`);
                    resolve();
                }, WS_SYNC_TIMEOUT);
                provider.once('sync', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }

        console.log(`[YjsRuntime] Document ${docId} loaded in ${Math.round(performance.now() - startTime)}ms`);

        return ydoc;
    }

    /**
     * Retrieves an already loaded Y.Doc instance, if any.
     *
     * @param {string} docId
     * @returns {import('yjs').Doc|null}
     */
    get(docId) {
        return this.activeDocs.get(docId)?.ydoc || null;
    }

    /**
     * Unloads a document, destroying its providers and Y.Doc instance to free memory.
     *
     * @param {string} docId
     */
    unload(docId) {
        const active = this.activeDocs.get(docId);
        if (active) {
            active.provider.disconnect();
            active.provider.destroy();
            active.persistence.destroy();
            active.ydoc.destroy();
            this.activeDocs.delete(docId);
        }
    }

    shutdown() {
        // Remove network listeners
        if (typeof window !== 'undefined') {
            if (this._handleOnline) {
                window.removeEventListener('online', this._handleOnline);
            }
            if (this._handleOffline) {
                window.removeEventListener('offline', this._handleOffline);
            }
        }

        for (const docId of this.activeDocs.keys()) {
            this.unload(docId);
        }
    }

    /**
     * @param {string} docId
     * @returns {boolean}
     */
    isConnected(docId) {
        return this.activeDocs.get(docId)?.provider.wsconnected || false;
    }

    /**
     * Returns the Awareness instance for a loaded document, or null.
     * @param {string} docId
     * @returns {object|null}
     */
    getAwareness(docId) {
        return this.activeDocs.get(docId)?.provider?.awareness ?? null;
    }

    /**
     * Clears the IndexedDB data for the current room, then loads the document
     * under a new roomId. Used after a snapshot restore to prevent offline
     * clients contaminating the restored room.
     * @param {string} docId
     * @param {string} newRoomId
     * @returns {Promise<import('yjs').Doc>}
     */
    async clearAndSwitchRoom(docId, newRoomId) {
        const active = this.activeDocs.get(docId);
        if (active) {
            active.provider.disconnect();
            active.provider.destroy();
            try {
                await active.persistence.clearData();
            } catch { /* ignore */ }
            active.persistence.destroy();
            active.ydoc.destroy();
            this.activeDocs.delete(docId);
        }
        return this.load(docId, newRoomId);
    }

    /**
     * Update the user info broadcast via awareness (e.g. after login).
     * @param {string} docId
     */
    refreshAwareness(docId) {
        const active = this.activeDocs.get(docId);
        if (!active?.provider?.awareness) return;
        const userInfo = this.getUserInfo?.();
        if (userInfo) {
            active.provider.awareness.setLocalStateField('user', {
                name: userInfo.username,
                color: userInfo.color,
            });
        }
    }

    /**
     * Explicitly initialize a Yjs document with the provided initializer function.
     * This should be called when creating a new document to ensure the initial
     * structure is set before other clients can load it.
     *
     * @param {string} docId - The logical document ID.
     * @param {string} roomId - The physical room ID on the Yjs server.
     * @param {function(Y.Doc): void} initializer - Function to initialize the document.
     * @returns {Promise<import('yjs').Doc>}
     */
    async initialize(docId, roomId, initializer) {
        console.log(`[YjsRuntime] Initializing document ${docId} (room: ${roomId})...`);

        // Load the document first
        const ydoc = await this.load(docId, roomId);

        // Run the initializer within a transaction
        ydoc.transact(() => {
            initializer(ydoc);
        });

        // Wait for persistence to sync the initial data
        const active = this.activeDocs.get(docId);
        if (active?.persistence) {
            await new Promise((resolve) => {
                // If already synced, resolve immediately
                if (active.persistence.synced) {
                    resolve();
                    return;
                }

                // Wait for sync with timeout
                const timeout = setTimeout(() => {
                    console.warn(`[YjsRuntime] Initialization sync timeout for ${roomId}`);
                    resolve();
                }, PERSISTENCE_TIMEOUT);

                active.persistence.once('synced', () => {
                    clearTimeout(timeout);
                    console.log(`[YjsRuntime] Initialization synced for ${roomId}`);
                    resolve();
                });
            });
        }

        console.log(`[YjsRuntime] Document ${docId} initialized`);
        return ydoc;
    }
}
