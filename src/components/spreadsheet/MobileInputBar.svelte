<script>
    import { spreadsheetSession, selectionState } from "../../stores/spreadsheetStore.svelte.js";
    import { editSessionState } from "../../stores/spreadsheet/index.js";
    import { mobileState } from "../../stores/mobileState.svelte.js";
    import { toCellRef } from "../../formulas/refCoords.js";
    import { applyFormatting } from "../../stores/spreadsheet/cellFormattingCommands.js";
    import FormulaInput from "./FormulaInput.svelte";
    import MobileFormattingSheet from "./MobileFormattingSheet.svelte";

    let { selectedCell = null, onEdit } = $props();

    let inputComponent = $state(null); // FormulaInput instance
    let captureInputEl = $state(null);
    let showFormatSheet = $state(false);

    // ── Derived state ─────────────────────────────────────────────────────────

    let isEditing     = $derived(editSessionState.isEditing);
    let editValue     = $derived(editSessionState.draft ?? '');
    let isFormulaMode = $derived(isEditing && editValue.startsWith('='));
    let bottomOffset  = $derived(Math.max(mobileState.viewportKeyboardHeight, 0));

    let hasRichText = $derived(
        !!editSessionState.initialTfr ||
        !!(selectedCell && spreadsheetSession.activeSheetStore?.getCell(selectedCell.row, selectedCell.col)?.tfr?.length)
    );

    let cellRef = $derived.by(() => {
        if (editSessionState.isEditing && editSessionState.cell)
            return toCellRef(editSessionState.cell.row, editSessionState.cell.col);
        return selectedCell ? toCellRef(selectedCell.row, selectedCell.col) : '';
    });

    let displayValue = $derived.by(() => {
        if (!selectedCell) return '';
        void spreadsheetSession.activeSheetStore?.cellsVersion;
        const rc = spreadsheetSession.renderContext;
        if (rc?.getCellType(selectedCell.row, selectedCell.col) === CELL_TYPE.TABLE_DATA) {
            const info = rc.tableManager?.getCellInfo(selectedCell.row, selectedCell.col);
            if (info?.table && info.colDef)
                return info.table.getRawValue(info.dataIndex, info.colDef.id) ?? '';
        }
        return spreadsheetSession.getCellEditValue(selectedCell.row, selectedCell.col) ?? '';
    });

    let canUndo  = $derived(spreadsheetSession.canUndo);
    let canRedo  = $derived(spreadsheetSession.canRedo);
    let isBold   = $derived.by(() => {
        const a = selectionState.anchor;
        return a ? spreadsheetSession.activeSheetStore?.getCell(a.row, a.col)?.bold === true : false;
    });
    let isItalic = $derived.by(() => {
        const a = selectionState.anchor;
        return a ? spreadsheetSession.activeSheetStore?.getCell(a.row, a.col)?.italic === true : false;
    });

    const SYMBOLS = ['=', '+', '-', '*', '/', '(', ')', '$', ':', '%', '^', '&', '<', '>'];

    // ── Helpers ───────────────────────────────────────────────────────────────

    function focusNoScroll(el) {
        if (!el) return;
        window.scrollTo(0, 0);
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
        window.scrollTo(0, 0);
    }

    function blurKeyboard() {
        setTimeout(() => { inputComponent?.el?.blur(); captureInputEl?.blur(); }, 0);
    }

    function moveSelection(dRow, dCol) {
        const rc = spreadsheetSession.activeSheetStore;
        selectionState.moveSelection(dRow, dCol, false, rc?.rowCount, rc?.colCount);
        selectionState.endSelection();
    }

    // ── Edit actions ──────────────────────────────────────────────────────────

    function startEdit() {
        if (!selectedCell || hasRichText) return;
        if (editSessionState.isEditingCell(selectedCell.row, selectedCell.col)) {
            editSessionState.switchSurface('formulaBar', { focus: true });
        } else {
            editSessionState.beginEdit(
                selectedCell.row, selectedCell.col,
                spreadsheetSession.getCellEditValue(selectedCell.row, selectedCell.col) ?? '',
                'formulaBar',
                { sheetId: spreadsheetSession.activeSheetId },
            );
        }
    }

    function commitEdit({ doBlur = true } = {}) {
        if (hasRichText) { editSessionState.cancel(); return; }
        const editingSheetId = editSessionState.editingSheetId;
        const payload = editSessionState.commit();
        if (!payload) return;
        onEdit?.(payload.value, payload.row, payload.col, editingSheetId);
        if (editingSheetId && editingSheetId !== spreadsheetSession.activeSheetId)
            spreadsheetSession.setActiveSheet(editingSheetId);
        if (doBlur) blurKeyboard();
    }

    function cancelEdit() {
        const editingSheetId = editSessionState.editingSheetId;
        editSessionState.cancel();
        if (editingSheetId && editingSheetId !== spreadsheetSession.activeSheetId)
            spreadsheetSession.setActiveSheet(editingSheetId);
        blurKeyboard();
    }

    function commitAndMoveDown() {
        if (isEditing) commitEdit({ doBlur: false });
        moveSelection(1, 0);
        captureKeyboardFocus();
    }

    function navigate(dRow, dCol) {
        if (isEditing) commitEdit({ doBlur: false });
        moveSelection(dRow, dCol);
        captureKeyboardFocus();
    }

    function insertSymbol(sym) {
        const el = inputComponent?.el;
        if (!el) return;
        const start = el.selectionStart ?? editValue.length;
        const end   = el.selectionEnd   ?? start;
        const next  = editValue.slice(0, start) + sym + editValue.slice(end);
        editSessionState.updateDraft(next, start + sym.length, start + sym.length);
        requestAnimationFrame(() => {
            el.focus({ preventScroll: true });
            el.setSelectionRange(start + sym.length, start + sym.length);
        });
    }


    function handleKeydown(e) {
        if (e.key === 'Enter')  { commitAndMoveDown(); e.preventDefault(); }
        else if (e.key === 'Escape') { cancelEdit(); e.preventDefault(); }
        else if (e.key === 'Tab')    { commitEdit(); e.preventDefault(); }
    }

    // ── Focus management ──────────────────────────────────────────────────────

    export function captureKeyboardFocus() {
        focusNoScroll(captureInputEl);
        requestAnimationFrame(() => { if (window.scrollY !== 0) window.scrollTo(0, 0); });
        return document.activeElement === captureInputEl;
    }

    $effect(() => {
        editSessionState.setFocusHandle('formulaBar', () => {
            if (inputComponent?.el) focusNoScroll(inputComponent.el);
            else focusNoScroll(captureInputEl);
            requestAnimationFrame(() => { if (window.scrollY !== 0) window.scrollTo(0, 0); });
        });
        return () => editSessionState.clearFocusHandle('formulaBar');
    });

    $effect(() => {
        if (isEditing && editSessionState.surface === 'formulaBar')
            editSessionState.requestFocus('formulaBar');
    });
</script>

<div class="mobile-input-bar" style="bottom: {bottomOffset}px;">
    {#if isEditing}
        <!-- Editing mode -->
        <div class="entry-bar">
            <button
                class="entry-action-btn cancel"
                onclick={cancelEdit}
                onmousedown={(e) => e.preventDefault()}
                aria-label="Cancel edit"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <span class="entry-cell-ref">{cellRef}</span>
            <div class="entry-input-wrap" class:formula={isFormulaMode}>
                <FormulaInput
                    bind:this={inputComponent}
                    value={editValue}
                    readonly={hasRichText}
                    scrollable={true}
                    onInput={(val, s, e) => editSessionState.updateDraft(val, s, e)}
                    onSelect={(s, e) => editSessionState.setCursor(s, e)}
                    onKeydown={handleKeydown}
                />
            </div>
            <button
                class="entry-action-btn accept"
                onclick={() => commitEdit()}
                onmousedown={(e) => e.preventDefault()}
                aria-label="Accept edit"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
        </div>
        <div class="symbols-row">
            {#each SYMBOLS as sym}
                <button class="symbol-btn" onclick={() => insertSymbol(sym)}>{sym}</button>
            {/each}
            <button class="symbol-btn nav-btn" onclick={() => navigate(0, -1)} title="Previous cell">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="symbol-btn nav-btn" onclick={() => navigate(0, 1)} title="Next cell">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <button class="symbol-btn nav-btn primary" onclick={commitAndMoveDown} title="Confirm and move down">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
        </div>
    {:else}
        <!-- Idle mode -->
        <div
            class="faux-formula-bar"
            onclick={startEdit}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') startEdit(); }}
            aria-label="Edit cell {cellRef}"
        >
            <span class="faux-cell-ref">{cellRef || '–'}</span>
            <div class="faux-divider"></div>
            <span class="faux-value">{displayValue}</span>
        </div>
        <div class="tools-row">
            <button class="tool-btn" onclick={() => spreadsheetSession.undo()} disabled={!canUndo} aria-label="Undo" title="Undo">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
            </button>
            <button class="tool-btn" onclick={() => spreadsheetSession.redo()} disabled={!canRedo} aria-label="Redo" title="Redo">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
            </button>
            <div class="tool-divider"></div>
            <button class="tool-btn text-tool" class:active={isBold}   onclick={() => applyFormatting('bold',   !isBold)}   aria-label="Bold"   aria-pressed={isBold}>
                <span class="bold-label">B</span>
            </button>
            <button class="tool-btn text-tool" class:active={isItalic} onclick={() => applyFormatting('italic', !isItalic)} aria-label="Italic" aria-pressed={isItalic}>
                <span class="italic-label">I</span>
            </button>
            <div class="tool-divider"></div>
            <button class="tool-btn" onclick={() => (showFormatSheet = true)} aria-label="Format cells" title="Format">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
        </div>
    {/if}

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
</div>

<MobileFormattingSheet open={showFormatSheet} onClose={() => (showFormatSheet = false)} />

<style>
    .mobile-input-bar {
        position: fixed;
        left: 0;
        right: 0;
        z-index: 200;
        background: var(--formula-bar-bg, #ffffff);
        border-top: 1px solid var(--border-color, #e2e8f0);
        box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.08);
        display: flex;
        flex-direction: column;
    }

    /* ── Idle ── */
    .faux-formula-bar {
        display: flex;
        align-items: center;
        height: 44px;
        padding: 0 0.5rem;
        cursor: text;
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        -webkit-tap-highlight-color: transparent;
    }
    .faux-formula-bar:active { background: var(--color-fill, #f8fafc); }
    .faux-cell-ref {
        min-width: 44px;
        font-family: monospace;
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--color-text-secondary, #64748b);
        text-align: center;
        background: var(--cell-ref-bg, #f1f5f9);
        border-radius: 4px;
        padding: 0.2rem 0.4rem;
        flex-shrink: 0;
    }
    .faux-divider { width: 1px; height: 20px; background: var(--border-color, #e2e8f0); margin: 0 0.5rem; flex-shrink: 0; }
    .faux-value {
        flex: 1;
        min-width: 0;
        font-family: monospace;
        font-size: 0.875rem;
        color: var(--color-text, #1e293b);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tools-row {
        display: flex;
        align-items: center;
        height: 44px;
        padding: 0 0.5rem;
        gap: 2px;
    }
    .tool-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        background: transparent;
        border: none;
        border-radius: 8px;
        color: var(--color-text-secondary, #64748b);
        cursor: pointer;
        flex-shrink: 0;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
    }
    .tool-btn:active { background: var(--color-fill, #f1f5f9); color: var(--color-text, #1e293b); }
    .tool-btn.active { background: var(--color-accent-muted, #dbeafe); color: var(--color-accent, #2563eb); }
    .tool-btn:disabled { opacity: 0.3; pointer-events: none; }
    .tool-divider { width: 1px; height: 22px; background: var(--border-color, #e2e8f0); margin: 0 4px; flex-shrink: 0; }
    .bold-label   { font-size: 15px; font-weight: 700; line-height: 1; font-family: serif; }
    .italic-label { font-size: 15px; font-weight: 600; font-style: italic; line-height: 1; font-family: serif; }

    /* ── Editing ── */
    .entry-bar {
        display: flex;
        align-items: center;
        height: 48px;
        padding: 0 0.375rem;
        gap: 4px;
        border-bottom: 1px solid var(--border-color, #e2e8f0);
    }
    .entry-action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        flex-shrink: 0;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
    }
    .entry-action-btn.cancel { background: var(--color-danger-muted, #fee2e2); color: var(--color-danger, #dc2626); }
    .entry-action-btn.accept { background: var(--color-success-muted, #dcfce7); color: var(--color-success, #16a34a); }
    .entry-cell-ref {
        font-family: monospace;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text-secondary, #64748b);
        background: var(--cell-ref-bg, #f1f5f9);
        border-radius: 4px;
        padding: 0.2rem 0.35rem;
        flex-shrink: 0;
        min-width: 36px;
        text-align: center;
    }
    .entry-input-wrap {
        flex: 1;
        min-width: 0;
        position: relative;
        height: 36px;
        border: 2px solid var(--focus-color, #3b82f6);
        border-radius: 6px;
        background: var(--input-bg, #ffffff);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 16px; /* prevent iOS auto-zoom */
        font-variant-ligatures: none;
        padding: 0 0.5rem;
        display: flex;
        align-items: center;
        color: var(--text-color, #1e293b);
    }

    .symbols-row {
        display: flex;
        align-items: center;
        height: 44px;
        padding: 0 0.25rem;
        overflow-x: auto;
        scrollbar-width: none;
        gap: 2px;
    }
    .symbols-row::-webkit-scrollbar { display: none; }
    .symbol-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 40px;
        height: 36px;
        padding: 0 6px;
        background: var(--color-fill, #f1f5f9);
        border: 1px solid var(--border-color, #cbd5e1);
        border-radius: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        flex-shrink: 0;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
    }
    .symbol-btn:active { background: var(--color-accent-muted, #dbeafe); border-color: var(--color-accent, #3b82f6); }
    .symbol-btn.nav-btn { background: var(--formula-nav-btn-bg, #f8fafc); min-width: 44px; margin-left: 4px; }
    .symbol-btn.nav-btn.primary { background: var(--color-accent-muted, #dbeafe); border-color: var(--color-accent, #3b82f6); color: var(--color-accent, #2563eb); }

    .capture-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; left: 0; top: 0; }
</style>
