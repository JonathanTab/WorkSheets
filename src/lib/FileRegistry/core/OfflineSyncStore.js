/**
 * OfflineSyncStore - Shared cross-app IndexedDB store for tracking pending Yjs syncs.
 *
 * Keyed on the username so all apps for the same user share one database.
 * DB name: fileregistry_pending_{username}
 *
 * Stores:
 *   'pending'    - Yjs rooms that need WebSocket sync after being edited offline.
 *   'touchQueue' - Files whose server updatedAt needs to be bumped when online.
 */
export class OfflineSyncStore {
    /** @param {string} username */
    constructor(username) {
        this.dbName = `fileregistry_pending_${username}`;
        /** @type {IDBDatabase|null} */
        this._db = null;
    }

    async open() {
        if (this._db) return;
        this._db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('pending')) {
                    db.createObjectStore('pending', { keyPath: 'fileId' });
                }
                if (!db.objectStoreNames.contains('touchQueue')) {
                    db.createObjectStore('touchQueue', { keyPath: 'fileId' });
                }
            };
        });
    }

    // -------------------------------------------------------
    // Pending Yjs sync
    // -------------------------------------------------------

    /**
     * Record a Yjs room as needing sync. Idempotent — same fileId overwrites.
     * @param {{ fileId: string, roomId: string, wsUrl: string, modifiedAt: string }} entry
     */
    async addPending(entry) {
        return this._put('pending', entry);
    }

    async removePending(fileId) {
        return this._delete('pending', fileId);
    }

    /** @returns {Promise<{fileId, roomId, wsUrl, modifiedAt}[]>} */
    async getAllPending() {
        return this._getAll('pending');
    }

    // -------------------------------------------------------
    // Touch queue (server updatedAt)
    // -------------------------------------------------------

    /**
     * Queue a server touch for a file. Idempotent.
     * @param {{ fileId: string, modifiedAt: string }} entry
     */
    async addToTouchQueue(entry) {
        return this._put('touchQueue', entry);
    }

    async removeFromTouchQueue(fileId) {
        return this._delete('touchQueue', fileId);
    }

    /** @returns {Promise<{fileId, modifiedAt}[]>} */
    async getAllTouchQueue() {
        return this._getAll('touchQueue');
    }

    // -------------------------------------------------------
    // Internal
    // -------------------------------------------------------

    async _getAll(storeName) {
        const db = this._db;
        return new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    async _put(storeName, value) {
        const db = this._db;
        return new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(value);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    async _delete(storeName, key) {
        const db = this._db;
        return new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    close() {
        this._db?.close();
        this._db = null;
    }
}
