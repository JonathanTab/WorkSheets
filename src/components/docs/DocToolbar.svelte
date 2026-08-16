<script>
    /**
     * DocToolbar — Two-row toolbar for document editor.
     * Row 1: navigation (back, doc name, menus, presence, history, user).
     * Row 2: full formatting ribbon.
     */
    import DocDocumentName from './DocDocumentName.svelte';
    import DocMenuBar from './DocMenuBar.svelte';
    import DocTableInsert from './DocTableInsert.svelte';
    import PresenceIndicator from '../spreadsheet/PresenceIndicator.svelte';
    import UserMenu from '../UserMenu.svelte';
    import { updateMenuItem } from '../../lib/ui/updateMenuItem.js';
    import {
        toggleBold, toggleItalic, toggleUnderline, toggleStrikethrough,
        toggleSuperscript, toggleSubscript,
        setHeading, setParagraph, setCodeBlock,
        setAlign,
        toggleBulletList, toggleOrderedList, toggleCheckList,
        indentList, outdentList,
        toggleBlockquote, insertHR,
        setTextColor, setBgColor, setFontSize, setFontFamily,
        setLink, insertImage, insertTable, clearFormatting,
        getMarkState,
    } from '../../stores/docs/docCommands.js';
    import { undo, redo } from 'y-prosemirror';

    let {
        view = null,
        editorState = null,
        onClose = undefined,
        awareness = null,
        currentUser = '',
        onShowHistory = undefined,
        onShowPageSetup = undefined,
        onToggleFind = undefined,
        onToggleRuler = undefined,
        registry = null,
        ontriggerlinkdialog = undefined,
    } = $props();

    // Derived formatting state
    let fmt = $derived(editorState ? getMarkState(editorState) : {});

    function run(cmd) {
        if (!view) return;
        cmd(view.state, view.dispatch, view);
        view.focus();
    }

    const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
    const FONT_FAMILIES = [
        'Arial', 'Georgia', 'Times New Roman',
        'Verdana', 'Courier New', 'Trebuchet MS',
        'Helvetica', 'Palatino', 'Garamond',
    ];

    let currentBlockLabel = $derived.by(() => {
        if (!editorState) return 'Normal text';
        const { blockType, headingLevel } = fmt;
        if (blockType === 'heading') return `Heading ${headingLevel}`;
        if (blockType === 'code_block') return 'Code';
        return 'Normal text';
    });

    let currentFontSize = $derived.by(() => {
        if (!fmt.fontSize) return 11;
        return parseInt(fmt.fontSize) || 11;
    });

    // ── Dropdown states ───────────────────────────────────────────────────────
    let showBlockMenu  = $state(false);
    let showTablePick  = $state(false);
    let showLinkDialog = $state(false);
    let showImgDialog  = $state(false);
    let linkHref  = $state('');
    let imgSrc    = $state('');
    let imgAlt    = $state('');

    function setBlock(cmd) { run(cmd); showBlockMenu = false; }

    // Expose a link trigger so DocWorkspace can open it via Ctrl+K
    $effect(() => {
        ontriggerlinkdialog?.(() => {
            if (!view || view.state.selection.empty) return;
            linkHref = '';
            showLinkDialog = true;
        });
    });

    function handleLink() {
        if (!view || view.state.selection.empty) return;
        linkHref = '';
        showLinkDialog = true;
    }

    function applyLink() {
        run(setLink(linkHref));
        showLinkDialog = false;
    }

    function applyImage() {
        if (!imgSrc.trim()) return;
        run(insertImage(imgSrc.trim(), imgAlt.trim()));
        showImgDialog = false;
        imgSrc = '';
        imgAlt = '';
    }

    function handleFontSize(e) {
        run(setFontSize(e.target.value + 'pt'));
    }

    function handleFontFamily(e) {
        run(setFontFamily(e.target.value));
    }

    // Format painter
    let painterActive = $state(false);
    let painterFmt = null;

    function activatePainter() {
        if (!editorState) return;
        painterFmt = { ...fmt };
        painterActive = true;
        view?.dom.addEventListener('mouseup', applyPainter, { once: true });
    }

    function applyPainter() {
        painterActive = false;
        if (!painterFmt || !view) return;
        const state = view.state;
        if (state.selection.empty) return;
        let tr = state.tr;
        const { from, to } = state.selection;
        if (painterFmt.bold)          tr.addMark(from, to, state.schema.marks.strong.create());
        if (painterFmt.italic)        tr.addMark(from, to, state.schema.marks.em.create());
        if (painterFmt.underline)     tr.addMark(from, to, state.schema.marks.underline.create());
        if (painterFmt.strikethrough) tr.addMark(from, to, state.schema.marks.strikethrough.create());
        if (painterFmt.textColor)     tr.addMark(from, to, state.schema.marks.textColor.create({ color: painterFmt.textColor }));
        if (painterFmt.bgColor)       tr.addMark(from, to, state.schema.marks.bgColor.create({ color: painterFmt.bgColor }));
        if (painterFmt.fontSize)      tr.addMark(from, to, state.schema.marks.fontSize.create({ size: painterFmt.fontSize }));
        if (painterFmt.fontFamily)    tr.addMark(from, to, state.schema.marks.fontFamily.create({ family: painterFmt.fontFamily }));
        view.dispatch(tr);
        view.focus();
        painterFmt = null;
    }
</script>

<!-- ── Row 1: navigation & identity ────────────────────────────────────────── -->
<div class="toolbar">
    <div class="toolbar-row row1">
        <div class="row1-left">
            {#if onClose}
                <button class="close-btn" onclick={onClose} title="Back to Drive">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="15 18 9 12 15 6"/>
                    </svg>
                    Back
                </button>
            {/if}
            <DocDocumentName />
            <DocMenuBar
                {view}
                {onShowPageSetup}
                onToggleFind={onToggleFind}
                onToggleRuler={onToggleRuler}
            />
        </div>
        <div class="row1-right">
            <PresenceIndicator {awareness} {currentUser} />
            {#if onShowHistory}
                <button class="icon-btn" onclick={onShowHistory} title="Document history">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                    </svg>
                </button>
            {/if}
            <UserMenu {registry} menuItems={[updateMenuItem]} />
        </div>
    </div>

    <!-- ── Row 2: formatting ribbon ─────────────────────────────────────────── -->
    <div class="toolbar-row row2">
        <div class="ribbon">

            <!-- Undo / Redo -->
            <button class="tool-btn" onclick={() => run(undo)} title="Undo (Ctrl+Z)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
            </button>
            <button class="tool-btn" onclick={() => run(redo)} title="Redo (Ctrl+Y)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
            </button>

            <!-- Format painter -->
            <button
                class="tool-btn"
                class:active={painterActive}
                onclick={activatePainter}
                title="Format painter — copy formatting, then click destination text"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 12c0-3.31 2.69-6 6-6h.5c2.76 0 5 2.24 5 5s-2.24 5-5 5H7"/>
                    <polyline points="7 16 7 22"/>
                    <path d="M14 6h7v5h-7z"/>
                </svg>
            </button>

            <div class="sep"></div>

            <!-- Block type selector -->
            <div class="block-wrap">
                <button class="block-btn" onclick={() => showBlockMenu = !showBlockMenu}>
                    <span class="block-label">{currentBlockLabel}</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {#if showBlockMenu}
                    <div class="block-menu" role="listbox">
                        <button onclick={() => setBlock(setParagraph)}>Normal text</button>
                        <button class="h1" onclick={() => setBlock(setHeading(1))}>Heading 1</button>
                        <button class="h2" onclick={() => setBlock(setHeading(2))}>Heading 2</button>
                        <button class="h3" onclick={() => setBlock(setHeading(3))}>Heading 3</button>
                        <button class="h4" onclick={() => setBlock(setHeading(4))}>Heading 4</button>
                        <button class="h5" onclick={() => setBlock(setHeading(5))}>Heading 5</button>
                        <button class="h6" onclick={() => setBlock(setHeading(6))}>Heading 6</button>
                        <div class="block-sep"></div>
                        <button class="code-b" onclick={() => setBlock(setCodeBlock)}>Code block</button>
                    </div>
                    <div class="backdrop" onclick={() => showBlockMenu = false}></div>
                {/if}
            </div>

            <div class="sep"></div>

            <!-- Font family -->
            <select class="font-family-sel" title="Font family" onchange={handleFontFamily}>
                {#each FONT_FAMILIES as f}
                    <option value={f} selected={fmt.fontFamily === f} style="font-family:{f}">{f}</option>
                {/each}
            </select>

            <!-- Font size -->
            <select class="font-size-sel" title="Font size" onchange={handleFontSize}>
                {#each FONT_SIZES as s}
                    <option value={s} selected={currentFontSize === s}>{s}</option>
                {/each}
            </select>

            <div class="sep"></div>

            <!-- Bold / Italic / Underline / Strikethrough / Superscript / Subscript -->
            <button class="tool-btn" class:active={fmt.bold}          onclick={() => run(toggleBold)}          title="Bold (Ctrl+B)"><b>B</b></button>
            <button class="tool-btn" class:active={fmt.italic}        onclick={() => run(toggleItalic)}        title="Italic (Ctrl+I)"><i>I</i></button>
            <button class="tool-btn" class:active={fmt.underline}     onclick={() => run(toggleUnderline)}     title="Underline (Ctrl+U)"><u>U</u></button>
            <button class="tool-btn" class:active={fmt.strikethrough} onclick={() => run(toggleStrikethrough)} title="Strikethrough"><s>S</s></button>
            <button class="tool-btn sup-btn" class:active={fmt.superscript} onclick={() => run(toggleSuperscript)} title="Superscript">x<sup>2</sup></button>
            <button class="tool-btn sub-btn" class:active={fmt.subscript}   onclick={() => run(toggleSubscript)}   title="Subscript">x<sub>2</sub></button>

            <div class="sep"></div>

            <!-- Text color -->
            <label class="color-btn" title="Text color">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3l-6 18h3l1.5-4.5h9L18 21h3L15 3z"/><line x1="6.75" y1="13.5" x2="17.25" y2="13.5"/></svg>
                <div class="swatch" style="background:{fmt.textColor ?? '#000000'}"></div>
                <input type="color" value={fmt.textColor ?? '#000000'} oninput={(e) => run(setTextColor(e.target.value))} />
            </label>

            <!-- Highlight color -->
            <label class="color-btn" title="Highlight color">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                <div class="swatch" style="background:{fmt.bgColor ?? '#ffff00'}"></div>
                <input type="color" value={fmt.bgColor ?? '#ffff00'} oninput={(e) => run(setBgColor(e.target.value))} />
            </label>

            <!-- Clear formatting -->
            <button class="tool-btn" onclick={() => run(clearFormatting)} title="Clear formatting" disabled={!editorState || editorState.selection.empty}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 1l22 22"/></svg>
            </button>

            <div class="sep"></div>

            <!-- Alignment -->
            <button class="tool-btn" class:active={!fmt.align || fmt.align === 'left'} onclick={() => run(setAlign('left'))} title="Align left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>
            </button>
            <button class="tool-btn" class:active={fmt.align === 'center'} onclick={() => run(setAlign('center'))} title="Center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>
            </button>
            <button class="tool-btn" class:active={fmt.align === 'right'} onclick={() => run(setAlign('right'))} title="Align right">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg>
            </button>
            <button class="tool-btn" class:active={fmt.align === 'justify'} onclick={() => run(setAlign('justify'))} title="Justify">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
            </button>

            <div class="sep"></div>

            <!-- Lists -->
            <button class="tool-btn" class:active={fmt.inBulletList}  onclick={() => run(toggleBulletList)}  title="Bullet list">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>
            </button>
            <button class="tool-btn" class:active={fmt.inOrderedList} onclick={() => run(toggleOrderedList)} title="Numbered list">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>
            </button>
            <button class="tool-btn" class:active={fmt.inCheckList} onclick={() => run(toggleCheckList)} title="Checklist">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            </button>

            <!-- Indent / Outdent -->
            <button class="tool-btn" onclick={() => run(outdentList)} title="Decrease indent (Shift+Tab)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="11 17 6 12 11 7"/><line x1="18" y1="12" x2="6" y2="12"/><line x1="21" y1="6" x2="13" y2="6"/><line x1="21" y1="18" x2="13" y2="18"/></svg>
            </button>
            <button class="tool-btn" onclick={() => run(indentList)} title="Increase indent (Tab)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 17 18 12 13 7"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="3" y1="6" x2="11" y2="6"/><line x1="3" y1="18" x2="11" y2="18"/></svg>
            </button>

            <div class="sep"></div>

            <!-- Blockquote -->
            <button class="tool-btn" class:active={fmt.inBlockquote} onclick={() => run(toggleBlockquote)} title="Blockquote">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
            </button>

            <!-- Horizontal rule -->
            <button class="tool-btn" onclick={() => run(insertHR)} title="Horizontal rule">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12" stroke-width="3"/></svg>
            </button>

            <!-- Link -->
            <button class="tool-btn" onclick={handleLink} title="Insert link (Ctrl+K)" disabled={!editorState || editorState.selection.empty}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </button>

            <!-- Image -->
            <button class="tool-btn" onclick={() => { showImgDialog = true; imgSrc = ''; imgAlt = ''; }} title="Insert image">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </button>

            <!-- Table picker -->
            <div class="block-wrap">
                <button class="tool-btn" onclick={() => showTablePick = !showTablePick} title="Insert table">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
                </button>
                {#if showTablePick}
                    <div class="table-picker-popup">
                        <DocTableInsert
                            oninsert={(rows, cols) => { run(insertTable(rows, cols)); }}
                            onclose={() => { showTablePick = false; }}
                        />
                    </div>
                    <div class="backdrop" onclick={() => showTablePick = false}></div>
                {/if}
            </div>

            <!-- Find -->
            <button class="tool-btn" onclick={onToggleFind} title="Find & Replace (Ctrl+F)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>

        </div>
    </div>
</div>

<!-- ── Link dialog ─────────────────────────────────────────────────────────── -->
{#if showLinkDialog}
    <div class="dialog-backdrop" onclick={() => showLinkDialog = false}></div>
    <div class="dialog link-dialog" role="dialog" aria-label="Insert link">
        <label class="dialog-label">URL</label>
        <input
            type="url"
            class="dialog-input"
            placeholder="https://…"
            bind:value={linkHref}
            onkeydown={(e) => { if (e.key === 'Enter') applyLink(); if (e.key === 'Escape') showLinkDialog = false; }}
            autofocus
        />
        <div class="dialog-actions">
            <button class="btn-secondary" onclick={() => { run(setLink(null)); showLinkDialog = false; }}>Remove</button>
            <button class="btn-primary" onclick={applyLink}>Apply</button>
        </div>
    </div>
{/if}

<!-- ── Image dialog ───────────────────────────────────────────────────────── -->
{#if showImgDialog}
    <div class="dialog-backdrop" onclick={() => showImgDialog = false}></div>
    <div class="dialog img-dialog" role="dialog" aria-label="Insert image">
        <label class="dialog-label">Image URL</label>
        <input
            type="url"
            class="dialog-input"
            placeholder="https://example.com/image.png"
            bind:value={imgSrc}
            onkeydown={(e) => { if (e.key === 'Enter') applyImage(); if (e.key === 'Escape') showImgDialog = false; }}
            autofocus
        />
        <label class="dialog-label" style="margin-top:8px">Alt text (optional)</label>
        <input
            type="text"
            class="dialog-input"
            placeholder="Description…"
            bind:value={imgAlt}
            onkeydown={(e) => { if (e.key === 'Enter') applyImage(); if (e.key === 'Escape') showImgDialog = false; }}
        />
        <div class="dialog-actions">
            <button class="btn-secondary" onclick={() => showImgDialog = false}>Cancel</button>
            <button class="btn-primary" onclick={applyImage} disabled={!imgSrc.trim()}>Insert</button>
        </div>
    </div>
{/if}

<style>
    .toolbar {
        display: flex;
        flex-direction: column;
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
        user-select: none;
        flex-shrink: 0;
    }

    /* ── Row 1 ── */
    .toolbar-row { display: flex; align-items: center; padding: 0 8px; }
    .row1 {
        min-height: 34px;
        justify-content: space-between;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
        gap: 6px;
    }
    .row1-left, .row1-right { display: flex; align-items: center; gap: 4px; }

    .close-btn {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 3px 8px;
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--color-text-secondary);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
    }
    .close-btn:hover { background: var(--color-fill); color: var(--color-text); }

    .icon-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
    }
    .icon-btn:hover { background: var(--color-fill); color: var(--color-text); }

    /* ── Row 2 / ribbon ── */
    .row2 { padding: 3px 6px; background: var(--color-surface); min-height: 36px; }
    .ribbon {
        display: flex;
        align-items: center;
        gap: 1px;
        flex-wrap: wrap;
    }

    /* Separator */
    .sep { width: 1px; height: 20px; background: var(--color-border); margin: 0 4px; flex-shrink: 0; }

    /* Tool button */
    .tool-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text, #18181b);
        cursor: pointer;
        font-size: 13px;
        padding: 0;
        transition: background 0.1s;
        flex-shrink: 0;
    }
    .tool-btn:hover { background: var(--color-fill); }
    .tool-btn.active {
        background: var(--color-primary-soft, #dbeafe);
        color: var(--color-primary, #007AFF);
    }
    .tool-btn:disabled { opacity: 0.38; cursor: default; }
    .tool-btn svg { width: 15px; height: 15px; }

    .sup-btn, .sub-btn { font-size: 11px; font-weight: 600; }

    /* Block selector */
    .block-wrap { position: relative; flex-shrink: 0; }
    .block-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: transparent;
        color: var(--color-text);
        cursor: pointer;
        font-size: 12px;
        min-width: 110px;
    }
    .block-btn:hover { background: var(--color-fill); }
    .block-label { flex: 1; text-align: left; white-space: nowrap; }

    .block-menu {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 300;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        padding: 4px;
        min-width: 170px;
        box-shadow: 0 8px 24px rgba(0,0,0,.14);
    }
    .block-menu button {
        display: block;
        width: 100%;
        padding: 6px 10px;
        text-align: left;
        background: none;
        border: none;
        border-radius: 5px;
        color: var(--color-text);
        cursor: pointer;
        font-size: 13px;
    }
    .block-menu button:hover { background: var(--color-fill); }
    .block-menu .h1 { font-size: 22px; font-weight: 700; }
    .block-menu .h2 { font-size: 18px; font-weight: 600; }
    .block-menu .h3 { font-size: 15px; font-weight: 600; }
    .block-menu .h4 { font-size: 13px; font-weight: 600; }
    .block-menu .h5 { font-size: 12px; font-weight: 500; }
    .block-menu .h6 { font-size: 11px; font-weight: 500; }
    .block-menu .code-b { font-family: monospace; }
    .block-sep { height: 1px; background: var(--color-border); margin: 3px 4px; }

    /* Font selects */
    .font-family-sel, .font-size-sel {
        height: 28px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 12px;
        cursor: pointer;
        padding: 0 4px;
        flex-shrink: 0;
    }
    .font-family-sel { width: 120px; }
    .font-size-sel   { width: 52px; }

    /* Color buttons */
    .color-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 4px;
        cursor: pointer;
        padding: 2px;
        position: relative;
        flex-shrink: 0;
        gap: 1px;
    }
    .color-btn:hover { background: var(--color-fill); }
    .color-btn svg { width: 14px; height: 14px; }
    .swatch { width: 14px; height: 3px; border-radius: 1px; }
    .color-btn input[type="color"] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }

    /* Table picker popup */
    .table-picker-popup {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 300;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,.14);
    }

    /* Shared backdrop */
    .backdrop { position: fixed; inset: 0; z-index: 299; }

    /* ── Dialogs ── */
    .dialog-backdrop { position: fixed; inset: 0; z-index: 400; }
    .dialog {
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 401;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        padding: 16px 20px;
        box-shadow: 0 12px 32px rgba(0,0,0,.2);
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 320px;
    }
    .dialog-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: .04em;
    }
    .dialog-input {
        height: 32px;
        border: 1px solid var(--color-border);
        border-radius: 6px;
        padding: 0 10px;
        font-size: 13px;
        color: var(--color-text);
        background: var(--color-surface);
        outline: none;
        width: 100%;
        box-sizing: border-box;
    }
    .dialog-input:focus { border-color: var(--color-primary); box-shadow: 0 0 0 2px rgba(0,122,255,.2); }
    .dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 6px;
    }
    .btn-primary {
        height: 30px; padding: 0 14px; border-radius: 6px; border: none;
        background: var(--color-primary, #007AFF); color: white; font-size: 13px;
        font-weight: 500; cursor: pointer;
    }
    .btn-primary:disabled { opacity: 0.4; cursor: default; }
    .btn-primary:hover:not(:disabled) { opacity: 0.9; }
    .btn-secondary {
        height: 30px; padding: 0 14px; border-radius: 6px;
        border: 1px solid var(--color-border); background: transparent;
        color: var(--color-text-secondary); font-size: 13px; cursor: pointer;
    }
    .btn-secondary:hover { background: var(--color-fill); }

    @media (max-width: 600px) {
        .row2 { overflow-x: auto; flex-wrap: nowrap; }
        .ribbon { flex-wrap: nowrap; }
        .font-family-sel { width: 90px; }
    }
</style>
