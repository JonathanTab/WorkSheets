/**
 * @typedef {string} FileId - Stable logical file ID. Stays the same across versions and renames.
 * @typedef {string} RoomId - The physical Yjs room ID (usually a UUID or hash) where the data actually lives.
 * @typedef {string} SchemaVersion - Version string (e.g., "1", "2.0"). Used to trigger migrations.
 * @typedef {string} FolderId - Unique identifier for a folder.
 */

/**
 * @typedef {Object} FileDescriptor
 * @description The raw metadata for a file as stored on the server and in IndexedDB.
 * Replaces the old DocDescriptor terminology.
 *
 * @property {FileId} id - Stable logical file ID.
 * @property {string} title - Human-readable file title.
 * @property {string|null} app - The application namespace this file belongs to.
 * @property {string} owner - Username of the file owner.
 * @property {('read'|'write')[]} permissions - List of permissions granted to the current user (includes inherited permissions).
 * @property {Object.<SchemaVersion, RoomId>} versions - Map of schema versions to their corresponding physical rooms (for yjs type).
 * @property {Array<{username: string, permissions: ('read'|'write')[]}>} [sharedWith] - List of users file is shared with.
 * @property {'yjs'|'blob'} [type='yjs'] - File type. 'yjs' for collaborative files, 'blob' for binary files.
 * @property {FolderId|null} [folderId=null] - ID of the parent folder (drive scope only), or null for root level.
 * @property {string|null} [blobKey=null] - Storage key for blob type files.
 * @property {string|null} [mimeType=null] - MIME type for blob files.
 * @property {number|null} [size=null] - File size in bytes for blob files.
 * @property {string|null} [filename=null] - Original filename for blob files.
 * @property {number} [createdAt] - Unix timestamp of file creation.
 * @property {number} [updatedAt] - Unix timestamp of last update.
 * @property {'app'|'drive'} [scope='drive'] - Storage scope: 'app' for app-scoped files, 'drive' for drive files.
 * @property {FileId|null} [parentId=null] - Parent file ID (for attachments).
 * @property {boolean} [publicRead=false] - Whether the file is publicly readable.
 * @property {boolean} [publicWrite=false] - Whether the file is publicly writable.
 * @property {boolean} [deleted=false] - Soft-delete flag.
 */

/**
 * @typedef {Object} ClassifiedFile
 * @description An augmented version of FileDescriptor with convenient boolean flags for UI logic.
 * @property {FileId} id - Stable logical file ID.
 * @property {string} title - Human-readable file title.
 * @property {string|null} app - The application namespace this file belongs to.
 * @property {string} owner - Username of the file owner.
 * @property {('read'|'write')[]} permissions - List of permissions granted to the current user.
 * @property {Object.<SchemaVersion, RoomId>} versions - Map of schema versions to room IDs.
 * @property {'yjs'|'blob'} [type='yjs'] - File type.
 * @property {FolderId|null} [folderId=null] - Parent folder ID (drive scope only).
 * @property {string|null} [blobKey=null] - Storage key for blob files.
 * @property {string|null} [mimeType=null] - MIME type for blob files.
 * @property {number|null} [size=null] - File size in bytes.
 * @property {string|null} [filename=null] - Original filename for blob files.
 * @property {number} [createdAt] - Unix timestamp of file creation.
 * @property {number} [updatedAt] - Unix timestamp of last update.
 * @property {'app'|'drive'} [scope='drive'] - Storage scope.
 * @property {FileId|null} [parentId=null] - Parent file ID (for attachments).
 * @property {boolean} [publicRead=false] - Whether publicly readable.
 * @property {boolean} [publicWrite=false] - Whether publicly writable.
 * @property {boolean} [deleted=false] - Soft-delete flag.
 * @property {Array<{username: string, permissions: ('read'|'write')[]}>} [sharedWith] - Share list.
 * @property {boolean} owned - Whether current user owns this file.
 * @property {boolean} shared - Whether this file is shared (with user or by user).
 * @property {boolean} writable - Whether current user can write to this file.
 */

/**
 * @typedef {Object} Folder
 * @description Represents a folder in the user's drive hierarchy.
 *
 * @property {FolderId} id - Unique folder identifier.
 * @property {string} name - Display name of the folder.
 * @property {FolderId|null} parentId - ID of parent folder, or null for root level.
 * @property {string} owner - Username of the folder owner.
 * @property {('read'|'write')[]} permissions - Effective permissions for the current user (includes inherited).
 * @property {Array<{username: string, permissions: ('read'|'write')[]}>} [sharedWith] - List of users folder is shared with.
 * @property {number} [createdAt] - Unix timestamp of folder creation.
 * @property {number} [updatedAt] - Unix timestamp of last update.
 * @property {boolean} [publicRead=false] - Whether the folder is publicly readable (propagates to contents).
 * @property {boolean} [publicWrite=false] - Whether the folder is publicly writable (propagates to contents).
 */

/**
 * @typedef {Folder & {
 *   owned: boolean,
 *   shared: boolean,
 *   writable: boolean
 * }} ClassifiedFolder
 * @description An augmented version of Folder with convenient boolean flags for UI logic.
 */

/**
 * @typedef {Object} FullSyncResult
 * @description Result returned from the full_sync API endpoint.
 *
 * @property {FileDescriptor[]} documents - All files accessible to the user (named 'documents' for server compatibility).
 * @property {Folder[]} folders - All folders accessible to the user.
 */

/**
 * @typedef {Object} SchemaDefinition
 * @description Defines a specific version of the file data structure.
 *
 * @property {SchemaVersion} version - The version string.
 * @property {function(import('yjs').Doc): Promise<void>|void} [migrate] -
 *   Optional function to transform data after it has been copied from a previous version.
 * @property {function(import('yjs').Doc): void} [initialize] -
 *   Optional function to set up shared types (e.g. Y.Map, Y.Array) on a fresh file.
 */

/**
 * @typedef {Object} StorageCoreOptions
 * @description Configuration for the StorageCore instance.
 *
 * @property {string} appName - Name of the application (used for filtering files and DB naming).
 * @property {SchemaVersion} schemaVersion - The version the application currently expects to work with.
 * @property {SchemaDefinition[]} schemas - Registered schema versions and their migration/init logic.
 * @property {string} baseUrl - The base URL for the REST API.
 * @property {string} wsUrl - The WebSocket server URL for Yjs synchronization.
 * @property {string} [blobStorageUrl] - The base URL for blob storage operations.
 * @property {function(): string|null} getApiKey - Dynamic provider for the authentication key.
 * @property {function(): string|null} [getUsername] - Optional provider for the current user's display name.
 * @property {number} [syncInterval=300000] - Background sync interval in milliseconds (default: 5 minutes).
 * @property {boolean} [debug=false] - Enable debug mode to dump storage contents on sync.
 */

/**
 * @typedef {Object} StorageOptions
 * @description Configuration for the Storage facade instance.
 *
 * @property {string} appName - Name of the application (used for filtering files and DB naming).
 * @property {SchemaVersion} schemaVersion - The version the application currently expects to work with.
 * @property {SchemaDefinition[]} schemas - Registered schema versions and their migration/init logic.
 * @property {string} baseUrl - The base URL for the REST API.
 * @property {string} wsUrl - The WebSocket server URL for Yjs synchronization.
 * @property {string} [blobStorageUrl] - The base URL for blob storage operations.
 * @property {function(): string|null} getApiKey - Dynamic provider for the authentication key.
 * @property {function(): string|null} [getUsername] - Optional provider for the current user's display name.
 * @property {number} [syncInterval=300000] - Background sync interval in milliseconds (default: 5 minutes).
 * @property {boolean} [debug=false] - Enable debug mode to dump storage contents on sync.
 */

/**
 * @typedef {Object} CreateFileOptions
 * @description Options for creating a new file.
 *
 * IMPORTANT: File IDs are always server-generated. Clients must NOT provide IDs.
 * Use the `title` property for human-readable file names.
 *
 * @property {string} [title='Untitled'] - The file title (user-facing name).
 * @property {'yjs'|'blob'} [type='yjs'] - File type.
 * @property {FolderId|null} [folderId=null] - Parent folder ID (drive scope only).
 * @property {FileId|null} [parentId=null] - Parent file ID (for attachments).
 * @property {boolean} [publicRead=false] - Whether the file is publicly readable.
 * @property {boolean} [publicWrite=false] - Whether the file is publicly writable.
 * @property {string|null} [filename=null] - Original filename (for blob type).
 * @property {string|null} [mimeType=null] - MIME type (for blob type).
 * @property {number|null} [size=null] - File size in bytes (for blob type).
 */

/**
 * @typedef {Object} CreateBlobOptions
 * @description Options for creating a blob file.
 *
 * @property {File} file - The file to upload.
 * @property {string} [title] - File title (defaults to filename).
 * @property {FolderId|null} [folderId=null] - Parent folder ID (drive scope only).
 * @property {FileId|null} [parentId=null] - Parent file ID (for attachments).
 * @property {boolean} [publicRead=false] - Whether the file is publicly readable.
 * @property {boolean} [publicWrite=false] - Whether the file is publicly writable.
 */

/**
 * @typedef {Object} CreateAttachmentOptions
 * @description Options for creating a file attachment.
 *
 * @property {FileId} parentId - Parent file ID (required).
 * @property {string} title - Attachment title.
 * @property {'yjs'|'blob'} [type='yjs'] - Attachment type.
 * @property {File} [file] - File for blob attachments (required if type='blob').
 * @property {boolean} [publicRead=false] - Whether the file is publicly readable.
 * @property {boolean} [publicWrite=false] - Whether the file is publicly writable.
 */

/**
 * @typedef {Object} CreateFolderOptions
 * @description Options for creating a new folder.
 *
 * @property {FolderId|null} [parentId=null] - Parent folder ID, or null for root.
 * @property {boolean} [publicRead=false] - Whether the folder is publicly readable.
 * @property {boolean} [publicWrite=false] - Whether the folder is publicly writable.
 */

// Legacy type aliases for backward compatibility
/**
 * @typedef {FileId} DocId
 * @typedef {FileDescriptor} DocDescriptor
 * @typedef {ClassifiedFile} ClassifiedDoc
 * @typedef {StorageCoreOptions} YjsDocManagerOptions
 */

export { };
