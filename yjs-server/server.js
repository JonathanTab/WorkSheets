#!/usr/bin/env node
/**
 * Congruum Yjs WebSocket Server
 *
 * WebSocket URL: ws://server:PORT/{roomId}?auth={token}&fileId={fileId}
 * HTTP API base: http://server:PORT/api/
 */

// ---------------------------------------------------------------------------
// Bootstrap — load .env if present (optional)
// ---------------------------------------------------------------------------
try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    require('dotenv').config();
} catch { /* dotenv is optional */ }

import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import { createHash } from 'crypto';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as map from 'lib0/map';

import { validateToken } from './auth.js';
import {
    initDb,
    bindDocState,
    writeDocState,
    saveSnapshot,
    listSnapshotsByRoom,
    listSnapshotsByFile,
    getSnapshotData,
    getSnapshotDiff,
    getSnapshotMeta,
    getDocStateUpdate,
    prepareRestore,
    getSqliteDb,
    updateFileLastEdit,
    getFileLastEdit,
    backfillAllDiffs,
    setSnapshotPinned,
    updateSnapshotDescription,
    deleteSnapshot,
    getDocDiskSize,
    getAllPersistedDocNames,
    PERSISTENCE_ORIGIN,
} from './db.js';
import { SnapshotScheduler } from './snapshot-scheduler.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? '4444');
const HOST = process.env.HOST ?? '0.0.0.0';
const LEVELDB_PATH = process.env.LEVELDB_PATH ?? './data/yjs-leveldb';
const SQLITE_PATH = process.env.SQLITE_PATH ?? './data/yjs-snapshots.db';
const GC_ENABLED = process.env.GC !== 'false' && process.env.GC !== '0';

// ---------------------------------------------------------------------------
// Server-wide metrics — process-lifetime counters surfaced via /api/stats.
// Per-room counters live on each WSSharedDoc; these aggregate across the whole
// server and survive room eviction (so totals don't reset when a room closes).
// ---------------------------------------------------------------------------
const serverMetrics = {
    startedAt: Date.now(),
    wireBytesIn: 0,          // total bytes received over all WS connections
    wireBytesOut: 0,         // total bytes sent over all WS connections
    messagesIn: 0,
    messagesOut: 0,
    connectionsOpened: 0,    // cumulative WS connections accepted since boot
    connectionsClosed: 0,    // cumulative WS connections closed since boot
};

// ---------------------------------------------------------------------------
// Initialise DB + scheduler
// ---------------------------------------------------------------------------
initDb(LEVELDB_PATH, SQLITE_PATH);
const scheduler = new SnapshotScheduler(saveSnapshot, getSqliteDb());

// Diffs are now computed synchronously at snapshot-save time.
// Use POST /api/backfill-diffs to recompute legacy snapshots on demand.

// ---------------------------------------------------------------------------
// Message type constants (y-protocols)
// ---------------------------------------------------------------------------
const messageSync = 0;
const messageAwareness = 1;
const messageFileMeta = 2;    // sideband: { last_edit_at, last_edit_by }
const messageRoomRotated = 3; // sideband: { newRoomId } — sent on snapshot restore

// ---------------------------------------------------------------------------
// WSSharedDoc — mirrors the reference utils.js WSSharedDoc exactly,
// extended with fileId and connUsers for our snapshot/auth features.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// File-meta sideband helpers
// ---------------------------------------------------------------------------

/** Encode a fileMeta message. */
const _encodeFileMeta = (meta) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageFileMeta);
    encoding.writeVarString(enc, JSON.stringify(meta));
    return encoding.toUint8Array(enc);
};

/** Send file meta to one connection. */
const sendFileMeta = (doc, conn, meta) => send(doc, conn, _encodeFileMeta(meta));

/** Broadcast file meta to all connections in a room. */
const broadcastFileMeta = (doc, meta) => {
    const msg = _encodeFileMeta(meta);
    doc.conns.forEach((_, conn) => send(doc, conn, msg));
};

/** Encode a roomRotated message. */
const _encodeRoomRotated = (newRoomId) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageRoomRotated);
    encoding.writeVarString(enc, JSON.stringify({ newRoomId }));
    return encoding.toUint8Array(enc);
};

/**
 * Broadcast a room-rotated notification to every client connected to any room
 * associated with the given fileId. Called after a snapshot restore so all
 * currently-open tabs switch to the new room without needing a page reload.
 */
const broadcastRoomRotated = (fileId, newRoomId) => {
    const msg = _encodeRoomRotated(newRoomId);
    for (const doc of docs.values()) {
        if (doc.fileId === fileId) {
            doc.conns.forEach((_, conn) => send(doc, conn, msg));
        }
    }
};

// Per-room debounce state for last-edit
const lastEditWritten   = new Map(); // fileId → last DB-write timestamp
const lastEditBroadcast = new Map(); // fileId → last WS-broadcast timestamp
const lastKnownFileMeta = new Map(); // fileId → { last_edit_at, last_edit_by } (in-memory, for on-connect send)
const LAST_EDIT_DEBOUNCE_MS   = 10_000; // DB write cooldown
const LAST_EDIT_BROADCAST_MS  =  2_000; // WS broadcast cooldown

// ---------------------------------------------------------------------------
// updateHandler
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} update
 * @param {any} origin
 * @param {WSSharedDoc} doc
 * @param {any} _tr
 */
const updateHandler = (update, origin, doc, _tr) => {
    // Broadcast the Yjs update to all peers.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    doc.conns.forEach((_, conn) => send(doc, conn, message));
    scheduler.markDirty(doc.name, doc.fileId, doc, update.byteLength);

    // Skip persistence-load origin (fires when a room first opens from LevelDB).
    if (!doc.fileId || origin === null || origin === PERSISTENCE_ORIGIN) return;

    // Attribute to the specific connection that sent this update; fall back to
    // any connected user if origin isn't a tracked conn (shouldn't normally happen).
    const username = doc.connUsers.get(origin)
        ?? (doc.connUsers.size > 0 ? [...doc.connUsers.values()].find(Boolean) : null)
        ?? null;
    if (!username) return;

    // Track this user as a contributor to the current session.
    scheduler.markUserActivity(doc.name, username);

    const now = Date.now();

    // Sideband broadcast (2 s debounce) — pushed to ALL connected clients so
    // every open tab sees the attribution update in near-real-time.
    const lastBcast = lastEditBroadcast.get(doc.fileId) ?? 0;
    if (now - lastBcast >= LAST_EDIT_BROADCAST_MS) {
        lastEditBroadcast.set(doc.fileId, now);
        const meta = { last_edit_at: now, last_edit_by: username };
        lastKnownFileMeta.set(doc.fileId, meta);
        broadcastFileMeta(doc, meta);
    }

    // DB write (10 s debounce) — persists across room eviction / server restart.
    const lastWritten = lastEditWritten.get(doc.fileId) ?? 0;
    if (now - lastWritten >= LAST_EDIT_DEBOUNCE_MS) {
        lastEditWritten.set(doc.fileId, now);
        try { updateFileLastEdit(doc.fileId, username, now); } catch { /* ignore */ }
    }
};

class WSSharedDoc extends Y.Doc {
    /**
     * @param {string} name
     * @param {string|null} fileId
     * @param {string|null} appType
     */
    constructor(name, fileId, appType) {
        super({ gc: GC_ENABLED });
        this.name = name;
        this.fileId = fileId;
        this.appType = appType;

        // Live per-room metrics (surfaced via /api/stats and /api/room/:id/stats).
        this.createdAt = Date.now();
        this.lastActivityAt = Date.now(); // last inbound message timestamp
        this.wireBytesIn = 0;             // bytes received over WS for this room
        this.wireBytesOut = 0;            // bytes sent over WS for this room
        this.messagesIn = 0;
        this.messagesOut = 0;
        this.connectionsOpened = 0;       // cumulative connections for this room since it loaded

        /** @type {Map<WebSocket, Set<number>>} conn → clientID set */
        this.conns = new Map();
        /** @type {Map<WebSocket, string>} conn → username */
        this.connUsers = new Map();

        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null);

        /**
         * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
         * @param {Object|null} conn
         */
        const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
            const changedClients = added.concat(updated, removed);
            if (conn !== null) {
                const connControlledIDs = this.conns.get(conn);
                if (connControlledIDs !== undefined) {
                    added.forEach(clientID => { connControlledIDs.add(clientID); });
                    removed.forEach(clientID => { connControlledIDs.delete(clientID); });
                }
            }
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(
                encoder,
                awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
            );
            const buff = encoding.toUint8Array(encoder);
            this.conns.forEach((_, c) => send(this, c, buff));
        };

        this.awareness.on('update', awarenessChangeHandler);
        this.on('update', /** @type {any} */(updateHandler));
    }

    /** @returns {string[]} unique usernames currently connected */
    getActiveUsers() {
        return [...new Set(this.connUsers.values())].filter(Boolean);
    }
}

// ---------------------------------------------------------------------------
// Document registry — synchronous, matching reference getYDoc pattern
// ---------------------------------------------------------------------------

/** @type {Map<string, WSSharedDoc>} */
const docs = new Map();

/**
 * Tracks rooms that are currently being evicted (last client disconnected;
 * writeDocState + destroy in progress). A new connection arriving for the same
 * room name awaits this promise before creating a fresh doc, preventing a race
 * where the new doc loads stale LevelDB state that the eviction flush hasn't
 * written yet.
 * @type {Map<string, Promise<void>>}
 */
const evicting = new Map();

/**
 * Get or create a doc. Synchronous — bindDocState loads state in background.
 * @param {string} name
 * @param {string|null} fileId
 * @param {string|null} appType
 * @returns {WSSharedDoc}
 */
const getDoc = async (name, fileId, appType) => {
    // If a previous connection's eviction (writeDocState + destroy) is still in
    // flight for this room, wait for it to complete before creating a fresh doc.
    // Without this, the new doc's bindDocState could load stale LevelDB state
    // that the eviction flush hasn't written yet.
    const pendingEvict = evicting.get(name);
    if (pendingEvict) await pendingEvict;

    return map.setIfUndefined(docs, name, () => {
        const doc = new WSSharedDoc(name, fileId, appType);
        // doc.ready resolves once historical state has been applied from LevelDB.
        // setupWSConnection awaits this before sending Sync Step 1 so new clients
        // never receive an empty state vector for a room that has persisted state.
        doc.ready = bindDocState(name, doc);
        return doc;
    });
};

// ---------------------------------------------------------------------------
// Connection helpers — mirrors reference closeConn and send exactly
// ---------------------------------------------------------------------------

/**
 * @param {WSSharedDoc} doc
 * @param {WebSocket} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
    if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
        closeConn(doc, conn);
        return;
    }
    try {
        conn.send(m, {}, err => { if (err != null) closeConn(doc, conn); });
        doc.wireBytesOut += m.byteLength;
        doc.messagesOut++;
        serverMetrics.wireBytesOut += m.byteLength;
        serverMetrics.messagesOut++;
    } catch {
        closeConn(doc, conn);
    }
};

/**
 * @param {WSSharedDoc} doc
 * @param {WebSocket} conn
 */
const closeConn = (doc, conn) => {
    if (!doc.conns.has(conn)) return;

    serverMetrics.connectionsClosed++;

    const controlledIds = doc.conns.get(conn);
    const username = doc.connUsers.get(conn);
    const activeUsers = doc.getActiveUsers();

    doc.conns.delete(conn);
    doc.connUsers.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);

    // Notify scheduler of updated user count (for collaborative session handling)
    if (doc.conns.size > 0) {
        scheduler.updateUserCount(doc.name, doc.conns.size);
    }

    if (doc.conns.size === 0) {
        scheduler.onRoomEmpty(doc.name, doc.fileId, doc, activeUsers);
        docs.delete(doc.name);
        scheduler.cleanup(doc.name);
        // Release per-file in-memory debounce state when the room closes.
        // The canonical data is in SQLite; on-connect we re-read from there.
        if (doc.fileId) {
            lastEditWritten.delete(doc.fileId);
            lastEditBroadcast.delete(doc.fileId);
            lastKnownFileMeta.delete(doc.fileId);
        }
        // Register an eviction promise so any reconnect that arrives before the
        // flush completes will wait rather than loading a stale LevelDB snapshot.
        const evictionDone = writeDocState(doc.name, doc).then(() => {
            doc.destroy();
        }).catch((err) => {
            console.error(`[room] writeDocState failed for ${doc.name}:`, err?.message);
            doc.destroy();
        }).finally(() => {
            evicting.delete(doc.name);
        });
        evicting.set(doc.name, evictionDone);
        console.log(`[room] ${doc.name} closed (last user: ${username})`);
    }

    conn.close();
};

// ---------------------------------------------------------------------------
// setupWSConnection — mirrors reference setupWSConnection exactly
// ---------------------------------------------------------------------------

/**
 * @param {WebSocket} conn
 * @param {string} name
 * @param {string|null} fileId
 * @param {string} username
 * @param {string|null} appType
 */
const setupWSConnection = async (conn, name, fileId, username, appType) => {
    conn.binaryType = 'arraybuffer';

    // Buffer messages that arrive before LevelDB state has loaded. The client
    // sends its SyncStep1 immediately on socket open; if we attached the
    // message handler only after `await doc.ready`, that first message would
    // be dropped by the ws EventEmitter (no listener attached yet), the
    // server would never reply with SyncStep2, and the client would wait the
    // full WS_SYNC_TIMEOUT before giving up. This deterministically affects
    // cold docs (those not already in memory) where bindDocState takes more
    // than ~0 ms — the slow-doc symptom users hit.
    /** @type {ArrayBuffer[]} */
    const pendingMessages = [];
    let docReady = false;
    /** @type {WSSharedDoc | null} */
    let docRef = null;

    const handleMessage = (/** @type {ArrayBuffer} */ message) => {
        // Account inbound traffic before processing (covers both live and
        // drained-from-buffer messages). message is an ArrayBuffer here.
        const inBytes = message.byteLength ?? 0;
        serverMetrics.wireBytesIn += inBytes;
        serverMetrics.messagesIn++;
        if (docRef) {
            docRef.wireBytesIn += inBytes;
            docRef.messagesIn++;
            docRef.lastActivityAt = Date.now();
        }
        try {
            const encoder = encoding.createEncoder();
            const decoder = decoding.createDecoder(new Uint8Array(message));
            const messageType = decoding.readVarUint(decoder);
            switch (messageType) {
                case messageSync:
                    encoding.writeVarUint(encoder, messageSync);
                    syncProtocol.readSyncMessage(decoder, encoder, docRef, conn);
                    if (encoding.length(encoder) > 1) {
                        send(docRef, conn, encoding.toUint8Array(encoder));
                    }
                    break;
                case messageAwareness:
                    awarenessProtocol.applyAwarenessUpdate(
                        docRef.awareness,
                        decoding.readVarUint8Array(decoder),
                        conn
                    );
                    break;
            }
        } catch (err) {
            console.error('[ws] Message error:', err.message);
            docRef?.emit('error', [err]);
        }
    };

    conn.on('message', (message) => {
        if (!docReady) { pendingMessages.push(message); return; }
        handleMessage(message);
    });

    const doc = await getDoc(name, fileId, appType);
    docRef = doc;
    doc.conns.set(conn, new Set());
    doc.connUsers.set(conn, username);

    // Connection accounting (cumulative; current count is doc.conns.size).
    doc.connectionsOpened++;
    serverMetrics.connectionsOpened++;

    console.log(`[room] ${username} joined ${name} (${doc.conns.size} users)`);

    // Notify scheduler of user count for collaborative session handling
    scheduler.updateUserCount(name, doc.conns.size);

    // Wait for LevelDB state to load before sending Sync Step 1.
    // Without this, a freshly-created room sends an empty state vector even
    // when it has persisted state, causing the client to unnecessarily resend
    // its full state rather than just the missing diff.
    await doc.ready;

    // Guard: the connection may have been closed while we were awaiting LevelDB.
    if (!doc.conns.has(conn)) return;

    docReady = true;
    // Drain any messages that arrived during getDoc/doc.ready. These include
    // the client's initial SyncStep1; processing it now (before we send our
    // own SyncStep1 below) means our reply travels in the same network burst.
    while (pendingMessages.length > 0) {
        handleMessage(pendingMessages.shift());
    }

    // Ping/pong keepalive — matches reference pingTimeout = 30000
    let pongReceived = true;
    const pingInterval = setInterval(() => {
        if (!pongReceived) {
            if (doc.conns.has(conn)) closeConn(doc, conn);
            clearInterval(pingInterval);
        } else if (doc.conns.has(conn)) {
            pongReceived = false;
            try { conn.ping(); } catch { closeConn(doc, conn); clearInterval(pingInterval); }
        }
    }, 30000);

    conn.on('close', () => { closeConn(doc, conn); clearInterval(pingInterval); });
    conn.on('pong', () => { pongReceived = true; });
    conn.on('error', err => {
        console.error('[ws] Connection error:', err.message);
        closeConn(doc, conn);
        clearInterval(pingInterval);
    });

    // Send sync step 1 + current awareness states
    {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeSyncStep1(encoder, doc);
        send(doc, conn, encoding.toUint8Array(encoder));

        const awarenessStates = doc.awareness.getStates();
        if (awarenessStates.size > 0) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(
                encoder,
                awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys()))
            );
            send(doc, conn, encoding.toUint8Array(encoder));
        }
    }

    // Send current file meta sideband so the connecting client immediately
    // knows the last editor without a separate REST round-trip.
    // Prefer in-memory (may be more recent than the 10 s debounced DB write).
    if (fileId) {
        const meta = lastKnownFileMeta.get(fileId) ?? getFileLastEdit(fileId);
        if (meta?.last_edit_at) sendFileMeta(doc, conn, meta);
    }
};

// ---------------------------------------------------------------------------
// HTTP server + REST API
// ---------------------------------------------------------------------------
const MAX_WS_PAYLOAD  = parseInt(process.env.MAX_WS_PAYLOAD  ?? String(10 * 1024 * 1024)); // 10 MB
const MAX_HTTP_BODY   = parseInt(process.env.MAX_HTTP_BODY   ?? String(1  * 1024 * 1024)); // 1 MB

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // Echo the request origin (instead of '*') when present so credentialed
    // requests (cookie auth for the snapshot fast-path) are allowed by the
    // browser. Falls back to '*' for non-browser / no-Origin callers.
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    handleHttp(req, res, url).catch(err => {
        console.error('[http] Unhandled error:', err);
        _json(res, 500, { error: 'Internal server error' });
    });
});

function _json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function _readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalSize = 0;
        req.on('data', c => {
            totalSize += c.length;
            if (totalSize > MAX_HTTP_BODY) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
            catch { resolve({}); }
        });
        req.on('error', reject);
    });
}

function _getToken(req, url) {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
    const queryToken = url.searchParams.get('auth');
    if (queryToken) return queryToken;
    // Cookie fallback (mirrors the WS upgrade path) so browser clients on the
    // same origin can call the HTTP API with their session cookie.
    const cookie = req.headers.cookie;
    if (cookie) {
        const m = cookie.match(/session_token=([a-f0-9]{64})/i);
        if (m) return m[1];
    }
    return null;
}

/**
 * Build a live metrics summary for a single in-memory room.
 * `stateSize` is the current in-memory logical size (encoded update bytes);
 * for the persisted on-disk size use getDocDiskSize via the room-detail endpoint.
 * @param {WSSharedDoc} doc
 */
function _roomSummary(doc) {
    const users = doc.getActiveUsers();
    return {
        roomId:            doc.name,
        fileId:            doc.fileId,
        appType:           doc.appType,
        connections:       doc.conns.size,
        users,
        userCount:         users.length,
        awarenessStates:   doc.awareness.getStates().size,
        stateSize:         Y.encodeStateAsUpdate(doc).byteLength,
        wireBytesIn:       doc.wireBytesIn,
        wireBytesOut:      doc.wireBytesOut,
        messagesIn:        doc.messagesIn,
        messagesOut:       doc.messagesOut,
        connectionsOpened: doc.connectionsOpened,
        createdAt:         doc.createdAt,
        lastActivityAt:    doc.lastActivityAt,
    };
}

async function handleHttp(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health' || pathname === '/api/health') {
        let totalConnections = 0;
        for (const doc of docs.values()) totalConnections += doc.conns.size;
        return _json(res, 200, { ok: true, activeDocs: docs.size, totalConnections });
    }

    if (pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('Congruum Yjs Server');
    }

    if (!pathname.startsWith('/api/')) {
        res.writeHead(404);
        return res.end('Not found');
    }

    const token = _getToken(req, url);
    const auth = validateToken(token);
    if (!auth) return _json(res, 401, { error: 'Unauthorized' });

    // GET /api/stats — server-wide metrics + per-room live summaries.
    // Surfaces total connection count, over-the-wire byte totals, active rooms,
    // and on-disk document count for the admin inspector.
    if (pathname === '/api/stats' && req.method === 'GET') {
        const rooms = [...docs.values()].map(_roomSummary);

        let totalConnections = 0;
        const userSet = new Set();
        for (const doc of docs.values()) {
            totalConnections += doc.conns.size;
            for (const u of doc.getActiveUsers()) userSet.add(u);
        }

        let onDiskDocCount = null;
        try { onDiskDocCount = (await getAllPersistedDocNames()).length; }
        catch (err) { console.warn('[stats] getAllPersistedDocNames failed:', err?.message); }

        return _json(res, 200, {
            server: {
                startedAt:         serverMetrics.startedAt,
                uptimeMs:          Date.now() - serverMetrics.startedAt,
                activeRooms:       docs.size,
                totalConnections,
                uniqueUsers:       userSet.size,
                wireBytesIn:       serverMetrics.wireBytesIn,
                wireBytesOut:      serverMetrics.wireBytesOut,
                messagesIn:        serverMetrics.messagesIn,
                messagesOut:       serverMetrics.messagesOut,
                connectionsOpened: serverMetrics.connectionsOpened,
                connectionsClosed: serverMetrics.connectionsClosed,
                onDiskDocCount,
                gcEnabled:         GC_ENABLED,
            },
            rooms,
        });
    }

    // GET /api/room/:roomId/stats — per-document detail incl. persisted on-disk size.
    // Works even when the room is not currently loaded (onDiskSize is read from LevelDB).
    const roomStatsMatch = pathname.match(/^\/api\/room\/([^/]+)\/stats$/);
    if (roomStatsMatch && req.method === 'GET') {
        const roomId = decodeURIComponent(roomStatsMatch[1]);
        const doc = docs.get(roomId);

        let onDiskSize = null;
        try { onDiskSize = await getDocDiskSize(roomId); }
        catch (err) { console.warn(`[stats] getDocDiskSize failed for ${roomId}:`, err?.message); }

        return _json(res, 200, {
            roomId,
            loaded:     !!doc,
            onDiskSize,
            live:       doc ? _roomSummary(doc) : null,
            scheduler:  scheduler.getStats(roomId),
        });
    }

    // GET /api/doc/:roomId/state — generic Yjs binary state for the client load
    // fast-path. App-agnostic (raw CRDT state, no schema awareness — works for
    // sheets/docs/svg alike). Prefers (1) the live in-memory doc, (2) the latest
    // precomputed snapshot BLOB for this room (no doc construction), (3) LevelDB.
    const docStateMatch = pathname.match(/^\/api\/doc\/([^/]+)\/state$/);
    if (docStateMatch && req.method === 'GET') {
        const roomId = decodeURIComponent(docStateMatch[1]);
        let bytes = null;

        const live = docs.get(roomId);
        if (live) {
            try { await live.ready; } catch { /* ignore */ }
            bytes = Y.encodeStateAsUpdate(live);
        } else {
            // Latest precomputed snapshot — a raw BLOB read, no Y.Doc construction.
            // Slightly stale is fine: the client's WebSocket sync reconciles the
            // delta after this head-start is applied.
            const snaps = listSnapshotsByRoom(roomId);
            if (snaps.length > 0) {
                const data = getSnapshotData(snaps[0].id);
                if (data) bytes = data; // Buffer is a Uint8Array
            }
            // Fallback: reconstruct from LevelDB.
            if (!bytes) bytes = await getDocStateUpdate(roomId);
        }

        if (!bytes || bytes.byteLength === 0) return _json(res, 404, { error: 'No state for room' });

        const buf = Buffer.from(bytes);
        const etag = 'W/"' + createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'private, max-age=5' });
            return res.end();
        }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'private, max-age=5',
            'ETag': etag,
        });
        return res.end(buf);
    }

    // GET /api/snapshots?roomId=X  or  ?fileId=X
    if (pathname === '/api/snapshots' && req.method === 'GET') {
        const roomId = url.searchParams.get('roomId');
        const fileId = url.searchParams.get('fileId');
        if (!roomId && !fileId) return _json(res, 400, { error: 'roomId or fileId required' });
        const snapshots = roomId ? listSnapshotsByRoom(roomId) : listSnapshotsByFile(fileId);
        return _json(res, 200, { snapshots });
    }

    // POST /api/snapshots { roomId, description?, appType?, schemaVersion? }
    if (pathname === '/api/snapshots' && req.method === 'POST') {
        const body = await _readBody(req);
        const { roomId, description, appType, schemaVersion } = body;
        if (!roomId) return _json(res, 400, { error: 'roomId required' });
        const doc = docs.get(roomId);
        if (!doc) return _json(res, 404, { error: 'Room not active (no connected clients)' });
        // appType from body (PHP-provided) takes precedence over doc's stored value
        const resolvedAppType = appType ?? doc.appType ?? null;
        if (resolvedAppType && !doc.appType) doc.appType = resolvedAppType;
        const sv = typeof schemaVersion === 'number' ? schemaVersion
                 : typeof schemaVersion === 'string' && /^\d+$/.test(schemaVersion) ? parseInt(schemaVersion)
                 : null;
        const id = await saveSnapshot(roomId, doc.fileId, doc, 'manual', auth.username, null, description ?? null, resolvedAppType, sv);
        return _json(res, 200, { id });
    }

    // GET /api/files/:fileId/meta
    const fileMetaMatch = pathname.match(/^\/api\/files\/([^/]+)\/meta$/);
    if (fileMetaMatch && req.method === 'GET') {
        const meta = getFileLastEdit(fileMetaMatch[1]);
        return _json(res, 200, meta ?? { last_edit_at: null, last_edit_by: null });
    }

    // POST /api/backfill-diffs  — recompute diff_json for all snapshots
    // Body: { force?: boolean }  — force=true clears and recomputes everything
    if (pathname === '/api/backfill-diffs' && req.method === 'POST') {
        const body = await _readBody(req);
        backfillAllDiffs(body.force === true);
        return _json(res, 200, { ok: true, message: 'Backfill started in background' });
    }

    // GET /api/snapshot/:id/diff  (diff JSON only — lightweight, no binary)
    const diffMatch = pathname.match(/^\/api\/snapshot\/([^/]+)\/diff$/);
    if (diffMatch && req.method === 'GET') {
        const diffJson = getSnapshotDiff(diffMatch[1]);
        return _json(res, 200, { diff_json: diffJson });
    }

    // GET /api/snapshot/:id/data  (binary)
    const dataMatch = pathname.match(/^\/api\/snapshot\/([^/]+)\/data$/);
    if (dataMatch && req.method === 'GET') {
        const data = getSnapshotData(dataMatch[1]);
        if (!data) return _json(res, 404, { error: 'Snapshot not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(data);
    }

    // POST /api/snapshot/:id/pin  { pinned: boolean }
    const pinMatch = pathname.match(/^\/api\/snapshot\/([^/]+)\/pin$/);
    if (pinMatch && req.method === 'POST') {
        const body = await _readBody(req);
        setSnapshotPinned(pinMatch[1], !!body.pinned);
        return _json(res, 200, { ok: true });
    }

    // PATCH /api/snapshot/:id  { description: string|null }
    const patchMatch = pathname.match(/^\/api\/snapshot\/([^/]+)$/);
    if (patchMatch && req.method === 'PATCH') {
        const body = await _readBody(req);
        updateSnapshotDescription(patchMatch[1], body.description ?? null);
        return _json(res, 200, { ok: true });
    }

    // DELETE /api/snapshot/:id  (manual snapshots only)
    if (patchMatch && req.method === 'DELETE') {
        const deleted = deleteSnapshot(patchMatch[1]);
        if (!deleted) return _json(res, 404, { error: 'Snapshot not found or not manual' });
        return _json(res, 200, { ok: true });
    }

    // GET /api/snapshot/:id  (metadata)
    const metaMatch = pathname.match(/^\/api\/snapshot\/([^/]+)$/);
    if (metaMatch && req.method === 'GET') {
        const meta = getSnapshotMeta(metaMatch[1]);
        if (!meta) return _json(res, 404, { error: 'Snapshot not found' });
        return _json(res, 200, meta);
    }

    // POST /api/restore { snapshotId }
    if (pathname === '/api/restore' && req.method === 'POST') {
        const body = await _readBody(req);
        const { snapshotId } = body;
        if (!snapshotId) return _json(res, 400, { error: 'snapshotId required' });
        const result = await prepareRestore(snapshotId);
        if (!result) return _json(res, 404, { error: 'Snapshot not found' });
        // Notify all clients currently connected to this file's rooms so they
        // switch to the new room without requiring a page reload.
        broadcastRoomRotated(result.fileId, result.newRoomId);
        return _json(res, 200, result);
    }

    return _json(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// WebSocket upgrade — authenticate then hand off to setupWSConnection
// ---------------------------------------------------------------------------
wss.on('connection', (ws, _req, name, fileId, username, appType) => {
    setupWSConnection(ws, name, fileId, username, appType).catch(err => {
        console.error(`[ws] setupWSConnection failed for ${name}:`, err?.message ?? err);
        try { ws.close(1011, 'Internal server error'); } catch { }
    });
});

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const name = url.pathname.slice(1).split('/')[0];
    if (!name) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    let token = url.searchParams.get('auth') ?? null;

    if (!token && req.headers.cookie) {
        const cookieMatch = req.headers.cookie.match(/session_token=([a-f0-9]{64})/i);
        if (cookieMatch) token = cookieMatch[1];
    }

    const auth = validateToken(token);
    if (!auth) {
        console.warn(`[auth] Rejected WS connection to room ${name} (bad token)`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    const fileId = url.searchParams.get('fileId') ?? null;
    const appType = url.searchParams.get('appType') ?? null;
    wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, req, name, fileId, auth.username, appType);
    });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
    console.log(`[server] Congruum Yjs Server listening on ${HOST}:${PORT}`);
    console.log(`[server] LevelDB: ${LEVELDB_PATH}`);
    console.log(`[server] SQLite (snapshots): ${SQLITE_PATH}`);
    console.log(`[server] GC: ${GC_ENABLED}`);
});

process.on('SIGINT', () => {
    console.log('[server] Shutting down...');
    const flushes = [];
    for (const [name, doc] of docs) {
        try {
            const users = doc.getActiveUsers();
            scheduler.onRoomEmpty(name, doc.fileId, doc, users);
            flushes.push(writeDocState(name, doc).catch(() => { }));
        } catch { /* ignore */ }
    }
    Promise.all(flushes).then(() => server.close(() => process.exit(0)));
});
