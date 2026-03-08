/**
 * FolderStore - Offline-first authoritative store for folder metadata.
 *
 * This class uses IndexedDB to persist folder descriptors locally. This allows
 * the application to show the folder tree immediately on startup, even before
 * the network sync completes.
 */
export class FolderStore {
    /**
     * @param {string} appName - Used to namespace the database.
     * @param {string} userName - Used to namespace the database (multi-user local support).
     */
    constructor(appName, userName) {
        this.dbName = `yjs_folders_${appName}_${userName}`;
        this.storeName = 'folders';
        this.version = 1;
        /** @type {IDBDatabase|null} */
        this.db = null;
    }

    /**
     * Opens the IndexedDB database and creates the object store if it doesn't exist.
     *
     * @returns {Promise<IDBDatabase>}
     */
    async open() {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(request.result);
            };

            request.onupgradeneeded = (event) => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    // Index for querying by parent
                    store.createIndex('parentId', 'parentId', { unique: false });
                }
            };
        });
    }

    /**
     * Retrieves all cached folder descriptors from the local store.
     *
     * @returns {Promise<import('../types').Folder[]>}
     */
    async getAll() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * @param {string} folderId
     * @returns {Promise<import('../types').Folder|null>}
     */
    async get(folderId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(folderId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result || null);
        });
    }

    /**
     * Gets all folders with a specific parent ID.
     *
     * @param {string|null} parentId
     * @returns {Promise<import('../types').Folder[]>}
     */
    async getByParent(parentId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('parentId');
            // Use null for root level folders (matches how folders are stored)
            const request = index.getAll(parentId || null);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * Persists or updates a folder descriptor in the local store.
     *
     * @param {import('../types').Folder} folder
     * @returns {Promise<void>}
     */
    async put(folder) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(folder);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * @param {string} folderId
     * @returns {Promise<void>}
     */
    async remove(folderId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(folderId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async clear() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * Bulk put multiple folders in a single transaction.
     * This is significantly faster than individual put() calls.
     *
     * @param {import('../types').Folder[]} folders
     * @returns {Promise<void>}
     */
    async putAll(folders) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);

            for (const folder of folders) {
                store.put(folder);
            }

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    /**
     * Atomically replaces all folders in the store.
     * This is safer than clear() + putAll() which can leave the store empty on failure.
     *
     * @param {import('../types').Folder[]} folders
     * @returns {Promise<void>}
     */
    async replaceAll(folders) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);

            // Clear and put all in the same transaction for atomicity
            store.clear();

            for (const folder of folders) {
                store.put(folder);
            }

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    /**
     * Closes the database connection.
     *
     * @returns {Promise<void>}
     */
    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
