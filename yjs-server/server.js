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
    getSnapshotMeta,
    prepareRestore,
    getSqliteDb,
    updateFileLastEdit,
    getFileLastEdit,
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
// Initialise DB + scheduler
// ---------------------------------------------------------------------------
initDb(LEVELDB_PATH, SQLITE_PATH);
const scheduler = new SnapshotScheduler(saveSnapshot, getSqliteDb());

// ---------------------------------------------------------------------------
// Message type constants (y-protocols)
// ---------------------------------------------------------------------------
const messageSync = 0;
const messageAwareness = 1;

// ---------------------------------------------------------------------------
// WSSharedDoc — mirrors the reference utils.js WSSharedDoc exactly,
// extended with fileId and connUsers for our snapshot/auth features.
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} update
 * @param {any} _origin
 * @param {WSSharedDoc} doc
 * @param {any} _tr
 */
const updateHandler = (update, origin, doc, _tr) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    doc.conns.forEach((_, conn) => send(doc, conn, message));
    scheduler.markDirty(doc.name, doc.fileId, doc, update.byteLength);

    // Track last-edit per file, debounced.
    // Skip persistence-load origin (fires when a room first opens from LevelDB).
    if (doc.fileId && origin !== null && origin !== PERSISTENCE_ORIGIN) {
        const now = Date.now();
        const last = lastEditWritten.get(doc.fileId) ?? 0;
        if (now - last >= LAST_EDIT_DEBOUNCE_MS) {
            lastEditWritten.set(doc.fileId, now);
            // Pick any connected user to attribute the edit
            const username = doc.connUsers.size > 0
                ? [...doc.connUsers.values()].find(Boolean) ?? null
                : null;
            if (username) {
                try { updateFileLastEdit(doc.fileId, username, now); } catch { /* ignore */ }
            }
        }
    }
};

// Per-room rate-limiter for last-edit writes (fileId → lastWrittenMs)
const lastEditWritten = new Map();
const LAST_EDIT_DEBOUNCE_MS = 10_000;

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
 * Get or create a doc. Synchronous — bindDocState loads state in background.
 * @param {string} name
 * @param {string|null} fileId
 * @param {string|null} appType
 * @returns {WSSharedDoc}
 */
const getDoc = (name, fileId, appType) => map.setIfUndefined(docs, name, () => {
    const doc = new WSSharedDoc(name, fileId, appType);
    bindDocState(name, doc); // fire-and-forget; state loads in background
    return doc;
});

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
        // Matches reference: writeState then destroy; delete from docs map first.
        scheduler.onRoomEmpty(doc.name, doc.fileId, doc, activeUsers);
        docs.delete(doc.name);
        scheduler.cleanup(doc.name);
        writeDocState(doc.name, doc).then(() => {
            doc.destroy();
        }).catch(() => {
            doc.destroy();
        });
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
const setupWSConnection = (conn, name, fileId, username, appType) => {
    conn.binaryType = 'arraybuffer';
    const doc = getDoc(name, fileId, appType);
    doc.conns.set(conn, new Set());
    doc.connUsers.set(conn, username);

    console.log(`[room] ${username} joined ${name} (${doc.conns.size} users)`);

    // Notify scheduler of user count for collaborative session handling
    scheduler.updateUserCount(name, doc.conns.size);

    conn.on('message', /** @param {ArrayBuffer} message */ message => {
        try {
            const encoder = encoding.createEncoder();
            const decoder = decoding.createDecoder(new Uint8Array(message));
            const messageType = decoding.readVarUint(decoder);
            switch (messageType) {
                case messageSync:
                    encoding.writeVarUint(encoder, messageSync);
                    syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
                    if (encoding.length(encoder) > 1) {
                        send(doc, conn, encoding.toUint8Array(encoder));
                    }
                    break;
                case messageAwareness:
                    awarenessProtocol.applyAwarenessUpdate(
                        doc.awareness,
                        decoding.readVarUint8Array(decoder),
                        conn
                    );
                    break;
            }
        } catch (err) {
            console.error('[ws] Message error:', err.message);
            doc.emit('error', [err]);
        }
    });

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
};

// ---------------------------------------------------------------------------
// HTTP server + REST API
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

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
        req.on('data', c => chunks.push(c));
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
    return url.searchParams.get('auth') ?? null;
}

async function handleHttp(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health' || pathname === '/api/health') {
        return _json(res, 200, { ok: true, activeDocs: docs.size });
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

    // GET /api/snapshots?roomId=X  or  ?fileId=X
    if (pathname === '/api/snapshots' && req.method === 'GET') {
        const roomId = url.searchParams.get('roomId');
        const fileId = url.searchParams.get('fileId');
        if (!roomId && !fileId) return _json(res, 400, { error: 'roomId or fileId required' });
        const snapshots = roomId ? listSnapshotsByRoom(roomId) : listSnapshotsByFile(fileId);
        return _json(res, 200, { snapshots });
    }

    // POST /api/snapshots { roomId, description?, appType? }
    if (pathname === '/api/snapshots' && req.method === 'POST') {
        const body = await _readBody(req);
        const { roomId, description, appType } = body;
        if (!roomId) return _json(res, 400, { error: 'roomId required' });
        const doc = docs.get(roomId);
        if (!doc) return _json(res, 404, { error: 'Room not active (no connected clients)' });
        // appType from body (PHP-provided) takes precedence over doc's stored value
        const resolvedAppType = appType ?? doc.appType ?? null;
        if (resolvedAppType && !doc.appType) doc.appType = resolvedAppType;
        const id = saveSnapshot(roomId, doc.fileId, doc, 'manual', auth.username, null, description ?? null, resolvedAppType);
        return _json(res, 200, { id });
    }

    // GET /api/files/:fileId/meta
    const fileMetaMatch = pathname.match(/^\/api\/files\/([^/]+)\/meta$/);
    if (fileMetaMatch && req.method === 'GET') {
        const meta = getFileLastEdit(fileMetaMatch[1]);
        return _json(res, 200, meta ?? { last_edit_at: null, last_edit_by: null });
    }

    // GET /api/snapshot/:id/data  (binary)
    const dataMatch = pathname.match(/^\/api\/snapshot\/([^/]+)\/data$/);
    if (dataMatch && req.method === 'GET') {
        const data = getSnapshotData(dataMatch[1]);
        if (!data) return _json(res, 404, { error: 'Snapshot not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(data);
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
        return _json(res, 200, result);
    }

    return _json(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// WebSocket upgrade — authenticate then hand off to setupWSConnection
// ---------------------------------------------------------------------------
wss.on('connection', (ws, _req, name, fileId, username, appType) => {
    setupWSConnection(ws, name, fileId, username, appType);
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
