/**
 * @fileoverview Yjs File Manager - Main exports
 *
 * This module provides a comprehensive file management system with:
 * - Real-time collaboration via Yjs
 * - Offline-first storage with IndexedDB
 * - Folder hierarchy for file organization
 * - Blob storage for binary files
 * - Sharing and permissions
 * - Schema versioning and migrations
 *
 * ## Quick Start
 *
 * ```javascript
 * import { Storage } from '@lib/yjs-manager';
 *
 * const storage = new Storage({
 *   appName: 'my-app',
 *   schemaVersion: '1',
 *   schemas: [
 *     { version: '1', initialize: (doc) => doc.getMap('data') }
 *   ],
 *   baseUrl: '/api/congruum-doc-manager.php',
 *   wsUrl: 'wss://yjs.example.com',
 *   blobStorageUrl: '/api/blob-storage.php',
 *   getApiKey: () => localStorage.getItem('apiKey'),
 *   getUsername: () => 'alice'
 * });
 *
 * await storage.init();
 *
 * // App-scoped files (settings, preferences, etc.)
 * // File IDs are always server-generated - use title for human-readable names
 * const file = await storage.app.createFile({ title: 'My Settings' });
 * const ydoc = await storage.app.load(file.id);
 *
 * // Drive files (user files)
 * const doc = await storage.drive.createFile({ title: 'My Document' });
 * const ydoc = await storage.drive.loadFile(doc.id);
 *
 * // Reactive Svelte stores
 * $: appFiles = $storage.app.files;
 * $: driveFiles = $storage.drive.files;
 * $: driveFolders = $storage.drive.folders;
 * ```
 *
 * ## Architecture
 *
 * - **Storage**: High-level facade for app and drive storage with reactive Svelte stores
 * - **StorageCore**: Central orchestrator for the storage ecosystem
 * - **FileAPI**: REST API adapter for server communication
 * - **FileIndex/FolderIndex**: In-memory search indices with classification
 * - **UnifiedStore**: Single IndexedDB for atomic file and folder operations
 * - **YjsRuntime**: Y.Doc lifecycle management
 * - **SchemaManager**: Schema versioning and migrations
 *
 * ## Terminology
 *
 * This system uses "File" terminology (replacing the old "Document" terminology):
 * - **File**: Any stored item (Yjs collaborative document or binary blob)
 * - **Folder**: A container for files and subfolders (drive scope only)
 * - **App-scoped**: Files isolated to a specific application
 * - **Drive-scoped**: Files organized in folders, visible in user's drive
 */

// Main facade
export { Storage } from './Storage.js';

// Core components (for advanced usage)
export { StorageCore } from './core/StorageCore.js';
export { FileAPI } from './api/FileAPI.js';
export { FileIndex } from './core/FileIndex.js';
export { FolderIndex } from './core/FolderIndex.js';
export { UnifiedStore } from './core/UnifiedStore.js';
export { YjsRuntime } from './core/YjsRuntime.js';
export { SchemaManager } from './core/SchemaManager.js';

// Legacy exports for backward compatibility
export { StorageCore as DocManager } from './core/StorageCore.js';
export { FileAPI as DocManagerAPI } from './api/FileAPI.js';
export { FileIndex as DocIndex } from './core/FileIndex.js';

// Re-export types for TypeScript users
export * from './types.js';
