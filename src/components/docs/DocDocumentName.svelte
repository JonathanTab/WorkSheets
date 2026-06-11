<script>
    /**
     * DocDocumentName — docs adapter around the shared DocumentNameBar.
     * Wires the docs session's id/title/rename; all UI lives in the shared
     * component (src/components/ui/DocumentNameBar.svelte).
     */
    import {
        docSession,
        renameDocument,
    } from "../../stores/docs/docStore.svelte.js";
    import DocumentNameBar from "../ui/DocumentNameBar.svelte";

    async function handleRename(newTitle) {
        const docId = docSession.docId;
        if (docId) await renameDocument(docId, newTitle);
    }
</script>

<DocumentNameBar
    docId={docSession.docId}
    title={docSession.metadata?.title || "Untitled"}
    onRename={handleRename}
    tabTitleSuffix="Documents"
/>
