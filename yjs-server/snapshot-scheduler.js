import * as Y from 'yjs';

/**
 * SnapshotScheduler — session-aware automatic snapshot management.
 *
 * Snapshot trigger model:
 *   - Editing session boundary: snapshot when a user pauses editing for SESSION_IDLE_MS.
 *     e.g. user logs in daily and makes one change → one snapshot per visit.
 *   - Long-session cap: during continuous editing, snapshot at most every IN_SESSION_CAP_MS.
 *     e.g. user edits for 5 hours → snapshot roughly every 15 minutes.
 *   - Room empty: immediate snapshot when all users disconnect (if unsaved changes exist).
 *   - Real-change guard: every snapshot candidate is checked against the Y.js state vector
 *     from the previous snapshot — pure no-ops (presence, dedup) never trigger a save.
 *
 * Retention model (per file, auto snapshots only):
 *   - Slot-based thinning: within each time slot, keep only the newest snapshot.
 *   - Slot sizes grow with age: 4h → 1d → 3d → 7d → 30d.
 *   - Same-slot duplicates are only deleted once the older copy is ≥ 6 months old,
 *     preserving full resolution within the 6-month window.
 *   - Manual snapshots are never touched.
 *   - Minimum 5 auto snapshots per file always preserved.
 *
 * Configuration (environment variables):
 *   SNAPSHOT_IDLE        - Idle time (ms) that ends a session (default: 5 min)
 *   SNAPSHOT_CAP         - Max interval (ms) between checkpoints during active editing (default: 15 min)
 *   SNAPSHOT_COLLAB_IDLE - Idle time for multi-user sessions (default: 2 min)
 *   SNAPSHOT_COLLAB_CAP  - Checkpoint interval for multi-user sessions (default: 10 min)
 */

const CONFIG = {
    SESSION_IDLE_MS:  parseInt(process.env.SNAPSHOT_IDLE        ?? String(5  * 60_000)),
    IN_SESSION_CAP_MS: parseInt(process.env.SNAPSHOT_CAP        ?? String(15 * 60_000)),
    COLLAB_IDLE_MS:   parseInt(process.env.SNAPSHOT_COLLAB_IDLE ?? String(2  * 60_000)),
    COLLAB_CAP_MS:    parseInt(process.env.SNAPSHOT_COLLAB_CAP  ?? String(10 * 60_000)),
};

// Slot sizes for retention thinning, from most-recent to oldest.
// Each entry covers snapshots with age in [prevMaxAge, maxAge).
const RETENTION_SLOTS = [
    { maxAge:   7 * 86_400_000, slotMs:  4 * 3_600_000 }, // 0–7d:    1 per 4h
    { maxAge:  30 * 86_400_000, slotMs:     86_400_000 }, // 7–30d:   1 per day
    { maxAge:  90 * 86_400_000, slotMs:  3 * 86_400_000 }, // 30–90d:  1 per 3 days
    { maxAge: 180 * 86_400_000, slotMs:  7 * 86_400_000 }, // 90–180d: 1 per week
    { maxAge: Infinity,         slotMs: 30 * 86_400_000 }, // >180d:   1 per month
];

const SIX_MONTHS_MS = 180 * 86_400_000;

export class SnapshotScheduler {
    /**
     * @param {function(roomId: string, fileId: string, ydoc: Y.Doc, trigger: string, createdBy: string|null, desc: string|null): string} saveFn
     * @param {object} [sqliteDb] - SQLite database for retention cleanup
     */
    constructor(saveFn, sqliteDb = null) {
        this.save = saveFn;
        this.sqliteDb = sqliteDb;

        /**
         * @type {Map<string, {
         *   idleTimer: ReturnType<typeof setTimeout>|null,
         *   burstCapTimer: ReturnType<typeof setTimeout>|null,
         *   lastSnapshot: number,
         *   lastActivity: number,
         *   dirty: boolean,
         *   fileId: string|null,
         *   ydoc: Y.Doc,
         *   userCount: number,
         *   sessionChanges: number,
         *   sessionStart: number,
         *   lastSnapshotSV: Uint8Array|null,
         *   lastCheckedSV: Uint8Array|null,
         * }>}
         */
        this.rooms = new Map();

        this._startRetentionCleanup();
    }

    setDatabase(db) {
        this.sqliteDb = db;
    }

    /**
     * Called whenever a room receives a document update.
     * Only triggers snapshot logic when the Y.js state vector actually advances.
     */
    markDirty(roomId, fileId, ydoc, _updateSize = 0) {
        let entry = this.rooms.get(roomId);
        if (!entry) {
            entry = this._createEntry(fileId, ydoc);
            this.rooms.set(roomId, entry);
        }

        entry.ydoc = ydoc;
        entry.lastActivity = Date.now();

        // Only count changes where the document state vector actually advances.
        // This filters out no-ops, duplicate relays, and pure-awareness packets.
        const currentSV = Y.encodeStateVector(ydoc);
        if (!this._svEqual(currentSV, entry.lastCheckedSV)) {
            entry.lastCheckedSV = currentSV;
            entry.dirty = true;
            entry.sessionChanges++;
        }

        this._scheduleSessionSnapshot(roomId, entry);
    }

    /**
     * Called when a user joins or leaves a room.
     * Collab mode tightens the idle and cap intervals.
     */
    updateUserCount(roomId, userCount) {
        const entry = this.rooms.get(roomId);
        if (!entry) return;
        entry.userCount = userCount;
        // Timers will naturally pick up the new intervals on their next reset.
    }

    /**
     * Called when all connections to a room close.
     * Snapshots immediately if there are unsaved changes.
     */
    onRoomEmpty(roomId, fileId, ydoc, activeUsernames) {
        const entry = this.rooms.get(roomId);

        if (entry) {
            if (entry.idleTimer)     clearTimeout(entry.idleTimer);
            if (entry.burstCapTimer) clearTimeout(entry.burstCapTimer);
            entry.idleTimer     = null;
            entry.burstCapTimer = null;
        }

        if (!entry?.dirty) {
            // Double-check state vector in case we're tracking from a fresh connection
            if (!this._hasRealChanges(ydoc, entry?.lastSnapshotSV ?? null)) {
                console.log(`[snapshot-scheduler] Skipping room_empty for ${roomId} — no changes`);
                return;
            }
        }

        const createdBy = activeUsernames.length > 0 ? activeUsernames.join(',') : null;
        const changes = entry?.sessionChanges ?? 0;
        const desc = changes > 0 ? `${changes} change${changes !== 1 ? 's' : ''}` : null;

        this._commitSnapshot(roomId, fileId ?? entry?.fileId, ydoc, 'room_empty', createdBy, desc, entry);
    }

    /** Remove tracking for a room after it's been destroyed. */
    cleanup(roomId) {
        const entry = this.rooms.get(roomId);
        if (!entry) return;
        if (entry.idleTimer)     clearTimeout(entry.idleTimer);
        if (entry.burstCapTimer) clearTimeout(entry.burstCapTimer);
        this.rooms.delete(roomId);
    }

    /** Debugging / monitoring. */
    getStats(roomId) {
        const entry = this.rooms.get(roomId);
        if (!entry) return null;
        const idleMs  = entry.userCount > 1 ? CONFIG.COLLAB_IDLE_MS  : CONFIG.SESSION_IDLE_MS;
        const capMs   = entry.userCount > 1 ? CONFIG.COLLAB_CAP_MS   : CONFIG.IN_SESSION_CAP_MS;
        return {
            dirty:              entry.dirty,
            sessionChanges:     entry.sessionChanges,
            userCount:          entry.userCount,
            idleTimeout:        Math.round(idleMs  / 1000) + 's',
            burstCap:           Math.round(capMs   / 1000) + 's',
            sessionLength:      Math.round((Date.now() - entry.sessionStart) / 60_000) + 'min',
            timeSinceSnapshot:  Math.round((Date.now() - entry.lastSnapshot)  / 1000)  + 's',
        };
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    _createEntry(fileId, ydoc) {
        return {
            idleTimer:      null,
            burstCapTimer:  null,
            lastSnapshot:   Date.now(),
            lastActivity:   Date.now(),
            dirty:          false,
            fileId,
            ydoc,
            userCount:      1,
            sessionChanges: 0,
            sessionStart:   Date.now(),
            lastSnapshotSV: ydoc ? Y.encodeStateVector(ydoc) : null,
            lastCheckedSV:  ydoc ? Y.encodeStateVector(ydoc) : null,
        };
    }

    /**
     * Set up (or reset) the two timers that drive session-based snapshotting.
     *
     *   idleTimer     — resets on every update; fires when editing pauses (session end).
     *   burstCapTimer — starts once at session onset; fires to checkpoint a long session.
     *                   Cleared after firing; next markDirty call restarts it.
     */
    _scheduleSessionSnapshot(roomId, entry) {
        const idleMs = entry.userCount > 1 ? CONFIG.COLLAB_IDLE_MS  : CONFIG.SESSION_IDLE_MS;
        const capMs  = entry.userCount > 1 ? CONFIG.COLLAB_CAP_MS   : CONFIG.IN_SESSION_CAP_MS;

        // Idle timer: always reset — fires when editing stops for idleMs.
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => {
            entry.idleTimer = null;
            // Session ended — clear cap timer too (it's no longer needed).
            if (entry.burstCapTimer) {
                clearTimeout(entry.burstCapTimer);
                entry.burstCapTimer = null;
            }
            if (entry.dirty) {
                this._takeSnapshot(roomId, entry, 'session_end');
            }
        }, idleMs);

        // Burst-cap timer: start only once per session; checkpoint long editing bursts.
        if (!entry.burstCapTimer) {
            entry.burstCapTimer = setTimeout(() => {
                entry.burstCapTimer = null; // cleared — next markDirty restarts it
                if (entry.dirty) {
                    this._takeSnapshot(roomId, entry, 'session_cap');
                }
            }, capMs);
        }
    }

    /**
     * Check whether the document has changed since the last snapshot.
     * Compares Y.js state vectors directly — cheap and allocation-free.
     */
    _hasRealChanges(ydoc, lastSnapshotSV) {
        if (!ydoc) return false;
        const currentSV = Y.encodeStateVector(ydoc);
        return !this._svEqual(currentSV, lastSnapshotSV);
    }

    /** Byte-by-byte equality for two state vectors (or null). */
    _svEqual(a, b) {
        if (!a && !b) return true;
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    /**
     * Take a snapshot if dirty and real changes exist.
     * Resets dirty state and updates lastSnapshotSV on success.
     */
    _takeSnapshot(roomId, entry, trigger) {
        if (!entry.dirty) return;

        // Final guard: verify the state vector actually advanced since last snapshot.
        if (!this._hasRealChanges(entry.ydoc, entry.lastSnapshotSV)) {
            entry.dirty          = false;
            entry.sessionChanges = 0;
            return;
        }

        const desc = entry.sessionChanges > 0
            ? `${entry.sessionChanges} change${entry.sessionChanges !== 1 ? 's' : ''}`
            : null;

        this._commitSnapshot(roomId, entry.fileId, entry.ydoc, trigger, null, desc, entry);
    }

    /** Persist the snapshot and update entry bookkeeping. */
    _commitSnapshot(roomId, fileId, ydoc, trigger, createdBy, desc, entry) {
        try {
            this.save(roomId, fileId, ydoc, trigger, createdBy ?? null, desc ?? null);
        } catch (err) {
            console.error(`[snapshot-scheduler] Failed to save snapshot for ${roomId}:`, err);
            return;
        }

        if (entry) {
            entry.dirty          = false;
            entry.lastSnapshot   = Date.now();
            entry.sessionChanges = 0;
            entry.sessionStart   = Date.now();
            entry.lastSnapshotSV = Y.encodeStateVector(ydoc);
        }
    }

    // -------------------------------------------------------------------------
    // Retention cleanup
    // -------------------------------------------------------------------------

    _startRetentionCleanup() {
        setTimeout(() => this._runRetentionCleanup(), 15_000);
        setInterval(() => this._runRetentionCleanup(), 60 * 60_000);
    }

    /**
     * Per-file slot-based thinning.
     *
     * For each file, auto-snapshots are bucketed into time slots whose width grows
     * with age (4h near, 30d far). Within each slot we keep only the newest snapshot.
     * A redundant (older) snapshot in the same slot is only deleted once it is
     * ≥ 6 months old — within the 6-month window we accumulate but never prune.
     *
     * Manual snapshots are never touched.
     * A minimum of 5 auto snapshots per file is always preserved.
     */
    _runRetentionCleanup() {
        if (!this.sqliteDb) return;

        try {
            const now = Date.now();

            const fileIds = this.sqliteDb.prepare(
                `SELECT DISTINCT file_id FROM snapshots WHERE trigger != 'manual'`
            ).all().map(r => r.file_id);

            let totalThinned = 0;

            for (const fileId of fileIds) {
                const snaps = this.sqliteDb.prepare(`
                    SELECT id, created_at FROM snapshots
                    WHERE file_id = ? AND trigger != 'manual'
                    ORDER BY created_at ASC
                `).all(fileId);

                if (snaps.length <= 5) continue;

                const slotKeeper = new Map(); // slotKey → { id, created_at }
                const toDelete   = [];

                for (const snap of snaps) {
                    const age  = now - snap.created_at;
                    const rule = RETENTION_SLOTS.find(s => age < s.maxAge)
                               ?? RETENTION_SLOTS[RETENTION_SLOTS.length - 1];
                    const slotKey = `${rule.slotMs}_${Math.floor(snap.created_at / rule.slotMs)}`;

                    if (slotKeeper.has(slotKey)) {
                        const older = slotKeeper.get(slotKey);
                        // older is a same-slot duplicate — only delete it if it's old enough
                        if (now - older.created_at >= SIX_MONTHS_MS) {
                            toDelete.push(older.id);
                        }
                        slotKeeper.set(slotKey, snap); // newer is now the slot keeper
                    } else {
                        slotKeeper.set(slotKey, snap);
                    }
                }

                // Guarantee minimum 5 survivors: cancel newest deletions if needed.
                const wouldRemain = snaps.length - toDelete.length;
                if (wouldRemain < 5) {
                    toDelete.splice(toDelete.length - (5 - wouldRemain));
                }

                if (toDelete.length === 0) continue;

                for (let i = 0; i < toDelete.length; i += 100) {
                    const chunk = toDelete.slice(i, i + 100);
                    const ph = chunk.map(() => '?').join(',');
                    this.sqliteDb.prepare(
                        `DELETE FROM snapshots WHERE id IN (${ph})`
                    ).run(chunk);
                }
                totalThinned += toDelete.length;
            }

            if (totalThinned > 0) {
                console.log(`[snapshot-scheduler] Retention: thinned ${totalThinned} duplicate snapshots`);
            }
        } catch (err) {
            console.error('[snapshot-scheduler] Retention cleanup error:', err);
        }
    }
}
