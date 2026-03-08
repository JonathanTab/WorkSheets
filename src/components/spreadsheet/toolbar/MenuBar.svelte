<script>
    import MenuDropdown from "./MenuDropdown.svelte";
    import {
        spreadsheetSession,
        createDocument,
        deleteDocument,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import {
        clipboardManager,
        selectionState,
    } from "../../../stores/spreadsheet/index.js";

    // File menu items (most are stubbed)
    const fileItems = [
        {
            label: "New",
            action: () => alert("New document - not implemented"),
            shortcut: "Ctrl+N",
        },
        {
            label: "Open...",
            action: () => alert("Open document - not implemented"),
            shortcut: "Ctrl+O",
        },
        { divider: true },
        {
            label: "Save",
            action: () => alert("Auto-saved via Yjs"),
            shortcut: "Ctrl+S",
        },
        {
            label: "Save As...",
            action: () => alert("Save as - not implemented"),
        },
        { divider: true },
        { label: "Print", action: () => window.print(), shortcut: "Ctrl+P" },
        { divider: true },
        {
            label: "Close",
            action: () => (window.location.hash = ""),
            shortcut: "Ctrl+W",
        },
    ];

    // Edit menu items
    const editItems = [
        {
            label: "Undo",
            action: () => spreadsheetSession.undo(),
            shortcut: "Ctrl+Z",
            icon: "↶",
        },
        {
            label: "Redo",
            action: () => spreadsheetSession.redo(),
            shortcut: "Ctrl+Y",
            icon: "↷",
        },
        { divider: true },
        {
            label: "Cut",
            action: () => handleCut(),
            shortcut: "Ctrl+X",
            icon: "✂",
        },
        {
            label: "Copy",
            action: () => handleCopy(),
            shortcut: "Ctrl+C",
            icon: "📋",
        },
        {
            label: "Paste",
            action: () => handlePaste(),
            shortcut: "Ctrl+V",
            icon: "📄",
        },
        {
            label: "Paste Special",
            submenu: [
                {
                    label: "Paste All",
                    action: () => handlePaste("full"),
                    shortcut: "Ctrl+V",
                },
                { divider: true },
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
                {
                    label: "Formulas & Formatting",
                    action: () => handlePaste("formulasFormat"),
                },
            ],
        },
        { divider: true },
        {
            label: "Delete",
            action: () => handleDelete(),
            shortcut: "Del",
            icon: "🗑",
        },
        {
            label: "Select All",
            action: () => handleSelectAll(),
            shortcut: "Ctrl+A",
        },
    ];

    // View menu items
    const viewItems = [
        { label: "Zoom 100%", action: () => alert("Zoom - not implemented") },
        { label: "Zoom 125%", action: () => alert("Zoom - not implemented") },
        { label: "Zoom 150%", action: () => alert("Zoom - not implemented") },
        { divider: true },
        {
            label: "Show Gridlines",
            action: () => alert("Toggle gridlines - not implemented"),
        },
        {
            label: "Show Formula Bar",
            action: () => alert("Toggle formula bar - not implemented"),
        },
    ];

    // Insert menu items
    const insertItems = [
        {
            label: "Row Above",
            action: () => insertRowAbove(),
            shortcut: "Ctrl+I then R",
        },
        {
            label: "Row Below",
            action: () => insertRowBelow(),
        },
        {
            label: "Column Left",
            action: () => insertColumnLeft(),
            shortcut: "Ctrl+I then C",
        },
        {
            label: "Column Right",
            action: () => insertColumnRight(),
        },
        { divider: true },
        {
            label: "New Sheet",
            action: () => spreadsheetSession.addSheet("Sheet"),
            icon: "+",
        },
        { divider: true },
        {
            label: "Chart...",
            action: () => alert("Insert chart - not implemented"),
        },
    ];

    // Format menu items
    const formatItems = [
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
        { divider: true },
        {
            label: "Number Format...",
            action: () => alert("Number format - not implemented"),
        },
        { divider: true },
        { label: "Clear Formatting", action: () => clearFormatting() },
    ];

    function applyFormat(property, value) {
        // This will be handled by FormattingToolbar
        alert(`Apply ${property}: ${value} - use formatting toolbar`);
    }

    function clearFormatting() {
        alert("Clear formatting - not implemented");
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

    // Row/Column insert handlers
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
</script>

<div class="menu-bar">
    <MenuDropdown label="File" items={fileItems} />
    <MenuDropdown label="Edit" items={editItems} />
    <MenuDropdown label="View" items={viewItems} />
    <MenuDropdown label="Insert" items={insertItems} />
    <MenuDropdown label="Format" items={formatItems} />
</div>

<style>
    .menu-bar {
        display: flex;
        align-items: center;
        gap: 2px;
    }
</style>
