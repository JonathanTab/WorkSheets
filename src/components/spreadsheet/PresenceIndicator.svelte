<script>
    /**
     * PresenceIndicator — shows avatars for users currently editing this document.
     *
     * Props:
     *   awareness  - Yjs Awareness instance (from spreadsheetSession.awareness)
     *   currentUser - username of the local user (to mark self)
     */
    import { onDestroy } from "svelte";

    let { awareness = null, currentUser = "" } = $props();

    /** @type {{ clientId: number, name: string, color: string, isSelf: boolean }[]} */
    let users = $state([]);

    function refresh() {
        if (!awareness) {
            users = [];
            return;
        }
        const states = awareness.getStates();
        const seen = new Set();
        const next = [];
        for (const [clientId, state] of states) {
            if (!state?.user?.name) continue;
            const name = state.user.name;
            // Skip current user
            if (name === currentUser) continue;
            // Deduplicate by username (same person may have multiple tabs)
            if (seen.has(name)) continue;
            seen.add(name);
            next.push({
                clientId,
                name,
                color: state.user.color ?? "#888",
                isSelf: false,
            });
        }
        // Sort alphabetical
        next.sort((a, b) => a.name.localeCompare(b.name));
        users = next;
    }

    // Re-subscribe when awareness instance changes
    let unsub = null;
    $effect(() => {
        unsub?.();
        unsub = null;
        if (!awareness) {
            users = [];
            return;
        }
        refresh();
        const handler = () => refresh();
        awareness.on("change", handler);
        unsub = () => awareness.off("change", handler);
    });

    onDestroy(() => unsub?.());

    const MAX_VISIBLE = 5;
</script>

{#if users.length > 0}
    <div
        class="flex items-center gap-1"
        role="group"
        aria-label="Active collaborators"
    >
        {#each users.slice(0, MAX_VISIBLE) as user (user.clientId)}
            <div
                class="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold select-none cursor-default ring-2 ring-white dark:ring-gray-800 transition-all"
                style:background-color={user.color}
                title={user.isSelf ? `${user.name} (you)` : user.name}
                aria-label={user.isSelf ? `${user.name} (you)` : user.name}
            >
                {user.name.slice(0, 1).toUpperCase()}
            </div>
        {/each}

        {#if users.length > MAX_VISIBLE}
            <div
                class="w-7 h-7 rounded-full bg-gray-400 dark:bg-gray-600 flex items-center justify-center text-white text-[11px] font-bold select-none cursor-default ring-2 ring-white dark:ring-gray-800"
                title={users
                    .slice(MAX_VISIBLE)
                    .map((u) => u.name)
                    .join(", ")}
            >
                +{users.length - MAX_VISIBLE}
            </div>
        {/if}
    </div>
{/if}
