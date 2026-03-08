import { DocManagerAPI } from '../api/DocManagerAPI';
import { MetadataStore } from './MetadataStore';
import { FolderStore } from './FolderStore';
import { DocIndex } from './DocIndex';
import { FolderIndex } from './FolderIndex';
import { YjsRuntime } from './YjsRuntime';
import { SchemaManager } from './SchemaManager';

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
 * DocManager - The main orchestrator for the Yjs Document Manager.
 *
 * ## Architecture Overview
 * The DocManager acts as the central facade for the Yjs ecosystem in the application.
 * It coordinates several specialized components:
 *
 * - **DocManagerAPI**: Handles communication with the remote document server.
 * - **MetadataStore**: Provides offline-first persistence for document metadata using IndexedDB.
 * - **FolderStore**: Provides offline-first persistence for folder metadata using IndexedDB.
 * - **DocIndex**: Manages an in-memory, searchable index of documents, classified by ownership and permissions.
 * - **FolderIndex**: Manages an in-memory, searchable tree of folders, classified by ownership and permissions.
 * - **YjsRuntime**: Manages the lifecycle of active Y.Doc instances, their WebSocket providers, and IndexedDB persistence.
 * - **SchemaManager**: Handles document schema initialization and version-to-version migrations.
 *
 * ## Lifecycle
 * 1. **Initialization**: `initialize()` loads cached metadata from IndexedDB and triggers a background sync with the server.
 * 2. **Discovery**: Document metadata is available via `getAllDocs()`, `getOwnedDocs()`, etc. Folder hierarchy via `getAllFolders()`, `getFolderTree()`.
 * 3. **Loading**: `loadDoc(id)` retrieves/creates the correct Yjs room, handles migrations if necessary, and connects the document.
 * 4. **Interaction**: Active documents are accessed via `getYDoc(id)`.
 * 5. **Teardown**: `shutdown()` cleans up all active network connections and database handles.
 *
 * ## Events
 * - `docs-ready`: Emitted when the document index is first loaded or updated from the server.
 * - `folders-ready`: Emitted when the folder index is first loaded or updated from the server.
 * - `sync-complete`: Emitted after successful full sync with the server.
 * - `doc-ready`: Emitted when a specific Y.Doc is loaded and ready for use.
 * - `doc-migrated`: Emitted after a successful schema migration.
 * - `doc-created`, `doc-updated`, `doc-deleted`: Emitted after document mutations.
 * - `folder-created`, `folder-updated`, `folder-deleted`: Emitted after folder mutations.
 * - `auth-error`: Emitted when API requests fail due to expired credentials.
 */
export class DocManager extends EventEmitter {
    /**
     * @param {import('../types').YjsDocManagerOptions & {blobStorageUrl?: string}} options
     */
    constructor(options) {
        super();
        this.options = options;

        this.api = new DocManagerAPI(options.baseUrl, options.getApiKey, {
            appName: options.appName,
            schemaVersion: options.schemaVersion
        });
        this.index = null; // Initialized in initialize()
        this.folderIndex = null; // Initialized in initialize()
        this.runtime = new YjsRuntime(options.wsUrl);
        this.schema = new SchemaManager(options.schemas);
        this.store = null; // Initialized in initialize()
        this.folderStore = null; // Initialized in initialize()

        this.isInitialized = false;
        this.userName = 'anonymous';

        // Blob storage URL for file uploads/downloads
        this.blobStorageUrl = options.blobStorageUrl || null;

        // Initialization lock to prevent concurrent initialization
        this._initPromise = null;

        // Background sync configuration
        this.syncInterval = options.syncInterval || 300000; // Default: 5 minutes
        this._syncIntervalId = null;
        this._syncState = new SyncState();
        this._syncPromise = null; // Sync lock to prevent concurrent syncs
    }

    /**
     * Initializes the DocManager.
     *
     * Loads document and folder metadata from the local stores and populates the indices.
     * If the browser is online, it immediately initiates a background sync with the server.
     *
     * This method is idempotent - multiple calls will return the same promise.
     *
     * @returns {Promise<void>}
     */
    async initialize() {
        // Return existing promise if initialization is in progress
        if (this._initPromise) {
            return this._initPromise;
        }

        // Already initialized
        if (this.isInitialized) {
            return Promise.resolve();
        }

        this._initPromise = this._doInitialize();
        try {
            await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    /**
     * Internal initialization logic
     */
    async _doInitialize() {
        console.log('[DocManager] Starting initialization...');
        const startTime = performance.now();

        const apiKey = this.options.getApiKey();
        const userName = this.options.getUsername?.() || 'anonymous';

        if (!apiKey) {
            console.warn('[DocManager] No API key provided during initialization');
        }

        this.userName = userName;

        console.log(`[DocManager] Opening metadata stores for ${userName}...`);

        // Open document store
        this.store = new MetadataStore(this.options.appName, userName);
        await this.store.open();

        // Open folder store
        this.folderStore = new FolderStore(this.options.appName, userName);
        await this.folderStore.open();

        // Initialize indices
        this.index = new DocIndex(this.options.appName, userName);
        this.folderIndex = new FolderIndex(userName);

        // Setup online/offline event handlers
        this._setupNetworkListeners();

        // 1. Load local metadata
        console.log('[DocManager] Loading cached metadata...');

        // Load cached documents
        const cachedDocs = await this.store.getAll();
        console.log(`[DocManager] Loaded ${cachedDocs.length} cached documents`);
        this.index.update(cachedDocs);

        // Load cached folders
        const cachedFolders = await this.folderStore.getAll();
        console.log(`[DocManager] Loaded ${cachedFolders.length} cached folders`);
        this.folderIndex.update(cachedFolders);

        // Emit ready events immediately with cached data so UI can render
        this.emit('docs-ready', this.index.getAll());
        this.emit('folders-ready', this.folderIndex.getAll());

        // Mark as initialized so the app can proceed
        this.isInitialized = true;
        console.log(`[DocManager] Initialization complete in ${Math.round(performance.now() - startTime)}ms`);

        // 2. Background full sync if online (non-blocking)
        if (navigator.onLine) {
            console.log('[DocManager] Starting background sync...');
            this.fullSync().catch(err => console.error('[DocManager] Background sync failed:', err));
        }
    }

    /**
     * Performs a full sync of both documents and folders with the server.
     *
     * This method fetches the latest document and folder lists from the API,
     * updates the local stores, and refreshes the indices. Server-side data is
     * considered authoritative.
     *
     * This method is concurrency-safe - if a sync is already in progress,
     * it will return the existing sync promise instead of starting a new one.
     *
     * @returns {Promise<void>}
     */
    async fullSync() {
        // Sync lock: if sync is already in progress, return existing promise
        if (this._syncPromise) {
            console.log('[DocManager] Sync already in progress, returning existing promise');
            return this._syncPromise;
        }

        // Don't sync if offline
        if (!navigator.onLine) {
            console.log('[DocManager] Skipping sync - offline');
            return;
        }

        this._syncPromise = this._doFullSync();

        try {
            await this._syncPromise;
        } finally {
            this._syncPromise = null;
        }
    }

    /**
     * Internal implementation of full sync.
     * @private
     */
    async _doFullSync() {
        console.log('[DocManager] Starting full sync...');
        const startTime = performance.now();

        this._syncState.isSyncing = true;
        this._syncState.syncAttemptCount++;

        try {
            const { documents, folders } = await this.api.fullSync();

            console.log(`[DocManager] Fetched ${documents.length} documents and ${folders.length} folders from server`);

            // Update document store and index atomically
            await this.store.replaceAll(documents);
            this.index.update(documents);

            // Update folder store and index atomically
            await this.folderStore.replaceAll(folders);
            this.folderIndex.update(folders);

            // Update sync state on success
            this._syncState.lastSyncTime = new Date();
            this._syncState.lastSyncError = null;

            // Emit events
            this.emit('docs-ready', this.index.getAll());
            this.emit('folders-ready', this.folderIndex.getAll());
            this.emit('sync-complete', { documents, folders });

            console.log(`[DocManager] Full sync complete in ${Math.round(performance.now() - startTime)}ms`);
        } catch (error) {
            console.error('[DocManager] Full sync failed:', error);
            this._syncState.lastSyncError = error;

            if (error.message === 'AUTH_EXPIRED') {
                this.emit('auth-error', error);
            }
            throw error;
        } finally {
            this._syncState.isSyncing = false;
        }
    }

    /**
     * @deprecated Use `fullSync()` instead. This method is kept for backward compatibility
     * and internally calls `fullSync()`.
     *
     * Synchronizes document metadata with the server.
     */
    async syncMetadata() {
        console.warn('[DocManager] syncMetadata() is deprecated. Use fullSync() instead.');
        return this.fullSync();
    }

    /**
     * Triggers a full sync. Alias for `fullSync()`.
     *
     * @returns {Promise<void>}
     */
    sync() {
        return this.fullSync();
    }

    // ===========================================
    // DOCUMENT LOADING
    // ===========================================

    /**
     * Loads a Yjs document by its logical ID.
     *
     * This is the primary entry point for working with a document's content.
     *
     * Logic Flow:
     * 1. Resolves the Room ID for the requested schema version.
     * 2. If the version doesn't exist:
     *    - Checks if a migration source exists (an older version of the doc).
     *    - If yes: Performs a data migration to a new room.
     *    - If no: Creates a fresh room for the current schema version.
     * 3. Initializes the YjsRuntime (persistence + network).
     * 4. Applies schema initialization (e.g., setting up shared types).
     *
     * @param {string} docId - The stable logical ID of the document.
     * @returns {Promise<import('yjs').Doc>}
     */
    async loadDoc(docId) {
        const docInfo = this.index.getById(docId);
        if (!docInfo) throw new Error(`Document not found: ${docId}`);

        // Check if this is a blob document - cannot be loaded as Yjs
        if (docInfo.type === 'blob') {
            throw new Error(`Cannot load blob document as Yjs: ${docId}. Use getBlobUrl() instead.`);
        }

        const targetVersion = this.options.schemaVersion;
        let roomId = docInfo.versions[targetVersion];

        // If roomId missing, we might need to migrate or create version
        if (!roomId) {
            if (!navigator.onLine) throw new Error('Offline: Cannot create new document version');

            const prevVersion = this.schema.findMigrationSource(targetVersion, docInfo.versions);

            if (prevVersion) {
                // Migration path
                console.log(`Migrating ${docId} from ${prevVersion} to ${targetVersion}`);
                const oldRoomId = docInfo.versions[prevVersion];
                const oldDoc = await this.runtime.load(`${docId}_migration_src`, oldRoomId);

                // Create new version on server
                const { room: newRoomId } = await this.api.createVersion(docId, targetVersion);

                const newDoc = await this.runtime.load(docId, newRoomId);

                await this.schema.migrate(targetVersion, oldDoc, newDoc);

                // Cleanup migration source
                this.runtime.unload(`${docId}_migration_src`);

                roomId = newRoomId;
                this.emit('doc-migrated', { docId, from: prevVersion, to: targetVersion });
            } else {
                // Fresh version / No migration possible
                const { room: newRoomId } = await this.api.createVersion(docId, targetVersion);
                roomId = newRoomId;
            }

            // Update metadata locally - only store clean DocDescriptor fields
            const rawDoc = await this.store.get(docId);
            if (rawDoc) {
                rawDoc.versions[targetVersion] = roomId;
                await this.store.put(rawDoc);
            } else {
                // Fallback: extract clean descriptor from ClassifiedDoc
                const { owned, shared, writable, ...descriptor } = docInfo;
                descriptor.versions[targetVersion] = roomId;
                await this.store.put(descriptor);
            }
        }

        console.log('[DocManager] About to call runtime.load()...');
        const ydoc = await this.runtime.load(docId, roomId);
        console.log('[DocManager] runtime.load() returned');

        // Initialize if first time
        console.log('[DocManager] About to call schema.initialize()...');
        this.schema.initialize(targetVersion, ydoc);
        console.log('[DocManager] schema.initialize() returned');

        this.emit('doc-ready', { docId, ydoc });
        return ydoc;
    }

    /**
     * Synchronously retrieves an already loaded Y.Doc.
     *
     * @param {string} docId - The logical ID of the document.
     * @returns {import('yjs').Doc|null}
     */
    getYDoc(docId) {
        return this.runtime.get(docId);
    }

    // ===========================================
    // QUERY API - DOCUMENTS
    // ===========================================

    /** @returns {import('../types').ClassifiedDoc[]} All documents in the index. */
    getAllDocs() { return this.index.getAll(); }

    /** @returns {import('../types').ClassifiedDoc[]} Documents owned by the current user. */
    getOwnedDocs() { return this.index.getOwned(); }

    /** @returns {import('../types').ClassifiedDoc[]} Documents shared with the current user. */
    getSharedDocs() { return this.index.getShared(); }

    /** @returns {import('../types').ClassifiedDoc[]} Documents where the user has 'write' permission. */
    getWritableDocs() { return this.index.getWritable(); }

    /** @param {string} docId @returns {import('../types').ClassifiedDoc|null} */
    getDoc(docId) { return this.index.getById(docId); }

    /** @returns {import('../types').ClassifiedDoc[]} Documents in a specific folder. */
    getDocsByFolder(folderId) {
        return this.index.getByFolder(folderId);
    }

    // ===========================================
    // QUERY API - FOLDERS
    // ===========================================

    /** @returns {import('../types').ClassifiedFolder[]} All folders in the index. */
    getAllFolders() { return this.folderIndex.getAll(); }

    /** @returns {import('../types').ClassifiedFolder[]} Folders owned by the current user. */
    getOwnedFolders() { return this.folderIndex.getOwned(); }

    /** @returns {import('../types').ClassifiedFolder[]} Folders shared with the current user. */
    getSharedFolders() { return this.folderIndex.getShared(); }

    /** @returns {import('../types').ClassifiedFolder[]} Folders where the user has 'write' permission. */
    getWritableFolders() { return this.folderIndex.getWritable(); }

    /** @param {string} folderId @returns {import('../types').ClassifiedFolder|null} */
    getFolder(folderId) { return this.folderIndex.getById(folderId); }

    /**
     * Gets the children of a folder.
     * @param {string|null} parentId - Parent folder ID, or null for root level.
     * @returns {import('../types').ClassifiedFolder[]}
     */
    getFolderTree(parentId = null) {
        return this.folderIndex.getChildren(parentId);
    }

    /**
     * Gets the contents of a folder (both subfolders and documents).
     * @param {string|null} folderId - Folder ID, or null for root level.
     * @returns {{ folders: import('../types').ClassifiedFolder[], documents: import('../types').ClassifiedDoc[] }}
     */
    getFolderContents(folderId) {
        const subfolders = this.folderIndex.getChildren(folderId);
        const docs = this.index.getByFolder(folderId);
        return { folders: subfolders, documents: docs };
    }

    /**
     * Gets all items shared with the current user.
     * @returns {{ folders: import('../types').ClassifiedFolder[], documents: import('../types').ClassifiedDoc[] }}
     */
    getSharedWithMe() {
        const sharedFolders = this.folderIndex.getShared();
        const sharedDocs = this.index.getShared();
        return { folders: sharedFolders, documents: sharedDocs };
    }

    // ===========================================
    // WRITE API - DOCUMENTS
    // ===========================================

    /**
     * Creates a new document.
     *
     * Generates a new ID, registers it with the server for the current app and schema version,
     * and updates the local index.
     *
     * @param {string} title - The display title of the document.
     * @param {string|null} [folderId=null] - Optional parent folder ID.
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async createDoc(title, folderId = null) {
        const id = await this.api.generateId();
        const docId = `${this.options.appName}_${id}`;

        const doc = await this.api.createDoc({
            id: docId,
            app: this.options.appName,
            title,
            type: 'yjs',
            version: this.options.schemaVersion,
            folderId
        });

        await this.store.put(doc);
        this.index.add(doc);
        this.emit('doc-created', doc);

        // Background sync for eventual consistency
        this.fullSync().catch(err => console.error('Background sync failed:', err));

        return doc;
    }

    /**
     * Renames an existing document.
     *
     * @param {string} docId
     * @param {string} title
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async renameDoc(docId, title) {
        const doc = await this.api.rename(docId, title);
        await this.store.put(doc);
        this.index.add(doc);
        this.emit('doc-updated', doc);
        return doc;
    }

    /**
     * Deletes a document from the server and local cache.
     *
     * @param {string} docId
     */
    async deleteDoc(docId) {
        await this.api.delete(docId);
        await this.store.remove(docId);
        this.runtime.unload(docId);
        this.index.remove(docId);
        this.emit('doc-deleted', docId);
    }

    /**
     * Moves a document to a different folder.
     *
     * @param {string} docId - The document ID.
     * @param {string|null} targetFolderId - Target folder ID, or null for root.
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async moveDocument(docId, targetFolderId) {
        const doc = await this.api.moveDocument(docId, targetFolderId);
        await this.store.put(doc);
        this.index.add(doc);
        this.emit('doc-updated', doc);
        return doc;
    }

    /**
     * Shares a document with another user.
     *
     * @param {string} docId
     * @param {string} username
     * @param {string[]} permissions - e.g. ['read', 'write']
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async shareDoc(docId, username, permissions) {
        const doc = await this.api.share(docId, username, permissions);
        await this.store.put(doc);
        this.index.add(doc);
        this.emit('doc-updated', doc);
        return doc;
    }

    /**
     * Revokes a user's access to a document.
     *
     * @param {string} docId
     * @param {string} username
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async revokeDoc(docId, username) {
        const doc = await this.api.revoke(docId, username);
        await this.store.put(doc);
        this.index.add(doc);
        this.emit('doc-updated', doc);
        return doc;
    }

    // ===========================================
    // WRITE API - FOLDERS
    // ===========================================

    /**
     * Creates a new folder.
     *
     * @param {string} name - The folder name.
     * @param {string|null} [parentId=null] - Parent folder ID, or null for root.
     * @returns {Promise<import('../types').Folder>}
     */
    async createFolder(name, parentId = null) {
        const folder = await this.api.createFolder(name, parentId);
        await this.folderStore.put(folder);
        this.folderIndex.add(folder);
        this.emit('folder-created', folder);
        return folder;
    }

    /**
     * Renames a folder.
     *
     * @param {string} folderId - The folder ID.
     * @param {string} newName - The new folder name.
     * @returns {Promise<import('../types').Folder>}
     */
    async renameFolder(folderId, newName) {
        const folder = await this.api.renameFolder(folderId, newName);
        await this.folderStore.put(folder);
        this.folderIndex.add(folder);
        this.emit('folder-updated', folder);
        return folder;
    }

    /**
     * Deletes a folder and all its contents.
     *
     * @param {string} folderId - The folder ID.
     */
    async deleteFolder(folderId) {
        await this.api.deleteFolder(folderId);
        await this.folderStore.remove(folderId);
        this.folderIndex.remove(folderId);
        this.emit('folder-deleted', folderId);

        // Trigger full sync to update documents that were in this folder
        this.fullSync().catch(err => console.error('Background sync failed:', err));
    }

    /**
     * Moves a folder to a new parent.
     *
     * @param {string} folderId - The folder ID.
     * @param {string|null} newParentId - New parent folder ID, or null for root.
     * @returns {Promise<import('../types').Folder>}
     */
    async moveFolder(folderId, newParentId) {
        const folder = await this.api.moveFolder(folderId, newParentId);
        await this.folderStore.put(folder);
        this.folderIndex.add(folder);
        this.emit('folder-updated', folder);
        return folder;
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
        const folder = await this.api.shareFolder(folderId, username, permissions);
        await this.folderStore.put(folder);
        this.folderIndex.add(folder);
        this.emit('folder-updated', folder);

        // After sharing, the user may have gained access to many new items.
        // Trigger a background full sync to fetch them.
        this.fullSync().catch(err => console.error('Background sync failed:', err));

        return folder;
    }

    /**
     * Revokes a user's access to a folder.
     *
     * @param {string} folderId - The folder ID.
     * @param {string} username - The user to revoke access from.
     * @returns {Promise<import('../types').Folder>}
     */
    async revokeFolderShare(folderId, username) {
        const folder = await this.api.revokeFolderShare(folderId, username);
        await this.folderStore.put(folder);
        this.folderIndex.add(folder);
        this.emit('folder-updated', folder);

        // Trigger full sync to update permissions
        this.fullSync().catch(err => console.error('Background sync failed:', err));

        return folder;
    }

    // ===========================================
    // BLOB SUPPORT
    // ===========================================

    /**
     * Creates a new blob document and uploads the file content.
     *
     * @param {string} title - The display title.
     * @param {File} file - The file to upload.
     * @param {Object} [options={}] - Additional options.
     * @param {string|null} [options.folderId=null] - Optional parent folder ID.
     * @param {boolean} [options.publicRead=false] - Whether the document is publicly readable.
     * @param {boolean} [options.publicWrite=false] - Whether the document is publicly writable.
     * @param {string|null} [options.parentId=null] - Parent document ID (for attachments).
     * @returns {Promise<import('../types').DocDescriptor>}
     */
    async createBlobDocument(title, file, options = {}) {
        const {
            folderId = null,
            publicRead = false,
            publicWrite = false,
            parentId = null
        } = options;

        if (!this.blobStorageUrl) {
            throw new Error('blobStorageUrl is required for blob documents');
        }

        // 1. Create metadata entry
        const id = await this.api.generateId();
        const docId = `${this.options.appName}_${id}`;

        const doc = await this.api.createDoc({
            id: docId,
            app: this.options.appName,
            title,
            type: 'blob',
            folderId,
            parentId,
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            publicRead,
            publicWrite
        });

        // 2. Upload file content
        await this.uploadBlob(doc.id, file);

        // 3. Update local store
        await this.store.put(doc);
        this.index.add(doc);
        this.emit('doc-created', doc);

        return doc;
    }

    /**
     * Uploads a file to blob storage for an existing document.
     *
     * For public-write documents, authentication is optional.
     * For private documents, an API key is required.
     *
     * @param {string} docId - The document ID.
     * @param {File} file - The file to upload.
     * @returns {Promise<void>}
     */
    async uploadBlob(docId, file) {
        if (!this.blobStorageUrl) {
            throw new Error('blobStorageUrl is required for blob operations');
        }

        const apiKey = this.options.getApiKey();
        // Build URL - only include apikey if we have one (allows public-write uploads)
        const url = apiKey
            ? `${this.blobStorageUrl}?id=${docId}&apikey=${apiKey}`
            : `${this.blobStorageUrl}?id=${docId}`;

        const response = await fetch(url, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type }
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }

        // Refresh metadata to get updated size/blobKey
        await this.fullSync();
    }

    /**
     * Gets the download URL for a blob document.
     *
     * For public-read documents, authentication is optional.
     * For private documents, an API key is required.
     *
     * @param {string} docId - The document ID.
     * @returns {string|null} The download URL, or null if blobStorageUrl is not configured.
     */
    getBlobUrl(docId) {
        if (!this.blobStorageUrl) {
            return null;
        }

        const apiKey = this.options.getApiKey();
        // Only include apikey if we have one (allows public-read downloads)
        return apiKey
            ? `${this.blobStorageUrl}?id=${docId}&apikey=${apiKey}`
            : `${this.blobStorageUrl}?id=${docId}`;
    }

    // ===========================================
    // BACKGROUND SYNC & NETWORK HANDLING
    // ===========================================

    /**
     * Sets up network event listeners for online/offline handling and starts background sync.
     * @private
     */
    _setupNetworkListeners() {
        if (typeof window === 'undefined') return;

        // Online event: sync when connection is restored
        this._onlineHandler = () => {
            console.log('[DocManager] Network online - triggering background sync');
            this._syncState.syncAttemptCount = 0;
            this.fullSync().catch(err => console.error('[DocManager] Background sync failed:', err));
        };

        // Offline event: just log, don't attempt sync
        this._offlineHandler = () => {
            console.log('[DocManager] Network offline - sync disabled until connection restored');
        };

        // Visibility change: sync when tab becomes visible (if online)
        this._visibilityHandler = () => {
            if (document.visibilityState === 'visible' && navigator.onLine && !this._syncState.isSyncing) {
                console.log('[DocManager] Tab visible - checking for updates');
                this.fullSync().catch(err => console.error('[DocManager] Background sync failed:', err));
            }
        };

        window.addEventListener('online', this._onlineHandler);
        window.addEventListener('offline', this._offlineHandler);
        document.addEventListener('visibilitychange', this._visibilityHandler);

        // Start background sync interval
        this._startSyncInterval();
    }

    /**
     * Starts the background sync interval.
     * @private
     */
    _startSyncInterval() {
        if (this._syncIntervalId) {
            clearInterval(this._syncIntervalId);
        }

        this._syncIntervalId = setInterval(() => {
            // Only sync if online and not already syncing
            if (navigator.onLine && !this._syncState.isSyncing) {
                console.log('[DocManager] Background sync interval triggered');
                this.fullSync().catch(err => {
                    console.error('[DocManager] Background sync failed:', err);
                    this._syncState.lastSyncError = err;
                });
            }
        }, this.syncInterval);
    }

    /**
     * Stops the background sync interval.
     * @private
     */
    _stopSyncInterval() {
        if (this._syncIntervalId) {
            clearInterval(this._syncIntervalId);
            this._syncIntervalId = null;
        }
    }

    /**
     * Gets the current sync state.
     * @returns {{ isSyncing: boolean, lastSyncTime: Date|null, lastSyncError: Error|null, syncAttemptCount: number }}
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
     * Gracefully shuts down the DocManager, closing all network connections and database handles.
     */
    async shutdown() {
        // Stop background sync interval
        this._stopSyncInterval();

        // Remove event listeners
        if (typeof window !== 'undefined') {
            if (this._onlineHandler) window.removeEventListener('online', this._onlineHandler);
            if (this._offlineHandler) window.removeEventListener('offline', this._offlineHandler);
            if (this._visibilityHandler) document.removeEventListener('visibilitychange', this._visibilityHandler);
        }

        // Cleanup runtime and stores
        this.runtime.shutdown();
        if (this.store) await this.store.close();
        if (this.folderStore) await this.folderStore.close();
    }
}
