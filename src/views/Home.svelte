<script>
    import { onMount, onDestroy } from "svelte";
    import DocumentPicker from "../components/DocumentPicker.svelte";
    import SpreadsheetWorkspace from "../components/spreadsheet/SpreadsheetWorkspace.svelte";
    import { spreadsheetSession } from "../stores/spreadsheetStore.svelte.js";

    const APP_NAME = "WorkSheets";

    // Current document ID from URL fragment
    let currentDocId = $state(null);

    // Parse URL hash to get document ID
    function parseHash() {
        const hash = window.location.hash.slice(1); // Remove the '#'
        return hash || null;
    }

    // Update URL hash
    function setHash(docId) {
        if (docId) {
            window.location.hash = docId;
        } else {
            history.pushState(
                "",
                document.title,
                window.location.pathname + window.location.search,
            );
        }
    }

    // Handle hash changes
    function handleHashChange() {
        currentDocId = parseHash();
    }

    // Update document title based on current state
    function updateTitle() {
        const docTitle =
            spreadsheetSession.metadata?.title ||
            spreadsheetSession.metadata?.name;
        if (currentDocId && docTitle) {
            document.title = `${docTitle} - ${APP_NAME}`;
        } else {
            document.title = APP_NAME;
        }
    }

    onMount(() => {
        // Set initial state from hash
        currentDocId = parseHash();

        // Listen for hash changes
        window.addEventListener("hashchange", handleHashChange);

        // Set initial title
        updateTitle();
    });

    onDestroy(() => {
        window.removeEventListener("hashchange", handleHashChange);
        // Reset title on unmount
        document.title = APP_NAME;
    });

    // Reactively update title when document or metadata changes
    $effect(() => {
        updateTitle();
    });
</script>

<div class="home-container">
    {#if currentDocId}
        <SpreadsheetWorkspace docId={currentDocId} />
    {:else}
        <DocumentPicker />
    {/if}
</div>

<style>
    .home-container {
        width: 100%;
        height: 100%;
        overflow: hidden;
    }
</style>
