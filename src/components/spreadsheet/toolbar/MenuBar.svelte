<script>
    import MenuDropdown from "./MenuDropdown.svelte";
    import {
        spreadsheetSession,
        selectionState,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import {
        paste,
        trash,
        cut,
        copy,
        table,
        download,
        printer,
        filter,
        info,
        imageIcon,
        functionIcon,
    } from "../../../lib/icons/index.js";
    import { clipboardManager } from "../../../stores/spreadsheet/index.js";
    import { clearFormatting as clearFormattingCmd } from "../../../stores/spreadsheet/formatCommands.js";
    import { applyFormatting as applyFormattingCmd } from "../../../stores/spreadsheet/cellFormattingCommands.js";
    import TableCreateDialog from "../features/TableCreateDialog.svelte";
    import RepeaterCreateDialog from "../features/RepeaterCreateDialog.svelte";
    import { openModal } from "../../../lib/ui/modalStore.svelte.js";
    import AlertModal from "../../modals/AlertModal.svelte";
    import ConditionalFormatPanel from "../ConditionalFormatPanel.svelte";
    import DataValidationPanel from "../DataValidationPanel.svelte";
    import FormulaDocsPanel from "../FormulaDocsPanel.svelte";
    import MakeCopyModal from "../../modals/MakeCopyModal.svelte";
    import MoveFileModal from "../../modals/MoveFileModal.svelte";
    import PromptModal from "../../modals/PromptModal.svelte";
    import ShareFileModal from "../../modals/ShareFileModal.svelte";
    import VersionHistoryModal from "../../modals/VersionHistoryModal.svelte";
    import ConfirmModal from "../../modals/ConfirmModal.svelte";
    import { storage } from "../../../stores/storage.js";
    import {
        deleteDocument,
        renameDocument,
    } from "../../../stores/spreadsheet/SpreadsheetSession.svelte.js";

    let { showTablesPanel = false, onShowTablesPanel = undefined } = $props();

    let showCFPanel = $state(false);
    let showDVPanel = $state(false);
    let showFormulaDocs = $state(false);

    function openPdfExport() {
        document.dispatchEvent(new CustomEvent('openPdfExport'));
    }

    function showAlert(title, message, type = "info") {
        openModal(AlertModal, { title, message, type });
    }

    // Shared state for cursor-following menu behavior
    let openMenuId = $state(null);

    function handleMenuOpenChange(isOpen, menuId) {
        if (isOpen) {
            openMenuId = menuId;
        } else if (openMenuId === menuId) {
            openMenuId = null;
        }
    }

    // Dialog state for table/repeater creation
    let showCreateTableDialog = $state(false);
    let showCreateRepeaterDialog = $state(false);

    // ─── VIEW STATE ───────────────────────────────────────────────────────────
    // Local state mirrors what was dispatched so checkmarks stay correct
    let viewFormulaBar = $state(true);
    let viewGridlines = $state(true);
    let viewFormulas = $state(false);
    let showPageBreakMarkers = $state(false);

    function dispatchViewChange(key, value) {
        document.dispatchEvent(new CustomEvent('spreadsheetViewChange', { detail: { key, value } }));
    }

    function toggleViewFormulaBar() {
        viewFormulaBar = !viewFormulaBar;
        dispatchViewChange('formulaBar', viewFormulaBar);
    }

    function toggleViewGridlines() {
        viewGridlines = !viewGridlines;
        dispatchViewChange('gridlines', viewGridlines);
    }

    function toggleViewFormulas() {
        viewFormulas = !viewFormulas;
        dispatchViewChange('formulas', viewFormulas);
    }

    function togglePageBreakMarkers() {
        showPageBreakMarkers = !showPageBreakMarkers;
        document.dispatchEvent(new CustomEvent('togglePageBreaks', {
            detail: { show: showPageBreakMarkers },
        }));
    }

    // ─── FILE MENU ────────────────────────────────────────────────────────────

    function openMakeCopyModal() {
        const docId = spreadsheetSession.docId;
        if (!docId) return;
        const file = storage.drive.getFile(docId);
        if (!file) return;
        openModal(MakeCopyModal, { file });
    }

    function openShareModal() {
        const docId = spreadsheetSession.docId;
        if (!docId) return;
        const file = storage.drive.getFile(docId);
        if (!file) return;
        openModal(ShareFileModal, { file });
    }

    function openMoveModal() {
        const docId = spreadsheetSession.docId;
        if (!docId) return;
        const file = storage.drive.getFile(docId);
        if (!file) return;
        openModal(MoveFileModal, {
            file,
            onConfirm: async (/** @type {string|null} */ targetFolderId) => {
                await storage.drive.moveFile(docId, targetFolderId);
            },
        });
    }

    function openRenameModal() {
        const docId = spreadsheetSession.docId;
        if (!docId) return;
        openModal(PromptModal, {
            title: "Rename",
            value: spreadsheetSession.docTitle || "Untitled",
            confirmText: "Rename",
            onConfirm: async (/** @type {string} */ newTitle) => {
                await renameDocument(docId, newTitle);
            },
        });
    }

    function openDeleteConfirm() {
        const docId = spreadsheetSession.docId;
        if (!docId) return;
        openModal(ConfirmModal, {
            title: "Delete document",
            message: `Delete "${spreadsheetSession.docTitle || "Untitled"}"? It will be moved to trash.`,
            onConfirm: async () => {
                await deleteDocument(docId);
                window.location.hash = "/";
            },
        });
    }

    function openVersionHistory() {
        const docId = spreadsheetSession.docId;
        if (!docId) return;
        const file = storage.drive.getFile(docId);
        if (!file) return;
        openModal(VersionHistoryModal, { registry: storage, file, onAfterRestore: () => spreadsheetSession.reload() });
    }

    function exportTSV() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        let tsv = "";
        for (let r = 0; r < sheetStore.rowCount; r++) {
            const row = [];
            for (let c = 0; c < sheetStore.colCount; c++) {
                const cell = sheetStore.getCell(r, c);
                let val = String(cell?.v ?? "").replace(/\t/g, " ");
                row.push(val);
            }
            tsv += row.join("\t") + "\n";
        }
        const blob = new Blob([tsv], { type: "text/tab-separated-values" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${spreadsheetSession.docTitle || "sheet"}.tsv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportHTML() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        let rows = "";
        for (let r = 0; r < sheetStore.rowCount; r++) {
            let cells = "";
            for (let c = 0; c < sheetStore.colCount; c++) {
                const cell = sheetStore.getCell(r, c);
                const val = String(cell?.v ?? "")
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
                cells += r === 0 ? `<th>${val}</th>` : `<td>${val}</td>`;
            }
            rows += `<tr>${cells}</tr>\n`;
        }
        const html = `<!DOCTYPE html><html><body><table border="1">\n${rows}</table></body></html>`;
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${spreadsheetSession.docTitle || "sheet"}.html`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportCSV() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;

        let csv = "";
        const rowCount = sheetStore.rowCount;
        const colCount = sheetStore.colCount;

        for (let r = 0; r < rowCount; r++) {
            const row = [];
            for (let c = 0; c < colCount; c++) {
                const cell = sheetStore.getCell(r, c);
                let val = cell?.v ?? "";
                if (typeof val === "string" && (val.includes(",") || val.includes('"'))) {
                    val = '"' + val.replace(/"/g, '""') + '"';
                }
                row.push(String(val));
            }
            csv += row.join(",") + "\n";
        }

        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${spreadsheetSession.docTitle || "sheet"}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    const fileItems = [
        { label: "New", action: () => (window.location.hash = "/new"), shortcut: "Ctrl+N" },
        { label: "Open…", action: () => (window.location.hash = "/"), shortcut: "Ctrl+O" },
        { label: "Import", action: () => showAlert("Import", "Import from CSV or Excel coming soon.", "info") },
        { label: "Make a copy", action: openMakeCopyModal },
        { divider: true },
        { label: "Share", action: openShareModal },
        {
            label: "Download",
            submenu: [
                { label: "PDF Document (.pdf)", icon: download, isSvgIcon: true, action: openPdfExport },
                { label: "Web Page (.html)", action: exportHTML },
                { label: "CSV (.csv)", action: exportCSV },
                { label: "TSV (.tsv)", action: exportTSV },
            ],
        },
        { divider: true },
        { label: "Rename", action: openRenameModal },
        { label: "Move", action: openMoveModal },
        { label: "Delete", action: openDeleteConfirm },
        { divider: true },
        { label: "See version history", action: openVersionHistory },
        { divider: true },
        { label: "Page setup & export PDF…", action: openPdfExport },
        { label: "Print", icon: printer, isSvgIcon: true, action: openPdfExport, shortcut: "Ctrl+P" },
    ];

    // ─── EDIT MENU ────────────────────────────────────────────────────────────

    function deleteSelectedRows() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        const indices = [];
        for (let r = range.startRow; r <= range.endRow; r++) indices.push(r);
        sheetStore.deleteRowsAt?.(indices) ?? indices.reverse().forEach(r => sheetStore.deleteRowAt(r));
    }

    function deleteSelectedCols() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        // Delete from right to left so indices stay valid
        for (let c = range.endCol; c >= range.startCol; c--) {
            sheetStore.deleteColumnAt(c);
        }
    }

    function deleteCellsShiftUp() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        const { startRow, endRow, startCol, endCol } = range;
        const numRows = endRow - startRow + 1;
        const totalRows = sheetStore.rowCount;

        spreadsheetSession.ydoc?.transact(() => {
            // For each affected column, shift cells up
            for (let c = startCol; c <= endCol; c++) {
                for (let r = startRow; r < totalRows - numRows; r++) {
                    const src = sheetStore.getCell(r + numRows, c);
                    if (src?.exists) {
                        sheetStore.setCellProperties(r, c, { v: src.v, ...getCellFormatProps(src) });
                    } else {
                        sheetStore.clearCell(r, c);
                    }
                }
                // Clear the vacated cells at the bottom
                for (let r = totalRows - numRows; r < totalRows; r++) {
                    sheetStore.clearCell(r, c);
                }
            }
        });
    }

    function deleteCellsShiftLeft() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        const { startRow, endRow, startCol, endCol } = range;
        const numCols = endCol - startCol + 1;
        const totalCols = sheetStore.colCount;

        spreadsheetSession.ydoc?.transact(() => {
            for (let r = startRow; r <= endRow; r++) {
                for (let c = startCol; c < totalCols - numCols; c++) {
                    const src = sheetStore.getCell(r, c + numCols);
                    if (src?.exists) {
                        sheetStore.setCellProperties(r, c, { v: src.v, ...getCellFormatProps(src) });
                    } else {
                        sheetStore.clearCell(r, c);
                    }
                }
                for (let c = totalCols - numCols; c < totalCols; c++) {
                    sheetStore.clearCell(r, c);
                }
            }
        });
    }

    function getCellFormatProps(cell) {
        const props = {};
        const fmt = ['bold', 'italic', 'underline', 'strikethrough', 'color', 'bgColor',
                     'fontSize', 'fontFamily', 'hAlign', 'vAlign', 'wrapText', 'ct'];
        for (const k of fmt) {
            if (cell[k] !== undefined) props[k] = cell[k];
        }
        return props;
    }

    const editItems = [
        { label: "Undo", action: () => spreadsheetSession.undo(), shortcut: "Ctrl+Z" },
        { label: "Redo", action: () => spreadsheetSession.redo(), shortcut: "Ctrl+Y" },
        { divider: true },
        { label: "Cut", action: () => handleCut(), shortcut: "Ctrl+X", icon: cut, isSvgIcon: true },
        { label: "Copy", action: () => handleCopy(), shortcut: "Ctrl+C", icon: copy, isSvgIcon: true },
        { label: "Paste", action: () => handlePaste(), shortcut: "Ctrl+V", icon: paste, isSvgIcon: true },
        {
            label: "Paste Special",
            submenu: [
                { label: "Values Only", action: () => handlePaste("values") },
                { label: "Formulas Only", action: () => handlePaste("formulas") },
                { label: "Formatting Only", action: () => handlePaste("formatting") },
                { divider: true },
                { label: "Values & Formatting", action: () => handlePaste("valuesFormat") },
            ],
        },
        { divider: true },
        {
            label: "Delete",
            submenu: [
                { label: "Delete Row", action: deleteSelectedRows },
                { label: "Delete Column", action: deleteSelectedCols },
                { divider: true },
                { label: "Delete Cells, Shift Up", action: deleteCellsShiftUp },
                { label: "Delete Cells, Shift Left", action: deleteCellsShiftLeft },
            ],
        },
        { divider: true },
        {
            label: "Find and Replace…",
            action: () => showAlert("Find and Replace", "Find and Replace coming soon.", "info"),
            shortcut: "Ctrl+H",
        },
    ];

    // ─── VIEW MENU ────────────────────────────────────────────────────────────

    let viewItems = $derived.by(() => {
        const anchor = selectionState.anchor;
        const sheetStore = spreadsheetSession.activeSheetStore;
        const frozenRows = sheetStore?.frozenRows ?? 0;
        const frozenCols = sheetStore?.frozenColumns ?? 0;
        const anchorRow = anchor?.row ?? 0;
        const anchorCol = anchor?.col ?? 0;

        return [
            {
                label: "Show",
                submenu: [
                    {
                        label: "Formula Bar",
                        action: toggleViewFormulaBar,
                        checked: viewFormulaBar,
                    },
                    {
                        label: "Gridlines",
                        action: toggleViewGridlines,
                        checked: viewGridlines,
                    },
                    {
                        label: "Formulas",
                        action: toggleViewFormulas,
                        checked: viewFormulas,
                        shortcut: "Ctrl+`",
                    },
                ],
            },
            {
                label: "Freeze",
                submenu: [
                    { label: "No frozen rows", action: () => setFreezeRows(0), checked: frozenRows === 0 },
                    { label: "1 row", action: () => setFreezeRows(1), checked: frozenRows === 1 },
                    { label: "2 rows", action: () => setFreezeRows(2), checked: frozenRows === 2 },
                    ...(anchorRow > 2 ? [{ label: `Up to row ${anchorRow + 1}`, action: () => setFreezeRows(anchorRow + 1) }] : []),
                    { divider: true },
                    { label: "No frozen columns", action: () => setFreezeCols(0), checked: frozenCols === 0 },
                    { label: "1 column", action: () => setFreezeCols(1), checked: frozenCols === 1 },
                    { label: "2 columns", action: () => setFreezeCols(2), checked: frozenCols === 2 },
                    ...(anchorCol > 2 ? [{ label: `Up to column ${anchorCol + 1}`, action: () => setFreezeCols(anchorCol + 1) }] : []),
                ],
            },
            { divider: true },
            {
                label: "Page break markers",
                action: togglePageBreakMarkers,
                checked: showPageBreakMarkers,
            },
        ];
    });

    function setFreezeRows(count) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore) sheetStore.setFrozenRows?.(count);
    }

    function setFreezeCols(count) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore) sheetStore.setFrozenColumns?.(count);
    }

    // ─── INSERT MENU ──────────────────────────────────────────────────────────

    let insertItems = $derived.by(() => {
        const range = selectionState.range;
        const numRows = range ? range.endRow - range.startRow + 1 : 1;
        const numCols = range ? range.endCol - range.startCol + 1 : 1;
        const rowLabel = numRows === 1 ? "1 row" : `${numRows} rows`;
        const colLabel = numCols === 1 ? "1 column" : `${numCols} columns`;

        return [
            {
                label: "Rows",
                submenu: [
                    { label: `${rowLabel} above`, action: () => insertRowsAbove(numRows) },
                    { label: `${rowLabel} below`, action: () => insertRowsBelow(numRows) },
                ],
            },
            {
                label: "Columns",
                submenu: [
                    { label: `${colLabel} left`, action: () => insertColsLeft(numCols) },
                    { label: `${colLabel} right`, action: () => insertColsRight(numCols) },
                ],
            },
            { label: "Sheet", action: () => spreadsheetSession.addSheet("Sheet"), icon: "+" },
            { divider: true },
            {
                label: "Floating image…",
                icon: imageIcon,
                isSvgIcon: true,
                action: () => document.dispatchEvent(new CustomEvent('insertFloatingImage')),
            },
            { divider: true },
            {
                label: "Checkbox",
                action: () => insertCellType("checkbox"),
            },
            {
                label: "Dropdown",
                action: () => insertCellType("dropdown"),
            },
            {
                label: "File cell",
                action: () => insertCellType("file"),
            },
            { divider: true },
            {
                label: "Table",
                action: () => (showCreateTableDialog = true),
                icon: table,
                isSvgIcon: true,
                disabled: !selectionState.range,
            },
            {
                label: "Repeater",
                action: () => (showCreateRepeaterDialog = true),
                icon: "↻",
                disabled: !selectionState.range,
            },
        ];
    });

    function insertRowsAbove(count) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        for (let i = 0; i < count; i++) sheetStore.insertRowAt(range.startRow);
    }

    function insertRowsBelow(count) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        for (let i = 0; i < count; i++) sheetStore.insertRowAt(range.endRow + 1);
    }

    function insertColsLeft(count) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        for (let i = 0; i < count; i++) sheetStore.insertColumnAt(range.startCol);
    }

    function insertColsRight(count) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        for (let i = 0; i < count; i++) sheetStore.insertColumnAt(range.endCol + 1);
    }

    function insertCellType(type) {
        const anchor = selectionState.anchor;
        const range = selectionState.range;
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore || !range) return;

        const defaults = {
            checkbox: { type: 'checkbox' },
            dropdown: { type: 'dropdown', options: [] },
            file: { type: 'file' },
        };
        const config = defaults[type];
        if (!config) return;

        spreadsheetSession.ydoc?.transact(() => {
            for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                    sheetStore.setCellTypeConfig(r, c, config);
                }
            }
        });
    }

    // ─── FORMAT MENU ──────────────────────────────────────────────────────────

    const formatItems = [
        {
            label: "Number",
            submenu: [
                { label: "Plain text", action: () => applyNumberFormat({ type: "text" }) },
                { divider: true },
                { label: "Number  1,000.00", action: () => applyNumberFormat({ type: "number", decimals: 2 }) },
                { label: "Percent  10%", action: () => applyNumberFormat({ type: "number", subFormat: "percent", decimals: 1 }) },
                { label: "Scientific  1.00E+3", action: () => applyNumberFormat({ type: "number", subFormat: "scientific", decimals: 2 }) },
                { divider: true },
                { label: "Accounting  $ 1,000.00", action: () => applyNumberFormat({ type: "number", subFormat: "accounting", decimals: 2, symbol: "$" }) },
                { label: "Financial  (1,000.00)", action: () => applyNumberFormat({ type: "number", subFormat: "financial", decimals: 2 }) },
                { label: "Currency  $1,000.00", action: () => applyNumberFormat({ type: "number", subFormat: "currency", decimals: 2, symbol: "$" }) },
                { label: "Currency rounded  $1,000", action: () => applyNumberFormat({ type: "number", subFormat: "currency", decimals: 0, symbol: "$" }) },
                { divider: true },
                { label: "Date  3/20/2026", action: () => applyNumberFormat({ type: "date", subFormat: "date", datePreset: "MM/DD/YYYY" }) },
                { label: "Time  1:30 PM", action: () => applyNumberFormat({ type: "date", subFormat: "time", timePreset: "h:mm A" }) },
                { label: "Date time  3/20/2026 1:30 PM", action: () => applyNumberFormat({ type: "date", subFormat: "datetime", datePreset: "MM/DD/YYYY", timePreset: "h:mm A" }) },
                { label: "Duration  1:30:00", action: () => applyNumberFormat({ type: "duration" }) },
            ],
        },
        {
            label: "Text",
            submenu: [
                { label: "Bold", action: () => applyFormattingCmd("bold", true), shortcut: "Ctrl+B" },
                { label: "Italic", action: () => applyFormattingCmd("italic", true), shortcut: "Ctrl+I" },
                { label: "Underline", action: () => applyFormattingCmd("underline", true), shortcut: "Ctrl+U" },
                { label: "Strikethrough", action: () => applyFormattingCmd("strikethrough", true) },
            ],
        },
        {
            label: "Alignment",
            submenu: [
                { label: "Left", action: () => applyFormattingCmd("horizontalAlign", "left") },
                { label: "Center", action: () => applyFormattingCmd("horizontalAlign", "center") },
                { label: "Right", action: () => applyFormattingCmd("horizontalAlign", "right") },
                { divider: true },
                { label: "Top", action: () => applyFormattingCmd("verticalAlign", "top") },
                { label: "Middle", action: () => applyFormattingCmd("verticalAlign", "middle") },
                { label: "Bottom", action: () => applyFormattingCmd("verticalAlign", "bottom") },
            ],
        },
        {
            label: "Wrapping",
            submenu: [
                { label: "Overflow", action: () => setTextWrap("overflow") },
                { label: "Wrap", action: () => setTextWrap("wrap") },
                { label: "Clip", action: () => setTextWrap("clip") },
            ],
        },
        { divider: true },
        {
            label: "Font size",
            submenu: [6, 7, 8, 9, 10, 11, 12, null, 14, 18, 24, 36].map(sz =>
                sz === null
                    ? { divider: true }
                    : { label: String(sz), action: () => applyFormattingCmd("fontSize", sz) }
            ),
        },
        { divider: true },
        {
            label: "Conditional formatting",
            action: () => (showCFPanel = !showCFPanel),
        },
        { divider: true },
        {
            label: "Clear formatting",
            action: () => clearFormatting(),
            shortcut: "Ctrl+\\",
        },
    ];

    // ─── DATA MENU ────────────────────────────────────────────────────────────
    const dataItems = [
        {
            label: "Tables",
            icon: table,
            isSvgIcon: true,
            action: () => onShowTablesPanel?.(),
        },
        {
            label: "Repeaters",
            icon: "↻",
            action: () => showAlert("Repeaters", "Open the Repeaters panel from the Tables panel.", "info"),
        },
        { divider: true },
        {
            label: "Data Validation",
            icon: functionIcon,
            isSvgIcon: true,
            action: () => (showDVPanel = !showDVPanel),
        },
    ];

    // ─── HELP MENU ────────────────────────────────────────────────────────────
    const helpItems = [
        {
            label: "Formula Reference",
            icon: functionIcon,
            isSvgIcon: true,
            action: () => (showFormulaDocs = true),
        },
        { divider: true },
        { label: "Keyboard Shortcuts", shortcut: "Ctrl+/", action: showKeyboardShortcuts },
        { divider: true },
        { label: "Help", icon: info, isSvgIcon: true, action: () => showAlert("Help", "Visit our documentation for help") },
    ];

    // ─── ACTION HANDLERS ──────────────────────────────────────────────────────

    function applyNumberFormat(config) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;

        const renderContext = spreadsheetSession.renderContext;
        spreadsheetSession.ydoc?.transact(() => {
            for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (ct === 'TABLE_HEADER' || ct === 'TABLE_DATA' || ct === 'TABLE_ENTRY') continue;
                    sheetStore.setCellTypeConfig(r, c, config);
                }
            }
        });
    }

    function setTextWrap(mode) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        const renderContext = spreadsheetSession.renderContext;

        spreadsheetSession.ydoc?.transact(() => {
            for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                    const ct = renderContext?.getCellType(r, c);
                    if (ct === 'TABLE_HEADER') continue;
                    if (ct === 'TABLE_DATA' || ct === 'TABLE_ENTRY') {
                        const info = renderContext?.tableManager?.getCellInfo(r, c);
                        if (info?.table && info.colDef && !info.colDef.isNonEntry && info.dataIndex >= 0) {
                            info.table.setCellFormatting(info.dataIndex, info.colDef.id, { wrapText: mode === 'overflow' ? undefined : mode });
                        }
                        continue;
                    }
                    sheetStore.setCellProperties(r, c, { wrapText: mode === 'overflow' ? undefined : mode });
                }
            }
        });
    }

    function clearFormatting() {
        clearFormattingCmd(spreadsheetSession, selectionState);
    }

    function handleCopy() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore) clipboardManager.copy(sheetStore, spreadsheetSession);
    }

    function handleCut() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const ydoc = spreadsheetSession.ydoc;
        if (sheetStore && ydoc) clipboardManager.cut(sheetStore, spreadsheetSession, ydoc);
    }

    function handlePaste(mode = "full") {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const ydoc = spreadsheetSession.ydoc;
        if (sheetStore && ydoc) clipboardManager.paste(sheetStore, spreadsheetSession, ydoc, mode);
    }

    function showKeyboardShortcuts() {
        const shortcuts = `Keyboard Shortcuts:

Navigation:
Ctrl+Arrow - Jump to edge of data region
Home - Go to first column of current row
Ctrl+Home - Go to cell A1

Selection:
Ctrl+A - Select all
Shift+Arrow - Extend selection
Ctrl+Space - Select entire column
Shift+Space - Select entire row

Editing:
F2 - Edit cell
Enter - Confirm edit, move down
Tab - Confirm edit, move right
Escape - Cancel edit
Ctrl+Enter - Fill selection with current entry

Formatting:
Ctrl+B - Bold
Ctrl+I - Italic
Ctrl+U - Underline
Ctrl+\\ - Clear formatting

Clipboard:
Ctrl+C - Copy
Ctrl+X - Cut
Ctrl+V - Paste
Ctrl+Shift+V - Paste values only

Insert:
Ctrl+; - Insert current date
Ctrl+Shift+; - Insert current time

Other:
Ctrl+Z - Undo
Ctrl+Y - Redo
Ctrl+P - Print / Export PDF
Ctrl+/ - Show keyboard shortcuts
Ctrl+\` - Toggle formula view`;

        openModal(AlertModal, { title: "Keyboard Shortcuts", message: shortcuts, type: "info" });
    }
</script>

<div class="menu-bar" class:menu-active={openMenuId !== null}>
    <MenuDropdown
        label="File"
        items={fileItems}
        menuId="file"
        isOpen={openMenuId === "file"}
        anyMenuOpen={openMenuId !== null}
        onOpenChange={handleMenuOpenChange}
    />
    <MenuDropdown
        label="Edit"
        items={editItems}
        menuId="edit"
        isOpen={openMenuId === "edit"}
        anyMenuOpen={openMenuId !== null}
        onOpenChange={handleMenuOpenChange}
    />
    <MenuDropdown
        label="View"
        items={viewItems}
        menuId="view"
        isOpen={openMenuId === "view"}
        anyMenuOpen={openMenuId !== null}
        onOpenChange={handleMenuOpenChange}
    />
    <MenuDropdown
        label="Insert"
        items={insertItems}
        menuId="insert"
        isOpen={openMenuId === "insert"}
        anyMenuOpen={openMenuId !== null}
        onOpenChange={handleMenuOpenChange}
    />
    <MenuDropdown
        label="Format"
        items={formatItems}
        menuId="format"
        isOpen={openMenuId === "format"}
        anyMenuOpen={openMenuId !== null}
        onOpenChange={handleMenuOpenChange}
    />
    <MenuDropdown
        label="Data"
        items={dataItems}
        menuId="data"
        isOpen={openMenuId === "data"}
        anyMenuOpen={openMenuId !== null}
        onOpenChange={handleMenuOpenChange}
    />
    <MenuDropdown
        label="Help"
        items={helpItems}
        menuId="help"
        isOpen={openMenuId === "help"}
        anyMenuOpen={openMenuId !== null}
        onOpenChange={handleMenuOpenChange}
    />
</div>

{#if showCreateTableDialog}
    <TableCreateDialog onClose={() => (showCreateTableDialog = false)} />
{/if}

{#if showCreateRepeaterDialog}
    <RepeaterCreateDialog onClose={() => (showCreateRepeaterDialog = false)} />
{/if}

{#if showCFPanel}
    <ConditionalFormatPanel onclose={() => (showCFPanel = false)} />
{/if}

{#if showDVPanel}
    <DataValidationPanel onclose={() => (showDVPanel = false)} />
{/if}

{#if showFormulaDocs}
    <FormulaDocsPanel onclose={() => (showFormulaDocs = false)} />
{/if}


<style>
    .menu-bar {
        display: flex;
        align-items: center;
        height: 28px;
        background: transparent;
        flex-shrink: 0;
    }

    /* Show hover hint on all menu buttons when any menu is open */
    .menu-active :global(.menu-button:hover:not(.disabled):not(.active)) {
        background: var(--color-fill-tertiary);
    }
</style>
