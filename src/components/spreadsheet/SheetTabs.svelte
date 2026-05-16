<script>
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import ConfirmModal from "../modals/ConfirmModal.svelte";
    import SelectionStats from "./SelectionStats.svelte";
    import BottomSheet from "../ui/BottomSheet.svelte";
    import ContextMenu from "../ui/ContextMenu.svelte";
    import { mobileState } from "../../stores/mobileState.svelte.js";
    import { edit as editIcon, trash as trashIcon } from "../../lib/icons/index.js";
    import { editSessionState } from "../../stores/spreadsheet/index.js";

    let {
        sheets = [],
        activeSheetId = null,
        onSheetChange,
        onAddSheet,
        onDeleteSheet,
        onRenameSheet,
        onMoveSheet,
    } = $props();

    let renamingSheetId = $state(null);
    let renameValue = $state("");
    let clickTimer = null;

    // ─── Drag-to-reorder ──────────────────────────────────────────────────────
    let draggedSheetId = $state(null);
    /** Insert position: 0..sheets.length (before tab i, or after the last) */
    let dropTargetIndex = $state(null);

    function handleDragStart(sheetId, e) {
        draggedSheetId = sheetId;
        e.dataTransfer.effectAllowed = "move";
    }

    /** Determine insert index based on whether cursor is in left or right half of the tab. */
    function insertIndexForEvent(tabIndex, e) {
        const rect = e.currentTarget.getBoundingClientRect();
        return e.clientX < rect.left + rect.width / 2 ? tabIndex : tabIndex + 1;
    }

    function handleDragOver(tabIndex, e) {
        if (!draggedSheetId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        dropTargetIndex = insertIndexForEvent(tabIndex, e);
    }

    function handleDrop(tabIndex, e) {
        e.preventDefault();
        if (draggedSheetId !== null) {
            onMoveSheet?.(draggedSheetId, insertIndexForEvent(tabIndex, e));
        }
        draggedSheetId = null;
        dropTargetIndex = null;
    }

    function handleDragEnd() {
        draggedSheetId = null;
        dropTargetIndex = null;
    }


    // ─── Context menu ──────────────────────────────────────────────────────────
    let contextMenu = $state(null); // { sheetId, x, y }

    function openContextMenu(sheetId, x, y) {
        contextMenu = { sheetId, x, y };
    }

    function closeContextMenu() {
        contextMenu = null;
    }

    function contextMenuItems(sheetId) {
        const items = /** @type {any[]} */ ([
            {
                label: "Rename",
                icon: editIcon,
                isSvgIcon: true,
                action: () => startRenaming(sheetId),
            },
        ]);
        if (sheets.length > 1) {
            items.push({ divider: true });
            items.push({
                label: "Delete",
                icon: trashIcon,
                isSvgIcon: true,
                action: () => handleDeleteClick(sheetId),
            });
        }
        return items;
    }

    // ─── Tab interactions ──────────────────────────────────────────────────────

    function handleAddSheet() {
        const name = `Sheet ${sheets.length + 1}`;
        onAddSheet(name);
    }

    function handleTabClick(sheetId) {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
            clickTimer = null;
            if (sheetId !== activeSheetId) {
                onSheetChange(sheetId);
            }
        }, 150);
    }

    function handleTabDoubleClick(sheetId) {
        clearTimeout(clickTimer);
        clickTimer = null;
        startRenaming(sheetId);
    }

    function handleTabContextMenu(sheetId, e) {
        e.preventDefault();
        openContextMenu(sheetId, e.clientX, e.clientY);
    }

    // ─── Rename ────────────────────────────────────────────────────────────────

    function startRenaming(sheetId) {
        const sheet = sheets.find((s) => s.id === sheetId);
        if (sheet) {
            renamingSheetId = sheetId;
            renameValue = sheet.name;
        }
    }

    function finishRenaming(sheetId) {
        const trimmed = renameValue.trim();
        if (trimmed && trimmed !== sheets.find((s) => s.id === sheetId)?.name) {
            onRenameSheet(sheetId, trimmed);
        }
        renamingSheetId = null;
        renameValue = "";
    }

    function cancelRenaming() {
        renamingSheetId = null;
        renameValue = "";
    }

    // ─── Delete ────────────────────────────────────────────────────────────────

    function handleDeleteClick(sheetId) {
        if (sheets.length <= 1) return;
        const sheet = sheets.find((s) => s.id === sheetId);
        if (sheet) {
            openModal(ConfirmModal, {
                title: "Delete sheet",
                message: `Delete "${sheet.name}"? This cannot be undone.`,
                variant: "danger",
                confirmText: "Delete",
                onConfirm: () => onDeleteSheet(sheetId),
            });
        }
    }

    // ─── Mobile long-press tab menu ────────────────────────────────────────────
    let tabLongPressTimer = null;
    let tabMenuSheetId = $state(null);

    function handleTabTouchStart(sheetId, e) {
        if (e.touches.length !== 1) return;
        tabLongPressTimer = setTimeout(() => {
            tabMenuSheetId = sheetId;
        }, 500);
    }

    function handleTabTouchMove() {
        clearTimeout(tabLongPressTimer);
    }

    function handleTabTouchEnd() {
        clearTimeout(tabLongPressTimer);
    }

    let tabMenuSheet = $derived(sheets.find((s) => s.id === tabMenuSheetId) ?? null);
</script>

<div class="sheet-tabs">
    <button class="add-sheet-btn" onclick={handleAddSheet} title="Add sheet">
        +
    </button>
    <div class="tabs-container" class:snap={mobileState.isMobile}>
        {#each sheets as sheet, i (sheet.id)}
            {#if dropTargetIndex === i}
                <div class="drop-indicator"></div>
            {/if}
            <button
                class="tab"
                class:active={sheet.id === activeSheetId}
                class:dragging={draggedSheetId === sheet.id}
                draggable={renamingSheetId !== sheet.id}
                onmousedown={() => {
                    // Switch surface to formulaBar before blur fires so handleEditBlur
                    // skips its commit guard — prevents formula edit from being committed
                    // when the user navigates to another sheet to pick a reference.
                    if (editSessionState.isFormulaMode) {
                        editSessionState.switchSurface("formulaBar", { focus: false });
                    }
                }}
                onclick={() => handleTabClick(sheet.id)}
                ondblclick={() => handleTabDoubleClick(sheet.id)}
                oncontextmenu={(e) => handleTabContextMenu(sheet.id, e)}
                ondragstart={(e) => handleDragStart(sheet.id, e)}
                ondragover={(e) => handleDragOver(i, e)}
                ondrop={(e) => handleDrop(i, e)}
                ondragend={handleDragEnd}
                ontouchstart={mobileState.isMobile ? (e) => handleTabTouchStart(sheet.id, e) : undefined}
                ontouchmove={mobileState.isMobile ? handleTabTouchMove : undefined}
                ontouchend={mobileState.isMobile ? handleTabTouchEnd : undefined}
            >
                {#if renamingSheetId === sheet.id}
                    <input
                        class="tab-rename-input"
                        type="text"
                        bind:value={renameValue}
                        onclick={(e) => e.stopPropagation()}
                        ondblclick={(e) => e.stopPropagation()}
                        onblur={() => finishRenaming(sheet.id)}
                        onkeydown={(e) => {
                            if (e.key === "Enter") finishRenaming(sheet.id);
                            else if (e.key === "Escape") cancelRenaming();
                        }}
                        autofocus
                    />
                {:else}
                    <span class="tab-name">{sheet.name}</span>
                {/if}
            </button>
        {/each}
        {#if dropTargetIndex === sheets.length}
            <div class="drop-indicator"></div>
        {/if}
    </div>
    {#if !mobileState.isMobile}
        <SelectionStats />
    {/if}
</div>

<!-- Desktop: right-click context menu -->
{#if contextMenu}
    <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        items={contextMenuItems(contextMenu.sheetId)}
        onClose={closeContextMenu}
    />
{/if}

<!-- Mobile: tab action sheet (long-press on tab) -->
<BottomSheet
    open={tabMenuSheetId !== null}
    onClose={() => (tabMenuSheetId = null)}
    title={tabMenuSheet?.name ?? "Sheet"}
    maxHeight="40vh"
>
    <div class="tab-action-sheet">
        <button class="tab-action-item" onclick={() => {
            if (tabMenuSheetId) startRenaming(tabMenuSheetId);
            tabMenuSheetId = null;
        }}>
            <span class="tab-action-icon">{@html editIcon}</span>
            Rename
        </button>
        {#if sheets.length > 1}
            <button class="tab-action-item danger" onclick={() => {
                const id = tabMenuSheetId;
                tabMenuSheetId = null;
                if (id) handleDeleteClick(id);
            }}>
                <span class="tab-action-icon">{@html trashIcon}</span>
                Delete
            </button>
        {/if}
    </div>
</BottomSheet>

<style>
    .sheet-tabs {
        display: flex;
        align-items: center;
        padding: 0.25rem 0.5rem;
        background: var(--tabs-bg, #f8fafc);
        border-top: 1px solid var(--border-color, #e2e8f0);
        min-height: 36px;
    }

    .tabs-container {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 1;
        overflow-x: auto;
    }

    .tab {
        display: flex;
        align-items: center;
        padding: 0 0.875rem;
        height: 30px;
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        cursor: pointer;
        font-size: 0.875rem;
        color: var(--text-secondary, #475569);
        white-space: nowrap;
        transition: color 0.15s, background 0.15s, border-color 0.15s;
        box-sizing: border-box;
        flex-shrink: 0;
    }

    .tab:hover {
        background: var(--hover-bg, #e2e8f0);
    }

    .tab.dragging {
        opacity: 0.4;
    }

    .drop-indicator {
        width: 2px;
        height: 20px;
        background: var(--active-color, #3b82f6);
        border-radius: 1px;
        flex-shrink: 0;
        pointer-events: none;
    }

    .tab.active {
        color: var(--text-color, #1e293b);
        font-weight: 500;
        border-bottom-color: var(--active-color, #3b82f6);
        background: var(--active-bg, #ffffff);
    }

    .tab-name {
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .tab-rename-input {
        /* Grow/shrink to fit content */
        field-sizing: content;
        min-width: 40px;
        max-width: 200px;
        height: 22px;
        padding: 0 4px;
        border: 1px solid var(--active-color, #3b82f6);
        border-radius: 3px;
        font-size: 0.875rem;
        font-family: inherit;
        font-weight: inherit;
        background: white;
        color: var(--text-color, #1e293b);
        box-sizing: border-box;
    }

    .tab-rename-input:focus {
        outline: none;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }

    .add-sheet-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        margin-left: 0.25rem;
        background: transparent;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 4px;
        cursor: pointer;
        font-size: 1.125rem;
        color: var(--text-muted, #64748b);
    }

    .add-sheet-btn:hover {
        background: var(--hover-bg, #e2e8f0);
        color: var(--text-color, #1e293b);
    }

    /* Scroll-snap for mobile tabs */
    .tabs-container.snap {
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
    }

    .tabs-container.snap .tab {
        scroll-snap-align: start;
    }

    /* Tab action sheet content */
    .tab-action-sheet {
        padding: 8px 0 env(safe-area-inset-bottom, 16px);
    }

    .tab-action-item {
        display: flex;
        align-items: center;
        width: 100%;
        padding: 14px 16px;
        background: transparent;
        border: none;
        font-size: 0.9375rem;
        color: var(--color-text, #1e293b);
        cursor: pointer;
        text-align: left;
        min-height: 48px;
        gap: 10px;
        -webkit-tap-highlight-color: transparent;
    }

    .tab-action-item:active {
        background: var(--color-fill, #f1f5f9);
    }

    .tab-action-item.danger {
        color: var(--color-danger, #dc2626);
    }

    .tab-action-icon {
        display: flex;
        align-items: center;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        opacity: 0.7;
    }

    .tab-action-icon :global(svg) {
        width: 18px;
        height: 18px;
    }

    /* ── Mobile: bigger touch targets ── */
    @media (max-width: 600px) {
        .sheet-tabs {
            min-height: 44px;
        }
        .tab {
            padding: 0 1rem;
            height: 36px;
            font-size: 0.875rem;
        }
        .add-sheet-btn {
            width: 36px;
            height: 36px;
        }
    }
</style>
