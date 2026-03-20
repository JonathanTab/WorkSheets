<script>
    import { authStore } from "../stores/authStore.js";

    let open = $state(false);
    let avatarEl = $state(null);

    function toggle() {
        open = !open;
    }
    function close() {
        open = false;
    }

    // Close on outside click
    function handleOutside(e) {
        if (avatarEl && !avatarEl.contains(e.target)) close();
    }

    $effect(() => {
        if (open) {
            document.addEventListener("pointerdown", handleOutside, true);
            return () =>
                document.removeEventListener(
                    "pointerdown",
                    handleOutside,
                    true,
                );
        }
    });

    function handleLogin() {
        close();
        authStore.login();
    }
    function handleLogout() {
        close();
        authStore.logout();
    }

    // First letter of username, uppercased
    const initial = $derived(
        $authStore.user?.username
            ? $authStore.user.username[0].toUpperCase()
            : null,
    );

    // Deterministic hue from username for avatar colour
    const avatarHue = $derived.by(() => {
        const name = $authStore.user?.username ?? "";
        let hash = 0;
        for (let i = 0; i < name.length; i++)
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return ((hash % 360) + 360) % 360;
    });
</script>

<div class="avatar-root" bind:this={avatarEl}>
    <button
        class="avatar-btn"
        class:signed-in={!!$authStore.user}
        style={$authStore.user ? `--hue: ${avatarHue}` : ""}
        onclick={toggle}
        aria-label={$authStore.user
            ? `Account: ${$authStore.user.username}`
            : "Sign in"}
        title={$authStore.user ? $authStore.user.username : "Sign in"}
    >
        {#if $authStore.isLoading}
            <span class="spinner"></span>
        {:else if $authStore.user}
            {initial}
        {:else}
            <!-- person icon -->
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
            >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            </svg>
        {/if}
    </button>

    {#if open}
        <div class="dropdown" role="menu">
            {#if $authStore.user}
                <div class="dropdown-header">
                    <div class="dropdown-avatar" style="--hue: {avatarHue}">
                        {initial}
                    </div>
                    <div>
                        <div class="dropdown-name">
                            {$authStore.user.username}
                        </div>
                        <div class="dropdown-mode">
                            {$authStore.authMode === "session"
                                ? "Session"
                                : "API key"}
                        </div>
                    </div>
                </div>
                <hr class="dropdown-divider" />
                <button
                    class="dropdown-item signout"
                    onclick={handleLogout}
                    role="menuitem"
                >
                    Sign out
                </button>
            {:else}
                <div class="dropdown-header signed-out-header">
                    <span>Not signed in</span>
                </div>
                <button
                    class="dropdown-item"
                    onclick={handleLogin}
                    role="menuitem"
                >
                    Sign in
                </button>
            {/if}
        </div>
    {/if}
</div>

<style>
    .avatar-root {
        position: relative;
    }

    .avatar-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text-muted);
        background: var(--color-fill);
        transition:
            background 0.15s,
            color 0.15s;
        flex-shrink: 0;
    }

    .avatar-btn:hover {
        background: var(--color-fill-secondary);
        color: var(--color-text-secondary);
    }

    .avatar-btn.signed-in {
        background: hsl(var(--hue, 210), 55%, 45%);
        color: #fff;
    }

    .avatar-btn.signed-in:hover {
        background: hsl(var(--hue, 210), 55%, 38%);
    }

    .avatar-btn svg {
        width: 17px;
        height: 17px;
    }

    .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    /* Dropdown */
    .dropdown {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        min-width: 180px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        z-index: 9999;
        overflow: hidden;
    }

    .dropdown-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
    }

    .signed-out-header {
        font-size: 0.8rem;
        color: var(--color-text-muted);
    }

    .dropdown-avatar {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: hsl(var(--hue, 210), 55%, 45%);
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .dropdown-name {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--color-text);
        line-height: 1.2;
    }

    .dropdown-mode {
        font-size: 0.7rem;
        color: var(--color-text-muted);
        margin-top: 1px;
    }

    .dropdown-divider {
        margin: 0;
        border: none;
        border-top: 1px solid var(--color-border);
    }

    .dropdown-item {
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        padding: 10px 14px;
        font-size: 0.85rem;
        color: var(--color-text);
        cursor: pointer;
        transition: background 0.12s;
    }

    .dropdown-item:hover {
        background: var(--color-fill);
    }

    .dropdown-item.signout {
        color: #dc2626;
    }

    .dropdown-item.signout:hover {
        background: rgba(220, 38, 38, 0.08);
    }
</style>
