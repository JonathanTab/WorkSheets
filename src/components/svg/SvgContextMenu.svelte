<script>
    /**
     * SvgContextMenu — right-click context menu for the SVG editor canvas.
     *
     * Renders at fixed viewport position (x, y).
     * Closes on outside click, contextmenu event, or Escape.
     */
    import { onMount, onDestroy } from 'svelte';
    import { svgEditorState } from '../../stores/svg/svgEditorState.svelte.js';

    let {
        x = 0,
        y = 0,
        onClose   = () => {},
        onChanged = () => {},
    } = $props();

    // ── Selection state ───────────────────────────────────────────────────────

    const sel      = $derived(svgEditorState.selectedShapes);
    const hasSel   = $derived(sel.length > 0);
    const isSingle = $derived(sel.length === 1);
    const isPath   = $derived(isSingle && sel[0]?.tag === 'path');
    const isGroup  = $derived(isSingle && sel[0]?.type === 'group');
    const isMulti  = $derived(sel.length > 1);
    const isLocked = $derived(isSingle && sel[0]?.locked);
    const canGroup = $derived(sel.length >= 2 && sel.every(s => !s.locked));
    const canZ     = $derived(isSingle && !isLocked);

    // ── Actions ───────────────────────────────────────────────────────────────

    function run(fn) { fn(); onClose(); }

    async function cut()   { await svgEditorState.cutSelected();     onChanged(); onClose(); }
    async function copy()  { await svgEditorState.copySelected();    onClose(); }
    async function paste() { await svgEditorState.pasteClipboard();  onChanged(); onClose(); }

    function del()          { svgEditorState.deleteSelected();                   onChanged(); onClose(); }
    function group()        { svgEditorState.groupSelected();                    onChanged(); onClose(); }
    function ungroup()      { svgEditorState.ungroupSelected();                  onChanged(); onClose(); }
    function bringToFront() { if (canZ) svgEditorState.bringToFront(sel[0].id);  onClose(); }
    function bringFwd()     { if (canZ) svgEditorState.bringForward(sel[0].id);  onClose(); }
    function sendBwd()      { if (canZ) svgEditorState.sendBackward(sel[0].id);  onClose(); }
    function sendToBack()   { if (canZ) svgEditorState.sendToBack(sel[0].id);    onClose(); }
    function toggleLock()   { if (isSingle) svgEditorState.setLocked(sel[0].id, !isLocked); onClose(); }
    function selectAll()    { svgEditorState.selectAll(); onClose(); }

    function editNodes() {
        if (!isPath) return;
        svgEditorState.activeTool = 'node';
        onClose();
    }

    // ── Close on outside interaction ──────────────────────────────────────────

    function onWinClick(e) {
        if (!menuEl?.contains(e.target)) onClose();
    }
    function onWinCtx(e) {
        if (!menuEl?.contains(e.target)) onClose();
    }
    function onKeydown(e) {
        if (e.key === 'Escape') onClose();
    }

    let menuEl;

    onMount(() => {
        // Defer so the click that opened the context menu isn't caught immediately
        setTimeout(() => {
            window.addEventListener('click',       onWinClick, { capture: true });
            window.addEventListener('contextmenu', onWinCtx,   { capture: true });
            window.addEventListener('keydown',     onKeydown);
        }, 0);
    });
    onDestroy(() => {
        window.removeEventListener('click',       onWinClick, { capture: true });
        window.removeEventListener('contextmenu', onWinCtx,   { capture: true });
        window.removeEventListener('keydown',     onKeydown);
    });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<menu
    bind:this={menuEl}
    class="ctx-menu"
    style="left:{x}px; top:{y}px;"
    onclick={(e) => e.stopPropagation()}
    oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
>
    {#if isPath}
        <li class="item" onclick={editNodes}>Edit Nodes</li>
        <div class="sep"></div>
    {/if}

    {#if hasSel}
        <li class="item" onclick={cut}>Cut</li>
        <li class="item" onclick={copy}>Copy</li>
    {/if}
    <li class="item" onclick={paste}>Paste</li>

    {#if hasSel}
        <div class="sep"></div>

        {#if canZ}
            <li class="item" onclick={bringToFront}>Bring to Front</li>
            <li class="item" onclick={bringFwd}>Bring Forward</li>
            <li class="item" onclick={sendBwd}>Send Backward</li>
            <li class="item" onclick={sendToBack}>Send to Back</li>
            <div class="sep"></div>
        {/if}

        {#if canGroup}
            <li class="item" onclick={group}>Group</li>
        {/if}
        {#if isGroup}
            <li class="item" onclick={ungroup}>Ungroup</li>
        {/if}
        {#if canGroup || isGroup}
            <div class="sep"></div>
        {/if}

        {#if isSingle}
            <li class="item" onclick={toggleLock}>
                {isLocked ? 'Unlock' : 'Lock'}
            </li>
            <div class="sep"></div>
        {/if}

        <li class="item danger" onclick={del}>Delete</li>
    {:else}
        <div class="sep"></div>
        <li class="item" onclick={selectAll}>Select All</li>
    {/if}
</menu>

<style>
    .ctx-menu {
        position: fixed;
        z-index: 9999;
        min-width: 188px;
        padding: 4px 0;
        margin: 0;
        list-style: none;
        background: #1c1c2e;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35);
        font-size: 13px;
        color: #dde0f0;
        user-select: none;
        outline: none;
    }

    .item {
        display: block;
        padding: 6px 14px;
        cursor: pointer;
        border-radius: 4px;
        margin: 1px 4px;
        white-space: nowrap;
        transition: background 80ms;
    }

    .item:hover {
        background: #4f8ef7;
        color: #fff;
    }

    .item.danger:hover {
        background: #ef4444;
        color: #fff;
    }

    .sep {
        height: 1px;
        background: rgba(255,255,255,0.08);
        margin: 4px 8px;
    }
</style>
