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
            <p>Authenticating...</p>
        {:else}
            <h2>You are signed out</h2>
            {#if $authStore.error}
                <p class="error">{$authStore.error}</p>
            {/if}
            <button on:click={() => authStore.login()}>
                Login with Instrumenta
            </button>
        {/if}
        <!-- <details style="margin-top: 1rem; text-align: left;">
            <summary>Debug: Cookies ({cookies.length})</summary>

            {#if cookies.length === 0}
                <p><em>No accessible cookies found</em></p>
            {:else}
                <ul class="cookie-list">
                    {#each cookies as cookie}
                        <li>
                            <strong>{cookie.name}</strong> = {cookie.value}
                        </li>
                    {/each}
                </ul>
            {/if}
        </details> -->
    </div>
</div>

<style>
    .modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1000;
    }
    .cookie-list {
        margin-top: 0.5rem;
        padding-left: 1rem;
        font-family: monospace;
        font-size: 0.85rem;
        max-height: 150px;
        overflow-y: auto;
    }
    .content {
        background: white;
        padding: 2rem;
        border-radius: 0.5rem;
        max-width: 400px;
        width: 100%;
        text-align: center;
    }

    .error {
        color: red;
        margin: 1rem 0;
    }

    button {
        background: #007bff;
        color: white;
        border: none;
        padding: 0.75rem 1.5rem;
        border-radius: 0.25rem;
        cursor: pointer;
        font-size: 1rem;
        transition: opacity 0.2s;
    }

    button:hover {
        opacity: 0.9;
    }

    button:disabled {
        opacity: 0.7;
        cursor: not-allowed;
    }
</style>
