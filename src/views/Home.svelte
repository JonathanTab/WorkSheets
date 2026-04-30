<script>
    import { router } from "../lib/router.svelte.js";
    import storage from "../stores/storage.js";
    import { APP_SHEETS, APP_DOCS, APP_SVG } from "../lib/appTypes.js";

    const APP_NAME = "Scriptorium";

    let route = $derived(router.route);

    // Kick off all workspace imports immediately so every chunk is in-flight
    // on first load (and precached by the service worker for offline use).
    const sheetMod  = import("../components/spreadsheet/SpreadsheetWorkspace.svelte");
    const docMod    = import("../components/docs/DocWorkspace.svelte");
    const svgMod    = import("../components/svg/SvgWorkspace.svelte");
    const driveMod  = import("../components/DriveBrowser.svelte");

    $effect(() => {
        if (route.view === 'browser') {
            document.title = APP_NAME;
        }
    });
</script>

<div class="home-container">
    {#if route.view === APP_SHEETS}
        {#await sheetMod then { default: SpreadsheetWorkspace }}
            <SpreadsheetWorkspace docId={route.docId} registry={storage} />
        {/await}
    {:else if route.view === APP_DOCS}
        {#await docMod then { default: DocWorkspace }}
            <DocWorkspace docId={route.docId} registry={storage} />
        {/await}
    {:else if route.view === APP_SVG}
        {#await svgMod then { default: SvgWorkspace }}
            <SvgWorkspace docId={route.docId} registry={storage} />
        {/await}
    {:else}
        {#await driveMod then { default: DriveBrowser }}
            <DriveBrowser registry={storage} />
        {/await}
    {/if}
</div>

<style>
    .home-container {
        width: 100%;
        height: 100%;
        overflow: hidden;
    }
</style>
