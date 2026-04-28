<script>
    /**
     * DocFloatingToolbar — contextual mini-toolbar that appears above text selections.
     * Fades in after a short delay (like Word's mini-toolbar), fades out when selection clears.
     * Positioned fixed in the viewport, anchored to the selection midpoint.
     */
    import {
        toggleBold, toggleItalic, toggleUnderline, toggleStrikethrough,
        setTextColor, setBgColor, setLink, clearFormatting, getMarkState,
    } from '../../stores/docs/docCommands.js';

    let {
        view = null,
        editorState = null,
    } = $props();

    let visible = $state(false);
    let pos = $state({ top: 0, left: 0 });
    let timer = null;

    let fmt = $derived(editorState ? getMarkState(editorState) : {});

    let showLinkInput = $state(false);
    let linkVal = $state('');

    // Re-compute position whenever editor state changes
    $effect(() => {
        if (!view || !editorState) { hide(); return; }
        const { selection } = editorState;
        if (selection.empty) { hide(); return; }

        clearTimeout(timer);
        timer = setTimeout(() => {
            if (!view || editorState.selection.empty) return;
            computePos(editorState.selection);
            visible = true;
        }, 280);
    });

    function hide() {
        clearTimeout(timer);
        visible = false;
        showLinkInput = false;
    }

    function computePos(sel) {
        try {
            const start = view.coordsAtPos(sel.from);
            const end   = view.coordsAtPos(sel.to);
            const midX  = (start.left + end.right) / 2;
            const topY  = Math.min(start.top, end.top);
            pos = {
                top:  topY - 46,
                left: midX,
            };
        } catch {
            visible = false;
        }
    }

    function run(cmd) {
        if (!view) return;
        cmd(view.state, view.dispatch, view);
        view.focus();
    }

    function applyLink() {
        run(setLink(linkVal));
        showLinkInput = false;
        linkVal = '';
    }

    function handleMouseDown(e) {
        // Prevent toolbar clicks from stealing focus
        e.preventDefault();
    }
</script>

{#if visible}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="floating-toolbar"
        style="top:{pos.top}px; left:{pos.left}px"
        onmousedown={handleMouseDown}
        role="toolbar"
        aria-label="Text formatting"
    >
        {#if showLinkInput}
            <div class="link-row">
                <input
                    type="url"
                    class="link-input"
                    placeholder="https://…"
                    bind:value={linkVal}
                    onkeydown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
                        if (e.key === 'Escape') { showLinkInput = false; }
                    }}
                    autofocus
                />
                <button class="ft-btn" onclick={applyLink} title="Apply link">✓</button>
                <button class="ft-btn" onclick={() => { run(setLink(null)); showLinkInput = false; }} title="Remove link">✗</button>
            </div>
        {:else}
            <button class="ft-btn" class:active={fmt.bold}          onclick={() => run(toggleBold)}          title="Bold (Ctrl+B)"><b>B</b></button>
            <button class="ft-btn" class:active={fmt.italic}        onclick={() => run(toggleItalic)}        title="Italic (Ctrl+I)"><i>I</i></button>
            <button class="ft-btn" class:active={fmt.underline}     onclick={() => run(toggleUnderline)}     title="Underline (Ctrl+U)"><u>U</u></button>
            <button class="ft-btn" class:active={fmt.strikethrough} onclick={() => run(toggleStrikethrough)} title="Strikethrough"><s>S</s></button>
            <div class="ft-sep"></div>
            <!-- Text color inline -->
            <label class="ft-color-btn" title="Text color">
                A
                <div class="ft-swatch" style="background:{fmt.textColor ?? '#000000'}"></div>
                <input
                    type="color"
                    value={fmt.textColor ?? '#000000'}
                    oninput={(e) => run(setTextColor(e.target.value))}
                />
            </label>
            <!-- Highlight -->
            <label class="ft-color-btn" title="Highlight color">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>
                </svg>
                <div class="ft-swatch" style="background:{fmt.bgColor ?? '#ffff00'}"></div>
                <input
                    type="color"
                    value={fmt.bgColor ?? '#ffff00'}
                    oninput={(e) => run(setBgColor(e.target.value))}
                />
            </label>
            <div class="ft-sep"></div>
            <button class="ft-btn" onclick={() => { showLinkInput = true; linkVal = ''; }} title="Insert link (Ctrl+K)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
            </button>
            <button class="ft-btn" onclick={() => run(clearFormatting)} title="Clear formatting">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 7h16M7 7l2 13M17 7l-2 13M10 7V4h4v3"/>
                    <line x1="18" y1="18" x2="6" y2="6"/>
                </svg>
            </button>
        {/if}
    </div>
{/if}

<style>
    .floating-toolbar {
        position: fixed;
        transform: translateX(-50%);
        z-index: 500;
        display: flex;
        align-items: center;
        gap: 1px;
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #c6c6c8);
        border-radius: 7px;
        padding: 3px 4px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.08);
        animation: ft-appear 0.15s ease;
        pointer-events: all;
        user-select: none;
    }

    @keyframes ft-appear {
        from { opacity: 0; transform: translateX(-50%) translateY(4px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0);   }
    }

    .ft-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 26px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text, #18181b);
        cursor: pointer;
        font-size: 12px;
        padding: 0;
        transition: background 0.1s;
        flex-shrink: 0;
    }
    .ft-btn:hover { background: var(--color-fill, #f4f4f5); }
    .ft-btn.active {
        background: var(--color-primary-soft, #dbeafe);
        color: var(--color-primary, #007AFF);
    }

    .ft-sep {
        width: 1px;
        height: 18px;
        background: var(--color-border, #c6c6c8);
        margin: 0 2px;
        flex-shrink: 0;
    }

    .ft-color-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 26px;
        cursor: pointer;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 700;
        color: var(--color-text);
        position: relative;
        flex-shrink: 0;
    }
    .ft-color-btn:hover { background: var(--color-fill); }

    .ft-swatch {
        width: 14px;
        height: 2px;
        border-radius: 1px;
    }
    .ft-color-btn input[type="color"] {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
        pointer-events: none;
    }

    /* Link row inside the toolbar */
    .link-row {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .link-input {
        height: 24px;
        width: 220px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        padding: 0 6px;
        font-size: 11px;
        color: var(--color-text);
        background: var(--color-surface);
        outline: none;
    }
    .link-input:focus { border-color: var(--color-primary, #007AFF); }
</style>
