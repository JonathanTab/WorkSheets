/**
 * horamStorage — a FileRegistry instance scoped to the "horam" app.
 *
 * Created lazily on first use so it doesn't connect until the plugin is activated.
 * Uses the same backend and auth as scriptorium's own storage.
 */

import { createSvelteRegistry } from '../../../../lib/FileRegistry/svelte/index.js';
import { authStore } from '../../../authStore.js';
import { get } from 'svelte/store';

const BASE_URL = 'https://instrumenta.cc/api/storage.php';
const WS_URL   = 'wss://instrumenta.cc/congruum/';
const BLOB_URL  = 'https://instrumenta.cc/api/blob-storage.php';

let _registry = null;
let _initPromise = null;

export function getHoramStorage() {
    if (!_registry) {
        _registry = createSvelteRegistry({
            appName:     'horam',
            baseUrl:     BASE_URL,
            blobUrl:     BLOB_URL,
            wsUrl:       WS_URL,
            getApiKey:   () => authStore.getApiKey?.() ?? null,
            getUsername: () => get(authStore).user?.username ?? 'anonymous',
        });
    }
    return _registry;
}

/** Initialize (or return cached init) the horam registry. */
export async function initHoramStorage() {
    const reg = getHoramStorage();
    if (!_initPromise) {
        _initPromise = reg.init();
    }
    return _initPromise;
}

/** List all horam app-scoped files accessible to the current user. */
export async function listHoramDocs() {
    await initHoramStorage();
    return getHoramStorage().app.list();
}

/** Load a horam Yjs doc by file ID. */
export async function loadHoramDoc(docId) {
    await initHoramStorage();
    return getHoramStorage().app.loadDoc(docId);
}
