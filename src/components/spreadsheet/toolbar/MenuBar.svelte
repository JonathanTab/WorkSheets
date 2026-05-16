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

    // Helper to show alert modal
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

    const fileItems = [
        {
            label: "New",
            action: () => (window.location.hash = "/new"),
            shortcut: "Ctrl+N",
        },
        {
            label: "Open...",
            action: () => (window.location.hash = "/"),
            shortcut: "Ctrl+O",
        },
        {
            label: "Import",
            action: () =>
                showAlert(
                    "Import",
                    "Import from CSV or Excel coming soon.",
                    "info",
                ),
        },
        {
            label: "Make a copy",
            action: openMakeCopyModal,
        },
        { divider: true },
        {
            label: "Share",
            action: openShareModal,
        },
        {
            label: "Download",
            submenu: [
                {
                    label: "PDF Document (.pdf)",
                    icon: download,
                    isSvgIcon: true,
                    action: openPdfExport,
                },
                {
                    label: "Web Page (.html)",
                    action: exportHTML,
                },
                {
                    label: "CSV (.csv)",
                    action: () => exportCSV(),
                },
                {
                    label: "TSV (.tsv)",
                    action: exportTSV,
                },
            ],
        },
        { divider: true },
        {
            label: "Rename",
            action: openRenameModal,
        },
        {
            label: "Move",
            action: openMoveModal,
        },
        {
            label: "Delete",
            action: openDeleteConfirm,
        },
        { divider: true },
        {
            label: "See version history",
            action: openVersionHistory,
        },
        { divider: true },
        {
            label: "Page setup & export PDF…",
            action: openPdfExport,
        },
        {
            label: "Print",
            icon: printer,
            isSvgIcon: true,
            action: openPdfExport,
            shortcut: "Ctrl+P",
        },
    ];

    // ─── EDIT MENU ────────────────────────────────────────────────────────────
    const editItems = [
        {
            label: "Undo",
            action: () => spreadsheetSession.undo(),
            shortcut: "Ctrl+Z",
        },
        {
            label: "Redo",
            action: () => spreadsheetSession.redo(),
            shortcut: "Ctrl+Y",
        },
        { divider: true },
        {
            label: "Cut",
            action: () => handleCut(),
            shortcut: "Ctrl+X",
            icon: cut,
            isSvgIcon: true,
        },
        {
            label: "Copy",
            action: () => handleCopy(),
            shortcut: "Ctrl+C",
            icon: copy,
            isSvgIcon: true,
        },
        {
            label: "Paste",
            action: () => handlePaste(),
            shortcut: "Ctrl+V",
            icon: paste,
            isSvgIcon: true,
        },
        {
            label: "Paste Special",
            submenu: [
                {
                    label: "Values Only",
                    action: () => handlePaste("values"),
                },
                {
                    label: "Formulas Only",
                    action: () => handlePaste("formulas"),
                },
                {
                    label: "Formatting Only",
                    action: () => handlePaste("formatting"),
                },
                { divider: true },
                {
                    label: "Values & Formatting",
                    action: () => handlePaste("valuesFormat"),
                },
            ],
        },
        { divider: true },
        {
            label: "Delete",
            action: () => handleDelete(),
            shortcut: "Del",
            icon: trash,
            isSvgIcon: true,
        },
        {
            label: "Select All",
            action: () => handleSelectAll(),
            shortcut: "Ctrl+A",
        },
    ];

    // ─── VIEW MENU ────────────────────────────────────────────────────────────
    let showGridlines = $state(true);
    let showFormulaBar = $state(true);
    let showRowColHeaders = $state(true);
    let showPageBreakMarkers = $state(false);

    function togglePageBreakMarkers() {
        showPageBreakMarkers = !showPageBreakMarkers;
        const settings = showPageBreakMarkers
            ? (spreadsheetSession.activeSheetStore?.getPrintSettings?.() ?? {})
            : null;
        document.dispatchEvent(new CustomEvent('togglePageBreaks', {
            detail: { show: showPageBreakMarkers, settings },
        }));
    }

    let viewItems = $derived([
        {
            label: showGridlines ? "Hide Gridlines" : "Show Gridlines",
            action: () => {
                showGridlines = !showGridlines;
                const sheetStore = spreadsheetSession.activeSheetStore;
                if (sheetStore) sheetStore.setGridlinesVisible?.(showGridlines);
            },
        },
        {
            label: showFormulaBar ? "Hide Formula Bar" : "Show Formula Bar",
            action: () => { showFormulaBar = !showFormulaBar; },
        },
        {
            label: showRowColHeaders ? "Hide Row & Column Headers" : "Show Row & Column Headers",
            action: () => { showRowColHeaders = !showRowColHeaders; },
        },
        {
            label: showPageBreakMarkers ? "Hide Page Break Markers" : "Show Page Break Markers",
            action: togglePageBreakMarkers,
        },
        { divider: true },
        {
            label: "Freeze",
            submenu: [
                { label: "No Frozen Rows", action: () => setFreezeRows(0) },
                {
                    label: "Freeze to Current Row",
                    action: () => { const anchor = selectionState.anchor; if (anchor) setFreezeRows(anchor.row + 1); },
                },
                { divider: true },
                { label: "No Frozen Columns", action: () => setFreezeCols(0) },
                {
                    label: "Freeze to Current Column",
                    action: () => { const anchor = selectionState.anchor; if (anchor) setFreezeCols(anchor.col + 1); },
                },
            ],
        },
    ]);

    function setFreezeRows(count) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore) {
            sheetStore.setFrozenRows?.(count);
        }
    }

    function setFreezeCols(count) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore) {
            sheetStore.setFrozenColumns?.(count);
        }
    }

    // ─── INSERT MENU ──────────────────────────────────────────────────────────
    const insertItems = [
        {
            label: "Row Above",
            action: () => insertRowAbove(),
        },
        {
            label: "Row Below",
            action: () => insertRowBelow(),
        },
        {
            label: "Column Left",
            action: () => insertColumnLeft(),
        },
        {
            label: "Column Right",
            action: () => insertColumnRight(),
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
        { divider: true },
        {
            label: "Image in Cell",
            icon: imageIcon,
            isSvgIcon: true,
            action: () => insertImageInCell(),
        },
        { divider: true },
        {
            label: "New Sheet",
            action: () => spreadsheetSession.addSheet("Sheet"),
            icon: "+",
        },
    ];

    // ─── FORMAT MENU ──────────────────────────────────────────────────────────
    let canMerge = $derived.by(() => {
        const range = selectionState.range;
        if (!range) return false;
        return (
            range.startRow !== range.endRow || range.startCol !== range.endCol
        );
    });

    let canUnmerge = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const anchor = selectionState.anchor;
        if (!sheetStore?.mergeEngine || !anchor) return false;
        return sheetStore.mergeEngine.isMergePrimary(anchor.row, anchor.col);
    });

    const formatItems = [
        {
            label: "Number",
            submenu: [
                {
                    label: "Automatic",
                    action: () => applyNumberFormat("automatic"),
                },
                { divider: true },
                {
                    label: "Number (1,000)",
                    action: () => applyNumberFormat("number"),
                },
                {
                    label: "Currency ($1,000.00)",
                    action: () => applyNumberFormat("currency"),
                },
                {
                    label: "Percent (10%)",
                    action: () => applyNumberFormat("percent"),
                },
                { divider: true },
                {
                    label: "Date (3/20/2026)",
                    action: () => applyNumberFormat("date"),
                },
                {
                    label: "Time (1:30 PM)",
                    action: () => applyNumberFormat("time"),
                },
            ],
        },
        { divider: true },
        {
            label: "Bold",
            action: () => applyFormat("bold", true),
            shortcut: "Ctrl+B",
        },
        {
            label: "Italic",
            action: () => applyFormat("italic", true),
            shortcut: "Ctrl+I",
        },
        {
            label: "Underline",
            action: () => applyFormat("underline", true),
            shortcut: "Ctrl+U",
        },
        {
            label: "Strikethrough",
            action: () => applyFormat("strikethrough", true),
        },
        { divider: true },
        {
            label: "Merge Cells",
            action: () => mergeSelectedCells(),
            disabled: !canMerge,
        },
        {
            label: "Unmerge Cells",
            action: () => unmergeSelectedCells(),
            disabled: !canUnmerge,
        },
        { divider: true },
        {
            label: "Text Wrapping",
            submenu: [
                { label: "Overflow", action: () => setTextWrap("overflow") },
                { label: "Wrap", action: () => setTextWrap("wrap") },
                { label: "Clip", action: () => setTextWrap("clip") },
            ],
        },
        { divider: true },
        {
            label: "Clear Formatting",
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
        { divider: true },
        {
            label: "Data Validation",
            icon: functionIcon,
            isSvgIcon: true,
            action: () => (showDVPanel = !showDVPanel),
        },
        {
            label: "Conditional Formatting",
            action: () => (showCFPanel = !showCFPanel),
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
        {
            label: "Keyboard Shortcuts",
            shortcut: "Ctrl+/",
            action: () => showKeyboardShortcuts(),
        },
        { divider: true },
        {
            label: "Help",
            icon: info,
            isSvgIcon: true,
            action: () => showAlert("Help", "Visit our documentation for help"),
        },
    ];

    // ─── ACTION HANDLERS ──────────────────────────────────────────────────────

    function applyFormat(property, value) {
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
                            info.table.setCellFormatting(info.dataIndex, info.colDef.id, { [property]: value });
                        }
                        continue;
                    }
                    sheetStore.setCellProperties(r, c, { [property]: value });
                }
            }
        });
    }

    function applyNumberFormat(type) {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;

        const typeConfigs = {
            automatic: { type: "automatic" },
            number: { type: "number", decimals: 2 },
            currency: { type: "currency", decimals: 2, symbol: "$" },
            percent: { type: "percent", decimals: 1 },
            date: { type: "date", format: "MM/DD/YYYY" },
            time: { type: "time", format: "h:mm A" },
        };

        const config = typeConfigs[type] || { type };

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
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;

        sheetStore.clearRangeFormatting?.(
            range.startRow,
            range.startCol,
            range.endRow,
            range.endCol,
        );
    }

    function handleCopy() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (sheetStore) {
            clipboardManager.copy(sheetStore, spreadsheetSession);
        }
    }

    function handleCut() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const ydoc = spreadsheetSession.ydoc;
        if (sheetStore && ydoc) {
            clipboardManager.cut(sheetStore, spreadsheetSession, ydoc);
        }
    }

    function handlePaste(mode = "full") {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const ydoc = spreadsheetSession.ydoc;
        if (sheetStore && ydoc) {
            clipboardManager.paste(sheetStore, spreadsheetSession, ydoc, mode);
        }
    }

    function handleDelete() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;

        for (let r = range.startRow; r <= range.endRow; r++) {
            for (let c = range.startCol; c <= range.endCol; c++) {
                sheetStore.clearCell(r, c);
            }
        }
    }

    function handleSelectAll() {
        selectionState.selectAll();
    }

    function insertRowAbove() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        sheetStore.insertRowAt(range.startRow);
    }

    function insertRowBelow() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        sheetStore.insertRowAt(range.endRow + 1);
    }

    function insertColumnLeft() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        sheetStore.insertColumnAt(range.startCol);
    }

    function insertColumnRight() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range) return;
        sheetStore.insertColumnAt(range.endCol + 1);
    }

    function mergeSelectedCells() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const range = selectionState.range;
        if (!sheetStore || !range || !canMerge) return;
        sheetStore.mergeCells(
            range.startRow,
            range.startCol,
            range.endRow,
            range.endCol,
        );
    }

    function unmergeSelectedCells() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const anchor = selectionState.anchor;
        if (!sheetStore || !anchor) return;
        sheetStore.unmergeCells(anchor.row, anchor.col);
    }

    function insertImageInCell() {
        const anchor = selectionState.anchor;
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!anchor || !sheetStore) return;
        sheetStore.setCellTypeConfig(anchor.row, anchor.col, {
            type: "image",
            fit: "contain",
        });
        showAlert("Insert Image", "Click the cell and use the image picker");
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
                // Escape quotes and wrap in quotes if contains comma
                if (
                    typeof val === "string" &&
                    (val.includes(",") || val.includes('"'))
                ) {
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
Ctrl+/ - Show keyboard shortcuts`;

        openModal(AlertModal, {
            title: "Keyboard Shortcuts",
            message: shortcuts,
            type: "info",
        });
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
