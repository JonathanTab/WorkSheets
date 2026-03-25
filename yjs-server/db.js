import { LeveldbPersistence } from 'y-leveldb';
import Database from 'better-sqlite3';
import * as Y from 'yjs';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';

let levelPersistence;
let sqliteDb;

/** Get the SQLite database instance (for scheduler retention cleanup). */
export function getSqliteDb() {
    return sqliteDb;
}

/**
 * Initialize both y-leveldb for document persistence and SQLite for snapshots.
 * @param {string} levelDbPath
 * @param {string} sqlitePath
 */
export function initDb(levelDbPath, sqlitePath) {
    fs.mkdirSync(path.dirname(path.resolve(levelDbPath)), { recursive: true });
    levelPersistence = new LeveldbPersistence(levelDbPath);

    fs.mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
    sqliteDb = new Database(sqlitePath);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');

    sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
            id          TEXT PRIMARY KEY,
            file_id     TEXT NOT NULL,
            room_id     TEXT NOT NULL,
            state       BLOB NOT NULL,
            created_at  INTEGER NOT NULL,
            trigger     TEXT NOT NULL DEFAULT 'auto',
            created_by  TEXT,
            description TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_snap_file ON snapshots(file_id);
        CREATE INDEX IF NOT EXISTS idx_snap_room  ON snapshots(room_id);
        CREATE INDEX IF NOT EXISTS idx_snap_time  ON snapshots(created_at);
    `);

    return { levelPersistence, sqliteDb };
}

// Sentinel origin used when applying persisted state so the update listener
// does not try to re-store it.
const PERSISTENCE_ORIGIN = Symbol('y-leveldb-persistence');

/**
 * Bind a Y.Doc to leveldb persistence.
 *
 * Matches the reference `persistence.bindState(docName, doc)` contract:
 *   1. Subscribe to future updates and store them incrementally.
 *   2. Load existing state from leveldb and apply to ydoc (fire-and-forget).
 *
 * Using PERSISTENCE_ORIGIN prevents the historical-state apply from
 * triggering another write back to leveldb.
 *
 * @param {string} roomId
 * @param {Y.Doc} ydoc
 */
export function bindDocState(roomId, ydoc) {
    // Step 1 — persist new updates incrementally (register before loading so
    // we never miss an update, even ones that arrive while history is loading).
    ydoc.on('update', (update, origin) => {
        if (origin === PERSISTENCE_ORIGIN) return;
        levelPersistence.storeUpdate(roomId, update).catch(err => {
            console.error(`[leveldb] storeUpdate failed for ${roomId}:`, err.message);
        });
    });

    // Step 2 — load historical state and apply (fire-and-forget).
    levelPersistence.getYDoc(roomId).then(storedDoc => {
        const update = Y.encodeStateAsUpdate(storedDoc);
        Y.applyUpdate(ydoc, update, PERSISTENCE_ORIGIN);
        storedDoc.destroy();
    }).catch(err => {
        console.warn(`[leveldb] Could not load state for ${roomId}:`, err.message);
    });
}

/**
 * Flush the current in-memory doc state to leveldb, then compact.
 * Call before doc.destroy() to ensure no updates are lost.
 *
 * Matches the reference `persistence.writeState(docName, doc)` contract.
 *
 * @param {string} roomId
 * @param {Y.Doc} ydoc
 * @returns {Promise<void>}
 */
export async function writeDocState(roomId, ydoc) {
    // Write the full current state as a single update (captures anything
    // that may not have been flushed from the incremental handler yet).
    await levelPersistence.storeUpdate(roomId, Y.encodeStateAsUpdate(ydoc));
    // Compact all individual update entries into a single merged entry.
    await levelPersistence.flushDocument(roomId);
}

/**
 * Create a snapshot of the current doc state.
 * @param {string} roomId
 * @param {string|null} fileId
 * @param {Y.Doc} ydoc
 * @param {'auto'|'manual'|'room_empty'} trigger
 * @param {string|null} createdBy
 * @param {string|null} description
 * @returns {string} snapshot id
 */
export function saveSnapshot(roomId, fileId, ydoc, trigger, createdBy, description) {
    const id = `snap_${randomBytes(8).toString('hex')}`;
    const state = Y.encodeStateAsUpdate(ydoc);
    sqliteDb.prepare(
        'INSERT INTO snapshots (id, file_id, room_id, state, created_at, trigger, created_by, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, fileId ?? roomId, roomId, Buffer.from(state), Date.now(), trigger, createdBy ?? null, description ?? null);
    console.log(`[snapshot] Saved ${id} room=${roomId} trigger=${trigger}`);
    return id;
}

/** @returns {object[]} snapshot metadata (no binary state) */
export function listSnapshotsByRoom(roomId) {
    return sqliteDb.prepare(
        'SELECT id, file_id, room_id, created_at, trigger, created_by, description FROM snapshots WHERE room_id = ? ORDER BY created_at DESC LIMIT 100'
    ).all(roomId);
}

/** @returns {object[]} */
export function listSnapshotsByFile(fileId) {
    return sqliteDb.prepare(
        'SELECT id, file_id, room_id, created_at, trigger, created_by, description FROM snapshots WHERE file_id = ? ORDER BY created_at DESC LIMIT 100'
    ).all(fileId);
}

/** @returns {Buffer|null} */
export function getSnapshotData(snapshotId) {
    const row = sqliteDb.prepare('SELECT state FROM snapshots WHERE id = ?').get(snapshotId);
    return row ? row.state : null;
}

/** @returns {object|null} metadata without binary */
export function getSnapshotMeta(snapshotId) {
    return sqliteDb.prepare(
        'SELECT id, file_id, room_id, created_at, trigger, created_by, description FROM snapshots WHERE id = ?'
    ).get(snapshotId) ?? null;
}

/**
 * Create a new room pre-loaded with a snapshot's state.
 * @param {string} snapshotId
 * @returns {Promise<{ newRoomId: string, fileId: string }|null>}
 */
export async function prepareRestore(snapshotId) {
    const snap = sqliteDb.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
    if (!snap) return null;

    const newRoomId = `room_${randomBytes(10).toString('hex')}`;

    // Store the snapshot state into leveldb so the new room loads it on first connect.
    await levelPersistence.storeUpdate(newRoomId, new Uint8Array(snap.state));
    await levelPersistence.flushDocument(newRoomId);

    console.log(`[restore] Prepared new room ${newRoomId} from snapshot ${snapshotId}`);
    return { newRoomId, fileId: snap.file_id };
}
