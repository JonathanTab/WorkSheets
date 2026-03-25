import * as Y from 'yjs';

/**
 * SnapshotScheduler — intelligent automatic snapshot management.
 *
 * Smart snapshot strategies:
 *   1. Change-threshold triggering: Snapshot after N significant updates
 *   2. Adaptive intervals: Adjust timing based on editing frequency
 *   3. Update size awareness: Track bytes changed for significance
 *   4. Session-based triggers: Handle user join/leave patterns intelligently
 *   5. Retention policy: Auto-cleanup of old snapshots
 *   6. User activity awareness: Different strategies for collaborative sessions
 *
 * Configuration (environment variables):
 *   SNAPSHOT_MIN_INTERVAL     - Min quiet period before snapshot (default: 5 min)
 *   SNAPSHOT_MAX_INTERVAL     - Max time between snapshots (default: 30 min)
 *   SNAPSHOT_UPDATE_THRESHOLD - Number of updates to trigger snapshot (default: 50)
 *   SNAPSHOT_BYTE_THRESHOLD   - Bytes changed to trigger snapshot (default: 50KB)
 *   SNAPSHOT_RETENTION_COUNT  - Max snapshots per file to keep (default: 20)
 *   SNAPSHOT_RETENTION_AGE    - Max age in hours for snapshots (default: 720 = 30 days)
 */

// Configuration with sensible defaults
const CONFIG = {
    MIN_INTERVAL: parseInt(process.env.SNAPSHOT_MIN_INTERVAL ?? String(5 * 60 * 1000)),      // 5 min
    MAX_INTERVAL: parseInt(process.env.SNAPSHOT_MAX_INTERVAL ?? String(30 * 60 * 1000)),    // 30 min
    UPDATE_THRESHOLD: parseInt(process.env.SNAPSHOT_UPDATE_THRESHOLD ?? '50'),              // 50 updates
    BYTE_THRESHOLD: parseInt(process.env.SNAPSHOT_BYTE_THRESHOLD ?? String(50 * 1024)),     // 50KB
    RETENTION_COUNT: parseInt(process.env.SNAPSHOT_RETENTION_COUNT ?? '20'),                // keep 20 snapshots
    RETENTION_AGE_MS: parseInt(process.env.SNAPSHOT_RETENTION_AGE ?? '720') * 60 * 60 * 1000, // 30 days in ms
    // Adaptive interval multipliers
    ADAPTIVE_MIN_FACTOR: 0.5,   // Fast editing: reduce min interval by 50%
    ADAPTIVE_MAX_FACTOR: 2.0,   // Slow editing: increase max interval by 100%
    COLLAB_MULTIPLIER: 0.7,     // Multi-user sessions: reduce intervals by 30%
};

export class SnapshotScheduler {
    /**
     * @param {function(roomId: string, fileId: string, ydoc: Y.Doc, trigger: string, createdBy: string|null, desc: string|null): string} saveFn
     * @param {object} [sqliteDb] - Optional SQLite database for retention cleanup
     */
    constructor(saveFn, sqliteDb = null) {
        this.save = saveFn;
        this.sqliteDb = sqliteDb;

        /**
         * @type {Map<string, {
         *   debounceTimer: ReturnType<typeof setTimeout>|null,
         *   maxTimer: ReturnType<typeof setTimeout>|null,
         *   lastSnapshot: number,
         *   lastActivity: number,
         *   dirty: boolean,
         *   fileId: string|null,
         *   ydoc: import('yjs').Doc,
         *   updateCount: number,
         *   byteCount: number,
         *   userCount: number,
         *   editRate: number,        // updates per minute
         *   editRateSamples: number[], // recent edit rates for averaging
         *   adaptiveMinInterval: number,
         *   adaptiveMaxInterval: number,
         *   sessionStart: number,
         *   recentUpdates: Array<{ time: number, size: number }>, // last N updates for rate calc
         *   lastSnapshotState: Uint8Array|null // encoded state vector from last snapshot for change detection
         * }>}
         */
        this.rooms = new Map();

        // Run retention cleanup periodically
        this._startRetentionCleanup();
    }

    /**
     * Set the SQLite database for retention cleanup.
     * @param {object} db
     */
    setDatabase(db) {
        this.sqliteDb = db;
    }

    /**
     * Called whenever a room receives an update.
     * Tracks update frequency and size for intelligent snapshot decisions.
     */
    markDirty(roomId, fileId, ydoc, updateSize = 0) {
        const now = Date.now();
        let entry = this.rooms.get(roomId);

        if (!entry) {
            entry = this._createEntry(roomId, fileId, ydoc);
            this.rooms.set(roomId, entry);
        }

        entry.ydoc = ydoc;
        entry.dirty = true;
        entry.lastActivity = now;
        entry.updateCount++;
        entry.byteCount += updateSize;

        // Track recent updates for rate calculation
        entry.recentUpdates.push({ time: now, size: updateSize });
        // Keep only last 100 updates for rate calculation
        if (entry.recentUpdates.length > 100) {
            entry.recentUpdates.shift();
        }

        // Calculate edit rate (updates per minute over last 5 minutes)
        this._updateEditRate(entry, now);

        // Adapt intervals based on editing patterns
        this._adaptIntervals(entry);

        // Check if we should snapshot based on thresholds
        const shouldSnapshot = this._checkThresholds(entry);

        if (shouldSnapshot) {
            this._takeSnapshot(roomId, entry, 'threshold');
            return;
        }

        // Reset debounce timer with adaptive interval
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => {
            entry.debounceTimer = null;
            if (entry.dirty) {
                this._takeSnapshot(roomId, entry, 'auto');
            }
        }, entry.adaptiveMinInterval);

        // Ensure max interval cap (snapshot even during continuous editing)
        if (!entry.maxTimer) {
            entry.maxTimer = setTimeout(() => {
                entry.maxTimer = null;
                if (entry.dirty) {
                    this._takeSnapshot(roomId, entry, 'auto');
                }
            }, entry.adaptiveMaxInterval);
        }
    }

    /**
     * Called when a user joins or leaves a room.
     * @param {string} roomId
     * @param {number} userCount - Current number of users in room
     */
    updateUserCount(roomId, userCount) {
        const entry = this.rooms.get(roomId);
        if (!entry) return;

        const wasCollab = entry.userCount > 1;
        const isCollab = userCount > 1;
        entry.userCount = userCount;

        // If transitioning to/from collaborative mode, adjust intervals
        if (wasCollab !== isCollab) {
            this._adaptIntervals(entry);
        }
    }

    /**
     * Called when all connections to a room close.
     * Takes an intelligent snapshot based on session analysis.
     */
    onRoomEmpty(roomId, fileId, ydoc, activeUsernames) {
        const entry = this.rooms.get(roomId);
        const sessionLength = entry ? (Date.now() - entry.sessionStart) : 0;

        // Cancel pending timers
        if (entry) {
            if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
            if (entry.maxTimer) clearTimeout(entry.maxTimer);
        }

        // Check if there are real changes to the document
        const lastState = entry ? entry.lastSnapshotState : null;
        const hasRealChanges = this._hasRealChanges(ydoc, lastState);

        if (!hasRealChanges) {
            console.log(`[snapshot-scheduler] Skipping room_empty snapshot for ${roomId} - no real changes`);
            return;
        }

        // Determine trigger and description based on session analysis
        const hadSignificantChanges = entry && (entry.updateCount > 5 || entry.byteCount > 1024);
        let trigger = 'room_empty';
        let description = null;

        if (entry) {
            if (hadSignificantChanges) {
                // Add context to description
                const duration = Math.round(sessionLength / 60000);
                description = `Session: ${entry.updateCount} updates, ${Math.round(entry.byteCount / 1024)}KB, ${duration}min`;
            } else if (entry.updateCount > 0) {
                // Minor changes - still snapshot but mark as minor
                trigger = 'room_empty_minor';
                description = `Minor session: ${entry.updateCount} updates`;
            }
        }

        const createdBy = activeUsernames.length > 0 ? activeUsernames.join(',') : null;
        this.save(roomId, fileId, ydoc, trigger, createdBy, description);
    }

    /** Remove tracking for a room after it's been destroyed. */
    cleanup(roomId) {
        const entry = this.rooms.get(roomId);
        if (!entry) return;
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        if (entry.maxTimer) clearTimeout(entry.maxTimer);
        this.rooms.delete(roomId);
    }

    /**
     * Create a new tracking entry for a room.
     * @private
     */
    _createEntry(roomId, fileId, ydoc) {
        // Capture initial state for change detection
        const initialState = ydoc ? Y.encodeStateAsUpdate(ydoc) : null;

        return {
            debounceTimer: null,
            maxTimer: null,
            lastSnapshot: Date.now(),
            lastActivity: Date.now(),
            dirty: false,
            fileId,
            ydoc,
            updateCount: 0,
            byteCount: 0,
            userCount: 1,
            editRate: 0,
            editRateSamples: [],
            adaptiveMinInterval: CONFIG.MIN_INTERVAL,
            adaptiveMaxInterval: CONFIG.MAX_INTERVAL,
            sessionStart: Date.now(),
            recentUpdates: [],
            lastSnapshotState: initialState,
        };
    }

    /**
     * Check if the document has real changes compared to the last snapshot.
     * Uses Y.js state vector comparison to detect actual content changes.
     * @private
     * @param {import('yjs').Doc} ydoc
     * @param {Uint8Array|null} lastState
     * @returns {boolean}
     */
    _hasRealChanges(ydoc, lastState) {
        if (!ydoc) return false;

        const currentState = Y.encodeStateAsUpdate(ydoc);

        // If no previous state, any content is a change
        if (!lastState || lastState.length === 0) {
            // Check if document has any actual content
            return currentState.length > 0;
        }

        // Compare state vectors using Y.js's diff method
        // If the diff is empty, there are no real changes
        try {
            // Create a temporary doc to apply both states and check if they differ
            const tempDoc = new Y.Doc();
            Y.applyUpdate(tempDoc, lastState);

            const lastStateVector = Y.encodeStateVector(tempDoc);
            tempDoc.destroy();

            // Get the difference - what's in current that's not in last
            const diff = Y.diffUpdate(currentState, lastStateVector);

            // If diff has content, there are real changes
            // diff is an empty Uint8Array if no differences
            return diff.length > 0;
        } catch (err) {
            // If comparison fails, be conservative and assume there are changes
            console.warn('[snapshot-scheduler] State comparison error, assuming changes:', err.message);
            return true;
        }
    }

    /**
     * Calculate and update edit rate.
     * @private
     */
    _updateEditRate(entry, now) {
        const fiveMinutesAgo = now - 5 * 60 * 1000;
        const recentUpdates = entry.recentUpdates.filter(u => u.time > fiveMinutesAgo);
        entry.recentUpdates = recentUpdates;

        if (recentUpdates.length > 0) {
            const timeSpan = now - recentUpdates[0].time;
            if (timeSpan > 0) {
                entry.editRate = (recentUpdates.length / timeSpan) * 60000; // updates per minute
            }
        }

        // Store sample for averaging
        entry.editRateSamples.push(entry.editRate);
        if (entry.editRateSamples.length > 10) {
            entry.editRateSamples.shift();
        }
    }

    /**
     * Adapt snapshot intervals based on editing patterns.
     * @private
     */
    _adaptIntervals(entry) {
        // Calculate average edit rate
        const avgEditRate = entry.editRateSamples.length > 0
            ? entry.editRateSamples.reduce((a, b) => a + b, 0) / entry.editRateSamples.length
            : entry.editRate;

        // High edit rate = faster snapshots (don't wait as long)
        // Low edit rate = slower snapshots (don't poll with tiny changes)
        let minFactor = 1;
        let maxFactor = 1;

        if (avgEditRate > 10) {
            // Very active editing: snapshot more frequently
            minFactor = CONFIG.ADAPTIVE_MIN_FACTOR;
            maxFactor = 0.8;
        } else if (avgEditRate > 5) {
            // Moderate editing
            minFactor = 0.7;
            maxFactor = 0.9;
        } else if (avgEditRate < 1) {
            // Slow editing: wait longer
            minFactor = 1.5;
            maxFactor = CONFIG.ADAPTIVE_MAX_FACTOR;
        }

        // Collaborative sessions: snapshot more frequently
        if (entry.userCount > 1) {
            minFactor *= CONFIG.COLLAB_MULTIPLIER;
            maxFactor *= CONFIG.COLLAB_MULTIPLIER;
        }

        entry.adaptiveMinInterval = Math.round(CONFIG.MIN_INTERVAL * minFactor);
        entry.adaptiveMaxInterval = Math.round(CONFIG.MAX_INTERVAL * maxFactor);

        // Clamp to reasonable bounds
        entry.adaptiveMinInterval = Math.max(60000, Math.min(entry.adaptiveMinInterval, 30 * 60 * 1000));
        entry.adaptiveMaxInterval = Math.max(entry.adaptiveMinInterval * 2, Math.min(entry.adaptiveMaxInterval, 2 * 60 * 60 * 1000));
    }

    /**
     * Check if thresholds warrant an immediate snapshot.
     * @private
     */
    _checkThresholds(entry) {
        // Update count threshold
        if (entry.updateCount >= CONFIG.UPDATE_THRESHOLD) {
            return true;
        }

        // Byte count threshold
        if (entry.byteCount >= CONFIG.BYTE_THRESHOLD) {
            return true;
        }

        // Time since last snapshot exceeds adaptive max
        const timeSinceSnapshot = Date.now() - entry.lastSnapshot;
        if (timeSinceSnapshot >= entry.adaptiveMaxInterval) {
            return true;
        }

        return false;
    }

    /**
     * Take a snapshot and reset counters.
     * Only saves if there are real changes to the document.
     * @private
     */
    _takeSnapshot(roomId, entry, trigger) {
        if (!entry.dirty) return;

        // Check for real changes before snapshotting
        if (!this._hasRealChanges(entry.ydoc, entry.lastSnapshotState)) {
            console.log(`[snapshot-scheduler] Skipping snapshot for ${roomId} - no real changes`);
            entry.dirty = false;
            entry.updateCount = 0;
            entry.byteCount = 0;
            return;
        }

        entry.dirty = false;
        entry.lastSnapshot = Date.now();

        const description = this._generateDescription(entry, trigger);

        try {
            this.save(roomId, entry.fileId, entry.ydoc, trigger, null, description);
            // Update the last snapshot state after successful save
            entry.lastSnapshotState = Y.encodeStateAsUpdate(entry.ydoc);
        } catch (err) {
            console.error(`[snapshot-scheduler] Failed to save snapshot for ${roomId}:`, err);
        }

        // Reset counters
        entry.updateCount = 0;
        entry.byteCount = 0;
    }

    /**
     * Generate a human-readable description for the snapshot.
     * @private
     */
    _generateDescription(entry, trigger) {
        const parts = [];

        if (entry.updateCount > 0) {
            parts.push(`${entry.updateCount} updates`);
        }
        if (entry.byteCount > 0) {
            parts.push(`${Math.round(entry.byteCount / 1024)}KB`);
        }
        if (entry.userCount > 1) {
            parts.push(`${entry.userCount} users`);
        }
        if (entry.editRate > 0) {
            parts.push(`${entry.editRate.toFixed(1)} edits/min`);
        }

        if (parts.length === 0) return null;
        return parts.join(', ');
    }

    /**
     * Start periodic retention cleanup.
     * @private
     */
    _startRetentionCleanup() {
        // Run cleanup every hour
        setInterval(() => {
            this._runRetentionCleanup();
        }, 60 * 60 * 1000);

        // Also run on startup after a short delay
        setTimeout(() => {
            this._runRetentionCleanup();
        }, 10000);
    }

    /**
     * Clean up old snapshots based on retention policy.
     * @private
     */
    _runRetentionCleanup() {
        if (!this.sqliteDb) {
            return;
        }

        try {
            const now = Date.now();
            const cutoffTime = now - CONFIG.RETENTION_AGE_MS;

            // Delete snapshots older than retention age (except manual ones)
            const ageResult = this.sqliteDb.prepare(`
                DELETE FROM snapshots
                WHERE created_at < ?
                AND trigger != 'manual'
            `).run(cutoffTime);

            if (ageResult.changes > 0) {
                console.log(`[snapshot-scheduler] Cleaned up ${ageResult.changes} old snapshots (age-based)`);
            }

            // Keep only RETENTION_COUNT most recent snapshots per file
            // (excluding manual snapshots which are always kept)
            const countResult = this.sqliteDb.prepare(`
                DELETE FROM snapshots
                WHERE id IN (
                    SELECT id FROM snapshots
                    WHERE trigger != 'manual'
                    ORDER BY created_at DESC
                    LIMIT -1 OFFSET ?
                )
            `).run(CONFIG.RETENTION_COUNT);

            if (countResult.changes > 0) {
                console.log(`[snapshot-scheduler] Cleaned up ${countResult.changes} excess snapshots (count-based)`);
            }
        } catch (err) {
            console.error('[snapshot-scheduler] Retention cleanup error:', err);
        }
    }

    /**
     * Get statistics about a room's snapshot state.
     * Useful for debugging and monitoring.
     */
    getStats(roomId) {
        const entry = this.rooms.get(roomId);
        if (!entry) return null;

        return {
            dirty: entry.dirty,
            updateCount: entry.updateCount,
            byteCount: entry.byteCount,
            userCount: entry.userCount,
            editRate: Math.round(entry.editRate * 10) / 10,
            adaptiveMinInterval: Math.round(entry.adaptiveMinInterval / 1000) + 's',
            adaptiveMaxInterval: Math.round(entry.adaptiveMaxInterval / 60000) + 'min',
            timeSinceLastSnapshot: Math.round((Date.now() - entry.lastSnapshot) / 1000) + 's',
            sessionLength: Math.round((Date.now() - entry.sessionStart) / 60000) + 'min',
        };
    }
}
