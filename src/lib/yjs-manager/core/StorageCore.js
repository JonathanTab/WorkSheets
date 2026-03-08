/**
 * StorageCore - Central orchestrator for the file storage system.
 *
 * This class coordinates:
 * - UnifiedStore: Single IndexedDB for files and folders
 * - FileIndex/FolderIndex: In-memory searchable indices
 * - YjsRuntime: Y.Doc lifecycle management
 * - SchemaManager: Schema versioning and migrations
 * - FileAPI: REST API communication
 *
 * It provides atomic sync operations and event-based coordination for
 * the Storage facade and its AppCollection/DriveFileSystem managers.
 */

import { FileAPI } from '../api/FileAPI.js';
import { UnifiedStore } from './UnifiedStore.js';
import { FileIndex } from './FileIndex.js';
import { FolderIndex } from './FolderIndex.js';
import { YjsRuntime } from './YjsRuntime.js';
import { SchemaManager } from './SchemaManager.js';

/**
 * Simple EventEmitter for internal coordination
 */
class EventEmitter {
    constructor() {
        this._events = new Map();
    }
    on(event, cb) {
        if (!this._events.has(event)) this._events.set(event, []);
        this._events.get(event).push(cb);
    }
    off(event, cb) {
        if (!this._events.has(event)) return;
        const callbacks = this._events.get(event);
        const index = callbacks.indexOf(cb);
        if (index !== -1) {
            callbacks.splice(index, 1);
        }
    }
    emit(event, data) {
        if (!this._events.has(event)) return;
        this._events.get(event).forEach(cb => cb(data));
    }
}

/**
 * SyncState - Tracks the current state of background sync
 */
class SyncState {
    constructor() {
        this.isSyncing = false;
        this.lastSyncTime = null;
        this.lastSyncError = null;
        this.syncAttemptCount = 0;
    }
}

/**
 * StorageCore - The main orchestrator for the storage system.
 *
 * ## Architecture Overview
 * StorageCore acts as the central facade for the storage ecosystem in the application.
 * It coordinates several specialized components:
 *
 * - **FileAPI**: Handles communication with the remote server.
 * - **UnifiedStore**: Provides offline-first persistence using IndexedDB.
 * - **FileIndex/FolderIndex**: Manages in-memory, searchable indices with classification.
 * - **YjsRuntime**: Manages the lifecycle of active Y.Doc instances.
 * - **SchemaManager**: Handles file schema initialization and migrations.
 *
 * ## Lifecycle
 * 1. **Initialization**: `initialize()` loads cached data from IndexedDB and triggers background sync.
 * 2. **Discovery**: Data available via `fileIndex` and `folderIndex`.
 * 3. **Loading**: `loadYjsFile(id)` retrieves/creates the correct Yjs room.
 * 4. **Interaction**: Active files accessed via `getYDoc(id)`.
 * 5. **Teardown**: `shutdown()` cleans up connections and database handles.
 *
 * ## Events
 * - `files-ready`: Emitted when the file index is first loaded or updated.
 * - `folders-ready`: Emitted when the folder index is first loaded or updated.
 * - `sync-complete`: Emitted after successful full sync.
 * - `file-ready`: Emitted when a specific Y.Doc is loaded and ready.
 * - `file-migrated`: Emitted after a successful schema migration.
 * - `file-created`, `file-updated`, `file-deleted`: Emitted after file mutations.
 * - `folder-created`, `folder-updated`, `folder-deleted`: Emitted after folder mutations.
 * - `auth-error`: Emitted when API requests fail due to expired credentials.
 */
export class StorageCore extends EventEmitter {
    /**
     * @param {import('../types').StorageCoreOptions} options
     */
    constructor(options) {
        super();
        this.options = options;

        this.api = new FileAPI(options.baseUrl, options.getApiKey, {
            appName: options.appName,
            schemaVersion: options.schemaVersion
        });

        /** @type {FileIndex|null} */
        this.fileIndex = null;
        /** @type {FolderIndex|null} */
        this.folderIndex = null;
        this.runtime = new YjsRuntime(options.wsUrl);
        this.schema = new SchemaManager(options.schemas);
        /** @type {UnifiedStore|null} */
        this.store = null;

        this.isInitialized = false;
        this.userName = 'anonymous';

        this.blobStorageUrl = options.blobStorageUrl || null;

        // Initialization lock
        this._initPromise = null;

        // Background sync configuration
        this.syncInterval = options.syncInterval || 300000; // 5 minutes
        this._syncIntervalId = null;
        this._syncState = new SyncState();
        this._syncPromise = null;

        // Debug mode - read from localStorage
        this._debugKey = `storage_debug_${options.appName}`;
        this.debug = this._readDebugState();
    }

    /**
     * Reads debug state from localStorage.
     * @private
     * @returns {boolean}
     */
    _readDebugState() {
        if (typeof localStorage === 'undefined') return false;
        const stored = localStorage.getItem(this._debugKey);
        return stored === 'true';
    }

    /**
     * Sets debug mode and persists to localStorage.
     * @param {boolean} enabled
     */
    setDebug(enabled) {
        this.debug = enabled;
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(this._debugKey, String(enabled));
        }
        console.log(`[StorageCore] Debug mode ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Dumps the full storage contents to console and returns the data.
     * @returns {{ files: import('../types').ClassifiedFile[], folders: import('../types').ClassifiedFolder[], syncState: Object }}
     */
    dumpStorage() {
        const data = {
            files: this.fileIndex ? this.fileIndex.getAll() : [],
            folders: this.folderIndex ? this.folderIndex.getAll() : [],
            syncState: this.getSyncState(),
            timestamp: new Date().toISOString()
        };

        console.log('[StorageCore] Storage dump:', data);
        console.table(data.files.map(f => ({
            id: f.id,
            title: f.title,
            type: f.type,
            scope: f.scope,
            owner: f.owner,
            owned: f.owned,
            shared: f.shared
        })));
        console.table(data.folders.map(f => ({
            id: f.id,
            name: f.name,
            owner: f.owner,
            owned: f.owned
        })));

        return data;
    }

    /**
     * Initializes the StorageCore.
     *
     * Loads file and folder metadata from the local store and populates the indices.
     * If online, triggers a background sync.
     *
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this._initPromise) return this._initPromise;
        if (this.isInitialized) return;

        this._initPromise = this._doInitialize();
        try {
            await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    async _doInitialize() {
        console.log('[StorageCore] Starting initialization...');
        const startTime = performance.now();

        const apiKey = this.options.getApiKey();
        this.userName = this.options.getUsername?.() || 'anonymous';

        if (!apiKey) {
            console.warn('[StorageCore] No API key provided');
        }

        console.log(`[StorageCore] Opening unified store for ${this.userName}...`);

        // Open unified store
        this.store = new UnifiedStore(this.options.appName, this.userName);
        await this.store.open();

        // Initialize indices
        this.fileIndex = new FileIndex(this.options.appName, this.userName);
        this.folderIndex = new FolderIndex(this.userName);

        // Setup network listeners
        this._setupNetworkListeners();

        // Load cached data
        console.log('[StorageCore] Loading cached data...');

        const cachedFiles = await this.store.getAllFiles();
        console.log(`[StorageCore] Loaded ${cachedFiles.length} cached files`);
        this.fileIndex.update(cachedFiles);

        const cachedFolders = await this.store.getAllFolders();
        console.log(`[StorageCore] Loaded ${cachedFolders.length} cached folders`);
        this.folderIndex.update(cachedFolders);

        // Emit ready events
        this.emit('files-ready', this.fileIndex.getAll());
        this.emit('folders-ready', this.folderIndex.getAll());

        this.isInitialized = true;
        console.log(`[StorageCore] Initialization complete in ${Math.round(performance.now() - startTime)}ms`);

        // Background sync if online
        if (navigator.onLine) {
            console.log('[StorageCore] Starting background sync...');
            this.fullSync().catch(err => console.error('[StorageCore] Background sync failed:', err));
        }
    }

    /**
     * Performs a full sync with the server.
     *
     * @returns {Promise<void>}
     */
    async fullSync() {
        if (this._syncPromise) return this._syncPromise;
        if (!navigator.onLine) return;

        this._syncPromise = this._doFullSync();
        try {
            await this._syncPromise;
        } finally {
            this._syncPromise = null;
        }
    }

    async _doFullSync() {
        console.log('[StorageCore] Starting full sync...');
        const startTime = performance.now();

        this._syncState.isSyncing = true;
        this._syncState.syncAttemptCount++;

        try {
            const { documents, folders } = await this.api.fullSync();

            console.log(`[StorageCore] Fetched ${documents.length} files and ${folders.length} folders`);

            // Atomic update - single transaction for both stores
            await this.store.replaceAll(documents, folders);

            // Update indices
            this.fileIndex.update(documents);
            this.folderIndex.update(folders);

            this._syncState.lastSyncTime = new Date();
            this._syncState.lastSyncError = null;

            this.emit('files-ready', this.fileIndex.getAll());
            this.emit('folders-ready', this.folderIndex.getAll());
            this.emit('sync-complete', { files: documents, folders });

            // Debug dump if enabled
            if (this.debug) {
                console.log('[StorageCore] Debug dump after sync:', {
                    files: documents,
                    folders: folders,
                    fileIndex: this.fileIndex.getAll(),
                    folderIndex: this.folderIndex.getAll(),
                    syncState: this.getSyncState()
                });
            }

            console.log(`[StorageCore] Full sync complete in ${Math.round(performance.now() - startTime)}ms`);
        } catch (error) {
            console.error('[StorageCore] Full sync failed:', error);
            this._syncState.lastSyncError = error;

            if (error.message === 'AUTH_EXPIRED') {
                this.emit('auth-error', error);
            }
            throw error;
        } finally {
            this._syncState.isSyncing = false;
        }
    }

    // ===========================================
    // FILE LOADING
    // ===========================================

    /**
     * Loads a Yjs file by its ID.
     *
     * @param {string} fileId - The file ID.
     * @returns {Promise<import('yjs').Doc>}
     */
    async loadYjsFile(fileId) {
        const fileInfo = this.fileIndex.getById(fileId);
        if (!fileInfo) throw new Error(`File not found: ${fileId}`);

        if (fileInfo.type === 'blob') {
            throw new Error(`Cannot load blob file as Yjs: ${fileId}. Use getBlobUrl() instead.`);
        }

        const targetVersion = this.options.schemaVersion;
        let roomId = fileInfo.versions?.[targetVersion];

        if (!roomId) {
            if (!navigator.onLine) throw new Error('Offline: Cannot create new file version');

            const prevVersion = this.schema.findMigrationSource(targetVersion, fileInfo.versions || {});

            if (prevVersion) {
                console.log(`[StorageCore] Migrating ${fileId} from ${prevVersion} to ${targetVersion}`);
                const oldRoomId = fileInfo.versions[prevVersion];
                const oldDoc = await this.runtime.load(`${fileId}_migration_src`, oldRoomId);

                const { room: newRoomId } = await this.api.createVersion(fileId, targetVersion);
                const newDoc = await this.runtime.load(fileId, newRoomId);

                await this.schema.migrate(targetVersion, oldDoc, newDoc);

                this.runtime.unload(`${fileId}_migration_src`);
                roomId = newRoomId;
                this.emit('file-migrated', { fileId, from: prevVersion, to: targetVersion });
            } else {
                const { room: newRoomId } = await this.api.createVersion(fileId, targetVersion);
                roomId = newRoomId;
            }

            // Update local metadata
            const rawFile = await this.store.getFile(fileId);
            if (rawFile) {
                rawFile.versions = rawFile.versions || {};
                rawFile.versions[targetVersion] = roomId;
                await this.store.putFile(rawFile);
            }
        }

        const ydoc = await this.runtime.load(fileId, roomId);
        this.schema.initialize(targetVersion, ydoc);
        this.emit('file-ready', { fileId, ydoc });

        return ydoc;
    }

    /**
     * Gets a loaded Y.Doc synchronously.
     *
     * @param {string} fileId
     * @returns {import('yjs').Doc|null}
     */
    getYDoc(fileId) {
        return this.runtime.get(fileId);
    }

    // ===========================================
    // QUERY API - FILES
    // ===========================================

    /** @returns {import('../types').ClassifiedFile[]} All files. */
    getAllFiles() { return this.fileIndex.getAll(); }

    /** @returns {import('../types').ClassifiedFile[]} Owned files. */
    getOwnedFiles() { return this.fileIndex.getOwned(); }

    /** @returns {import('../types').ClassifiedFile[]} Shared files. */
    getSharedFiles() { return this.fileIndex.getShared(); }

    /** @returns {import('../types').ClassifiedFile[]} Writable files. */
    getWritableFiles() { return this.fileIndex.getWritable(); }

    /** @param {string} fileId @returns {import('../types').ClassifiedFile|null} */
    getFile(fileId) { return this.fileIndex.getById(fileId); }

    /** @returns {import('../types').ClassifiedFile[]} Files in a folder. */
    getFilesByFolder(folderId) {
        return this.fileIndex.getByFolder(folderId);
    }

    // ===========================================
    // QUERY API - FOLDERS
    // ===========================================

    /** @returns {import('../types').ClassifiedFolder[]} All folders. */
    getAllFolders() { return this.folderIndex.getAll(); }

    /** @returns {import('../types').ClassifiedFolder[]} Owned folders. */
    getOwnedFolders() { return this.folderIndex.getOwned(); }

    /** @returns {import('../types').ClassifiedFolder[]} Shared folders. */
    getSharedFolders() { return this.folderIndex.getShared(); }

    /** @returns {import('../types').ClassifiedFolder[]} Writable folders. */
    getWritableFolders() { return this.folderIndex.getWritable(); }

    /** @param {string} folderId @returns {import('../types').ClassifiedFolder|null} */
    getFolder(folderId) { return this.folderIndex.getById(folderId); }

    /** @returns {import('../types').ClassifiedFolder[]} Children of a folder. */
    getFolderChildren(parentId = null) {
        return this.folderIndex.getChildren(parentId);
    }

    /** @returns {{ folders: import('../types').ClassifiedFolder[], files: import('../types').ClassifiedFile[] }} */
    getFolderContents(folderId) {
        const folders = this.folderIndex.getChildren(folderId);
        const files = this.fileIndex.getByFolder(folderId);
        return { folders, files };
    }

    /** @returns {{ folders: import('../types').ClassifiedFolder[], files: import('../types').ClassifiedFile[] }} */
    getSharedWithMe() {
        return {
            folders: this.folderIndex.getShared(),
            files: this.fileIndex.getShared()
        };
    }

    // ===========================================
    // WRITE API - FILES
    // ===========================================

    /**
     * Creates a new file.
     *
     * File IDs are always server-generated. Clients must NOT provide IDs.
     * Use the `title` property for human-readable file names.
     *
     * @param {Object} options - Creation options.
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async createFile(options = {}) {
        const {
            title = 'Untitled',
            folderId = null,
            type = 'yjs',
            scope = 'drive',
            parentId = null,
            publicRead = false,
            publicWrite = false
        } = options;

        // Always generate ID server-side
        const id = await this.api.generateId();
        // For app scope, prefix with app name
        const fileId = scope === 'app' ? `${this.options.appName}_${id}` : id;

        const file = await this.api.createFile({
            id: fileId,
            app: scope === 'app' ? this.options.appName : undefined,
            title,
            type,
            scope,
            folderId,
            parentId,
            version: type === 'yjs' ? this.options.schemaVersion : undefined,
            publicRead,
            publicWrite
        });

        await this.store.putFile(file);
        this.fileIndex.add(file);
        this.emit('file-created', file);

        this.fullSync().catch(err => console.error('[StorageCore] Background sync failed:', err));

        return file;
    }

    /**
     * Renames a file.
     *
     * @param {string} fileId
     * @param {string} title
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async renameFile(fileId, title) {
        const file = await this.api.rename(fileId, title);
        await this.store.putFile(file);
        this.fileIndex.add(file);
        this.emit('file-updated', file);
        return file;
    }

    /**
     * Deletes a file.
     *
     * @param {string} fileId
     */
    async deleteFile(fileId) {
        await this.api.delete(fileId);
        await this.store.removeFile(fileId);
        this.runtime.unload(fileId);
        this.fileIndex.remove(fileId);
        this.emit('file-deleted', fileId);
    }

    /**
     * Moves a file to a different folder.
     *
     * @param {string} fileId
     * @param {string|null} targetFolderId
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async moveFile(fileId, targetFolderId) {
        const file = await this.api.moveFile(fileId, targetFolderId);
        await this.store.putFile(file);
        this.fileIndex.add(file);
        this.emit('file-updated', file);
        return file;
    }

    /**
     * Sets the parent of a file (for attachments).
     *
     * @param {string} fileId
     * @param {string|null} parentId
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async setFileParent(fileId, parentId) {
        const file = await this.api.setFileParent(fileId, parentId);
        await this.store.putFile(file);
        this.fileIndex.add(file);
        this.emit('file-updated', file);
        return file;
    }

    /**
     * Shares a file with another user.
     *
     * @param {string} fileId
     * @param {string} username
     * @param {string[]} permissions
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async shareFile(fileId, username, permissions) {
        const file = await this.api.share(fileId, username, permissions);
        await this.store.putFile(file);
        this.fileIndex.add(file);
        this.emit('file-updated', file);
        return file;
    }

    /**
     * Revokes access to a file.
     *
     * @param {string} fileId
     * @param {string} username
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async revokeFile(fileId, username) {
        const file = await this.api.revoke(fileId, username);
        await this.store.putFile(file);
        this.fileIndex.add(file);
        this.emit('file-updated', file);
        return file;
    }

    // ===========================================
    // WRITE API - FOLDERS
    // ===========================================

    /**
     * Creates a new folder.
     *
     * @param {string} name
     * @param {string|null} parentId
     * @returns {Promise<import('../types').Folder>}
     */
    async createFolder(name, parentId = null) {
        const folder = await this.api.createFolder(name, parentId);
        await this.store.putFolder(folder);
        this.folderIndex.add(folder);
        this.emit('folder-created', folder);
        return folder;
    }

    /**
     * Renames a folder.
     *
     * @param {string} folderId
     * @param {string} newName
     * @returns {Promise<import('../types').Folder>}
     */
    async renameFolder(folderId, newName) {
        const folder = await this.api.renameFolder(folderId, newName);
        await this.store.putFolder(folder);
        this.folderIndex.add(folder);
        this.emit('folder-updated', folder);
        return folder;
    }

    /**
     * Deletes a folder.
     *
     * @param {string} folderId
     */
    async deleteFolder(folderId) {
        await this.api.deleteFolder(folderId);
        await this.store.removeFolder(folderId);
        this.folderIndex.remove(folderId);
        this.emit('folder-deleted', folderId);

        this.fullSync().catch(err => console.error('[StorageCore] Background sync failed:', err));
    }

    /**
     * Moves a folder.
     *
     * @param {string} folderId
     * @param {string|null} newParentId
     * @returns {Promise<import('../types').Folder>}
     */
    async moveFolder(folderId, newParentId) {
        const folder = await this.api.moveFolder(folderId, newParentId);
        await this.store.putFolder(folder);
        this.folderIndex.add(folder);
        this.emit('folder-updated', folder);
        return folder;
    }

    /**
     * Shares a folder.
     *
     * @param {string} folderId
     * @param {string} username
     * @param {string[]} permissions
     * @returns {Promise<import('../types').Folder>}
     */
    async shareFolder(folderId, username, permissions) {
        const folder = await this.api.shareFolder(folderId, username, permissions);
        await this.store.putFolder(folder);
        this.folderIndex.add(folder);
        this.emit('folder-updated', folder);

        this.fullSync().catch(err => console.error('[StorageCore] Background sync failed:', err));

        return folder;
    }

    /**
     * Revokes folder access.
     *
     * @param {string} folderId
     * @param {string} username
     * @returns {Promise<import('../types').Folder>}
     */
    async revokeFolderShare(folderId, username) {
        const folder = await this.api.revokeFolderShare(folderId, username);
        await this.store.putFolder(folder);
        this.folderIndex.add(folder);
        this.emit('folder-updated', folder);

        this.fullSync().catch(err => console.error('[StorageCore] Background sync failed:', err));

        return folder;
    }

    // ===========================================
    // BLOB SUPPORT
    // ===========================================

    /**
     * Creates a blob file.
     *
     * The upload is atomic from the client perspective:
     * 1. Create metadata on server (gets blob key)
     * 2. Upload blob content
     * 3. Only add to local store after successful upload
     *
     * If upload fails, we attempt to clean up server metadata.
     * If cleanup also fails, the next fullSync will reconcile state.
     *
     * @param {string} title
     * @param {File} file
     * @param {Object} options
     * @returns {Promise<import('../types').FileDescriptor>}
     */
    async createBlobFile(title, file, options = {}) {
        const {
            folderId = null,
            publicRead = false,
            publicWrite = false,
            parentId = null,
            scope = 'drive',
            app  // Allow app to be passed in (for AppCollection)
        } = options;

        if (!this.blobStorageUrl) {
            throw new Error('blobStorageUrl is required for blob files');
        }

        const id = await this.api.generateId();
        // Use provided app name for app scope, or fall back to options.appName
        const effectiveApp = scope === 'app' ? (app || this.options.appName) : undefined;
        const fileId = scope === 'app' && effectiveApp ? `${effectiveApp}_${id}` : id;

        // Step 1: Create metadata on server
        let descriptor;
        try {
            descriptor = await this.api.createFile({
                id: fileId,
                app: effectiveApp,
                title,
                type: 'blob',
                scope,
                folderId,
                parentId,
                filename: file.name,
                mimeType: file.type,
                size: file.size,
                publicRead,
                publicWrite
            });
        } catch (createError) {
            console.error('[StorageCore] Failed to create blob metadata:', createError);
            throw createError;
        }

        // Step 2: Upload blob content
        let uploadSucceeded = false;
        try {
            await this.uploadBlob(descriptor.id, file);
            uploadSucceeded = true;
        } catch (uploadError) {
            console.error('[StorageCore] Blob upload failed:', uploadError);

            // Attempt to delete the orphaned metadata on server
            // This is best-effort - if it fails, the server has orphaned metadata
            // that will be cleaned up on next fullSync (it won't appear in listings
            // since the blob doesn't exist)
            try {
                await this.api.delete(descriptor.id);
                console.log('[StorageCore] Cleaned up orphaned blob metadata after upload failure');
            } catch (deleteError) {
                console.warn('[StorageCore] Could not clean up orphaned blob metadata:', deleteError.message);
                // The server may have orphaned metadata, but client state is consistent
                // Next fullSync will not include this file (it's soft-deleted or doesn't match queries)
            }

            throw uploadError;
        }

        // Step 3: Only add to local store after successful upload
        if (uploadSucceeded) {
            await this.store.putFile(descriptor);
            this.fileIndex.add(descriptor);
            this.emit('file-created', descriptor);
        }

        return descriptor;
    }

    /**
     * Uploads a blob.
     *
     * @param {string} fileId
     * @param {File} file
     */
    async uploadBlob(fileId, file) {
        if (!this.blobStorageUrl) {
            throw new Error('blobStorageUrl is required for blob operations');
        }

        const apiKey = this.options.getApiKey();
        const url = apiKey
            ? `${this.blobStorageUrl}?id=${fileId}&apikey=${apiKey}`
            : `${this.blobStorageUrl}?id=${fileId}`;

        const response = await fetch(url, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type }
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }

        await this.fullSync();
    }

    /**
     * Gets the blob URL.
     *
     * @param {string} fileId
     * @returns {string|null}
     */
    getBlobUrl(fileId) {
        if (!this.blobStorageUrl) return null;

        const apiKey = this.options.getApiKey();
        return apiKey
            ? `${this.blobStorageUrl}?id=${fileId}&apikey=${apiKey}`
            : `${this.blobStorageUrl}?id=${fileId}`;
    }

    // ===========================================
    // BACKGROUND SYNC & NETWORK
    // ===========================================

    _setupNetworkListeners() {
        if (typeof window === 'undefined') return;

        this._onlineHandler = () => {
            console.log('[StorageCore] Online - triggering sync');
            this._syncState.syncAttemptCount = 0;
            this.fullSync().catch(err => console.error('[StorageCore] Sync failed:', err));
        };

        this._offlineHandler = () => {
            console.log('[StorageCore] Offline - sync disabled');
        };

        this._visibilityHandler = () => {
            if (document.visibilityState === 'visible' && navigator.onLine && !this._syncState.isSyncing) {
                console.log('[StorageCore] Tab visible - checking for updates');
                this.fullSync().catch(err => console.error('[StorageCore] Sync failed:', err));
            }
        };

        window.addEventListener('online', this._onlineHandler);
        window.addEventListener('offline', this._offlineHandler);
        document.addEventListener('visibilitychange', this._visibilityHandler);

        this._startSyncInterval();
    }

    _startSyncInterval() {
        if (this._syncIntervalId) clearInterval(this._syncIntervalId);

        this._syncIntervalId = setInterval(() => {
            if (navigator.onLine && !this._syncState.isSyncing) {
                console.log('[StorageCore] Background sync interval');
                this.fullSync().catch(err => {
                    console.error('[StorageCore] Sync failed:', err);
                    this._syncState.lastSyncError = err;
                });
            }
        }, this.syncInterval);
    }

    _stopSyncInterval() {
        if (this._syncIntervalId) {
            clearInterval(this._syncIntervalId);
            this._syncIntervalId = null;
        }
    }

    /**
     * Gets the sync state.
     */
    getSyncState() {
        return {
            isSyncing: this._syncState.isSyncing,
            lastSyncTime: this._syncState.lastSyncTime,
            lastSyncError: this._syncState.lastSyncError,
            syncAttemptCount: this._syncState.syncAttemptCount
        };
    }

    // ===========================================
    // TEARDOWN
    // ===========================================

    /**
     * Gracefully shuts down.
     */
    async shutdown() {
        this._stopSyncInterval();

        if (typeof window !== 'undefined') {
            if (this._onlineHandler) window.removeEventListener('online', this._onlineHandler);
            if (this._offlineHandler) window.removeEventListener('offline', this._offlineHandler);
            if (this._visibilityHandler) document.removeEventListener('visibilitychange', this._visibilityHandler);
        }

        this.runtime.shutdown();
        if (this.store) this.store.close();

        // Reset initialization state for potential re-init
        this.isInitialized = false;
        this._initPromise = null;
        this.fileIndex = null;
        this.folderIndex = null;
        this.store = null;
    }
}

// Legacy alias for backward compatibility
export { StorageCore as DocManager };
