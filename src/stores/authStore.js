import { writable } from 'svelte/store';

const AUTH_URL = 'https://instrumenta.cf/api/auth.php';
const USER_CACHE = 'worksheets:user'; // only stores {username} — not a secret

/**
 * Session-only auth store for same-origin PWAs.
 *
 * Auth is entirely via the `session_token` httpOnly cookie managed by PHP.
 * JS never sees or stores any credential. localStorage holds only the
 * username string so the UI can render immediately while offline.
 *
 * Session persistence: the `session_token` cookie is rotated on every
 * authenticated request (see iauth.php). As long as the app is used at
 * least once every 30 days while online, the user stays signed in forever.
 *
 * Offline behaviour:
 *   - Cached username is loaded instantly → UI renders, IndexedDB data loads.
 *   - No network calls are made while offline.
 *   - When back online, the session is re-validated in the background.
 *   - If the cookie expired (30-day inactivity), the login screen appears
 *     the next time the user is online.
 *
 * apiKey is always null. FileRegistry / StorageAPI detect this and rely on
 * the browser sending the session cookie automatically (credentials: same-origin).
 */
function createAuthStore() {
    /** @type {import('svelte/store').Writable<{
     *   user:      {username: string} | null,
     *   isLoading: boolean,
     *   error:     string | null,
     *   apiKey:    null,
     * }>} */
    const { subscribe, set, update } = writable({
        user: null,
        isLoading: false,
        error: null,
        apiKey: null, // always null — kept so FileRegistry callers don't break
    });

    const browser = typeof window !== 'undefined';
    let messageListener = null;

    // Listen for the login popup signalling success.
    // The popup is same-origin; the cookie was already set by PHP before
    // postMessage fires, so trySessionAuth() will succeed immediately.
    if (browser) {
        messageListener = (event) => {
            if (event.origin !== 'https://instrumenta.cf') return;
            if (event.data?.type === 'AUTH_SUCCESS') trySessionAuth();
        };
        window.addEventListener('message', messageListener);
    }

    // ------------------------------------------------------------------
    // Core: validate the session cookie
    // ------------------------------------------------------------------

    /**
     * Verify the current session with the server.
     * The browser sends the session cookie automatically — no JS credential.
     * Updates store state on success or 401; is silent on network errors
     * (offline, server down) so cached state is preserved.
     * @returns {Promise<boolean>}
     */
    async function trySessionAuth() {
        try {
            const res = await fetch(`${AUTH_URL}?action=get_current_user`, {
                credentials: 'same-origin',
            });
            if (res.ok) {
                const data = await res.json();
                if (data?.username) {
                    set({ user: { username: data.username }, isLoading: false, error: null, apiKey: null });
                    try { localStorage.setItem(USER_CACHE, JSON.stringify({ username: data.username })); } catch { /* storage disabled */ }
                    return true;
                }
            } else if (res.status === 401) {
                // Cookie genuinely expired — clear stale cache so login UI shows
                set({ user: null, isLoading: false, error: null, apiKey: null });
                try { localStorage.removeItem(USER_CACHE); } catch { /* ignore */ }
            }
            // Other errors (500, network blip) leave state unchanged
        } catch { /* offline or DNS failure — preserve cached state */ }
        return false;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Offline-first init. Loads the cached username from localStorage instantly
     * (no network needed) so the app can render and load IndexedDB data.
     * Triggers a background session validation when online.
     *
     * If no cache exists and the device is online, waits for a session check
     * so we can detect an already-active website session (silent sign-in).
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
            // Paint from cache immediately
            set({ user: { username: cached.username }, isLoading: false, error: null, apiKey: null });

            // Re-validate in background — don't block the UI
            if (navigator.onLine) trySessionAuth();

            return true;
        }

        // No cache — if online, check for an existing website session first.
        // This lets a user who's already logged in on the main site open the
        // PWA without ever seeing a login screen.
        if (navigator.onLine) {
            return trySessionAuth();
        }

        set({ user: null, isLoading: false, error: null, apiKey: null });
        return false;
    }

    // ------------------------------------------------------------------
    // Login / Logout
    // ------------------------------------------------------------------

    /**
     * Sign in. First checks silently for an active website session.
     * If not signed in, opens the login popup.
     */
    async function login() {
        update(s => ({ ...s, isLoading: true, error: null }));

        // Open popup BEFORE any await — browsers block popups after async gaps
        const popup = window.open(
            'https://instrumenta.cf/mobilelogin.php',
            'Login',
            'width=400,height=580,scrollbars=yes,resizable=yes'
        );

        // Silent check — user might already be signed in from the main site
        const ok = await trySessionAuth();
        if (ok) {
            // Already signed in — close the popup we opened
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

        // Ask the server to delete the session_token file and clear the cookie
        try {
            await fetch(`${AUTH_URL}?action=logout`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
        } catch { /* ignore network errors on logout */ }

        set({ user: null, isLoading: false, error: null, apiKey: null });
        try { localStorage.removeItem(USER_CACHE); } catch { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Accessors
    // ------------------------------------------------------------------

    /** Always null — FileRegistry uses session cookies, not Bearer tokens. */
    function getApiKey() { return null; }

    /** @deprecated No-op. Session auth has no explicit key to set. */
    async function setApiKey() { /* no-op */ }

    /** @deprecated Use trySessionAuth() directly. */
    async function checkIfLoggedIn() { return trySessionAuth(); }

    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------

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
        setApiKey,
        getApiKey,
        destroy,
    };
}

export const authStore = createAuthStore();
