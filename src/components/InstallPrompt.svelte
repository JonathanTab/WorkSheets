<script>
    import { onMount } from "svelte";

    let isMobile = false;
    let isStandalone = false;
    let isDevelopment = false;
    let appName = "My PWA App";
    let appDescription =
        "An amazing Progressive Web App built with Vite and Svelte.";
    let appIcon = "/pwa-512x512.png";

    onMount(() => {
        isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        isStandalone =
            window.matchMedia("(display-mode: standalone)").matches ||
            navigator.standalone === true;
        isDevelopment =
            window.location.hostname === "localhost" ||
            window.location.hostname === "127.0.0.1" ||
            window.location.port !== "";

        // Accessing manifest data from the DOM
        const manifestLink = document.querySelector('link[rel="manifest"]');
        if (manifestLink) {
            const manifestUrl = manifestLink.href;
            fetch(manifestUrl)
                .then((response) => response.json())
                .then((manifest) => {
                    appName = manifest.name || appName;
                    appDescription = manifest.description || appDescription;
                    appIcon =
                        manifest.icons?.find((icon) => icon.sizes === "512x512")
                            ?.src || appIcon;
                })
                .catch((error) =>
                    console.error("Error loading manifest:", error),
                );
        }
    });
</script>

{#if isMobile && !isStandalone && !isDevelopment}
    <div class="install-overlay">
        <div class="install-card">
            <img src={appIcon} alt="App Icon" class="app-icon" />
            <div class="app-title">{appName}</div>
            <div class="app-description">{appDescription}</div>
            <div class="instruction">
                To install,
                {#if /android/i.test(navigator.userAgent)}
                    tap the ⋮ menu in your browser > Add to Home screen
                {:else if /iPad|iPhone|iPod/.test(navigator.userAgent)}
                    tap the Share button
                    <div class="ios-share-icon">
                        <svg
                            fill="#000000"
                            viewBox="0 0 50 50"
                            xmlns="http://www.w3.org/2000/svg"
                        >
                            <g id="SVGRepo_bgCarrier" stroke-width="0"></g>
                            <g
                                id="SVGRepo_tracerCarrier"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            ></g>
                            <g id="SVGRepo_iconCarrier">
                                <path
                                    d="M30.3 13.7L25 8.4l-5.3 5.3-1.4-1.4L25 5.6l6.7 6.7z"
                                ></path>
                                <path d="M24 7h2v21h-2z"></path>
                                <path
                                    d="M35 40H15c-1.7 0-3-1.3-3-3V19c0-1.7 1.3-3 3-3h7v2h-7c-.6 0-1 .4-1 1v18c0 .6.4 1 1 1h20c.6 0 1-.4 1-1V19c0-.6-.4-1-1-1h-7v-2h7c1.7 0 3 1.3 3 3v18c0 1.7-1.3 3-3 3z"
                                ></path>
                            </g>
                        </svg>
                    </div>
                    then tap "Add to Home Screen"
                {:else}
                    Install this app using your browser's install option.
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .install-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(255, 255, 255, 0.96);
        z-index: 9999;
        display: flex;
        justify-content: center;
        align-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
            sans-serif;
    }
    .install-card {
        background: white;
        padding: 1.5rem;
        border-radius: 1rem;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
        text-align: center;
        max-width: 22rem;
        width: 85vw;
    }
    .app-icon {
        width: 72px;
        height: 72px;
        border-radius: 16px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
        margin-bottom: 1rem;
    }
    .app-title {
        font-size: 1.25rem;
        font-weight: 600;
        margin-bottom: 0.25rem;
    }
    .app-description {
        font-size: 0.95rem;
        color: #374151;
        margin-bottom: 1rem;
    }
    .instruction {
        font-size: 0.85rem;
        color: #4b5563;
    }
    .ios-share-icon {
        display: inline-block;
        margin-left: 0.5rem;
        vertical-align: middle;
    }
    .ios-share-icon svg {
        width: 20px;
        height: 20px;
    }
</style>
