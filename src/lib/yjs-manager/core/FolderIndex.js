/**
 * FolderIndex - Logic for folder classification and in-memory tree indexing.
 *
 * This class maintains a searchable map of folders and provides methods to filter
 * them by ownership, permissions, and hierarchy. It is typically populated by
 * `StorageCore` during initialization and synchronization.
 */
export class FolderIndex {
    /**
     * @param {string} username - The current user's username for ownership classification.
     */
    constructor(username) {
        this.username = username || 'anonymous';
        /** @type {Map<string, import('../types').ClassifiedFolder>} */
        this.byId = new Map();
        /** @type {Map<string, import('../types').ClassifiedFolder[]>} children by parentId ('root' for root level) */
        this.children = new Map();
    }

    /**
     * Augments a raw Folder with classification flags (owned, shared, writable).
     *
     * @param {import('../types').Folder} folder
     * @returns {import('../types').ClassifiedFolder}
     */
    classify(folder) {
        const owned = folder.owner === this.username;
        // Derive permissions from sharedWith (normalized camelCase) or shared_with (legacy)
        const sharedWith = folder.sharedWith || folder.shared_with || [];
        const permissions = folder.permissions?.length > 0
            ? folder.permissions
            : (sharedWith.find(u => u.username === this.username)?.permissions || []);
        // A folder is shared if it has entries in sharedWith (someone has been granted access)
        // This is true for both owned folders (shared with others) and folders shared with current user
        const hasShares = sharedWith && sharedWith.length > 0;
        return {
            ...folder,
            owned,
            shared: hasShares || !owned,
            writable: owned || permissions.includes('write')  // FIX: owned folders are always writable
        };
    }

    /**
     * Rebuilds the index from a fresh set of folder descriptors.
     *
     * @param {import('../types').Folder[]} folders - Raw descriptors from API or Store.
     */
    update(folders) {
        this.byId.clear();
        this.children.clear();

        for (const raw of folders) {
            const folder = this.classify(raw);
            this.byId.set(folder.id, folder);
        }

        // Build children map after all folders are in byId
        for (const folder of this.byId.values()) {
            const parentKey = folder.parentId || 'root';
            if (!this.children.has(parentKey)) {
                this.children.set(parentKey, []);
            }
            this.children.get(parentKey).push(folder);
        }
    }

    /**
     * Adds a single folder to the index.
     * Useful for immediately updating the index after creating a folder
     * without waiting for a full sync.
     *
     * @param {import('../types').Folder} folder
     * @returns {import('../types').ClassifiedFolder}
     */
    add(folder) {
        const classified = this.classify(folder);

        // Check if folder already exists with different parent
        const existing = this.byId.get(classified.id);
        if (existing) {
            // Remove from old parent's children
            const oldParentKey = existing.parentId || 'root';
            const oldSiblings = this.children.get(oldParentKey);
            if (oldSiblings) {
                const idx = oldSiblings.findIndex(f => f.id === classified.id);
                if (idx !== -1) {
                    oldSiblings.splice(idx, 1);
                }
            }
        }

        // Add/update in byId map
        this.byId.set(classified.id, classified);

        // Add to new parent's children
        const parentKey = classified.parentId || 'root';
        if (!this.children.has(parentKey)) {
            this.children.set(parentKey, []);
        }
        const siblings = this.children.get(parentKey);
        const existingIdx = siblings.findIndex(f => f.id === classified.id);
        if (existingIdx === -1) {
            siblings.push(classified);
        } else {
            siblings[existingIdx] = classified;
        }

        return classified;
    }

    /**
     * Removes a folder and all its descendants from the index.
     *
     * @param {string} folderId
     */
    remove(folderId) {
        const folder = this.byId.get(folderId);
        if (!folder) return;

        // Recursively remove children first
        const childFolders = this.children.get(folderId) || [];
        for (const child of childFolders) {
            this.remove(child.id);
        }

        // Remove from parent's children list
        const parentKey = folder.parentId || 'root';
        const siblings = this.children.get(parentKey);
        if (siblings) {
            const idx = siblings.findIndex(f => f.id === folderId);
            if (idx !== -1) {
                siblings.splice(idx, 1);
            }
        }

        // Remove from byId map
        this.byId.delete(folderId);

        // Remove empty children entry
        if (this.children.has(folderId)) {
            this.children.delete(folderId);
        }
    }

    /**
     * Gets a folder by its ID.
     *
     * @param {string} folderId
     * @returns {import('../types').ClassifiedFolder|null}
     */
    getById(folderId) {
        return this.byId.get(folderId) || null;
    }

    /**
     * Gets the children of a folder.
     *
     * @param {string|null} parentId - Parent folder ID, or null for root level.
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getChildren(parentId = null) {
        const key = parentId || 'root';
        return this.children.get(key) || [];
    }

    /**
     * Gets all folders in the index.
     *
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getAll() {
        return Array.from(this.byId.values());
    }

    /**
     * Gets all folders owned by the current user.
     *
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getOwned() {
        return this.getAll().filter(f => f.owned);
    }

    /**
     * Gets all folders shared with the current user.
     *
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getShared() {
        return this.getAll().filter(f => f.shared);
    }

    /**
     * Gets all folders where the user has write permission.
     *
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getWritable() {
        return this.getAll().filter(f => f.writable);
    }

    /**
     * Gets all publicly readable folders.
     *
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getPublic() {
        return this.getAll().filter(f => f.publicRead);
    }

    /**
     * Gets all publicly writable folders.
     *
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getPublicWritable() {
        return this.getAll().filter(f => f.publicWrite);
    }

    /**
     * Gets the ancestor path from root to the specified folder.
     *
     * @param {string} folderId
     * @returns {import('../types').ClassifiedFolder[]} - Array from root to the folder (inclusive).
     */
    getAncestors(folderId) {
        const path = [];
        let current = this.byId.get(folderId);

        while (current) {
            path.unshift(current);
            current = current.parentId ? this.byId.get(current.parentId) : null;
        }

        return path;
    }

    /**
     * Gets all descendant folders of a given folder (not including the folder itself).
     *
     * @param {string} folderId
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getDescendants(folderId) {
        const descendants = [];
        const stack = this.getChildren(folderId);

        while (stack.length > 0) {
            const folder = stack.pop();
            descendants.push(folder);
            stack.push(...this.getChildren(folder.id));
        }

        return descendants;
    }

    /**
     * Checks if a folder is an ancestor of another folder.
     *
     * @param {string} potentialAncestorId
     * @param {string} folderId
     * @returns {boolean}
     */
    isAncestor(potentialAncestorId, folderId) {
        let current = this.byId.get(folderId);
        while (current) {
            if (current.parentId === potentialAncestorId) {
                return true;
            }
            current = current.parentId ? this.byId.get(current.parentId) : null;
        }
        return false;
    }

    /**
     * Moves a folder to a new parent.
     * This only updates the in-memory index; it does not persist the change.
     *
     * @param {string} folderId
     * @param {string|null} newParentId
     * @returns {import('../types').ClassifiedFolder|null}
     */
    move(folderId, newParentId) {
        const folder = this.byId.get(folderId);
        if (!folder) return null;

        // Prevent moving a folder into itself or its descendants
        if (folderId === newParentId || this.isAncestor(folderId, newParentId)) {
            return null;
        }

        // Remove from old parent's children
        const oldParentKey = folder.parentId || 'root';
        const oldSiblings = this.children.get(oldParentKey);
        if (oldSiblings) {
            const idx = oldSiblings.findIndex(f => f.id === folderId);
            if (idx !== -1) {
                oldSiblings.splice(idx, 1);
            }
        }

        // Update folder's parentId
        const updated = { ...folder, parentId: newParentId };
        this.byId.set(folderId, updated);

        // Add to new parent's children
        const newParentKey = newParentId || 'root';
        if (!this.children.has(newParentKey)) {
            this.children.set(newParentKey, []);
        }
        this.children.get(newParentKey).push(updated);

        return updated;
    }
}
