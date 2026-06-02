import { SCHEMA_VERSION } from '../stores/spreadsheet/constants.js';

const VERSION_URL = import.meta.env.BASE_URL + 'schema-version.json';
const CHECK_TIMEOUT_MS = 5000;

/**
 * Fetches the server's minimum required schema version and compares it against
 * this client's bundled SCHEMA_VERSION. Returns false if the client is stale.
 *
 * Fail policy:
 *   - Network errors, timeouts, non-2xx HTTP responses → fail OPEN (return true).
 *     Server is genuinely unreachable; blocking would leave the user with no app.
 *   - Successful response with malformed or missing payload → fail CLOSED
 *     (return false). The deployment is misconfigured and we'd rather force a
 *     reload than let an out-of-date client write to docs.
 */
export async function checkSchemaVersion() {
    let res;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

        res = await fetch(VERSION_URL, {
            cache: 'no-store',
            signal: controller.signal,
        });
        clearTimeout(timeout);
    } catch {
        return true; // network / timeout — fail open
    }

    if (!res.ok) return true; // 4xx/5xx — fail open

    // From here on we successfully reached the server; treat malformed payloads
    // as a hard fail so misconfigured deployments don't silently let stale
    // clients corrupt newer docs.
    let payload;
    try {
        payload = await res.json();
    } catch {
        console.warn('[schemaVersionGuard] schema-version.json was not valid JSON — failing closed');
        return false;
    }

    const minRaw = payload?.minSchemaVersion;
    const min = typeof minRaw === 'number' ? minRaw
              : typeof minRaw === 'string' && /^\d+$/.test(minRaw) ? parseInt(minRaw)
              : null;
    if (min == null) {
        console.warn('[schemaVersionGuard] minSchemaVersion missing or unparseable — failing closed');
        return false;
    }

    return parseInt(SCHEMA_VERSION) >= min;
}

/**
 * Triggers an immediate service worker update (if one is available) then
 * reloads the page. Waits up to 4s for the new SW to take control before
 * falling back to a plain reload.
 *
 * Because workbox is configured with skipWaiting + clientsClaim, a new SW
 * activates as soon as it installs, so the reload always picks up fresh code.
 */
export async function forceUpdate() {
    if (!('serviceWorker' in navigator)) {
        window.location.reload();
        return;
    }

    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
            // Listen for controller change (new SW took over) then reload.
            // This fires automatically because skipWaiting is set in the workbox config.
            let reloaded = false;
            const doReload = () => {
                if (!reloaded) { reloaded = true; window.location.reload(); }
            };

            navigator.serviceWorker.addEventListener('controllerchange', doReload);

            // Trigger the update check; if a new SW is found it will install
            // and immediately skip waiting, firing controllerchange above.
            await reg.update();

            // Fallback: if controllerchange hasn't fired within 4s, reload anyway.
            // The new SW may already be active and the event already dispatched.
            setTimeout(doReload, 4000);
            return;
        }
    } catch { /* ignore */ }

    window.location.reload();
}
