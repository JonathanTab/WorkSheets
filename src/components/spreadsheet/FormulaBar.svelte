<script>
    import {
        spreadsheetSession,
        selectionState,
    } from "../../stores/spreadsheetStore.svelte.js";
    import { editSessionState } from "../../stores/spreadsheet/index.js";
    import { segmentFormula } from "../../formulas/reference-highlighter.js";
    import {
        isRichText,
        richTextToPlain,
    } from "../../stores/spreadsheet/richText.js";
    import { CELL_TYPE } from "../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
    import { untrack } from "svelte";
    import FormulaValuePopup from "./FormulaValuePopup.svelte";
    import { close, check } from "../../lib/icons/index.js";
    import { toCellRef } from "../../stores/spreadsheet/FormulaEditState.svelte.js";
    import { mobileState } from "../../stores/mobileState.svelte.js";

    /** Get the raw editable value for a cell, including table cells. */
    function getTableAwareEditValue(row, col) {
        const renderContext = spreadsheetSession.renderContext;
        if (!renderContext)
            return spreadsheetSession.getCellEditValue(row, col);
        const cellType = renderContext.getCellType(row, col);
        if (cellType === CELL_TYPE.TABLE_DATA) {
            const info = renderContext.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                return (
                    info.table.getValue(info.dataIndex, info.colDef.id) ?? ""
                );
            }
        }
        if (cellType === CELL_TYPE.TABLE_ENTRY) {
            const info = renderContext.tableManager?.getCellInfo(row, col);
            if (info?.table && info.colDef) {
                return info.table.entryBuffer?.[info.colDef.id] ?? "";
            }
        }
        if (cellType === CELL_TYPE.TABLE_HEADER) {
            const info = renderContext.tableManager?.getCellInfo(row, col);
            return info?.colDef?.name ?? "";
        }
        return spreadsheetSession.getCellEditValue(row, col);
    }

    let { selectedCell = null, onEdit, floating = false } = $props();

    let previousCellKey = $state(null); // Track previous cell to detect actual cell changes
    let editInputEl = $state(null);
    let captureInputEl = $state(null);
    let formulaOverlayEl = $state(null);

    // Cell reference — shows origin cell during editing, active anchor otherwise.
    // When editing cross-sheet (formula started on a different sheet), shows "SheetName!A1".
    let cellRef = $derived.by(() => {
        if (editSessionState.isEditing && editSessionState.cell) {
            const cell = editSessionState.cell;
            const ref = toCellRef(cell.row, cell.col);
            const editingSheetId = editSessionState.editingSheetId;
            const activeSheetId = spreadsheetSession.activeSheetId;
            if (editingSheetId && editingSheetId !== activeSheetId) {
                // Cross-sheet: show full qualified ref
                const sheetName =
                    spreadsheetSession.getSheetName(editingSheetId);
                return `${sheetName}!${ref}`;
            }
            return ref;
        }
        if (!selectedCell) return "";
        return toCellRef(selectedCell.row, selectedCell.col);
    });

    // Current cell key for tracking
    let currentCellKey = $derived(
        selectedCell ? `${selectedCell.row},${selectedCell.col}` : null,
    );

    // Display value - show formula if present, plain text for rich text cells
    let displayValue = $derived(() => {
        if (!selectedCell) return "";
        const raw = getTableAwareEditValue(selectedCell.row, selectedCell.col);
        // Convert rich text to plain text for display in the formula bar
        if (isRichText(raw)) return richTextToPlain(raw);
        return raw ?? "";
    });

    // Edit value - show raw value (formula if present)
    let editStartValue = $derived(() => {
        if (!selectedCell) return "";
        return getTableAwareEditValue(selectedCell.row, selectedCell.col) ?? "";
    });

    let isEditing = $derived(editSessionState.isEditing);
    let editValue = $derived(editSessionState.draft);

    // Check if selected cell contains rich text (whether editing or not)
    let selectedCellHasRichText = $derived(() => {
        if (!selectedCell) return false;
        const rawVal = editStartValue();
        return isRichText(rawVal);
    });

    // During editing, also check active edit session state
    let hasRichText = $derived(
        editSessionState.richTextValue !== null || selectedCellHasRichText(),
    );

    // Check if we're editing a formula
    let isFormulaMode = $derived(isEditing && editValue?.startsWith("="));

    // Get colored segments for formula display
    let formulaSegments = $derived(
        isFormulaMode ? segmentFormula(editValue) : [],
    );

    function startEdit() {
        if (!selectedCell) return;

        // Rich text cells must be edited in the cell editor, not the formula bar.
        // Check both the active session state AND the raw cell value (when not yet editing).
        const rawVal = editStartValue();
        if (hasRichText || isRichText(rawVal)) return;

        // If already editing this cell (on grid), switch surface to formula bar
        if (
            editSessionState.isEditingCell(selectedCell.row, selectedCell.col)
        ) {
            editSessionState.switchSurface("formulaBar", { focus: true });
        } else {
            // Otherwise, start a new edit on formula bar
            editSessionState.beginEdit(
                selectedCell.row,
                selectedCell.col,
                rawVal,
                "formulaBar",
                { sheetId: spreadsheetSession.activeSheetId },
            );
        }
    }

    function blurMobileKeyboard() {
        if (!mobileState.isMobile) return;
        setTimeout(() => {
            editInputEl?.blur();
            captureInputEl?.blur();
        }, 0);
    }

    function focusNoScroll(el, { select = false } = {}) {
        if (!el) return;
        // Synchronously prevent iOS from scrolling the page body when an input is focused.
        if (mobileState.isMobile) window.scrollTo(0, 0);
        try {
            el.focus({ preventScroll: true });
        } catch {
            el.focus();
        }
        if (mobileState.isMobile) window.scrollTo(0, 0);
        if (select && typeof el.select === "function") {
            el.select();
        }
    }

    function enforcePageTop() {
        if (!mobileState.isMobile) return;
        if (window.scrollY !== 0 || (window.visualViewport?.offsetTop ?? 0) !== 0) {
            window.scrollTo(0, 0);
        }
    }

    function moveSelection(dRow, dCol) {
        const rowCount = spreadsheetSession.activeSheetStore?.rowCount;
        const colCount = spreadsheetSession.activeSheetStore?.colCount;
        selectionState.moveSelection(dRow, dCol, false, rowCount, colCount);
        selectionState.endSelection();
    }

    function navigateMobile(dRow, dCol) {
        if (isEditing) commitEdit({ blurKeyboard: false });
        moveSelection(dRow, dCol);
        if (mobileState.isMobile) captureKeyboardFocus();
    }

    function getEditingTableContext() {
        const cell = editSessionState.cell;
        if (!cell) return null;
        const renderContext = spreadsheetSession.renderContext;
        if (!renderContext) return null;
        const cellType = renderContext.getCellType(cell.row, cell.col);
        const info = renderContext.tableManager?.getCellInfo(cell.row, cell.col);
        if (!info?.table || !info.colDef) return null;
        return { cellType, info, row: cell.row, col: cell.col };
    }

    function commitAndMoveDown() {
        const tableCtx = getEditingTableContext();
        if (isEditing) commitEdit({ blurKeyboard: false });

        if (tableCtx?.cellType === CELL_TYPE.TABLE_ENTRY) {
            tableCtx.info.table.commitEntry();
            const firstEditable = tableCtx.info.table.columns.findIndex(
                (c) => !c.isNonEntry,
            );
            if (firstEditable >= 0) {
                const targetCol = tableCtx.info.table.startCol + firstEditable;
                selectionState.startSelection(tableCtx.row, targetCol);
                selectionState.endSelection();
            }
            if (mobileState.isMobile) captureKeyboardFocus();
            return;
        }

        moveSelection(1, 0);
        if (mobileState.isMobile) captureKeyboardFocus();
    }

    export function captureKeyboardFocus() {
        if (!mobileState.isMobile) return false;
        focusNoScroll(captureInputEl);
        requestAnimationFrame(() => enforcePageTop());
        return document.activeElement === captureInputEl;
    }

    function commitEdit(options = {}) {
        const { blurKeyboard = true } = options;
        // Rich text sessions are always committed by the cell's contenteditable editor.
        // The formula bar must never commit the plain-text draft over a rich text value.
        if (hasRichText) {
            editSessionState.cancel();
            if (blurKeyboard) blurMobileKeyboard();
            return;
        }

        const editingSheetId = editSessionState.editingSheetId;
        const payload = editSessionState.commit();
        if (!payload) return;
        onEdit?.(payload.value, payload.row, payload.col, editingSheetId);
        // Return to origin sheet if we navigated away for cross-sheet ref picking
        if (
            editingSheetId &&
            editingSheetId !== spreadsheetSession.activeSheetId
        ) {
            spreadsheetSession.setActiveSheet(editingSheetId);
        }
        if (blurKeyboard) blurMobileKeyboard();
    }

    function cancelEdit() {
        const editingSheetId = editSessionState.editingSheetId;
        editSessionState.cancel();
        if (
            editingSheetId &&
            editingSheetId !== spreadsheetSession.activeSheetId
        ) {
            spreadsheetSession.setActiveSheet(editingSheetId);
        }
        blurMobileKeyboard();
    }

    function handleKeydown(e) {
        if (e.key === "Enter") {
            if (mobileState.isMobile) commitAndMoveDown();
            else commitEdit();
            e.preventDefault();
        } else if (e.key === "Escape") {
            cancelEdit();
            e.preventDefault();
        } else if (e.key === "Tab") {
            // Commit and let the grid move selection (Tab = right, Shift+Tab = left)
            commitEdit();
            e.preventDefault();
        }
    }

    function handleInput(e) {
        editSessionState.updateDraft(
            e.target.value,
            e.target.selectionStart,
            e.target.selectionEnd,
        );
        syncFormulaOverlayScrollFromEvent(e);
    }

    function handleSelect(e) {
        editSessionState.setCursor(
            e.target.selectionStart,
            e.target.selectionEnd,
        );
        syncFormulaOverlayScrollFromEvent(e);
    }

    function syncFormulaOverlayScrollFromEvent(e) {
        const target = /** @type {HTMLInputElement | null} */ (e?.target ?? null);
        if (!target) return;
        syncFormulaOverlayScroll(target.scrollLeft || 0);
    }

    function syncFormulaOverlayScrollFromInput() {
        syncFormulaOverlayScroll(editInputEl?.scrollLeft || 0);
    }

    function syncFormulaOverlayScroll(scrollLeft = 0) {
        if (!formulaOverlayEl) return;
        // Sync by setting scrollLeft on the overlay container — avoids the GPU-layer
        // pre-clipping bug that happens when will-change:transform is inside overflow:hidden.
        formulaOverlayEl.scrollLeft = scrollLeft;
    }

    $effect(() => {
        editSessionState.setFocusHandle("formulaBar", () => {
            if (editInputEl) focusNoScroll(editInputEl);
            else if (mobileState.isMobile) focusNoScroll(captureInputEl);
            // Double rAF: first frame lets iOS settle, second corrects any residual scroll.
            requestAnimationFrame(() => {
                enforcePageTop();
                requestAnimationFrame(enforcePageTop);
            });
        });
        return () => {
            editSessionState.clearFocusHandle("formulaBar");
        };
    });

    $effect(() => {
        if (isEditing && editSessionState.surface === "formulaBar") {
            editSessionState.requestFocus("formulaBar");
        }
    });

    // Keep formula color overlay text horizontally aligned with the real input.
    $effect(() => {
        const _editing = isEditing;
        const _formula = isFormulaMode;
        if (!_editing || !_formula || !editInputEl) {
            syncFormulaOverlayScroll(0);
            return;
        }
        let rafId = 0;
        const tick = () => {
            syncFormulaOverlayScrollFromInput();
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafId);
    });

    // Reset edit value ONLY when the cell actually changes (not on every reactive update)
    $effect(() => {
        const newKey = currentCellKey;
        if (newKey !== previousCellKey) {
            // Cell selection changed - update the edit value
            untrack(() => {
                if (!isEditing && selectedCell) {
                    // keep local display in sync only when idle
                }
            });
            previousCellKey = newKey;
        }
    });
</script>

<div
    class="formula-bar"
    class:floating
    style={floating
        ? `bottom: ${Math.max(mobileState.viewportKeyboardHeight, 36)}px`
        : ""}
>
    <div class="formula-bar-row">
        <div class="cell-reference">
            {cellRef || "-"}
        </div>
        <div class="divider"></div>
        <div class="edit-buttons">
            <button
                class="btn-cancel"
                onclick={cancelEdit}
                onmousedown={(e) => e.preventDefault()}
                disabled={!isEditing || hasRichText}
                title="Cancel (Escape)"
                aria-label="Cancel edit"
            >
                <span class="icon">{@html close}</span>
            </button>
            <button
                class="btn-accept"
                onclick={commitEdit}
                onmousedown={(e) => e.preventDefault()}
                disabled={!isEditing || hasRichText}
                title="Accept (Enter)"
                aria-label="Accept edit"
            >
                <span class="icon">{@html check}</span>
            </button>
        </div>
        <div class="divider"></div>
        <div class="formula-input">
            {#if selectedCellHasRichText()}
                <!-- Show rich text notice when rich text cell is selected (regardless of editing) -->
                <div class="edit-container rich-text-notice">
                    <span class="notice-text">
                        Edit rich text formatting in the cell ⬇️
                    </span>
                </div>
            {:else if isEditing}
                <div class="edit-container" class:has-formula={isFormulaMode}>
                    <input
                        type="text"
                        bind:this={editInputEl}
                        value={editValue}
                        onmousedown={(e) => {
                            e.stopPropagation();
                            // Switch to formula bar surface BEFORE blur fires on grid cell
                            // This prevents the grid cell's blur handler from committing
                            if (editSessionState.isEditing) {
                                editSessionState.switchSurface("formulaBar", {
                                    focus: false,
                                });
                            }
                        }}
                        onkeydown={handleKeydown}
                        oninput={handleInput}
                        onselect={handleSelect}
                        onscroll={syncFormulaOverlayScrollFromInput}
                        onkeyup={syncFormulaOverlayScrollFromInput}
                        onclick={syncFormulaOverlayScrollFromInput}
                        class="edit-input"
                    />
                    {#if isFormulaMode}
                        <!-- Color overlay for references -->
                        <div class="formula-overlay" aria-hidden="true" bind:this={formulaOverlayEl}>
                            <span
                                class="formula-overlay-text"
                                >{#each formulaSegments as segment}{#if segment.color}<span
                                            style="color: {segment.color}; font-weight: 600;"
                                            >{segment.text}</span
                                        >{:else if segment.type === "FUNCTION"}<span
                                            class="formula-function"
                                            >{segment.text}</span
                                        >{:else}<span>{segment.text}</span
                                        >{/if}{/each}</span
                            >
                        </div>
                        <!-- Real-time computed value popup -->
                        <FormulaValuePopup formula={editValue} visible={true} />
                    {/if}
                </div>
            {:else}
                <div
                    class="display-value"
                    onclick={(e) => {
                        e.stopPropagation();
                        startEdit();
                    }}
                    role="button"
                    tabindex="0"
                    onkeydown={(e) => {
                        if (e.key === "Enter") {
                            e.stopPropagation();
                            startEdit();
                        }
                    }}
                >
                    {displayValue()}
                </div>
            {/if}
        </div>
    </div>
    <!-- end .formula-bar-row -->
    <input
        bind:this={captureInputEl}
        class="capture-input"
        type="text"
        tabindex="-1"
        aria-hidden="true"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
    />
    {#if mobileState.isMobile}
        <div class="mobile-nav-row">
            <button class="mobile-nav-btn" onclick={() => navigateMobile(0, -1)}>
                Prev
            </button>
            <button class="mobile-nav-btn" onclick={() => navigateMobile(0, 1)}>
                Next
            </button>
            <button class="mobile-nav-btn primary" onclick={() => commitEdit({ blurKeyboard: true })}>
                Commit
            </button>
            <button class="mobile-nav-btn primary" onclick={commitAndMoveDown}>
                Newline
            </button>
        </div>
    {/if}
</div>

<style>
    .formula-bar {
        display: flex;
        flex-direction: column;
        background: var(--formula-bar-bg, #ffffff);
        border-bottom: 1px solid var(--border-color, #e2e8f0);
    }

    .formula-bar-row {
        display: flex;
        align-items: center;
        padding: 0.25rem 0.5rem;
        min-height: 36px;
    }

    .cell-reference {
        min-width: 60px;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0.25rem 0.5rem;
        font-family: monospace;
        font-size: 0.875rem;
        text-align: center;
        background: var(--cell-ref-bg, #f1f5f9);
        border-radius: 4px;
        color: var(--text-color, #1e293b);
    }

    .divider {
        width: 1px;
        height: 24px;
        background: var(--border-color, #e2e8f0);
        margin: 0 0.5rem;
    }

    .edit-buttons {
        display: flex;
        gap: 0.25rem;
    }

    .edit-buttons button {
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        transition:
            opacity 0.15s,
            background-color 0.15s;
    }

    .btn-cancel {
        background-color: #fee2e2;
        color: #dc2626;
    }

    .btn-cancel:hover:not(:disabled) {
        background-color: #fecaca;
    }

    .btn-accept {
        background-color: #dcfce7;
        color: #16a34a;
    }

    .btn-accept:hover:not(:disabled) {
        background-color: #bbf7d0;
    }

    .edit-buttons button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .formula-input {
        flex: 1;
        min-width: 0;
        position: relative;
    }

    .capture-input {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
        left: 0;
        bottom: 0;
    }

    .mobile-nav-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.375rem;
        padding: 0.375rem 0.5rem 0.5rem;
        border-top: 1px solid var(--border-color, #e2e8f0);
    }

    .mobile-nav-btn {
        border: 1px solid var(--border-color, #cbd5e1);
        border-radius: 8px;
        background: var(--formula-nav-btn-bg, #f8fafc);
        color: var(--text-color, #0f172a);
        font-size: 0.8125rem;
        font-weight: 600;
        padding: 0.5rem 0.375rem;
        min-height: 36px;
        touch-action: manipulation;
    }

    .mobile-nav-btn.primary {
        background: var(--formula-nav-btn-primary-bg, #e2e8f0);
    }

    .display-value {
        padding: 0.25rem 0.5rem;
        font-size: 0.875rem;
        cursor: text;
        height: 28px;
        box-sizing: border-box;
        border-radius: 4px;
        border: 2px solid transparent;
        font-family: monospace;
        line-height: 20px;
    }

    .display-value:hover {
        background: var(--hover-bg, #f1f5f9);
    }

    .display-value:focus {
        outline: 2px solid var(--focus-color, #3b82f6);
        outline-offset: -2px;
    }

    .edit-container {
        position: relative;
    }

    .edit-container.rich-text-notice {
        display: flex;
        align-items: center;
        padding: 0.25rem 0.5rem;
        background: var(--info-bg, #eff6ff);
        border: 2px solid var(--info-border, #3b82f6);
        border-radius: 4px;
        height: 28px;
        box-sizing: border-box;
    }

    .notice-text {
        font-size: 0.875rem;
        color: var(--info-text, #1e40af);
        font-style: italic;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .edit-input {
        width: 100%;
        padding: 0.25rem 0.5rem;
        font-size: 0.875rem;
        line-height: 20px;
        border: 2px solid var(--focus-color, #3b82f6);
        border-radius: 4px;
        outline: none;
        background: var(--input-bg, #ffffff);
        color: var(--text-color, #1e293b);
        font-family:
            ui-monospace,
            SFMono-Regular,
            Menlo,
            Monaco,
            Consolas,
            "Liberation Mono",
            "Courier New",
            monospace;
        font-variant-ligatures: none;
        letter-spacing: 0;
        position: relative;
        z-index: 2;
        height: 28px;
        box-sizing: border-box;
    }

    /* When editing a formula, make input text transparent to show overlay */
    .edit-container.has-formula .edit-input {
        color: transparent;
        background: transparent;
        caret-color: var(--text-color, #1e293b);
    }

    .formula-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 0.25rem 0.5rem;
        font-size: 0.875rem;
        line-height: 20px;
        pointer-events: none;
        /* Scrollable so we can sync scrollLeft with the real input — avoids the GPU-layer
           clipping bug that occurs with overflow:hidden + will-change:transform. */
        overflow-x: scroll;
        overflow-y: hidden;
        scrollbar-width: none; /* Firefox */
        font-family:
            ui-monospace,
            SFMono-Regular,
            Menlo,
            Monaco,
            Consolas,
            "Liberation Mono",
            "Courier New",
            monospace;
        font-variant-ligatures: none;
        letter-spacing: 0;
        z-index: 1;
        color: var(--text-color, #1e293b);
        /* Match the input styling */
        border: 2px solid var(--focus-color, #3b82f6);
        border-radius: 4px;
        background: var(--input-bg, #ffffff);
        /* Vertically center to match <input> behavior */
        display: flex;
        align-items: center;
    }

    .formula-overlay::-webkit-scrollbar {
        display: none; /* Chrome/Safari */
    }

    .formula-overlay-text {
        white-space: pre;
        min-width: 0;
        display: inline-block;
        line-height: inherit;
        flex-shrink: 0;
    }

    .formula-function {
        font-weight: 600;
        color: var(--function-color, #7c3aed);
    }

    /* ── Floating mode (mobile) ── */
    .formula-bar.floating {
        position: fixed;
        left: 0;
        right: 0;
        z-index: 200;
        border-top: 1px solid var(--color-border, #e2e8f0);
        border-bottom: none;
        box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.1);
    }

    /* ── Mobile: taller touch targets ── */
    @media (pointer: coarse), (max-width: 768px) {
        .formula-bar-row {
            min-height: 44px;
            padding: 0.25rem 0.5rem;
        }
        .edit-buttons button {
            width: 34px;
            height: 34px;
            font-size: 1rem;
        }
        .cell-reference {
            min-width: 50px;
            font-size: 0.8rem;
            padding: 0.2rem 0.4rem;
        }
        .display-value {
            height: 36px;
            line-height: 28px;
            font-size: 0.875rem;
        }
        .edit-input {
            height: 36px;
            font-size: 16px;
            line-height: 24px;
        }
        .formula-overlay {
            font-size: 16px;
            line-height: 24px;
        }
        .mobile-nav-btn {
            min-height: 40px;
            font-size: 0.875rem;
        }
    }
</style>
