<script>
    /**
     * DocumentName — spreadsheet adapter around the shared DocumentNameBar.
     * Wires the spreadsheet session's id/title/rename; all UI lives in the
     * shared component (src/components/ui/DocumentNameBar.svelte).
     */
    import {
        spreadsheetSession,
        renameDocument,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import DocumentNameBar from "../../ui/DocumentNameBar.svelte";

    async function handleRename(newTitle) {
        const docId = spreadsheetSession.docId;
        if (docId) await renameDocument(docId, newTitle);
    }
</script>

<DocumentNameBar
    docId={spreadsheetSession.docId}
    title={spreadsheetSession.docTitle || "Untitled"}
    onRename={handleRename}
    tabTitleSuffix="Scriptorium"
/>
