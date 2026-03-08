<script>
    import { onMount, onDestroy, untrack } from "svelte";
    import Grid from "./Grid.svelte";
    import FormulaBar from "./FormulaBar.svelte";
    import SheetTabs from "./SheetTabs.svelte";
    import Toolbar from "./Toolbar.svelte";
    import {
        spreadsheetSession,
        selectionState,
        loadDocument,
        unloadDocument,
    } from "../../stores/spreadsheetStore.svelte.js";

    let { docId } = $props();

    let isLoading = $state(true);
    let error = $state(null);
    let currentLoadedDocId = $state.raw(null); // Track what we've actually loaded (raw to avoid reactivity)
    let isLoadInProgress = false; // Guard against concurrent loads

    // Subscribe to session state
    let sheets = $derived(spreadsheetSession.sheets);
    let activeSheetId = $derived(spreadsheetSession.activeSheetId);
    let canUndo = $derived(spreadsheetSession.canUndo);
    let canRedo = $derived(spreadsheetSession.canRedo);

    // Selection for formula bar
    // Svelte 5 fine-grained reactivity handles updates automatically
    let selectedCell = $derived.by(() => {
        const anchor = selectionState.anchor;
        if (!anchor) return null;

        return {
            row: anchor.row,
            col: anchor.col,
            value: spreadsheetSession.getCellDisplayValue(
                anchor.row,
                anchor.col,
            ),
            raw: spreadsheetSession.getCell(anchor.row, anchor.col),
        };
    });

    async function loadDoc(id) {
        console.log("[SpreadsheetWorkspace] loadDoc() called with id:", id);

        if (!id) {
            console.log("[SpreadsheetWorkspace] No id provided, returning");
            return;
        }

        // Guard against loading the same doc or concurrent loads
        if (isLoadInProgress) {
            console.log(
                "[SpreadsheetWorkspace] Load already in progress, returning",
            );
            return;
        }

        if (id === currentLoadedDocId && !error) {
            console.log(
                "[SpreadsheetWorkspace] Already loaded this doc, returning early",
            );
            return;
        }

        isLoadInProgress = true;
        console.log("[SpreadsheetWorkspace] Starting document load...");
        isLoading = true;
        error = null;

        try {
            console.log("[SpreadsheetWorkspace] Calling loadDocument()...");
            await loadDocument(id);
            console.log("[SpreadsheetWorkspace] loadDocument() returned");
            currentLoadedDocId = id;
        } catch (e) {
            console.error("[SpreadsheetWorkspace] Failed to load document:", e);
            error = e.message;
        } finally {
            console.log("[SpreadsheetWorkspace] Setting isLoading=false");
            isLoading = false;
            isLoadInProgress = false;
            console.log("[SpreadsheetWorkspace] loadDoc() complete");
        }
    }

    // Use onMount for initial load
    onMount(() => {
        console.log("[SpreadsheetWorkspace] onMount, docId:", docId);
        if (docId) {
            loadDoc(docId);
        }
    });

    // Use $effect only for docId changes after mount
    $effect(() => {
        // Only react to docId changes, and only if it's different from what we've loaded
        if (docId && docId !== currentLoadedDocId && !isLoadInProgress) {
            console.log("[SpreadsheetWorkspace] docId changed to:", docId);
            loadDoc(docId);
        }
    });

    onDestroy(() => {
        // Optionally unload document when leaving
        // unloadDocument();
    });

    function handleCellEdit(row, col, value) {
        spreadsheetSession.setCell(row, col, value);
    }

    function handleUndo() {
        spreadsheetSession.undo();
    }

    function handleRedo() {
        spreadsheetSession.redo();
    }

    function handleSheetChange(sheetId) {
        spreadsheetSession.setActiveSheet(sheetId);
    }

    function handleAddSheet(name) {
        return spreadsheetSession.addSheet(name);
    }

    function handleDeleteSheet(sheetId) {
        spreadsheetSession.deleteSheet(sheetId);
    }

    function handleRenameSheet(sheetId, name) {
        spreadsheetSession.renameSheet(sheetId, name);
    }

    function handleCloseDocument() {
        window.location.hash = "";
    }
</script>

<div class="spreadsheet-workspace">
    {#if isLoading}
        <div class="loading-state">
            <div class="spinner"></div>
            <p>Loading spreadsheet...</p>
        </div>
    {:else if error}
        <div class="error-state">
            <p class="text-red-500">Failed to load: {error}</p>
            <button
                class="px-4 py-2 bg-blue-500 text-white rounded"
                onclick={loadDoc}
            >
                Retry
            </button>
        </div>
    {:else}
        <div class="workspace-container">
            <!-- Toolbar -->
            <Toolbar onClose={handleCloseDocument} />

            <!-- Formula Bar -->
            <FormulaBar
                {selectedCell}
                onEdit={(value, row, col) => {
                    // Use provided row/col if available (from editingCell tracking)
                    // otherwise fall back to current anchor
                    const targetRow = row ?? selectionState.anchor?.row;
                    const targetCol = col ?? selectionState.anchor?.col;
                    if (targetRow !== undefined && targetCol !== undefined) {
                        handleCellEdit(targetRow, targetCol, value);
                    }
                }}
            />

            <!-- Main Grid -->
            <div class="grid-container">
                <Grid />
            </div>

            <!-- Sheet Tabs -->
            <SheetTabs
                {sheets}
                {activeSheetId}
                onSheetChange={handleSheetChange}
                onAddSheet={handleAddSheet}
                onDeleteSheet={handleDeleteSheet}
                onRenameSheet={handleRenameSheet}
            />
        </div>
    {/if}
</div>

<style>
    .spreadsheet-workspace {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        min-height: 0;
    }

    .loading-state,
    .error-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        gap: 1rem;
    }

    .spinner {
        border: 3px solid #f3f3f3;
        border-top: 3px solid #3498db;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .workspace-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        min-height: 0;
    }

    .grid-container {
        flex: 1;
        overflow: hidden;
        min-height: 0;
        border-top: 1px solid var(--border-color, #e2e8f0);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
    }
</style>
