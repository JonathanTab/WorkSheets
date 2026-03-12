<script>
    import {
        spreadsheetSession,
        selectionState,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import { clipboardManager, editSessionState } from "../../../stores/spreadsheet/index.js";
    import { CELL_TYPE } from "../../../stores/spreadsheet/features/SheetRenderContext.svelte.js";
    import ColorPicker from "./ColorPicker.svelte";
    import BorderPicker from "./BorderPicker.svelte";
    import AlignmentPicker from "./AlignmentPicker.svelte";
    import MenuDropdown from "./MenuDropdown.svelte";
    import CellTypeConfigurator from "./CellTypeConfigurator.svelte";

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

    // Derived: Get formatting state for selected cells
    let selectedFormatting = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return null;

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
        // When editing a rich-text cell with a text selection, apply inline formatting
        if (editSessionState.richTextValue != null && editSessionState.richFormatApplier) {
            const propMap = {
                bold: ['fontWeight', 'bold'],
                italic: ['fontStyle', 'italic'],
                underline: ['underline', null],
                strikethrough: ['strikethrough', null],
                color: ['color', value],
                fontSize: ['fontSize', value],
            };
            const mapped = propMap[property];
            if (mapped) {
                editSessionState.richFormatApplier(mapped[0], mapped[1] ?? value);
                return;
            }
        }

        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;

        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        if (mode === "rows" && selectionState.selectedRows) {
            const { start, end } = selectionState.selectedRows;
            for (let r = start; r <= end; r++) {
                sheetStore.setRowFormatting?.(r, { [property]: value });
            }
            return;
        }

        if (mode === "cols" && selectionState.selectedCols) {
            const { start, end } = selectionState.selectedCols;
            for (let c = start; c <= end; c++) {
                sheetStore.setColFormatting?.(c, { [property]: value });
            }
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

        // For whole-column mode, use setColTypeConfig
        if (mode === "cols" && selectionState.selectedCols) {
            const { start, end } = selectionState.selectedCols;
            for (let c = start; c <= end; c++) {
                sheetStore.setColTypeConfig(c, config);
            }
            return;
        }

        // For range/row/all: set on individual cells
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

    // Print handler
    function handlePrint() {
        window.print();
    }

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

    // Merge state — only valid for range mode
    let canMerge = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return false;
        const eff = selectionState.effectiveRange(
            sheetStore.rowCount,
            sheetStore.colCount,
        );
        if (!eff) return false;
        return eff.startRow !== eff.endRow || eff.startCol !== eff.endCol;
    });

    let isMergedCell = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const anchor = selectionState.anchor;
        if (!sheetStore?.mergeEngine || !anchor) return false;
        return sheetStore.mergeEngine.isMergePrimary(anchor.row, anchor.col);
    });

    function toggleMerge() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;

        if (isMergedCell) {
            // Unmerge
            const anchor = selectionState.anchor;
            if (anchor) {
                sheetStore.unmergeCells(anchor.row, anchor.col);
            }
        } else if (canMerge) {
            // Merge using the range selection only
            const range = selectionState.range;
            if (range) {
                sheetStore.mergeCells(
                    range.startRow,
                    range.startCol,
                    range.endRow,
                    range.endCol,
                );
            }
        }
    }
</script>

<div class="formatting-toolbar">
    <!-- Undo/Redo -->
    <div class="toolbar-group">
        <button
            class="toolbar-btn"
            class:disabled={!spreadsheetSession.canUndo}
            onclick={() => spreadsheetSession.undo()}
            disabled={!spreadsheetSession.canUndo}
            title="Undo (Ctrl+Z)"
        >
            ↶
        </button>
        <button
            class="toolbar-btn"
            class:disabled={!spreadsheetSession.canRedo}
            onclick={() => spreadsheetSession.redo()}
            disabled={!spreadsheetSession.canRedo}
            title="Redo (Ctrl+Shift+Z)"
        >
            ↷
        </button>
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
            ✂
        </button>
        <button
            class="toolbar-btn"
            class:disabled={!hasSelection}
            onclick={handleCopy}
            disabled={!hasSelection}
            title="Copy (Ctrl+C)"
        >
            📋
        </button>
        <button
            class="toolbar-btn"
            onclick={() => handlePaste("full")}
            title="Paste (Ctrl+V)"
        >
            📄
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
    <div class="toolbar-group">
        <input
            type="text"
            class="font-size-input"
            value={selectedFormatting?.fontSize || 12}
            onchange={handleFontSizeChange}
            disabled={!hasSelection}
            size="3"
        />
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
            value={selectedFormatting?.color || "#000000"}
            onchange={handleTextColorChange}
        />
        <ColorPicker
            label="Background Color"
            value={selectedFormatting?.backgroundColor || "#ffffff"}
            onchange={handleBackgroundColorChange}
        />
    </div>

    <div class="divider"></div>

    <!-- Borders -->
    <div class="toolbar-group">
        <BorderPicker
            value={selectedFormatting?.border}
            onchange={handleBorderChange}
            selectionRange={selectionState.range}
        />
    </div>

    <div class="divider"></div>

    <!-- Alignment -->
    <div class="toolbar-group">
        <AlignmentPicker
            value={selectedFormatting?.horizontalAlign || "left"}
            onchange={handleAlignmentChange}
        />
    </div>

    <div class="divider"></div>

    <!-- Cell Type -->
    <div class="toolbar-group">
        <MenuDropdown icon="123" title="Cell Type">
            <CellTypeConfigurator {selectionState} />
        </MenuDropdown>
    </div>

    <div class="divider"></div>

    <!-- Merge Cells -->
    <div class="toolbar-group">
        <button
            class="toolbar-btn"
            class:active={isMergedCell}
            onclick={toggleMerge}
            disabled={!canMerge && !isMergedCell}
            title={isMergedCell ? "Unmerge Cells" : "Merge Cells"}
        >
            ⊞
        </button>
    </div>

    <!-- Spacer -->
    <div class="spacer"></div>

    <!-- Print -->
    <div class="toolbar-group">
        <button
            class="toolbar-btn"
            onclick={handlePrint}
            title="Print (Ctrl+P)"
        >
            🖨
        </button>
    </div>
</div>

<style>
    .formatting-toolbar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 0.5rem;
    }

    .toolbar-group {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .toolbar-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        height: 28px;
        padding: 0 6px;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
        color: var(--color-text);
    }

    .toolbar-btn:hover:not(.disabled) {
        background: var(--color-fill);
    }

    .toolbar-btn.active {
        background: var(--color-primary-soft);
        color: var(--color-primary);
    }

    .toolbar-btn.disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .divider {
        width: 1px;
        height: 20px;
        background: var(--color-border);
        margin: 0 4px;
    }

    .spacer {
        flex: 1;
    }

    .font-family-select {
        height: 28px;
        padding: 0 8px;
        font-size: 0.8125rem;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
        cursor: pointer;
    }

    .font-family-select:hover {
        border-color: var(--color-border-strong);
    }

    .font-family-select:focus {
        outline: none;
        border-color: var(--color-primary);
    }

    .font-size-input {
        width: 40px;
        height: 28px;
        padding: 0 4px;
        font-size: 0.8125rem;
        text-align: center;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
    }

    .font-size-input:hover {
        border-color: var(--color-border-strong);
    }

    .font-size-input:focus {
        outline: none;
        border-color: var(--color-primary);
    }

    .font-size-input:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
</style>
