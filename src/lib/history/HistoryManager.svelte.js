/**
 * HistoryManager — per-workspace coordinator for document history.
 *
 * Owns the snapshot list (loaded from server, includes server-computed diff_json),
 * last-edit state (from Yjs server file_meta), viewer open/close state,
 * and snapshot create/restore operations.
 *
 * Designed for Svelte 5 runes ($state).
 */

import { interpretDiff } from './diffInterpreters.js';

export class HistoryManager {
    /**
     * @param {{
     *   fileId: string,
     *   registry: import('../FileRegistry/FileRegistry.js').FileRegistry,
     *   appType: string,
     * }} opts
     */
    constructor({ fileId, registry, appType }) {
        this.fileId  = fileId;
        this.registry = registry;
        this.appType = appType;

        // Reactive state (Svelte 5 runes — read via $state proxy on instances)
        this.snapshots      = $state(/** @type {import('../FileRegistry/api/YjsServerAPI.js').SnapshotMeta[]} */ ([]));
        this.lastEdit       = $state(/** @type {{ by: string, at: number } | null} */ (null));
        this.loading        = $state(false);
        this.viewerOpen     = $state(false);
        this.selectedSnap   = $state(/** @type {import('../FileRegistry/api/YjsServerAPI.js').SnapshotMeta | null} */ (null));
        this.restoring      = $state(false);
        this.error          = $state(/** @type {string|null} */ (null));
    }

    /** Load the snapshot list from the server (no binary downloads). */
    async loadSnapshots() {
        this.loading = true;
        this.error = null;
        try {
            const snaps = await this.registry.listSnapshots(this.fileId);
            this.snapshots = snaps;
        } catch (err) {
            this.error = err.message;
        } finally {
            this.loading = false;
        }
    }

    /** Load last-edit metadata from the Yjs server. */
    async loadFileMeta() {
        try {
            const meta = await this.registry.getFileMeta(this.fileId);
            if (meta?.last_edit_at) {
                this.lastEdit = { by: meta.last_edit_by, at: meta.last_edit_at };
            }
        } catch { /* silently ignore — last-edit is non-critical */ }
    }

    /**
     * Update last-edit state locally (called by LastEditTracker on each content change).
     * @param {string} username
     */
    notifyLocalEdit(username) {
        this.lastEdit = { by: username, at: Date.now() };
    }

    /** Open the history viewer for a specific snapshot. */
    selectSnapshot(snap) {
        this.selectedSnap = snap;
        this.viewerOpen = true;
    }

    closeViewer() {
        this.viewerOpen = false;
        this.selectedSnap = null;
    }

    /**
     * Create a manual snapshot with an optional label.
     * @param {string|null} description
     * @returns {Promise<void>}
     */
    async createSnapshot(description = null) {
        try {
            await this.registry.createSnapshot(this.fileId, description, this.appType);
            await this.loadSnapshots();
        } catch (err) {
            this.error = `Failed to save version: ${err.message}`;
        }
    }

    /**
     * Restore a snapshot to the live document.
     * @param {string} snapshotId
     */
    async restoreSnapshot(snapshotId) {
        this.restoring = true;
        try {
            await this.registry.restoreSnapshot(this.fileId, snapshotId);
            this.closeViewer();
            await this.loadSnapshots();
        } catch (err) {
            this.error = `Failed to restore: ${err.message}`;
        } finally {
            this.restoring = false;
        }
    }

    /**
     * Get the snapshot immediately before a given one (for "vs previous" diff).
     * @param {string} snapshotId
     * @returns {import('../FileRegistry/api/YjsServerAPI.js').SnapshotMeta | null}
     */
    getPreviousSnapshot(snapshotId) {
        const idx = this.snapshots.findIndex(s => s.id === snapshotId);
        return idx >= 0 && idx < this.snapshots.length - 1 ? this.snapshots[idx + 1] : null;
    }

    /**
     * Interpret a snapshot's server diff JSON into a human-readable summary.
     * @param {import('../FileRegistry/api/YjsServerAPI.js').SnapshotMeta} snap
     * @returns {{ summary: string, changeCount: number }}
     */
    interpretSnapshotDiff(snap) {
        return interpretDiff(snap.app_type ?? this.appType, snap.diff_json);
    }
}
