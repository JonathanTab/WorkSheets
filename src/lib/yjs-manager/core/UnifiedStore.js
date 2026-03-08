/**
 * UnifiedStore - Single IndexedDB database for both files and folders.
 *
 * This class consolidates the previously separate MetadataStore and FolderStore
 * into a single database named `storage_{appName}_{username}`. This ensures
 * atomic transactions across files and folders during sync operations.
 *
 * ## Migration
 * On first open, the store checks for legacy databases (`yjs_doc_manager_*` and
 * `yjs_folders_*`) and migrates their data into the new unified store.
 */

// Legacy database name patterns
const LEGACY_DOC_DB_PREFIX = 'yjs_doc_manager_';
const LEGACY_FOLDER_DB_PREFIX = 'yjs_folders_';

// Migration status values
const MIGRATION_STATUS = {
    NOT_STARTED: 'not_started',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

/**
 * @typedef {Object} UnifiedStoreOptions
 * @property {string} appName - Application name for database namespacing.
 * @property {string} userName - Username for database namespacing.
 */

export class UnifiedStore {
    /**
     * @param {string} appName - Used to namespace the database.
     * @param {string} userName - Used to namespace the database (multi-user local support).
     */
    constructor(appName, userName) {
        this.dbName = `storage_${appName}_${userName}`;
        this.filesStoreName = 'files';
        this.foldersStoreName = 'folders';
        this.version = 1;
        /** @type {IDBDatabase|null} */
        this.db = null;
        this.appName = appName;
        this.userName = userName;
    }

    /**
     * Opens the IndexedDB database, creating object stores if needed.
     * Also performs migration from legacy databases if they exist.
     *
     * @returns {Promise<IDBDatabase>}
     */
    async open() {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = async () => {
                this.db = request.result;

                // Check for legacy databases and migrate
                try {
                    await this._migrateFromLegacyStores();
                } catch (err) {
                    console.error('[UnifiedStore] Migration error:', err);
                    // Continue even if migration fails - user can still use the app
                }

                resolve(request.result);
            };

            request.onupgradeneeded = (event) => {
                const db = request.result;

                // Create files object store
                if (!db.objectStoreNames.contains(this.filesStoreName)) {
                    const filesStore = db.createObjectStore(this.filesStoreName, { keyPath: 'id' });
                    filesStore.createIndex('scope', 'scope', { unique: false });
                    filesStore.createIndex('folderId', 'folderId', { unique: false });
                    filesStore.createIndex('parentId', 'parentId', { unique: false });
                    filesStore.createIndex('type', 'type', { unique: false });
                }

                // Create folders object store
                if (!db.objectStoreNames.contains(this.foldersStoreName)) {
                    const foldersStore = db.createObjectStore(this.foldersStoreName, { keyPath: 'id' });
                    foldersStore.createIndex('parentId', 'parentId', { unique: false });
                }
            };
        });
    }

    /**
     * Gets the migration state from localStorage.
     * @private
     * @returns {{ status: string, fileCount: number, folderCount: number, timestamp: number|null }}
     */
    _getMigrationState() {
        const migrationKey = `migration_state_${this.dbName}`;
        const stored = localStorage.getItem(migrationKey);
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                return { status: MIGRATION_STATUS.NOT_STARTED, fileCount: 0, folderCount: 0, timestamp: null };
            }
        }
        return { status: MIGRATION_STATUS.NOT_STARTED, fileCount: 0, folderCount: 0, timestamp: null };
    }

    /**
     * Saves the migration state to localStorage.
     * @private
     * @param {string} status
     * @param {number} fileCount
     * @param {number} folderCount
     */
    _setMigrationState(status, fileCount = 0, folderCount = 0) {
        const migrationKey = `migration_state_${this.dbName}`;
        localStorage.setItem(migrationKey, JSON.stringify({
            status,
            fileCount,
            folderCount,
            timestamp: Date.now()
        }));
    }

    /**
     * Verifies that migrated data was written correctly.
     * @private
     * @param {number} expectedFiles
     * @param {number} expectedFolders
     * @returns {Promise<boolean>}
     */
    async _verifyMigration(expectedFiles, expectedFolders) {
        const actualFiles = await this.getAllFiles();
        const actualFolders = await this.getAllFolders();
        return actualFiles.length >= expectedFiles && actualFolders.length >= expectedFolders;
    }

    /**
     * Checks for and migrates data from legacy separate databases.
     * Uses robust state tracking to recover from interrupted migrations.
     * @private
     */
    async _migrateFromLegacyStores() {
        const legacyDocDbName = `${LEGACY_DOC_DB_PREFIX}${this.appName}_${this.userName}`;
        const legacyFolderDbName = `${LEGACY_FOLDER_DB_PREFIX}${this.appName}_${this.userName}`;

        const migrationState = this._getMigrationState();

        // Check if migration already completed successfully
        if (migrationState.status === MIGRATION_STATUS.COMPLETED) {
            // Verify the data is actually there
            const existingFiles = await this.getAllFiles();
            if (existingFiles.length > 0 || migrationState.fileCount === 0) {
                return; // Migration complete and verified
            }
            // Data missing but marked complete - need to re-migrate
            console.warn('[UnifiedStore] Migration marked complete but data missing, re-migrating...');
        }

        // Check if there's already data in the new store (from server sync)
        const existingFiles = await this.getAllFiles();
        if (existingFiles.length > 0) {
            // Already have data from another source, mark as complete
            this._setMigrationState(MIGRATION_STATUS.COMPLETED, existingFiles.length, (await this.getAllFolders()).length);
            return;
        }

        // Check if a migration is in progress (possibly from a crashed tab)
        if (migrationState.status === MIGRATION_STATUS.IN_PROGRESS) {
            const timeSinceStart = Date.now() - (migrationState.timestamp || 0);
            // If less than 30 seconds, another migration might be in progress
            if (timeSinceStart < 30000) {
                console.log('[UnifiedStore] Migration may be in progress in another tab, waiting...');
                // Wait a bit and check again
                await new Promise(resolve => setTimeout(resolve, 1000));
                const newState = this._getMigrationState();
                if (newState.status === MIGRATION_STATUS.COMPLETED) {
                    return;
                }
            }
            // Otherwise, previous migration likely crashed - proceed with re-migration
            console.warn('[UnifiedStore] Previous migration appears to have failed, retrying...');
        }

        console.log('[UnifiedStore] Checking for legacy databases to migrate...');

        // Count items to migrate
        let docData = [];
        let folderData = [];

        try {
            docData = await this._readLegacyStore(legacyDocDbName, 'metadata');
        } catch (err) {
            if (err.message !== 'not_found') {
                console.warn('[UnifiedStore] Could not read legacy doc store:', err);
            }
        }

        try {
            folderData = await this._readLegacyStore(legacyFolderDbName, 'folders');
        } catch (err) {
            if (err.message !== 'not_found') {
                console.warn('[UnifiedStore] Could not read legacy folder store:', err);
            }
        }

        // No legacy data to migrate
        if (docData.length === 0 && folderData.length === 0) {
            this._setMigrationState(MIGRATION_STATUS.COMPLETED, 0, 0);
            return;
        }

        // Mark migration as in progress
        this._setMigrationState(MIGRATION_STATUS.IN_PROGRESS, docData.length, folderData.length);

        let migrated = false;

        // Migrate document store
        if (docData.length > 0) {
            try {
                console.log(`[UnifiedStore] Migrating ${docData.length} documents from legacy store...`);
                await this._putAllInStore(this.filesStoreName, docData);
                migrated = true;
            } catch (err) {
                console.error('[UnifiedStore] Failed to migrate documents:', err);
                this._setMigrationState(MIGRATION_STATUS.FAILED, 0, 0);
                throw err;
            }
        }

        // Migrate folder store
        if (folderData.length > 0) {
            try {
                console.log(`[UnifiedStore] Migrating ${folderData.length} folders from legacy store...`);
                await this._putAllInStore(this.foldersStoreName, folderData);
                migrated = true;
            } catch (err) {
                console.error('[UnifiedStore] Failed to migrate folders:', err);
                this._setMigrationState(MIGRATION_STATUS.FAILED, docData.length, 0);
                throw err;
            }
        }

        // Verify migration succeeded
        const verified = await this._verifyMigration(docData.length, folderData.length);
        if (!verified) {
            console.error('[UnifiedStore] Migration verification failed!');
            this._setMigrationState(MIGRATION_STATUS.FAILED, 0, 0);
            throw new Error('Migration verification failed');
        }

        if (migrated) {
            console.log('[UnifiedStore] Migration complete and verified');

            // Delete legacy databases after successful migration
            await this._deleteLegacyDatabase(legacyDocDbName);
            await this._deleteLegacyDatabase(legacyFolderDbName);
        }

        // Mark as completed
        this._setMigrationState(MIGRATION_STATUS.COMPLETED, docData.length, folderData.length);
    }

    /**
     * Reads all data from a legacy store.
     * @private
     * @param {string} dbName - Legacy database name.
     * @param {string} storeName - Store name within the legacy database.
     * @returns {Promise<any[]>}
     */
    _readLegacyStore(dbName, storeName) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbName);

            request.onerror = () => {
                if (request.error?.name === 'NotFoundError') {
                    reject(new Error('not_found'));
                } else {
                    reject(request.error);
                }
            };

            request.onsuccess = () => {
                const db = request.result;

                if (!db.objectStoreNames.contains(storeName)) {
                    db.close();
                    reject(new Error('not_found'));
                    return;
                }

                try {
                    const transaction = db.transaction(storeName, 'readonly');
                    const store = transaction.objectStore(storeName);
                    const getAllRequest = store.getAll();

                    getAllRequest.onerror = () => {
                        db.close();
                        reject(getAllRequest.error);
                    };

                    getAllRequest.onsuccess = () => {
                        db.close();
                        resolve(getAllRequest.result || []);
                    };
                } catch (err) {
                    db.close();
                    reject(err);
                }
            };
        });
    }

    /**
     * Deletes a legacy database.
     * @private
     * @param {string} dbName
     */
    async _deleteLegacyDatabase(dbName) {
        return new Promise((resolve) => {
            const request = indexedDB.deleteDatabase(dbName);
            request.onsuccess = () => {
                console.log(`[UnifiedStore] Deleted legacy database: ${dbName}`);
                resolve();
            };
            request.onerror = () => {
                console.warn(`[UnifiedStore] Could not delete legacy database: ${dbName}`);
                resolve();
            };
        });
    }

    /**
     * Puts all items into a specific store.
     * @private
     * @param {string} storeName
     * @param {any[]} items
     */
    async _putAllInStore(storeName, items) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);

            for (const item of items) {
                store.put(item);
            }

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    // ===========================================
    // FILE OPERATIONS
    // ===========================================

    /**
     * Retrieves all cached file descriptors from the local store.
     *
     * @returns {Promise<import('../types').FileDescriptor[]>}
     */
    async getAllFiles() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.filesStoreName, 'readonly');
            const store = transaction.objectStore(this.filesStoreName);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * @param {string} fileId
     * @returns {Promise<import('../types').FileDescriptor|null>}
     */
    async getFile(fileId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.filesStoreName, 'readonly');
            const store = transaction.objectStore(this.filesStoreName);
            const request = store.get(fileId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result || null);
        });
    }

    /**
     * Persists or updates a file descriptor in the local store.
     *
     * @param {import('../types').FileDescriptor} file
     * @returns {Promise<void>}
     */
    async putFile(file) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.filesStoreName, 'readwrite');
            const store = transaction.objectStore(this.filesStoreName);
            const request = store.put(file);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * @param {string} fileId
     * @returns {Promise<void>}
     */
    async removeFile(fileId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.filesStoreName, 'readwrite');
            const store = transaction.objectStore(this.filesStoreName);
            const request = store.delete(fileId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    // ===========================================
    // FOLDER OPERATIONS
    // ===========================================

    /**
     * Retrieves all cached folder descriptors from the local store.
     *
     * @returns {Promise<import('../types').Folder[]>}
     */
    async getAllFolders() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.foldersStoreName, 'readonly');
            const store = transaction.objectStore(this.foldersStoreName);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * @param {string} folderId
     * @returns {Promise<import('../types').Folder|null>}
     */
    async getFolder(folderId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.foldersStoreName, 'readonly');
            const store = transaction.objectStore(this.foldersStoreName);
            const request = store.get(folderId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result || null);
        });
    }

    /**
     * Persists or updates a folder descriptor in the local store.
     *
     * @param {import('../types').Folder} folder
     * @returns {Promise<void>}
     */
    async putFolder(folder) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.foldersStoreName, 'readwrite');
            const store = transaction.objectStore(this.foldersStoreName);
            const request = store.put(folder);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * @param {string} folderId
     * @returns {Promise<void>}
     */
    async removeFolder(folderId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.foldersStoreName, 'readwrite');
            const store = transaction.objectStore(this.foldersStoreName);
            const request = store.delete(folderId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    // ===========================================
    // ATOMIC OPERATIONS
    // ===========================================

    /**
     * Atomically replaces all files and folders in a single transaction.
     * This ensures the UI never sees an inconsistent state.
     *
     * @param {import('../types').FileDescriptor[]} files
     * @param {import('../types').Folder[]} folders
     * @returns {Promise<void>}
     */
    async replaceAll(files, folders) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            // Use a single transaction for both stores
            const transaction = db.transaction(
                [this.filesStoreName, this.foldersStoreName],
                'readwrite'
            );

            const filesStore = transaction.objectStore(this.filesStoreName);
            const foldersStore = transaction.objectStore(this.foldersStoreName);

            // Clear both stores
            filesStore.clear();
            foldersStore.clear();

            // Put all files
            for (const file of files) {
                filesStore.put(file);
            }

            // Put all folders
            for (const folder of folders) {
                foldersStore.put(folder);
            }

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    /**
     * Clears both files and folders stores.
     *
     * @returns {Promise<void>}
     */
    async clearAll() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [this.filesStoreName, this.foldersStoreName],
                'readwrite'
            );

            transaction.objectStore(this.filesStoreName).clear();
            transaction.objectStore(this.foldersStoreName).clear();

            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
    }

    /**
     * Closes the database connection.
     *
     * @returns {void}
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
