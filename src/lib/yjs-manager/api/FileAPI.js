/**
 * FileAPI - Strict API adapter for the file storage backend.
 *
 * This class handles all HTTP communication with the server, normalizing
 * responses from the server's "document" terminology to client-side "file"
 * terminology.
 */

/**
 * @typedef {Object} FileAPIOptions
 * @property {string} [appName] - Application name for file creation.
 * @property {string} [schemaVersion] - Schema version for Yjs files.
 */

export class FileAPI {
    /**
     * @param {string} baseUrl - The base URL for the REST API.
     * @param {function(): string|null} getApiKey - Returns the current API key.
     * @param {FileAPIOptions} [options={}] - Additional options.
     */
    constructor(baseUrl, getApiKey, options = {}) {
        this.baseUrl = baseUrl;
        this.getApiKey = getApiKey;
        this.options = options;
    }

    /**
     * @private
     * @returns {string|null}
     */
    _getAuthKey() {
        return this.getApiKey();
    }

    /**
     * Makes an API request.
     *
     * @param {Object} params - Request parameters.
     * @param {'GET'|'POST'} method - HTTP method.
     * @param {Object} [requestOptions] - Additional options.
     * @param {boolean} [requestOptions.requireAuth=true] - Whether auth is required.
     */
    async _request(params = {}, method = 'GET', requestOptions = {}) {
        const { requireAuth = true } = requestOptions;
        const apiKey = this._getAuthKey();

        if (requireAuth && !apiKey) {
            throw new Error('API key required');
        }

        const url = this.baseUrl.startsWith('http')
            ? new URL(this.baseUrl)
            : new URL(this.baseUrl, window.location.origin);

        if (apiKey) {
            url.searchParams.set('apikey', apiKey);
        }

        const fetchOptions = { method };

        if (method === 'POST') {
            const formData = new FormData();
            for (const [key, value] of Object.entries(params)) {
                if (value !== null && value !== undefined) {
                    formData.append(key, value);
                }
            }
            fetchOptions.body = formData;
        } else {
            for (const [key, value] of Object.entries(params)) {
                if (value !== null && value !== undefined) {
                    url.searchParams.set(key, value);
                }
            }
        }

        const response = await fetch(url.toString(), fetchOptions);

        if (response.status === 401) {
            throw new Error('AUTH_EXPIRED');
        }

        if (response.status === 409) {
            throw new Error('CONFLICT');
        }

        if (!response.ok) {
            throw new Error(`API_ERROR: ${response.status}`);
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }

        return data;
    }

    /**
     * Normalizes a raw server response to a FileDescriptor.
     * All fields are converted to camelCase for consistent client-side usage.
     *
     * @param {any} raw - Raw server response.
     * @returns {import('../types').FileDescriptor}
     */
    _normalizeFile(raw) {
        if (!raw) return null;

        return {
            id: raw.id,
            title: raw.title || 'Untitled',
            app: raw.app || null,
            owner: raw.owner,
            permissions: this._normalizePermissions(raw.permissions),
            versions: raw.versions || {},
            sharedWith: this._normalizeShares(raw.shared_with ?? raw.sharedWith),
            type: raw.type || 'yjs',
            folderId: raw.folder_id ?? raw.folderId ?? null,
            blobKey: raw.blob_key ?? raw.blobKey ?? null,
            mimeType: raw.mime_type ?? raw.mimeType ?? null,
            size: raw.size ?? null,
            filename: raw.filename ?? null,
            createdAt: raw.created_at ?? raw.createdAt ?? null,
            updatedAt: raw.updated_at ?? raw.updatedAt ?? null,
            scope: raw.scope || 'drive',
            parentId: raw.parent_id ?? raw.parentId ?? null,
            publicRead: !!(raw.public_read ?? raw.publicRead),
            publicWrite: !!(raw.public_write ?? raw.publicWrite),
            deleted: !!raw.deleted
        };
    }

    /**
     * Normalizes a permissions value to an array.
     *
     * @param {any} permissions
     * @returns {string[]}
     */
    _normalizePermissions(permissions) {
        if (Array.isArray(permissions)) {
            return permissions;
        }
        if (typeof permissions === 'string' && permissions.length > 0) {
            return permissions.split(',').map(p => p.trim()).filter(Boolean);
        }
        return [];
    }

    /**
     * Normalizes share data.
     * Handles null/undefined input and normalizes to consistent format.
     *
     * @param {any[]|null|undefined} shares
     * @returns {Array<{username: string, permissions: string[]}>}
     */
    _normalizeShares(shares) {
        if (!shares || !Array.isArray(shares)) {
            return [];
        }
        return shares.map(s => ({
            username: s.username,
            permissions: this._normalizePermissions(s.permissions)
        }));
    }

    /**
     * Normalizes a raw server response to a Folder.
     * All fields are converted to camelCase for consistent client-side usage.
     *
     * @param {any} raw - Raw server response.
     * @returns {import('../types').Folder}
     */
    _normalizeFolder(raw) {
        if (!raw) return null;

        return {
            id: raw.id,
            name: raw.name || 'Untitled Folder',
            parentId: raw.parent_id ?? raw.parentId ?? null,
            owner: raw.owner,
            permissions: this._normalizePermissions(raw.permissions),
            sharedWith: this._normalizeShares(raw.shared_with ?? raw.sharedWith),
            createdAt: raw.created_at ?? raw.createdAt ?? null,
            updatedAt: raw.updated_at ?? raw.updatedAt ?? null,
            publicRead: !!(raw.public_read ?? raw.publicRead),
            publicWrite: !!(raw.public_write ?? raw.publicWrite)
        };
    }

    // ===========================================
    // SYNC OPERATIONS
    // ===========================================

    /**
     * Performs a full sync, returning all files and folders.
     *
     * @returns {Promise<import('../types').FullSyncResult>}
     */
    async fullSync() {
        const data = await this._request({ action: 'full_sync' });
        return {
            documents: (data.documents || []).map(d => this._normalizeFile(d)),
            folders: (data.folders || []).map(f => this._normalizeFolder(f))
        };
    }

    // ===========================================
    // FILE OPERATIONS
    // ===========================================

    /**
     * Creates a new file.
     *
     * @param {Object} options - File creation options.
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async createFile(options) {
        const {
            id,
            title,
            type = 'yjs',
            folderId = null,
            parentId = null,
            app,
            scope = 'drive',
            version,
            filename = null,
            mimeType = null,
            size = null,
            publicRead = false,
            publicWrite = false
        } = options;

        const params = {
            action: 'create',
            id,
            app,
            title,
            type,
            scope,
            folder_id: folderId,
            parent_id: parentId,
            public_read: publicRead ? 1 : 0,
            public_write: publicWrite ? 1 : 0
        };

        if (type === 'blob') {
            params.filename = filename;
            params.mime_type = mimeType;
            params.size = size;
        } else {
            params.version = version;
        }

        const data = await this._request(params, 'POST');
        return this._normalizeFile(data);
    }

    /**
     * Renames a file.
     *
     * @param {string} id - The file ID.
     * @param {string} title - New title.
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async rename(id, title) {
        const data = await this._request({ action: 'rename', id, title }, 'POST');
        return this._normalizeFile(data);
    }

    /**
     * Deletes a file.
     *
     * @param {string} id - The file ID.
     */
    async delete(id) {
        await this._request({ action: 'delete', id }, 'POST');
    }

    /**
     * Creates a new version of a Yjs file.
     *
     * @param {string} id - The file ID.
     * @param {string} version - The schema version.
     * @returns {Promise<{room: string, version: string}>}
     */
    async createVersion(id, version) {
        return await this._request({
            action: 'create_version',
            id,
            version
        }, 'POST');
    }

    /**
     * Moves a file to a different folder.
     *
     * @param {string} id - The file ID.
     * @param {string|null} targetFolderId - Target folder ID.
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async moveFile(id, targetFolderId) {
        const data = await this._request({
            action: 'move_document',
            id,
            target_folder_id: targetFolderId
        }, 'POST');
        return this._normalizeFile(data);
    }

    /**
     * Shares a file with a user.
     *
     * @param {string} id - The file ID.
     * @param {string} username - Username to share with.
     * @param {string[]} permissions - Permissions to grant.
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async share(id, username, permissions = ['read', 'write']) {
        const data = await this._request({
            action: 'share',
            id,
            username,
            permissions: permissions.join(',')
        }, 'POST');
        return this._normalizeFile(data);
    }

    /**
     * Revokes a user's access to a file.
     *
     * @param {string} id - The file ID.
     * @param {string} username - Username to revoke.
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async revoke(id, username) {
        const data = await this._request({ action: 'revoke', id, username }, 'POST');
        return this._normalizeFile(data);
    }

    /**
     * Sets public access flags on a file.
     *
     * @param {string} id - The file ID.
     * @param {boolean} publicRead - Public read access.
     * @param {boolean} publicWrite - Public write access.
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async setFilePublic(id, publicRead, publicWrite) {
        const data = await this._request({
            action: 'set_public',
            id,
            public_read: publicRead ? 1 : 0,
            public_write: publicWrite ? 1 : 0
        }, 'POST');
        return this._normalizeFile(data);
    }

    /**
     * Sets the parent of a file (for attachments).
     *
     * @param {string} id - The file ID.
     * @param {string|null} parentId - Parent file ID.
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async setFileParent(id, parentId) {
        const data = await this._request({
            action: 'set_parent',
            id,
            parent_id: parentId
        }, 'POST');
        return this._normalizeFile(data);
    }

    /**
     * Gets access info for a file.
     *
     * @param {string} id - The file ID.
     * @param {string} [version] - Schema version.
     * @returns {Promise<any>}
     */
    async access(id, version) {
        const params = { action: 'access', id };
        if (version) params.version = version;
        return await this._request(params, 'GET', { requireAuth: false });
    }

    // ===========================================
    // FOLDER OPERATIONS
    // ===========================================

    /**
     * Creates a new folder.
     *
     * @param {string} name - Folder name.
     * @param {string|null} parentId - Parent folder ID.
     * @returns {Promise<import('../types').Folder>}
     */
    async createFolder(name, parentId = null) {
        const data = await this._request({
            action: 'create_folder',
            name,
            parent_id: parentId
        }, 'POST');
        return this._normalizeFolder(data);
    }

    /**
     * Renames a folder.
     *
     * @param {string} folderId - The folder ID.
     * @param {string} newName - New folder name.
     * @returns {Promise<import('../types').Folder>}
     */
    async renameFolder(folderId, newName) {
        const data = await this._request({
            action: 'rename_folder',
            folder_id: folderId,
            new_name: newName
        }, 'POST');
        return this._normalizeFolder(data);
    }

    /**
     * Deletes a folder.
     *
     * @param {string} folderId - The folder ID.
     */
    async deleteFolder(folderId) {
        await this._request({
            action: 'delete_folder',
            folder_id: folderId
        }, 'POST');
    }

    /**
     * Moves a folder.
     *
     * @param {string} folderId - The folder ID.
     * @param {string|null} newParentId - New parent folder ID.
     * @returns {Promise<import('../types').Folder>}
     */
    async moveFolder(folderId, newParentId) {
        const data = await this._request({
            action: 'move_folder',
            folder_id: folderId,
            target_parent_id: newParentId
        }, 'POST');
        return this._normalizeFolder(data);
    }

    /**
     * Shares a folder.
     *
     * @param {string} folderId - The folder ID.
     * @param {string} username - Username to share with.
     * @param {string[]} permissions - Permissions to grant.
     * @returns {Promise<import('../types').Folder>}
     */
    async shareFolder(folderId, username, permissions) {
        const data = await this._request({
            action: 'share_folder',
            folder_id: folderId,
            username,
            permissions: permissions.join(',')
        }, 'POST');
        return this._normalizeFolder(data);
    }

    /**
     * Revokes a user's access to a folder.
     *
     * @param {string} folderId - The folder ID.
     * @param {string} username - Username to revoke.
     * @returns {Promise<import('../types').Folder>}
     */
    async revokeFolderShare(folderId, username) {
        const data = await this._request({
            action: 'revoke_folder_share',
            folder_id: folderId,
            username
        }, 'POST');
        return this._normalizeFolder(data);
    }

    /**
     * Sets public access flags on a folder.
     *
     * @param {string} folderId - The folder ID.
     * @param {boolean} publicRead - Public read access.
     * @param {boolean} publicWrite - Public write access.
     * @returns {Promise<import('../types').Folder>}
     */
    async setFolderPublic(folderId, publicRead, publicWrite) {
        const data = await this._request({
            action: 'set_public_folder',
            folder_id: folderId,
            public_read: publicRead ? 1 : 0,
            public_write: publicWrite ? 1 : 0
        }, 'POST');
        return this._normalizeFolder(data);
    }

    // ===========================================
    // UTILITY OPERATIONS
    // ===========================================

    /**
     * Generates a random ID.
     *
     * @param {number} [length=16] - ID length.
     * @returns {Promise<string>}
     */
    async generateId(length = 16) {
        const data = await this._request({ action: 'generate_id', length });
        return data.id;
    }

    /**
     * Lists files with optional filters.
     *
     * @param {Object} [options={}] - Filter options.
     * @returns {Promise<import('../types').FileDescriptor[]>}
     */
    async list(options = {}) {
        const params = { action: 'list' };

        if (options.scope) params.scope = options.scope;
        if (options.folderId !== undefined) params.folder_id = options.folderId;
        if (options.parentId !== undefined) params.parent_id = options.parentId;

        const data = await this._request(params);
        return data.map(d => this._normalizeFile(d));
    }

    /**
     * Permanently deletes a file.
     *
     * @param {string} id - The file ID.
     * @returns {Promise<void>}
     */
    async permanentDelete(id) {
        await this._request({ action: 'permanent_delete', id }, 'POST');
    }

    /**
     * Restores a soft-deleted file.
     *
     * @param {string} id - The file ID.
     * @returns {Promise<void>}
     */
    async restore(id) {
        await this._request({ action: 'restore', id }, 'POST');
    }

    /**
     * Gets all children of a parent file (attachments).
     *
     * @param {string} parentId - The parent file ID.
     * @returns {Promise<import('../types').FileDescriptor[]>}
     */
    async getChildren(parentId) {
        const data = await this._request({ action: 'get_children', id: parentId });
        return data.map(d => this._normalizeFile(d));
    }
}

// Legacy alias for backward compatibility
export { FileAPI as DocManagerAPI };
