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
     *   adapter?: { ViewerComponent: any } | null,
     *   onAfterRestore?: (() => Promise<void>) | null,
     *   getSchemaVersion?: (() => number | null) | null,
     * }} opts
     */
    constructor({ fileId, registry, appType, adapter = null, onAfterRestore = null, getSchemaVersion = null }) {
        this.fileId  = fileId;
        this.registry = registry;
        this.appType = appType;
        /** Returns the integer schema version of the live doc, or null. @type {(() => number|null)|null} */
        this.getSchemaVersion = getSchemaVersion;

        /**
         * App-specific adapter for visual rendering.
         * Shape: { ViewerComponent }
         * @type {{ ViewerComponent: any } | null}
         */
        this.adapter = adapter;

        /** Optional async callback invoked after a successful restore. @type {(() => Promise<void>)|null} */
        this.onAfterRestore = onAfterRestore;

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

    /**
     * Called by the YjsRuntime fileMeta sideband when the server pushes
     * { last_edit_at, last_edit_by }.  This replaces both the old
     * loadFileMeta() REST poll and the LastEditTracker local-watch approach.
     * @param {{ last_edit_at: number, last_edit_by: string|null }} meta
     */
    receiveFileMeta(meta) {
        if (meta?.last_edit_at) {
            this.lastEdit = { by: meta.last_edit_by ?? null, at: meta.last_edit_at };
        }
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
            const sv = this.getSchemaVersion?.() ?? null;
            await this.registry.createSnapshot(this.fileId, description, this.appType, sv);
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
            // Let the workspace reload the session against the new Yjs room before
            // closing the viewer, so the user lands on a live document.
            if (this.onAfterRestore) await this.onAfterRestore();
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
     * Used by docs/svg apps that still register generic interpreters.
     * Not used by the spreadsheet viewer (which reads diff.totals directly).
     * @param {import('../FileRegistry/api/YjsServerAPI.js').SnapshotMeta} snap
     * @returns {{ summary: string, changeCount: number }}
     */
    interpretSnapshotDiff(snap) {
        return interpretDiff(snap.app_type ?? this.appType, snap.diff_json);
    }

    /**
     * Fetch the precomputed diff JSON for a snapshot from the server.
     * The snapshot list no longer includes diff_json (slim response).
     * @param {import('../FileRegistry/api/YjsServerAPI.js').SnapshotMeta} snap
     * @returns {Promise<object|null>} parsed diff object
     */
    async fetchDiff(snap) {
        if (!snap?.id) return null;
        try {
            return await this.registry.getSnapshotDiff(this.fileId, snap.id);
        } catch {
            return null;
        }
    }
}
