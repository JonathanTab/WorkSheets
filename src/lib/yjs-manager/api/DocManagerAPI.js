/**
 * DocManagerAPI - Strict API adapter for the document manager backend
 */
export class DocManagerAPI {
    /**
     * @param {string} baseUrl
     * @param {function(): string|null} getApiKey
     * @param {Object} [options] - Additional options
     * @param {string} [options.appName] - Application name for document creation
     * @param {string} [options.schemaVersion] - Schema version for document creation
     */
    constructor(baseUrl, getApiKey, options = {}) {
        this.baseUrl = baseUrl;
        this.getApiKey = getApiKey;
        this.options = options;
    }

    /**
     * Returns the API key if available.
     * @private
     * @returns {string|null}
     */
    _getAuthKey() {
        return this.getApiKey();
    }

    /**
     * @param {Object} params
     * @param {'GET'|'POST'} method
     * @param {Object} [requestOptions] - Request options
     * @param {boolean} [requestOptions.requireAuth=true] - Whether authentication is required
     */
    async _request(params = {}, method = 'GET', requestOptions = {}) {
        const { requireAuth = true } = requestOptions;
        const apiKey = this._getAuthKey();

        // For operations requiring authentication, throw if no key
        if (requireAuth && !apiKey) {
            throw new Error('API key required');
        }

        // Handle relative URLs by using window.location.origin as base
        const url = this.baseUrl.startsWith('http')
            ? new URL(this.baseUrl)
            : new URL(this.baseUrl, window.location.origin);

        // Only add apikey if we have one (allows public access when key is null)
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
     * @param {any} raw
     * @returns {import('../types').DocDescriptor}
     */
    _normalize(raw) {
        return {
            id: raw.id,
            title: raw.title || 'Untitled',
            app: raw.app || null,
            owner: raw.owner, // Preserve owner as username string
            permissions: Array.isArray(raw.permissions)
                ? raw.permissions
                : (typeof raw.permissions === 'string' ? raw.permissions.split(',') : []),
            versions: raw.versions || {},
            shared_with: Array.isArray(raw.shared_with) ? raw.shared_with : [],
            // New fields for folder hierarchy and blob support
            type: raw.type || 'yjs',
            folderId: raw.folder_id || raw.folderId || null,
            blobKey: raw.blob_key || raw.blobKey || null,
            mimeType: raw.mime_type || raw.mimeType || null,
            size: raw.size || null,
            filename: raw.filename || null,
            createdAt: raw.created_at || raw.createdAt || null,
            updatedAt: raw.updated_at || raw.updatedAt || null,
            // Phase 2 fields
            scope: raw.scope || 'drive',
            parentId: raw.parent_id || raw.parentId || null,
            publicRead: !!raw.public_read || !!raw.publicRead || false,
            publicWrite: !!raw.public_write || !!raw.publicWrite || false,
            deleted: !!raw.deleted || false
        };
    }

    /**
     * @param {any} raw
     * @returns {import('../types').Folder}
     */
    _normalizeFolder(raw) {
        return {
            id: raw.id,
            name: raw.name || 'Untitled Folder',
            parentId: raw.parent_id || raw.parentId || null,
            owner: raw.owner,
            permissions: Array.isArray(raw.permissions)
                ? raw.permissions
                : (typeof raw.permissions === 'string' ? raw.permissions.split(',') : []),
            shared_with: Array.isArray(raw.shared_with) ? raw.shared_with : [],
            createdAt: raw.created_at || raw.createdAt || null,
            updatedAt: raw.updated_at || raw.updatedAt || null,
            publicRead: !!raw.public_read || !!raw.publicRead || false,
            publicWrite: !!raw.public_write || !!raw.publicWrite || false
        };
    }

    /**
     * @param {string} app
     * @returns {Promise<import('../types').DocDescriptor[]>}
     */
    async listByApp(app) {
        const data = await this._request({ action: 'list_by_app', app });
        return data.map(this._normalize);
    }

    /**
     * @param {string} id
     * @param {string} app
     * @param {string} title
     * @param {string} version
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async create(id, app, title, version) {
        const data = await this._request({
            action: 'create',
            id,
            app,
            title,
            version
        }, 'POST');
        return this._normalize(data);
    }

    /**
     * @param {string} id
     * @param {string} version
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
     * @param {string} id
     * @param {string} title
     */
    async rename(id, title) {
        const data = await this._request({ action: 'rename', id, title }, 'POST');
        return this._normalize(data);
    }

    /**
     * @param {string} id
     * @param {string} username
     * @param {string[]} permissions
     */
    async share(id, username, permissions = ['read', 'write']) {
        const data = await this._request({
            action: 'share',
            id,
            username,
            permissions: permissions.join(',')
        }, 'POST');
        return this._normalize(data);
    }

    /**
     * Removes a user's access to a document.
     *
     * @param {string} id - The logical document ID.
     * @param {string} username - The user to revoke access from.
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async revoke(id, username) {
        const data = await this._request({ action: 'revoke', id, username }, 'POST');
        return this._normalize(data);
    }

    /**
     * Permanently deletes a document from the server.
     *
     * @param {string} id - The logical document ID.
     */
    async delete(id) {
        await this._request({ action: 'delete', id }, 'POST');
    }

    /**
     * Requests a cryptographically secure random ID from the server.
     *
     * @param {number} [length=16]
     * @returns {Promise<string>}
     */
    async generateId(length = 16) {
        const data = await this._request({ action: 'generate_id', length });
        return data.id;
    }

    // ===========================================
    // FULL SYNC
    // ===========================================

    /**
     * Performs a full sync, returning all documents and folders accessible to the user.
     *
     * @returns {Promise<import('../types').FullSyncResult>}
     */
    async fullSync() {
        const data = await this._request({ action: 'full_sync' });
        return {
            documents: (data.documents || []).map(d => this._normalize(d)),
            folders: (data.folders || []).map(f => this._normalizeFolder(f))
        };
    }

    // ===========================================
    // FOLDER OPERATIONS
    // ===========================================

    /**
     * Creates a new folder.
     *
     * @param {string} name - The folder name.
     * @param {string|null} [parentId=null] - Parent folder ID, or null for root.
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
     * @param {string} newName - The new folder name.
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
     * Deletes a folder and all its contents.
     *
     * @param {string} folderId - The folder ID.
     * @returns {Promise<void>}
     */
    async deleteFolder(folderId) {
        await this._request({
            action: 'delete_folder',
            folder_id: folderId
        }, 'POST');
    }

    /**
     * Moves a folder to a new parent.
     *
     * @param {string} folderId - The folder ID.
     * @param {string|null} newParentId - New parent folder ID, or null for root.
     * @returns {Promise<import('../types').Folder>}
     */
    async moveFolder(folderId, newParentId) {
        const data = await this._request({
            action: 'move_folder',
            folder_id: folderId,
            new_parent_id: newParentId
        }, 'POST');
        return this._normalizeFolder(data);
    }

    /**
     * Shares a folder with another user.
     *
     * @param {string} folderId - The folder ID.
     * @param {string} username - The user to share with.
     * @param {string[]} permissions - Array of permissions (e.g., ['read', 'write']).
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
     * @param {string} username - The user to revoke access from.
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

    // ===========================================
    // EXTENDED DOCUMENT OPERATIONS
    // ===========================================

    /**
     * Moves a document to a different folder.
     *
     * @param {string} docId - The document ID.
     * @param {string|null} targetFolderId - Target folder ID, or null for root.
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async moveDocument(docId, targetFolderId) {
        const data = await this._request({
            action: 'move_document',
            id: docId,
            target_folder_id: targetFolderId
        }, 'POST');
        return this._normalize(data);
    }

    /**
     * Creates a new document with extended options (folders, blob type).
     *
     * @param {Object} options - Document creation options.
     * @param {string} options.id - The document ID.
     * @param {string} options.title - The document title.
     * @param {string} [options.type='yjs'] - Document type ('yjs' or 'blob').
     * @param {string|null} [options.folderId=null] - Parent folder ID.
     * @param {string|null} [options.parentId=null] - Parent document ID (for attachments).
     * @param {string} [options.app] - Application name.
     * @param {string} [options.scope='drive'] - Storage scope ('app' or 'drive').
     * @param {string} [options.version] - Schema version (for yjs type).
     * @param {string|null} [options.filename=null] - Original filename (for blob type).
     * @param {string|null} [options.mimeType=null] - MIME type (for blob type).
     * @param {number|null} [options.size=null] - File size in bytes (for blob type).
     * @param {boolean} [options.publicRead=false] - Whether the document is publicly readable.
     * @param {boolean} [options.publicWrite=false] - Whether the document is publicly writable.
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async createDoc(options) {
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
        return this._normalize(data);
    }

    // ===========================================
    // LIST OPERATIONS
    // ===========================================

    /**
     * Lists documents with optional filters.
     *
     * @param {Object} [options={}] - Filter options.
     * @param {'app'|'drive'} [options.scope] - Filter by scope.
     * @param {string|null} [options.folderId] - Filter by folder ID.
     * @param {string|null} [options.parentId] - Filter by parent document ID.
     * @param {boolean} [options.showDeleted=false] - Include deleted documents (admin only).
     * @returns {Promise<import('../types').DocDescriptor[]>}
     */
    async list(options = {}) {
        const params = { action: 'list' };

        if (options.scope) params.scope = options.scope;
        if (options.folderId !== undefined) params.folder_id = options.folderId;
        if (options.parentId !== undefined) params.parent_id = options.parentId;
        if (options.showDeleted) params.show_deleted = 1;

        const data = await this._request(params);
        return data.map(this._normalize);
    }

    // ===========================================
    // DELETE OPERATIONS
    // ===========================================

    /**
     * Restores a soft-deleted document.
     *
     * @param {string} id - The document ID.
     * @returns {Promise<{success: boolean}>}
     */
    async restore(id) {
        return await this._request({ action: 'restore', id }, 'POST');
    }

    /**
     * Permanently deletes a document (must be soft-deleted first).
     *
     * @param {string} id - The document ID.
     * @returns {Promise<void>}
     */
    async permanentDelete(id) {
        await this._request({ action: 'permanent_delete', id }, 'POST');
    }

    // ===========================================
    // PUBLIC ACCESS
    // ===========================================

    /**
     * Sets public access flags on a document or folder.
     *
     * @param {string} id - The document or folder ID.
     * @param {'document'|'folder'} type - The resource type.
     * @param {boolean} publicRead - Whether the resource is publicly readable.
     * @param {boolean} publicWrite - Whether the resource is publicly writable.
     * @returns {Promise<import('../types').DocDescriptor|import('../types').Folder>}
     */
    async setPublic(id, type, publicRead, publicWrite) {
        const data = await this._request({
            action: 'set_public',
            id,
            type,
            public_read: publicRead ? 1 : 0,
            public_write: publicWrite ? 1 : 0
        }, 'POST');

        return type === 'folder' ? this._normalizeFolder(data) : this._normalize(data);
    }

    // ===========================================
    // ACCESS INFO
    // ===========================================

    /**
     * Gets access information for a document.
     *
     * This method can be called without authentication for public documents.
     *
     * @param {string} id - The document ID.
     * @param {string} [version] - Schema version (optional).
     * @returns {Promise<{id: string, room?: string, type?: string, filename?: string, mime_type?: string, size?: number, user: string|null, permissions: string[]}>}
     */
    async access(id, version) {
        const params = { action: 'access', id };
        if (version) params.version = version;

        // Allow public access - authentication not required for public documents
        return await this._request(params, 'GET', { requireAuth: false });
    }

    // ===========================================
    // DOCUMENT MOVING WITH PARENT
    // ===========================================

    /**
     * Moves a document to a different folder or changes its parent document.
     *
     * @param {string} docId - The document ID.
     * @param {Object} options - Move options.
     * @param {string|null} [options.targetFolderId] - Target folder ID, or null for root.
     * @param {string|null} [options.targetParentId] - Target parent document ID (for attachments).
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async moveDocumentWithOptions(docId, options = {}) {
        const params = {
            action: 'move_document',
            id: docId
        };

        if (options.targetFolderId !== undefined) {
            params.target_folder_id = options.targetFolderId;
        }
        if (options.targetParentId !== undefined) {
            params.target_parent_id = options.targetParentId;
        }

        const data = await this._request(params, 'POST');
        return this._normalize(data);
    }
}
