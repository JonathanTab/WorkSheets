import { writable } from 'svelte/store';
import { log } from '../util/log.js';

const AUTH_URL = 'https://instrumenta.cc/api/auth.php';
const USER_CACHE = 'scriptorium:user'; // only stores {username} — not a secret
const DEVICE_TOKEN = 'scriptorium:device_token';
const DEV_API_KEY = 'scriptorium:dev_api_key'; // dev-only API key for testing
const APP_NAME = 'Scriptorium';

/**
 * Auth store for an app that runs both as a browser tab and as an installed PWA.
 *
 * Two credentials, one code path:
 *
 *   - The `session_token` cookie is the primary credential. It is httpOnly, so
 *     JS never sees it, and in a browser tab it is the only thing needed.
 *   - A *device token* is a named, revocable, per-install credential sent as a
 *     Bearer. It exists because an installed PWA often cannot see the cookies
 *     set in the browser that installed it.
 *
 * Which one applies is decided by capability, never by display-mode. A
 * standalone check is unreliable — an installed PWA can open links in a tab,
 * and the flag can change at runtime — and it asks the wrong question anyway.
 * The real question is "does my cookie reach the server", and the only honest
 * way to know is to try. So: probe with the cookie, fall back to the Bearer,
 * and only mint a device token once the cookie has actually been shown to fail.
 *
 * That ordering matters for security. In a browser tab the httpOnly cookie
 * already works, and a device token would be a second, weaker, longer-lived
 * credential sitting in localStorage where any script on the origin can read
 * it. We do not hold a credential we do not need.
 *
 * This replaces an older scheme that fetched the account's permanent `api_key`
 * and kept that in localStorage — the same exposure, but non-revocable and
 * valid for every app on the site.
 */
function createAuthStore() {
    /** @type {import('svelte/store').Writable<{
     *   user:      {username: string} | null,
     *   isLoading: boolean,
     *   error:     string | null,
     *   apiKey:    string | null,
     * }>} */
    const { subscribe, set, update } = writable({
        user: null,
        isLoading: false,
        error: null,
        apiKey: null, // device token when one is in use, else null
    });

    const browser = typeof window !== 'undefined';
    let messageListener = null;

    // ------------------------------------------------------------------
    // Device token storage
    // ------------------------------------------------------------------

    function readDeviceToken() {
        if (!browser) return null;
        try { return localStorage.getItem(DEVICE_TOKEN) || null; } catch { return null; }
    }

    /**
     * Persist the device token, and mirror it into a cookie.
     *
     * The cookie is what makes `<img src>` and `<video src>` work: subresource
     * requests cannot carry an Authorization header, and the previous answer —
     * appending ?apikey= to the URL — leaked a long-lived credential into
     * access logs, browser history and Referer headers. The cookie is no more
     * exposed than the localStorage copy beside it, and the server only accepts
     * device-kind tokens from it.
     */
    function writeDeviceToken(token) {
        if (!browser) return;
        try {
            if (token) localStorage.setItem(DEVICE_TOKEN, token);
            else localStorage.removeItem(DEVICE_TOKEN);
        } catch { /* storage disabled */ }

        try {
            const secure = location.protocol === 'https:' ? '; Secure' : '';
            document.cookie = token
                ? `device_token=${token}; Path=/; Max-Age=${60 * 60 * 24 * 180}; SameSite=Lax${secure}`
                : `device_token=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
        } catch { /* cookies disabled */ }
    }

    /**
     * Returns the Bearer credential for API calls, or null to rely on the
     * session cookie. FileRegistry / StorageAPI / YjsServerAPI all take this
     * as their `getApiKey` callback, so returning the device token here is what
     * wires it through to every request and the realtime socket.
     */
    function getApiKey() {
        if (!browser) return null;
        try {
            const dev = localStorage.getItem(DEV_API_KEY);
            if (dev) return dev;
        } catch { /* storage disabled */ }
        return readDeviceToken();
    }

    // ------------------------------------------------------------------
    // Probes
    // ------------------------------------------------------------------

    /**
     * Ask the server who we are.
     * @param {string|null} bearer Send this as a Bearer, or null for cookie-only.
     * @returns {Promise<string|null|false>} username, null if rejected,
     *          or false if the request could not be completed at all.
     */
    async function whoAmI(bearer) {
        try {
            const res = await fetch(`${AUTH_URL}?action=get_current_user`, {
                credentials: 'same-origin',
                headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
            });
            if (res.ok) {
                const data = await res.json();
                return data?.username ?? null;
            }
            if (res.status === 401) return null;
            return false; // 5xx — server trouble, not an auth answer
        } catch {
            return false; // offline / DNS failure
        }
    }

    function signedIn(username) {
        const apiKey = readDeviceToken();
        set({ user: { username }, isLoading: false, error: null, apiKey });
        try { localStorage.setItem(USER_CACHE, JSON.stringify({ username })); } catch { /* ignore */ }
        return true;
    }

    function signedOut() {
        set({ user: null, isLoading: false, error: null, apiKey: null });
        try { localStorage.removeItem(USER_CACHE); } catch { /* ignore */ }
    }

    /**
     * Establish who we are, cookie first then device token.
     *
     * Only clears cached state when the server actually says "no". A network
     * failure leaves the cached identity alone, so going offline does not look
     * like being logged out.
     */
    async function trySessionAuth() {
        const byCookie = await whoAmI(null);
        if (typeof byCookie === 'string') return signedIn(byCookie);

        const device = readDeviceToken();
        if (device) {
            const byDevice = await whoAmI(device);
            if (typeof byDevice === 'string') return signedIn(byDevice);
            if (byDevice === null) {
                // The server rejected it — revoked, expired, or the account is
                // gone. Drop it so we stop sending a dead credential.
                writeDeviceToken(null);
            }
        }

        // Distinguish "server said no" from "could not ask".
        if (byCookie === null) signedOut();
        return false;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Offline-first init. Paints from the cached username immediately so the
     * UI and IndexedDB data are available without waiting on the network, then
     * revalidates in the background when online.
     *
     * @returns {Promise<boolean>} true if a user was found (cached or live)
     */
    async function initOffline() {
        if (!browser) return false;

        let cached = null;
        try {
            const raw = localStorage.getItem(USER_CACHE);
            if (raw) cached = JSON.parse(raw);
        } catch { /* parse error */ }

        if (cached?.username) {
            set({
                user: { username: cached.username },
                isLoading: false,
                error: null,
                apiKey: readDeviceToken(),
            });
            if (navigator.onLine) trySessionAuth();
            return true;
        }

        if (navigator.onLine) return trySessionAuth();

        signedOut();
        return false;
    }

    // ------------------------------------------------------------------
    // Login / Logout
    // ------------------------------------------------------------------

    if (browser) {
        messageListener = async (event) => {
            if (event.origin !== 'https://instrumenta.cc') return;
            if (event.data?.type !== 'AUTH_SUCCESS') return;

            const offered = event.data.deviceToken || null;

            // The popup always offers a device token, but we keep it only if
            // the cookie genuinely does not work here. If it does, hand the
            // token straight back rather than leaving an unused long-lived
            // credential lying around.
            const byCookie = await whoAmI(null);
            if (typeof byCookie === 'string') {
                if (offered) revokeToken(offered);
                signedIn(byCookie);
                return;
            }

            if (offered) {
                writeDeviceToken(offered);
                const byDevice = await whoAmI(offered);
                if (typeof byDevice === 'string') {
                    signedIn(byDevice);
                    return;
                }
                writeDeviceToken(null);
            }

            update(s => ({ ...s, isLoading: false, error: 'Sign-in did not complete.' }));
        };
        window.addEventListener('message', messageListener);
    }

    /** Best-effort revoke of a token we decided not to keep. */
    async function revokeToken(token) {
        try {
            await fetch(`${AUTH_URL}?action=revoke_session`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: token.slice(0, 12) }),
            });
        } catch { /* best effort — an unused token is visible and revocable in the account UI */ }
    }

    /**
     * Sign in. Checks for an existing session first, and only opens the popup
     * if there genuinely isn't one.
     */
    async function login() {
        update(s => ({ ...s, isLoading: true, error: null }));

        // Open the popup before any await — browsers block popups opened after
        // an async gap. It asks for a device token; we decide later whether to
        // keep it.
        const popup = window.open(
            `https://instrumenta.cc/mobilelogin.php?device=1&device_name=${encodeURIComponent(APP_NAME)}`,
            'instrumenta-auth',
            'width=400,height=580,scrollbars=yes,resizable=yes'
        );

        const ok = await trySessionAuth();
        if (ok) {
            if (popup) popup.close();
            return;
        }

        update(s => ({ ...s, isLoading: false }));

        if (!popup) {
            update(s => ({ ...s, error: 'Popup blocked. Please allow popups for this site.' }));
        }
    }

    async function logout() {
        try {
            const { cleanupSpreadsheet } = await import('./spreadsheetStore.svelte.js');
            cleanupSpreadsheet();
        } catch { /* ignore */ }

        const device = readDeviceToken();

        // Sending the device token as a Bearer tells the server to revoke this
        // install specifically; other devices are unaffected.
        try {
            await fetch(`${AUTH_URL}?action=logout`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    ...(device ? { Authorization: `Bearer ${device}` } : {}),
                },
                body: '{}',
            });
        } catch { /* ignore network errors on logout */ }

        writeDeviceToken(null);
        signedOut();
    }

    // ------------------------------------------------------------------
    // Dev helpers
    // ------------------------------------------------------------------

    /**
     * Set a dev API key for authentication (development only).
     * Takes precedence over the device token in getApiKey().
     */
    function setDevApiKey(key) {
        if (!browser) return;
        try {
            if (key) {
                localStorage.setItem(DEV_API_KEY, key);
                log.debug('[dev] API key set. Reload to use Bearer token auth.');
            } else {
                localStorage.removeItem(DEV_API_KEY);
                log.debug('[dev] API key cleared. Reload to use session auth.');
            }
        } catch {
            console.error('[dev] Failed to access localStorage');
        }
    }

    function clearDevApiKey() { setDevApiKey(null); }

    /** @deprecated Use trySessionAuth() directly. */
    async function checkIfLoggedIn() { return trySessionAuth(); }

    function destroy() {
        if (browser && messageListener) {
            window.removeEventListener('message', messageListener);
            messageListener = null;
        }
    }

    return {
        subscribe,
        init: initOffline, // called as init() by App.svelte
        initOffline,
        trySessionAuth,
        checkIfLoggedIn,
        login,
        logout,
        setDevApiKey,
        clearDevApiKey,
        getApiKey,
        destroy,
    };
}

export const authStore = createAuthStore();
