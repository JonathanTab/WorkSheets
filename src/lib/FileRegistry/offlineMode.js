/**
 * Offline mode preference, Yjs IndexedDB cleanup, and service worker registration.
 *
 * Offline mode controls whether Yjs documents are persisted to IndexedDB for
 * offline editing, and whether the PWA service worker is installed at all. When
 * disabled (default), no local Yjs copies are created, no service worker caches
 * app assets, and the app always loads fresh from the network.
 *
 * The preference is stored in localStorage so it persists across page loads.
 * Changing the setting requires a page reload to take effect.
 *
 * When offline mode is disabled, any Yjs IndexedDB databases previously created
 * are tracked by room ID and deleted automatically on the next startup. Likewise,
 * any previously-registered service worker and its caches are torn down.
 */

const OFFLINE_MODE_KEY = 'scriptorium_offline_mode';
const YJS_ROOMS_KEY = 'scriptorium_yjs_rooms';
// docId → roomId last successfully opened on this device. Used to detect
// snapshot restores that rotated the room while we weren't connected.
const LAST_OPENED_ROOM_KEY = 'scriptorium_last_opened_room';

/** Returns true if offline mode (Yjs IndexedDB persistence) is enabled. Default: false. */
export function getOfflineMode() {
    try {
        return localStorage.getItem(OFFLINE_MODE_KEY) === 'true';
    } catch {
        return false;
    }
}

/** Saves the offline mode preference to localStorage. Requires page reload to take effect. */
export function setOfflineMode(enabled) {
    try {
        localStorage.setItem(OFFLINE_MODE_KEY, enabled ? 'true' : 'false');
    } catch {}
}

/**
 * Records a room ID whose Yjs IndexedDB database was created.
 * Called by YjsRuntime when offline mode is on so cleanup knows what to remove.
 */
export function trackYjsRoom(roomId) {
    try {
        const rooms = _getTrackedRooms();
        rooms.add(roomId);
        localStorage.setItem(YJS_ROOMS_KEY, JSON.stringify([...rooms]));
    } catch {}
}

function _getTrackedRooms() {
    try {
        const raw = localStorage.getItem(YJS_ROOMS_KEY);
        if (!raw) return new Set();
        return new Set(JSON.parse(raw));
    } catch {
        return new Set();
    }
}

/**
 * Deletes all tracked Yjs IndexedDB databases and clears the tracking list.
 * Should be called on startup when offline mode is disabled so stale Yjs data
 * left from a previous offline-mode session is removed from the browser.
 *
 * Safe to call when there is nothing to clean up (no-op).
 */
export async function clearYjsPersistenceData() {
    const rooms = _getTrackedRooms();
    if (rooms.size === 0) return;

    await Promise.all([...rooms].map(roomId => new Promise((resolve) => {
        try {
            const req = indexedDB.deleteDatabase(roomId);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
        } catch {
            resolve();
        }
    })));

    try {
        localStorage.removeItem(YJS_ROOMS_KEY);
    } catch {}
}

/**
 * Read the docId→roomId map of last-known rooms. Returns null on any
 * read/parse error so callers degrade gracefully (no rotation detection).
 * @returns {Record<string, string>|null}
 */
function _readLastOpenedMap() {
    try {
        const raw = localStorage.getItem(LAST_OPENED_ROOM_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return null; }
}

/**
 * Return the roomId this device last successfully opened for `docId`, or
 * null if we've never opened it (or storage is unreadable).
 * @param {string} docId
 * @returns {string|null}
 */
export function getLastOpenedRoom(docId) {
    const map = _readLastOpenedMap();
    return map?.[docId] ?? null;
}

/**
 * Record that this device opened `docId` under `roomId`. Should be called
 * after a successful load completes (not just after the connection is made).
 * @param {string} docId
 * @param {string} roomId
 */
export function recordOpenedRoom(docId, roomId) {
    const map = _readLastOpenedMap();
    if (!map) return;
    if (map[docId] === roomId) return;
    map[docId] = roomId;
    try {
        localStorage.setItem(LAST_OPENED_ROOM_KEY, JSON.stringify(map));
    } catch { /* quota / private mode — ignore */ }
}

/**
 * Forget the recorded room for `docId`. Used after a rotation has been
 * processed (offline edits dropped or replayed) so the next load doesn't
 * re-trigger the rotation handling.
 * @param {string} docId
 */
export function forgetOpenedRoom(docId) {
    const map = _readLastOpenedMap();
    if (!map || !(docId in map)) return;
    delete map[docId];
    try {
        localStorage.setItem(LAST_OPENED_ROOM_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
}

/**
 * Registers the PWA service worker if offline mode is enabled, or tears down
 * any existing registration and its caches if not. Call once on app startup
 * (after that, toggling offline mode requires a reload, same as Yjs persistence).
 *
 * Service worker caching only ever happens when offline mode is on — with it
 * off, the app always fetches fresh from the network instead of a cached copy.
 */
export async function syncServiceWorkerRegistration() {
    if (!('serviceWorker' in navigator)) return;

    if (getOfflineMode() && import.meta.env.PROD) {
        try {
            const { registerSW } = await import('virtual:pwa-register');
            registerSW({ immediate: true });
        } catch { /* ignore */ }
        return;
    }

    try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
    } catch { /* ignore */ }

    try {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
    } catch { /* ignore */ }
}
