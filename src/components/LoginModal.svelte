<script>
    import { onDestroy } from "svelte";
    import { authStore } from "../stores/authStore";

    const browser = typeof window !== "undefined";
    let showBrowserChrome = false;
    let cookies = [];

    // Handle browser chrome visibility
    $: {
        if (browser) {
            showBrowserChrome = !$authStore.isLoading;
            document.body.classList.toggle("hide-chrome", !showBrowserChrome);
        }
    }

    // Cleanup body class on destroy
    onDestroy(() => {
        if (browser) {
            document.body.classList.remove("hide-chrome");
        }
    });

    // Read cookies for debugging
    $: if (browser) {
        cookies = document.cookie
            ? document.cookie.split("; ").map((c) => {
                  const [name, ...value] = c.split("=");
                  return { name, value: value.join("=") };
              })
            : [];
    }
</script>

<div class="modal">
    <div class="content">
        {#if $authStore.isLoading}
            <p class="status">Authenticating...</p>
        {:else}
            <h2>Sign In</h2>
            {#if $authStore.error}
                <p class="error">{$authStore.error}</p>
            {/if}
            <button on:click={() => authStore.login()}>
                Login with Instrumenta
            </button>
        {/if}
    </div>
</div>

<style>
    .modal {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1000;
    }

    .content {
        background: var(--color-surface, white);
        border: 1px solid var(--color-border, #e5e5e5);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
        padding: 24px;
        min-width: 320px;
        max-width: 400px;
        text-align: center;
    }

    h2 {
        margin: 0 0 16px 0;
        font-size: 15px;
        font-weight: 600;
        color: var(--color-text, #18181b);
    }

    .status {
        margin: 0;
        font-size: 13px;
        color: var(--color-text-secondary, #52525b);
    }

    .error {
        margin: 0 0 16px 0;
        font-size: 13px;
        color: #dc2626;
    }

    button {
        background: var(--color-primary, #007bff);
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        transition: background 0.1s;
    }

    button:hover {
        background: #0066dd;
    }

    button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
</style>
