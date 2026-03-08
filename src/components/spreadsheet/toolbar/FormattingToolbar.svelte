<script>
    import {
        spreadsheetSession,
        selectionState,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import { clipboardManager } from "../../../stores/spreadsheet/index.js";
    import ColorPicker from "./ColorPicker.svelte";
    import BorderPicker from "./BorderPicker.svelte";
    import AlignmentPicker from "./AlignmentPicker.svelte";

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

    // Derived: Get formatting state for selected cells
    let selectedFormatting = $derived.by(() => {
        const range = selectionState.range;
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!range || !sheetStore) {
            return null;
        }

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
            const values = new Set();
            for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                    const cell = sheetStore.getCell(r, c);
                    values.add(cell[key] ?? null);
                }
            }
            // If all values are the same, use that value; otherwise "mixed"
            props[key] = values.size === 1 ? [...values][0] : "mixed";
        }

        return props;
    });

    // Helper: Apply formatting to all selected cells
    function applyFormatting(property, value) {
        const range = selectionState.range;
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!range || !sheetStore) return;

        spreadsheetSession.ydoc?.transact(() => {
            for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
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

    // Has selection
    let hasSelection = $derived(!!selectionState.range);
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
