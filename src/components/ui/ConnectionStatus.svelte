<script>
    import { untrack } from "svelte";
    import { storage } from "../../stores/storage.js";
    import { log } from "../../util/log.js";

    // Fully modular: the only input is the doc id to monitor. Any sub-app
    // (sheets, docs, …) passes its own session's docId; the underlying
    // YjsRuntime/providers live on the shared storage singleton.
    let { docId = null } = $props();

    // Phases: 'no-connection' | 'connecting' | 'connected'.
    // 'no-connection' covers both "no network" and "server unreachable" —
    // distinguished only in the tooltip (noConnectionReason), per design:
    // one visual state, accurate cause on hover.
    let phase = $state.raw("connecting");
    let noConnectionReason = $state.raw(null); // 'network' | 'server' | null
    // Transient flash for real traffic, not a steady-state phase.
    let activityPulse = $state.raw(null); // 'sent' | 'received' | null

    // After this many consecutive failed connection attempts (no successful
    // open since the last one), stop pretending we're "connecting" and tell
    // the user the server is unreachable. y-websocket retries forever with
    // backoff regardless — we just stop narrating every attempt once it's
    // clear this isn't progressing. Kept low so a dead server is reported
    // within ~300ms (100ms + 200ms backoff), not after a long fake wait.
    const FAILURE_THRESHOLD = 2;
    const PULSE_DURATION_MS = 450;
    // One-time bootstrap wait for YjsRuntime to create the provider for this
    // docId (load() is async). Not a connectivity check — just "does the
    // provider object exist yet".
    const PROVIDER_BOOTSTRAP_POLL_MS = 100;
    const PROVIDER_BOOTSTRAP_MAX_ATTEMPTS = 30; // 3s

    let pulseTimeout = null;
    let providerPollInterval = null;
    let listenerCleanup = null;
    let previousDocId = null;
    let isBrowserOffline = !(typeof navigator !== "undefined" ? navigator.onLine : true);

    function getActive(id) {
        if (!id) return null;
        const runtime = storage?._runtime;
        return runtime?.activeDocs?.get(id) ?? null;
    }

    function clearProviderPoll() {
        if (providerPollInterval) {
            clearInterval(providerPollInterval);
            providerPollInterval = null;
        }
    }

    function setPhase(next, reason = null) {
        phase = next;
        noConnectionReason = next === "no-connection" ? reason : null;
    }

    function pulse(kind) {
        activityPulse = kind;
        clearTimeout(pulseTimeout);
        pulseTimeout = setTimeout(() => {
            activityPulse = null;
        }, PULSE_DURATION_MS);
    }

    // Single source of truth for the non-network phase: derive it from the
    // provider's own counters rather than trusting whichever status event
    // happened to fire last. This is what keeps "no connection possible"
    // stable instead of flickering back to "connecting" on every background
    // retry attempt.
    function evaluateProvider(provider) {
        if (isBrowserOffline) return; // network state takes priority
        if (provider.wsconnected) {
            setPhase("connected");
        } else if (provider.wsUnsuccessfulReconnects >= FAILURE_THRESHOLD) {
            setPhase("no-connection", "server");
        } else {
            setPhase("connecting");
        }
    }

    function setupProviderListeners(provider, ydoc) {
        evaluateProvider(provider);

        const handleStatus = ({ status }) => {
            log.debug("[ConnectionStatus] status event:", status);
            if (status === "connected") {
                setPhase("connected");
            } else {
                evaluateProvider(provider);
            }
        };

        const handleSync = (isSynced) => {
            if (isSynced) pulse("received");
        };

        const handleUpdate = (_update, origin) => {
            if (phase !== "connected") return; // don't claim traffic we didn't actually send/receive
            pulse(origin === provider ? "received" : "sent");
        };

        provider.on("status", handleStatus);
        provider.on("sync", handleSync);
        ydoc.on("update", handleUpdate);

        listenerCleanup = () => {
            try {
                provider.off("status", handleStatus);
                provider.off("sync", handleSync);
                ydoc.off("update", handleUpdate);
            } catch (e) {
                // Provider/doc may have been destroyed before cleanup ran
            }
        };
    }

    function setupForDocId(id) {
        clearProviderPoll();
        if (listenerCleanup) {
            listenerCleanup();
            listenerCleanup = null;
        }

        if (!id) {
            setPhase("no-connection", null);
            return;
        }

        const active = getActive(id);
        if (active) {
            setupProviderListeners(active.provider, active.ydoc);
            return;
        }

        // Provider not created yet — runtime.load() is still in flight.
        setPhase("connecting");
        let attempts = 0;
        providerPollInterval = setInterval(() => {
            attempts++;
            const found = getActive(id);
            if (found) {
                clearProviderPoll();
                setupProviderListeners(found.provider, found.ydoc);
            } else if (attempts >= PROVIDER_BOOTSTRAP_MAX_ATTEMPTS) {
                clearProviderPoll();
                setPhase("no-connection", "server");
            }
        }, PROVIDER_BOOTSTRAP_POLL_MS);
    }

    $effect(() => {
        if (docId === previousDocId) return;
        previousDocId = docId;
        untrack(() => setupForDocId(docId));
    });

    $effect(() => {
        const handleOnline = () => {
            log.debug("[ConnectionStatus] Browser online");
            isBrowserOffline = false;
            // Optimistic: YjsRuntime reconnects providers on this same event;
            // real status events correct this shortly after.
            const active = getActive(docId);
            if (active) evaluateProvider(active.provider);
            else setPhase("connecting");
        };

        const handleOffline = () => {
            log.debug("[ConnectionStatus] Browser offline");
            isBrowserOffline = true;
            setPhase("no-connection", "network");
        };

        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);

        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    });

    $effect(() => {
        return () => {
            clearProviderPoll();
            clearTimeout(pulseTimeout);
            if (listenerCleanup) listenerCleanup();
        };
    });

    function getStatusLabel() {
        if (phase === "no-connection") {
            if (noConnectionReason === "network") return "No internet connection";
            if (noConnectionReason === "server") return "Server unavailable";
            return "Not connected";
        }
        if (phase === "connecting") return "Connecting…";
        if (activityPulse === "sent") return "Connected — sending changes";
        if (activityPulse === "received") return "Connected — receiving changes";
        return "Connected";
    }
</script>

<div
    class="connection-status"
    class:pulse-sent={activityPulse === "sent"}
    class:pulse-received={activityPulse === "received"}
    title={getStatusLabel()}
>
    {#if phase === "no-connection"}
        <!-- Cloud with slash icon -->
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
            class="icon no-connection"
        >
            <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            <path d="m2 2 20 20" />
        </svg>
    {:else if phase === "connecting"}
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

    .no-connection {
        stroke: var(--color-error, #ef4444);
    }

    .connecting {
        stroke: var(--color-warning, #f59e0b);
        animation: pulse 1.5s ease-in-out infinite;
    }

    .connected {
        stroke: var(--color-success, #22c55e);
    }

    .pulse-sent .icon {
        animation: activity-pulse 0.45s ease-in-out;
        stroke: var(--color-info, #3b82f6);
    }

    .pulse-received .icon {
        animation: activity-pulse 0.45s ease-in-out;
        stroke: var(--color-success, #22c55e);
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

    @keyframes activity-pulse {
        0% {
            transform: scale(1);
        }
        50% {
            transform: scale(1.25);
        }
        100% {
            transform: scale(1);
        }
    }
</style>
