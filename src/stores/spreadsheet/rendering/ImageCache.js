/**
 * ImageCache - In-memory cache for HTMLImageElement objects used by the canvas renderer.
 *
 * Since canvas painting is synchronous, images must be pre-loaded before paint time.
 * This module loads images on demand and notifies a callback when loading completes,
 * triggering a canvas re-render to display the loaded image.
 *
 * Usage:
 *   setOnLoadCallback(() => renderScheduler.invalidateAll());
 *   const entry = loadImage(blobId, url);
 *   // entry.status: 'loading' | 'loaded' | 'error'
 *   // entry.img:    HTMLImageElement when status === 'loaded'
 */

/**
 * @typedef {{ img: HTMLImageElement|null, status: 'loading'|'loaded'|'error', url: string }} ImageEntry
 */

/** @type {Map<string, ImageEntry>} */
const cache = new Map();

/** @type {Function|null} */
let onLoadCallback = null;

/**
 * Register a callback invoked when any image finishes loading (or errors).
 * Use this to trigger a canvas re-render.
 * @param {Function|null} cb
 */
export function setOnLoadCallback(cb) {
    onLoadCallback = cb;
}

/**
 * Get the cached entry for a blob ID without starting a load.
 * Returns null if not in cache.
 * @param {string} blobId
 * @returns {ImageEntry|null}
 */
export function getImage(blobId) {
    return cache.get(blobId) ?? null;
}

/**
 * Get or start loading an image for a given blob ID.
 * If already loading or loaded, returns the existing entry.
 * If the URL has changed (e.g. after re-upload), re-fetches.
 *
 * @param {string} blobId
 * @param {string} url  - Authenticated download URL
 * @returns {ImageEntry}
 */
export function loadImage(blobId, url) {
    const existing = cache.get(blobId);
    if (existing && existing.url === url && existing.status !== 'error') {
        return existing;
    }

    const entry = /** @type {ImageEntry} */ ({ img: null, status: 'loading', url });
    cache.set(blobId, entry);

    const img = new Image();
    img.onload = () => {
        entry.img = img;
        entry.status = 'loaded';
        onLoadCallback?.();
    };
    img.onerror = () => {
        entry.status = 'error';
        onLoadCallback?.();
    };
    img.src = url;

    return entry;
}

/**
 * Remove a cached entry so it will be re-fetched on next paint.
 * Call after uploading a new version of an image.
 * @param {string} blobId
 */
export function invalidateImage(blobId) {
    cache.delete(blobId);
}

/**
 * Clear the entire image cache (e.g. on document close).
 */
export function clearImageCache() {
    cache.clear();
}
