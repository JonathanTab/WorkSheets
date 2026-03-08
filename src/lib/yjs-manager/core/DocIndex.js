/**
 * DocIndex - Logic for document classification and in-memory indexing.
 *
 * This class maintains a searchable map of documents and provides methods to filter
 * them by ownership and permissions. It is typically populated by `DocManager`
 * during initialization and synchronization.
 */
export class DocIndex {
    /**
     * @param {string} appName - The application namespace.
     * @param {string} [username] - The current user's username for ownership classification.
     */
    constructor(appName, username) {
        this.appName = appName;
        this.username = username || 'anonymous';
        /** @type {Map<string, import('../types').ClassifiedDoc>} */
        this.docsById = new Map();
        /** @type {Map<string, Set<string>>} Index of folderId -> docIds */
        this.docsByFolder = new Map();
        /** @type {Map<string, Set<string>>} Index of parentId -> docIds (for attachments) */
        this.docsByParent = new Map();
    }

    /**
     * Rebuilds the index from a fresh set of document descriptors.
     *
     * @param {import('../types').DocDescriptor[]} descriptors - Raw descriptors from API or Store.
     */
    update(descriptors) {
        this.docsById.clear();
        this.docsByFolder.clear();
        this.docsByParent.clear();

        for (const desc of descriptors) {
            const classified = this.classify(desc);
            this.docsById.set(classified.id, classified);
            this._addToFolderIndex(classified);
            this._addToParentIndex(classified);
        }
    }

    /**
     * @private
     * @param {import('../types').ClassifiedDoc} doc
     */
    _addToFolderIndex(doc) {
        const folderKey = doc.folderId || '__root__';
        if (!this.docsByFolder.has(folderKey)) {
            this.docsByFolder.set(folderKey, new Set());
        }
        this.docsByFolder.get(folderKey).add(doc.id);
    }

    /**
     * @private
     * @param {import('../types').ClassifiedDoc} doc
     */
    _addToParentIndex(doc) {
        if (doc.parentId) {
            if (!this.docsByParent.has(doc.parentId)) {
                this.docsByParent.set(doc.parentId, new Set());
            }
            this.docsByParent.get(doc.parentId).add(doc.id);
        }
    }

    /**
     * @private
     * @param {import('../types').ClassifiedDoc} doc
     */
    _removeFromFolderIndex(doc) {
        const folderKey = doc.folderId || '__root__';
        const set = this.docsByFolder.get(folderKey);
        if (set) {
            set.delete(doc.id);
            if (set.size === 0) {
                this.docsByFolder.delete(folderKey);
            }
        }
    }

    /**
     * @private
     * @param {import('../types').ClassifiedDoc} doc
     */
    _removeFromParentIndex(doc) {
        if (doc.parentId) {
            const set = this.docsByParent.get(doc.parentId);
            if (set) {
                set.delete(doc.id);
                if (set.size === 0) {
                    this.docsByParent.delete(doc.parentId);
                }
            }
        }
    }

    /**
     * Augments a raw DocDescriptor with classification flags (owned, shared, writable).
     *
     * @param {import('../types').DocDescriptor} doc
     * @returns {import('../types').ClassifiedDoc}
     */
    classify(doc) {
        const owned = doc.owner === this.username;
        // Derive permissions from shared_with if not already set
        const permissions = doc.permissions?.length > 0
            ? doc.permissions
            : (doc.shared_with?.find(u => u.username === this.username)?.permissions || []);
        return {
            ...doc,
            owned,
            shared: !owned,
            writable: permissions.includes('write')
        };
    }

    /**
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getAll() {
        return Array.from(this.docsById.values());
    }

    /**
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getOwned() {
        return this.getAll().filter(d => d.owned);
    }

    /**
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getShared() {
        return this.getAll().filter(d => d.shared);
    }

    /**
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getWritable() {
        return this.getAll().filter(d => d.writable);
    }

    /**
     * @param {string} docId
     * @returns {import('../types').ClassifiedDoc|null}
     */
    getById(docId) {
        return this.docsById.get(docId) || null;
    }

    /**
     * Adds a single document to the index.
     * Useful for immediately updating the index after creating a document
     * without waiting for a full sync.
     *
     * @param {import('../types').DocDescriptor} doc
     * @returns {import('../types').ClassifiedDoc}
     */
    add(doc) {
        const classified = this.classify(doc);
        const existing = this.docsById.get(classified.id);

        // Remove old indexes if updating
        if (existing) {
            this._removeFromFolderIndex(existing);
            this._removeFromParentIndex(existing);
        }

        this.docsById.set(classified.id, classified);
        this._addToFolderIndex(classified);
        this._addToParentIndex(classified);
        return classified;
    }

    /**
     * Removes a single document from the index.
     *
     * @param {string} docId
     */
    remove(docId) {
        const doc = this.docsById.get(docId);
        if (doc) {
            this._removeFromFolderIndex(doc);
            this._removeFromParentIndex(doc);
        }
        this.docsById.delete(docId);
    }

    /**
     * Gets all documents in a specific folder.
     *
     * @param {string|null} folderId - Folder ID, or null for root level documents.
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getByFolder(folderId) {
        const folderKey = folderId || '__root__';
        const ids = this.docsByFolder.get(folderKey);
        if (!ids) return [];
        return Array.from(ids)
            .map(id => this.docsById.get(id))
            .filter(Boolean);
    }

    /**
     * Gets all attachments of a parent document.
     *
     * @param {string} parentId - Parent document ID.
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getByParent(parentId) {
        const ids = this.docsByParent.get(parentId);
        if (!ids) return [];
        return Array.from(ids)
            .map(id => this.docsById.get(id))
            .filter(Boolean);
    }

    /**
     * Gets all documents of a specific type.
     *
     * @param {'yjs'|'blob'} type - Document type.
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getByType(type) {
        return this.getAll().filter(d => d.type === type);
    }

    /**
     * Gets all documents with a specific scope.
     *
     * @param {'app'|'drive'} scope - Storage scope.
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getByScope(scope) {
        return this.getAll().filter(d => d.scope === scope);
    }

    /**
     * Gets all app-scoped documents for this app.
     *
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getAppScoped() {
        return this.getAll().filter(d => d.scope === 'app' && d.app === this.appName);
    }

    /**
     * Gets all drive-scoped documents.
     *
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getDriveScoped() {
        return this.getAll().filter(d => d.scope === 'drive');
    }

    /**
     * Gets all publicly readable documents.
     *
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getPublic() {
        return this.getAll().filter(d => d.publicRead);
    }

    /**
     * Gets all soft-deleted documents.
     *
     * @returns {import('../types').ClassifiedDoc[]}
     */
    getDeleted() {
        return this.getAll().filter(d => d.deleted);
    }
}
