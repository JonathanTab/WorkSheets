<script>
    import { onDestroy } from "svelte";
    import DriveBrowser from "../components/DriveBrowser.svelte";
    import SpreadsheetWorkspace from "../components/spreadsheet/SpreadsheetWorkspace.svelte";
    import DocWorkspace from "../components/docs/DocWorkspace.svelte";
    import SvgWorkspace from "../components/svg/SvgWorkspace.svelte";
    import { spreadsheetSession } from "../stores/spreadsheetStore.svelte.js";
    import { router } from "../lib/router.svelte.js";
    import storage from "../stores/storage.js";

    const APP_NAME = "WorkSheets";

    let route = $derived(router.route);

    // Reactively update document title
    $effect(() => {
        const view = route.view;
        if (view === 'sheet') {
            const docTitle = spreadsheetSession.metadata?.title ?? spreadsheetSession.metadata?.name;
            document.title = docTitle ? `${docTitle} — ${APP_NAME}` : APP_NAME;
        } else if (view === 'doc') {
            document.title = APP_NAME;
        } else {
            document.title = APP_NAME;
        }
    });
</script>

<div class="home-container">
    {#if route.view === 'sheet'}
        <SpreadsheetWorkspace docId={route.docId} registry={storage} />
    {:else if route.view === 'doc'}
        <DocWorkspace docId={route.docId} registry={storage} />
    {:else if route.view === 'svg'}
        <SvgWorkspace docId={route.docId} registry={storage} />
    {:else}
        <DriveBrowser registry={storage} />
    {/if}
</div>

<style>
    .home-container {
        width: 100%;
        height: 100%;
        overflow: hidden;
    }
</style>
