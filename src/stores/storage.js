/**
 * Central Storage Instance for Scriptorium App
 *
 * Singleton FileRegistry instance configured for the scriptorium app.
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

const APP_NAME = 'scriptorium';
const BASE_URL = 'https://instrumenta.cf/api/storage.php';
const WS_URL = 'wss://instrumenta.cf/congruum/';
const BLOB_URL = 'https://instrumenta.cf/api/blob-storage.php';

export const storage = createSvelteRegistry({
    appName: APP_NAME,
    baseUrl: BASE_URL,
    blobUrl: BLOB_URL,
    wsUrl: WS_URL,
    // Auth: uses dev API key if set (localStorage), otherwise falls back to session cookie.
    // StorageAPI sends Bearer header when key is present; browser cookie when null.
    getApiKey: () => authStore.getApiKey(),
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
        sync: () => storage.sync(),
        state: () => console.log(storage.getSyncState()),
        files: () => console.table(storage.drive.listFiles()),
        folders: () => console.table(storage.drive.listFolders()),
        // Dev API key management (paste your API key to authenticate without cookies)
        setApiKey: (key) => authStore.setDevApiKey(key),
        clearApiKey: () => authStore.clearDevApiKey(),
        getApiKey: () => {
            const key = authStore.getApiKey();
            console.log(key ? `API key set: ${key.substring(0, 8)}...` : 'No API key set (using session cookie)');
            return key;
        },
    };
}

export default storage;
