import { writable, get } from 'svelte/store';

// Store user data and authentication state
function createAuthStore() {
    /** @type {import('svelte/store').Writable<{
     *  user: {username: string} | null,
     *  isLoading: boolean,
     *  error: string | null,
     *  apiKey: string | null
     * }>} */
    const { subscribe, set } = writable({
        user: null,
        isLoading: false,
        error: null,
        apiKey: null,
    });

    const browser = typeof window !== 'undefined';

    /** @type {((event: MessageEvent) => void) | null} */
    let messageListener = null;

    // Handle API key from login
    if (browser) {
        messageListener = (event) => {
            console.log("Received API key from popup");

            // Accept messages from instrumenta.cf login page
            if (event.origin !== 'https://instrumenta.cf') return;
            if (event.data.type === 'AUTH_SUCCESS') {
                setApiKey(event.data.apikey);
            }
        };
        window.addEventListener('message', messageListener);
    }

    // Load user from localStorage if available
    async function init() {
        if (!browser) return;

        // Load API key from localStorage
        const storedApiKey = localStorage.getItem('worksheets:apiKey');
        if (storedApiKey) {
            // If we have an API key, validate it and get user info
            await checkIfLoggedIn(storedApiKey);
        }
    }

    // Load user data immediately from cache without network validation
    async function initOffline() {
        if (!browser) return false;

        // Load cached user data and API key
        const storedApiKey = localStorage.getItem('worksheets:apiKey');
        const storedUser = localStorage.getItem('worksheets:user');

        if (storedApiKey && storedUser) {
            try {
                const userData = JSON.parse(storedUser);
                if (userData?.username) {
                    set({
                        user: { username: userData.username },
                        isLoading: false,
                        error: null,
                        apiKey: storedApiKey
                    });
                    console.log("Loaded cached user data for", userData.username);

                    // Start background validation if online
                    if (navigator.onLine) {
                        backgroundValidateAuth(storedApiKey);
                    } else {
                        console.log("Offline - skipping background auth validation");
                    }

                    return true;
                }
            } catch (error) {
                console.error('Error parsing cached user data:', error);
            }
        }

        // No valid cached data found
        set({ user: null, isLoading: false, error: null, apiKey: null });
        return false;
    }

    // Background validation without blocking UI
    async function backgroundValidateAuth(apiKey) {
        try {
            const response = await fetch(
                `https://instrumenta.cf/api/auth.php?action=get_current_user&apikey=${apiKey}`
            );

            if (response.status === 401) {
                // API key invalid, clear cached data
                console.log('Background auth validation failed - clearing cached data');
                logout();
                return;
            }

            if (response.ok) {
                const data = await response.json();
                if (data?.username) {
                    // Update with fresh data if different
                    const currentState = get(authStore);
                    if (currentState.user?.username !== data.username) {
                        set({
                            user: { username: data.username },
                            isLoading: false,
                            error: null,
                            apiKey
                        });
                        localStorage.setItem('worksheets:user', JSON.stringify(data));
                    }
                }
            }
        } catch (error) {
            console.log('Background auth validation failed (network error), keeping cached data');
        }
    }

    // Validate user with API
    async function checkIfLoggedIn(apiKey) {
        if (!apiKey) {
            set({ user: null, isLoading: false, error: null, apiKey: null });
            return false;
        }

        set({ user: null, isLoading: true, error: null, apiKey });
        try {
            const response = await fetch(
                `https://instrumenta.cf/api/auth.php?action=get_current_user&apikey=${apiKey}`
            );

            // Handle unauthorized response (401)
            if (response.status === 401) {
                set({ user: null, isLoading: false, error: null, apiKey: null });
                localStorage.removeItem('worksheets:apiKey');
                return false;
            }

            // Handle other error statuses
            if (!response.ok) {
                // Preserve session state on server errors
                set({ user: null, isLoading: false, error: 'Server error', apiKey });
                return false;
            }

            const data = await response.json();

            //If we get a username, save it
            if (data?.username) {
                console.log("Logged in as " + data.username);

                set({ user: { username: data.username }, isLoading: false, error: null, apiKey });
                localStorage.setItem('worksheets:user', JSON.stringify(data));

                return true;
            }

            // No username in response - treat as not logged in
            set({ user: null, isLoading: false, error: null, apiKey: null });
            localStorage.removeItem('worksheets:apiKey');
            return false;
        } catch (err) {
            // Preserve session state on network errors
            set({ user: null, isLoading: false, error: 'Network error', apiKey });
            return false;
        }
    }

    // Handle login - open popup window
    async function login() {
        set({ user: null, isLoading: true, error: null, apiKey: null });

        const loginUrl = 'https://instrumenta.cf/mobilelogin.php';
        const popup = window.open(
            loginUrl,
            'Login',
            'width=500,height=600,scrollbars=yes,resizable=yes'
        );

        if (!popup) {
            set({ user: null, isLoading: false, error: 'Popup blocked. Please allow popups for this site.', apiKey: null });
        }
    }

    /**
     * @param {string | null} apiKey
     */
    async function setApiKey(apiKey) {
        if (!apiKey) {
            set({ user: null, isLoading: false, error: null, apiKey: null });
            localStorage.removeItem('worksheets:apiKey');
            return;
        }

        // Store API key
        localStorage.setItem('worksheets:apiKey', apiKey);

        // Validate the API key and get user info
        await checkIfLoggedIn(apiKey);
    }

    function getApiKey() {
        let apiKey = null;
        const unsubscribe = subscribe(state => {
            apiKey = state.apiKey;
        });
        unsubscribe();
        return apiKey;
    }
    //Handle Logout
    async function logout() {
        // Cleanup documents before clearing auth state
        try {
            const { cleanupSpreadsheet } = await import('./spreadsheetStore.svelte.js');
            cleanupSpreadsheet();
        } catch (error) {
            console.error('Failed to cleanup documents on logout:', error);
        }

        set({ user: null, isLoading: false, error: null, apiKey: null });
        if (browser) {
            localStorage.removeItem('worksheets:user');
            localStorage.removeItem('worksheets:apiKey');
        }
    }

    // Cleanup message listener (for HMR and app shutdown)
    function destroy() {
        if (browser && messageListener) {
            window.removeEventListener('message', messageListener);
            messageListener = null;
        }
    }

    return {
        subscribe,
        init,
        initOffline,
        checkIfLoggedIn,
        login,
        logout,
        setApiKey,
        getApiKey,
        destroy
    };
}

export const authStore = createAuthStore();
