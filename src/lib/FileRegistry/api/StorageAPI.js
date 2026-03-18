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
            publicRead:  !!raw.publicRead,
            publicWrite: !!raw.publicWrite,
            deleted:     !!raw.deleted,
            createdAt:   raw.createdAt   ?? null,
            updatedAt:   raw.updatedAt   ?? null,
            sharedWith:  this._normalizeShares(raw.sharedWith),
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
            createdAt:   raw.createdAt   ?? null,
            updatedAt:   raw.updatedAt   ?? null,
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

    /** @returns {Promise<{files: FileDescriptor[], folders: Folder[]}>} */
    async fullSync() {
        const data = await this._get({ action: 'full_sync' });
        return {
            files:   (data.files   ?? []).map(f => this._normalizeFile(f)),
            folders: (data.folders ?? []).map(f => this._normalizeFolder(f)),
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
        const res = await fetch(url.toString(), {
            method:  'PUT',
            body:    file,
            credentials: 'same-origin',
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
                ...this._authHeaders(),
            },
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
}
