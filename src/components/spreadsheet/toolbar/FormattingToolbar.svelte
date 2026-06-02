<script>
    import {
        spreadsheetSession,
        selectionState,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import {
        clipboardManager,
        editSessionState,
    } from "../../../stores/spreadsheet/index.js";
    import {
        applyFormatting,
        handleBorderChange,
        handleCellTypeChange,
        applyNumberSubFormat,
        adjustDecimals,
        computeSelectedFormatting,
        computeBorderSelectionRange,
        computeBordersSummary,
        getTableColContext,
    } from "../../../stores/spreadsheet/cellFormattingCommands.js";
    import { cut, copy, paste, printer, undo as undoIcon, redo as redoIcon } from "../../../lib/icons/index.js";
    import ColorPicker from "./ColorPicker.svelte";
    import BorderPicker from "./BorderPicker.svelte";
    import AlignmentPicker from "./AlignmentPicker.svelte";
    import MenuDropdown from "./MenuDropdown.svelte";
    import CellTypeConfigurator from "./CellTypeConfigurator.svelte";

    const fontSizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
    const fontFamilies = [
        { value: "Arial", label: "Arial" },
        { value: "Helvetica", label: "Helvetica" },
        { value: "Times New Roman", label: "Times New Roman" },
        { value: "Georgia", label: "Georgia" },
        { value: "Verdana", label: "Verdana" },
        { value: "Courier New", label: "Courier New" },
    ];

    let borderSelectionRange = $derived.by(computeBorderSelectionRange);
    let bordersSummary       = $derived.by(computeBordersSummary);
    let selectedFormatting   = $derived.by(computeSelectedFormatting);

    // ── Link button state ────────────────────────────────────────────────────
    let linkInputVisible = $state(false);
    let linkInputValue   = $state('');
    let linkInputEl      = $state(null);

    // Reflects an existing hyperlink on the current inline selection so the
    // button can show as active and the input can pre-fill for editing.
    let selectionLink = $derived(editSessionState.isEditing ? editSessionState.inlineSelLink : null);

    function openLinkInput() {
        linkInputValue   = selectionLink ?? '';
        linkInputVisible = true;
        setTimeout(() => { linkInputEl?.focus(); linkInputEl?.select(); }, 0);
    }

    function applyLink() {
        const url = linkInputValue.trim();
        if (url && editSessionState.applyInlineFormat) {
            const uri = /^https?:\/\//i.test(url) ? url : 'https://' + url;
            editSessionState.applyInlineFormat('link', { uri });
        }
        linkInputVisible = false;
        linkInputValue   = '';
    }

    function removeLink() {
        if (editSessionState.applyInlineFormat) {
            editSessionState.applyInlineFormat('link', null);
        }
        linkInputVisible = false;
    }

    function handleLinkKeydown(e) {
        if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
        if (e.key === 'Escape') { e.preventDefault(); linkInputVisible = false; }
    }

    function toggleBold()      { applyFormatting('bold',      selectedFormatting?.bold      === true ? false : true); }
    function toggleItalic()    { applyFormatting('italic',    selectedFormatting?.italic    === true ? false : true); }
    function toggleUnderline() { applyFormatting('underline', selectedFormatting?.underline === true ? false : true); }

    let displayFontSize = $derived.by(() => {
        if (editSessionState.isEditing) {
            const s = editSessionState.inlineSelFontSize;
            if (typeof s === 'number') return s;
            if (s === 'mixed') return '';
        }
        const sf = selectedFormatting?.fontSize;
        if (sf === 'mixed') return '';
        return sf || 10;
    });

    function getStepBaseFontSize() {
        if (editSessionState.isEditing) {
            const s = editSessionState.inlineSelFontSize;
            if (typeof s === 'number') return s;
        }
        const sf = selectedFormatting?.fontSize;
        return typeof sf === 'number' ? sf : 10;
    }

    function handleFontFamilyChange(e) {
        if (e.target.value) applyFormatting('fontFamily', e.target.value);
    }

    function handleFontSizeChange(e) {
        const size = parseInt(e.target.value, 10);
        if (!isNaN(size) && size > 0) applyFormatting('fontSize', size);
    }

    function decrementFontSize() {
        const current = getStepBaseFontSize();
        const idx = fontSizes.findLastIndex(s => s < current);
        if (idx >= 0) applyFormatting('fontSize', fontSizes[idx]);
    }

    function incrementFontSize() {
        const current = getStepBaseFontSize();
        const idx = fontSizes.findIndex(s => s > current);
        if (idx >= 0) applyFormatting('fontSize', fontSizes[idx]);
    }

    let hasSelection = $derived(selectionState.anchor !== null);

    let tableColTypeConfig = $derived.by(() => {
        const tcc = getTableColContext();
        if (!tcc) return null;
        return tcc.colDef.typeConfig ?? (tcc.colDef.type ? { type: tcc.colDef.type } : null);
    });

    function decreaseDecimals() { adjustDecimals(-1); }
    function increaseDecimals() { adjustDecimals(1); }

    let isMergeActive = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return false;
        return !!sheetStore.mergeEngine?.getMergeAt(range.startRow, range.startCol);
    });

    function toggleMergeCells() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        const { startRow, endRow, startCol, endCol } = range;
        if (isMergeActive) {
            sheetStore.mergeEngine.unmergeRange(startRow, endRow, startCol, endCol);
        } else {
            sheetStore.mergeCells(startRow, startCol, endRow, endCol);
        }
    }

    function handleCopy() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore) clipboardManager.copy(sheetStore, spreadsheetSession);
    }

    function handleCut() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore && spreadsheetSession.ydoc) {
            clipboardManager.cut(sheetStore, spreadsheetSession, spreadsheetSession.ydoc);
        }
    }

    function handlePaste(mode = 'full') {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore && spreadsheetSession.ydoc) {
            clipboardManager.paste(sheetStore, spreadsheetSession, spreadsheetSession.ydoc, mode);
        }
    }
</script>

<div class="formatting-toolbar">
    <!-- Undo/Redo + Print -->
    <div class="toolbar-group">
        <button
            class="toolbar-btn"
            class:disabled={!spreadsheetSession.canUndo}
            onclick={() => spreadsheetSession.undo()}
            disabled={!spreadsheetSession.canUndo}
            title="Undo (Ctrl+Z)"
        >
            {@html undoIcon}
        </button>
        <button
            class="toolbar-btn"
            class:disabled={!spreadsheetSession.canRedo}
            onclick={() => spreadsheetSession.redo()}
            disabled={!spreadsheetSession.canRedo}
            title="Redo (Ctrl+Shift+Z)"
        >
            {@html redoIcon}
        </button>
        <button
            class="toolbar-btn"
            onclick={() => document.dispatchEvent(new CustomEvent('openPdfExport'))}
            title="Page Setup & Export PDF (Ctrl+P)"
        >
            {@html printer}
        </button>
    </div>

    <div class="divider"></div>

    <!-- Number Format: $, %, −.0, +.0 + Cell Type -->
    <div class="toolbar-group">
        <button
            class="toolbar-btn"
            onclick={() => applyNumberSubFormat("currency", { decimals: 2, symbol: "$" })}
            disabled={!hasSelection}
            title="Format as currency"
        >
            <span class="fmt-label">$</span>
        </button>
        <button
            class="toolbar-btn"
            onclick={() => applyNumberSubFormat("percent", { decimals: 1 })}
            disabled={!hasSelection}
            title="Format as percent"
        >
            <span class="fmt-label">%</span>
        </button>
        <button
            class="toolbar-btn"
            onclick={decreaseDecimals}
            disabled={!hasSelection}
            title="Decrease decimal places"
        >
            <span class="fmt-label">.0←</span>
        </button>
        <button
            class="toolbar-btn"
            onclick={increaseDecimals}
            disabled={!hasSelection}
            title="Increase decimal places"
        >
            <span class="fmt-label">.0→</span>
        </button>
    </div>

    <!-- Cell Type -->
    <div class="toolbar-group">
        <MenuDropdown icon="123" title="Cell Type">
            <CellTypeConfigurator
                controlledConfig={tableColTypeConfig}
                onControlledChange={tableColTypeConfig !== null ? handleCellTypeChange : null}
            />
        </MenuDropdown>
    </div>

    <div class="divider"></div>

    <!-- Clipboard: Cut, Copy, Paste -->
    <div class="toolbar-group">
        <button
            class="toolbar-btn"
            class:disabled={!hasSelection}
            onclick={handleCut}
            disabled={!hasSelection}
            title="Cut (Ctrl+X)"
        >
            {@html cut}
        </button>
        <button
            class="toolbar-btn"
            class:disabled={!hasSelection}
            onclick={handleCopy}
            disabled={!hasSelection}
            title="Copy (Ctrl+C)"
        >
            {@html copy}
        </button>
        <button
            class="toolbar-btn"
            onclick={() => handlePaste("full")}
            title="Paste (Ctrl+V)"
        >
            {@html paste}
        </button>
    </div>

    <div class="divider"></div>

    <!-- Font Family -->
    <div class="toolbar-group">
        <select
            class="font-family-select"
            value={selectedFormatting?.fontFamily || "Arial"}
            onchange={handleFontFamilyChange}
            disabled={!hasSelection}
        >
            {#each fontFamilies as font}
                <option value={font.value}>{font.label}</option>
            {/each}
        </select>
    </div>

    <!-- Font Size -->
    <div class="toolbar-group font-size-group">
        <button
            class="toolbar-btn font-size-step"
            onmousedown={(e) => { e.preventDefault(); decrementFontSize(); }}
            disabled={!hasSelection}
            title="Decrease font size"
        >−</button>
        <input
            type="text"
            class="font-size-input"
            value={displayFontSize}
            onchange={handleFontSizeChange}
            disabled={!hasSelection}
            size="3"
        />
        <button
            class="toolbar-btn font-size-step"
            onmousedown={(e) => { e.preventDefault(); incrementFontSize(); }}
            disabled={!hasSelection}
            title="Increase font size"
        >+</button>
    </div>

    <div class="divider"></div>

    <!-- Bold, Italic, Underline -->
    <div class="toolbar-group">
        <button
            class="toolbar-btn"
            class:active={selectedFormatting?.bold === true}
            onclick={toggleBold}
            disabled={!hasSelection}
            title="Bold (Ctrl+B)"
        >
            <strong>B</strong>
        </button>
        <button
            class="toolbar-btn"
            class:active={selectedFormatting?.italic === true}
            onclick={toggleItalic}
            disabled={!hasSelection}
            title="Italic (Ctrl+I)"
        >
            <em>I</em>
        </button>
        <button
            class="toolbar-btn"
            class:active={selectedFormatting?.underline === true}
            onclick={toggleUnderline}
            disabled={!hasSelection}
            title="Underline (Ctrl+U)"
        >
            <u>U</u>
        </button>
        {#if editSessionState.isEditing && editSessionState.applyInlineFormat}
            <button
                class="toolbar-btn"
                class:active={selectionLink !== null}
                onclick={openLinkInput}
                title={selectionLink ? "Edit link" : "Insert link"}
            >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1"/>
                    <path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1"/>
                </svg>
            </button>
        {/if}
    </div>

    {#if linkInputVisible}
        <div class="link-input-row">
            <input
                bind:this={linkInputEl}
                bind:value={linkInputValue}
                class="link-input"
                type="text"
                placeholder="https://example.com"
                onkeydown={handleLinkKeydown}
            />
            <button class="link-apply-btn" onclick={applyLink}>Apply</button>
            <button class="link-remove-btn" onclick={removeLink} title="Remove link">✕</button>
        </div>
    {/if}

    <div class="divider"></div>

    <!-- Colors -->
    <div class="toolbar-group">
        <ColorPicker
            label="Text Color"
            variant="text"
            value={selectedFormatting?.color || "#000000"}
            onchange={(color) => applyFormatting('color', color)}
        />
        <ColorPicker
            label="Background Color"
            variant="fill"
            value={selectedFormatting?.backgroundColor || "#ffffff"}
            onchange={(color) => applyFormatting('backgroundColor', color)}
        />
    </div>

    <div class="divider"></div>

    <!-- Borders -->
    <div class="toolbar-group">
        <BorderPicker
            onchange={handleBorderChange}
            selectionRange={borderSelectionRange}
            currentSummary={bordersSummary}
        />
    </div>

    <div class="divider"></div>

    <!-- Horizontal Alignment -->
    <div class="toolbar-group">
        <AlignmentPicker
            value={selectedFormatting?.horizontalAlign || "left"}
            onchange={(align) => applyFormatting('horizontalAlign', align)}
        />
    </div>

    <!-- Vertical Alignment -->
    <div class="toolbar-group">
        <AlignmentPicker
            value={selectedFormatting?.verticalAlign || "middle"}
            onchange={(align) => applyFormatting('verticalAlign', align)}
            vertical={true}
        />
    </div>

    <!-- Merge Cells -->
    <div class="toolbar-group">
        <button
            class="toolbar-btn"
            class:active={isMergeActive}
            onclick={toggleMergeCells}
            disabled={!hasSelection}
            title={isMergeActive ? "Unmerge cells" : "Merge cells"}
        >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <rect x="1" y="3" width="13" height="9" rx="1"/>
                <line x1="7.5" y1="3" x2="7.5" y2="12" stroke-dasharray="1.5 1.5" stroke-width="1"/>
                <path d="M5.5 7.5H3.5M4.5 6.5L3.5 7.5L4.5 8.5"/>
                <path d="M9.5 7.5H11.5M10.5 6.5L11.5 7.5L10.5 8.5"/>
            </svg>
        </button>
    </div>

    <!-- Spacer -->
    <div class="spacer"></div>
</div>


<style>
    .formatting-toolbar {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 4px 0 4px 8px;
        height: 40px;
    }

    .toolbar-group {
        display: flex;
        align-items: center;
        gap: 1px;
    }

    .toolbar-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        height: 30px;
        padding: 0 6px;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
        color: var(--color-text-secondary);
        transition: all 0.08s ease;
    }

    .toolbar-btn:hover:not(.disabled) {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .toolbar-btn.active {
        background: var(--color-primary-soft);
        color: var(--color-primary);
    }

    .toolbar-btn.disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }

    .toolbar-btn:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .divider {
        width: 1px;
        height: 18px;
        background: var(--color-border);
        margin: 0 6px;
        flex-shrink: 0;
    }

    .spacer {
        flex: 1;
    }

    .fmt-label {
        font-size: 0.75rem;
        font-weight: 600;
        line-height: 1;
        letter-spacing: -0.01em;
    }

    .font-family-select {
        height: 30px;
        padding: 0 6px;
        font-size: 0.75rem;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text);
        cursor: pointer;
        transition: all 0.08s ease;
        min-width: 90px;
    }

    .font-family-select:hover {
        background: var(--color-fill);
        border-color: var(--color-border);
    }

    .font-family-select:focus {
        outline: none;
        border-color: var(--color-primary);
        background: var(--color-surface);
    }

    .font-size-input {
        width: 36px;
        height: 30px;
        padding: 0 3px;
        font-size: 0.75rem;
        text-align: center;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text);
        transition: all 0.08s ease;
    }

    .font-size-input:hover {
        background: var(--color-fill);
        border-color: var(--color-border);
    }

    .font-size-input:focus {
        outline: none;
        border-color: var(--color-primary);
        background: var(--color-surface);
    }

    .font-size-input:disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }

    .font-size-group {
        gap: 0;
    }

    .font-size-step {
        min-width: 20px;
        padding: 0 3px;
        font-size: 1rem;
        line-height: 1;
    }

    /* ── Mobile: scrollable toolbar with bigger tap targets ── */
    @media (max-width: 600px) {
        .formatting-toolbar {
            overflow-x: auto;
            overflow-y: hidden;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: none;
            height: 48px;
            padding: 0 4px 0 8px;
            gap: 0px;
        }
        .formatting-toolbar::-webkit-scrollbar {
            display: none;
        }
        .toolbar-btn {
            min-width: 36px;
            height: 36px;
            padding: 0 7px;
            font-size: 1rem;
        }
        .toolbar-group {
            gap: 2px;
            flex-shrink: 0;
        }
        .divider {
            margin: 0 4px;
            flex-shrink: 0;
        }
        .font-family-select {
            min-width: 80px;
            height: 34px;
            font-size: 0.8rem;
        }
        .font-size-input {
            width: 38px;
            height: 34px;
            font-size: 0.8rem;
        }
    }

    .link-input-row {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-top: 1px solid var(--toolbar-border, #e2e8f0);
        background: var(--toolbar-bg, #f8fafc);
        flex-shrink: 0;
    }

    .link-input {
        flex: 1;
        height: 26px;
        border: 1px solid var(--input-border, #cbd5e1);
        border-radius: 4px;
        padding: 0 6px;
        font-size: 12px;
        min-width: 0;
        background: var(--input-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
    }

    .link-input:focus {
        border-color: var(--editor-outline, #3b82f6);
    }

    .link-apply-btn {
        height: 26px;
        padding: 0 10px;
        border: none;
        border-radius: 4px;
        background: var(--editor-outline, #3b82f6);
        color: #fff;
        font-size: 12px;
        cursor: pointer;
        flex-shrink: 0;
    }

    .link-apply-btn:hover { opacity: 0.85; }

    .link-remove-btn {
        height: 26px;
        padding: 0 6px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--text-muted, #94a3b8);
        font-size: 13px;
        cursor: pointer;
        flex-shrink: 0;
    }

    .link-remove-btn:hover { color: var(--text-color, #1e293b); }
</style>
