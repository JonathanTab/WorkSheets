/**
 * Central Storage Instance for WorkSheets App
 *
 * Singleton FileRegistry instance configured for the worksheets app.
 * Uses createSvelteRegistry so drive/app stores are reactive Svelte stores.
 *
 * After calling `await storage.init()`:
 *   $storage.drive.files   — reactive list of drive files
 *   $storage.drive.folders — reactive list of folders
 *   $storage.drive.root    — { files, folders } at root
 *   $storage.drive.shared  — { files, folders } shared with me
 *   $storage.app.files     — reactive list of app-scoped files
 *   $storage.ready         — becomes true after init completes
 */

import { writable, get } from 'svelte/store';
import { createSvelteRegistry } from '../lib/FileRegistry/svelte/index.js';
import { authStore } from './authStore.js';

const APP_NAME = 'worksheets';
const BASE_URL = 'https://instrumenta.cf/api/storage.php';
const WS_URL   = 'wss://instrumenta.cf/congruum/';
const BLOB_URL = 'https://instrumenta.cf/api/blob-storage.php';

export const storage = createSvelteRegistry({
    appName:     APP_NAME,
    baseUrl:     BASE_URL,
    blobUrl:     BLOB_URL,
    wsUrl:       WS_URL,
    // Session-cookie auth: getApiKey always returns null.
    // StorageAPI sends no Bearer header; the browser cookie handles auth.
    getApiKey:   () => null,
    getUsername: () => get(authStore).user?.username ?? 'anonymous',
});

// Add a `ready` store that becomes true once init() completes.
const _ready = writable(false);
storage.ready = { subscribe: _ready.subscribe };

const _patchedInit = storage.init.bind(storage);
storage.init = async function () {
    const result = await _patchedInit();
    _ready.set(true);
    return result;
};

// Expose lightweight debug helpers in dev.
if (typeof window !== 'undefined') {
    /** @type {any} */ (window).storageDebug = {
        sync:   () => storage.sync(),
        state:  () => console.log(storage.getSyncState()),
        files:  () => console.table(storage.drive.listFiles()),
        folders:() => console.table(storage.drive.listFolders()),
    };
}

export default storage;
