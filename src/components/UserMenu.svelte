<script>
    /**
     * UserMenu — A round avatar button with dropdown for user management.
     * Designed for the top menu/title bar area across all apps.
     *
     * Features:
     *   - Round avatar with user initials
     *   - Deterministic color from username
     *   - Dropdown with user info and controls
     *   - Logout functionality
     *   - Sync status indicator
     */
    import { authStore } from "../stores/authStore.js";
    import { onDestroy } from "svelte";

    let {
        /** Optional registry for sync status */
        registry = null,
        /** Optional additional menu items */
        menuItems = [],
    } = $props();

    let isOpen = $state(false);
    let menuRef = $state(null);
    let triggerRef = $state(null);

    // User state
    let user = $derived($authStore.user);
    let username = $derived(user?.username ?? "");
    let initials = $derived(username.slice(0, 2).toUpperCase());

    // Deterministic color from username
    let avatarColor = $derived.by(() => {
        if (!username) return "#6b7280";
        let hash = 0;
        for (let i = 0; i < username.length; i++) {
            hash = username.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash) % 360;
        return `hsl(${h}, 65%, 45%)`;
    });

    // Sync state (if registry provided)
    let syncState = $state({ isSyncing: false, lastSync: null, error: null });

    $effect(() => {
        if (!registry?.syncState) return;
        const unsub = registry.syncState.subscribe((s) => {
            syncState = s;
        });
        return unsub;
    });

    // Click outside to close
    function handleClickOutside(e) {
        if (!menuRef || !triggerRef) return;
        if (!menuRef.contains(e.target) && !triggerRef.contains(e.target)) {
            isOpen = false;
        }
    }

    // Escape to close
    function handleKeydown(e) {
        if (e.key === "Escape") {
            isOpen = false;
            triggerRef?.focus();
        }
    }

    $effect(() => {
        if (isOpen) {
            document.addEventListener("click", handleClickOutside);
            document.addEventListener("keydown", handleKeydown);
        }
        return () => {
            document.removeEventListener("click", handleClickOutside);
            document.removeEventListener("keydown", handleKeydown);
        };
    });

    function toggle() {
        isOpen = !isOpen;
    }

    async function handleLogout() {
        isOpen = false;
        await authStore.logout();
    }

    function handleSync() {
        registry?.sync?.();
    }

    function formatLastSync(date) {
        if (!date) return null;
        const diff = Date.now() - new Date(date).getTime();
        if (diff < 60000) return "just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        return `${Math.floor(diff / 3600000)}h ago`;
    }

    onDestroy(() => {
        document.removeEventListener("click", handleClickOutside);
        document.removeEventListener("keydown", handleKeydown);
    });
</script>

{#if user}
    <div class="user-menu-container">
        <!-- Avatar trigger button -->
        <button
            bind:this={triggerRef}
            class="avatar-btn"
            class:open={isOpen}
            onclick={toggle}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            title={username}
        >
            <span class="avatar" style="background-color: {avatarColor}">
                {initials}
            </span>
        </button>

        <!-- Dropdown menu -->
        {#if isOpen}
            <div bind:this={menuRef} class="menu" role="menu">
                <!-- User info header -->
                <div class="menu-header">
                    <div
                        class="menu-avatar"
                        style="background-color: {avatarColor}"
                    >
                        {initials}
                    </div>
                    <div class="menu-user-info">
                        <div class="menu-username">{username}</div>
                        <div class="menu-status">Signed in</div>
                    </div>
                </div>

                <div class="menu-divider"></div>

                <!-- Sync status (if registry provided) -->
                {#if registry}
                    <button
                        class="menu-item sync-item"
                        class:syncing={syncState.isSyncing}
                        class:error={syncState.error}
                        onclick={handleSync}
                        role="menuitem"
                    >
                        <span
                            class="menu-icon"
                            class:spin={syncState.isSyncing}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                            >
                                <path
                                    d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
                                />
                                <path d="M21 3v5h-5" />
                            </svg>
                        </span>
                        <span class="menu-label">
                            {#if syncState.isSyncing}
                                Syncing...
                            {:else if syncState.error}
                                Sync error
                            {:else if syncState.lastSync}
                                Synced {formatLastSync(syncState.lastSync)}
                            {:else}
                                Sync now
                            {/if}
                        </span>
                        {#if syncState.error}
                            <span
                                class="sync-error-badge"
                                title={syncState.error}>!</span
                            >
                        {/if}
                    </button>
                    <div class="menu-divider"></div>
                {/if}

                <!-- Custom menu items -->
                {#each menuItems as item}
                    <button
                        class="menu-item"
                        onclick={() => {
                            isOpen = false;
                            item.action?.();
                        }}
                        role="menuitem"
                    >
                        {#if item.icon}
                            <span class="menu-icon">{@html item.icon}</span>
                        {/if}
                        <span class="menu-label">{item.label}</span>
                    </button>
                {/each}

                {#if menuItems.length > 0}
                    <div class="menu-divider"></div>
                {/if}

                <!-- Logout -->
                <button
                    class="menu-item logout-item"
                    onclick={handleLogout}
                    role="menuitem"
                >
                    <span class="menu-icon">
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                            <polyline points="16 17 21 12 16 7" />
                            <line x1="21" y1="12" x2="9" y2="12" />
                        </svg>
                    </span>
                    <span class="menu-label">Sign out</span>
                </button>
            </div>
        {/if}
    </div>
{/if}

<style>
    .user-menu-container {
        position: relative;
        display: flex;
        align-items: center;
    }

    .avatar-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        background: transparent;
        border: none;
        cursor: pointer;
        border-radius: 50%;
        transition: all 0.15s ease;
    }

    .avatar-btn:hover {
        transform: scale(1.05);
    }

    .avatar-btn:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 2px;
    }

    .avatar-btn.open .avatar {
        box-shadow: 0 0 0 2px var(--color-primary);
    }

    .avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        color: white;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        transition: box-shadow 0.15s ease;
        user-select: none;
    }

    .menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        z-index: 1000;
        min-width: 200px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
        padding: 6px;
        animation: menu-enter 0.15s ease;
    }

    @keyframes menu-enter {
        from {
            opacity: 0;
            transform: translateY(-4px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    .menu-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
    }

    .menu-avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        color: white;
        font-size: 14px;
        font-weight: 600;
        text-transform: uppercase;
        flex-shrink: 0;
    }

    .menu-user-info {
        flex: 1;
        min-width: 0;
    }

    .menu-username {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .menu-status {
        font-size: 0.75rem;
        color: var(--color-text-muted);
    }

    .menu-divider {
        height: 1px;
        background: var(--color-border);
        margin: 4px 0;
    }

    .menu-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 8px 10px;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: var(--color-text);
        font-size: 0.8125rem;
        cursor: pointer;
        text-align: left;
        transition: background 0.1s ease;
    }

    .menu-item:hover {
        background: var(--color-fill);
    }

    .menu-item:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: -2px;
    }

    .menu-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        color: var(--color-text-secondary);
    }

    .menu-icon :global(svg) {
        width: 18px;
        height: 18px;
    }

    .menu-label {
        flex: 1;
    }

    .sync-item.syncing .menu-icon {
        color: var(--color-primary);
    }

    .sync-item.syncing .menu-icon svg {
        animation: spin 1s linear infinite;
    }

    .sync-item.error .menu-label {
        color: var(--color-error, #ef4444);
    }

    .sync-error-badge {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        background: var(--color-error, #ef4444);
        color: white;
        font-size: 10px;
        font-weight: 700;
        border-radius: 50%;
    }

    .logout-item {
        color: var(--color-error, #ef4444);
    }

    .logout-item .menu-icon {
        color: var(--color-error, #ef4444);
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    /* Mobile adjustments */
    @media (max-width: 600px) {
        .avatar {
            width: 30px;
            height: 30px;
            font-size: 11px;
        }

        .menu {
            min-width: 180px;
        }
    }
</style>
