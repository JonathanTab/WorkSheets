<script>
    /**
     * MobileFormattingSheet — slide-up formatting drawer for mobile.
     * Provides all formatting controls from FormattingToolbar in large-touch-target rows.
     * Reuses the same store operations as FormattingToolbar.
     */
    import BottomSheet from "../ui/BottomSheet.svelte";
    import ColorPicker from "./toolbar/ColorPicker.svelte";
    import BorderPicker from "./toolbar/BorderPicker.svelte";
    import AlignmentPicker from "./toolbar/AlignmentPicker.svelte";
    import CellTypeConfigurator from "./toolbar/CellTypeConfigurator.svelte";
    import {
        spreadsheetSession,
        selectionState,
    } from "../../stores/spreadsheetStore.svelte.js";
    import {
        clipboardManager,
        editSessionState,
    } from "../../stores/spreadsheet/index.js";
    import { CELL_TYPE } from "../../stores/spreadsheet/features/SheetRenderContext.svelte.js";

    let { open = false, onClose = undefined } = $props();

    // Sub-sheet state
    let activeSection = $state(null); // 'color-text' | 'color-bg' | 'borders' | 'alignment' | 'cell-type'

    const fontFamilies = [
        { value: "Arial", label: "Arial" },
        { value: "Helvetica", label: "Helvetica" },
        { value: "Times New Roman", label: "Times New Roman" },
        { value: "Georgia", label: "Georgia" },
        { value: "Verdana", label: "Verdana" },
        { value: "Courier New", label: "Courier New" },
    ];

    const fontSizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

    const MAX_SAMPLE_CELLS = 200;

    let selectedFormatting = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return null;
        sheetStore.cellsVersion;

        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        if (mode === "rows" && selectionState.selectedRows) {
            const fmt = sheetStore.getRowFormatting?.(selectionState.selectedRows.start) ?? {};
            return { bold: fmt.bold ?? null, italic: fmt.italic ?? null, underline: fmt.underline ?? null,
                fontSize: fmt.fontSize ?? null, fontFamily: fmt.fontFamily ?? null,
                color: fmt.color ?? null, backgroundColor: fmt.backgroundColor ?? null,
                horizontalAlign: fmt.horizontalAlign ?? null, verticalAlign: fmt.verticalAlign ?? null };
        }
        if (mode === "cols" && selectionState.selectedCols) {
            const fmt = sheetStore.getColFormatting?.(selectionState.selectedCols.start) ?? {};
            return { bold: fmt.bold ?? null, italic: fmt.italic ?? null, underline: fmt.underline ?? null,
                fontSize: fmt.fontSize ?? null, fontFamily: fmt.fontFamily ?? null,
                color: fmt.color ?? null, backgroundColor: fmt.backgroundColor ?? null,
                horizontalAlign: fmt.horizontalAlign ?? null, verticalAlign: fmt.verticalAlign ?? null };
        }

        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return null;
        const renderContext = spreadsheetSession.renderContext;
        const props = {};
        const keys = ["bold","italic","underline","fontSize","fontFamily","color","backgroundColor","horizontalAlign","verticalAlign"];
        for (const key of keys) props[key] = { values: new Set() };
        let sampled = 0;
        outer: for (let r = eff.startRow; r <= eff.endRow && sampled < MAX_SAMPLE_CELLS; r++) {
            for (let c = eff.startCol; c <= eff.endCol && sampled < MAX_SAMPLE_CELLS; c++) {
                const ct = renderContext?.getCellType(r, c);
                if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY ||
                    ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.VIEWPORT_OCCUPIED) continue;
                const cell = sheetStore.getCell(r, c);
                for (const key of keys) props[key].values.add(cell[key] ?? null);
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

    function applyFormatting(property, value) {
        if (editSessionState.isEditing && editSessionState.richFormatApplier) {
            const propMap = { bold: ["fontWeight","bold"], italic: ["fontStyle","italic"],
                underline: ["underline",null], color: ["color",value],
                fontSize: ["fontSize",value], fontFamily: ["fontFamily",value] };
            const mapped = propMap[property];
            if (mapped && editSessionState.richFormatApplier(mapped[0], mapped[1] ?? value)) return;
        }
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;
        if (mode === "rows" && selectionState.selectedRows) {
            const { start, end } = selectionState.selectedRows;
            spreadsheetSession.ydoc?.transact(() => {
                for (let r = start; r <= end; r++) sheetStore.setRowFormatting?.(r, { [property]: value });
            });
            return;
        }
        if (mode === "cols" && selectionState.selectedCols) {
            const { start, end } = selectionState.selectedCols;
            spreadsheetSession.ydoc?.transact(() => {
                for (let c = start; c <= end; c++) sheetStore.setColFormatting?.(c, { [property]: value });
            });
            return;
        }
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const renderContext = spreadsheetSession.renderContext;
        spreadsheetSession.ydoc?.transact(() => {
            for (let r = eff.startRow; r <= eff.endRow; r++) {
                for (let c = eff.startCol; c <= eff.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY ||
                        ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.VIEWPORT_OCCUPIED) continue;
                    sheetStore.setCellProperties(r, c, { [property]: value });
                }
            }
        });
    }

    function toggleBold() { applyFormatting("bold", selectedFormatting?.bold === true ? false : true); }
    function toggleItalic() { applyFormatting("italic", selectedFormatting?.italic === true ? false : true); }
    function toggleUnderline() { applyFormatting("underline", selectedFormatting?.underline === true ? false : true); }
    function toggleStrikethrough() { applyFormatting("strikethrough", selectedFormatting?.strikethrough === true ? false : true); }

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

    function handleBorderChange(borderInstructions) {
        if (!borderInstructions || !Array.isArray(borderInstructions)) return;
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const clearInstruction = borderInstructions.find(i => i.type === "clear-range");
        if (clearInstruction) {
            const { startRow, endRow, startCol, endCol } = clearInstruction;
            sheetStore.clearBordersInRange(startRow, endRow, startCol, endCol);
            return;
        }
        sheetStore.applyBorders(borderInstructions);
    }

    // Row / col operations using selectionState
    function insertRowAbove() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
        if (!eff) return;
        const count = eff.endRow - eff.startRow + 1;
        for (let i = 0; i < count; i++) spreadsheetSession.insertRowAt(eff.startRow);
    }
    function insertRowBelow() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
        if (!eff) return;
        const count = eff.endRow - eff.startRow + 1;
        for (let i = 0; i < count; i++) spreadsheetSession.insertRowAt(eff.endRow + 1 + i);
    }
    function deleteSelectedRows() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
        if (!eff) return;
        for (let row = eff.endRow; row >= eff.startRow; row--) spreadsheetSession.deleteRowAt(row);
    }
    function insertColumnLeft() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
        if (!eff) return;
        const count = eff.endCol - eff.startCol + 1;
        for (let i = 0; i < count; i++) spreadsheetSession.insertColumnAt(eff.startCol);
    }
    function insertColumnRight() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
        if (!eff) return;
        const count = eff.endCol - eff.startCol + 1;
        for (let i = 0; i < count; i++) spreadsheetSession.insertColumnAt(eff.endCol + 1 + i);
    }
    function deleteSelectedColumns() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
        if (!eff) return;
        for (let col = eff.endCol; col >= eff.startCol; col--) spreadsheetSession.deleteColumnAt(col);
    }

    function clearSelection() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
        if (!eff) return;
        const renderContext = spreadsheetSession.renderContext;
        for (let r = eff.startRow; r <= eff.endRow; r++) {
            for (let c = eff.startCol; c <= eff.endCol; c++) {
                const ct = renderContext?.getCellType(r, c);
                if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_DATA ||
                    ct === CELL_TYPE.TABLE_ENTRY || ct === CELL_TYPE.VIEWPORT_OCCUPIED) continue;
                sheetStore.clearCell(r, c);
            }
        }
    }

    let currentFontSize = $derived(
        typeof selectedFormatting?.fontSize === "number" ? selectedFormatting.fontSize : 12
    );
    let currentFontFamily = $derived(
        typeof selectedFormatting?.fontFamily === "string" ? selectedFormatting.fontFamily : "Arial"
    );
    let textColor = $derived(
        typeof selectedFormatting?.color === "string" ? selectedFormatting.color : null
    );
    let bgColor = $derived(
        typeof selectedFormatting?.backgroundColor === "string" ? selectedFormatting.backgroundColor : null
    );

    // Border selection range (same logic as FormattingToolbar)
    let borderSelectionRange = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return null;
        const mode = selectionState.selectionMode;
        if (mode !== 'range') return selectionState.effectiveRange(sheetStore.rowCount, sheetStore.colCount);
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
</script>

<BottomSheet {open} {onClose} title="Format" maxHeight="85vh">
    <div class="fmt-sheet">

        <!-- ── Clipboard ─────────────────────────── -->
        <div class="fmt-section">
            <div class="fmt-row clipboard-row">
                <button class="clipboard-btn" onclick={() => { clipboardManager.copy(); onClose?.(); }}>
                    <span class="clipboard-icon">⎘</span> Copy
                </button>
                <button class="clipboard-btn" onclick={() => { clipboardManager.cut(); onClose?.(); }}>
                    <span class="clipboard-icon">✂</span> Cut
                </button>
                <button class="clipboard-btn" onclick={() => { clipboardManager.paste(); onClose?.(); }}>
                    <span class="clipboard-icon">📋</span> Paste
                </button>
                <button class="clipboard-btn danger" onclick={() => { clearSelection(); onClose?.(); }}>
                    <span class="clipboard-icon">🗑</span> Clear
                </button>
            </div>
        </div>

        <div class="fmt-divider"></div>

        <!-- ── Font ──────────────────────────────── -->
        <div class="fmt-section">
            <div class="fmt-section-label">Font</div>
            <div class="fmt-row">
                <select
                    class="font-family-select"
                    value={currentFontFamily}
                    onchange={(e) => applyFormatting("fontFamily", e.target.value)}
                >
                    {#each fontFamilies as f}
                        <option value={f.value}>{f.label}</option>
                    {/each}
                </select>
            </div>
            <div class="fmt-row size-row">
                <span class="fmt-row-label">Size</span>
                <div class="size-controls">
                    <button class="size-btn" onclick={decrementFontSize} aria-label="Decrease font size">−</button>
                    <span class="size-display">{currentFontSize}</span>
                    <button class="size-btn" onclick={incrementFontSize} aria-label="Increase font size">+</button>
                </div>
            </div>
        </div>

        <div class="fmt-divider"></div>

        <!-- ── Style ─────────────────────────────── -->
        <div class="fmt-section">
            <div class="fmt-section-label">Style</div>
            <div class="fmt-row style-row">
                <button
                    class="style-btn"
                    class:active={selectedFormatting?.bold === true}
                    onclick={toggleBold}
                    aria-label="Bold"
                ><strong>B</strong></button>
                <button
                    class="style-btn"
                    class:active={selectedFormatting?.italic === true}
                    onclick={toggleItalic}
                    aria-label="Italic"
                ><em>I</em></button>
                <button
                    class="style-btn"
                    class:active={selectedFormatting?.underline === true}
                    onclick={toggleUnderline}
                    aria-label="Underline"
                ><span style="text-decoration: underline">U</span></button>
                <button
                    class="style-btn"
                    class:active={selectedFormatting?.strikethrough === true}
                    onclick={toggleStrikethrough}
                    aria-label="Strikethrough"
                ><span style="text-decoration: line-through">S</span></button>
            </div>
        </div>

        <div class="fmt-divider"></div>

        <!-- ── Colors ────────────────────────────── -->
        <div class="fmt-section">
            <div class="fmt-section-label">Color</div>
            <div class="fmt-row color-row">
                <button
                    class="color-row-btn"
                    onclick={() => activeSection = activeSection === 'color-text' ? null : 'color-text'}
                    aria-expanded={activeSection === 'color-text'}
                >
                    <span class="color-swatch" style="background: {textColor || '#1e293b'}"></span>
                    Text color
                    <span class="expand-chevron" class:rotated={activeSection === 'color-text'}>▼</span>
                </button>
            </div>
            {#if activeSection === 'color-text'}
                <div class="color-picker-inline">
                    <ColorPicker
                        value={textColor || '#1e293b'}
                        onChange={(c) => applyFormatting("color", c)}
                    />
                </div>
            {/if}
            <div class="fmt-row color-row">
                <button
                    class="color-row-btn"
                    onclick={() => activeSection = activeSection === 'color-bg' ? null : 'color-bg'}
                    aria-expanded={activeSection === 'color-bg'}
                >
                    <span class="color-swatch" style="background: {bgColor || 'transparent'}; border: 1px solid var(--color-border)"></span>
                    Fill color
                    <span class="expand-chevron" class:rotated={activeSection === 'color-bg'}>▼</span>
                </button>
            </div>
            {#if activeSection === 'color-bg'}
                <div class="color-picker-inline">
                    <ColorPicker
                        value={bgColor || '#ffffff'}
                        onChange={(c) => applyFormatting("backgroundColor", c)}
                    />
                </div>
            {/if}
        </div>

        <div class="fmt-divider"></div>

        <!-- ── Alignment ─────────────────────────── -->
        <div class="fmt-section">
            <div class="fmt-row color-row">
                <button
                    class="color-row-btn"
                    onclick={() => activeSection = activeSection === 'alignment' ? null : 'alignment'}
                    aria-expanded={activeSection === 'alignment'}
                >
                    Alignment
                    <span class="expand-chevron" class:rotated={activeSection === 'alignment'}>▼</span>
                </button>
            </div>
            {#if activeSection === 'alignment'}
                <div class="picker-inline">
                    <AlignmentPicker
                        horizontalAlign={selectedFormatting?.horizontalAlign}
                        verticalAlign={selectedFormatting?.verticalAlign}
                        onHorizontalChange={(v) => applyFormatting("horizontalAlign", v)}
                        onVerticalChange={(v) => applyFormatting("verticalAlign", v)}
                    />
                </div>
            {/if}
        </div>

        <div class="fmt-divider"></div>

        <!-- ── Borders ───────────────────────────── -->
        <div class="fmt-section">
            <div class="fmt-row color-row">
                <button
                    class="color-row-btn"
                    onclick={() => activeSection = activeSection === 'borders' ? null : 'borders'}
                    aria-expanded={activeSection === 'borders'}
                >
                    Borders
                    <span class="expand-chevron" class:rotated={activeSection === 'borders'}>▼</span>
                </button>
            </div>
            {#if activeSection === 'borders'}
                <div class="picker-inline">
                    <BorderPicker
                        selectionRange={borderSelectionRange}
                        onChange={handleBorderChange}
                    />
                </div>
            {/if}
        </div>

        <div class="fmt-divider"></div>

        <!-- ── Cell Type ─────────────────────────── -->
        <div class="fmt-section">
            <div class="fmt-row color-row">
                <button
                    class="color-row-btn"
                    onclick={() => activeSection = activeSection === 'cell-type' ? null : 'cell-type'}
                    aria-expanded={activeSection === 'cell-type'}
                >
                    Cell type
                    <span class="expand-chevron" class:rotated={activeSection === 'cell-type'}>▼</span>
                </button>
            </div>
            {#if activeSection === 'cell-type'}
                <div class="picker-inline">
                    <CellTypeConfigurator />
                </div>
            {/if}
        </div>

        <div class="fmt-divider"></div>

        <!-- ── Rows & Columns ────────────────────── -->
        <div class="fmt-section">
            <div class="fmt-section-label">Rows & Columns</div>
            <div class="fmt-row actions-grid">
                <button class="action-btn" onclick={() => { insertRowAbove(); onClose?.(); }}>Insert row above</button>
                <button class="action-btn" onclick={() => { insertRowBelow(); onClose?.(); }}>Insert row below</button>
                <button class="action-btn" onclick={() => { insertColumnLeft(); onClose?.(); }}>Insert col left</button>
                <button class="action-btn" onclick={() => { insertColumnRight(); onClose?.(); }}>Insert col right</button>
                <button class="action-btn danger" onclick={() => { deleteSelectedRows(); onClose?.(); }}>Delete rows</button>
                <button class="action-btn danger" onclick={() => { deleteSelectedColumns(); onClose?.(); }}>Delete cols</button>
            </div>
        </div>

        <!-- Bottom padding so content clears safe area -->
        <div style="height: env(safe-area-inset-bottom, 16px)"></div>
    </div>
</BottomSheet>

<style>
    .fmt-sheet {
        padding: 0 0 8px;
    }

    .fmt-section {
        padding: 0 16px;
    }

    .fmt-section-label {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-text-secondary, #64748b);
        padding: 10px 0 4px;
    }

    .fmt-row {
        display: flex;
        align-items: center;
        min-height: 48px;
        gap: 8px;
    }

    .fmt-divider {
        height: 1px;
        background: var(--color-border, #e2e8f0);
        margin: 4px 0;
    }

    /* Clipboard */
    .clipboard-row {
        gap: 6px;
        padding: 8px 0;
    }

    .clipboard-btn {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 10px 4px;
        background: var(--color-fill, #f1f5f9);
        border: none;
        border-radius: 8px;
        font-size: 0.75rem;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
    }

    .clipboard-btn:active {
        background: var(--color-border, #e2e8f0);
    }

    .clipboard-btn.danger {
        color: var(--color-danger, #dc2626);
    }

    .clipboard-icon {
        font-size: 1.1rem;
    }

    /* Font */
    .font-family-select {
        width: 100%;
        padding: 10px 12px;
        font-size: 0.9375rem;
        background: var(--color-fill, #f1f5f9);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 8px;
        color: var(--color-text, #1e293b);
        appearance: auto;
        height: 44px;
    }

    .size-row {
        justify-content: space-between;
        padding: 4px 0;
    }

    .fmt-row-label {
        font-size: 0.9375rem;
        color: var(--color-text, #1e293b);
    }

    .size-controls {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .size-btn {
        width: 40px;
        height: 40px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 8px;
        background: var(--color-fill, #f1f5f9);
        font-size: 1.25rem;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        -webkit-tap-highlight-color: transparent;
    }

    .size-btn:active {
        background: var(--color-border, #e2e8f0);
    }

    .size-display {
        font-size: 1rem;
        font-weight: 600;
        min-width: 2.5ch;
        text-align: center;
        color: var(--color-text, #1e293b);
    }

    /* Style buttons */
    .style-row {
        gap: 10px;
        padding: 4px 0;
    }

    .style-btn {
        width: 48px;
        height: 48px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 8px;
        background: var(--color-fill, #f1f5f9);
        font-size: 1.125rem;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        -webkit-tap-highlight-color: transparent;
        transition: background 0.1s, border-color 0.1s;
    }

    .style-btn.active {
        background: var(--color-primary, #3b82f6);
        border-color: var(--color-primary, #3b82f6);
        color: #fff;
    }

    .style-btn:active {
        opacity: 0.75;
    }

    /* Color rows */
    .color-row {
        padding: 4px 0;
    }

    .color-row-btn {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 12px 0;
        background: transparent;
        border: none;
        font-size: 0.9375rem;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        text-align: left;
        -webkit-tap-highlight-color: transparent;
    }

    .color-swatch {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .expand-chevron {
        margin-left: auto;
        font-size: 0.625rem;
        color: var(--color-text-secondary, #64748b);
        transition: transform 0.15s;
    }

    .expand-chevron.rotated {
        transform: rotate(180deg);
    }

    .color-picker-inline,
    .picker-inline {
        padding: 8px 0 12px;
    }

    /* Actions grid */
    .actions-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        padding: 8px 0;
        flex-wrap: wrap;
    }

    .action-btn {
        padding: 12px 8px;
        background: var(--color-fill, #f1f5f9);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 8px;
        font-size: 0.8125rem;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        text-align: center;
        -webkit-tap-highlight-color: transparent;
    }

    .action-btn:active {
        background: var(--color-border, #e2e8f0);
    }

    .action-btn.danger {
        color: var(--color-danger, #dc2626);
        border-color: #fecaca;
        background: #fff5f5;
    }

    .action-btn.danger:active {
        background: #fee2e2;
    }
</style>
