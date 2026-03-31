<script>
    /**
     * DocToolbar — Two-row toolbar for document editor.
     * Matches the structure of spreadsheet Toolbar for consistent UX.
     */
    import DocDocumentName from "./DocDocumentName.svelte";
    import DocMenuBar from "./DocMenuBar.svelte";
    import PresenceIndicator from "../spreadsheet/PresenceIndicator.svelte";
    import UserMenu from "../UserMenu.svelte";
    import {
        toggleBold,
        toggleItalic,
        toggleUnderline,
        toggleStrikethrough,
        setHeading,
        setParagraph,
        setCodeBlock,
        setAlign,
        toggleBulletList,
        toggleOrderedList,
        indentList,
        outdentList,
        toggleBlockquote,
        insertHR,
        setTextColor,
        setBgColor,
        setFontSize,
        setFontFamily,
        setLink,
        getMarkState,
    } from "../../stores/docs/docCommands.js";
    import { undo, redo } from "y-prosemirror";

    let {
        view = null,
        editorState = null,
        onClose = undefined,
        awareness = null,
        currentUser = "",
        onShowHistory = undefined,
        onShowPageSetup = undefined,
        registry = null,
    } = $props();

    // Derived formatting state from current ProseMirror state
    let fmt = $derived(editorState ? getMarkState(editorState) : {});

    function run(cmd) {
        if (!view) return;
        cmd(view.state, view.dispatch, view);
        view.focus();
    }

    // Font sizes
    const FONT_SIZES = [
        8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72,
    ];
    const FONT_FAMILIES = [
        "Arial",
        "Georgia",
        "Times New Roman",
        "Verdana",
        "Courier New",
        "Trebuchet MS",
    ];

    let currentBlockLabel = $derived.by(() => {
        if (!editorState) return "Normal text";
        const bt = fmt.blockType;
        if (bt === "heading") return `Heading ${fmt.headingLevel}`;
        if (bt === "code_block") return "Code";
        return "Normal text";
    });

    let showBlockMenu = $state(false);
    let showLinkDialog = $state(false);
    let linkHref = $state("");

    function setBlock(cmd) {
        run(cmd);
        showBlockMenu = false;
    }

    function handleLink() {
        if (!view) return;
        const { selection } = view.state;
        if (selection.empty) return;
        showLinkDialog = true;
        linkHref = "";
    }

    function applyLink() {
        run(setLink(linkHref));
        showLinkDialog = false;
    }

    function handleFontSize(e) {
        const size = e.target.value + "pt";
        run(setFontSize(size));
    }

    function handleFontFamily(e) {
        run(setFontFamily(e.target.value));
    }

    let currentFontSize = $derived.by(() => {
        if (!fmt.fontSize) return 11;
        return parseInt(fmt.fontSize) || 11;
    });
</script>

<div class="toolbar">
    <div class="toolbar-row row1">
        <div class="row1-left">
            {#if onClose}
                <button
                    class="close-btn"
                    onclick={onClose}
                    title="Close document"
                >
                    ← Back
                </button>
            {/if}
            <DocDocumentName />
            <DocMenuBar {onShowPageSetup} />
        </div>
        <div class="row1-right">
            <PresenceIndicator {awareness} {currentUser} />
            {#if onShowHistory}
                <button
                    class="history-btn"
                    onclick={onShowHistory}
                    title="Document history"
                    aria-label="View document history"
                >
                    <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                    </svg>
                </button>
            {/if}
            <UserMenu {registry} />
        </div>
    </div>
    <div class="toolbar-row row2">
        <div class="formatting-toolbar">
            <!-- Undo / Redo -->
            <button
                class="tool-btn"
                onclick={() => run(undo)}
                title="Undo (Ctrl+Z)"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path d="M3 7v6h6" />
                    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                </svg>
            </button>
            <button
                class="tool-btn"
                onclick={() => run(redo)}
                title="Redo (Ctrl+Y)"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path d="M21 7v6h-6" />
                    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
                </svg>
            </button>

            <div class="toolbar-sep"></div>

            <!-- Block type selector -->
            <div class="block-selector-wrap">
                <button
                    class="block-selector"
                    onclick={() => (showBlockMenu = !showBlockMenu)}
                >
                    <span>{currentBlockLabel}</span>
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        width="14"
                        height="14"
                    >
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                </button>
                {#if showBlockMenu}
                    <div class="block-menu" role="menu">
                        <button onclick={() => setBlock(setParagraph)}
                            >Normal text</button
                        >
                        <button
                            class="heading-1"
                            onclick={() => setBlock(setHeading(1))}
                            >Heading 1</button
                        >
                        <button
                            class="heading-2"
                            onclick={() => setBlock(setHeading(2))}
                            >Heading 2</button
                        >
                        <button
                            class="heading-3"
                            onclick={() => setBlock(setHeading(3))}
                            >Heading 3</button
                        >
                        <button
                            class="heading-4"
                            onclick={() => setBlock(setHeading(4))}
                            >Heading 4</button
                        >
                        <button
                            class="heading-5"
                            onclick={() => setBlock(setHeading(5))}
                            >Heading 5</button
                        >
                        <button
                            class="heading-6"
                            onclick={() => setBlock(setHeading(6))}
                            >Heading 6</button
                        >
                        <button
                            class="code-block"
                            onclick={() => setBlock(setCodeBlock)}
                            >Code block</button
                        >
                    </div>
                    <div
                        class="block-menu-backdrop"
                        onclick={() => (showBlockMenu = false)}
                    ></div>
                {/if}
            </div>

            <div class="toolbar-sep"></div>

            <!-- Font family -->
            <select
                class="font-family-select"
                title="Font family"
                onchange={handleFontFamily}
            >
                {#each FONT_FAMILIES as f}
                    <option
                        value={f}
                        selected={fmt.fontFamily === f}
                        style="font-family:{f}">{f}</option
                    >
                {/each}
            </select>

            <!-- Font size -->
            <select
                class="font-size-select"
                title="Font size"
                onchange={handleFontSize}
            >
                {#each FONT_SIZES as s}
                    <option value={s} selected={currentFontSize === s}
                        >{s}</option
                    >
                {/each}
            </select>

            <div class="toolbar-sep"></div>

            <!-- Bold, Italic, Underline, Strikethrough -->
            <button
                class="tool-btn"
                class:active={fmt.bold}
                onclick={() => run(toggleBold)}
                title="Bold (Ctrl+B)"><b>B</b></button
            >
            <button
                class="tool-btn"
                class:active={fmt.italic}
                onclick={() => run(toggleItalic)}
                title="Italic (Ctrl+I)"><i>I</i></button
            >
            <button
                class="tool-btn"
                class:active={fmt.underline}
                onclick={() => run(toggleUnderline)}
                title="Underline (Ctrl+U)"><u>U</u></button
            >
            <button
                class="tool-btn"
                class:active={fmt.strikethrough}
                onclick={() => run(toggleStrikethrough)}
                title="Strikethrough"><s>S</s></button
            >

            <div class="toolbar-sep"></div>

            <!-- Text color -->
            <label class="color-btn" title="Text color">
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path d="M9 3l-6 18h3l1.5-4.5h9L18 21h3L15 3z" />
                    <line x1="6.75" y1="13.5" x2="17.25" y2="13.5" />
                </svg>
                <div
                    class="color-swatch"
                    style="background:{fmt.textColor ?? '#000000'}"
                ></div>
                <input
                    type="color"
                    value={fmt.textColor ?? "#000000"}
                    oninput={(e) => run(setTextColor(e.target.value))}
                />
            </label>

            <!-- Highlight color -->
            <label class="color-btn" title="Highlight color">
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path d="M12 20h9" />
                    <path
                        d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
                    />
                </svg>
                <div
                    class="color-swatch"
                    style="background:{fmt.bgColor ?? '#ffff00'}"
                ></div>
                <input
                    type="color"
                    value={fmt.bgColor ?? "#ffff00"}
                    oninput={(e) => run(setBgColor(e.target.value))}
                />
            </label>

            <div class="toolbar-sep"></div>

            <!-- Alignment -->
            <button
                class="tool-btn"
                class:active={fmt.align === "left" || !fmt.align}
                onclick={() => run(setAlign("left"))}
                title="Align left"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <line x1="17" y1="10" x2="3" y2="10" />
                    <line x1="21" y1="6" x2="3" y2="6" />
                    <line x1="21" y1="14" x2="3" y2="14" />
                    <line x1="17" y1="18" x2="3" y2="18" />
                </svg>
            </button>
            <button
                class="tool-btn"
                class:active={fmt.align === "center"}
                onclick={() => run(setAlign("center"))}
                title="Center"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <line x1="18" y1="10" x2="6" y2="10" />
                    <line x1="21" y1="6" x2="3" y2="6" />
                    <line x1="21" y1="14" x2="3" y2="14" />
                    <line x1="18" y1="18" x2="6" y2="18" />
                </svg>
            </button>
            <button
                class="tool-btn"
                class:active={fmt.align === "right"}
                onclick={() => run(setAlign("right"))}
                title="Align right"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <line x1="21" y1="10" x2="7" y2="10" />
                    <line x1="21" y1="6" x2="3" y2="6" />
                    <line x1="21" y1="14" x2="3" y2="14" />
                    <line x1="21" y1="18" x2="7" y2="18" />
                </svg>
            </button>
            <button
                class="tool-btn"
                class:active={fmt.align === "justify"}
                onclick={() => run(setAlign("justify"))}
                title="Justify"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <line x1="21" y1="10" x2="3" y2="10" />
                    <line x1="21" y1="6" x2="3" y2="6" />
                    <line x1="21" y1="14" x2="3" y2="14" />
                    <line x1="21" y1="18" x2="3" y2="18" />
                </svg>
            </button>

            <div class="toolbar-sep"></div>

            <!-- Lists -->
            <button
                class="tool-btn"
                class:active={fmt.inBulletList}
                onclick={() => run(toggleBulletList)}
                title="Bullet list"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <line x1="9" y1="6" x2="20" y2="6" />
                    <line x1="9" y1="12" x2="20" y2="12" />
                    <line x1="9" y1="18" x2="20" y2="18" />
                    <circle cx="4" cy="6" r="1" fill="currentColor" />
                    <circle cx="4" cy="12" r="1" fill="currentColor" />
                    <circle cx="4" cy="18" r="1" fill="currentColor" />
                </svg>
            </button>
            <button
                class="tool-btn"
                class:active={fmt.inOrderedList}
                onclick={() => run(toggleOrderedList)}
                title="Numbered list"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <line x1="10" y1="6" x2="21" y2="6" />
                    <line x1="10" y1="12" x2="21" y2="12" />
                    <line x1="10" y1="18" x2="21" y2="18" />
                    <path d="M4 6h1v4" />
                    <path d="M4 10h2" />
                    <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
                </svg>
            </button>

            <!-- Indent / Outdent -->
            <button
                class="tool-btn"
                onclick={() => run(outdentList)}
                title="Decrease indent"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <polyline points="11 17 6 12 11 7" />
                    <line x1="18" y1="12" x2="6" y2="12" />
                    <line x1="21" y1="6" x2="13" y2="6" />
                    <line x1="21" y1="18" x2="13" y2="18" />
                </svg>
            </button>
            <button
                class="tool-btn"
                onclick={() => run(indentList)}
                title="Increase indent"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <polyline points="13 17 18 12 13 7" />
                    <line x1="6" y1="12" x2="18" y2="12" />
                    <line x1="3" y1="6" x2="11" y2="6" />
                    <line x1="3" y1="18" x2="11" y2="18" />
                </svg>
            </button>

            <div class="toolbar-sep"></div>

            <!-- Blockquote, HR, Link -->
            <button
                class="tool-btn"
                class:active={fmt.inBlockquote}
                onclick={() => run(toggleBlockquote)}
                title="Blockquote"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path
                        d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"
                    />
                    <path
                        d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"
                    />
                </svg>
            </button>
            <button
                class="tool-btn"
                onclick={() => run(insertHR)}
                title="Horizontal rule"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <line x1="5" y1="12" x2="19" y2="12" stroke-width="3" />
                </svg>
            </button>
            <button class="tool-btn" onclick={handleLink} title="Insert link">
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path
                        d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
                    />
                    <path
                        d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
                    />
                </svg>
            </button>
        </div>
    </div>
</div>

<!-- Link dialog -->
{#if showLinkDialog}
    <div
        class="link-dialog-backdrop"
        onclick={() => (showLinkDialog = false)}
    ></div>
    <div class="link-dialog">
        <input
            type="url"
            placeholder="https://..."
            bind:value={linkHref}
            onkeydown={(e) => {
                if (e.key === "Enter") applyLink();
                if (e.key === "Escape") showLinkDialog = false;
            }}
            autofocus
        />
        <button onclick={applyLink}>Apply</button>
        <button
            onclick={() => {
                run(setLink(null));
                showLinkDialog = false;
            }}>Remove</button
        >
    </div>
{/if}

<style>
    .toolbar {
        display: flex;
        flex-direction: column;
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
        user-select: none;
    }

    .toolbar-row {
        display: flex;
        align-items: center;
        padding: 0 8px;
        min-height: 32px;
    }

    .row1 {
        justify-content: space-between;
        border-bottom: 1px solid var(--color-border);
        gap: 8px;
        background: var(--color-bg-secondary);
    }

    .row1-left {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .row1-right {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .history-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: 4px;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all 0.1s ease;
    }

    .history-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .history-btn:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .row2 {
        justify-content: flex-start;
        background: var(--color-surface);
        padding: 0 6px;
    }

    .close-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--color-text-secondary);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.1s ease;
    }

    .close-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .close-btn:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .formatting-toolbar {
        display: flex;
        align-items: center;
        gap: 2px;
        flex-wrap: wrap;
    }

    .toolbar-sep {
        width: 1px;
        height: 20px;
        background: var(--color-border, #444);
        margin: 0 4px;
        flex-shrink: 0;
    }

    .tool-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text, #e0e0e0);
        cursor: pointer;
        font-size: 13px;
        padding: 0;
        transition: background 0.1s;
        flex-shrink: 0;
    }
    .tool-btn:hover {
        background: var(--color-hover, rgba(255, 255, 255, 0.08));
    }
    .tool-btn.active {
        background: var(--color-accent-muted, rgba(99, 102, 241, 0.3));
        color: var(--color-accent, #818cf8);
    }
    .tool-btn svg {
        width: 16px;
        height: 16px;
    }

    .block-selector-wrap {
        position: relative;
        flex-shrink: 0;
    }
    .block-selector {
        display: flex;
        align-items: center;
        gap: 4px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid var(--color-border, #444);
        border-radius: 4px;
        background: transparent;
        color: var(--color-text, #e0e0e0);
        cursor: pointer;
        font-size: 12px;
        min-width: 110px;
        white-space: nowrap;
    }
    .block-selector:hover {
        background: var(--color-hover, rgba(255, 255, 255, 0.08));
    }
    .block-selector span {
        flex: 1;
        text-align: left;
    }

    .block-menu {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 200;
        background: var(--color-surface, #1a1a2e);
        border: 1px solid var(--color-border, #444);
        border-radius: 6px;
        padding: 4px;
        min-width: 160px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
    .block-menu button {
        display: block;
        width: 100%;
        padding: 6px 10px;
        text-align: left;
        background: none;
        border: none;
        border-radius: 4px;
        color: var(--color-text, #e0e0e0);
        cursor: pointer;
        font-size: 13px;
    }
    .block-menu button:hover {
        background: var(--color-hover, rgba(255, 255, 255, 0.08));
    }
    .block-menu .heading-1 {
        font-size: 20px;
        font-weight: 700;
    }
    .block-menu .heading-2 {
        font-size: 17px;
        font-weight: 600;
    }
    .block-menu .heading-3 {
        font-size: 15px;
        font-weight: 600;
    }
    .block-menu .heading-4 {
        font-size: 13px;
        font-weight: 600;
    }
    .block-menu .heading-5 {
        font-size: 12px;
        font-weight: 500;
    }
    .block-menu .heading-6 {
        font-size: 11px;
        font-weight: 500;
    }
    .block-menu .code-block {
        font-family: monospace;
    }
    .block-menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 199;
    }

    .font-family-select,
    .font-size-select {
        height: 28px;
        border: 1px solid var(--color-border, #444);
        border-radius: 4px;
        background: var(--color-surface, #1a1a2e);
        color: var(--color-text, #e0e0e0);
        font-size: 12px;
        cursor: pointer;
        padding: 0 4px;
        flex-shrink: 0;
    }
    .font-family-select {
        width: 120px;
    }
    .font-size-select {
        width: 54px;
    }

    .color-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        width: 28px;
        height: 28px;
        border-radius: 4px;
        cursor: pointer;
        padding: 2px;
        position: relative;
        flex-shrink: 0;
    }
    .color-btn:hover {
        background: var(--color-hover, rgba(255, 255, 255, 0.08));
    }
    .color-btn svg {
        width: 14px;
        height: 14px;
        color: var(--color-text, #e0e0e0);
    }
    .color-swatch {
        width: 14px;
        height: 3px;
        border-radius: 1px;
        margin-top: 1px;
    }
    .color-btn input[type="color"] {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
        pointer-events: none;
    }

    .link-dialog-backdrop {
        position: fixed;
        inset: 0;
        z-index: 300;
    }
    .link-dialog {
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 301;
        display: flex;
        align-items: center;
        gap: 8px;
        background: var(--color-surface, #1a1a2e);
        border: 1px solid var(--color-border, #444);
        border-radius: 8px;
        padding: 12px 16px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
    .link-dialog input {
        height: 32px;
        width: 320px;
        padding: 0 10px;
        border: 1px solid var(--color-border, #444);
        border-radius: 6px;
        background: var(--color-bg, #0d0d1a);
        color: var(--color-text, #e0e0e0);
        font-size: 13px;
    }
    .link-dialog button {
        height: 32px;
        padding: 0 12px;
        border: 1px solid var(--color-border, #444);
        border-radius: 6px;
        background: var(--color-accent, #4f46e5);
        color: white;
        cursor: pointer;
        font-size: 13px;
    }
    .link-dialog button:last-child {
        background: transparent;
        color: var(--color-text-secondary, #aaa);
    }

    /* Mobile: tighter rows */
    @media (pointer: coarse), (max-width: 768px) {
        .toolbar-row {
            min-height: 38px;
            padding: 0 6px;
        }
        .row1 {
            gap: 4px;
        }
        .close-btn {
            padding: 6px 10px;
            font-size: 0.875rem;
        }
    }
</style>
