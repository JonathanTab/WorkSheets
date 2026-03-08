/**
 * MetadataStore - Offline-first authoritative store for document metadata.
 *
 * This class uses IndexedDB to persist document descriptors locally. This allows
 * the application to show the document list immediately on startup, even before
 * the network sync completes.
 */
export class MetadataStore {
    /**
     * @param {string} appName - Used to namespace the database.
     * @param {string} userName - Used to namespace the database (multi-user local support).
     */
    constructor(appName, userName) {
        this.dbName = `yjs_doc_manager_${appName}_${userName}`;
        this.storeName = 'metadata';
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
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
        });
    }

    /**
     * Retrieves all cached document descriptors from the local store.
     *
     * @returns {Promise<import('../types').DocDescriptor[]>}
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
     * @param {string} docId
     * @returns {Promise<import('../types').DocDescriptor|null>}
     */
    async get(docId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(docId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result || null);
        });
    }

    /**
     * Persists or updates a document descriptor in the local store.
     *
     * @param {import('../types').DocDescriptor} doc
     * @returns {Promise<void>}
     */
    async put(doc) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(doc);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * @param {string} docId
     * @returns {Promise<void>}
     */
    async remove(docId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(docId);

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
     * Bulk put multiple documents in a single transaction.
     * This is significantly faster than individual put() calls.
     *
     * @param {import('../types').DocDescriptor[]} docs
     * @returns {Promise<void>}
     */
    async putAll(docs) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);

            for (const doc of docs) {
                store.put(doc);
            }

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    /**
     * Atomically replaces all documents in the store.
     * This is safer than clear() + putAll() which can leave the store empty on failure.
     *
     * @param {import('../types').DocDescriptor[]} docs
     * @returns {Promise<void>}
     */
    async replaceAll(docs) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);

            // Clear and put all in the same transaction for atomicity
            store.clear();

            for (const doc of docs) {
                store.put(doc);
            }

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
