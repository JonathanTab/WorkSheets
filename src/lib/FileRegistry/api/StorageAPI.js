/**
 * StorageAPI - HTTP adapter for the storage backend.
 *
 * Auth strategy:
 *   - When `getApiKey()` returns a token → `Authorization: Bearer <token>`
 *   - When `getApiKey()` returns null → no auth header; browser session cookie
 *     handles auth automatically (same-origin requests).
 *
 * Exception: `getBlobUrl()` still appends `?apikey=` when a token is available
 * because <img> / <video> src attributes cannot carry custom headers. For
 * same-origin session auth (token is null) the browser cookie is sent instead.
 */
export class StorageAPI {
    /**
     * @param {string} baseUrl - URL to storage.php
     * @param {string} blobUrl - URL to blob-storage.php
     * @param {() => string|null} getApiKey - returns Bearer token, or null for session auth
     */
    constructor(baseUrl, blobUrl, getApiKey) {
        this.baseUrl   = baseUrl;
        this.blobUrl   = blobUrl;
        this.getApiKey = getApiKey;
    }

    // -------------------------------------------------------
    // Internal
    // -------------------------------------------------------

    /** Build auth headers for fetch calls. */
    _authHeaders() {
        const key = this.getApiKey();
        return key ? { 'Authorization': `Bearer ${key}` } : {};
    }

    async _get(params) {
        const url = this.baseUrl.startsWith('http')
            ? new URL(this.baseUrl)
            : new URL(this.baseUrl, window.location.origin);
        for (const [k, v] of Object.entries(params)) {
            if (v != null) url.searchParams.set(k, v);
        }
        const res = await fetch(url.toString(), {
            credentials: 'same-origin',
            headers: this._authHeaders(),
        });
        return this._handleResponse(res);
    }

    async _post(params) {
        const url = this.baseUrl.startsWith('http')
            ? new URL(this.baseUrl)
            : new URL(this.baseUrl, window.location.origin);
        const body = new FormData();
        for (const [k, v] of Object.entries(params)) {
            if (v != null) body.append(k, v);
        }
        const res = await fetch(url.toString(), {
            method: 'POST',
            body,
            credentials: 'same-origin',
            headers: this._authHeaders(),
        });
        return this._handleResponse(res);
    }

    async _handleResponse(res) {
        if (res.status === 401) throw new Error('AUTH_EXPIRED');
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data;
    }

    // -------------------------------------------------------
    // Normalization
    // -------------------------------------------------------

    _normalizeFile(raw) {
        if (!raw) return null;
        return {
            id:          raw.id,
            owner:       raw.owner,
            app:         raw.app         ?? null,
            title:       raw.title       ?? 'Untitled',
            type:        raw.type        ?? 'yjs',
            scope:       raw.scope       ?? 'drive',
            folderId:    raw.folderId    ?? null,
            parentId:    raw.parentId    ?? null,
            roomId:      raw.roomId      ?? null,
            blobKey:     raw.blobKey     ?? null,
            mimeType:    raw.mimeType    ?? null,
            size:        raw.size        ?? null,
            filename:    raw.filename    ?? null,
            publicRead:   !!raw.publicRead,
            publicWrite:  !!raw.publicWrite,
            deleted:      !!raw.deleted,
            birthtime:    raw.birthtime  ?? raw.createdAt  ?? null,
            mtime:        raw.mtime      ?? raw.updatedAt  ?? null,
            ctime:        raw.ctime      ?? raw.updatedAt  ?? null,
            sharedWith:   this._normalizeShares(raw.sharedWith),
            thumbnailKey: raw.thumbnailKey ?? null,
        };
    }

    _normalizeFolder(raw) {
        if (!raw) return null;
        return {
            id:          raw.id,
            owner:       raw.owner,
            name:        raw.name        ?? 'Untitled Folder',
            parentId:    raw.parentId    ?? null,
            publicRead:  !!raw.publicRead,
            publicWrite: !!raw.publicWrite,
            birthtime:   raw.birthtime ?? raw.createdAt ?? null,
            ctime:       raw.ctime     ?? raw.updatedAt ?? null,
            sharedWith:  this._normalizeShares(raw.sharedWith),
        };
    }

    _normalizeShares(shares) {
        if (!Array.isArray(shares)) return [];
        return shares.map(s => ({
            username:    s.username,
            permissions: Array.isArray(s.permissions) ? s.permissions : [],
        }));
    }

    // -------------------------------------------------------
    // Sync
    // -------------------------------------------------------

    /** @returns {Promise<{files: FileDescriptor[], folders: Folder[], recents: RecentEntry[]}>} */
    async fullSync() {
        const data = await this._get({ action: 'full_sync' });
        return {
            files:   (data.files   ?? []).map(f => this._normalizeFile(f)),
            folders: (data.folders ?? []).map(f => this._normalizeFolder(f)),
            recents: (data.recents ?? []).map(r => ({
                fileId:  r.file_id  ?? r.fileId,
                appName: r.app_name ?? r.appName ?? null,
                atime:   r.atime    ?? r.opened_at ?? r.openedAt,
            })),
        };
    }

    // -------------------------------------------------------
    // File operations
    // -------------------------------------------------------

    /** @returns {Promise<FileDescriptor>} */
    async createFile(opts) {
        const data = await this._post({
            action:       'create',
            id:           opts.id           ?? null,
            room_id:      opts.roomId       ?? null,   // client-provided for offline creates
            title:        opts.title        ?? 'Untitled',
            type:         opts.type         ?? 'yjs',
            scope:        opts.scope        ?? 'drive',
            app:          opts.app          ?? null,
            folder_id:    opts.folderId     ?? null,
            parent_id:    opts.parentId     ?? null,
            public_read:  opts.publicRead   ? 1 : 0,
            public_write: opts.publicWrite  ? 1 : 0,
            mime_type:    opts.mimeType     ?? null,
            size:         opts.size         ?? null,
            filename:     opts.filename     ?? null,
        });
        return this._normalizeFile(data);
    }

    /** @returns {Promise<FileDescriptor>} */
    async renameFile(id, title) {
        return this._normalizeFile(await this._post({ action: 'rename', id, title }));
    }

    /** @returns {Promise<void>} */
    async deleteFile(id) {
        await this._post({ action: 'delete', id });
    }

    /** @returns {Promise<FileDescriptor>} */
    async restoreFile(id) {
        return this._normalizeFile(await this._post({ action: 'restore', id }));
    }

    /** @returns {Promise<void>} */
    async permanentDeleteFile(id) {
        await this._post({ action: 'permanent_delete', id });
    }

    /** @returns {Promise<FileDescriptor>} */
    async moveFile(id, targetFolderId) {
        return this._normalizeFile(await this._post({ action: 'move_file', id, target_folder_id: targetFolderId }));
    }

    /** @returns {Promise<FileDescriptor>} */
    async setParent(id, parentId) {
        return this._normalizeFile(await this._post({ action: 'set_parent', id, parent_id: parentId }));
    }

    /** @returns {Promise<FileDescriptor>} */
    async shareFile(id, username, permissions = ['read', 'write']) {
        return this._normalizeFile(await this._post({ action: 'share', id, username, permissions: permissions.join(',') }));
    }

    /** @returns {Promise<FileDescriptor>} */
    async revokeFile(id, username) {
        return this._normalizeFile(await this._post({ action: 'revoke', id, username }));
    }

    /** @returns {Promise<FileDescriptor>} */
    async setFilePublic(id, publicRead, publicWrite) {
        return this._normalizeFile(await this._post({ action: 'set_public', id, public_read: publicRead ? 1 : 0, public_write: publicWrite ? 1 : 0 }));
    }

    // -------------------------------------------------------
    // Folder operations
    // -------------------------------------------------------

    /** @returns {Promise<Folder>} */
    async createFolder(opts) {
        return this._normalizeFolder(await this._post({
            action:       'create_folder',
            id:           opts.id          ?? null,   // client-provided for offline creates
            name:         opts.name,
            parent_id:    opts.parentId    ?? null,
            public_read:  opts.publicRead  ? 1 : 0,
            public_write: opts.publicWrite ? 1 : 0,
        }));
    }

    /** @returns {Promise<Folder>} */
    async renameFolder(folderId, name) {
        return this._normalizeFolder(await this._post({ action: 'rename_folder', folder_id: folderId, name }));
    }

    /** @returns {Promise<void>} */
    async deleteFolder(folderId) {
        await this._post({ action: 'delete_folder', folder_id: folderId });
    }

    /** @returns {Promise<Folder>} */
    async moveFolder(folderId, targetParentId) {
        return this._normalizeFolder(await this._post({ action: 'move_folder', folder_id: folderId, target_parent_id: targetParentId }));
    }

    /** @returns {Promise<Folder>} */
    async shareFolder(folderId, username, permissions = ['read', 'write']) {
        return this._normalizeFolder(await this._post({ action: 'share_folder', folder_id: folderId, username, permissions: permissions.join(',') }));
    }

    /** @returns {Promise<Folder>} */
    async revokeFolderShare(folderId, username) {
        return this._normalizeFolder(await this._post({ action: 'revoke_folder_share', folder_id: folderId, username }));
    }

    /** @returns {Promise<Folder>} */
    async setFolderPublic(folderId, publicRead, publicWrite) {
        return this._normalizeFolder(await this._post({ action: 'set_folder_public', folder_id: folderId, public_read: publicRead ? 1 : 0, public_write: publicWrite ? 1 : 0 }));
    }

    // -------------------------------------------------------
    // Users
    // -------------------------------------------------------

    /** @returns {Promise<{username: string, displayName: string, isAdmin: boolean}[]>} */
    async listUsers() {
        return this._get({ action: 'users' });
    }

    // -------------------------------------------------------
    // Blob upload / download
    // -------------------------------------------------------

    /**
     * Upload binary content for a blob file.
     * @param {string} fileId
     * @param {File|Blob} file
     */
    async uploadBlob(fileId, file) {
        const url = this.blobUrl.startsWith('http')
            ? new URL(this.blobUrl)
            : new URL(this.blobUrl, window.location.origin);
        url.searchParams.set('id', fileId);
        const filename = file.name ?? '';
        const headers = {
            'Content-Type': file.type || 'application/octet-stream',
            ...this._authHeaders(),
        };
        if (filename) {
            headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
        }
        const res = await fetch(url.toString(), {
            method: 'PUT',
            body:   file,
            credentials: 'same-origin',
            headers,
        });
        if (!res.ok) throw new Error(`Blob upload failed: ${res.status}`);
    }

    /**
     * Returns the download URL for a blob file.
     * Appends ?apikey= when a Bearer token is present, because <img> src
     * attributes cannot carry custom headers. For session auth (token=null)
     * the browser cookie is sent automatically.
     * @param {string} fileId
     * @returns {string}
     */
    getBlobUrl(fileId) {
        const url = this.blobUrl.startsWith('http')
            ? new URL(this.blobUrl)
            : new URL(this.blobUrl, window.location.origin);
        url.searchParams.set('id', fileId);
        const key = this.getApiKey();
        if (key) url.searchParams.set('apikey', key); // needed for img/video src
        return url.toString();
    }

    /**
     * Returns the inline-stream URL for a blob file (Content-Disposition: inline).
     * Use this for in-browser preview (PDF viewer, video player, etc.) so the
     * browser renders the file rather than downloading it.
     * @param {string} fileId
     * @returns {string}
     */
    getStreamUrl(fileId) {
        const url = this.blobUrl.startsWith('http')
            ? new URL(this.blobUrl)
            : new URL(this.blobUrl, window.location.origin);
        url.searchParams.set('id', fileId);
        url.searchParams.set('action', 'stream');
        const key = this.getApiKey();
        if (key) url.searchParams.set('apikey', key);
        return url.toString();
    }

    /**
     * Fetch mimeType and filename for a blob by inspecting its HTTP response headers.
     * Used as a fallback when the file descriptor is not in the local registry.
     * @param {string} fileId
     * @returns {Promise<{mimeType:string, filename:string}|null>}
     */
    async fetchBlobInfo(fileId) {
        try {
            const url = this.blobUrl.startsWith('http')
                ? new URL(this.blobUrl)
                : new URL(this.blobUrl, window.location.origin);
            url.searchParams.set('id', fileId);
            url.searchParams.set('action', 'info');
            const key = this.getApiKey();
            if (key) url.searchParams.set('apikey', key);
            const res = await fetch(url.toString(), { credentials: 'same-origin', headers: this._authHeaders() });
            if (!res.ok) return null;
            const data = await res.json();
            if (!data) return null;
            return {
                mimeType: data.mime_type  ?? '',
                filename: data.filename   ?? '',
                size:     data.size       ?? null,
            };
        } catch {
            return null;
        }
    }

    // -------------------------------------------------------
    // Thumbnail
    // -------------------------------------------------------

    /**
     * Upload a thumbnail image for any file (yjs or blob).
     * The image is uploaded as multipart form data.
     * @param {string} fileId
     * @param {Blob} imageBlob
     * @returns {Promise<FileDescriptor>}
     */
    async setThumbnail(fileId, imageBlob) {
        const url = this.baseUrl.startsWith('http')
            ? new URL(this.baseUrl)
            : new URL(this.baseUrl, window.location.origin);
        const body = new FormData();
        body.append('action', 'set_thumbnail');
        body.append('id', fileId);
        body.append('thumbnail', imageBlob, 'thumbnail.jpg');
        const res = await fetch(url.toString(), {
            method: 'POST',
            body,
            credentials: 'same-origin',
            headers: this._authHeaders(),
        });
        return this._normalizeFile(await this._handleResponse(res));
    }

    /**
     * Remove the thumbnail for a file.
     * @param {string} fileId
     * @returns {Promise<FileDescriptor>}
     */
    async clearThumbnail(fileId) {
        return this._normalizeFile(await this._post({ action: 'clear_thumbnail', id: fileId }));
    }

    /**
     * Returns the URL to fetch a file's thumbnail.
     * Works for any file type (yjs or blob).
     * @param {string} fileId
     * @returns {string}
     */
    getThumbnailUrl(fileId) {
        const url = this.blobUrl.startsWith('http')
            ? new URL(this.blobUrl)
            : new URL(this.blobUrl, window.location.origin);
        url.searchParams.set('id', fileId);
        url.searchParams.set('action', 'thumbnail');
        const key = this.getApiKey();
        if (key) url.searchParams.set('apikey', key);
        return url.toString();
    }

    // -------------------------------------------------------
    // Content search text
    // -------------------------------------------------------

    /**
     * Store a plain-text representation of a file's content for server-side search.
     * Pass an empty string to clear the search text.
     * @param {string} fileId
     * @param {string} text
     * @returns {Promise<FileDescriptor>}
     */
    async setSearchText(fileId, text) {
        return this._normalizeFile(await this._post({ action: 'set_search_text', id: fileId, text }));
    }

    /**
     * Record that the current user opened a file (cross-device recently-opened tracking).
     * Fire-and-forget: errors are intentionally ignored by callers.
     * @param {string} fileId
     * @param {string} appName
     * @param {string} atime  ISO 8601 timestamp of when the open occurred (client time)
     * @returns {Promise<void>}
     */
    async recordOpen(fileId, appName, atime) {
        await this._post({ action: 'record_open', file_id: fileId, app_name: appName ?? '', opened_at: atime ?? '' });
    }

    /**
     * Update a Yjs file's mtime on the server.
     * Called after offline edits are synced back to the server.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async touchFile(id) {
        await this._post({ action: 'touch', id });
    }

    /**
     * Update a Yjs file's room_id. Used after a snapshot restore to migrate
     * to a fresh room that is not contaminated by offline clients.
     * @param {string} id - File ID
     * @param {string} roomId - New room ID
     * @returns {Promise<FileDescriptor>}
     */
    async updateRoomId(id, roomId) {
        return this._normalizeFile(await this._post({ action: 'update_room_id', id, room_id: roomId }));
    }

    // -------------------------------------------------------
    // Version history (snapshot proxy — access-controlled via storage.php)
    // -------------------------------------------------------

    /**
     * List snapshot history for a Yjs file.
     * @param {string} fileId
     * @returns {Promise<SnapshotMeta[]>}
     */
    async listSnapshots(fileId) {
        const data = await this._get({ action: 'snapshot_list', file_id: fileId });
        return data.snapshots ?? [];
    }

    /**
     * Fetch the raw Yjs state for a snapshot as a Uint8Array.
     * Apply to a Y.Doc with Y.applyUpdate(doc, data) to reconstruct the doc for diffing.
     * @param {string} fileId - The file this snapshot belongs to (used for access control)
     * @param {string} snapshotId
     * @returns {Promise<Uint8Array>}
     */
    async getSnapshotData(fileId, snapshotId) {
        const url = this.baseUrl.startsWith('http')
            ? new URL(this.baseUrl)
            : new URL(this.baseUrl, window.location.origin);
        url.searchParams.set('action', 'snapshot_data');
        url.searchParams.set('file_id', fileId);
        url.searchParams.set('snapshot_id', snapshotId);
        const res = await fetch(url.toString(), {
            credentials: 'same-origin',
            headers: this._authHeaders(),
        });
        if (res.status === 401) throw new Error('AUTH_EXPIRED');
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    }

    /**
     * Restore a file to a snapshot version.
     * Creates a fresh Yjs room with the snapshot state and updates the file record.
     * All current clients will need to reconnect to the new room.
     * @param {string} fileId
     * @param {string} snapshotId
     * @returns {Promise<FileDescriptor>} updated file with new roomId
     */
    async restoreVersion(fileId, snapshotId) {
        return this._normalizeFile(
            await this._post({ action: 'snapshot_restore', file_id: fileId, snapshot_id: snapshotId })
        );
    }

    /**
     * Search files by title or stored content text (server-side).
     * Returns files the authenticated user has access to.
     * @param {string} query - Minimum 2 characters
     * @param {{ scope?: 'drive'|'app', app?: string }} [opts]
     * @returns {Promise<FileDescriptor[]>}
     */
    async search(query, opts = {}) {
        const params = { action: 'search', q: query };
        if (opts.scope) params.scope = opts.scope;
        if (opts.app)   params.app   = opts.app;
        const data = await this._get(params);
        return (data.files ?? []).map(f => this._normalizeFile(f));
    }
}

/**
 * @typedef {object} RecentEntry
 * @property {string}      fileId
 * @property {string|null} appName
 * @property {string}      atime  ISO datetime string (last access time)
 */

/**
 * @typedef {object} SnapshotMeta
 * @property {string}  id
 * @property {string}  file_id
 * @property {string}  room_id
 * @property {number}  created_at  Unix ms timestamp
 * @property {'auto'|'manual'|'room_empty'|'session_end'|'session_cap'} trigger
 * @property {string|null} created_by  comma-separated usernames (deduped)
 * @property {string|null} description
 * @property {number|null} change_count  number of meaningful content changes in this snapshot
 * @property {string|null} diff_json  server-computed diff JSON (v1 generic or v2 sheets)
 * @property {string|null} app_type  'sheets' | 'docs' | 'svg'
 * @property {number}      pinned    1 if pinned (excluded from retention thinning), 0 otherwise
 */
