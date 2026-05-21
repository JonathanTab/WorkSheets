import { LeveldbPersistence } from 'y-leveldb';
import Database from 'better-sqlite3';
import * as Y from 'yjs';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import { computeAppDiff, countDiffChanges, inferAppType } from './diff.js';

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
            id           TEXT PRIMARY KEY,
            file_id      TEXT NOT NULL,
            room_id      TEXT NOT NULL,
            state        BLOB NOT NULL,
            created_at   INTEGER NOT NULL,
            trigger      TEXT NOT NULL DEFAULT 'auto',
            created_by   TEXT,
            description  TEXT,
            change_count INTEGER,
            diff_json    TEXT,
            app_type     TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_snap_file      ON snapshots(file_id);
        CREATE INDEX IF NOT EXISTS idx_snap_room      ON snapshots(room_id);
        CREATE INDEX IF NOT EXISTS idx_snap_time      ON snapshots(created_at);
        CREATE INDEX IF NOT EXISTS idx_snap_file_time ON snapshots(file_id, created_at);

        CREATE TABLE IF NOT EXISTS file_meta (
            file_id      TEXT PRIMARY KEY,
            last_edit_at INTEGER,
            last_edit_by TEXT
        );
    `);

    // Migrate existing databases
    const migrations = [
        `ALTER TABLE snapshots ADD COLUMN change_count INTEGER`,
        `ALTER TABLE snapshots ADD COLUMN diff_json TEXT`,
        `ALTER TABLE snapshots ADD COLUMN app_type TEXT`,
        `ALTER TABLE snapshots ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const sql of migrations) {
        try { sqliteDb.exec(sql); } catch { /* column already exists */ }
    }

    return { levelPersistence, sqliteDb };
}

// Sentinel origin used when applying persisted state so the update listener
// does not try to re-store it. Exported so server.js can filter it out too.
export const PERSISTENCE_ORIGIN = Symbol('y-leveldb-persistence');

// Symbol used to stash the incremental update listener on the ydoc so
// writeDocState can remove it before flushing, preventing late writes that
// race with the full-state compaction.
const LEVELDB_LISTENER = Symbol('leveldb-update-listener');

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
/**
 * @param {string} roomId
 * @param {Y.Doc} ydoc
 * @returns {Promise<void>} Resolves once historical state has been applied (or failed).
 *   Attach this to `doc.ready` so that setupWSConnection can await it before sending
 *   Sync Step 1, eliminating the race where a new client receives an empty state vector.
 */
export function bindDocState(roomId, ydoc) {
    // Step 1 — persist new updates incrementally (register BEFORE loading so
    // we never miss an update that arrives while history is loading).
    const updateListener = (update, origin) => {
        if (origin === PERSISTENCE_ORIGIN) return;
        levelPersistence.storeUpdate(roomId, update).catch(err => {
            console.error(`[leveldb] storeUpdate failed for ${roomId}:`, err.message);
        });
    };
    ydoc[LEVELDB_LISTENER] = updateListener;
    ydoc.on('update', updateListener);

    // Step 2 — load historical state and apply. Return the promise so callers
    // can await it before sending a Sync Step 1 state vector to new clients.
    return levelPersistence.getYDoc(roomId).then(storedDoc => {
        const update = Y.encodeStateAsUpdate(storedDoc);
        Y.applyUpdate(ydoc, update, PERSISTENCE_ORIGIN);
        storedDoc.destroy();
    }).catch(err => {
        console.warn(`[leveldb] Could not load state for ${roomId}:`, err.message);
        // Non-fatal: the doc starts empty, which is safe (CRDT will merge on next sync).
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
    // Remove the incremental listener first so no late storeUpdate calls can
    // race with the full-state write we're about to do.
    const listener = ydoc[LEVELDB_LISTENER];
    if (listener) {
        ydoc.off('update', listener);
        delete ydoc[LEVELDB_LISTENER];
    }
    // Write the full current state as a single update (captures anything
    // that may not have been flushed from the incremental handler yet).
    await levelPersistence.storeUpdate(roomId, Y.encodeStateAsUpdate(ydoc));
    // Compact all individual update entries into a single merged entry.
    await levelPersistence.flushDocument(roomId);
}

/**
 * Create a snapshot of the current doc state, computing the diff synchronously
 * so that empty auto-snapshots can be rejected before writing to disk.
 *
 * Returns the snapshot id on success, or null if the snapshot was rejected
 * (zero meaningful changes on a non-manual trigger).
 *
 * @param {string} roomId
 * @param {string|null} fileId
 * @param {Y.Doc} ydoc
 * @param {'auto'|'manual'|'room_empty'|'session_end'|'session_cap'} trigger
 * @param {string|null} createdBy - comma-separated usernames (may have dupes — deduped here)
 * @param {number} _sessionChanges - legacy SV-advance count (unused, kept for signature compat)
 * @param {string|null} [description] - optional user-provided label
 * @param {string|null} [appType] - 'sheets' | 'docs' | 'svg'
 * @returns {string|null} snapshot id, or null if aborted (no changes)
 */
export async function saveSnapshot(roomId, fileId, ydoc, trigger, createdBy, _sessionChanges, description = null, appType = null) {
    const effectiveFileId = fileId ?? roomId;
    const newStateBytes = Y.encodeStateAsUpdate(ydoc);

    // Deduplicate comma-separated usernames
    const cleanCreatedBy = createdBy
        ? [...new Set(createdBy.split(',').map(s => s.trim()).filter(Boolean))].join(',') || null
        : null;

    // Find predecessor snapshot for this file — fast synchronous DB read
    const prevRow = sqliteDb.prepare(
        'SELECT state, app_type FROM snapshots WHERE file_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(effectiveFileId);

    let diffJson;
    let realChangeCount = 0;

    if (!prevRow) {
        // Initial snapshot — always keep it, no diff needed
        diffJson = JSON.stringify({ v: 2, appType: appType ?? 'unknown', isInitial: true, totals: { cells: 0, formatting: 0, structure: 0, tables: 0, sheetsAdded: 0, sheetsRemoved: 0 }, sheets: [], sheetsRenamed: [], sheetOrder: null });
    } else {
        // Yield the event loop before the heavy synchronous CPU work so incoming
        // WebSocket messages can be processed while we compute the diff.
        await new Promise(r => setImmediate(r));

        const prevStateBytes = _toUint8Array(prevRow.state);

        const prevDoc = new Y.Doc({ gc: false });
        Y.applyUpdate(prevDoc, prevStateBytes);
        const newDoc = new Y.Doc({ gc: false });
        Y.applyUpdate(newDoc, newStateBytes);

        let diff, resolvedAppType;
        try {
            ({ diff, resolvedAppType } = computeAppDiff(appType ?? prevRow.app_type ?? null, prevDoc, newDoc));
        } catch (err) {
            console.error(`[snapshot] Diff compute error: ${err.message}`);
            diff = { v: 1, entries: [] };
            resolvedAppType = appType;
        } finally {
            prevDoc.destroy();
            newDoc.destroy();
        }

        // Use inferred appType if the explicit one was null
        const effectiveAppType = appType ?? resolvedAppType ?? null;

        realChangeCount = countDiffChanges(diff);

        // Reject zero-change auto snapshots (not manual)
        if (realChangeCount === 0 && trigger !== 'manual') {
            console.log(`[snapshot] Skipping ${trigger} snapshot for ${roomId} — zero meaningful changes`);
            return null;
        }

        diffJson = JSON.stringify(diff);
        appType = effectiveAppType; // update for the INSERT below
        console.log(`[diff] ${trigger} snapshot for ${roomId}: ${realChangeCount} changes (${effectiveAppType ?? 'unknown'})`);
    }

    const id = `snap_${randomBytes(8).toString('hex')}`;
    sqliteDb.prepare(
        'INSERT INTO snapshots (id, file_id, room_id, state, created_at, trigger, created_by, change_count, description, app_type, diff_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, effectiveFileId, roomId, Buffer.from(newStateBytes), Date.now(), trigger, cleanCreatedBy, realChangeCount, description ?? null, appType ?? null, diffJson);

    console.log(`[snapshot] Saved ${id} room=${roomId} trigger=${trigger} changes=${realChangeCount}`);
    return id;
}

/**
 * Compute and store the diff for a snapshot vs. its predecessor (used by backfill).
 * Uses computeAppDiff to dispatch to the correct app-specific diff function.
 * @param {string} snapshotId
 * @param {string} fileId
 * @param {Uint8Array} newStateBytes
 * @param {string|null} appType
 */
function _computeAndStoreDiff(snapshotId, fileId, newStateBytes, appType) {
    try {
        const current = sqliteDb.prepare('SELECT created_at, room_id, app_type FROM snapshots WHERE id = ?').get(snapshotId);

        let prevRow = null;
        if (current) {
            // 1. Same-room predecessor (strictly before in time)
            prevRow = sqliteDb.prepare(
                'SELECT state FROM snapshots WHERE file_id = ? AND room_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1'
            ).get(fileId, current.room_id, current.created_at);

            // 2. Any same-file predecessor (e.g. first snapshot after a room restore)
            if (!prevRow) {
                prevRow = sqliteDb.prepare(
                    'SELECT state FROM snapshots WHERE file_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1'
                ).get(fileId, current.created_at);
            }
        }

        let diffJson;
        let resolvedAppType = appType ?? current?.app_type ?? null;

        if (!prevRow) {
            // Use inferAppType to get proper type even without a predecessor
            if (!resolvedAppType) {
                const doc = new Y.Doc({ gc: false });
                Y.applyUpdate(doc, _toUint8Array(newStateBytes));
                resolvedAppType = inferAppType(doc);
                doc.destroy();
            }
            diffJson = JSON.stringify({ v: 2, appType: resolvedAppType, isInitial: true, totals: { cells: 0, formatting: 0, structure: 0, tables: 0, sheetsAdded: 0, sheetsRemoved: 0 }, sheets: [], sheetsRenamed: [], sheetOrder: null });
        } else {
            const prevDoc = new Y.Doc({ gc: false });
            Y.applyUpdate(prevDoc, _toUint8Array(prevRow.state));
            const newDoc = new Y.Doc({ gc: false });
            Y.applyUpdate(newDoc, _toUint8Array(newStateBytes));

            let diff;
            ({ diff, resolvedAppType } = computeAppDiff(resolvedAppType, prevDoc, newDoc));
            diffJson = JSON.stringify(diff);
            const n = countDiffChanges(diff);

            prevDoc.destroy();
            newDoc.destroy();
            console.log(`[diff] backfill ${snapshotId}: ${n} changes (${resolvedAppType ?? 'unknown'})`);
        }

        // Update diff_json and opportunistically write app_type if it was inferred
        if (resolvedAppType && resolvedAppType !== current?.app_type) {
            sqliteDb.prepare('UPDATE snapshots SET diff_json = ?, app_type = ? WHERE id = ?').run(diffJson, resolvedAppType, snapshotId);
        } else {
            sqliteDb.prepare('UPDATE snapshots SET diff_json = ? WHERE id = ?').run(diffJson, snapshotId);
        }
    } catch (err) {
        console.error(`[diff] Failed for ${snapshotId}:`, err.message);
    }
}

/** Safely convert Buffer or Uint8Array to Uint8Array without sharing memory. */
function _toUint8Array(buf) {
    if (buf instanceof Buffer) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf instanceof Uint8Array) return buf;
    return new Uint8Array(buf);
}

/**
 * Backfill diff_json for all snapshots of a file that have none yet.
 * Called once at startup or via the API endpoint.
 * Processes oldest→newest so each diff has access to the prior result.
 * @param {string} fileId
 * @returns {number} count of snapshots processed
 */
export function backfillDiffs(fileId) {
    const snaps = sqliteDb.prepare(
        'SELECT id, state, created_at, app_type FROM snapshots WHERE file_id = ? AND diff_json IS NULL ORDER BY created_at ASC'
    ).all(fileId);

    if (snaps.length === 0) return 0;

    let processed = 0;
    for (const snap of snaps) {
        _computeAndStoreDiff(snap.id, fileId, _toUint8Array(snap.state), snap.app_type ?? null);
        processed++;
    }
    console.log(`[diff] Backfilled ${processed} snapshots for file ${fileId}`);
    return processed;
}

/**
 * Backfill diffs for ALL files.
 * @param {boolean} [force=false]  If true, clears existing diff_json and recomputes everything.
 * Runs in the background — does not block.
 */
export function backfillAllDiffs(force = false) {
    setImmediate(() => {
        try {
            if (force) {
                sqliteDb.prepare('UPDATE snapshots SET diff_json = NULL').run();
                console.log('[diff] Cleared all existing diffs for full recompute');
            }

            const files = sqliteDb.prepare(
                'SELECT DISTINCT file_id FROM snapshots WHERE diff_json IS NULL'
            ).all().map(r => r.file_id);

            if (files.length === 0) { console.log('[diff] All diffs up to date'); return; }
            console.log(`[diff] Backfilling ${files.length} files…`);
            let total = 0;
            for (const fileId of files) total += backfillDiffs(fileId);
            console.log(`[diff] Backfill complete — ${total} snapshots updated`);
        } catch (err) {
            console.error('[diff] Backfill error:', err.message);
        }
    });
}

// Columns for list endpoints — omits diff_json (can be 100s of KB per row)
const SNAP_LIST_COLS = 'id, file_id, room_id, created_at, trigger, created_by, change_count, description, app_type, pinned';
// Full columns for single-snapshot fetches (metadata + diff)
const SNAP_COLS = SNAP_LIST_COLS + ', diff_json';

/** @returns {object[]} snapshot list metadata (no diff_json, no binary state) */
export function listSnapshotsByRoom(roomId) {
    return sqliteDb.prepare(
        `SELECT ${SNAP_LIST_COLS} FROM snapshots WHERE room_id = ? ORDER BY created_at DESC LIMIT 100`
    ).all(roomId);
}

/** @returns {object[]} */
export function listSnapshotsByFile(fileId) {
    return sqliteDb.prepare(
        `SELECT ${SNAP_LIST_COLS} FROM snapshots WHERE file_id = ? ORDER BY created_at DESC LIMIT 100`
    ).all(fileId);
}

/**
 * Get only the diff_json for a specific snapshot (lightweight on-demand fetch).
 * @param {string} snapshotId
 * @returns {string|null}
 */
export function getSnapshotDiff(snapshotId) {
    const row = sqliteDb.prepare('SELECT diff_json FROM snapshots WHERE id = ?').get(snapshotId);
    return row?.diff_json ?? null;
}

/** @returns {Buffer|null} */
export function getSnapshotData(snapshotId) {
    const row = sqliteDb.prepare('SELECT state FROM snapshots WHERE id = ?').get(snapshotId);
    return row ? row.state : null;
}

/** @returns {object|null} metadata without binary */
export function getSnapshotMeta(snapshotId) {
    return sqliteDb.prepare(
        `SELECT ${SNAP_COLS} FROM snapshots WHERE id = ?`
    ).get(snapshotId) ?? null;
}

/**
 * Record the most recent meaningful edit for a file.
 * Rate-limited at the call site — this writes unconditionally.
 * @param {string} fileId
 * @param {string} username
 * @param {number} at - Unix ms
 */
export function updateFileLastEdit(fileId, username, at) {
    sqliteDb.prepare(`
        INSERT INTO file_meta (file_id, last_edit_at, last_edit_by) VALUES (?, ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET last_edit_at = excluded.last_edit_at, last_edit_by = excluded.last_edit_by
    `).run(fileId, at, username);
}

/**
 * Get the last-edit metadata for a file.
 * @param {string} fileId
 * @returns {{ last_edit_at: number, last_edit_by: string }|null}
 */
export function getFileLastEdit(fileId) {
    return sqliteDb.prepare(
        'SELECT last_edit_at, last_edit_by FROM file_meta WHERE file_id = ?'
    ).get(fileId) ?? null;
}

/**
 * Toggle the pinned state of a snapshot.
 * Pinned snapshots are excluded from retention thinning.
 * @param {string} snapshotId
 * @param {boolean} pinned
 */
export function setSnapshotPinned(snapshotId, pinned) {
    sqliteDb.prepare('UPDATE snapshots SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, snapshotId);
}

/**
 * Update the description of a snapshot (manual snapshots only).
 * @param {string} snapshotId
 * @param {string|null} description
 */
export function updateSnapshotDescription(snapshotId, description) {
    sqliteDb.prepare("UPDATE snapshots SET description = ? WHERE id = ? AND trigger = 'manual'").run(description ?? null, snapshotId);
}

/**
 * Delete a snapshot (manual snapshots only; auto/room_empty are managed by retention).
 * @param {string} snapshotId
 * @returns {boolean} true if a row was deleted
 */
export function deleteSnapshot(snapshotId) {
    const info = sqliteDb.prepare("DELETE FROM snapshots WHERE id = ? AND trigger = 'manual'").run(snapshotId);
    return info.changes > 0;
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
