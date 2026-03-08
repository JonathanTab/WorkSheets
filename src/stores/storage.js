/**
 * Central Storage Instance for WorkSheets App
 *
 * This module provides a singleton Storage instance configured for the
 * worksheets spreadsheet application. All document metadata access and
 * mutation goes through this facade.
 *
 * ## Usage
 *
 * ```javascript
 * import { storage } from './stores/storage.js';
 *
 * // Initialize on app startup
 * await storage.init();
 *
 * // Access drive files (reactive)
 * $: files = $storage.drive.files;
 *
 * // Create a new document
 * const doc = await storage.drive.createFile({ title: 'My Spreadsheet' });
 *
 * // Load for editing
 * const ydoc = await storage.drive.loadFile(doc.id);
 * ```
 */

import { get } from 'svelte/store';
import { Storage } from '../lib/yjs-manager/index.js';
import { authStore } from './authStore.js';
import { spreadsheetSchema } from './spreadsheet/schema.js';
import { SCHEMA_VERSION } from './spreadsheet/constants.js';

// Constants
const APP_NAME = 'worksheets';
const BASE_URL = 'https://instrumenta.cf/api/drive.php';
const WS_URL = 'wss://instrumenta.cf/congruum/';
const BLOB_STORAGE_URL = 'https://instrumenta.cf/api/blob-storage.php';

/**
 * Singleton Storage instance for the worksheets app.
 *
 * Provides:
 * - `storage.drive` - User files organized in folders
 * - `storage.app` - App-scoped files (settings, preferences)
 *
 * After calling `storage.init()`, the reactive stores are available:
 * - `$storage.drive.files` - All drive files
 * - `$storage.drive.folders` - All folders
 */
export const storage = new Storage({
    appName: APP_NAME,
    schemaVersion: SCHEMA_VERSION,
    schemas: [spreadsheetSchema],
    baseUrl: BASE_URL,
    wsUrl: WS_URL,
    blobStorageUrl: BLOB_STORAGE_URL,
    getApiKey: () => get(authStore).apiKey,
    getUsername: () => get(authStore).user?.username
});

// Expose debug utilities on window for console access
if (typeof window !== 'undefined') {
    window.storageDebug = {
        /**
         * Toggle debug mode on/off
         */
        toggle: () => {
            if (storage._core) {
                storage.setDebug(!storage.core.debug);
            } else {
                console.warn('[storageDebug] Storage not initialized yet');
            }
        },

        /**
         * Enable debug mode
         */
        on: () => {
            if (storage._core) {
                storage.setDebug(true);
            } else {
                console.warn('[storageDebug] Storage not initialized yet');
            }
        },

        /**
         * Disable debug mode
         */
        off: () => {
            if (storage._core) {
                storage.setDebug(false);
            } else {
                console.warn('[storageDebug] Storage not initialized yet');
            }
        },

        /**
         * Dump storage contents to console
         */
        dump: () => {
            if (storage._core) {
                return storage.dumpStorage();
            } else {
                console.warn('[storageDebug] Storage not initialized yet');
                return null;
            }
        },

        /**
         * Show debug status
         */
        status: () => {
            if (storage._core) {
                console.log('Debug mode:', storage.core.debug);
                console.log('Sync state:', storage.core.getSyncState());
            } else {
                console.warn('[storageDebug] Storage not initialized yet');
            }
        }
    };

    console.log('[Storage] Debug utilities available at window.storageDebug');
    console.log('  storageDebug.toggle() - Toggle debug mode');
    console.log('  storageDebug.on()     - Enable debug mode');
    console.log('  storageDebug.off()    - Disable debug mode');
    console.log('  storageDebug.dump()   - Dump storage contents');
    console.log('  storageDebug.status() - Show debug status');
}

export default storage;
