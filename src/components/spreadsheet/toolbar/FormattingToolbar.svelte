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

    /**
     * Returns { table, colId, colDef } when the anchor cell is inside a table,
     * otherwise null.  Reads table.columns to establish reactivity so that
     * selectedFormatting re-derives whenever any column property changes.
     */
    /**
     * When the anchor is on a TABLE_HEADER, returns { table, colId, colDef } for routing
     * formatting to the column definition. Returns null for all other cell types.
     */
    function getTableColContext() {
        const renderContext = spreadsheetSession.renderContext;
        const anchor = selectionState.anchor;
        if (!anchor || !renderContext) return null;
        const cellType = renderContext.getCellType(anchor.row, anchor.col);
        if (cellType !== CELL_TYPE.TABLE_HEADER) return null;
        const info = renderContext.tableManager?.getCellInfo(anchor.row, anchor.col);
        if (!info?.table || !info?.colDef) return null;
        const liveCol = info.table.columns.find(c => c.id === info.colDef.id) ?? info.colDef;
        return { table: info.table, colId: liveCol.id, colDef: liveCol };
    }

    /**
     * When the anchor is on a TABLE_DATA or TABLE_ENTRY cell, returns the cell info
     * for routing formatting to per-cell storage. Returns null for other cell types.
     */
    function getTableDataCellInfo() {
        const renderContext = spreadsheetSession.renderContext;
        const anchor = selectionState.anchor;
        if (!anchor || !renderContext) return null;
        const cellType = renderContext.getCellType(anchor.row, anchor.col);
        if (cellType !== CELL_TYPE.TABLE_DATA && cellType !== CELL_TYPE.TABLE_ENTRY) return null;
        return renderContext.tableManager?.getCellInfo(anchor.row, anchor.col) ?? null;
    }

    let selectedFormatting = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return null;

        // TABLE_HEADER: read formatting from column definition
        const tcc = getTableColContext();
        if (tcc) {
            const cd = tcc.colDef;
            return {
                bold: cd.bold ?? null,
                italic: cd.italic ?? null,
                underline: cd.underline ?? null,
                fontSize: cd.fontSize ?? null,
                fontFamily: cd.fontFamily ?? null,
                color: cd.textColor ?? null,
                backgroundColor: cd.bgColor ?? null,
                horizontalAlign: cd.hAlign ?? null,
                verticalAlign: null,
            };
        }

        // TABLE_DATA / TABLE_ENTRY: read effective merged formatting (col → row → cell)
        const tdi = getTableDataCellInfo();
        if (tdi?.table && tdi?.colDef && tdi.dataIndex >= 0) {
            const fmt = tdi.table.getEffectiveCellFormatting(tdi.dataIndex, tdi.colDef.id);
            return {
                bold: fmt.bold ?? null,
                italic: fmt.italic ?? null,
                underline: fmt.underline ?? null,
                fontSize: fmt.fontSize ?? null,
                fontFamily: fmt.fontFamily ?? null,
                color: fmt.color ?? null,
                backgroundColor: fmt.backgroundColor ?? null,
                horizontalAlign: fmt.horizontalAlign ?? null,
                verticalAlign: fmt.verticalAlign ?? null,
            };
        }

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
                const ct = renderContext?.getCellType(r, c);
                if (ct === CELL_TYPE.TABLE_HEADER) continue;

                if (ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.TABLE_ENTRY) {
                    // Sample effective merged formatting from the table store
                    const info = renderContext?.tableManager?.getCellInfo(r, c);
                    if (info?.table && info.colDef && info.dataIndex >= 0) {
                        const fmt = info.table.getEffectiveCellFormatting(info.dataIndex, info.colDef.id);
                        const fmtKeyMap = { color: 'color', backgroundColor: 'backgroundColor',
                            bold: 'bold', italic: 'italic', underline: 'underline',
                            fontSize: 'fontSize', fontFamily: 'fontFamily',
                            horizontalAlign: 'horizontalAlign', verticalAlign: 'verticalAlign' };
                        for (const key of keys) {
                            props[key].values.add(fmt[fmtKeyMap[key]] ?? null);
                            props[key].count++;
                        }
                        sampled++;
                    }
                    continue;
                }

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
        // applyInlineFormat returns true if a selection existed and formatting was applied,
        // false if the cursor was collapsed (fall through to cell-level formatting).
        if (editSessionState.isEditing && editSessionState.applyInlineFormat) {
            // Map toolbar property names to TextFormat property names
            const tfrPropMap = {
                bold:          'bold',
                italic:        'italic',
                underline:     'underline',
                strikethrough: 'strikethrough',
                color:         'foregroundColor',
                fontSize:      'fontSize',
                fontFamily:    'fontFamily',
            };
            const tfrProp = tfrPropMap[property];
            if (tfrProp) {
                // Toggle props (bold/italic/underline/strikethrough) pass undefined
                // so applyInlineFormat uses toggleFormatInRange
                const toggleProps = new Set(['bold', 'italic', 'underline', 'strikethrough']);
                const tfrValue = toggleProps.has(property) ? undefined : value;
                const applied = editSessionState.applyInlineFormat(tfrProp, tfrValue);
                if (applied) return;
            }
        }

        // Table column context: route all formatting to the column def
        const tcc = getTableColContext();
        if (tcc) {
            const colPropMap = {
                bold: 'bold',
                italic: 'italic',
                underline: 'underline',
                fontSize: 'fontSize',
                fontFamily: 'fontFamily',
                color: 'textColor',
                backgroundColor: 'bgColor',
                horizontalAlign: 'hAlign',
            };
            const colProp = colPropMap[property];
            if (colProp) tcc.table.updateColumnDef(tcc.colId, { [colProp]: value });
            return;
        }

        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;

        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        if (mode === "rows") {
            const rowRanges = selectionState.allRowRanges;
            if (rowRanges.length === 0) return;
            spreadsheetSession.ydoc?.transact(() => {
                for (const { start, end } of rowRanges) {
                    for (let r = start; r <= end; r++) {
                        sheetStore.setRowFormatting?.(r, { [property]: value });
                    }
                }
            });
            return;
        }

        if (mode === "cols") {
            const colRanges = selectionState.allColRanges;
            if (colRanges.length === 0) return;
            spreadsheetSession.ydoc?.transact(() => {
                for (const { start, end } of colRanges) {
                    for (let c = start; c <= end; c++) {
                        sheetStore.setColFormatting?.(c, { [property]: value });
                    }
                }
            });
            return;
        }

        // Range / all mode — iterate all selected ranges, routing each cell correctly.
        // TABLE_DATA/TABLE_ENTRY → per-cell table formatting.
        // TABLE_HEADER → skip (format headers by selecting them directly).
        // Regular cells → sheetStore.setCellProperties.
        const ranges = mode === 'all'
            ? [selectionState.effectiveRange(rowCount, colCount)]
            : selectionState.allRanges;
        if (ranges.length === 0 || !ranges[0]) return;

        const renderContext = spreadsheetSession.renderContext;
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                if (!eff) continue;
                for (let r = eff.startRow; r <= eff.endRow; r++) {
                    for (let c = eff.startCol; c <= eff.endCol; c++) {
                        const ct = renderContext?.getCellType(r, c);
                        if (ct === CELL_TYPE.TABLE_HEADER) continue;
                        if (ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.TABLE_ENTRY) {
                            const info = renderContext?.tableManager?.getCellInfo(r, c);
                            if (info?.table && info.colDef && !info.colDef.isNonEntry && info.dataIndex >= 0) {
                                info.table.setCellFormatting(info.dataIndex, info.colDef.id, { [property]: value });
                            }
                            continue;
                        }
                        sheetStore.setCellProperties(r, c, { [property]: value });
                    }
                }
            }
        });
    }

    // ── Link button state ────────────────────────────────────────────────────
    let linkInputVisible = $state(false);
    let linkInputValue   = $state('');
    let linkInputEl      = $state(null);

    function openLinkInput() {
        linkInputValue   = '';
        linkInputVisible = true;
        setTimeout(() => linkInputEl?.focus(), 0);
    }

    function applyLink() {
        const url = linkInputValue.trim();
        if (url && editSessionState.applyInlineFormat) {
            // Prepend https:// if no protocol given
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

    // The effective font size for display and +/- stepping:
    // During inline editing, prefer the run-level size at the selection over cell-level.
    let displayFontSize = $derived.by(() => {
        if (editSessionState.isEditing) {
            const s = editSessionState.inlineSelFontSize;
            if (typeof s === 'number') return s;
            if (s === 'mixed') return '';
        }
        const sf = selectedFormatting?.fontSize;
        if (sf === 'mixed') return '';
        return sf || 12;
    });

    function getStepBaseFontSize() {
        if (editSessionState.isEditing) {
            const s = editSessionState.inlineSelFontSize;
            if (typeof s === 'number') return s;
        }
        const sf = selectedFormatting?.fontSize;
        return typeof sf === 'number' ? sf : 12;
    }

    // Font size handler
    function handleFontSizeChange(e) {
        const size = parseInt(e.target.value, 10);
        if (!isNaN(size) && size > 0) {
            applyFormatting("fontSize", size);
        }
    }

    function decrementFontSize() {
        const current = getStepBaseFontSize();
        const idx = fontSizes.findLastIndex(s => s < current);
        if (idx >= 0) applyFormatting("fontSize", fontSizes[idx]);
    }

    function incrementFontSize() {
        const current = getStepBaseFontSize();
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
        // Table column context: route type config to the column def
        const tcc = getTableColContext();
        if (tcc) {
            tcc.table.updateColumnTypeConfig(tcc.colId, config);
            return;
        }

        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;

        const mode = selectionState.selectionMode;
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        // For whole-row mode, use setRowTypeConfig
        if (mode === "rows") {
            spreadsheetSession.ydoc?.transact(() => {
                for (const { start, end } of selectionState.allRowRanges) {
                    for (let r = start; r <= end; r++) sheetStore.setRowTypeConfig(r, config);
                }
            });
            return;
        }

        // For whole-column mode, use setColTypeConfig
        if (mode === "cols") {
            spreadsheetSession.ydoc?.transact(() => {
                for (const { start, end } of selectionState.allColRanges) {
                    for (let c = start; c <= end; c++) sheetStore.setColTypeConfig(c, config);
                }
            });
            return;
        }

        // For range/all: set on individual cells
        const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
        if (ranges.length === 0) return;

        const renderContext = spreadsheetSession.renderContext;
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                for (let r = eff.startRow; r <= eff.endRow; r++) {
                    for (let c = eff.startCol; c <= eff.endCol; c++) {
                        const ct = renderContext?.getCellType(r, c);
                        if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY ||
                            ct === CELL_TYPE.TABLE_DATA) continue;
                        sheetStore.setCellTypeConfig(r, c, config);
                    }
                }
            }
        });
    }

    // Vertical alignment handler
    function handleVerticalAlignmentChange(align) {
        applyFormatting("verticalAlign", align);
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

    // When a table column is selected, expose its typeConfig for the CellTypeConfigurator
    let tableColTypeConfig = $derived.by(() => {
        const tcc = getTableColContext();
        if (!tcc) return null;
        return tcc.colDef.typeConfig ?? (tcc.colDef.type ? { type: tcc.colDef.type } : null);
    });

    // Decimal adjustment for number formats
    function adjustDecimals(delta) {
        const anchor = selectionState.anchor;
        if (!anchor) return;
        // Table column: read config from colDef
        const tcc = getTableColContext();
        if (tcc) {
            const config = tcc.colDef.typeConfig ?? { type: "number", decimals: 2 };
            const current = config.decimals ?? 2;
            handleCellTypeChange({ ...config, type: config.type || "number", decimals: Math.max(0, current + delta) });
            return;
        }
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
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
                onclick={openLinkInput}
                title="Insert link"
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
