<script>
    /**
     * DocMenuBar — menu bar for document editor.
     * Similar structure to spreadsheet MenuBar but with document-specific actions.
     */
    import MenuDropdown from "../spreadsheet/toolbar/MenuDropdown.svelte";
    import { docSession } from "../../stores/docs/docStore.svelte.js";
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import AlertModal from "../modals/AlertModal.svelte";
    import { router } from "../../lib/router.svelte.js";

    let { onShowPageSetup = undefined } = $props();

    // Shared state for cursor-following menu behavior
    let openMenuId = $state(null);

    function handleMenuOpenChange(isOpen, menuId) {
        if (isOpen) {
            openMenuId = menuId;
        } else if (openMenuId === menuId) {
            openMenuId = null;
        }
    }

    function showAlert(title, message, type = "info") {
        openModal(AlertModal, { title, message, type });
    }

    // ─── FILE MENU ────────────────────────────────────────────────────────────
    let fileItems = $derived([
        {
            label: "New",
            action: () => (window.location.hash = "/new"),
            shortcut: "Ctrl+N",
        },
        {
            label: "Open...",
            action: () => router.goHome(),
            shortcut: "Ctrl+O",
        },
        { divider: true },
        {
            label: "Page Setup...",
            action: () => onShowPageSetup?.(),
        },
        {
            label: "Download",
            submenu: [
                {
                    label: "Plain Text (.txt)",
                    action: () => exportText(),
                },
                {
                    label: "HTML (.html)",
                    action: () => exportHTML(),
                },
            ],
        },
        { divider: true },
        {
            label: "Print",
            action: () => window.print(),
            shortcut: "Ctrl+P",
        },
    ]);

    // ─── EDIT MENU ────────────────────────────────────────────────────────────
    // These will be passed from parent via props since we need access to the ProseMirror view
    let editItems = $derived([
        {
            label: "Undo",
            action: () => handleUndo(),
            shortcut: "Ctrl+Z",
        },
        {
            label: "Redo",
            action: () => handleRedo(),
            shortcut: "Ctrl+Y",
        },
        { divider: true },
        {
            label: "Cut",
            action: () => document.execCommand("cut"),
            shortcut: "Ctrl+X",
        },
        {
            label: "Copy",
            action: () => document.execCommand("copy"),
            shortcut: "Ctrl+C",
        },
        {
            label: "Paste",
            action: () => document.execCommand("paste"),
            shortcut: "Ctrl+V",
        },
        { divider: true },
        {
            label: "Select All",
            action: () => document.execCommand("selectAll"),
            shortcut: "Ctrl+A",
        },
    ]);

    // ─── VIEW MENU ────────────────────────────────────────────────────────────
    const viewItems = [
        {
            label: "Toggle Full Screen",
            action: () => toggleFullscreen(),
        },
    ];

    // ─── HELP MENU ────────────────────────────────────────────────────────────
    const helpItems = [
        {
            label: "Keyboard Shortcuts",
            shortcut: "Ctrl+/",
            action: () => showKeyboardShortcuts(),
        },
        { divider: true },
        {
            label: "Help",
            action: () => showAlert("Help", "Visit our documentation for help"),
        },
    ];

    // ─── ACTION HANDLERS ──────────────────────────────────────────────────────

    function handleUndo() {
        document.execCommand("undo");
    }

    function handleRedo() {
        document.execCommand("redo");
    }

    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    }

    function exportText() {
        const content = getPlainTextContent();
        downloadFile(
            content,
            `${docSession.metadata?.title || "document"}.txt`,
            "text/plain",
        );
    }

    function exportHTML() {
        const content = getHTMLContent();
        downloadFile(
            content,
            `${docSession.metadata?.title || "document"}.html`,
            "text/html",
        );
    }

    function getPlainTextContent() {
        // Get text content from the document
        const editorEl = document.querySelector(".ProseMirror");
        return editorEl?.textContent || "";
    }

    function getHTMLContent() {
        const editorEl = document.querySelector(".ProseMirror");
        if (!editorEl) return "";
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${docSession.metadata?.title || "Document"}</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
        h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; }
        blockquote { border-left: 3px solid #ccc; padding-left: 1em; color: #555; }
        pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
        code { background: #f0f0f0; padding: 0.2em 0.4em; border-radius: 3px; }
    </style>
</head>
<body>
${editorEl.innerHTML}
</body>
</html>`;
    }

    function downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    function showKeyboardShortcuts() {
        const shortcuts = `Keyboard Shortcuts:

Editing:
Ctrl+B - Bold
Ctrl+I - Italic
Ctrl+U - Underline
Ctrl+Z - Undo
Ctrl+Y - Redo
Ctrl+Shift+Z - Redo

Navigation:
Ctrl+Home - Go to start of document
Ctrl+End - Go to end of document

Other:
Ctrl+P - Print
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
        label="Help"
        items={helpItems}
        menuId="help"
        isOpen={openMenuId === "help"}
        anyMenuOpen={openMenuId !== null}
        onOpenChange={handleMenuOpenChange}
    />
</div>

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
