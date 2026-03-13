<script>
    import { onMount } from "svelte";
    import { warning } from "./lib/icons/index.js";
    import AppShell from "./components/AppShell.svelte";
    import LoginModal from "./components/LoginModal.svelte";
    import InstallPrompt from "./components/InstallPrompt.svelte";
    import MaintenanceOverlay from "./components/MaintenanceOverlay.svelte";
    import { authStore } from "./stores/authStore";
    import { initializeSpreadsheet } from "./stores/spreadsheetStore.svelte.js";

    let initialized = $state(false);
    let loading = $state(true);
    let isOffline = $state(false);
    let isInitializing = $state(false);

    let unsubscribeAuth = null;

    // Initialize stores on mount with offline-first approach
    onMount(() => {
        console.log("[App] Starting mount...");

        // Set initial offline status
        isOffline = !navigator.onLine;

        // Listen for network changes
        const handleOnline = () => {
            console.log("Network connection restored");
            isOffline = false;
        };

        const handleOffline = () => {
            console.log("Network connection lost");
            isOffline = true;
        };

        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);

        (async () => {
            try {
                // Load cached authentication data immediately (no network required)
                console.log("[App] Loading cached auth data...");
                const isAuthenticated = await authStore.initOffline();

                if (isAuthenticated) {
                    // User has cached credentials, load documents from cache
                    console.log(
                        "[App] User has cached credentials, initializing spreadsheet...",
                    );
                    isInitializing = true;
                    console.log("[App] About to call initializeSpreadsheet...");
                    initialized = await initializeSpreadsheet();
                    console.log(
                        "[App] initializeSpreadsheet returned:",
                        initialized,
                    );
                    isInitializing = false;

                    if (!initialized) {
                        console.error("[App] Document initialization failed");
                    }
                } else {
                    // No cached credentials found - user needs to log in
                    console.log(
                        "[App] No cached credentials found - user needs to authenticate",
                    );
                    initialized = false;
                }

                console.log(
                    "[App] Initialization sequence complete, setting loading=false",
                );
                loading = false;
                console.log("[App] loading state updated to:", loading);

                // Subscribe to auth changes for login/logout handling
                console.log("[App] Subscribing to auth changes...");
                unsubscribeAuth = authStore.subscribe(async (state) => {
                    // Only react to auth changes after initial setup is complete
                    if (loading) return;

                    if (
                        state.user?.username &&
                        state.apiKey &&
                        !initialized &&
                        !isInitializing
                    ) {
                        // User just logged in, initialize documents
                        console.log(
                            "[App] User logged in - initializing documents",
                        );
                        isInitializing = true;
                        initialized = await initializeSpreadsheet();
                        isInitializing = false;
                    } else if (!state.user?.username || !state.apiKey) {
                        // User logged out, reset initialization state
                        console.log(
                            "[App] User logged out - resetting document state",
                        );
                        initialized = false;
                    }
                });
            } catch (error) {
                console.error("[App] Initialization error:", error);
                initialized = false;
                loading = false;
            } finally {
                console.log("[App] finally block, loading should be false");
            }
        })();

        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
            if (unsubscribeAuth) unsubscribeAuth();
        };
    });
</script>

<main class="overscroll-none bg-bg text-text">
    <InstallPrompt />
    <MaintenanceOverlay />

    {#if loading}
        <div class="loading-overlay">
            <div class="spinner"></div>
            <p>Initializing workspace...</p>
        </div>
    {:else if !initialized}
        <div class="error-overlay">
            <p>{@html warning} Failed to initialize workspace</p>
            <button onclick={() => location.reload()}>Retry</button>
        </div>
    {:else}
        <AppShell />
    {/if}

    <!-- Login modal when not authenticated -->
    {#if !$authStore.apiKey && !loading}
        <LoginModal />
    {/if}
</main>

<style>
    .loading-overlay,
    .error-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        z-index: 1000;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
    }

    .spinner {
        border: 4px solid #f3f3f3;
        border-top: 4px solid #3498db;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        animation: spin 1s linear infinite;
        margin-bottom: 1em;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .error-overlay button {
        margin-top: 1em;
        padding: 0.5em 1em;
        background: #e74c3c;
        color: white;
        border: none;
        border-radius: 4px;
    }
</style>
