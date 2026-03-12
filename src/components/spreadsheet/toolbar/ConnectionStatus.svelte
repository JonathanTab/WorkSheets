<script>
    import { untrack } from "svelte";
    import {
        spreadsheetSession,
        getDocManager,
    } from "../../../stores/spreadsheetStore.svelte.js";

    // Connection states: 'disconnected' | 'connecting' | 'connected' | 'syncing'
    let connectionStatus = $state("disconnected");
    let syncTimeout = null;
    let currentDocId = $state.raw(null); // Track which doc we've set up listeners for
    let providerPollInterval = null; // Polling for provider availability
    let connectionPollInterval = null; // Polling for connection status
    let listenerCleanup = null; // Cleanup for provider listeners

    // Helper to set status only if it actually changes
    function setStatus(newStatus) {
        if (connectionStatus !== newStatus) {
            connectionStatus = newStatus;
        }
    }

    // Get the provider from the active document
    function getProvider(docId) {
        if (!docId) return null;

        // Access runtime via storage.core.runtime (not storage.runtime)
        const storage = getDocManager();
        if (!storage) {
            console.log(
                "[ConnectionStatus] getProvider: storage not available",
            );
            return null;
        }

        const core = storage.core;
        if (!core) {
            console.log("[ConnectionStatus] getProvider: core not available");
            return null;
        }

        const runtime = core.runtime;
        if (!runtime) {
            console.log(
                "[ConnectionStatus] getProvider: runtime not available",
            );
            return null;
        }

        const activeDoc = runtime.activeDocs.get(docId);
        if (!activeDoc) {
            console.log(
                "[ConnectionStatus] getProvider: docId not in activeDocs",
                docId,
                "activeDocs:",
                [...runtime.activeDocs.keys()],
            );
            return null;
        }

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
                // When sync completes, we're connected
                setStatus("connected");
                triggerSyncing();
            }
        };

        provider.on("status", handleStatus);
        provider.on("sync", handleSync);

        // Also listen for document updates to show activity
        const ydoc = spreadsheetSession.ydoc;
        const handleUpdate = () => {
            triggerSyncing();
        };

        if (ydoc) {
            ydoc.on("update", handleUpdate);
        }

        // Return cleanup function
        listenerCleanup = () => {
            console.log("[ConnectionStatus] Cleaning up provider listeners");
            provider.off("status", handleStatus);
            provider.off("sync", handleSync);
            if (ydoc) {
                ydoc.off("update", handleUpdate);
            }
        };

        // NOW check current status after listeners are set up
        // Check wsconnected first
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

            // Set up polling to detect connection state changes
            // This is a safety net in case events are missed
            let pollAttempts = 0;
            const maxPollAttempts = 100; // 10 seconds (100 * 100ms)
            let notConnectingCount = 0; // Count consecutive "not connecting" states

            connectionPollInterval = setInterval(() => {
                pollAttempts++;

                // Log every 10 attempts (1 second)
                if (pollAttempts % 10 === 0) {
                    // Also check the underlying WebSocket if available
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

                // Check both y-websocket flags AND underlying WebSocket state
                const ws = provider.ws;
                const isWsOpen = ws && ws.readyState === WebSocket.OPEN;

                if (provider.wsconnected || isWsOpen) {
                    console.log(
                        "[ConnectionStatus] Poll detected connection (wsconnected:",
                        provider.wsconnected,
                        "isWsOpen:",
                        isWsOpen,
                        ")",
                    );
                    setStatus("connected");
                    clearInterval(connectionPollInterval);
                    connectionPollInterval = null;
                } else if (!provider.wsconnecting && !isWsOpen) {
                    // Not connecting and not connected
                    notConnectingCount++;

                    // If we've been "not connecting" for 3 seconds (30 attempts),
                    // the WebSocket failed to establish or was disconnected
                    if (notConnectingCount >= 30) {
                        console.log(
                            "[ConnectionStatus] WebSocket not connecting for 3+ seconds, assuming disconnected",
                        );
                        setStatus("disconnected");
                        clearInterval(connectionPollInterval);
                        connectionPollInterval = null;
                    }
                } else {
                    // Is connecting, reset the counter
                    notConnectingCount = 0;
                }

                if (pollAttempts >= maxPollAttempts) {
                    // Timed out
                    console.log(
                        "[ConnectionStatus] Connection poll timeout after",
                        pollAttempts * 100,
                        "ms. Final state - wsconnected:",
                        provider.wsconnected,
                        "wsconnecting:",
                        provider.wsconnecting,
                    );
                    clearInterval(connectionPollInterval);
                    connectionPollInterval = null;
                    // Set to whatever the current state actually is
                    if (provider.wsconnected) {
                        setStatus("connected");
                    } else {
                        setStatus("disconnected");
                    }
                }
            }, 100);
        }
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
            setStatus("connecting"); // Show connecting while we wait for provider

            // Poll for provider availability
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds max

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

    // Trigger syncing state with a timeout
    function triggerSyncing() {
        // Don't transition from disconnected or connecting
        if (
            connectionStatus === "disconnected" ||
            connectionStatus === "connecting"
        ) {
            return;
        }

        // Only update if not already syncing (prevents redundant updates)
        if (connectionStatus !== "syncing") {
            setStatus("syncing");
        }

        // Clear any existing timeout
        if (syncTimeout) {
            clearTimeout(syncTimeout);
            syncTimeout = null;
        }

        // Reset to connected after 500ms of no activity
        syncTimeout = setTimeout(() => {
            syncTimeout = null;
            const provider = getProvider(currentDocId);
            if (provider?.wsconnected) {
                setStatus("connected");
            } else {
                setStatus("disconnected");
            }
        }, 500);
    }

    // Track previous docId to detect changes
    let previousDocId = null;

    // Reactive effect to setup listeners when docId changes
    $effect(() => {
        const docId = spreadsheetSession.docId;

        // Use previousDocId to detect actual changes (not reactive)
        if (docId === previousDocId) {
            return;
        }

        console.log(
            "[ConnectionStatus] docId changed from",
            previousDocId,
            "to",
            docId,
        );

        // Update previous docId BEFORE setting up (to avoid effect re-trigger)
        previousDocId = docId;
        currentDocId = docId;

        // Clear any existing timers from previous setup
        clearAllTimers();

        // Setup in untracked context
        untrack(() => setupForDocId(docId));
    });

    // Cleanup on component destroy using $effect with no dependencies
    $effect(() => {
        return () => {
            console.log("[ConnectionStatus] Component destroy cleanup");
            clearAllTimers();
        };
    });

    // Status label for tooltip
    const statusLabel = $derived.by(() => {
        switch (connectionStatus) {
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
    });
</script>

<div class="connection-status" title={statusLabel}>
    {#if connectionStatus === "disconnected"}
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
    {:else if connectionStatus === "connecting"}
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
    {:else if connectionStatus === "syncing"}
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
