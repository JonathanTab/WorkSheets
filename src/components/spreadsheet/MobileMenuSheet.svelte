<script>
    /**
     * MobileMenuSheet — overflow menu bottom sheet for mobile.
     * Surfaces the key MenuBar actions in large-touch-target rows.
     */
    import BottomSheet from "../ui/BottomSheet.svelte";
    import {
        spreadsheetSession,
        selectionState,
    } from "../../stores/spreadsheetStore.svelte.js";
    import { clipboardManager } from "../../stores/spreadsheet/index.js";
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import AlertModal from "../modals/AlertModal.svelte";
    import TableCreateDialog from "./features/TableCreateDialog.svelte";
    import RepeaterCreateDialog from "./features/RepeaterCreateDialog.svelte";
    import ConditionalFormatPanel from "./ConditionalFormatPanel.svelte";
    import DataValidationPanel from "./DataValidationPanel.svelte";
    import FormulaDocsPanel from "./FormulaDocsPanel.svelte";

    let { open = false, onClose = undefined } = $props();

    let showCFPanel = $state(false);
    let showDVPanel = $state(false);
    let showFormulaDocs = $state(false);
    let showTableCreate = $state(false);
    let showRepeaterCreate = $state(false);

    function showAlert(title, message, type = "info") {
        openModal(AlertModal, { title, message, type });
    }

    function openPdfExport() {
        onClose?.();
        document.dispatchEvent(new CustomEvent('openPdfExport'));
    }

    function undo() { spreadsheetSession.undo(); onClose?.(); }
    function redo() { spreadsheetSession.redo(); onClose?.(); }

    let canUndo = $derived(spreadsheetSession.canUndo);
    let canRedo = $derived(spreadsheetSession.canRedo);
</script>

<!-- Main overflow sheet -->
<BottomSheet {open} {onClose} title="More" maxHeight="75vh">
    <div class="menu-sheet">

        <div class="menu-group-label">Edit</div>
        <button class="menu-item" disabled={!canUndo} onclick={undo}>↩ Undo</button>
        <button class="menu-item" disabled={!canRedo} onclick={redo}>↪ Redo</button>

        <div class="menu-divider"></div>
        <div class="menu-group-label">Insert</div>
        <button class="menu-item" onclick={() => { showTableCreate = true; onClose?.(); }}>⊞ Insert table</button>
        <button class="menu-item" onclick={() => { showRepeaterCreate = true; onClose?.(); }}>⟳ Insert repeater</button>

        <div class="menu-divider"></div>
        <div class="menu-group-label">Format</div>
        <button class="menu-item" onclick={() => { showCFPanel = true; onClose?.(); }}>⚡ Conditional formatting</button>
        <button class="menu-item" onclick={() => { showDVPanel = true; onClose?.(); }}>✔ Data validation</button>

        <div class="menu-divider"></div>
        <div class="menu-group-label">File</div>
        <button class="menu-item" onclick={openPdfExport}>⬇ Export PDF / Print</button>

        <div class="menu-divider"></div>
        <div class="menu-group-label">Help</div>
        <button class="menu-item" onclick={() => { showFormulaDocs = true; onClose?.(); }}>ƒ Formula reference</button>

        <div style="height: env(safe-area-inset-bottom, 16px)"></div>
    </div>
</BottomSheet>

<!-- Sub-panels (rendered outside the main BottomSheet so they can stack) -->
{#if showTableCreate}
    <TableCreateDialog onClose={() => (showTableCreate = false)} />
{/if}

{#if showRepeaterCreate}
    <RepeaterCreateDialog onClose={() => (showRepeaterCreate = false)} />
{/if}

{#if showCFPanel}
    <ConditionalFormatPanel onClose={() => (showCFPanel = false)} />
{/if}

{#if showDVPanel}
    <DataValidationPanel onClose={() => (showDVPanel = false)} />
{/if}

{#if showFormulaDocs}
    <FormulaDocsPanel onClose={() => (showFormulaDocs = false)} />
{/if}



<style>
    .menu-sheet {
        padding: 4px 0 8px;
    }

    .menu-group-label {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-text-secondary, #64748b);
        padding: 10px 16px 4px;
    }

    .menu-divider {
        height: 1px;
        background: var(--color-border, #e2e8f0);
        margin: 4px 0;
    }

    .menu-item {
        display: flex;
        align-items: center;
        width: 100%;
        padding: 14px 16px;
        background: transparent;
        border: none;
        font-size: 0.9375rem;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        text-align: left;
        -webkit-tap-highlight-color: transparent;
        min-height: 48px;
        gap: 10px;
    }

    .menu-item:active {
        background: var(--color-fill, #f1f5f9);
    }

    .menu-item:disabled {
        opacity: 0.4;
        cursor: default;
    }
</style>
