<script>
    import {
        spreadsheetSession,
        selectionState,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import {
        clipboardManager,
        editSessionState,
    } from "../../../stores/spreadsheet/index.js";
    import { cut, copy, paste, printer, undo as undoIcon, redo as redoIcon } from "../../../lib/icons/index.js";
    import { CELL_TYPE } from "../../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
    import ColorPicker from "./ColorPicker.svelte";
    import BorderPicker from "./BorderPicker.svelte";
    import AlignmentPicker from "./AlignmentPicker.svelte";
    import MenuDropdown from "./MenuDropdown.svelte";
    import CellTypeConfigurator from "./CellTypeConfigurator.svelte";
    import PageSetupPanel from "../PageSetupPanel.svelte";

    // Font size options
    const fontSizes = [
        8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72,
    ];

    // Font family options
    const fontFamilies = [
        { value: "Arial", label: "Arial" },
        { value: "Helvetica", label: "Helvetica" },
        { value: "Times New Roman", label: "Times New Roman" },
        { value: "Georgia", label: "Georgia" },
        { value: "Verdana", label: "Verdana" },
        { value: "Courier New", label: "Courier New" },
    ];

    /** Maximum cells to sample when computing mixed formatting state */
    const MAX_SAMPLE_CELLS = 200;

    // Derived: effective selection range for the border picker.
    // For rows/cols/all modes uses effectiveRange so that borders can be applied
    // to whole-row and whole-column selections. For range mode also expands to
    // cover any merged cells the selection touches.
    let borderSelectionRange = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return null;

        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        // For whole-axis / all modes, use effectiveRange directly (no merges to expand)
        if (mode !== 'range') {
            return selectionState.effectiveRange(rowCount, colCount);
        }

        // For range mode, expand to cover any merged cells the selection touches
        const range = selectionState.range;
        if (!range) return null;
        const mergeEngine = sheetStore.mergeEngine;
        if (!mergeEngine || mergeEngine.merges.length === 0) return range;
        let { startRow, endRow, startCol, endCol } = range;
        let changed = true;
        while (changed) {
            changed = false;
            for (const m of mergeEngine.merges) {
                if (m.startRow <= endRow && m.endRow >= startRow && m.startCol <= endCol && m.endCol >= startCol) {
                    if (m.startRow < startRow) { startRow = m.startRow; changed = true; }
                    if (m.endRow > endRow)      { endRow   = m.endRow;   changed = true; }
                    if (m.startCol < startCol)  { startCol = m.startCol; changed = true; }
                    if (m.endCol > endCol)      { endCol   = m.endCol;   changed = true; }
                }
            }
        }
        return { startRow, endRow, startCol, endCol };
    });

    let selectedFormatting = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return null;

        // Touch version counters so this derived re-runs on any meta change
        const _rowMetaVer = sheetStore.rowMetaVersion;
        const _colMetaVer = sheetStore.colMetaVersion;
        const _cellsVer = sheetStore.cellsVersion;

        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        // For whole-axis modes, read from the axis-level formatting
        if (mode === "rows" && selectionState.selectedRows) {
            const { start, end } = selectionState.selectedRows;
            // Sample formatting from the first selected row
            const rowFmt = sheetStore.getRowFormatting?.(start) ?? {};
            return {
                bold: rowFmt.bold ?? null,
                italic: rowFmt.italic ?? null,
                underline: rowFmt.underline ?? null,
                fontSize: rowFmt.fontSize ?? null,
                fontFamily: rowFmt.fontFamily ?? null,
                color: rowFmt.color ?? null,
                backgroundColor: rowFmt.backgroundColor ?? null,
                horizontalAlign: rowFmt.horizontalAlign ?? null,
                verticalAlign: rowFmt.verticalAlign ?? null,
            };
        }

        if (mode === "cols" && selectionState.selectedCols) {
            const { start } = selectionState.selectedCols;
            const colFmt = sheetStore.getColFormatting?.(start) ?? {};
            return {
                bold: colFmt.bold ?? null,
                italic: colFmt.italic ?? null,
                underline: colFmt.underline ?? null,
                fontSize: colFmt.fontSize ?? null,
                fontFamily: colFmt.fontFamily ?? null,
                color: colFmt.color ?? null,
                backgroundColor: colFmt.backgroundColor ?? null,
                horizontalAlign: colFmt.horizontalAlign ?? null,
                verticalAlign: colFmt.verticalAlign ?? null,
            };
        }

        // For range/all mode: sample from cells (limited to avoid hang)
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return null;

        const renderContext = spreadsheetSession.renderContext;
        const props = {};
        const keys = [
            "bold",
            "italic",
            "underline",
            "fontSize",
            "fontFamily",
            "color",
            "backgroundColor",
            "horizontalAlign",
            "verticalAlign",
        ];

        for (const key of keys) {
            props[key] = { values: new Set(), count: 0 };
        }

        let sampled = 0;
        outer: for (
            let r = eff.startRow;
            r <= eff.endRow && sampled < MAX_SAMPLE_CELLS;
            r++
        ) {
            for (
                let c = eff.startCol;
                c <= eff.endCol && sampled < MAX_SAMPLE_CELLS;
                c++
            ) {
                // Skip table/repeater cells as they don't use sheet formatting
                const ct = renderContext?.getCellType(r, c);
                if (
                    ct === CELL_TYPE.TABLE_HEADER ||
                    ct === CELL_TYPE.TABLE_ENTRY ||
                    ct === CELL_TYPE.TABLE_DATA ||
                    ct === CELL_TYPE.VIEWPORT_OCCUPIED
                )
                    continue;

                const cell = sheetStore.getCell(r, c);
                for (const key of keys) {
                    props[key].values.add(cell[key] ?? null);
                    props[key].count++;
                }
                sampled++;
            }
        }

        const result = {};
        for (const key of keys) {
            const { values } = props[key];
            result[key] = values.size === 1 ? [...values][0] : "mixed";
        }
        return result;
    });

    /**
     * Apply formatting to the selection.
     * For whole-axis modes, uses setRowFormatting/setColFormatting.
     * For range mode, iterates cells (skipping table/viewport cells).
     */
    function applyFormatting(property, value) {
        // When editing, try to apply inline formatting to the current text selection.
        // richFormatApplier returns true if a selection existed and formatting was applied,
        // false if the cursor was collapsed (fall through to cell-level formatting).
        if (editSessionState.isEditing && editSessionState.richFormatApplier) {
            const propMap = {
                bold: ["fontWeight", "bold"],
                italic: ["fontStyle", "italic"],
                underline: ["underline", null],
                strikethrough: ["strikethrough", null],
                color: ["color", value],
                fontSize: ["fontSize", value],
                fontFamily: ["fontFamily", value],
            };
            const mapped = propMap[property];
            if (mapped) {
                const applied = editSessionState.richFormatApplier(
                    mapped[0],
                    mapped[1] ?? value,
                );
                if (applied) return;
            }
        }

        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;

        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        if (mode === "rows" && selectionState.selectedRows) {
            const { start, end } = selectionState.selectedRows;
            spreadsheetSession.ydoc?.transact(() => {
                for (let r = start; r <= end; r++) {
                    sheetStore.setRowFormatting?.(r, { [property]: value });
                }
            });
            return;
        }

        if (mode === "cols" && selectionState.selectedCols) {
            const { start, end } = selectionState.selectedCols;
            spreadsheetSession.ydoc?.transact(() => {
                for (let c = start; c <= end; c++) {
                    sheetStore.setColFormatting?.(c, { [property]: value });
                }
            });
            return;
        }

        // Range / all mode — iterate cells, skip table cells
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;

        const renderContext = spreadsheetSession.renderContext;
        spreadsheetSession.ydoc?.transact(() => {
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (
                        ct === CELL_TYPE.TABLE_HEADER ||
                        ct === CELL_TYPE.TABLE_ENTRY ||
                        ct === CELL_TYPE.TABLE_DATA ||
                        ct === CELL_TYPE.VIEWPORT_OCCUPIED
                    )
                        continue;
                    sheetStore.setCellProperties(r, c, { [property]: value });
                }
            }
        });
    }

    // Toggle handlers
    function toggleBold() {
        const current = selectedFormatting?.bold;
        const newValue = current === true ? false : true;
        applyFormatting("bold", newValue);
    }

    function toggleItalic() {
        const current = selectedFormatting?.italic;
        const newValue = current === true ? false : true;
        applyFormatting("italic", newValue);
    }

    function toggleUnderline() {
        const current = selectedFormatting?.underline;
        const newValue = current === true ? false : true;
        applyFormatting("underline", newValue);
    }

    // Font size handler
    function handleFontSizeChange(e) {
        const size = parseInt(e.target.value, 10);
        if (!isNaN(size) && size > 0) {
            applyFormatting("fontSize", size);
        }
    }

    function decrementFontSize() {
        const current = selectedFormatting?.fontSize || 12;
        const idx = fontSizes.findLastIndex(s => s < current);
        if (idx >= 0) applyFormatting("fontSize", fontSizes[idx]);
    }

    function incrementFontSize() {
        const current = selectedFormatting?.fontSize || 12;
        const idx = fontSizes.findIndex(s => s > current);
        if (idx >= 0) applyFormatting("fontSize", fontSizes[idx]);
    }

    // Font family handler
    function handleFontFamilyChange(e) {
        applyFormatting("fontFamily", e.target.value);
    }

    // Color handlers
    function handleTextColorChange(color) {
        applyFormatting("color", color);
    }

    function handleBackgroundColorChange(color) {
        applyFormatting("backgroundColor", color);
    }

    // Border handler - receives edge-based border instructions
    function handleBorderChange(borderInstructions) {
        if (!borderInstructions || !Array.isArray(borderInstructions)) return;

        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;

        // Check for clear-range instruction
        const clearInstruction = borderInstructions.find(
            (i) => i.type === "clear-range",
        );
        if (clearInstruction) {
            const { startRow, endRow, startCol, endCol } = clearInstruction;
            sheetStore.clearBordersInRange(startRow, endRow, startCol, endCol);
            return;
        }

        // Apply edge-based borders
        sheetStore.applyBorders(borderInstructions);
    }

    // Alignment handler
    function handleAlignmentChange(align) {
        applyFormatting("horizontalAlign", align);
    }

    function handleCellTypeChange(config) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;

        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        // For whole-row mode, use setRowTypeConfig
        if (mode === "rows" && selectionState.selectedRows) {
            const { start, end } = selectionState.selectedRows;
            spreadsheetSession.ydoc?.transact(() => {
                for (let r = start; r <= end; r++) {
                    sheetStore.setRowTypeConfig(r, config);
                }
            });
            return;
        }

        // For whole-column mode, use setColTypeConfig
        if (mode === "cols" && selectionState.selectedCols) {
            const { start, end } = selectionState.selectedCols;
            spreadsheetSession.ydoc?.transact(() => {
                for (let c = start; c <= end; c++) {
                    sheetStore.setColTypeConfig(c, config);
                }
            });
            return;
        }

        // For range/all: set on individual cells
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;

        const renderContext = spreadsheetSession.renderContext;
        spreadsheetSession.ydoc?.transact(() => {
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (
                        ct === CELL_TYPE.TABLE_HEADER ||
                        ct === CELL_TYPE.TABLE_ENTRY ||
                        ct === CELL_TYPE.TABLE_DATA ||
                        ct === CELL_TYPE.VIEWPORT_OCCUPIED
                    )
                        continue;
                    sheetStore.setCellTypeConfig(r, c, config);
                }
            }
        });
    }

    // Vertical alignment handler
    function handleVerticalAlignmentChange(align) {
        applyFormatting("verticalAlign", align);
    }

    // Page setup / Print handler
    let showPageSetupPanel = $state(false);

    function handlePrint() {
        showPageSetupPanel = true;
    }

    // Show page break overlay while Page Setup panel is open
    $effect(() => {
        const settings = spreadsheetSession.activeSheetStore?.getPrintSettings?.() ?? {};
        document.dispatchEvent(new CustomEvent('togglePageBreaks', {
            detail: { show: showPageSetupPanel, settings }
        }));
    });


    // Clipboard handlers
    function handleCopy() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore) {
            clipboardManager.copy(sheetStore, spreadsheetSession);
        }
    }

    function handleCut() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore && spreadsheetSession.ydoc) {
            clipboardManager.cut(
                sheetStore,
                spreadsheetSession,
                spreadsheetSession.ydoc,
            );
        }
    }

    function handlePaste(mode = "full") {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore && spreadsheetSession.ydoc) {
            clipboardManager.paste(
                sheetStore,
                spreadsheetSession,
                spreadsheetSession.ydoc,
                mode,
            );
        }
    }

    // Has selection (works for all selectionMode values)
    let hasSelection = $derived(selectionState.anchor !== null);

    // Decimal adjustment for number formats
    function adjustDecimals(delta) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const anchor = selectionState.anchor;
        if (!sheetStore || !anchor) return;
        const cell = sheetStore.getCell(anchor.row, anchor.col);
        const config = cell?.typeConfig ?? { type: "number", decimals: 2 };
        const current = config.decimals ?? 2;
        handleCellTypeChange({ ...config, type: config.type || "number", decimals: Math.max(0, current + delta) });
    }

    function decreaseDecimals() { adjustDecimals(-1); }
    function increaseDecimals() { adjustDecimals(1); }
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
            class:active={showPageSetupPanel}
            onclick={handlePrint}
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
            onclick={() => handleCellTypeChange({ type: "currency", decimals: 2, symbol: "$" })}
            disabled={!hasSelection}
            title="Format as currency"
        >
            <span class="fmt-label">$</span>
        </button>
        <button
            class="toolbar-btn"
            onclick={() => handleCellTypeChange({ type: "percent", decimals: 1 })}
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
            <CellTypeConfigurator />
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
            value={selectedFormatting?.fontSize || 12}
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
    </div>

    <div class="divider"></div>

    <!-- Colors -->
    <div class="toolbar-group">
        <ColorPicker
            label="Text Color"
            variant="text"
            value={selectedFormatting?.color || "#000000"}
            onchange={handleTextColorChange}
        />
        <ColorPicker
            label="Background Color"
            variant="fill"
            value={selectedFormatting?.backgroundColor || "#ffffff"}
            onchange={handleBackgroundColorChange}
        />
    </div>

    <div class="divider"></div>

    <!-- Borders -->
    <div class="toolbar-group">
        <BorderPicker
            onchange={handleBorderChange}
            selectionRange={borderSelectionRange}
        />
    </div>

    <div class="divider"></div>

    <!-- Horizontal Alignment -->
    <div class="toolbar-group">
        <AlignmentPicker
            value={selectedFormatting?.horizontalAlign || "left"}
            onchange={handleAlignmentChange}
        />
    </div>

    <!-- Vertical Alignment -->
    <div class="toolbar-group">
        <AlignmentPicker
            value={selectedFormatting?.verticalAlign || "middle"}
            onchange={handleVerticalAlignmentChange}
            vertical={true}
        />
    </div>

    <!-- Spacer -->
    <div class="spacer"></div>
</div>

{#if showPageSetupPanel}
    <PageSetupPanel
        onclose={() => (showPageSetupPanel = false)}
    />
{/if}

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
    @media (pointer: coarse), (max-width: 768px) {
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
</style>
