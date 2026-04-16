<script>
    import { onMount } from "svelte";
    import { warning } from "./lib/icons/index.js";
    import AppShell from "./components/AppShell.svelte";
    import LoginModal from "./components/LoginModal.svelte";
    import InstallPrompt from "./components/InstallPrompt.svelte";
    import MaintenanceOverlay from "./components/MaintenanceOverlay.svelte";
    import { authStore } from "./stores/authStore";
    import storage from "./stores/storage.js";

    let initialized = $state(false);
    let loading = $state(true);

    let unsubscribeAuth = null;

    // Initialize on mount: auth + shared storage (all workspaces need this)
    onMount(() => {
        (async () => {
            try {
                const isAuthenticated = await authStore.initOffline();

                if (isAuthenticated) {
                    await storage.init();
                    storage.on('auth-error', () => authStore.logout());
                }

                initialized = isAuthenticated;
                loading = false;

                // React to login / logout after initial auth is resolved
                unsubscribeAuth = authStore.subscribe(async (state) => {
                    if (loading) return;
                    if (state.user?.username && !initialized) {
                        await storage.init();
                        initialized = true;
                    } else if (!state.user?.username) {
                        initialized = false;
                    }
                });
            } catch (error) {
                console.error("[App] Initialization error:", error);
                initialized = false;
                loading = false;
            }
        })();

        return () => {
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
    {#if !$authStore.user && !loading}
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
