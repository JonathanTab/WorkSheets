<script>
    /**
     * MobileToolbar — single-row 44px top bar for the spreadsheet on mobile.
     * Packs in: Back | DocumentName | [Undo] [Redo] [B] [I] [Format▸] [⋮]
     * All remaining actions are in MobileFormattingSheet / MobileMenuSheet.
     */
    import MobileToolbarShell from "../ui/MobileToolbarShell.svelte";
    import DocumentName from "./toolbar/DocumentName.svelte";
    import MobileFormattingSheet from "./MobileFormattingSheet.svelte";
    import MobileMenuSheet from "./MobileMenuSheet.svelte";
    import { moreVertical } from "../../lib/icons/index.js";
    import { spreadsheetSession, selectionState } from "../../stores/spreadsheetStore.svelte.js";
    import { CELL_TYPE } from "../../stores/spreadsheet/features/SheetRenderContext.svelte.js";

    let {
        onClose = undefined,
        awareness = null,
        currentUser = "",
    } = $props();

    let showFormatSheet = $state(false);
    let showMenuSheet = $state(false);

    let canUndo = $derived(spreadsheetSession.canUndo);
    let canRedo = $derived(spreadsheetSession.canRedo);

    // Check bold/italic state at anchor cell for toolbar active state
    let isBold = $derived.by(() => {
        const anchor = selectionState.anchor;
        if (!anchor) return false;
        return spreadsheetSession.activeSheetStore?.getCell(anchor.row, anchor.col)?.bold === true;
    });
    let isItalic = $derived.by(() => {
        const anchor = selectionState.anchor;
        if (!anchor) return false;
        return spreadsheetSession.activeSheetStore?.getCell(anchor.row, anchor.col)?.italic === true;
    });

    function applyFormat(property, value) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
        if (!eff) return;
        spreadsheetSession.ydoc?.transact(() => {
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    const ct = spreadsheetSession.renderContext?.getCellType(r, c);
                    if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY ||
                        ct === CELL_TYPE.TABLE_DATA) continue;
                    sheetStore.setCellProperties(r, c, { [property]: value });
                }
            }
        });
    }

    function toggleBold() { applyFormat("bold", !isBold); }
    function toggleItalic() { applyFormat("italic", !isItalic); }
</script>

<MobileToolbarShell {onClose}>
    {#snippet titleContent()}
        <div class="doc-name-area">
            <DocumentName />
        </div>
    {/snippet}

    {#snippet actions()}
        <!-- Undo -->
        <button
            class="action-btn"
            onclick={() => spreadsheetSession.undo()}
            disabled={!canUndo}
            title="Undo"
            aria-label="Undo"
        >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
            </svg>
        </button>

        <!-- Redo -->
        <button
            class="action-btn"
            onclick={() => spreadsheetSession.redo()}
            disabled={!canRedo}
            title="Redo"
            aria-label="Redo"
        >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>
            </svg>
        </button>

        <!-- Bold -->
        <button
            class="action-btn text-action-btn"
            class:active={isBold}
            onclick={toggleBold}
            title="Bold"
            aria-label="Bold"
            aria-pressed={isBold}
        >
            <span class="bold-label">B</span>
        </button>

        <!-- Italic -->
        <button
            class="action-btn text-action-btn"
            class:active={isItalic}
            onclick={toggleItalic}
            title="Italic"
            aria-label="Italic"
            aria-pressed={isItalic}
        >
            <span class="italic-label">I</span>
        </button>

        <!-- Format (opens full formatting sheet) -->
        <button
            class="action-btn"
            onclick={() => (showFormatSheet = true)}
            title="Format"
            aria-label="Format cells"
        >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
        </button>

        <!-- More options -->
        <button
            class="action-btn"
            onclick={() => (showMenuSheet = true)}
            title="More options"
            aria-label="More options"
        >
            {@html moreVertical}
        </button>
    {/snippet}
</MobileToolbarShell>

<!-- Formatting bottom sheet -->
<MobileFormattingSheet
    open={showFormatSheet}
    onClose={() => (showFormatSheet = false)}
/>

<!-- Menu bottom sheet -->
<MobileMenuSheet
    open={showMenuSheet}
    onClose={() => (showMenuSheet = false)}
/>

<style>
    .doc-name-area {
        flex: 1;
        min-width: 0;
        overflow: hidden;
    }

    .action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: var(--color-text-secondary, #64748b);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        flex-shrink: 0;
    }

    .action-btn:active {
        background: var(--color-fill, #f1f5f9);
        color: var(--color-text, #1e293b);
    }

    .action-btn.active {
        background: var(--color-accent-muted, #dbeafe);
        color: var(--color-accent, #2563eb);
    }

    .action-btn:disabled {
        opacity: 0.3;
        pointer-events: none;
    }

    .bold-label {
        font-size: 15px;
        font-weight: 700;
        line-height: 1;
        font-family: serif;
    }

    .italic-label {
        font-size: 15px;
        font-weight: 600;
        font-style: italic;
        line-height: 1;
        font-family: serif;
    }
</style>
