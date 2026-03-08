/**
 * FileIndex - Logic for file classification and in-memory indexing.
 *
 * This class maintains a searchable map of files and provides methods to filter
 * them by ownership, permissions, scope, and relationships. It is typically
 * populated by `StorageCore` during initialization and synchronization.
 *
 * Renamed from DocIndex to FileIndex to align with new terminology.
 */
export class FileIndex {
    /**
     * @param {string} appName - The application namespace.
     * @param {string} [username] - The current user's username for ownership classification.
     */
    constructor(appName, username) {
        this.appName = appName;
        this.username = username || 'anonymous';
        /** @type {Map<string, import('../types').ClassifiedFile>} */
        this.filesById = new Map();
        /** @type {Map<string, Set<string>>} Index of folderId -> fileIds */
        this.filesByFolder = new Map();
        /** @type {Map<string, Set<string>>} Index of parentId -> fileIds (for attachments) */
        this.filesByParent = new Map();
    }

    /**
     * Rebuilds the index from a fresh set of file descriptors.
     *
     * @param {import('../types').FileDescriptor[]} descriptors - Raw descriptors from API or Store.
     */
    update(descriptors) {
        this.filesById.clear();
        this.filesByFolder.clear();
        this.filesByParent.clear();

        for (const desc of descriptors) {
            const classified = this.classify(desc);
            this.filesById.set(classified.id, classified);
            this._addToFolderIndex(classified);
            this._addToParentIndex(classified);
        }
    }

    /**
     * @private
     * @param {import('../types').ClassifiedFile} file
     */
    _addToFolderIndex(file) {
        const folderKey = file.folderId || '__root__';
        if (!this.filesByFolder.has(folderKey)) {
            this.filesByFolder.set(folderKey, new Set());
        }
        this.filesByFolder.get(folderKey).add(file.id);
    }

    /**
     * @private
     * @param {import('../types').ClassifiedFile} file
     */
    _addToParentIndex(file) {
        if (file.parentId) {
            if (!this.filesByParent.has(file.parentId)) {
                this.filesByParent.set(file.parentId, new Set());
            }
            this.filesByParent.get(file.parentId).add(file.id);
        }
    }

    /**
     * @private
     * @param {import('../types').ClassifiedFile} file
     */
    _removeFromFolderIndex(file) {
        const folderKey = file.folderId || '__root__';
        const set = this.filesByFolder.get(folderKey);
        if (set) {
            set.delete(file.id);
            if (set.size === 0) {
                this.filesByFolder.delete(folderKey);
            }
        }
    }

    /**
     * @private
     * @param {import('../types').ClassifiedFile} file
     */
    _removeFromParentIndex(file) {
        if (file.parentId) {
            const set = this.filesByParent.get(file.parentId);
            if (set) {
                set.delete(file.id);
                if (set.size === 0) {
                    this.filesByParent.delete(file.parentId);
                }
            }
        }
    }

    /**
     * Augments a raw FileDescriptor with classification flags (owned, shared, writable).
     *
     * @param {import('../types').FileDescriptor} file
     * @returns {import('../types').ClassifiedFile}
     */
    classify(file) {
        const owned = file.owner === this.username;
        // Derive permissions from the permissions array or sharedWith
        const permissions = file.permissions?.length > 0
            ? file.permissions
            : (file.sharedWith?.find(u => u.username === this.username)?.permissions || []);
        // A file is shared if it has entries in sharedWith (someone has been granted access)
        // This is true for both owned files (shared with others) and files shared with current user
        const hasShares = file.sharedWith && file.sharedWith.length > 0;
        return {
            ...file,
            owned,
            shared: hasShares || !owned,
            writable: owned || permissions.includes('write')  // FIX: owned files are always writable
        };
    }

    /**
     * @returns {import('../types').ClassifiedFile[]}
     */
    getAll() {
        return Array.from(this.filesById.values());
    }

    /**
     * @returns {import('../types').ClassifiedFile[]}
     */
    getOwned() {
        return this.getAll().filter(f => f.owned);
    }

    /**
     * @returns {import('../types').ClassifiedFile[]}
     */
    getShared() {
        return this.getAll().filter(f => f.shared);
    }

    /**
     * @returns {import('../types').ClassifiedFile[]}
     */
    getWritable() {
        return this.getAll().filter(f => f.writable);
    }

    /**
     * @param {string} fileId
     * @returns {import('../types').ClassifiedFile|null}
     */
    getById(fileId) {
        return this.filesById.get(fileId) || null;
    }

    /**
     * Adds a single file to the index.
     * Useful for immediately updating the index after creating a file
     * without waiting for a full sync.
     *
     * @param {import('../types').FileDescriptor} file
     * @returns {import('../types').ClassifiedFile}
     */
    add(file) {
        const classified = this.classify(file);
        const existing = this.filesById.get(classified.id);

        // Remove old indexes if updating
        if (existing) {
            this._removeFromFolderIndex(existing);
            this._removeFromParentIndex(existing);
        }

        this.filesById.set(classified.id, classified);
        this._addToFolderIndex(classified);
        this._addToParentIndex(classified);
        return classified;
    }

    /**
     * Removes a single file from the index.
     *
     * @param {string} fileId
     */
    remove(fileId) {
        const file = this.filesById.get(fileId);
        if (file) {
            this._removeFromFolderIndex(file);
            this._removeFromParentIndex(file);
        }
        this.filesById.delete(fileId);
    }

    /**
     * Gets all files in a specific folder.
     *
     * @param {string|null} folderId - Folder ID, or null for root level files.
     * @returns {import('../types').ClassifiedFile[]}
     */
    getByFolder(folderId) {
        const folderKey = folderId || '__root__';
        const ids = this.filesByFolder.get(folderKey);
        if (!ids) return [];
        return Array.from(ids)
            .map(id => this.filesById.get(id))
            .filter(Boolean);
    }

    /**
     * Gets all attachments of a parent file.
     *
     * @param {string} parentId - Parent file ID.
     * @returns {import('../types').ClassifiedFile[]}
     */
    getByParent(parentId) {
        const ids = this.filesByParent.get(parentId);
        if (!ids) return [];
        return Array.from(ids)
            .map(id => this.filesById.get(id))
            .filter(Boolean);
    }

    /**
     * Gets all files of a specific type.
     *
     * @param {'yjs'|'blob'} type - File type.
     * @returns {import('../types').ClassifiedFile[]}
     */
    getByType(type) {
        return this.getAll().filter(f => f.type === type);
    }

    /**
     * Gets all files with a specific scope.
     *
     * @param {'app'|'drive'} scope - Storage scope.
     * @returns {import('../types').ClassifiedFile[]}
     */
    getByScope(scope) {
        return this.getAll().filter(f => f.scope === scope);
    }

    /**
     * Gets all app-scoped files for this app.
     *
     * @returns {import('../types').ClassifiedFile[]}
     */
    getAppScoped() {
        return this.getAll().filter(f => f.scope === 'app' && f.app === this.appName);
    }

    /**
     * Gets all drive-scoped files.
     *
     * @returns {import('../types').ClassifiedFile[]}
     */
    getDriveScoped() {
        return this.getAll().filter(f => f.scope === 'drive');
    }

    /**
     * Gets all publicly readable files.
     *
     * @returns {import('../types').ClassifiedFile[]}
     */
    getPublic() {
        return this.getAll().filter(f => f.publicRead);
    }

    /**
     * Gets all soft-deleted files.
     *
     * @returns {import('../types').ClassifiedFile[]}
     */
    getDeleted() {
        return this.getAll().filter(f => f.deleted);
    }
}

// Legacy export alias for backward compatibility
export { FileIndex as DocIndex };
