<script>
    /**
     * SvgMenuBar — row 1 of the SVG editor toolbar.
     * Structure mirrors DocToolbar row 1.
     */
    import MenuDropdown from '../spreadsheet/toolbar/MenuDropdown.svelte';
    import { svgEditorState } from '../../stores/svg/svgEditorState.svelte.js';
    import { svgSession } from '../../stores/svg/svgStore.svelte.js';
    import { arrowRight, penTool } from '../../lib/icons/index.js';

    let {
        isSaving  = false,
        onClose   = () => {},
        onSave    = () => {},
        onToggleDocProps = () => {},
    } = $props();

    // ── Editable title ────────────────────────────────────────────────────────
    let isEditingTitle = $state(false);
    let titleDraft     = $state('');
    let titleInput     = $state(null);

    function startTitleEdit() {
        titleDraft = svgSession.title ?? 'Untitled Drawing';
        isEditingTitle = true;
        setTimeout(() => titleInput?.select(), 0);
    }

    function commitTitle() {
        const t = titleDraft.trim();
        if (t && t !== svgSession.title) svgSession.title = t;
        isEditingTitle = false;
    }

    function titleKeydown(e) {
        if (e.key === 'Enter')  { e.preventDefault(); commitTitle(); }
        if (e.key === 'Escape') isEditingTitle = false;
    }

    // ── Zoom display ──────────────────────────────────────────────────────────
    const zoomLabel = $derived(Math.round(svgEditorState.zoom * 100) + '%');

    function cycleZoom() {
        const steps = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
        const cur = svgEditorState.zoom;
        const next = steps.find(z => z > cur + 0.01) ?? steps[0];
        svgEditorState.zoom = next;
        svgEditorState.panX = svgEditorState.panX; // trigger update
    }

    // ── Menu shared state ─────────────────────────────────────────────────────
    let openMenuId = $state(null);
    function handleMenuOpenChange(isOpen, menuId) {
        openMenuId = isOpen ? menuId : (openMenuId === menuId ? null : openMenuId);
    }

    // ── File menu ─────────────────────────────────────────────────────────────
    const fileItems = $derived([
        { label: 'Save',        action: onSave,       shortcut: 'Ctrl+S' },
        { divider: true },
        { label: 'Close',       action: onClose,      shortcut: 'Ctrl+W' },
    ]);

    // ── Edit menu ─────────────────────────────────────────────────────────────
    const editItems = $derived([
        { label: 'Undo',       action: () => svgEditorState.undo(),            shortcut: 'Ctrl+Z' },
        { label: 'Redo',       action: () => svgEditorState.redo(),            shortcut: 'Ctrl+Y' },
        { divider: true },
        { label: 'Cut',        action: () => { svgEditorState.cutSelected(); },   shortcut: 'Ctrl+X' },
        { label: 'Copy',       action: () => svgEditorState.copySelected(),    shortcut: 'Ctrl+C' },
        { label: 'Paste',      action: () => svgEditorState.pasteClipboard(),  shortcut: 'Ctrl+V' },
        { label: 'Delete',     action: () => svgEditorState.deleteSelected(),  shortcut: 'Del' },
        { divider: true },
        { label: 'Select All', action: () => svgEditorState.selectAll(),       shortcut: 'Ctrl+A' },
    ]);

    // ── View menu ─────────────────────────────────────────────────────────────
    const viewItems = $derived([
        { label: 'Zoom In',           action: () => svgEditorState.setZoom(svgEditorState.zoom * 1.25, 0, 0), shortcut: 'Ctrl+=' },
        { label: 'Zoom Out',          action: () => svgEditorState.setZoom(svgEditorState.zoom / 1.25, 0, 0), shortcut: 'Ctrl+-' },
        { label: 'Fit to Screen',     action: fitToScreen,  shortcut: 'Ctrl+0' },
        { divider: true },
        {
            label: svgEditorState.clipToArtboard ? '✓ Clip to Artboard' : 'Clip to Artboard',
            action: () => { svgEditorState.clipToArtboard = !svgEditorState.clipToArtboard; },
        },
        {
            label: svgEditorState.showGrid ? '✓ Show Grid' : 'Show Grid',
            action: () => { svgEditorState.showGrid = !svgEditorState.showGrid; },
        },
        {
            label: svgEditorState.showGuides ? '✓ Show Guides' : 'Show Guides',
            action: () => { svgEditorState.showGuides = !svgEditorState.showGuides; },
        },
        { divider: true },
        { label: `Document units: ${svgEditorState.docUnits}`, disabled: true },
    ]);

    // ── Object menu ───────────────────────────────────────────────────────────
    const objectItems = $derived.by(() => {
        const sel = svgEditorState.firstSelected;
        const hasOne = !!sel;
        const selCount = svgEditorState.selectedIds.size;
        const isGroup = sel?.type === 'group';
        return [
            { label: 'Group',          action: () => svgEditorState.groupSelected(),   disabled: selCount < 2, shortcut: 'Ctrl+G' },
            { label: 'Ungroup',        action: () => svgEditorState.ungroupSelected(), disabled: !isGroup,     shortcut: 'Ctrl+Shift+G' },
            { divider: true },
            { label: 'Bring to Front', action: () => sel && svgEditorState.bringToFront(sel.id), disabled: !hasOne, shortcut: 'Ctrl+Shift+]' },
            { label: 'Bring Forward',  action: () => sel && svgEditorState.bringForward(sel.id),  disabled: !hasOne, shortcut: 'Ctrl+]' },
            { label: 'Send Backward',  action: () => sel && svgEditorState.sendBackward(sel.id),  disabled: !hasOne, shortcut: 'Ctrl+[' },
            { label: 'Send to Back',   action: () => sel && svgEditorState.sendToBack(sel.id),    disabled: !hasOne, shortcut: 'Ctrl+Shift+[' },
            { divider: true },
            {
                label: sel?.locked ? 'Unlock' : 'Lock',
                action: () => sel && svgEditorState.setLocked(sel.id, !sel.locked),
                disabled: !hasOne,
            },
            {
                label: sel?.visible === false ? 'Show' : 'Hide',
                action: () => sel && svgEditorState.setVisible(sel.id, sel.visible === false),
                disabled: !hasOne,
            },
            { divider: true },
            { label: 'Document Properties…', action: onToggleDocProps },
        ];
    });

    function fitToScreen() {
        const el = document.querySelector('.canvas-area');
        if (el) svgEditorState.fitToView(el.clientWidth, el.clientHeight);
    }
</script>

<div class="menubar" class:menu-active={openMenuId !== null}>
    <!-- Left: back, icon, title, menus -->
    <div class="left">
        <button class="back-btn" onclick={onClose} title="Back to drive">
            <span class="back-icon">{@html arrowRight}</span>
        </button>

        <div class="app-icon">{@html penTool}</div>

        {#if isEditingTitle}
            <input
                bind:this={titleInput}
                class="title-input"
                type="text"
                bind:value={titleDraft}
                onblur={commitTitle}
                onkeydown={titleKeydown}
            />
        {:else}
            <button class="title-btn" onclick={startTitleEdit} title="Rename">
                {svgSession.title ?? 'Untitled Drawing'}
            </button>
        {/if}

        {#if svgSession.isDirty}
            <span class="dirty-dot" title="Unsaved changes"></span>
        {/if}

        <!-- Menus -->
        <MenuDropdown label="File"   items={fileItems}   menuId="file"   isOpen={openMenuId==='file'}   anyMenuOpen={openMenuId!==null} onOpenChange={handleMenuOpenChange} />
        <MenuDropdown label="Edit"   items={editItems}   menuId="edit"   isOpen={openMenuId==='edit'}   anyMenuOpen={openMenuId!==null} onOpenChange={handleMenuOpenChange} />
        <MenuDropdown label="View"   items={viewItems}   menuId="view"   isOpen={openMenuId==='view'}   anyMenuOpen={openMenuId!==null} onOpenChange={handleMenuOpenChange} />
        <MenuDropdown label="Object" items={objectItems} menuId="object" isOpen={openMenuId==='object'} anyMenuOpen={openMenuId!==null} onOpenChange={handleMenuOpenChange} />
    </div>

    <!-- Right: zoom, save -->
    <div class="right">
        <button class="zoom-btn" onclick={cycleZoom} title="Click to cycle zoom">{zoomLabel}</button>
        <button
            class="save-btn"
            onclick={onSave}
            disabled={isSaving || !svgSession.isDirty}
            title="Save (Ctrl+S)"
        >
            {isSaving ? 'Saving…' : 'Save'}
        </button>
    </div>
</div>

<style>
    .menubar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 36px;
        padding: 0 8px;
        background: var(--color-bg-secondary, #111122);
        border-bottom: 1px solid var(--color-border, #2a2a4a);
        flex-shrink: 0;
        gap: 8px;
        user-select: none;
    }

    .left {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        flex: 1;
    }

    .right {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
    }

    .back-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        color: var(--color-text-secondary, #888);
        cursor: pointer;
        border-radius: 4px;
        flex-shrink: 0;
    }
    .back-btn:hover { background: var(--color-fill, rgba(255,255,255,0.07)); color: var(--color-text, #fff); }
    .back-icon { display: flex; transform: rotate(180deg); }
    .back-icon :global(svg) { width: 16px; height: 16px; }

    .app-icon {
        display: flex;
        align-items: center;
        color: #f97316;
        flex-shrink: 0;
    }
    .app-icon :global(svg) { width: 16px; height: 16px; }

    .title-btn {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        padding: 3px 7px;
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text, #e0e0e0);
        cursor: text;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .title-btn:hover { background: var(--color-fill, rgba(255,255,255,0.07)); border-color: var(--color-border, #333); }

    .title-input {
        height: 26px;
        padding: 0 7px;
        font-size: 13px;
        font-weight: 600;
        background: var(--color-surface, #1a1a2e);
        border: 1px solid var(--color-primary, #4f46e5);
        border-radius: 4px;
        color: var(--color-text, #e0e0e0);
        outline: none;
        max-width: 200px;
        box-shadow: 0 0 0 2px rgba(79,70,229,0.25);
    }

    .dirty-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--color-primary, #4f46e5);
        flex-shrink: 0;
    }

    .zoom-btn {
        height: 24px;
        min-width: 46px;
        padding: 0 8px;
        font-size: 12px;
        background: var(--color-fill, rgba(255,255,255,0.07));
        border: 1px solid var(--color-border, #333);
        border-radius: 4px;
        color: var(--color-text-secondary, #aaa);
        cursor: pointer;
        white-space: nowrap;
    }
    .zoom-btn:hover { color: var(--color-text, #fff); }

    .save-btn {
        height: 28px;
        padding: 0 14px;
        font-size: 12px;
        font-weight: 500;
        background: var(--color-primary, #4f46e5);
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        transition: opacity 0.15s;
    }
    .save-btn:hover:not(:disabled) { opacity: 0.85; }
    .save-btn:disabled { opacity: 0.4; cursor: default; }

    /* Cursor-following menu hover */
    .menu-active :global(.menu-button:hover:not(.active)) {
        background: var(--color-fill, rgba(255,255,255,0.07));
    }
</style>
