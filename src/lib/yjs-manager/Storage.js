/**
 * Storage - Unified facade for file and folder management.
 *
 * This module provides a simplified, high-level API for:
 * - App-scoped files (app-specific settings, preferences, caches)
 * - Drive files (user files organized in folders)
 * - Real-time collaboration via Yjs
 * - Blob storage for binary files
 *
 * ## Design Philosophy
 *
 * Storage provides two conceptual storage areas:
 *
 * ### App Storage (`storage.app`)
 * For application-specific data that doesn't belong in the user's drive:
 * - Application settings and preferences
 * - Cache data
 * - Session state
 * - Files that are internal to the app
 *
 * App files are isolated by app name and not visible in the user's drive.
 *
 * ### Drive Storage (`storage.drive`)
 * For user files that should appear in their file system:
 * - User-created files
 * - Uploaded files
 * - Shared files
 *
 * Drive files are organized in folders and can be shared with other users.
 *
 * ## Usage Example
 *
 * ```javascript
 * import { Storage } from '@lib/yjs-manager';
 *
 * const storage = new Storage({
 *   appName: 'my-app',
 *   schemaVersion: '1',
 *   schemas: [...],
 *   baseUrl: '/api/docs',
 *   wsUrl: 'wss://sync.example.com',
 *   blobStorageUrl: '/api/blobs',
 *   getApiKey: () => localStorage.getItem('apiKey'),
 *   getUsername: () => localStorage.getItem('username')
 * });
 *
 * await storage.init();
 *
 * // App storage (reactive)
 * $: appFiles = $storage.app.files;
 *
 * // Drive storage (reactive)
 * $: driveFiles = $storage.drive.files;
 * $: driveFolders = $storage.drive.folders;
 * $: sharedItems = $storage.drive.shared;
 * ```
 */

import { writable, derived } from 'svelte/store';
import { StorageCore } from './core/StorageCore.js';

/**
 * Storage - The main facade for file and folder management.
 */
export class Storage {
    /**
     * @param {import('./types').StorageOptions} options
     */
    constructor(options) {
        this.options = options;
        /** @type {StorageCore|null} */
        this._core = null;
        /** @type {AppCollection|null} */
        this._app = null;
        /** @type {DriveFileSystem|null} */
        this._drive = null;
        this._isInitialized = false;

        // Ready store - starts false, becomes true after init() completes
        this.ready = writable(false);
    }

    /**
     * Initializes the storage system.
     *
     * @returns {Promise<void>}
     */
    async init() {
        if (this._isInitialized) return;

        this._core = new StorageCore({
            appName: this.options.appName,
            schemaVersion: this.options.schemaVersion,
            schemas: this.options.schemas,
            baseUrl: this.options.baseUrl,
            wsUrl: this.options.wsUrl,
            blobStorageUrl: this.options.blobStorageUrl,
            getApiKey: this.options.getApiKey,
            getUsername: this.options.getUsername,
            syncInterval: this.options.syncInterval,
            debug: this.options.debug
        });

        await this._core.initialize();

        // Create the app and drive interfaces
        this._app = new AppCollection(this._core, this.options.appName);
        this._drive = new DriveFileSystem(this._core);

        // Wire up reactive updates
        this._setupReactivity();

        // Immediately seed reactive stores with cached data
        // This ensures UI gets data even if initial events fired before listeners attached
        if (this._app) {
            this._app._update();
        }
        if (this._drive) {
            this._drive._updateFiles();
            this._drive._updateFolders();
        }

        this._isInitialized = true;
        this.ready.set(true);
    }

    /**
     * Sets up reactive store updates based on core events.
     * @private
     */
    _setupReactivity() {
        // Update app store when files change
        this._core.on('files-ready', () => {
            if (this._app) {
                this._app._update();
            }
            if (this._drive) {
                this._drive._updateFiles();
            }
        });

        // Update drive store when folders change
        this._core.on('folders-ready', () => {
            if (this._drive) {
                this._drive._updateFolders();
            }
        });
    }

    /**
     * Access app-scoped storage.
     *
     * @returns {AppCollection}
     */
    get app() {
        this._ensureInitialized();
        return this._app;
    }

    /**
     * Access drive storage.
     *
     * @returns {DriveFileSystem}
     */
    get drive() {
        this._ensureInitialized();
        return this._drive;
    }

    /**
     * Performs a full sync with the server.
     *
     * @returns {Promise<void>}
     */
    async sync() {
        this._ensureInitialized();
        return this._core.fullSync();
    }

    /**
     * Gets the underlying StorageCore for advanced operations.
     *
     * @returns {StorageCore}
     */
    get core() {
        this._ensureInitialized();
        return this._core;
    }

    /**
     * Sets debug mode and persists to localStorage.
     *
     * @param {boolean} enabled
     */
    setDebug(enabled) {
        this._ensureInitialized();
        this._core.setDebug(enabled);
    }

    /**
     * Dumps the full storage contents to console and returns the data.
     *
     * @returns {{ files: import('./types').ClassifiedFile[], folders: import('./types').ClassifiedFolder[], syncState: Object }}
     */
    dumpStorage() {
        this._ensureInitialized();
        return this._core.dumpStorage();
    }

    /**
     * Gracefully shuts down the storage system.
     */
    async shutdown() {
        if (this._core) {
            await this._core.shutdown();
        }
        this._isInitialized = false;
        this.ready.set(false);
    }

    /**
     * Subscribe to storage events.
     *
     * @param {'sync-complete'|'auth-error'|'files-ready'|'folders-ready'} event
     * @param {Function} callback
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        this._ensureInitialized();
        this._core.on(event, callback);
        return () => this._core.off(event, callback);
    }

    _ensureInitialized() {
        if (!this._isInitialized) {
            throw new Error('Storage not initialized. Call init() first.');
        }
    }
}

/**
 * AppCollection - Interface for app-scoped storage.
 *
 * App files are isolated by app name and not visible in the user's drive.
 * They're ideal for application settings, preferences, caches, and internal state.
 *
 * ## File IDs vs Titles
 *
 * File IDs are always server-generated opaque identifiers. Clients must never set
 * their own IDs. Use the `title` property for human-readable file names.
 *
 * ## API Pattern
 *
 * AppCollection follows the same file storage pattern as DriveFileSystem:
 * - `createFile(options)` - Create a new Yjs file
 * - `createBlob(options)` - Create a new blob file
 * - `renameFile(fileId, title)` - Rename an existing file
 *
 * This is NOT a key-value store. App storage is namespaced file storage without
 * folder hierarchy.
 */
class AppCollection {
    /**
     * @param {StorageCore} core
     * @param {string} appName
     */
    constructor(core, appName) {
        this._core = core;
        this._appName = appName;

        // Reactive Svelte store for app files
        this._files = writable([]);
        this.files = { subscribe: this._files.subscribe };
    }

    /**
     * Updates the reactive store from the core index.
     * @internal
     */
    _update() {
        const appFiles = this._core.fileIndex.getAppScoped();
        this._files.set(appFiles);
    }

    // ===========================================
    // QUERY METHODS
    // ===========================================

    /**
     * Gets an app file by its full ID.
     *
     * @param {string} fileId - The full file ID (with app prefix)
     * @returns {import('./types').ClassifiedFile|null}
     */
    get(fileId) {
        return this._core.getFile(fileId);
    }

    /**
     * Lists all app-scoped files for this app.
     *
     * @returns {import('./types').ClassifiedFile[]}
     */
    list() {
        return this._core.fileIndex.getAppScoped();
    }

    /**
     * Gets all app files shared with the current user.
     *
     * @returns {import('./types').ClassifiedFile[]}
     */
    getShared() {
        return this.list().filter(f => f.shared);
    }

    /**
     * Gets all publicly accessible app files.
     *
     * @returns {import('./types').ClassifiedFile[]}
     */
    getPublic() {
        return this.list().filter(f => f.publicRead);
    }

    /**
     * Gets all app files owned by the current user.
     *
     * @returns {import('./types').ClassifiedFile[]}
     */
    getOwned() {
        return this.list().filter(f => f.owned);
    }

    // ===========================================
    // CREATE METHODS
    // ===========================================

    /**
     * Creates a new app-scoped Yjs file.
     *
     * File IDs are always server-generated. Use the `title` property for
     * human-readable file names.
     *
     * @param {import('./types').CreateFileOptions} options - Creation options.
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async createFile(options = {}) {
        const {
            title = 'Untitled',
            parentId = null,
            publicRead = false,
            publicWrite = false
        } = options;

        const result = await this._core.createFile({
            title,
            type: 'yjs',
            scope: 'app',
            parentId,
            publicRead,
            publicWrite
        });

        this._update();
        return result;
    }

    // ===========================================
    // LOAD METHODS
    // ===========================================

    /**
     * Loads a Yjs file for real-time collaboration.
     *
     * @param {string} fileId - The file ID
     * @returns {Promise<import('yjs').Doc>}
     */
    async load(fileId) {
        return this._core.loadYjsFile(fileId);
    }

    /**
     * Gets a synchronously loaded Yjs document.
     *
     * @param {string} fileId - The file ID
     * @returns {import('yjs').Doc|null}
     */
    getYDoc(fileId) {
        return this._core.getYDoc(fileId);
    }

    // ===========================================
    // BLOB OPERATIONS
    // ===========================================

    /**
     * Creates a blob file from a File object.
     *
     * @param {string} title - The file title.
     * @param {File} file - The file to upload.
     * @param {Object} [options] - Additional options.
     * @param {string} [options.parentId] - Parent file ID (for attachments).
     * @param {boolean} [options.publicRead=false] - Public read access.
     * @param {boolean} [options.publicWrite=false] - Public write access.
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async createBlob(title, file, options = {}) {
        const { parentId = null, publicRead = false, publicWrite = false } = options;

        // Removed redundant ID generation - StorageCore.createBlobFile handles it
        const descriptor = await this._core.createBlobFile(title, file, {
            scope: 'app',
            app: this._appName,  // Pass app name for proper ID prefixing
            parentId,
            publicRead,
            publicWrite
        });

        this._update();
        return descriptor;
    }

    /**
     * Uploads a new version of a blob file.
     *
     * @param {string} id - The file ID (without app prefix)
     * @param {File} file - The new file
     * @returns {Promise<void>}
     */
    async uploadBlob(id, file) {
        const fullId = `${this._appName}_${id}`;
        await this._core.uploadBlob(fullId, file);
        this._update();
    }

    /**
     * Gets the download URL for a blob file.
     *
     * @param {string} id - The file ID (without app prefix)
     * @returns {string|null}
     */
    getBlobUrl(id) {
        const fullId = `${this._appName}_${id}`;
        return this._core.getBlobUrl(fullId);
    }

    // ===========================================
    // ATTACHMENT OPERATIONS
    // ===========================================

    /**
     * Gets all attachments of a parent file.
     *
     * @param {string} parentId - Parent file ID (without app prefix)
     * @returns {import('./types').ClassifiedFile[]}
     */
    getChildren(parentId) {
        const fullParentId = `${this._appName}_${parentId}`;
        return this._core.fileIndex.getByParent(fullParentId);
    }

    /**
     * Creates an attachment for a parent file.
     *
     * File IDs are always server-generated. Use the `title` property for
     * human-readable file names.
     *
     * @param {import('./types').CreateAttachmentOptions} options - Creation options.
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async createAttachment(options) {
        const { parentId, title, type = 'yjs', file, publicRead = false, publicWrite = false } = options;

        const descriptor = await this._core.createFile({
            title,
            type,
            scope: 'app',
            parentId,
            publicRead,
            publicWrite
        });

        if (type === 'blob' && file) {
            await this._core.uploadBlob(descriptor.id, file);
        }

        this._update();
        return descriptor;
    }

    // ===========================================
    // MODIFY METHODS
    // ===========================================

    /**
     * Renames an app file.
     *
     * @param {string} fileId - The file ID
     * @param {string} title - New title
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async renameFile(fileId, title) {
        const result = await this._core.renameFile(fileId, title);
        this._update();
        return result;
    }

    /**
     * Deletes an app file.
     *
     * @param {string} fileId - The file ID
     * @returns {Promise<void>}
     */
    async delete(fileId) {
        await this._core.deleteFile(fileId);
        this._update();
    }

    // ===========================================
    // SHARING OPERATIONS
    // ===========================================

    /**
     * Shares an app file with another user.
     *
     * @param {string} fileId - The file ID
     * @param {string} username - Username to share with
     * @param {string[]} permissions - Permissions to grant
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async share(fileId, username, permissions) {
        const result = await this._core.shareFile(fileId, username, permissions);
        this._update();
        return result;
    }

    /**
     * Revokes a user's access to an app file.
     *
     * @param {string} fileId - The file ID
     * @param {string} username - Username to revoke
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async revoke(fileId, username) {
        const result = await this._core.revokeFile(fileId, username);
        this._update();
        return result;
    }

    /**
     * Sets public access flags on an app file.
     *
     * @param {string} fileId - The file ID
     * @param {boolean} publicRead - Public read access
     * @param {boolean} publicWrite - Public write access
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async setPublic(fileId, publicRead, publicWrite) {
        const result = await this._core.api.setFilePublic(fileId, publicRead, publicWrite);
        this._core.fileIndex.add(result);
        this._update();
        return result;
    }

    /**
     * Sets the parent of an app file (for attachments).
     *
     * @param {string} fileId - The file ID
     * @param {string|null} parentId - Parent file ID, or null to remove parent
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async setParent(fileId, parentId) {
        const result = await this._core.setFileParent(fileId, parentId);
        this._update();
        return result;
    }
}

/**
 * DriveFileSystem - Interface for user drive storage.
 *
 * Drive files are organized in folders and can be shared with other users.
 * They appear in the user's file system and can be accessed from any app.
 */
class DriveFileSystem {
    /**
     * @param {StorageCore} core
     */
    constructor(core) {
        this._core = core;

        // Reactive Svelte stores
        this._files = writable([]);
        this._folders = writable([]);

        // Public readable stores
        this.files = { subscribe: this._files.subscribe };
        this.folders = { subscribe: this._folders.subscribe };

        // Derived store for shared items
        this.shared = derived(
            [this._files, this._folders],
            ([$files, $folders]) => ({
                files: $files.filter(f => f.shared),
                folders: $folders.filter(f => f.shared)
            })
        );
    }

    /**
     * Updates the files store from the core index.
     * @internal
     */
    _updateFiles() {
        const driveFiles = this._core.fileIndex.getDriveScoped();
        this._files.set(driveFiles);
    }

    /**
     * Updates the folders store from the core index.
     * @internal
     */
    _updateFolders() {
        const folders = this._core.folderIndex.getAll();
        this._folders.set(folders);
    }

    // ===========================================
    // FILE OPERATIONS
    // ===========================================

    /**
     * Gets a file by ID.
     *
     * @param {string} fileId - The file ID
     * @returns {import('./types').ClassifiedFile|null}
     */
    getFile(fileId) {
        return this._core.getFile(fileId);
    }

    /**
     * Lists all files in the drive.
     *
     * @param {Object} [options] - Filter options
     * @param {string|null} [options.folderId] - Filter by folder ID
     * @param {'yjs'|'blob'} [options.type] - Filter by file type
     * @param {boolean} [options.owned] - Filter to owned files only
     * @param {boolean} [options.shared] - Filter to shared files only
     * @returns {import('./types').ClassifiedFile[]}
     */
    listFiles(options = {}) {
        let files = this._core.fileIndex.getDriveScoped();

        if (options.folderId !== undefined) {
            files = files.filter(f => f.folderId === options.folderId);
        }
        if (options.type) {
            files = files.filter(f => f.type === options.type);
        }
        if (options.owned) {
            files = files.filter(f => f.owned);
        }
        if (options.shared) {
            files = files.filter(f => f.shared);
        }

        return files;
    }

    /**
     * Creates a new file.
     *
     * @param {Object} options - Creation options
     * @param {string} [options.title='Untitled'] - File title
     * @param {string|null} [options.folderId] - Parent folder ID
     * @param {'yjs'|'blob'} [options.type='yjs'] - File type
     * @param {boolean} [options.publicRead=false] - Public read access
     * @param {boolean} [options.publicWrite=false] - Public write access
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async createFile(options = {}) {
        const {
            title = 'Untitled',
            folderId = null,
            type = 'yjs',
            publicRead = false,
            publicWrite = false
        } = options;

        const result = await this._core.createFile({
            title,
            folderId,
            type,
            scope: 'drive',
            publicRead,
            publicWrite
        });

        this._updateFiles();
        return result;
    }

    /**
     * Loads a Yjs file for real-time collaboration.
     *
     * @param {string} fileId - The file ID
     * @returns {Promise<import('yjs').Doc>}
     */
    async loadFile(fileId) {
        return this._core.loadYjsFile(fileId);
    }

    /**
     * Gets a synchronously loaded Yjs document.
     *
     * @param {string} fileId - The file ID
     * @returns {import('yjs').Doc|null}
     */
    getYDoc(fileId) {
        return this._core.getYDoc(fileId);
    }

    /**
     * Renames a file.
     *
     * @param {string} fileId - The file ID
     * @param {string} title - New title
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async renameFile(fileId, title) {
        const result = await this._core.renameFile(fileId, title);
        this._updateFiles();
        return result;
    }

    /**
     * Moves a file to a different folder.
     *
     * @param {string} fileId - The file ID
     * @param {string|null} targetFolderId - Target folder ID, or null for root
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async moveFile(fileId, targetFolderId) {
        const result = await this._core.moveFile(fileId, targetFolderId);
        this._updateFiles();
        return result;
    }

    /**
     * Deletes a file.
     *
     * @param {string} fileId - The file ID
     * @returns {Promise<void>}
     */
    async deleteFile(fileId) {
        await this._core.deleteFile(fileId);
        this._updateFiles();
    }

    /**
     * Shares a file with another user.
     *
     * @param {string} fileId - The file ID
     * @param {string} username - Username to share with
     * @param {string[]} permissions - Permissions to grant
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async shareFile(fileId, username, permissions) {
        const result = await this._core.shareFile(fileId, username, permissions);
        this._updateFiles();
        return result;
    }

    /**
     * Revokes a user's access to a file.
     *
     * @param {string} fileId - The file ID
     * @param {string} username - Username to revoke
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async revokeFile(fileId, username) {
        const result = await this._core.revokeFile(fileId, username);
        this._updateFiles();
        return result;
    }

    /**
     * Sets the parent of a file (for attachments).
     *
     * @param {string} fileId - The file ID
     * @param {string|null} parentId - Parent file ID, or null to remove parent
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async setFileParent(fileId, parentId) {
        const result = await this._core.setFileParent(fileId, parentId);
        this._updateFiles();
        return result;
    }

    // ===========================================
    // FOLDER OPERATIONS
    // ===========================================

    /**
     * Gets a folder by ID.
     *
     * @param {string} folderId - The folder ID
     * @returns {import('./types').ClassifiedFolder|null}
     */
    getFolder(folderId) {
        return this._core.getFolder(folderId);
    }

    /**
     * Lists folders.
     *
     * @param {Object} [options] - Filter options
     * @param {string|null} [options.parentId] - Filter by parent folder ID
     * @returns {import('./types').ClassifiedFolder[]}
     */
    listFolders(options = {}) {
        if (options.parentId !== undefined) {
            return this._core.folderIndex.getChildren(options.parentId);
        }
        return this._core.folderIndex.getAll();
    }

    /**
     * Gets the contents of a folder (both subfolders and files).
     *
     * @param {string|null} folderId - Folder ID, or null for root
     * @returns {{ folders: import('./types').ClassifiedFolder[], files: import('./types').ClassifiedFile[] }}
     */
    getFolderContents(folderId) {
        return this._core.getFolderContents(folderId);
    }

    /**
     * Creates a new folder.
     *
     * @param {Object} options - Creation options
     * @param {string} options.name - Folder name
     * @param {string|null} [options.parentId] - Parent folder ID
     * @param {boolean} [options.publicRead=false] - Public read access
     * @param {boolean} [options.publicWrite=false] - Public write access
     * @returns {Promise<import('./types').Folder>}
     */
    async createFolder(options) {
        const { name, parentId = null, publicRead = false, publicWrite = false } = options;

        const folder = await this._core.createFolder(name, parentId);

        // Set public access if needed
        if (publicRead || publicWrite) {
            await this._core.api.setFolderPublic(folder.id, publicRead, publicWrite);
        }

        this._updateFolders();
        return folder;
    }

    /**
     * Renames a folder.
     *
     * @param {string} folderId - The folder ID
     * @param {string} name - New name
     * @returns {Promise<import('./types').Folder>}
     */
    async renameFolder(folderId, name) {
        const result = await this._core.renameFolder(folderId, name);
        this._updateFolders();
        return result;
    }

    /**
     * Moves a folder to a different parent.
     *
     * @param {string} folderId - The folder ID
     * @param {string|null} newParentId - New parent folder ID
     * @returns {Promise<import('./types').Folder>}
     */
    async moveFolder(folderId, newParentId) {
        const result = await this._core.moveFolder(folderId, newParentId);
        this._updateFolders();
        return result;
    }

    /**
     * Deletes a folder and all its contents.
     *
     * @param {string} folderId - The folder ID
     * @returns {Promise<void>}
     */
    async deleteFolder(folderId) {
        await this._core.deleteFolder(folderId);
        this._updateFolders();
        this._updateFiles();
    }

    /**
     * Shares a folder with another user.
     *
     * @param {string} folderId - The folder ID
     * @param {string} username - Username to share with
     * @param {string[]} permissions - Permissions to grant
     * @returns {Promise<import('./types').Folder>}
     */
    async shareFolder(folderId, username, permissions) {
        const result = await this._core.shareFolder(folderId, username, permissions);
        this._updateFolders();
        return result;
    }

    /**
     * Revokes a user's access to a folder.
     *
     * @param {string} folderId - The folder ID
     * @param {string} username - Username to revoke
     * @returns {Promise<import('./types').Folder>}
     */
    async revokeFolderShare(folderId, username) {
        const result = await this._core.revokeFolderShare(folderId, username);
        this._updateFolders();
        return result;
    }

    // ===========================================
    // BLOB OPERATIONS
    // ===========================================

    /**
     * Creates a blob file from a File object.
     *
     * @param {Object} options - Creation options
     * @param {string} [options.title] - File title (defaults to filename)
     * @param {File} options.file - The file to upload
     * @param {string|null} [options.folderId] - Parent folder ID
     * @param {boolean} [options.publicRead=false] - Public read access
     * @param {boolean} [options.publicWrite=false] - Public write access
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async createBlob(options) {
        const { file, title, folderId = null, publicRead = false, publicWrite = false } = options;

        const result = await this._core.createBlobFile(
            title || file.name,
            file,
            { folderId, publicRead, publicWrite, scope: 'drive' }
        );

        this._updateFiles();
        return result;
    }

    /**
     * Gets the download URL for a blob file.
     *
     * @param {string} fileId - The file ID
     * @returns {string|null}
     */
    getBlobUrl(fileId) {
        return this._core.getBlobUrl(fileId);
    }

    /**
     * Uploads a new version of a blob file.
     *
     * @param {string} fileId - The file ID
     * @param {File} file - The new file
     * @returns {Promise<void>}
     */
    async updateBlob(fileId, file) {
        await this._core.uploadBlob(fileId, file);
        this._updateFiles();
    }

    // ===========================================
    // ATTACHMENT OPERATIONS
    // ===========================================

    /**
     * Gets all attachments of a parent file.
     *
     * @param {string} parentId - Parent file ID
     * @returns {import('./types').ClassifiedFile[]}
     */
    getAttachments(parentId) {
        return this._core.fileIndex.getByParent(parentId);
    }

    /**
     * Creates an attachment for a parent file.
     *
     * File IDs are always server-generated. Use the `title` property for
     * human-readable file names.
     *
     * @param {import('./types').CreateAttachmentOptions} options - Creation options.
     * @returns {Promise<import('./types').FileDescriptor>}
     */
    async createAttachment(options) {
        const { parentId, title, type = 'yjs', file, publicRead = false, publicWrite = false } = options;

        const descriptor = await this._core.createFile({
            title,
            type,
            scope: 'drive',
            parentId,
            publicRead,
            publicWrite
        });

        if (type === 'blob' && file) {
            await this._core.uploadBlob(descriptor.id, file);
        }

        this._updateFiles();
        return descriptor;
    }

    // ===========================================
    // PUBLIC ACCESS
    // ===========================================

    /**
     * Sets public access on a file or folder.
     *
     * @param {string} id - Resource ID
     * @param {'file'|'folder'} type - Resource type
     * @param {boolean} publicRead - Public read access
     * @param {boolean} publicWrite - Public write access
     * @returns {Promise<import('./types').FileDescriptor|import('./types').Folder>}
     */
    async setPublic(id, type, publicRead, publicWrite) {
        let result;
        if (type === 'folder') {
            result = await this._core.api.setFolderPublic(id, publicRead, publicWrite);
            this._updateFolders();
        } else {
            result = await this._core.api.setFilePublic(id, publicRead, publicWrite);
            this._updateFiles();
        }
        return result;
    }

    // ===========================================
    // SPECIAL VIEWS
    // ===========================================

    /**
     * Gets all items shared with the current user.
     *
     * @returns {{ folders: import('./types').ClassifiedFolder[], files: import('./types').ClassifiedFile[] }}
     */
    getSharedWithMe() {
        return this._core.getSharedWithMe();
    }

    /**
     * Gets all items owned by the current user.
     *
     * @returns {{ folders: import('./types').ClassifiedFolder[], files: import('./types').ClassifiedFile[] }}
     */
    getMyItems() {
        return {
            folders: this._core.folderIndex.getOwned(),
            files: this._core.fileIndex.getOwned()
        };
    }

    /**
     * Gets all publicly accessible items.
     *
     * @returns {{ folders: import('./types').ClassifiedFolder[], files: import('./types').ClassifiedFile[] }}
     */
    getPublicItems() {
        return {
            folders: this._core.folderIndex.getPublic(),
            files: this._core.fileIndex.getPublic()
        };
    }
}

export default Storage;
