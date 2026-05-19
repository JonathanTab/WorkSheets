<script>
    /**
     * DocMenuBar — menu bar for document editor.
     * File · Edit · View · Insert · Format · Help
     */
    import MenuDropdown from '../spreadsheet/toolbar/MenuDropdown.svelte';
    import { docSession } from '../../stores/docs/docStore.svelte.js';
    import { openModal } from '../../lib/ui/modalStore.svelte.js';
    import AlertModal from '../modals/AlertModal.svelte';
    import { router } from '../../lib/router.svelte.js';
    import { undo, redo } from 'y-prosemirror';
    import {
        toggleBold, toggleItalic, toggleUnderline,
        toggleStrikethrough, toggleSuperscript, toggleSubscript,
        clearFormatting,
        toggleBulletList, toggleOrderedList, toggleCheckList,
        toggleBlockquote, insertHR,
        addRowBefore, addRowAfter, deleteRow,
        addColumnBefore, addColumnAfter, deleteColumn,
        mergeCells, splitCell,
    } from '../../stores/docs/docCommands.js';

    let {
        view = null,
        onShowPageSetup = undefined,
        onToggleFind = undefined,
        onToggleRuler = undefined,
    } = $props();

    let openMenuId = $state(null);

    function handleMenuOpenChange(isOpen, menuId) {
        openMenuId = isOpen ? menuId : (openMenuId === menuId ? null : openMenuId);
    }

    function run(cmd) {
        if (!view) return;
        cmd(view.state, view.dispatch, view);
        view.focus();
    }

    function showAlert(title, message) {
        openModal(AlertModal, { title, message, type: 'info' });
    }

    // ── FILE ──────────────────────────────────────────────────────────────────
    let fileItems = $derived([
        { label: 'New document',    action: () => (window.location.hash = '/new'), shortcut: 'Ctrl+N' },
        { label: 'Open…',           action: () => router.goBack(),                 shortcut: 'Ctrl+O' },
        { divider: true },
        { label: 'Page Setup…',     action: () => onShowPageSetup?.() },
        {
            label: 'Download',
            submenu: [
                { label: 'Plain Text (.txt)',  action: exportText },
                { label: 'HTML (.html)',       action: exportHTML  },
            ],
        },
        { divider: true },
        { label: 'Print',           action: () => window.print(), shortcut: 'Ctrl+P' },
    ]);

    // ── EDIT ──────────────────────────────────────────────────────────────────
    let editItems = $derived([
        { label: 'Undo',            action: () => run(undo),     shortcut: 'Ctrl+Z' },
        { label: 'Redo',            action: () => run(redo),     shortcut: 'Ctrl+Y' },
        { divider: true },
        { label: 'Cut',             action: () => document.execCommand('cut'),       shortcut: 'Ctrl+X' },
        { label: 'Copy',            action: () => document.execCommand('copy'),      shortcut: 'Ctrl+C' },
        { label: 'Paste',           action: () => document.execCommand('paste'),     shortcut: 'Ctrl+V' },
        { label: 'Paste without formatting', action: () => document.execCommand('paste') },
        { divider: true },
        { label: 'Select All',      action: () => document.execCommand('selectAll'), shortcut: 'Ctrl+A' },
        { divider: true },
        { label: 'Find…',           action: () => onToggleFind?.(), shortcut: 'Ctrl+F' },
        { label: 'Find & Replace…', action: () => onToggleFind?.(), shortcut: 'Ctrl+H' },
    ]);

    // ── VIEW ──────────────────────────────────────────────────────────────────
    const viewItems = [
        { label: 'Toggle ruler',      action: () => onToggleRuler?.() },
        { divider: true },
        { label: 'Toggle full screen', action: toggleFullscreen },
    ];

    // ── INSERT ────────────────────────────────────────────────────────────────
    const insertItems = [
        { label: 'Link…',             action: () => {}, shortcut: 'Ctrl+K' },
        { label: 'Image…',            action: () => {} },
        { divider: true },
        { label: 'Table',             submenu: [
            { label: '3 × 3',         action: () => {} },
            { label: '5 × 5',         action: () => {} },
            { label: 'Custom…',       action: () => {} },
        ]},
        { label: 'Horizontal rule',   action: () => run(insertHR) },
        { divider: true },
        { label: 'Comment',           action: () => {}, shortcut: 'Ctrl+Alt+M' },
    ];

    // ── FORMAT ────────────────────────────────────────────────────────────────
    const formatItems = [
        {
            label: 'Text',
            submenu: [
                { label: 'Bold',          action: () => run(toggleBold),          shortcut: 'Ctrl+B' },
                { label: 'Italic',        action: () => run(toggleItalic),        shortcut: 'Ctrl+I' },
                { label: 'Underline',     action: () => run(toggleUnderline),     shortcut: 'Ctrl+U' },
                { label: 'Strikethrough', action: () => run(toggleStrikethrough) },
                { divider: true },
                { label: 'Superscript',   action: () => run(toggleSuperscript) },
                { label: 'Subscript',     action: () => run(toggleSubscript)   },
            ],
        },
        {
            label: 'Lists',
            submenu: [
                { label: 'Bullet list',   action: () => run(toggleBulletList)  },
                { label: 'Numbered list', action: () => run(toggleOrderedList) },
                { label: 'Checklist',     action: () => run(toggleCheckList)   },
            ],
        },
        {
            label: 'Table',
            submenu: [
                { label: 'Insert row above',    action: () => run(addRowBefore)    },
                { label: 'Insert row below',    action: () => run(addRowAfter)     },
                { label: 'Delete row',          action: () => run(deleteRow)       },
                { divider: true },
                { label: 'Insert column before', action: () => run(addColumnBefore) },
                { label: 'Insert column after',  action: () => run(addColumnAfter)  },
                { label: 'Delete column',        action: () => run(deleteColumn)    },
                { divider: true },
                { label: 'Merge cells',         action: () => run(mergeCells) },
                { label: 'Split cell',          action: () => run(splitCell)  },
            ],
        },
        { divider: true },
        { label: 'Blockquote',        action: () => run(toggleBlockquote) },
        { divider: true },
        { label: 'Clear formatting',  action: () => run(clearFormatting) },
    ];

    // ── HELP ──────────────────────────────────────────────────────────────────
    const helpItems = [
        { label: 'Keyboard shortcuts', shortcut: 'Ctrl+/', action: showKeyboardShortcuts },
        { divider: true },
        { label: 'Help', action: () => showAlert('Help', 'Visit the documentation for help.') },
    ];

    // ── Actions ───────────────────────────────────────────────────────────────

    function toggleFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
    }

    function exportText() {
        const el = document.querySelector('.ProseMirror');
        downloadFile(el?.textContent ?? '', title() + '.txt', 'text/plain');
    }

    function exportHTML() {
        const el = document.querySelector('.ProseMirror');
        if (!el) return;
        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title()}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    h1,h2,h3,h4,h5,h6 { margin-top: 1.5em; }
    blockquote { border-left: 3px solid #ccc; padding-left: 1em; color: #555; font-style: italic; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
    code { background: #f0f0f0; padding: .2em .4em; border-radius: 3px; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ccc; padding: 6px 12px; }
    th { background: #f5f5f5; font-weight: 600; }
  </style>
</head>
<body>${el.innerHTML}</body>
</html>`;
        downloadFile(html, title() + '.html', 'text/html');
    }

    function title() {
        return docSession.metadata?.title || 'document';
    }

    function downloadFile(content, filename, mime) {
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(new Blob([content], { type: mime })),
            download: filename,
        });
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function showKeyboardShortcuts() {
        showAlert('Keyboard Shortcuts',
`Formatting
  Ctrl+B       Bold
  Ctrl+I       Italic
  Ctrl+U       Underline
  Ctrl+K       Insert link

Undo / Redo
  Ctrl+Z       Undo
  Ctrl+Y       Redo
  Ctrl+Shift+Z Redo

Document
  Ctrl+F       Find
  Ctrl+H       Find & Replace
  Ctrl+P       Print
  Ctrl+/       This help

Tables
  Tab          Next cell
  Shift+Tab    Previous cell`
        );
    }
</script>

<div class="menu-bar" class:menu-active={openMenuId !== null}>
    <MenuDropdown label="File"   items={fileItems}   menuId="file"   isOpen={openMenuId === 'file'}   anyMenuOpen={openMenuId !== null} onOpenChange={handleMenuOpenChange} />
    <MenuDropdown label="Edit"   items={editItems}   menuId="edit"   isOpen={openMenuId === 'edit'}   anyMenuOpen={openMenuId !== null} onOpenChange={handleMenuOpenChange} />
    <MenuDropdown label="View"   items={viewItems}   menuId="view"   isOpen={openMenuId === 'view'}   anyMenuOpen={openMenuId !== null} onOpenChange={handleMenuOpenChange} />
    <MenuDropdown label="Insert" items={insertItems} menuId="insert" isOpen={openMenuId === 'insert'} anyMenuOpen={openMenuId !== null} onOpenChange={handleMenuOpenChange} />
    <MenuDropdown label="Format" items={formatItems} menuId="format" isOpen={openMenuId === 'format'} anyMenuOpen={openMenuId !== null} onOpenChange={handleMenuOpenChange} />
    <MenuDropdown label="Help"   items={helpItems}   menuId="help"   isOpen={openMenuId === 'help'}   anyMenuOpen={openMenuId !== null} onOpenChange={handleMenuOpenChange} />
</div>

<style>
    .menu-bar {
        display: flex;
        align-items: center;
        height: 28px;
        background: transparent;
        flex-shrink: 0;
    }

    .menu-active :global(.menu-button:hover:not(.disabled):not(.active)) {
        background: var(--color-fill-tertiary);
    }
</style>
