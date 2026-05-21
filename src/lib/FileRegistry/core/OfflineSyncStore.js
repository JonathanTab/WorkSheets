/**
 * OfflineSyncStore - Shared cross-app IndexedDB store for all offline coordination.
 *
 * Keyed on the username so all apps for the same user share one database.
 * DB name: fileregistry_pending_{username}
 *
 * Stores (v1):
 *   'pending'       - Yjs rooms needing WebSocket sync after being edited offline.
 *   'touchQueue'    - Files whose server updatedAt needs bumped when online.
 *
 * Stores (v2 additions):
 *   'mutations'     - Offline metadata mutations (create/rename/delete/move/etc.)
 *   'recents'       - Cross-app per-user access log (fileId → {appName, atime})
 *   'drive_files'   - Shared drive FileDescriptor cache (across all apps for this user)
 *   'drive_folders' - Shared drive Folder cache
 *   'drive_meta'    - Drive sync metadata (lastSync timestamp, etc.)
 *
 * Stores (v3 additions):
 *   'pending_blobs' - Offline-created blob files awaiting upload (previously in v2
 *                     but not always migrated; bumped to v3 to guarantee creation)
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
            const req = indexedDB.open(this.dbName, 3);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = (e) => {
                const db = req.result;
                // V1 stores
                if (!db.objectStoreNames.contains('pending')) {
                    db.createObjectStore('pending', { keyPath: 'fileId' });
                }
                if (!db.objectStoreNames.contains('touchQueue')) {
                    db.createObjectStore('touchQueue', { keyPath: 'fileId' });
                }
                // V2 additions
                if (e.oldVersion < 2) {
                    const ms = db.createObjectStore('mutations', { keyPath: 'id' });
                    ms.createIndex('by_created', 'createdAt');

                    db.createObjectStore('recents', { keyPath: 'fileId' });

                    db.createObjectStore('drive_files', { keyPath: 'id' });
                    db.createObjectStore('drive_folders', { keyPath: 'id' });
                    db.createObjectStore('drive_meta');
                }
                // V3: guarantee pending_blobs exists (was in v2 but not always migrated)
                if (!db.objectStoreNames.contains('pending_blobs')) {
                    db.createObjectStore('pending_blobs', { keyPath: 'id' });
                }
            };
        });
    }

    // -------------------------------------------------------
    // Pending Yjs sync
    // -------------------------------------------------------

    /**
     * Record a Yjs room as needing sync. Idempotent — same fileId overwrites.
     * @param {{ fileId: string, roomId: string, wsUrl: string, mtime: string }} entry
     */
    async addPending(entry) {
        return this._put('pending', entry);
    }

    async removePending(fileId) {
        return this._delete('pending', fileId);
    }

    /** @returns {Promise<{fileId, roomId, wsUrl, mtime}[]>} */
    async getAllPending() {
        return this._getAll('pending');
    }

    // -------------------------------------------------------
    // Touch queue (server updatedAt)
    // -------------------------------------------------------

    /**
     * Queue a server touch for a file. Idempotent.
     * @param {{ fileId: string, mtime: string }} entry
     */
    async addToTouchQueue(entry) {
        return this._put('touchQueue', entry);
    }

    async removeFromTouchQueue(fileId) {
        return this._delete('touchQueue', fileId);
    }

    /** @returns {Promise<{fileId, mtime}[]>} */
    async getAllTouchQueue() {
        return this._getAll('touchQueue');
    }

    // -------------------------------------------------------
    // Offline mutation queue
    // -------------------------------------------------------

    /**
     * Persist a metadata mutation for later replay.
     * @param {{ id: string, type: string, payload: object, createdAt: string, attempts: number, lastError: string|null }} mutation
     */
    async addMutation(mutation) {
        return this._put('mutations', mutation);
    }

    async removeMutation(id) {
        return this._delete('mutations', id);
    }

    /**
     * Returns all pending mutations sorted by seq (monotonic) ascending.
     * Falls back to createdAt string comparison for pre-seq entries.
     * @returns {Promise<object[]>}
     */
    async getAllMutations() {
        const all = await this._getAll('mutations');
        all.sort((a, b) => {
            // Prefer numeric seq; fall back to ISO createdAt string (lexical = chronological)
            const aKey = a.seq ?? a.createdAt;
            const bKey = b.seq ?? b.createdAt;
            if (aKey < bKey) return -1;
            if (aKey > bKey) return 1;
            return 0;
        });
        return all;
    }

    // -------------------------------------------------------
    // Cross-app recents
    // -------------------------------------------------------

    /**
     * Record a file as accessed (updates atime). Keyed by fileId.
     * @param {string} fileId
     * @param {string} appName
     */
    async recordAccess(fileId, appName) {
        return this._put('recents', { fileId, appName, atime: new Date().toISOString() });
    }

    /**
     * Returns recents sorted by atime descending.
     * @param {number} [limit=100]
     * @returns {Promise<{fileId: string, appName: string, atime: string}[]>}
     */
    async getRecents(limit = 100) {
        const all = await this._getAll('recents');
        all.sort((a, b) => b.atime > a.atime ? 1 : -1); // newest first
        return all.slice(0, limit);
    }

    /**
     * Merge recents from server — keep whichever atime is newer.
     * @param {{ fileId: string, appName: string|null, atime?: string, opened_at?: string }[]} serverRecents
     */
    async mergeRecents(serverRecents) {
        for (const r of serverRecents) {
            const fileId = r.fileId ?? r.file_id;
            if (!fileId) continue;
            const atime = r.atime ?? r.openedAt ?? r.opened_at;
            const appName = r.appName ?? r.app_name ?? null;
            if (!atime) continue;
            const existing = await this._get('recents', fileId);
            if (!existing || atime > existing.atime) {
                await this._put('recents', { fileId, appName, atime });
            }
        }
    }

    // -------------------------------------------------------
    // Pending offline blobs (awaiting upload)
    // -------------------------------------------------------

    /**
     * Store a blob that was created offline. The blob content is preserved in IDB
     * until the network mutation is flushed and the upload completes.
     * @param {string} id - client-generated file ID (same as FileDescriptor.id)
     * @param {Blob} blob - the raw file content
     * @param {object} metadata - create options needed to replay the server-side create
     */
    async storePendingBlob(id, blob, metadata) {
        return this._put('pending_blobs', { id, blob, metadata });
    }

    /**
     * Retrieve a pending offline blob by file ID.
     * Returns null if the blob has already been uploaded or doesn't exist.
     * @param {string} id @returns {Promise<{id: string, blob: Blob, metadata: object}|null>}
     */
    async getPendingBlob(id) {
        return this._get('pending_blobs', id);
    }

    async removePendingBlob(id) {
        return this._delete('pending_blobs', id);
    }

    /** @returns {Promise<{id, blob, metadata}[]>} */
    async getAllPendingBlobs() {
        return this._getAll('pending_blobs');
    }

    // -------------------------------------------------------
    // Shared drive cache
    // -------------------------------------------------------

    /**
     * Atomically replace the entire drive cache (files + folders) in one transaction.
     * @param {object[]} files
     * @param {object[]} folders
     */
    async replaceDrive(files, folders) {
        const db = this._db;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['drive_files', 'drive_folders', 'drive_meta'], 'readwrite');
            tx.objectStore('drive_files').clear();
            tx.objectStore('drive_folders').clear();
            for (const f of files)   tx.objectStore('drive_files').put(f);
            for (const f of folders) tx.objectStore('drive_folders').put(f);
            tx.objectStore('drive_meta').put(new Date().toISOString(), 'lastSync');
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    /** @returns {Promise<object[]>} */
    async getDriveFiles() { return this._getAll('drive_files'); }

    /** @returns {Promise<object[]>} */
    async getDriveFolders() { return this._getAll('drive_folders'); }

    /** @returns {Promise<{ lastSync: string|null }>} */
    async getDriveMeta() {
        const val = await this._get('drive_meta', 'lastSync');
        return { lastSync: val ?? null };
    }

    /** Optimistic single-file update in the shared drive cache. */
    async putDriveFile(file) { return this._put('drive_files', file); }

    /** Optimistic single-folder update in the shared drive cache. */
    async putDriveFolder(folder) { return this._put('drive_folders', folder); }

    async removeDriveFile(id) { return this._delete('drive_files', id); }
    async removeDriveFolder(id) { return this._delete('drive_folders', id); }

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

    async _get(storeName, key) {
        const db = this._db;
        return new Promise((resolve, reject) => {
            const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
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
