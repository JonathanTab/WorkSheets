import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { log } from '../../../util/log.js';

// Message type for the server's file-meta sideband (matches server.js)
const MESSAGE_FILE_META = 2;
// Message type the server sends when a room's roomId has been rotated (snapshot restore).
const MESSAGE_ROOM_ROTATED = 3;

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

        /**
         * Called when the server notifies us that a doc's room has been rotated
         * (snapshot restore). Signature: (docId: string, newRoomId: string) => void.
         */
        this.onRoomRotated = options.onRoomRotated ?? null;

        /** @type {() => string|null} */
        this.getApiKey = options.getApiKey ?? null;
        /** @type {() => {username: string, color: string}|null} */
        this.getUserInfo = options.getUserInfo ?? null;

        /** @type {Map<string, (meta: {last_edit_at: number, last_edit_by: string}) => void>} */
        this._fileMetaHandlers = new Map();
        /** Tracks WS instances we've already attached a fileMeta listener to (avoid duplicates on same instance). */
        this._patchedWs = new WeakSet();

        // Track offline state (based on navigator.onLine — used only for UI labelling)
        this.isOffline = typeof navigator !== 'undefined' ? !navigator.onLine : false;

        // Per-doc WS liveness: true when the provider is connected AND has completed
        // initial sync. More reliable than navigator.onLine for deciding whether edits
        // need to be queued for background flushing.
        /** @type {Map<string, boolean>} */
        this._wsLive = new Map();

        // Set up offline/online listeners
        this._setupNetworkListeners();
    }

    /**
     * Set up listeners for online/offline events to manage WebSocket connections.
     */
    _setupNetworkListeners() {
        if (typeof window === 'undefined') return;

        this._handleOnline = () => {
            log.debug('[YjsRuntime] Network connection restored');
            this.isOffline = false;
            this._reconnectAll();
        };

        this._handleOffline = () => {
            log.debug('[YjsRuntime] Network connection lost');
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
        log.debug('[YjsRuntime] Disconnecting all WebSocket providers due to offline state');
        for (const [docId, active] of this.activeDocs) {
            if (active.provider && active.provider.wsconnected) {
                log.debug(`[YjsRuntime] Disconnecting WebSocket for ${docId}`);
                active.provider.disconnect();
            }
        }
    }

    /**
     * Reconnect all WebSocket providers when coming back online.
     */
    _reconnectAll() {
        log.debug('[YjsRuntime] Reconnecting all WebSocket providers due to online state');
        for (const [docId, active] of this.activeDocs) {
            if (active.provider && !active.provider.wsconnected) {
                log.debug(`[YjsRuntime] Reconnecting WebSocket for ${docId}`);
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
     * @param {string|null} [appType] - App type ('sheets'|'docs'|'svg') sent to the server
     *   so snapshot diffs are correctly attributed even on fresh rooms.
     * @returns {Promise<import('yjs').Doc>}
     */
    async load(docId, roomId, appType = null) {
        // Check if already loaded
        if (this.activeDocs.has(docId)) {
            const active = this.activeDocs.get(docId);
            // If roomId is the same, return existing. If different, we need to switch (shouldn't happen via loadDoc)
            if (active.provider.roomname === roomId) {
                log.debug(`[YjsRuntime] Document ${docId} already loaded, reusing`);
                return active.ydoc;
            }
            log.debug(`[YjsRuntime] Room ID changed for ${docId}, unloading old`);
            this.unload(docId);
        }

        // Check if load is already in progress - return existing promise to deduplicate
        if (this.loadingDocs.has(docId)) {
            log.debug(`[YjsRuntime] Document ${docId} load already in progress, waiting...`);
            return this.loadingDocs.get(docId);
        }

        // Start a new load
        const loadPromise = this._doLoad(docId, roomId, appType);
        this.loadingDocs.set(docId, loadPromise);

        try {
            return await loadPromise;
        } finally {
            this.loadingDocs.delete(docId);
        }
    }

    /**
     * Internal load implementation
     * @param {string} docId
     * @param {string} roomId
     * @param {string|null} appType
     */
    async _doLoad(docId, roomId, appType = null) {
        log.debug(`[YjsRuntime] Loading document ${docId} (room: ${roomId})...`);
        const startTime = performance.now();

        const ydoc = new Y.Doc();

        // 1. Start IndexedDB persistence
        log.debug(`[YjsRuntime] Initializing IndexedDB persistence for ${roomId}...`);
        const persistence = new IndexeddbPersistence(roomId, ydoc);

        // 2. Start WebSocket in parallel with IndexedDB — on slow devices (e.g. mobile Safari)
        //    IndexedDB can take seconds to sync. Starting the WebSocket immediately means
        //    we can resolve as soon as either source delivers data.
        log.debug(`[YjsRuntime] Connecting WebSocket for ${roomId}...`);
        /** @type {Record<string, string>} */
        const wsParams = {};
        const apiKey = this.getApiKey?.();
        if (apiKey) wsParams['auth'] = apiKey;
        wsParams['fileId'] = docId; // server uses this to group snapshots by file
        if (appType) wsParams['appType'] = appType;

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

        // Track WS liveness (connected + synced) so callsites can distinguish a
        // dead connection from a genuine offline state, even when navigator.onLine lies.
        this._wsLive.set(docId, false);
        provider.on('status', ({ status }) => {
            if (status !== 'connected') this._wsLive.set(docId, false);
        });
        provider.on('sync', (synced) => {
            this._wsLive.set(docId, synced && provider.wsconnected);
        });

        // Watchdog: if no message has arrived for >45 s while the socket appears
        // connected, force a reconnect. Recovers from half-open sockets (NAT timeout,
        // laptop sleep/resume, proxy half-close) that the server-side 30 s ping misses
        // because the server closes its side — the browser side may stay OPEN.
        const WATCHDOG_INTERVAL_MS = 20_000;
        const WATCHDOG_STALE_MS = 45_000;
        const watchdogInterval = setInterval(() => {
            const active = this.activeDocs.get(docId);
            if (!active) { clearInterval(watchdogInterval); return; }
            if (!provider.wsconnected) return;
            const lastMsg = provider.wsLastMessageReceived;
            if (lastMsg != null && Date.now() - lastMsg > WATCHDOG_STALE_MS) {
                console.warn(`[YjsRuntime] Watchdog: stale connection for ${docId}, forcing reconnect`);
                this._wsLive.set(docId, false);
                provider.disconnect();
                provider.connect();
            }
        }, WATCHDOG_INTERVAL_MS);
        // Store the interval handle so unload() can clear it.
        const existingActive = this.activeDocs.get(docId);
        if (existingActive) existingActive._watchdog = watchdogInterval;

        // Intercept file-meta sideband messages (type 2/3) from the server.
        this._setupFileMetaListener(docId, provider);

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

        // 3. Wait for IndexedDB OR WebSocket to deliver data, whichever is first.
        await new Promise((resolve) => {
            if (persistence.synced) {
                log.debug(`[YjsRuntime] Persistence already synced for ${roomId}`);
                resolve();
                return;
            }

            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                resolve();
            };

            const timeout = setTimeout(() => {
                console.warn(`[YjsRuntime] Persistence sync timeout for ${roomId}, proceeding anyway`);
                done();
            }, PERSISTENCE_TIMEOUT);

            persistence.once('synced', () => {
                log.debug(`[YjsRuntime] Persistence synced for ${roomId}`);
                done();
            });

            // Resolve early if WebSocket delivers server state first (speeds up slow-IndexedDB devices)
            if (navigator.onLine) {
                provider.once('sync', () => {
                    log.debug(`[YjsRuntime] WebSocket synced before persistence for ${roomId}`);
                    done();
                });
            }
        });

        // 4. If no data arrived from either source yet, wait for WebSocket.
        //
        // Why: if the caller initializes the doc structure on an empty doc and
        // the server's state arrives moments later, CRDT conflict resolution may
        // displace the client-created structures, leaving the UI watching orphaned
        // objects and showing a blank document until reload.
        //
        // WebSocket is already connecting (started above), so this wait is shorter
        // than in the old sequential flow.
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

        log.debug(`[YjsRuntime] Document ${docId} loaded in ${Math.round(performance.now() - startTime)}ms`);

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
     * Wait for the WebSocket provider to complete its initial sync with the
     * server for `docId`. Resolves immediately if already synced, or after
     * `timeoutMs` if the sync doesn't arrive (e.g. offline).
     *
     * Returns `true` if server sync was confirmed, `false` if we timed out
     * or are offline / the doc isn't loaded.
     *
     * @param {string} docId
     * @param {number} [timeoutMs]
     * @returns {Promise<boolean>}
     */
    async waitForServerSync(docId, timeoutMs = WS_SYNC_TIMEOUT) {
        const active = this.activeDocs.get(docId);
        if (!active?.provider) return false;
        if (active.provider.synced) return true;
        if (typeof navigator !== 'undefined' && !navigator.onLine) return false;

        return await new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(ok);
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            active.provider.once('sync', () => finish(true));
        });
    }

    /**
     * Unloads a document, destroying its providers and Y.Doc instance to free memory.
     *
     * @param {string} docId
     */
    unload(docId) {
        const active = this.activeDocs.get(docId);
        if (active) {
            if (active._watchdog != null) clearInterval(active._watchdog);
            active.provider.disconnect();
            active.provider.destroy();
            active.persistence.destroy();
            active.ydoc.destroy();
            this.activeDocs.delete(docId);
            this._wsLive.delete(docId);
        }
    }

    /**
     * Subscribe to file-meta sideband messages the Yjs server pushes on connect
     * and after each debounced edit. The callback receives { last_edit_at, last_edit_by }.
     * @param {string} docId
     * @param {(meta: {last_edit_at: number, last_edit_by: string}) => void} callback
     * @returns {() => void} unsubscribe
     */
    subscribeFileMeta(docId, callback) {
        this._fileMetaHandlers.set(docId, callback);
        return () => this._fileMetaHandlers.delete(docId);
    }

    /**
     * Attach a raw WebSocket message listener to intercept type-2 (fileMeta) messages.
     * Uses a WeakSet so we never double-attach to the same WS instance, and re-attaches
     * on reconnect via the provider's 'status' event.
     * @param {string} docId
     * @param {WebsocketProvider} provider
     */
    _setupFileMetaListener(docId, provider) {
        const attach = (ws) => {
            if (!ws || this._patchedWs.has(ws)) return;
            this._patchedWs.add(ws);
            ws.addEventListener('message', (event) => {
                if (!(event.data instanceof ArrayBuffer)) return;
                try {
                    const buf = new Uint8Array(event.data);
                    // Read first varuint (message type).  lib0 varuint: each byte
                    // contributes 7 bits; high bit signals more bytes follow.
                    let pos = 0, type = 0, shift = 0;
                    while (pos < buf.length) {
                        const b = buf[pos++];
                        type |= (b & 0x7f) << shift;
                        if ((b & 0x80) === 0) break;
                        shift += 7;
                    }
                    if (type !== MESSAGE_FILE_META && type !== MESSAGE_ROOM_ROTATED) return;
                    // Read varstring: varuint length, then UTF-8 bytes.
                    let len = 0; shift = 0;
                    while (pos < buf.length) {
                        const b = buf[pos++];
                        len |= (b & 0x7f) << shift;
                        if ((b & 0x80) === 0) break;
                        shift += 7;
                    }
                    const payload = JSON.parse(new TextDecoder().decode(buf.subarray(pos, pos + len)));
                    if (type === MESSAGE_FILE_META) {
                        this._fileMetaHandlers.get(docId)?.(payload);
                    } else if (type === MESSAGE_ROOM_ROTATED && this.onRoomRotated) {
                        const { newRoomId } = payload;
                        if (newRoomId) this.onRoomRotated(docId, newRoomId);
                    }
                } catch { /* ignore malformed or non-fileMeta messages */ }
            });
        };

        // Attach to the WS that was created at provider construction time.
        attach(provider.ws);

        // Re-attach each time the provider reconnects (new WS instance each time).
        provider.on('status', ({ status }) => {
            if (status === 'connected') attach(provider.ws);
        });
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
     * Returns true if the WebSocket for docId is currently connected AND has
     * completed initial sync. More reliable than navigator.onLine for deciding
     * whether local edits need offline-queue treatment.
     * @param {string} docId
     * @returns {boolean}
     */
    isLive(docId) {
        return this._wsLive.get(docId) ?? false;
    }

    /**
     * Returns true if at least one active doc has a live WebSocket connection.
     * Used by the sync coordinator as a more reliable alternative to navigator.onLine.
     * @returns {boolean}
     */
    isAnyLive() {
        for (const live of this._wsLive.values()) {
            if (live) return true;
        }
        return false;
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
        log.debug(`[YjsRuntime] Initializing document ${docId} (room: ${roomId})...`);

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
                    log.debug(`[YjsRuntime] Initialization synced for ${roomId}`);
                    resolve();
                });
            });
        }

        log.debug(`[YjsRuntime] Document ${docId} initialized`);
        return ydoc;
    }
}
