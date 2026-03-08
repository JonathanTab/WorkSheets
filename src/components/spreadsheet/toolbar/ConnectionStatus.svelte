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
        const runtime = getDocManager()?.core?.runtime;
        if (!runtime) return null;

        return runtime.activeDocs.get(docId)?.provider;
    }

    // Track connection status changes
    function setupProviderListeners(docId) {
        const provider = getProvider(docId);
        if (!provider) {
            setStatus("disconnected");
            return () => {};
        }

        // Set initial status
        if (provider.wsconnected) {
            setStatus("connected");
        } else if (provider.wsconnecting) {
            setStatus("connecting");
        } else {
            setStatus("disconnected");
        }

        // Listen for status changes
        const handleStatus = (event) => {
            if (event.status === "connected") {
                setStatus("connected");
            } else if (event.status === "connecting") {
                setStatus("connecting");
            } else {
                setStatus("disconnected");
            }
        };

        // Listen for sync events (data being exchanged)
        const handleSync = (isSynced) => {
            if (isSynced) {
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

        return () => {
            provider.off("status", handleStatus);
            provider.off("sync", handleSync);
            if (ydoc) {
                ydoc.off("update", handleUpdate);
            }
        };
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

    // Cleanup helper
    function cleanup() {
        if (syncTimeout) {
            clearTimeout(syncTimeout);
            syncTimeout = null;
        }
    }

    // Reactive effect to setup listeners when docId changes
    // Only track docId - everything else should be untracked
    $effect(() => {
        // Track docId reactively - this is the ONLY dependency
        const docId = spreadsheetSession.docId;

        // Skip if docId hasn't actually changed (prevents re-setup on unrelated updates)
        if (docId === currentDocId) {
            return;
        }

        // Cleanup previous listeners
        cleanup();

        // Update current doc ID
        currentDocId = docId;

        // Setup new listeners in untracked context
        const cleanupFn = untrack(() => setupProviderListeners(docId));

        // Return cleanup function - Svelte 5 calls this on re-run or destroy
        return () => {
            cleanup();
            if (cleanupFn) cleanupFn();
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
