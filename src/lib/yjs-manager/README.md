# Yjs File Manager v2.6

A robust, offline-first orchestration layer for managing collaborative [Yjs](https://yjs.dev/) files with **two-branch storage**, versioned schemas, folder hierarchy, blob storage, file attachments, public access, and server-side metadata synchronization.

## What's New in v2.6

This release enforces automatic server-generated file IDs across the entire system:

- **File IDs are always server-generated**: Clients can no longer set their own IDs - this ensures consistent ID generation and prevents collisions
- **Titles are user-facing names**: Use `title` for human-readable file names, not IDs
- **App storage is file storage**: App-scoped files follow the same pattern as drive files (namespaced, no folders)
- **Consistent API patterns**: Both `app` and `drive` use the same `createFile(options)` pattern

## What's New in v2.5

- **"File" Terminology**: All client APIs now use "File" instead of "Document" (server still uses "document" internally)
- **Unified IndexedDB**: Single database for files and folders with atomic operations
- **Reactive Svelte Stores**: Full Svelte 5 runes integration for automatic UI updates
- **Automatic Migration**: Seamless migration from legacy `yjs_doc_manager_*` databases

## Quick Start

```javascript
import { Storage } from './lib/yjs-manager';

const storage = new Storage({
    appName: 'my-app',
    schemaVersion: '2.0',
    baseUrl: '/api/congruum-doc-manager.php',
    wsUrl: 'wss://yjs-server.com',
    blobStorageUrl: '/api/blob-storage.php',
    schemas: [
        {
            version: '2.0',
            initialize: (ydoc) => {
                ydoc.getMap('data');
            }
        }
    ],
    getApiKey: () => localStorage.getItem('api_key'),
    getUsername: () => localStorage.getItem('username')
});

await storage.init();
```

## File IDs vs Titles

**Important**: File IDs are always server-generated opaque identifiers. Clients must never set their own IDs.

| Concept | Description | Example |
|---------|-------------|---------|
| **File ID** | Server-generated, stable, opaque identifier | `appname_abc123`, `xyz789` |
| **Title** | User-facing, human-readable name | `"My Settings"`, `"Budget 2024"` |

```javascript
// ✅ Correct: Use title for human-readable names
const file = await storage.app.createFile({ title: 'My Settings' });
console.log(file.id);    // Server-generated: "my-app_abc123"
console.log(file.title); // "My Settings"

// ❌ Wrong: Don't try to set your own ID
// This is no longer supported - IDs are always server-generated
```

## Two-Branch Storage System

### App-Scoped Storage (`storage.app`)

App-scoped files are isolated by app name and ideal for:
- Application settings and preferences
- Cache data and session state
- Files internal to the app
- Files that shouldn't appear in the user's drive

**Important**: App storage is NOT a key-value store. It's namespaced file storage without folder hierarchy. Both `app` and `drive` follow the same file storage pattern.

```javascript
// Create an app file
const file = await storage.app.createFile({ title: 'My Settings' });

// Get a file by ID
const settings = storage.app.get(file.id);

// List all app files
const appFiles = storage.app.list();

// Load for real-time editing
const ydoc = await storage.app.load(file.id);
const data = ydoc.getMap('data');
data.set('theme', 'dark');

// Rename
await storage.app.renameFile(file.id, 'New Title');

// Delete
await storage.app.delete(file.id);

// Share an app file with another user
await storage.app.share(file.id, 'username', ['read', 'write']);

// Revoke access
await storage.app.revoke(file.id, 'username');

// Make an app file publicly accessible
await storage.app.setPublic(file.id, true, false);

// Query app files
const shared = storage.app.getShared();  // Shared with me
const public = storage.app.getPublic();   // Publicly accessible
const owned = storage.app.getOwned();     // Owned by me
```

### Drive Storage (`storage.drive`)

Drive files are user-facing files organized in folders:
- User-created files and uploaded files
- Shared files and folders
- Hierarchical organization with full folder tree support

```javascript
// Create a file
const file = await storage.drive.createFile({
    title: 'My Document',
    folderId: 'folder_123',
    publicRead: false
});

// List files
const allFiles = storage.drive.listFiles();
const folderFiles = storage.drive.listFiles({ folderId: 'folder_123' });
const myFiles = storage.drive.listFiles({ owned: true });
const sharedFiles = storage.drive.listFiles({ shared: true });

// Load for editing
const ydoc = await storage.drive.loadFile(file.id);

// Rename, move, delete
await storage.drive.renameFile(file.id, 'New Title');
await storage.drive.moveFile(file.id, 'new_folder_id');
await storage.drive.deleteFile(file.id);

// Sharing
await storage.drive.shareFile(file.id, 'username', ['read', 'write']);
await storage.drive.revokeFile(file.id, 'username');
```

## API Comparison: App vs Drive

Both `app` and `drive` follow the same file storage pattern:

| Operation | App (`storage.app`) | Drive (`storage.drive`) |
|-----------|---------------------|-------------------------|
| **Create file** | `createFile({ title })` | `createFile({ title, folderId })` |
| **Get file** | `get(fileId)` | `getFile(fileId)` |
| **List files** | `list()` | `listFiles({ folderId })` |
| **Load Yjs** | `load(fileId)` | `loadFile(fileId)` |
| **Rename** | `renameFile(fileId, title)` | `renameFile(fileId, title)` |
| **Delete** | `delete(fileId)` | `deleteFile(fileId)` |
| **Share** | `share(fileId, user, perms)` | `shareFile(fileId, user, perms)` |
| **Create blob** | `createBlob(title, file, opts)` | `createBlob({ file, title, folderId })` |
| **Create attachment** | `createAttachment({ parentId, title, ... })` | `createAttachment({ parentId, title, ... })` |

Key differences:
- **App files** are namespaced by `appName` and have no folder hierarchy
- **Drive files** support folder organization via `folderId`

## Folder Operations

```javascript
// List folders
const rootFolders = storage.drive.listFolders({ parentId: null });
const childFolders = storage.drive.listFolders({ parentId: 'folder_123' });

// Get folder contents (both folders and files)
const { folders, files } = storage.drive.getFolderContents('folder_123');

// Create a folder
const folder = await storage.drive.createFolder({
    name: 'Projects',
    parentId: null,
    publicRead: false
});

// Rename, move, delete
await storage.drive.renameFolder(folder.id, 'New Name');
await storage.drive.moveFolder(folder.id, 'new_parent_id');
await storage.drive.deleteFolder(folder.id);

// Share folder (grants access to all contents)
await storage.drive.shareFolder(folder.id, 'username', ['read', 'write']);
await storage.drive.revokeFolderShare(folder.id, 'username');
```

## Blob Storage

Binary files (images, PDFs, etc.) are stored separately from Yjs files:

```javascript
// Create a blob file from a File object
const blobFile = await storage.drive.createBlob({
    file: uploadedFile,
    title: 'My Image',
    folderId: 'folder_123',
    publicRead: false,
    publicWrite: false
});

// Get download URL
const url = storage.drive.getBlobUrl(blobFile.id);

// Update blob content
await storage.drive.updateBlob(blobFile.id, newFile);
```

### App-Scoped Blobs

```javascript
// Create an app-scoped blob
const blobFile = await storage.app.createBlob('My Image', uploadedFile, {
    parentId: null,  // Optional: for attachments
    publicRead: false,
    publicWrite: false
});

// Get download URL
const url = storage.app.getBlobUrl(blobFile.id);
```

## File Attachments

Files can have child files (attachments) with inherited permissions:

```javascript
// Get all attachments of a file
const attachments = storage.drive.getAttachments(parentFileId);

// Create an attachment
const attachment = await storage.drive.createAttachment({
    parentId: parentFileId,
    title: 'Related Data',
    type: 'yjs',         // or 'blob' for binary files
    file: uploadedFile   // required for blob type
});
```

### App-Scoped Attachments

```javascript
// Create an attachment for an app file
const image = await storage.app.createAttachment({
    parentId: parentFileId,
    title: 'Photo',
    type: 'blob',
    file: uploadedFile,
    publicRead: true
});

// Get all attachments
const attachments = storage.app.getChildren(parentFileId);
```

## Public Access

Files and folders can be made publicly accessible:

```javascript
// Create a publicly readable file
const file = await storage.drive.createFile({
    title: 'Public Document',
    publicRead: true,   // Anyone can read
    publicWrite: false  // Only owner can write
});

// Create a public folder
const folder = await storage.drive.createFolder({
    name: 'Public Gallery',
    publicRead: true
});

// Update public access on existing items
await storage.drive.setPublic(file.id, 'file', true, false);
await storage.drive.setPublic(folder.id, 'folder', true, true);

// Get public items
const { folders, files } = storage.drive.getPublicItems();
```

### Public Blob Access

Public blobs are accessible without authentication:

```javascript
// Create a public blob
const blobFile = await storage.drive.createBlob({
    file: imageFile,
    title: 'Profile Picture',
    publicRead: true
});

// The URL works without an API key
const publicUrl = storage.drive.getBlobUrl(blobFile.id);
```

## Permission System

### Permission Inheritance

Permissions cascade through the hierarchy:

1. **Folder → Contents**: If a user has access to a folder, they have access to all subfolders and files inside
2. **Parent File → Attachments**: If a user can read a parent file, they can read its attachments
3. **Public Flags**: Folder public flags propagate to all descendants

### Permission Sources

A user's effective permission is the **union** of:

- **Ownership**: The owner has full access
- **Direct Shares**: Explicit shares on the file
- **Folder Shares**: Inherited from folder shares (via closure table)
- **Parent File**: Inherited from parent file permissions
- **Public Flags**: `publicRead` / `publicWrite` on the item

### Checking Permissions

```javascript
const file = storage.drive.getFile(fileId);

if (file.writable) {
    // User can edit
}

if (file.owned) {
    // User is the owner
}

if (file.shared) {
    // File is shared with user
}
```

## Special Views

```javascript
// Items shared with me
const { folders, files } = storage.drive.getSharedWithMe();

// My items (owned)
const { folders, files } = storage.drive.getMyItems();

// Public items
const { folders, files } = storage.drive.getPublicItems();
```

## Events

```javascript
// Subscribe to events
const unsubscribe = storage.on('sync-complete', () => {
    console.log('Sync complete');
});

storage.on('auth-error', () => {
    // Redirect to login
});

// Later: unsubscribe
unsubscribe();
```

### Available Events

| Event | Description |
|-------|-------------|
| `files-ready` | File index loaded/updated |
| `folders-ready` | Folder index loaded/updated |
| `file-ready` | A Y.Doc is fully loaded |
| `file-created` | New file created |
| `file-updated` | File renamed or moved |
| `file-deleted` | File deleted |
| `sync-complete` | Full sync completed |
| `auth-error` | API authentication failed |

## Architecture

### Core Components

| Component | Description |
|-----------|-------------|
| `Storage` | High-level facade with `app` and `drive` interfaces, reactive Svelte stores |
| `StorageCore` | Central orchestrator for storage operations (replaces DocManager) |
| `YjsRuntime` | Manages Y.Doc instances, WebSocket, and IndexedDB persistence |
| `FileIndex` | In-memory searchable file index with permission classification |
| `FolderIndex` | In-memory folder tree with hierarchy traversal |
| `UnifiedStore` | Single IndexedDB for atomic file and folder operations |
| `SchemaManager` | Schema versioning and migration handling |
| `FileAPI` | HTTP adapter for server communication (replaces DocManagerAPI) |

### Legacy Aliases

For backward compatibility:
- `DocManager` → `StorageCore`
- `DocManagerAPI` → `FileAPI`
- `DocIndex` → `FileIndex`

### Key Concepts

#### Stable Logical IDs vs. Room IDs

- **Logical ID**: A stable identifier (e.g., `doc_abc123`) that remains constant across renames and schema migrations
- **Room ID**: The physical Yjs room where data lives; may change when schema versions are updated

#### Offline-First Workflow

1. **Metadata**: Cached in IndexedDB, available instantly on launch
2. **Content**: Cached via `y-indexeddb`; edits work offline
3. **Sync**: Automatic background sync with conflict-free merging via Yjs

## Server API Requirements

The library requires two server endpoints:

### Document Manager (`congruum-doc-manager.php`)

| Action | Method | Description |
|--------|--------|-------------|
| `full_sync` | GET | Returns all accessible files and folders |
| `create` | POST | Create a file |
| `rename` | POST | Rename a file |
| `delete` | POST | Soft-delete a file |
| `restore` | POST | Restore a soft-deleted file |
| `permanent_delete` | POST | Permanently delete a file |
| `move_file` | POST | Move file to different folder |
| `share` / `revoke` | POST | File sharing |
| `set_public_v2` | POST | Unified public access for files and folders |
| `create_folder` | POST | Create a folder |
| `rename_folder` | POST | Rename a folder |
| `delete_folder` | POST | Delete a folder |
| `move_folder` | POST | Move folder to different parent |
| `share_folder` / `revoke_folder_share` | POST | Folder sharing |
| `create_version` | POST | Create new schema version |
| `generate_id` | GET | Generate unique ID |
| `access` | GET | Get file access info |

### Blob Storage (`blob-storage.php`)

| Method | Description |
|--------|-------------|
| `PUT` | Upload file content |
| `GET` | Download file (supports range requests) |
| `GET ?action=info` | Get blob metadata |
| `OPTIONS` | CORS preflight |

#### Public Access Handling

- Files with `publicRead: true` are downloadable without authentication
- Files with `publicWrite: true` accept uploads without authentication
- Rate limiting is applied to unauthenticated requests

## Schema Migrations

When `schemaVersion` is bumped:

1. Detect missing version for file
2. Find previous version to migrate from
3. Create new Room ID on server
4. Copy state from old room to new room
5. Execute custom migration logic

```javascript
const storage = new Storage({
    schemaVersion: '2.0',
    schemas: [
        {
            version: '1.0',
            initialize: (ydoc) => {
                ydoc.getMap('data');
            }
        },
        {
            version: '2.0',
            migrate: async (ydoc) => {
                // Transform data from v1.0 to v2.0
                const data = ydoc.getMap('data');
                const oldFormat = data.get('items');
                if (oldFormat) {
                    // Migrate to new format
                    data.set('items_v2', transform(oldFormat));
                    data.delete('items');
                }
            },
            initialize: (ydoc) => {
                ydoc.getMap('data');
            }
        }
    ]
});
```

## TypeScript Types

Comprehensive JSDoc types are included:

```javascript
/**
 * @typedef {Object} FileDescriptor
 * @property {string} id - Stable logical file ID (server-generated)
 * @property {string} title - Human-readable title
 * @property {'yjs'|'blob'} type
 * @property {'app'|'drive'} scope
 * @property {string|null} folderId - Parent folder (drive scope)
 * @property {string|null} parentId - Parent file (attachments)
 * @property {boolean} publicRead
 * @property {boolean} publicWrite
 * @property {('read'|'write')[]} permissions
 * // ... see types.js for complete definitions
 */

/**
 * @typedef {Object} ClassifiedFile
 * @property {string} id - Stable logical file ID
 * @property {string} title - Human-readable title
 * @property {string} owner - Username of the file owner
 * @property {'yjs'|'blob'} type
 * @property {'app'|'drive'} scope
 * @property {string|null} folderId - Parent folder (drive scope)
 * @property {string|null} parentId - Parent file (attachments)
 * @property {boolean} publicRead
 * @property {boolean} publicWrite
 * @property {('read'|'write')[]} permissions
 * @property {boolean} owned - Current user owns this file
 * @property {boolean} shared - File is shared (with or by user)
 * @property {boolean} writable - Current user can write
 * // ... see types.js for complete definitions
 */
```

## License

MIT
