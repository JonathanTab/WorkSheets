<script>
    import { onMount, onDestroy } from "svelte";
    import Grid from "./Grid.svelte";
    import FormulaBar from "./FormulaBar.svelte";
    import SheetTabs from "./SheetTabs.svelte";
    import Toolbar from "./Toolbar.svelte";
    import MobileToolbar from "./MobileToolbar.svelte";
    import HistoryPanel from "../HistoryPanel.svelte";
    import DocumentTablesPanel from "./features/DocumentTablesPanel.svelte";
    import { mobileState } from "../../stores/mobileState.svelte.js";
    import { computeSpreadsheetDiff } from "../../lib/spreadsheetDiff.js";
    import {
        spreadsheetSession,
        selectionState,
        loadDocument,
        unloadDocument,
    } from "../../stores/spreadsheetStore.svelte.js";
    import { editSessionState } from "../../stores/spreadsheet/index.js";
    import { toCellRef } from "../../stores/spreadsheet/FormulaEditState.svelte.js";
    import { CELL_TYPE } from "../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
    import { CellTypeRegistry } from "../../stores/spreadsheet/index.js";
    import { authStore } from "../../stores/authStore.js";
    import { router } from "../../lib/router.svelte.js";

    let { docId, registry = null } = $props();

    let isLoading = $state(true);
    let error = $state(null);
    let showHistory = $state(false);
    let showTablesPanel = $state(false);
    let formulaBarRef = $state(null);

    // ── Awareness / presence ───────────────────────────────────────────────────
    let awareness = $derived(spreadsheetSession.awareness);
    let currentUser = $derived($authStore.user?.username ?? "");

    // ── Page break overlay state ───────────────────────────────────────────────
    let showPageBreaks = $state(false);
    let pageBreakPrintSettings = $state(null);
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

    // ── Page break overlay event listener ─────────────────────────────────────
    function handleTogglePageBreaks(e) {
        showPageBreaks = e.detail.show;
        pageBreakPrintSettings = e.detail.settings ?? null;
    }

    const APP_NAME = "WorkSheets";

    $effect(() => {
        const meta = /** @type {any} */ (spreadsheetSession.metadata);
        const title = meta?.title ?? meta?.name;
        document.title = title ? `${title} — ${APP_NAME}` : APP_NAME;
    });

    // Use onMount for initial load
    onMount(async () => {
        if (docId) {
            loadDoc(docId);
        }
        document.addEventListener("togglePageBreaks", handleTogglePageBreaks);
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
        document.removeEventListener(
            "togglePageBreaks",
            handleTogglePageBreaks,
        );
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

    // Cross-sheet formula editing: true when editing a formula and navigated to another sheet
    let isCrossSheetFormulaEdit = $derived(
        editSessionState.isFormulaMode &&
            editSessionState.editingSheetId !== null &&
            editSessionState.editingSheetId !== activeSheetId,
    );

    let crossSheetOriginLabel = $derived.by(() => {
        if (!isCrossSheetFormulaEdit) return "";
        const cell = editSessionState.cell;
        if (!cell) return "";
        const sheetName = spreadsheetSession.getSheetName(
            editSessionState.editingSheetId,
        );
        const cellRef = toCellRef(cell.row, cell.col);
        return `${sheetName}!${cellRef}`;
    });

    function handleSheetChange(sheetId) {
        if (editSessionState.isFormulaMode) {
            // Stay in formula edit mode — just switch the sheet for reference picking.
            // Switch surface to formula bar so the input remains accessible while browsing.
            editSessionState.switchSurface("formulaBar", { focus: true });
            spreadsheetSession.setActiveSheet(sheetId);
            return;
        }
        spreadsheetSession.setActiveSheet(sheetId);
    }

    function handleCancelCrossSheetEdit() {
        const editingSheetId = editSessionState.editingSheetId;
        editSessionState.cancel();
        if (
            editingSheetId &&
            editingSheetId !== spreadsheetSession.activeSheetId
        ) {
            spreadsheetSession.setActiveSheet(editingSheetId);
        }
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

    function handleMoveSheet(sheetId, toIndex) {
        spreadsheetSession.moveSheet(sheetId, toIndex);
    }

    function handleCloseDocument() {
        router.goHome();
    }

    // Capture the hash present in the URL at the moment this component mounts
    // (before any effect can overwrite it with the default sheet id).
    const _initialHash = window.location.hash.slice(1);
    let _hashRestored = false;

    // After loading completes, restore the sheet from the captured hash once.
    // Then keep the hash in sync with every subsequent sheet change.
    $effect(() => {
        const sheetId = spreadsheetSession.activeSheetId;
        if (!sheetId) return;

        if (!_hashRestored && !isLoading && spreadsheetSession.sheets?.length) {
            _hashRestored = true;
            if (_initialHash && _initialHash !== sheetId) {
                const exists = spreadsheetSession.sheets.some(
                    (s) => s.id === _initialHash,
                );
                if (exists) {
                    spreadsheetSession.setActiveSheet(_initialHash);
                    return; // next run will update the hash
                }
            }
        }

        // Keep URL hash in sync with current sheet
        history.replaceState({}, "", window.location.pathname + "#" + sheetId);
    });
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
        <div class="workspace-outer">
            {#if showHistory && registry}
                <HistoryPanel
                    {registry}
                    fileId={docId}
                    currentDoc={spreadsheetSession.ydoc ?? null}
                    diffFn={computeSpreadsheetDiff}
                    onClose={() => { showHistory = false; }}
                />
            {/if}

            {#if showTablesPanel && !mobileState.isMobile}
                <DocumentTablesPanel
                    session={spreadsheetSession}
                    onClose={() => { showTablesPanel = false; }}
                />
            {/if}

            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="workspace-container" class:mobile={mobileState.isMobile} oncontextmenu={(e) => e.preventDefault()}>
                <!-- Toolbar: desktop two-row vs mobile single-row -->
                {#if mobileState.isMobile}
                    <MobileToolbar
                        onClose={handleCloseDocument}
                        {awareness}
                        {currentUser}
                    />
                {:else}
                    <Toolbar
                        onClose={handleCloseDocument}
                        {awareness}
                        {currentUser}
                        onShowHistory={registry ? () => { showHistory = true; } : undefined}
                        onShowTablesPanel={() => { showTablesPanel = !showTablesPanel; }}
                        tablesPanelOpen={showTablesPanel}
                        {registry}
                    />
                {/if}

                <!-- Formula Bar: static on desktop, floating on mobile -->
                <FormulaBar
                    bind:this={formulaBarRef}
                    floating={mobileState.isMobile}
                    {selectedCell}
                    onEdit={(value, row, col, sheetId) => {
                        // Use provided row/col if available (from editingCell tracking)
                        // otherwise fall back to current anchor
                        const targetRow = row ?? selectionState.anchor?.row;
                        const targetCol = col ?? selectionState.anchor?.col;
                        if (targetRow === undefined || targetCol === undefined)
                            return;

                        // Route table cell edits to the table store, not the sheet store
                        const renderContext = spreadsheetSession.renderContext;
                        if (renderContext) {
                            const cellType = renderContext.getCellType(
                                targetRow,
                                targetCol,
                            );
                            if (cellType === CELL_TYPE.TABLE_DATA) {
                                const info =
                                    renderContext.tableManager?.getCellInfo(
                                        targetRow,
                                        targetCol,
                                    );
                                if (
                                    info?.table &&
                                    info.colDef &&
                                    !info.colDef.isNonEntry
                                ) {
                                    const parsed = CellTypeRegistry.parseInput(
                                        { type: info.colDef.type },
                                        value,
                                    );
                                    info.table.updateCell(
                                        info.dataIndex,
                                        info.colDef.id,
                                        parsed,
                                    );
                                }
                                return;
                            }
                            if (cellType === CELL_TYPE.TABLE_ENTRY) {
                                const info =
                                    renderContext.tableManager?.getCellInfo(
                                        targetRow,
                                        targetCol,
                                    );
                                if (
                                    info?.table &&
                                    info.colDef &&
                                    !info.colDef.isNonEntry
                                ) {
                                    const parsed = CellTypeRegistry.parseInput(
                                        { type: info.colDef.type },
                                        value,
                                    );
                                    info.table.setEntryValue(
                                        info.colDef.id,
                                        parsed,
                                    );
                                }
                                return;
                            }
                            if (cellType === CELL_TYPE.TABLE_HEADER) {
                                const info =
                                    renderContext.tableManager?.getCellInfo(
                                        targetRow,
                                        targetCol,
                                    );
                                if (info?.table && info.colDef) {
                                    const newName = String(value ?? "").trim();
                                    if (newName)
                                        info.table.renameColumn(
                                            info.colDef.id,
                                            newName,
                                        );
                                }
                                return;
                            }
                        }

                        const targetSheetId =
                            sheetId ?? spreadsheetSession.activeSheetId;
                        if (
                            typeof value === "string" &&
                            value.startsWith("=")
                        ) {
                            spreadsheetSession.setCellFormulaOnSheet(
                                targetSheetId,
                                targetRow,
                                targetCol,
                                value,
                            );
                        } else {
                            spreadsheetSession.setCellValueOnSheet(
                                targetSheetId,
                                targetRow,
                                targetCol,
                                value,
                            );
                        }
                    }}
                />

                <!-- Main Grid -->
                <div class="grid-container">
                    <Grid
                        {showPageBreaks}
                        requestMobileKeyboardFocus={() =>
                            formulaBarRef?.captureKeyboardFocus?.()}
                        printSettings={pageBreakPrintSettings ??
                            spreadsheetSession.activeSheetStore?.getPrintSettings() ??
                            null}
                        onShowTablesPanel={() => { showTablesPanel = true; }}
                    />
                    {#if isCrossSheetFormulaEdit}
                        <div class="cross-sheet-indicator">
                            <span class="cross-sheet-icon">⊞</span>
                            <span class="cross-sheet-label"
                                >Editing <strong>{crossSheetOriginLabel}</strong
                                ></span
                            >
                            <span class="cross-sheet-hint"
                                >Click cells to add references · Enter to
                                confirm · Esc to cancel</span
                            >
                            <button
                                class="cross-sheet-cancel"
                                onclick={handleCancelCrossSheetEdit}
                                title="Cancel edit">✕</button
                            >
                        </div>
                    {/if}
                </div>

                <!-- Sheet Tabs -->
                <SheetTabs
                    {sheets}
                    {activeSheetId}
                    onSheetChange={handleSheetChange}
                    onAddSheet={handleAddSheet}
                    onDeleteSheet={handleDeleteSheet}
                    onRenameSheet={handleRenameSheet}
                    onMoveSheet={handleMoveSheet}
                />
            </div>
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

    .workspace-outer {
        display: flex;
        flex-direction: row;
        height: 100%;
        overflow: hidden;
        min-height: 0;
    }

    .workspace-container {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
        min-height: 0;
    }

    .grid-container {
        flex: 1;
        overflow: hidden;
        min-height: 0;
        border-top: 1px solid var(--border-color, #e2e8f0);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        position: relative;
    }

    .cross-sheet-indicator {
        position: absolute;
        bottom: 8px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 200;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.75rem;
        background: #1e40af;
        color: #fff;
        border-radius: 20px;
        font-size: 0.8125rem;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
        white-space: nowrap;
        pointer-events: auto;
    }

    .cross-sheet-icon {
        font-size: 0.875rem;
        opacity: 0.8;
    }

    .cross-sheet-label strong {
        font-weight: 700;
    }

    .cross-sheet-hint {
        opacity: 0.75;
        font-size: 0.75rem;
        border-left: 1px solid rgba(255, 255, 255, 0.3);
        padding-left: 0.5rem;
    }

    .cross-sheet-cancel {
        background: rgba(255, 255, 255, 0.15);
        border: none;
        color: #fff;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 0.75rem;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        margin-left: 0.25rem;
    }

    .cross-sheet-cancel:hover {
        background: rgba(255, 255, 255, 0.25);
    }

    /* ── Mobile layout: formula bar floats at bottom ── */
    .workspace-container.mobile .grid-container {
        /* Grid fills up to the fixed-bottom formula bar + sheet tabs */
        border-bottom: none;
    }
</style>
