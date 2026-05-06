<script>
    import { untrack } from "svelte";
    import {
        spreadsheetSession,
        getDocManager,
    } from "../../../stores/spreadsheetStore.svelte.js";

    // Connection states: 'offline' | 'disconnected' | 'connecting' | 'connected' | 'syncing'
    // All state uses $state.raw to prevent reactive triggers from value changes
    let connectionStatus = $state.raw("disconnected");
    let isBrowserOffline = $state.raw(!navigator.onLine);

    // Non-reactive internal state
    let syncTimeout = null;
    let currentDocId = null;
    let providerPollInterval = null;
    let connectionPollInterval = null;
    let listenerCleanup = null;
    let previousDocId = null;
    let isUpdating = false; // Guard against reentrant updates

    // Helper to set status with guard against reentrant updates
    function setStatus(newStatus) {
        if (isUpdating) return;
        if (connectionStatus === newStatus) return;
        isUpdating = true;
        connectionStatus = newStatus;
        // Use queueMicrotask to reset the flag after the current update cycle
        queueMicrotask(() => {
            isUpdating = false;
        });
    }

    // Get the provider from the active document
    function getProvider(docId) {
        if (!docId) return null;

        const storage = getDocManager();
        if (!storage) return null;

        const runtime = storage._runtime;
        if (!runtime) return null;

        const activeDoc = runtime.activeDocs?.get(docId);
        if (!activeDoc) return null;

        return activeDoc.provider;
    }

    // Clear all timers and listeners
    function clearAllTimers() {
        if (syncTimeout) {
            clearTimeout(syncTimeout);
            syncTimeout = null;
        }
        if (providerPollInterval) {
            clearInterval(providerPollInterval);
            providerPollInterval = null;
        }
        if (connectionPollInterval) {
            clearInterval(connectionPollInterval);
            connectionPollInterval = null;
        }
        if (listenerCleanup) {
            listenerCleanup();
            listenerCleanup = null;
        }
    }

    // Set up listeners when we have a provider
    function setupProviderListeners(provider, docId) {
        console.log(
            "[ConnectionStatus] Setting up listeners for provider, initial state - wsconnected:",
            provider.wsconnected,
            "wsconnecting:",
            provider.wsconnecting,
        );

        // Set up event listeners FIRST to avoid race conditions
        const handleStatus = (event) => {
            console.log("[ConnectionStatus] Status event:", event.status);
            if (event.status === "connected") {
                setStatus("connected");
                clearConnectionPoll();
            } else if (event.status === "connecting") {
                setStatus("connecting");
            } else if (event.status === "disconnected") {
                setStatus("disconnected");
            }
        };

        // Listen for sync events (data being exchanged)
        const handleSync = (isSynced) => {
            console.log("[ConnectionStatus] Sync event:", isSynced);
            if (isSynced) {
                setStatus("connected");
                clearConnectionPoll();
                // Don't call triggerSyncing on sync - it causes loops
            }
        };

        provider.on("status", handleStatus);
        provider.on("sync", handleSync);

        // Return cleanup function
        listenerCleanup = () => {
            console.log("[ConnectionStatus] Cleaning up provider listeners");
            try {
                provider.off("status", handleStatus);
                provider.off("sync", handleSync);
            } catch (e) {
                // Provider may have been destroyed before cleanup ran
            }
        };

        // NOW check current status after listeners are set up
        if (provider.wsconnected) {
            console.log("[ConnectionStatus] Provider already connected");
            setStatus("connected");
        } else {
            // Not connected yet - show connecting state
            console.log(
                "[ConnectionStatus] Provider not connected, wsconnecting:",
                provider.wsconnecting,
            );
            setStatus("connecting");
            startConnectionPoll(provider);
        }
    }

    // Clear connection polling
    function clearConnectionPoll() {
        if (connectionPollInterval) {
            clearInterval(connectionPollInterval);
            connectionPollInterval = null;
        }
    }

    // Start polling for connection state (safety net)
    function startConnectionPoll(provider) {
        let pollAttempts = 0;
        const maxPollAttempts = 100; // 10 seconds
        let notConnectingCount = 0;

        connectionPollInterval = setInterval(() => {
            pollAttempts++;

            // Log every 10 attempts (1 second)
            if (pollAttempts % 10 === 0) {
                const ws = provider.ws;
                const wsState = ws
                    ? {
                          readyState: ws.readyState,
                          readyStateText:
                              ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][
                                  ws.readyState
                              ] || "UNKNOWN",
                      }
                    : "no ws";

                console.log(
                    "[ConnectionStatus] Polling... attempt",
                    pollAttempts,
                    "wsconnected:",
                    provider.wsconnected,
                    "wsconnecting:",
                    provider.wsconnecting,
                    "ws:",
                    wsState,
                );
            }

            const ws = provider.ws;
            const isWsOpen = ws && ws.readyState === WebSocket.OPEN;

            if (provider.wsconnected || isWsOpen) {
                console.log("[ConnectionStatus] Poll detected connection");
                setStatus("connected");
                clearConnectionPoll();
            } else if (!provider.wsconnecting && !isWsOpen) {
                notConnectingCount++;
                if (notConnectingCount >= 30) {
                    console.log(
                        "[ConnectionStatus] WebSocket not connecting for 3+ seconds, assuming disconnected",
                    );
                    setStatus("disconnected");
                    clearConnectionPoll();
                }
            } else {
                notConnectingCount = 0;
            }

            if (pollAttempts >= maxPollAttempts) {
                console.log(
                    "[ConnectionStatus] Connection poll timeout after",
                    pollAttempts * 100,
                    "ms",
                );
                clearConnectionPoll();
                setStatus(provider.wsconnected ? "connected" : "disconnected");
            }
        }, 100);
    }

    // Track connection status changes
    function setupForDocId(docId) {
        // Clear any existing state
        clearAllTimers();

        if (!docId) {
            setStatus("disconnected");
            return;
        }

        // Check if provider already exists
        const provider = getProvider(docId);

        if (provider) {
            console.log("[ConnectionStatus] Provider exists immediately");
            setupProviderListeners(provider, docId);
        } else {
            console.log(
                "[ConnectionStatus] Provider not found, polling for availability",
            );
            setStatus("connecting");

            let attempts = 0;
            const maxAttempts = 50;

            providerPollInterval = setInterval(() => {
                attempts++;
                const newProvider = getProvider(docId);

                if (newProvider) {
                    console.log(
                        "[ConnectionStatus] Provider found after",
                        attempts * 100,
                        "ms",
                    );
                    clearInterval(providerPollInterval);
                    providerPollInterval = null;
                    setupProviderListeners(newProvider, docId);
                } else if (attempts >= maxAttempts) {
                    console.log(
                        "[ConnectionStatus] Timed out waiting for provider",
                    );
                    clearInterval(providerPollInterval);
                    providerPollInterval = null;
                    setStatus("disconnected");
                }
            }, 100);
        }
    }

    // Reactive effect to setup listeners when docId changes
    $effect(() => {
        const docId = spreadsheetSession.docId;

        // Use previousDocId to detect actual changes
        if (docId === previousDocId) {
            return;
        }

        console.log(
            "[ConnectionStatus] docId changed from",
            previousDocId,
            "to",
            docId,
        );

        previousDocId = docId;
        currentDocId = docId;

        // Setup in untracked context
        untrack(() => setupForDocId(docId));
    });

    // Listen for browser online/offline events
    $effect(() => {
        const handleOnline = () => {
            console.log("[ConnectionStatus] Browser online");
            isBrowserOffline = false;
        };

        const handleOffline = () => {
            console.log("[ConnectionStatus] Browser offline");
            isBrowserOffline = true;
            setStatus("offline");
            clearConnectionPoll();
        };

        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);

        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    });

    // Cleanup on component destroy
    $effect(() => {
        return () => {
            console.log("[ConnectionStatus] Component destroy cleanup");
            clearAllTimers();
        };
    });

    // Computed display status - derived from raw state values
    // This is safe because the source values are $state.raw
    function getDisplayStatus() {
        return isBrowserOffline ? "offline" : connectionStatus;
    }

    // Status label for tooltip
    function getStatusLabel() {
        const status = getDisplayStatus();
        switch (status) {
            case "offline":
                return "You are offline";
            case "disconnected":
                return "Disconnected from server";
            case "connecting":
                return "Connecting...";
            case "connected":
                return "Connected and synced";
            case "syncing":
                return "Syncing changes...";
            default:
                return "Unknown status";
        }
    }
</script>

<div class="connection-status" title={getStatusLabel()}>
    {#if getDisplayStatus() === "offline"}
        <!-- Cloud with slash icon (offline) -->
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="icon offline"
        >
            <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            <path d="m2 2 20 20" />
        </svg>
    {:else if getDisplayStatus() === "disconnected"}
        <!-- Cloud with X icon -->
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="icon disconnected"
        >
            <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            <path d="m9 15 6-6" />
            <path d="m15 15-6-6" />
        </svg>
    {:else if getDisplayStatus() === "connecting"}
        <!-- Cloud with loading indicator -->
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="icon connecting"
        >
            <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            <path d="M12 12v-2" />
            <path d="M12 15h.01" />
        </svg>
    {:else if getDisplayStatus() === "syncing"}
        <!-- Cloud with arrows icon -->
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="icon syncing"
        >
            <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            <path d="m9 12 2 2" />
            <path d="m9 14 2-2" />
            <path d="M15 12l2 2" />
            <path d="M15 14l2-2" />
        </svg>
    {:else}
        <!-- Cloud icon (connected) -->
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="icon connected"
        >
            <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
        </svg>
    {/if}
</div>

<style>
    .connection-status {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.125rem;
        border-radius: 4px;
        margin-left: 0.25rem;
    }

    .icon {
        transition: stroke 0.2s ease;
    }

    .offline {
        stroke: var(--color-error, #ef4444);
    }

    .disconnected {
        stroke: var(--color-text-secondary, #888);
    }

    .connecting {
        stroke: var(--color-warning, #f59e0b);
        animation: pulse 1.5s ease-in-out infinite;
    }

    .connected {
        stroke: var(--color-success, #22c55e);
    }

    .syncing {
        stroke: var(--color-success, #22c55e);
        animation: sync-pulse 0.5s ease-in-out;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }

    @keyframes sync-pulse {
        0% {
            transform: scale(1);
        }
        50% {
            transform: scale(1.15);
        }
        100% {
            transform: scale(1);
        }
    }
</style>
