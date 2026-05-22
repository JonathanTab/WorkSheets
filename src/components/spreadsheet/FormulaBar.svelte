<script>
    import { spreadsheetSession, selectionState } from "../../stores/spreadsheetStore.svelte.js";
    import { editSessionState } from "../../stores/spreadsheet/index.js";
    import { toCellRef } from "../../formulas/refCoords.js";
    import { CELL_TYPE } from "../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
    import { mobileState } from "../../stores/mobileState.svelte.js";
    import { untrack } from "svelte";
    import FormulaInput from "./FormulaInput.svelte";
    import { close, check } from "../../lib/icons/index.js";

    let { selectedCell = null, onEdit } = $props();

    let inputComponent = $state(null); // FormulaInput instance
    let captureInputEl = $state(null);
    let previousCellKey = $state(null);

    // ── Derived state ─────────────────────────────────────────────────────────

    let isEditing     = $derived(editSessionState.isEditing);
    let editValue     = $derived(editSessionState.draft);
    let isFormulaMode = $derived(isEditing && editValue?.startsWith('='));

    let hasRichText = $derived.by(() => {
        if (editSessionState.initialTfr) return true;
        if (!selectedCell) return false;
        return !!spreadsheetSession.activeSheetStore?.getCell(selectedCell.row, selectedCell.col)?.tfr?.length;
    });

    let cellRef = $derived.by(() => {
        if (editSessionState.isEditing && editSessionState.cell) {
            const { row, col } = editSessionState.cell;
            const ref = toCellRef(row, col);
            const editingId = editSessionState.editingSheetId;
            const activeId  = spreadsheetSession.activeSheetId;
            if (editingId && editingId !== activeId) {
                return `${spreadsheetSession.getSheetName(editingId)}!${ref}`;
            }
            return ref;
        }
        return selectedCell ? toCellRef(selectedCell.row, selectedCell.col) : '';
    });

    let displayValue = $derived.by(() => {
        if (!selectedCell) return '';
        void spreadsheetSession.activeSheetStore?.cellsVersion;
        return _getEditValue(selectedCell.row, selectedCell.col);
    });

    let currentCellKey = $derived(selectedCell ? `${selectedCell.row},${selectedCell.col}` : null);

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _getEditValue(row, col) {
        const rc = spreadsheetSession.renderContext;
        if (rc) {
            const ct = rc.getCellType(row, col);
            if (ct === CELL_TYPE.TABLE_DATA) {
                const info = rc.tableManager?.getCellInfo(row, col);
                if (info?.table && info.colDef)
                    return info.table.getRawValue(info.dataIndex, info.colDef.id) ?? '';
            }
            if (ct === CELL_TYPE.TABLE_ENTRY) {
                const info = rc.tableManager?.getCellInfo(row, col);
                if (info?.table && info.colDef)
                    return info.table.entryBuffer?.[info.colDef.id] ?? '';
            }
            if (ct === CELL_TYPE.TABLE_HEADER) {
                const info = rc.tableManager?.getCellInfo(row, col);
                return info?.colDef?.name ?? '';
            }
        }
        return spreadsheetSession.getCellEditValue(row, col) ?? '';
    }

    function blurMobileKeyboard() {
        if (!mobileState.isMobile) return;
        setTimeout(() => { inputComponent?.el?.blur(); captureInputEl?.blur(); }, 0);
    }

    function focusNoScroll(el) {
        if (!el) return;
        if (mobileState.isMobile) window.scrollTo(0, 0);
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
        if (mobileState.isMobile) window.scrollTo(0, 0);
    }

    function enforcePageTop() {
        if (!mobileState.isMobile) return;
        if (window.scrollY !== 0 || (window.visualViewport?.offsetTop ?? 0) !== 0) window.scrollTo(0, 0);
    }

    // ── Edit actions ──────────────────────────────────────────────────────────

    function startEdit() {
        if (!selectedCell || hasRichText) return;
        if (editSessionState.isEditingCell(selectedCell.row, selectedCell.col)) {
            editSessionState.switchSurface('formulaBar', { focus: true });
        } else {
            editSessionState.beginEdit(
                selectedCell.row, selectedCell.col,
                _getEditValue(selectedCell.row, selectedCell.col),
                'formulaBar',
                { sheetId: spreadsheetSession.activeSheetId },
            );
        }
    }

    function commitEdit({ blurKeyboard = true } = {}) {
        if (hasRichText) { editSessionState.cancel(); if (blurKeyboard) blurMobileKeyboard(); return; }
        const editingSheetId = editSessionState.editingSheetId;
        const payload = editSessionState.commit();
        if (!payload) return;
        onEdit?.(payload.value, payload.row, payload.col, editingSheetId);
        if (editingSheetId && editingSheetId !== spreadsheetSession.activeSheetId)
            spreadsheetSession.setActiveSheet(editingSheetId);
        if (blurKeyboard) blurMobileKeyboard();
    }

    function cancelEdit() {
        const editingSheetId = editSessionState.editingSheetId;
        editSessionState.cancel();
        if (editingSheetId && editingSheetId !== spreadsheetSession.activeSheetId)
            spreadsheetSession.setActiveSheet(editingSheetId);
        blurMobileKeyboard();
    }

    function handleKeydown(e) {
        if (e.key === 'Enter')  { commitEdit(); e.preventDefault(); }
        else if (e.key === 'Escape') { cancelEdit(); e.preventDefault(); }
        else if (e.key === 'Tab')    { commitEdit(); e.preventDefault(); }
    }

    // ── Focus management ──────────────────────────────────────────────────────

    export function captureKeyboardFocus() {
        if (!mobileState.isMobile) return false;
        focusNoScroll(captureInputEl);
        requestAnimationFrame(() => enforcePageTop());
        return document.activeElement === captureInputEl;
    }

    $effect(() => {
        editSessionState.setFocusHandle('formulaBar', () => {
            if (inputComponent?.el) focusNoScroll(inputComponent.el);
            requestAnimationFrame(() => { enforcePageTop(); requestAnimationFrame(enforcePageTop); });
        });
        return () => editSessionState.clearFocusHandle('formulaBar');
    });

    $effect(() => {
        if (isEditing && editSessionState.surface === 'formulaBar')
            editSessionState.requestFocus('formulaBar');
    });

    // Track cell changes (kept only to avoid spurious reactive resets)
    $effect(() => {
        const newKey = currentCellKey;
        if (newKey !== previousCellKey) {
            untrack(() => { previousCellKey = newKey; });
        }
    });
</script>

<div class="formula-bar">
    <div class="formula-bar-row">
        <div class="cell-reference">{cellRef || '–'}</div>
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
        <div class="formula-input-area">
            {#if isEditing}
                <div class="input-wrap" class:has-formula={isFormulaMode}>
                    <FormulaInput
                        bind:this={inputComponent}
                        value={editValue}
                        readonly={hasRichText}
                        scrollable={true}
                        onInput={(val, s, e) => editSessionState.updateDraft(val, s, e)}
                        onSelect={(s, e) => editSessionState.setCursor(s, e)}
                        onKeydown={handleKeydown}
                        onBlur={() => {
                            if (editSessionState.surface === 'formulaBar' && !hasRichText)
                                commitEdit({ blurKeyboard: false });
                        }}
                        onmousedown={(e) => {
                            e.stopPropagation();
                            if (!hasRichText && editSessionState.isEditing)
                                editSessionState.switchSurface('formulaBar', { focus: false });
                        }}
                    />
                </div>
            {:else}
                <div
                    class="display-value"
                    onclick={(e) => { e.stopPropagation(); startEdit(); }}
                    role="button"
                    tabindex="0"
                    onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); startEdit(); } }}
                >
                    {displayValue}
                </div>
            {/if}
        </div>
    </div>
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

    .edit-buttons { display: flex; gap: 0.25rem; }

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
        transition: opacity 0.15s, background-color 0.15s;
    }

    .btn-cancel { background: #fee2e2; color: #dc2626; }
    .btn-cancel:hover:not(:disabled) { background: #fecaca; }
    .btn-accept { background: #dcfce7; color: #16a34a; }
    .btn-accept:hover:not(:disabled) { background: #bbf7d0; }
    .edit-buttons button:disabled { opacity: 0.4; cursor: not-allowed; }

    .formula-input-area {
        flex: 1;
        min-width: 0;
        position: relative;
    }

    .input-wrap {
        position: relative;
        height: 28px;
        border: 2px solid var(--focus-color, #3b82f6);
        border-radius: 4px;
        background: var(--input-bg, #ffffff);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 0.875rem;
        font-variant-ligatures: none;
        letter-spacing: 0;
        padding: 0 0.5rem;
        display: flex;
        align-items: center;
        color: var(--text-color, #1e293b);
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

    .display-value:hover { background: var(--hover-bg, #f1f5f9); }
    .display-value:focus { outline: 2px solid var(--focus-color, #3b82f6); outline-offset: -2px; }

    .capture-input {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
        left: 0;
        bottom: 0;
    }
</style>
