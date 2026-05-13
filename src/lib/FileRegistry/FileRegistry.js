/**
 * FileRegistry - Central client for the file storage system.
 *
 * Provides two storage views:
 *   registry.app   - app-scoped flat list (files owned by or shared with the user, for this app)
 *   registry.drive - user's drive (hierarchical folders, browsable tree)
 *   registry.users - user directory (for sharing UI)
 *
 * Offline support:
 *   - All basic file/folder operations (create, rename, delete, move) work offline.
 *   - Offline creates use client-generated UUIDs so the file is usable immediately.
 *   - All mutations are queued in a shared IndexedDB and replayed when back online.
 *   - Multiple apps on the same domain share one drive cache and mutation queue.
 *
 * Lifecycle:
 *   1. `new FileRegistry(options)` - create instance
 *   2. `await registry.init()`    - loads IndexedDB cache instantly, syncs in background
 *   3. Use `registry.app.*` and `registry.drive.*` immediately
 *   4. `await registry.shutdown()` when done
 *
 * Events (via registry.on / registry.off):
 *   'change'      - data changed (files or folders updated); re-read from registry
 *   'sync'        - background sync completed successfully
 *   'auth-error'  - server returned 401; re-authenticate
 */

import * as Y from 'yjs';
import { StorageAPI } from './api/StorageAPI.js';
import { YjsServerAPI } from './api/YjsServerAPI.js';
import { LocalStore } from './core/LocalStore.js';
import { YjsRuntime } from './core/YjsRuntime.js';
import { BlobCache } from './core/BlobCache.js';
import { OfflineSyncStore } from './core/OfflineSyncStore.js';
import { OfflineMutationQueue } from './core/OfflineMutationQueue.js';
import { YjsSyncCoordinator } from './core/YjsSyncCoordinator.js';

// Deterministic color from username so presence color is consistent
const _PRESENCE_COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#16a085', '#d35400', '#2980b9',
];
function _userColor(username) {
    let h = 0;
    for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
    return _PRESENCE_COLORS[h % _PRESENCE_COLORS.length];
}

// ============================================================
// Internal EventEmitter
// ============================================================

class EventEmitter {
    constructor() { this._handlers = new Map(); }

    on(event, fn) {
        if (!this._handlers.has(event)) this._handlers.set(event, []);
        this._handlers.get(event).push(fn);
    }

    off(event, fn) {
        const list = this._handlers.get(event);
        if (!list) return;
        const i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
    }

    emit(event, data) {
        this._handlers.get(event)?.forEach(fn => fn(data));
    }
}

// ============================================================
// AppView
// ============================================================

/**
 * View into app-scoped files for a specific app.
 * App files are a flat list (no folder hierarchy).
 * Every file must have `app === appName`.
 */
class AppView {
    /** @param {FileRegistry} registry @param {string} appName */
    constructor(registry, appName) {
        this._r = registry;
        this._appName = appName;
    }

    // -------------------------------------------------------
    // Query
    // -------------------------------------------------------

    /**
     * All app-scoped files for this app (owned + shared with you).
     * Available immediately after init(), before sync completes.
     * @returns {FileDescriptor[]}
     */
    list() {
        return [...this._r._files.values()].filter(f => f.scope === 'app' && f.app === this._appName && !f.deleted);
    }

    /** @param {string} id @returns {FileDescriptor|null} */
    get(id) {
        const f = this._r._files.get(id);
        return f && !f.deleted ? f : null;
    }

    /**
     * All attachments of a parent file.
     * @param {string} parentId
     * @returns {FileDescriptor[]}
     */
    getAttachments(parentId) {
        return [...this._r._files.values()].filter(f => f.parentId === parentId && !f.deleted);
    }

    // -------------------------------------------------------
    // Create
    // -------------------------------------------------------

    /**
     * Create a new Yjs file.
     * Works offline: uses client-generated IDs and queues a mutation for later sync.
     * @param {{ title?: string, parentId?: string|null, publicRead?: boolean, publicWrite?: boolean }} [opts]
     * @returns {Promise<FileDescriptor>}
     */
    async createFile(opts = {}) {
        if (!navigator.onLine) {
            return this._r._createFileOffline({
                title: opts.title ?? 'Untitled',
                type: 'yjs',
                scope: 'app',
                app: this._appName,
                parentId: opts.parentId ?? null,
                publicRead: opts.publicRead ?? false,
                publicWrite: opts.publicWrite ?? false,
            });
        }
        const file = await this._r._api.createFile({
            title: opts.title ?? 'Untitled',
            type: 'yjs',
            scope: 'app',
            app: this._appName,
            parentId: opts.parentId ?? null,
            publicRead: opts.publicRead ?? false,
            publicWrite: opts.publicWrite ?? false,
        });
        this._r._upsertFile(file);
        return file;
    }

    /**
     * Create a new blob file and upload its content.
     * Requires network access (blob upload cannot be deferred).
     * @param {{ title?: string, file: File|Blob, filename?: string, parentId?: string|null, publicRead?: boolean, publicWrite?: boolean }} opts
     * @returns {Promise<FileDescriptor>}
     */
    async createBlob(opts) {
        return this._r._createBlobFile({ ...opts, scope: 'app', app: this._appName });
    }

    /**
     * Create an attachment (yjs or blob) under a parent file.
     * @param {{ parentId: string, title?: string, type?: 'yjs'|'blob', file?: File|Blob, publicRead?: boolean, publicWrite?: boolean }} opts
     * @returns {Promise<FileDescriptor>}
     */
    async createAttachment(opts) {
        if (opts.type === 'blob' && opts.file) {
            return this._r._createBlobFile({ ...opts, scope: 'app', app: this._appName });
        }
        if (!navigator.onLine) {
            return this._r._createFileOffline({
                title: opts.title ?? 'Untitled',
                type: opts.type ?? 'yjs',
                scope: 'app',
                app: this._appName,
                parentId: opts.parentId,
                publicRead: opts.publicRead ?? false,
                publicWrite: opts.publicWrite ?? false,
            });
        }
        const file = await this._r._api.createFile({
            title: opts.title ?? 'Untitled',
            type: opts.type ?? 'yjs',
            scope: 'app',
            app: this._appName,
            parentId: opts.parentId,
            publicRead: opts.publicRead ?? false,
            publicWrite: opts.publicWrite ?? false,
        });
        this._r._upsertFile(file);
        return file;
    }

    // -------------------------------------------------------
    // Load (Yjs)
    // -------------------------------------------------------

    /**
     * Load a Yjs document. Records this file as recently opened.
     * @param {string} id
     * @returns {Promise<import('yjs').Doc>}
     */
    async loadDoc(id) {
        const file = this.get(id);
        if (!file) throw new Error(`File not found: ${id}`);
        if (file.type !== 'yjs') throw new Error(`Not a Yjs file: ${id}`);
        this._r._recordOpen(id);
        return this._r._runtime.load(id, file.roomId);
    }

    /**
     * Get an already-loaded Yjs doc synchronously.
     * @param {string} id
     * @returns {import('yjs').Doc|null}
     */
    getDoc(id) { return this._r._runtime.get(id); }

    // -------------------------------------------------------
    // Blob
    // -------------------------------------------------------

    /** Returns the authenticated URL for downloading a blob. @param {string} id @returns {string} */
    getBlobUrl(id) { return this._r._api.getBlobUrl(id); }

    /** Returns the authenticated stream URL (Content-Disposition: inline) for a blob. @param {string} id @returns {string} */
    getStreamUrl(id) { return this._r._api.getStreamUrl(id); }

    /**
     * Return the descriptor for a blob, fetching metadata from the server via
     * GET request (headers only) if the file is not in the local registry.
     * Deduplicates concurrent calls. Permanently skips blobs that fail so callers
     * in render loops don't cause infinite retries.
     * @param {string} id
     * @returns {Promise<import('./FileRegistry').FileDescriptor|null>}
     */
    async resolveBlob(id) {
        const cached = this.get(id);
        if (cached) return cached;

        // Deduplicate concurrent resolves for the same id.
        if (this._resolveCache) {
            if (this._resolveCache.failed.has(id)) return null;
            if (this._resolveCache.pending.has(id)) return this._resolveCache.pending.get(id);
        } else {
            this._resolveCache = { pending: new Map(), failed: new Set() };
        }

        const promise = this._r._api.fetchBlobInfo(id)
            .catch(() => null)
            .then(info => {
                this._resolveCache.pending.delete(id);
                if (!info) { this._resolveCache.failed.add(id); return null; }
                const now = new Date().toISOString();
                const descriptor = {
                    id,
                    owner:        this._r._options.getUsername?.() ?? 'anonymous',
                    app:          this._appName,
                    title:        info.filename || id,
                    type:         'blob',
                    scope:        'app',
                    folderId:     null,
                    parentId:     null,
                    roomId:       null,
                    blobKey:      id,
                    mimeType:     info.mimeType || null,
                    size:         info.size     ?? null,
                    filename:     info.filename || null,
                    publicRead:   false,
                    publicWrite:  false,
                    deleted:      false,
                    birthtime:    now,
                    mtime:        now,
                    ctime:        now,
                    sharedWith:   [],
                    thumbnailKey: null,
                };
                this._r._upsertFile(descriptor);
                return descriptor;
            });

        this._resolveCache.pending.set(id, promise);
        return promise;
    }

    /** Fetch and cache a blob. Returns cached copy if still fresh. @param {string} id @returns {Promise<Blob>} */
    async fetchBlob(id) {
        const pending = await this._r._getPendingBlob(id);
        if (pending) return pending;
        const file = this.get(id);
        if (!file) throw new Error(`File not found: ${id}`);
        return this._r._blobCache.fetch(file, this._r._api.getBlobUrl(id));
    }

    /** Replace the blob content for an existing blob file. @param {string} id @param {File|Blob} file @returns {Promise<void>} */
    async updateBlob(id, file) {
        await this._r._api.uploadBlob(id, file);
        this._r._blobCache.invalidate?.(id);
    }

    /** Return the blob from cache without network access. Null if not cached. @param {string} id @returns {Promise<Blob|null>} */
    async getCachedBlob(id) {
        const pending = await this._r._getPendingBlob(id);
        if (pending) return pending;
        const file = this.get(id);
        if (!file) return null;
        return this._r._blobCache.getCached(file);
    }

    /** Preemptively cache a list of blob files. @param {string[]} ids */
    prefetchBlobs(ids) {
        const files = ids.map(id => this.get(id)).filter(Boolean);
        return this._r._blobCache.prefetch(files, id => this._r._api.getBlobUrl(id));
    }

    // -------------------------------------------------------
    // Modify
    // -------------------------------------------------------

    /** @returns {Promise<FileDescriptor>} */
    async renameFile(id, title) {
        if (!navigator.onLine) return this._r._renameFileOffline(id, title);
        const file = await this._r._api.renameFile(id, title);
        this._r._upsertFile(file);
        return file;
    }

    /** @returns {Promise<void>} */
    async delete(id) {
        if (!navigator.onLine) return this._r._deleteFileOffline(id);
        await this._r._api.deleteFile(id);
        this._r._markDeleted(id);
    }

    /** @returns {Promise<FileDescriptor>} */
    async share(id, username, permissions = ['read', 'write']) {
        const file = await this._r._api.shareFile(id, username, permissions);
        this._r._upsertFile(file);
        return file;
    }

    /** @returns {Promise<FileDescriptor>} */
    async revoke(id, username) {
        const file = await this._r._api.revokeFile(id, username);
        this._r._upsertFile(file);
        return file;
    }

    /** @returns {Promise<FileDescriptor>} */
    async setPublic(id, publicRead, publicWrite) {
        const file = await this._r._api.setFilePublic(id, publicRead, publicWrite);
        this._r._upsertFile(file);
        return file;
    }

    /** @returns {Promise<FileDescriptor>} */
    async setParent(id, parentId) {
        if (!navigator.onLine) return this._r._setParentOffline(id, parentId);
        const file = await this._r._api.setParent(id, parentId);
        this._r._upsertFile(file);
        return file;
    }

    // -------------------------------------------------------
    // Thumbnail
    // -------------------------------------------------------

    /**
     * Upload a thumbnail image for a file. Accepts any image Blob.
     * @param {string} id @param {Blob} imageBlob @returns {Promise<FileDescriptor>}
     */
    async setThumbnail(id, imageBlob) {
        const file = await this._r._api.setThumbnail(id, imageBlob);
        this._r._upsertFile(file);
        return file;
    }

    /** @returns {Promise<FileDescriptor>} */
    async clearThumbnail(id) {
        const file = await this._r._api.clearThumbnail(id);
        this._r._upsertFile(file);
        return file;
    }

    /** Returns the URL to display a file's thumbnail image. @param {string} id @returns {string} */
    getThumbnailUrl(id) { return this._r._api.getThumbnailUrl(id); }

    // -------------------------------------------------------
    // Content search
    // -------------------------------------------------------

    /**
     * Store plain-text content for server-side search (e.g. extracted from a Yjs doc).
     * @param {string} id @param {string} text @returns {Promise<FileDescriptor>}
     */
    async setSearchText(id, text) {
        return this._r._api.setSearchText(id, text);
    }

    /**
     * Search app-scoped files by title or stored content text.
     * @param {string} query - Minimum 2 characters
     * @returns {Promise<FileDescriptor[]>}
     */
    async search(query) {
        return this._r._api.search(query, { scope: 'app', app: this._appName });
    }
}

// ============================================================
// DriveView
// ============================================================

/**
 * View into the user's drive (hierarchical folder tree).
 * Folders are only present in drive scope.
 */
class DriveView {
    /** @param {FileRegistry} registry */
    constructor(registry) {
        this._r = registry;
    }

    // -------------------------------------------------------
    // Tree navigation
    // -------------------------------------------------------

    /**
     * Contents of a folder (or the root if folderId is null).
     * @param {string|null} folderId
     * @returns {{ folders: Folder[], files: FileDescriptor[] }}
     */
    getContents(folderId = null) {
        return {
            folders: [...this._r._folders.values()].filter(f => f.parentId === folderId),
            files: [...this._r._files.values()].filter(f =>
                f.scope === 'drive' && f.folderId === folderId && !f.deleted
            ),
        };
    }

    /** @param {string} id @returns {Folder|null} */
    getFolder(id) { return this._r._folders.get(id) ?? null; }

    /** @param {string} id @returns {FileDescriptor|null} */
    getFile(id) {
        const f = this._r._files.get(id);
        return f && f.scope === 'drive' && !f.deleted ? f : null;
    }

    /**
     * Find the first drive file with a matching title, optionally within a folder.
     * @param {string} title @param {string|null} [folderId] @returns {FileDescriptor|null}
     */
    findFile(title, folderId = undefined) {
        for (const f of this._r._files.values()) {
            if (f.scope !== 'drive' || f.deleted) continue;
            if (f.title !== title) continue;
            if (folderId !== undefined && f.folderId !== folderId) continue;
            return f;
        }
        return null;
    }

    /**
     * All drive files and folders shared with the current user (not owned).
     * @returns {{ files: FileDescriptor[], folders: Folder[] }}
     */
    sharedWithMe() {
        const username = this._r._username;
        return {
            files: [...this._r._files.values()].filter(f =>
                f.scope === 'drive' && !f.deleted && f.owner !== username &&
                f.sharedWith.some(s => s.username === username)
            ),
            folders: [...this._r._folders.values()].filter(f =>
                f.owner !== username && f.sharedWith.some(s => s.username === username)
            ),
        };
    }

    /**
     * Recently opened drive files across all apps, sorted by when they were opened.
     * Uses a shared cross-app record so opening a file in one app shows up in all apps.
     * @param {number} [limit=10]
     * @returns {FileDescriptor[]}
     */
    recentlyOpened(limit = 10) {
        return this._r._getRecentlyOpened(limit);
    }

    /**
     * All attachments of a drive file.
     * @param {string} parentId @returns {FileDescriptor[]}
     */
    getAttachments(parentId) {
        return [...this._r._files.values()].filter(f => f.parentId === parentId && !f.deleted);
    }

    /** All drive files (flat list, for search/bulk ops). @returns {FileDescriptor[]} */
    listFiles() {
        return [...this._r._files.values()].filter(f => f.scope === 'drive' && !f.deleted);
    }

    /** All soft-deleted drive files (for Trash view). @returns {FileDescriptor[]} */
    listDeletedFiles() {
        return [...this._r._files.values()].filter(f => f.scope === 'drive' && f.deleted === true);
    }

    /** All folders. @returns {Folder[]} */
    listFolders() {
        return [...this._r._folders.values()];
    }

    // -------------------------------------------------------
    // File operations
    // -------------------------------------------------------

    /**
     * Create a new Yjs drive file.
     * Works offline: uses client-generated IDs and queues a mutation for later sync.
     * @returns {Promise<FileDescriptor>}
     */
    async createFile(opts = {}) {
        if (!navigator.onLine) {
            const file = await this._r._createFileOffline({
                title: opts.title ?? 'Untitled',
                type: 'yjs',
                scope: 'drive',
                app: opts.app ?? null,
                folderId: opts.folderId ?? null,
                parentId: opts.parentId ?? null,
                publicRead: opts.publicRead ?? false,
                publicWrite: opts.publicWrite ?? false,
            });
            this._r._recordOpen(file.id);
            return file;
        }
        const file = await this._r._api.createFile({
            title: opts.title ?? 'Untitled',
            type: 'yjs',
            scope: 'drive',
            app: opts.app ?? null,
            folderId: opts.folderId ?? null,
            parentId: opts.parentId ?? null,
            publicRead: opts.publicRead ?? false,
            publicWrite: opts.publicWrite ?? false,
        });
        this._r._upsertFile(file);
        this._r._recordOpen(file.id);
        return file;
    }

    /**
     * Create a new Yjs file and initialize it with the provided initializer function.
     * Works offline: initializer runs locally; doc syncs to server when connection is restored.
     *
     * @param {{ title?: string, app?: string|null, folderId?: string|null, parentId?: string|null, publicRead?: boolean, publicWrite?: boolean, initializer: function(import('yjs').Doc): void }} opts
     * @returns {Promise<FileDescriptor>}
     */
    async createAndInitializeFile(opts) {
        const { initializer, ...fileOpts } = opts;

        if (!navigator.onLine) {
            const file = await this._r._createFileOffline({
                title: fileOpts.title ?? 'Untitled',
                type: 'yjs',
                scope: 'drive',
                app: fileOpts.app ?? null,
                folderId: fileOpts.folderId ?? null,
                parentId: fileOpts.parentId ?? null,
                publicRead: fileOpts.publicRead ?? false,
                publicWrite: fileOpts.publicWrite ?? false,
            });
            // Initialize doc locally; will sync to server when online
            if (initializer && file.roomId) {
                await this._r._runtime.initialize(file.id, file.roomId, initializer);
            }
            this._r._recordOpen(file.id);
            return file;
        }

        const file = await this._r._api.createFile({
            title: fileOpts.title ?? 'Untitled',
            type: 'yjs',
            scope: 'drive',
            app: fileOpts.app ?? null,
            folderId: fileOpts.folderId ?? null,
            parentId: fileOpts.parentId ?? null,
            publicRead: fileOpts.publicRead ?? false,
            publicWrite: fileOpts.publicWrite ?? false,
        });

        if (initializer && file.roomId) {
            await this._r._runtime.initialize(file.id, file.roomId, initializer);
        }

        this._r._upsertFile(file);
        this._r._recordOpen(file.id);
        return file;
    }

    /** @returns {Promise<FileDescriptor>} */
    async createBlob(opts) {
        return this._r._createBlobFile({ ...opts, scope: 'drive' });
    }

    /** @returns {Promise<FileDescriptor>} */
    async createAttachment(opts) {
        if (opts.type === 'blob' && opts.file) {
            return this._r._createBlobFile({ ...opts, scope: 'drive' });
        }
        if (!navigator.onLine) {
            return this._r._createFileOffline({
                title: opts.title ?? 'Untitled',
                type: opts.type ?? 'yjs',
                scope: 'drive',
                parentId: opts.parentId,
                publicRead: opts.publicRead ?? false,
                publicWrite: opts.publicWrite ?? false,
            });
        }
        const file = await this._r._api.createFile({
            title: opts.title ?? 'Untitled',
            type: opts.type ?? 'yjs',
            scope: 'drive',
            parentId: opts.parentId,
            publicRead: opts.publicRead ?? false,
            publicWrite: opts.publicWrite ?? false,
        });
        this._r._upsertFile(file);
        return file;
    }

    // -------------------------------------------------------
    // Load (Yjs)
    // -------------------------------------------------------

    /**
     * Load a Yjs document. Records this file as recently opened unless opts.recordOpen is false.
     * @param {string} id
     * @param {{ recordOpen?: boolean }} [opts]
     * @returns {Promise<import('yjs').Doc>}
     */
    async loadDoc(id, opts = {}) {
        const file = this.getFile(id);
        if (!file) throw new Error(`File not found: ${id}`);
        if (file.type !== 'yjs') throw new Error(`Not a Yjs file: ${id}`);
        if (opts.recordOpen !== false) this._r._recordOpen(id);
        return this._r._runtime.load(id, file.roomId);
    }

    /** @param {string} id @returns {import('yjs').Doc|null} */
    getDoc(id) { return this._r._runtime.get(id); }

    // -------------------------------------------------------
    // Blob
    // -------------------------------------------------------

    getBlobUrl(id) { return this._r._api.getBlobUrl(id); }

    /** Returns the authenticated stream URL (Content-Disposition: inline) for a blob. @param {string} id @returns {string} */
    getStreamUrl(id) { return this._r._api.getStreamUrl(id); }

    async fetchBlob(id) {
        const pending = await this._r._getPendingBlob(id);
        if (pending) return pending;
        const file = this.getFile(id);
        if (!file) throw new Error(`File not found: ${id}`);
        return this._r._blobCache.fetch(file, this._r._api.getBlobUrl(id));
    }

    /** Replace the blob content for an existing blob file. @param {string} id @param {File|Blob} file @returns {Promise<void>} */
    async updateBlob(id, file) {
        await this._r._api.uploadBlob(id, file);
        this._r._blobCache.invalidate?.(id);
    }

    async getCachedBlob(id) {
        const pending = await this._r._getPendingBlob(id);
        if (pending) return pending;
        const file = this.getFile(id);
        if (!file) return null;
        return this._r._blobCache.getCached(file);
    }

    prefetchBlobs(ids) {
        const files = ids.map(id => this.getFile(id)).filter(Boolean);
        return this._r._blobCache.prefetch(files, id => this._r._api.getBlobUrl(id));
    }

    // -------------------------------------------------------
    // Modify files
    // -------------------------------------------------------

    async renameFile(id, title) {
        if (!navigator.onLine) return this._r._renameFileOffline(id, title);
        const file = await this._r._api.renameFile(id, title);
        this._r._upsertFile(file);
        return file;
    }

    async moveFile(id, targetFolderId) {
        if (!navigator.onLine) return this._r._moveFileOffline(id, targetFolderId);
        const file = await this._r._api.moveFile(id, targetFolderId);
        this._r._upsertFile(file);
        return file;
    }

    async deleteFile(id) {
        if (!navigator.onLine) return this._r._deleteFileOffline(id);
        await this._r._api.deleteFile(id);
        this._r._markDeleted(id);
    }

    async restoreFile(id) {
        if (!navigator.onLine) return this._r._restoreFileOffline(id);
        const file = await this._r._api.restoreFile(id);
        this._r._upsertFile(file);
        return file;
    }

    async permanentDeleteFile(id) {
        await this._r._api.permanentDeleteFile(id);
        this._r._files.delete(id);
        this._r._sharedStore?.removeDriveFile(id).catch(() => { });
        this._r._sharedStore?.removePendingBlob(id).catch(() => { });
        this._r._blobCache.invalidate(id).catch(() => { });
        this._r.emit('change');
    }

    async shareFile(id, username, permissions = ['read', 'write']) {
        const file = await this._r._api.shareFile(id, username, permissions);
        this._r._upsertFile(file);
        return file;
    }

    async revokeFile(id, username) {
        const file = await this._r._api.revokeFile(id, username);
        this._r._upsertFile(file);
        return file;
    }

    async setFilePublic(id, publicRead, publicWrite) {
        const file = await this._r._api.setFilePublic(id, publicRead, publicWrite);
        this._r._upsertFile(file);
        return file;
    }

    async setParent(id, parentId) {
        if (!navigator.onLine) return this._r._setParentOffline(id, parentId);
        const file = await this._r._api.setParent(id, parentId);
        this._r._upsertFile(file);
        return file;
    }

    /**
     * Duplicate a drive file. For Yjs files, copies the current document state.
     * For blob files, re-uploads the blob content.
     * @param {string} id
     * @param {{ title?: string, folderId?: string|null }} [opts]
     * @returns {Promise<FileDescriptor>}
     */
    async duplicateFile(id, opts = {}) {
        const file = this.getFile(id);
        if (!file) throw new Error(`File not found: ${id}`);

        const title = opts.title ?? `Copy of ${file.title ?? 'Untitled'}`;
        const folderId = opts.folderId !== undefined ? opts.folderId : file.folderId;

        if (file.type === 'blob') {
            const blob = await this._r._blobCache.fetch(file, this._r._api.getBlobUrl(id));
            return this._r._createBlobFile({
                title,
                file: blob,
                filename: file.filename,
                mimeType: file.mimeType,
                folderId,
                scope: 'drive',
                app: file.app,
            });
        } else {
            const sourceDoc = await this._r._runtime.load(id, file.roomId);
            const update = Y.encodeStateAsUpdate(sourceDoc);
            return this.createAndInitializeFile({
                title,
                folderId,
                app: file.app,
                initializer: (doc) => Y.applyUpdate(doc, update),
            });
        }
    }

    // -------------------------------------------------------
    // Thumbnail
    // -------------------------------------------------------

    /**
     * Upload a thumbnail image for a drive file. Accepts any image Blob.
     * @param {string} id @param {Blob} imageBlob @returns {Promise<FileDescriptor>}
     */
    async setThumbnail(id, imageBlob) {
        const file = await this._r._api.setThumbnail(id, imageBlob);
        this._r._upsertFile(file);
        return file;
    }

    /** @returns {Promise<FileDescriptor>} */
    async clearThumbnail(id) {
        const file = await this._r._api.clearThumbnail(id);
        this._r._upsertFile(file);
        return file;
    }

    /** Returns the URL to display a file's thumbnail image. @param {string} id @returns {string} */
    getThumbnailUrl(id) { return this._r._api.getThumbnailUrl(id); }

    // -------------------------------------------------------
    // Access tracking
    // -------------------------------------------------------

    /**
     * Record that the current user accessed this file.
     * Use for opens that don't go through loadDoc (e.g. blob file preview).
     * @param {string} fileId
     */
    recordOpen(fileId) {
        this._r._recordOpen(fileId);
    }

    // -------------------------------------------------------
    // Content search
    // -------------------------------------------------------

    /**
     * Store plain-text content for server-side search.
     * @param {string} id @param {string} text @returns {Promise<FileDescriptor>}
     */
    async setSearchText(id, text) {
        return this._r._api.setSearchText(id, text);
    }

    /**
     * Search drive files by title or stored content text.
     * @param {string} query - Minimum 2 characters
     * @returns {Promise<FileDescriptor[]>}
     */
    async search(query) {
        return this._r._api.search(query, { scope: 'drive' });
    }

    // -------------------------------------------------------
    // Folder operations
    // -------------------------------------------------------

    async createFolder(opts) {
        if (!navigator.onLine) return this._r._createFolderOffline(opts);
        const folder = await this._r._api.createFolder(opts);
        this._r._upsertFolder(folder);
        return folder;
    }

    async renameFolder(id, name) {
        if (!navigator.onLine) return this._r._renameFolderOffline(id, name);
        const folder = await this._r._api.renameFolder(id, name);
        this._r._upsertFolder(folder);
        return folder;
    }

    async moveFolder(id, targetParentId) {
        if (!navigator.onLine) return this._r._moveFolderOffline(id, targetParentId);
        const folder = await this._r._api.moveFolder(id, targetParentId);
        this._r._upsertFolder(folder);
        return folder;
    }

    async deleteFolder(id) {
        if (!navigator.onLine) {
            await this._r._deleteFolderOffline(id);
            return;
        }
        await this._r._api.deleteFolder(id);
        // Soft-deletes all contained files on server; resync to pick up changes
        await this._r.sync();
    }

    async shareFolder(id, username, permissions = ['read', 'write']) {
        const folder = await this._r._api.shareFolder(id, username, permissions);
        this._r._upsertFolder(folder);
        return folder;
    }

    async revokeFolderShare(id, username) {
        const folder = await this._r._api.revokeFolderShare(id, username);
        this._r._upsertFolder(folder);
        return folder;
    }

    async setFolderPublic(id, publicRead, publicWrite) {
        const folder = await this._r._api.setFolderPublic(id, publicRead, publicWrite);
        this._r._upsertFolder(folder);
        return folder;
    }
}

// ============================================================
// UsersView
// ============================================================

class UsersView {
    constructor(registry) { this._r = registry; }

    /**
     * List all platform users (useful for share UIs).
     * @returns {Promise<{username: string, displayName: string, isAdmin: boolean}[]>}
     */
    list() { return this._r._api.listUsers(); }
}

// ============================================================
// FileRegistry
// ============================================================

export class FileRegistry extends EventEmitter {
    /**
     * @param {object} options
     * @param {string}              options.appName      - Application name (namespaces app scope and IndexedDB)
     * @param {string}              options.baseUrl      - URL to storage.php
     * @param {string}              options.blobUrl      - URL to blob-storage.php
     * @param {string}              options.wsUrl        - Yjs WebSocket server URL
     * @param {() => string|null}   options.getApiKey    - Returns current API key (called on each request)
     * @param {() => string}        options.getUsername  - Returns current username
     * @param {number}             [options.syncInterval=300000] - Background sync interval (ms)
     */
    constructor(options) {
        super();
        this._options = options;
        this._appName = options.appName;
        this._username = 'anonymous';

        this._api = new StorageAPI(options.baseUrl, options.blobUrl, options.getApiKey);
        this._yjsApi = new YjsServerAPI(options.wsUrl, options.getApiKey);
        this._localStore = null;    // per-app IDB (app-scoped files only)
        this._sharedStore = null;   // cross-app IDB (drive cache, mutations, recents)
        this._runtime = new YjsRuntime(options.wsUrl, (docId, { offline }) => {
            this._onYjsDocUpdated(docId, offline);
        }, {
            getApiKey: options.getApiKey,
            getUserInfo: () => ({
                username: this._username,
                color: _userColor(this._username),
            }),
        });
        this._blobCache = new BlobCache();
        this._coordinator = null;
        this._mutationQueue = null;

        // Cross-app BroadcastChannel for drive cache invalidation
        this._driveChannel = null;

        // In-memory per-user access log (cross-app, sourced from shared IDB)
        // mtime lives on the FileDescriptor; only atime (last access) is tracked here.
        /** @type {{ fileId: string, appName: string|null, atime: string }[]} */
        this._recents = [];

        /** @type {Map<string, object>} */
        this._files = new Map();
        /** @type {Map<string, object>} */
        this._folders = new Map();

        this._syncState = { isSyncing: false, lastSync: null, error: null };
        this._syncPromise = null;
        this._syncInterval = null;
        this._initPromise = null;

        this.app = new AppView(this, options.appName);
        this.drive = new DriveView(this);
        this.users = new UsersView(this);
    }

    // -------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------

    /**
     * Initialize: open IndexedDB, load cached data (synchronous path),
     * then kick off a background sync. Safe to call multiple times.
     */
    /** @returns {string} */
    getUsername() { return this._username; }

    async init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInit();
        return this._initPromise;
    }

    async _doInit() {
        this._username = this._options.getUsername?.() ?? 'anonymous';

        // Per-app store (app-scoped files only)
        this._localStore = new LocalStore(this._appName, this._username);
        await this._localStore.open();

        // Shared cross-app store (drive cache, mutations, recents)
        this._sharedStore = new OfflineSyncStore(this._username);
        await this._sharedStore.open();

        // Load drive files from shared cache (all apps see the same drive)
        const [driveFiles, driveFolders] = await Promise.all([
            this._sharedStore.getDriveFiles(),
            this._sharedStore.getDriveFolders(),
        ]);
        // Load all files from per-app LocalStore (may include drive files on first run before migration)
        const localCachedFiles = await this._localStore.getAllFiles();

        for (const f of [...driveFiles, ...localCachedFiles]) this._files.set(f.id, f);
        for (const f of driveFolders) this._folders.set(f.id, f);

        // Load cross-app recents into memory
        this._recents = await this._sharedStore.getRecents(100);

        this.emit('change');

        // BroadcastChannel: cross-tab / cross-app drive updates
        this._setupDriveChannel();

        // Offline mutation queue (shared IDB, Web Locks for leader election)
        this._mutationQueue = new OfflineMutationQueue({
            username: this._username,
            store: this._sharedStore,
            api: this._api,
            onFileUpdate: (file) => this._upsertFile(file),
            onFolderUpdate: (folder) => this._upsertFolder(folder),
        });

        // Yjs sync coordinator (handles Yjs offline edits and touch queue)
        this._coordinator = new YjsSyncCoordinator({
            username: this._username,
            pendingStore: this._sharedStore,
            api: this._api,
            runtime: this._runtime,
            getApiKey: this._options.getApiKey,
        });
        this._coordinator.start();

        // Network + background sync
        this._setupNetworkListeners();
        this._startSyncInterval();
        if (navigator.onLine) {
            this._mutationQueue.flush().catch(() => { });
            this.sync().catch(() => { });
        }
    }

    /**
     * Trigger a full sync with the server immediately.
     * Safe to call multiple times concurrently (deduped).
     * @returns {Promise<void>}
     */
    async sync() {
        if (this._syncPromise) return this._syncPromise;
        if (!navigator.onLine) return;
        if (!this._sharedStore) return; // init() not yet complete
        this._syncPromise = this._doSync().finally(() => { this._syncPromise = null; });
        return this._syncPromise;
    }

    async _doSync() {
        this._syncState.isSyncing = true;
        this.emit('change'); // Announce sync started so UI shows syncing state
        try {
            const { files, folders, recents } = await this._api.fullSync();

            const driveFiles = files.filter(f => f.scope === 'drive');
            const appFiles = files.filter(f => f.scope !== 'drive');

            // Update shared drive cache (other apps on same domain benefit)
            await this._sharedStore.replaceDrive(driveFiles, folders);
            // Update per-app cache (app-scoped files only)
            await this._localStore.replaceAll(appFiles, []);

            // In-memory update
            this._files.clear();
            this._folders.clear();
            for (const f of files) this._files.set(f.id, f);
            for (const f of folders) this._folders.set(f.id, f);

            // Merge server recents (cross-device sync)
            if (recents?.length) {
                // mergeRecents accepts both camelCase and snake_case field names
                await this._sharedStore.mergeRecents(/** @type {any} */(recents));
                this._mergeServerRecents(recents);
            }

            // Tell other open apps that drive data is fresh
            this._driveChannel?.postMessage({ type: 'drive_synced' });

            this._syncState.lastSync = new Date();
            this._syncState.error = null;
            this._syncState.isSyncing = false; // Set false BEFORE emit so UI sees correct state
            this.emit('change');
            this.emit('sync');
        } catch (err) {
            this._syncState.error = err;
            this._syncState.isSyncing = false; // Set false BEFORE emit so UI sees correct state
            this.emit('change'); // Announce sync ended so UI updates
            if (err.message === 'AUTH_EXPIRED') this.emit('auth-error', err);
            throw err;
        }
    }

    /** @returns {{ isSyncing: boolean, lastSync: Date|null, error: Error|null }} */
    getSyncState() { return { ...this._syncState }; }

    // -------------------------------------------------------
    // Awareness / presence
    // -------------------------------------------------------

    /**
     * Returns the Yjs Awareness instance for an open document.
     * @param {string} fileId @returns {object|null}
     */
    getAwareness(fileId) {
        return this._runtime.getAwareness(fileId);
    }

    // -------------------------------------------------------
    // Snapshot / history
    // -------------------------------------------------------

    /**
     * List snapshots for a file. Proxied through storage.php for access control.
     * @param {string} fileId @returns {Promise<import('./api/StorageAPI.js').SnapshotMeta[]>}
     */
    async listSnapshots(fileId) {
        const file = this._files.get(fileId);
        if (!file) return [];
        return this._api.listSnapshots(fileId);
    }

    /**
     * Create a manual snapshot of an actively open document.
     * @param {string} fileId
     * @param {string} [description]
     * @param {string|null} [appType]  'sheets' | 'docs' | 'svg'
     * @returns {Promise<{ id: string }>}
     */
    async createSnapshot(fileId, description, appType) {
        const file = this._files.get(fileId);
        if (!file?.roomId) throw new Error('No active room for file');
        return this._yjsApi.createSnapshot(file.roomId, description, appType ?? null);
    }

    /**
     * Get last-edit metadata for a file from the Yjs server.
     * @param {string} fileId
     * @returns {Promise<{ last_edit_at: number|null, last_edit_by: string|null }>}
     */
    async getFileMeta(fileId) {
        return this._yjsApi.getFileMeta(fileId);
    }

    /**
     * Fetch the raw Yjs binary state for a snapshot.
     * @param {string} fileId @param {string} snapshotId @returns {Promise<Uint8Array>}
     */
    async getSnapshotData(fileId, snapshotId) {
        return this._api.getSnapshotData(fileId, snapshotId);
    }

    /**
     * Restore a snapshot:
     *   1. storage.php validates access, asks the Yjs server to create a new room
     *      pre-loaded with the snapshot state, and updates the file's roomId atomically.
     *   2. Reconnects the local Y.Doc to the new room (clearing old IndexedDB data).
     *
     * @param {string} fileId @param {string} snapshotId @returns {Promise<object>}
     */
    async restoreSnapshot(fileId, snapshotId) {
        const updatedFile = await this._api.restoreVersion(fileId, snapshotId);
        this._upsertFile(updatedFile);
        await this._runtime.clearAndSwitchRoom(fileId, updatedFile.roomId);
        return updatedFile;
    }

    async shutdown() {
        this._stopSyncInterval();
        this._removeNetworkListeners();
        this._coordinator?.shutdown();
        this._mutationQueue?.shutdown();
        this._driveChannel?.close();
        this._runtime.shutdown();
        this._localStore?.close();
        this._sharedStore?.close();
        this._files.clear();
        this._folders.clear();
        this._recents = [];
        this._initPromise = null;
    }

    // -------------------------------------------------------
    // Internal: offline mutation helpers
    // -------------------------------------------------------

    /**
     * Create a file descriptor locally (offline-first).
     * Generates client-side UUIDs so the file is immediately usable.
     * Queues a 'create_file' mutation to sync to the server later.
     * Internal: called from AppView and DriveView.
     */
    async _createFileOffline(opts) {
        const id = crypto.randomUUID();
        const roomId = opts.type === 'yjs' ? crypto.randomUUID() : null;
        const now = new Date().toISOString();

        const file = {
            id,
            owner: this._username,
            app: opts.app ?? null,
            title: opts.title ?? 'Untitled',
            type: opts.type ?? 'yjs',
            scope: opts.scope ?? 'drive',
            folderId: opts.folderId ?? null,
            parentId: opts.parentId ?? null,
            roomId,
            blobKey: opts.type === 'blob' ? id : null,
            mimeType: null,
            size: null,
            filename: null,
            publicRead: opts.publicRead ?? false,
            publicWrite: opts.publicWrite ?? false,
            deleted: false,
            birthtime: now,
            mtime: now,
            ctime: now,
            sharedWith: [],
            thumbnailKey: null,
        };

        // Persist and queue
        this._files.set(file.id, file);
        await this._persistFile(file);
        await this._mutationQueue.enqueue('create_file', {
            id,
            roomId,
            title: file.title,
            type: file.type,
            scope: file.scope,
            app: file.app,
            folderId: file.folderId,
            parentId: file.parentId,
            publicRead: file.publicRead,
            publicWrite: file.publicWrite,
        });
        this._broadcastDriveFile(file);
        this.emit('change');
        return file;
    }

    async _createFolderOffline(opts) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const folder = {
            id,
            owner: this._username,
            name: opts.name ?? 'New Folder',
            parentId: opts.parentId ?? null,
            publicRead: opts.publicRead ?? false,
            publicWrite: opts.publicWrite ?? false,
            birthtime: now,
            ctime: now,
            sharedWith: [],
        };

        this._folders.set(folder.id, folder);
        await this._sharedStore.putDriveFolder(folder);
        await this._mutationQueue.enqueue('create_folder', {
            id,
            name: folder.name,
            parentId: folder.parentId,
            publicRead: folder.publicRead,
            publicWrite: folder.publicWrite,
        });
        this._driveChannel?.postMessage({ type: 'drive_folder_updated', folder });
        this.emit('change');
        return folder;
    }

    async _renameFileOffline(id, title) {
        const file = this._files.get(id);
        if (!file) throw new Error(`File not found: ${id}`);
        const updated = { ...file, title, ctime: new Date().toISOString() };
        this._files.set(id, updated);
        await this._persistFile(updated);
        await this._mutationQueue.enqueue('rename_file', { id, title });
        this._broadcastDriveFile(updated);
        this.emit('change');
        return updated;
    }

    async _renameFolderOffline(id, name) {
        const folder = this._folders.get(id);
        if (!folder) throw new Error(`Folder not found: ${id}`);
        const updated = { ...folder, name, ctime: new Date().toISOString() };
        this._folders.set(id, updated);
        await this._sharedStore.putDriveFolder(updated);
        await this._mutationQueue.enqueue('rename_folder', { id, name });
        this._driveChannel?.postMessage({ type: 'drive_folder_updated', folder: updated });
        this.emit('change');
        return updated;
    }

    async _deleteFileOffline(id) {
        const file = this._files.get(id);
        if (!file) return;
        const updated = { ...file, deleted: true, ctime: new Date().toISOString() };
        this._files.set(id, updated);
        await this._persistFile(updated);
        await this._mutationQueue.enqueue('delete_file', { id });
        this._broadcastDriveFile(updated);
        this.emit('change');
    }

    async _deleteFolderOffline(id) {
        // Collect all descendant folder IDs (mirrors the server's folder_closure logic)
        const allFolderIds = new Set([id]);
        let frontier = [id];
        while (frontier.length) {
            const next = [];
            for (const fid of frontier) {
                for (const f of this._folders.values()) {
                    if (f.parentId === fid && !allFolderIds.has(f.id)) {
                        allFolderIds.add(f.id);
                        next.push(f.id);
                    }
                }
            }
            frontier = next;
        }

        // Remove all descendant folders from memory and IDB
        for (const fid of allFolderIds) {
            this._folders.delete(fid);
            await this._sharedStore.removeDriveFolder(fid);
        }

        // Soft-delete all files in any of those folders
        const now = new Date().toISOString();
        for (const f of this._files.values()) {
            if (f.folderId && allFolderIds.has(f.folderId) && !f.deleted) {
                const updated = { ...f, deleted: true, ctime: now };
                this._files.set(f.id, updated);
                await this._persistFile(updated);
            }
        }

        await this._mutationQueue.enqueue('delete_folder', { id });
        this._driveChannel?.postMessage({ type: 'drive_folder_deleted', id });
        this.emit('change');
    }

    async _restoreFileOffline(id) {
        const file = this._files.get(id);
        if (!file) throw new Error(`File not found: ${id}`);
        const updated = { ...file, deleted: false, ctime: new Date().toISOString() };
        this._files.set(id, updated);
        await this._persistFile(updated);
        await this._mutationQueue.enqueue('restore_file', { id });
        this._broadcastDriveFile(updated);
        this.emit('change');
        return updated;
    }

    async _moveFileOffline(id, targetFolderId) {
        const file = this._files.get(id);
        if (!file) throw new Error(`File not found: ${id}`);
        const updated = { ...file, folderId: targetFolderId, ctime: new Date().toISOString() };
        this._files.set(id, updated);
        await this._persistFile(updated);
        await this._mutationQueue.enqueue('move_file', { id, targetFolderId });
        this._broadcastDriveFile(updated);
        this.emit('change');
        return updated;
    }

    async _moveFolderOffline(id, targetParentId) {
        const folder = this._folders.get(id);
        if (!folder) throw new Error(`Folder not found: ${id}`);
        const updated = { ...folder, parentId: targetParentId, ctime: new Date().toISOString() };
        this._folders.set(id, updated);
        await this._sharedStore.putDriveFolder(updated);
        await this._mutationQueue.enqueue('move_folder', { id, targetParentId });
        this._driveChannel?.postMessage({ type: 'drive_folder_updated', folder: updated });
        this.emit('change');
        return updated;
    }

    async _setParentOffline(id, parentId) {
        const file = this._files.get(id);
        if (!file) throw new Error(`File not found: ${id}`);
        const updated = { ...file, parentId, ctime: new Date().toISOString() };
        this._files.set(id, updated);
        await this._persistFile(updated);
        await this._mutationQueue.enqueue('set_parent', { id, parentId });
        this._broadcastDriveFile(updated);
        this.emit('change');
        return updated;
    }

    // -------------------------------------------------------
    // Internal mutations (shared by AppView + DriveView)
    // -------------------------------------------------------

    _upsertFile(file) {
        this._files.set(file.id, file);
        this._persistFile(file).catch(() => { });
        this._broadcastDriveFile(file);
        this.emit('change');
    }

    _upsertFolder(folder) {
        this._folders.set(folder.id, folder);
        this._sharedStore?.putDriveFolder(folder).catch(() => { });
        this._driveChannel?.postMessage({ type: 'drive_folder_updated', folder });
        this.emit('change');
    }

    _markDeleted(id) {
        const f = this._files.get(id);
        if (f) {
            const updated = { ...f, deleted: true };
            this._files.set(id, updated);
            this._persistFile(updated).catch(() => { });
            this._broadcastDriveFile(updated);
        }
        this.emit('change');
    }

    /** Route file persistence to the correct store based on scope. @private */
    async _persistFile(file) {
        if (!file) return;
        if (file.scope === 'drive') {
            await this._sharedStore?.putDriveFile(file);
        } else {
            await this._localStore?.putFile(file);
        }
    }

    /**
     * Create a blob file: register metadata, upload content, then index.
     * Cleans up orphaned server metadata if upload fails.
     * Internal: called from AppView and DriveView.
     */
    async _createBlobFile(opts) {
        if (!navigator.onLine) return this._createBlobFileOffline(opts);

        const { file, title, scope, app, folderId, parentId, publicRead, publicWrite } = opts;

        const descriptor = await this._api.createFile({
            title: title ?? file.name ?? 'Untitled',
            type: 'blob',
            scope,
            app: app ?? null,
            folderId: folderId ?? null,
            parentId: parentId ?? null,
            mimeType: file.type || null,
            size: file.size ?? null,
            filename: file.name ?? null,
            publicRead: publicRead ?? false,
            publicWrite: publicWrite ?? false,
        });

        try {
            await this._api.uploadBlob(descriptor.id, file);
        } catch (err) {
            this._api.deleteFile(descriptor.id).catch(() => { });
            throw err;
        }

        await this._blobCache.invalidate(descriptor.id);
        this._upsertFile(descriptor);
        if (scope === 'drive') this._recordOpen(descriptor.id);
        return descriptor;
    }

    /**
     * Offline path for blob creation: store blob in IDB and queue a mutation.
     * The file is immediately usable locally; the upload is deferred until online.
     * Internal: called from _createBlobFile when offline.
     */
    async _createBlobFileOffline(opts) {
        const { file, title, scope, app, folderId, parentId, publicRead, publicWrite } = opts;
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        const descriptor = {
            id,
            owner: this._username,
            app: app ?? null,
            title: title ?? file?.name ?? 'Untitled',
            type: 'blob',
            scope,
            folderId: folderId ?? null,
            parentId: parentId ?? null,
            roomId: null,
            blobKey: id,
            mimeType: file?.type || null,
            size: file?.size ?? null,
            filename: file?.name ?? null,
            publicRead: publicRead ?? false,
            publicWrite: publicWrite ?? false,
            deleted: false,
            birthtime: now,
            mtime: now,
            ctime: now,
            sharedWith: [],
            thumbnailKey: null,
        };

        this._files.set(id, descriptor);
        await this._persistFile(descriptor);

        // Store blob content in IDB so it survives page reloads
        if (file) {
            await this._sharedStore?.storePendingBlob(id, file, {
                title: descriptor.title, scope, app, folderId, parentId,
                mimeType: descriptor.mimeType, size: descriptor.size,
                filename: descriptor.filename, publicRead, publicWrite,
            });
        }

        await this._mutationQueue?.enqueue('create_blob', {
            id,
            title: descriptor.title,
            type: 'blob',
            scope,
            app: app ?? null,
            folderId: folderId ?? null,
            parentId: parentId ?? null,
            mimeType: descriptor.mimeType,
            size: descriptor.size,
            filename: descriptor.filename,
            publicRead: publicRead ?? false,
            publicWrite: publicWrite ?? false,
        });

        this._broadcastDriveFile(descriptor);
        this.emit('change');
        if (scope === 'drive') this._recordOpen(descriptor.id);
        return descriptor;
    }

    /**
     * Return a pending offline blob from IDB, or null if not found.
     * Internal: used by fetchBlob/getCachedBlob to serve offline-created blobs.
     */
    async _getPendingBlob(id) {
        const entry = await this._sharedStore?.getPendingBlob(id);
        return entry?.blob ?? null;
    }

    // -------------------------------------------------------
    // Yjs doc update handler
    // -------------------------------------------------------

    /**
     * Called by YjsRuntime whenever a local (non-remote) edit happens to a Yjs doc.
     * @param {string} docId @param {boolean} offline
     */
    _onYjsDocUpdated(docId, offline) {
        const file = this._files.get(docId);
        if (!file) return;

        const now = new Date().toISOString();
        const updated = { ...file, mtime: now };
        this._files.set(docId, updated);
        this._persistFile(updated).catch(() => { });
        this.emit('change');

        if (!this._coordinator) return;

        if (offline) {
            this._coordinator.markNeedsSync(docId, file.roomId, this._options.wsUrl)
                .catch(() => { });
        }

        this._coordinator.queueTouch(docId).catch(() => { });
    }

    // -------------------------------------------------------
    // Cross-app drive BroadcastChannel
    // -------------------------------------------------------

    _setupDriveChannel() {
        if (typeof BroadcastChannel === 'undefined') return;
        this._driveChannel = new BroadcastChannel(`fileregistry_drive_${this._username}`);
        this._driveChannel.onmessage = (e) => {
            const data = e.data;
            if (!data) return;

            if (data.type === 'drive_file_updated' && data.file) {
                // Another app updated a drive file — reflect it in memory
                this._files.set(data.file.id, data.file);
                this.emit('change');
            } else if (data.type === 'drive_folder_updated' && data.folder) {
                this._folders.set(data.folder.id, data.folder);
                this.emit('change');
            } else if (data.type === 'drive_folder_deleted' && data.id) {
                this._folders.delete(data.id);
                this.emit('change');
            } else if (data.type === 'drive_synced') {
                // Another app did a full sync — reload drive from shared store
                this._reloadDriveFromSharedStore().catch(() => { });
            } else if (data.type === 'recents_updated' && data.fileId) {
                // Another tab opened a file — reflect in our in-memory recents immediately
                const { fileId, appName, atime } = data;
                const existing = this._recents.find(r => r.fileId === fileId);
                if (!existing || atime > existing.atime) {
                    this._recents = [
                        { fileId, appName, atime },
                        ...this._recents.filter(r => r.fileId !== fileId),
                    ].slice(0, 100);
                    this.emit('change');
                }
            }
        };
    }

    async _reloadDriveFromSharedStore() {
        const [driveFiles, driveFolders] = await Promise.all([
            this._sharedStore.getDriveFiles(),
            this._sharedStore.getDriveFolders(),
        ]);
        for (const f of driveFiles) this._files.set(f.id, f);
        // Remove drive files that are no longer in the shared store
        for (const [id, f] of this._files) {
            if (f.scope === 'drive' && !driveFiles.find(df => df.id === id)) {
                this._files.delete(id);
            }
        }
        this._folders.clear();
        for (const f of driveFolders) this._folders.set(f.id, f);
        this.emit('change');
    }

    /** Broadcast a drive file update to other open apps. @private */
    _broadcastDriveFile(file) {
        if (file?.scope === 'drive') {
            this._driveChannel?.postMessage({ type: 'drive_file_updated', file });
        }
    }

    // -------------------------------------------------------
    // File access tracking — atime (cross-app, cross-device)
    // mtime lives on the FileDescriptor and is updated by _onYjsDocUpdated / blob uploads.
    // -------------------------------------------------------

    _recordOpen(fileId) {
        const appName = this._appName;
        const atime = new Date().toISOString();

        // Update in-memory list immediately (most-recently-accessed first)
        this._recents = [
            { fileId, appName, atime },
            ...this._recents.filter(r => r.fileId !== fileId),
        ].slice(0, 100);

        // Persist to shared IDB (fire-and-forget)
        this._sharedStore?.recordAccess(fileId, appName).catch(() => { });

        // Notify other open tabs so their recents list updates without waiting for a full sync
        this._driveChannel?.postMessage({ type: 'recents_updated', fileId, appName, atime });

        // Sync to server: immediately if online, otherwise queue (atime travels with the mutation
        // so the server stamps the actual open time rather than the replay time)
        if (navigator.onLine) {
            this._api.recordOpen(fileId, appName, atime).catch(() => { });
        } else {
            this._mutationQueue?.enqueue('record_open', { fileId, appName, atime }).catch(() => { });
        }

        this.emit('change');
    }

    _getRecentlyOpened(limit) {
        // _recents is maintained in atime-descending order; iterate and break early.
        // atime is the current user's own access time — mtime is intentionally excluded
        // because it reflects any user's edits and would violate per-user ordering.
        const result = [];
        for (const rec of this._recents) {
            const f = this._files.get(rec.fileId);
            if (!f || f.deleted || f.scope !== 'drive') continue;
            result.push({ ...f, _activityAt: rec.atime, _activityType: 'opened' });
            if (result.length >= limit) break;
        }
        return result;
    }

    _mergeServerRecents(serverRecents) {
        // Merge server atime entries — keep whichever is newer
        for (const r of serverRecents) {
            const fileId = r.fileId ?? r.file_id;
            const appName = r.appName ?? r.app_name ?? null;
            const atime = r.atime ?? r.openedAt ?? r.opened_at;
            if (!fileId || !atime) continue;
            const existing = this._recents.find(x => x.fileId === fileId);
            if (!existing || atime > existing.atime) {
                this._recents = this._recents.filter(x => x.fileId !== fileId);
                this._recents.push({ fileId, appName, atime });
            }
        }
        this._recents.sort((a, b) => b.atime > a.atime ? 1 : -1); // newest first
        this._recents = this._recents.slice(0, 100);
    }

    // -------------------------------------------------------
    // Network / sync interval
    // -------------------------------------------------------

    _setupNetworkListeners() {
        if (typeof window === 'undefined') return;
        this._onOnline = async () => {
            // Flush queued mutations first, then resync metadata
            await this._mutationQueue?.flush().catch(() => { });
            this.sync().catch(() => { });
        };
        this._onVisible = () => {
            if (document.visibilityState === 'visible' && navigator.onLine) {
                this.sync().catch(() => { });
            }
        };
        window.addEventListener('online', this._onOnline);
        document.addEventListener('visibilitychange', this._onVisible);
    }

    _removeNetworkListeners() {
        if (typeof window === 'undefined') return;
        if (this._onOnline) window.removeEventListener('online', this._onOnline);
        if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
    }

    _startSyncInterval() {
        const ms = this._options.syncInterval ?? 300_000;
        this._syncInterval = setInterval(() => {
            if (navigator.onLine && !this._syncState.isSyncing) this.sync().catch(() => { });
        }, ms);
    }

    _stopSyncInterval() {
        if (this._syncInterval) {
            clearInterval(this._syncInterval);
            this._syncInterval = null;
        }
    }
}

/**
 * @typedef {object} FileDescriptor
 * @property {string}  id
 * @property {string}  owner
 * @property {string|null} app
 * @property {string}  title
 * @property {'yjs'|'blob'} type
 * @property {'drive'|'app'} scope
 * @property {string|null} folderId
 * @property {string|null} parentId
 * @property {string|null} roomId
 * @property {string|null} blobKey
 * @property {string|null} mimeType
 * @property {number|null} size
 * @property {string|null} filename
 * @property {boolean} publicRead
 * @property {boolean} publicWrite
 * @property {boolean} deleted
 * @property {string|null} birthtime - creation time, set once, never changes
 * @property {string|null} mtime     - content modification time (Yjs edits, blob upload)
 * @property {string|null} ctime     - metadata change time (rename, move, delete, share)
 * @property {{username: string, permissions: string[]}[]} sharedWith
 * @property {string|null} thumbnailKey - key used to fetch thumbnail via getThumbnailUrl()
 */

/**
 * @typedef {object} Folder
 * @property {string}  id
 * @property {string}  owner
 * @property {string}  name
 * @property {string|null} parentId
 * @property {boolean} publicRead
 * @property {boolean} publicWrite
 * @property {string|null} birthtime - creation time
 * @property {string|null} ctime     - metadata change time (rename, move)
 * @property {{username: string, permissions: string[]}[]} sharedWith
 */
