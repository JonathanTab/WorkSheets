<script>
    import { onDestroy } from "svelte";
    import { openModal } from "../../lib/ui/modalStore.svelte.js";
    import ConfirmModal from "../modals/ConfirmModal.svelte";
    import SelectionStats from "./SelectionStats.svelte";
    import BottomSheet from "../ui/BottomSheet.svelte";
    import ContextMenu from "../ui/ContextMenu.svelte";
    import { mobileState } from "../../stores/mobileState.svelte.js";
    import { edit as editIcon, trash as trashIcon, copy as copyIcon } from "../../lib/icons/index.js";
    import { editSessionState } from "../../stores/spreadsheet/index.js";

    let {
        sheets = [],
        activeSheetId = null,
        onSheetChange,
        onAddSheet,
        onDeleteSheet,
        onRenameSheet,
        onMoveSheet,
        onDuplicateSheet,
    } = $props();

    let renamingSheetId = $state(null);
    let renameValue = $state("");
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
            {
                label: "Duplicate",
                icon: copyIcon,
                isSvgIcon: true,
                action: () => onDuplicateSheet?.(sheetId),
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

    /**
     * Switch surface before blur fires so handleEditBlur skips its commit guard —
     * prevents a formula edit from being committed when the user navigates to
     * another sheet to pick a reference.
     */
    function releaseFormulaSurface() {
        if (editSessionState.isFormulaMode) {
            editSessionState.switchSurface("formulaBar", { focus: false });
        }
    }

    function handleTabClick(sheetId) {
        if (sheetId !== activeSheetId) {
            onSheetChange(sheetId);
        }
    }

    /** Click path — skipped when touchend already handled this tap. */
    function handleTabClickEvent(sheetId) {
        if (tabTouchHandled) return;
        handleTabClick(sheetId);
    }

    function handleTabDoubleClick(sheetId) {
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
        if (renamingSheetId !== sheetId) return;
        const trimmed = renameValue.trim();
        if (trimmed && trimmed !== sheets.find((s) => s.id === sheetId)?.name) {
            onRenameSheet(sheetId, trimmed);
        }
        renamingSheetId = null;
        renameValue = "";
    }

    // Commit rename when clicking outside the input (e.g. on the canvas which is non-focusable,
    // so blur never fires).
    $effect(() => {
        if (renamingSheetId === null) return;
        const id = renamingSheetId;
        /** @param {MouseEvent} e */
        function onMousedown(e) {
            const input = document.querySelector(".tab-rename-input");
            if (input && !input.contains(/** @type {Node} */ (e.target))) {
                finishRenaming(id);
            }
        }
        window.addEventListener("mousedown", onMousedown, true);
        return () => window.removeEventListener("mousedown", onMousedown, true);
    });

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

    // ─── Mobile tab tap / long-press ───────────────────────────────────────────
    // Taps are resolved from the touch events rather than from the synthesized
    // click. The tab strip is a horizontal scroller (touch-action: pan-x), and a
    // tap that drifts a pixel — or one that lands while the soft keyboard is
    // dismissing and the strip reflows under the finger — gets reinterpreted as
    // a pan, so the click never arrives and the switch appears to need a second
    // tap. touchend always fires, so drive the switch from there and suppress the
    // synthetic click that may follow (re-activating the current sheet is not a
    // no-op in the session — it tears down and rebuilds the sheet store).
    const TAB_TAP_MOVE_PX = 10;
    const TAB_LONG_PRESS_MS = 500;
    const SYNTHETIC_CLICK_WINDOW_MS = 600;

    let tabLongPressTimer = null;
    let tabMenuSheetId = $state(null);
    let tabTouchStart = null; // { x, y } — null once the tap is disqualified
    let tabLongPressFired = false;
    let tabTouchHandled = false; // suppresses the synthetic click after a touch tap
    let tabTouchHandledTimer = null;

    function handleTabTouchStart(sheetId, e) {
        if (e.touches.length !== 1) {
            clearTimeout(tabLongPressTimer);
            tabTouchStart = null;
            return;
        }
        tabTouchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        tabLongPressFired = false;
        tabLongPressTimer = setTimeout(() => {
            tabLongPressFired = true;
            tabTouchStart = null;
            tabMenuSheetId = sheetId;
        }, TAB_LONG_PRESS_MS);
    }

    function handleTabTouchMove(e) {
        if (!tabTouchStart || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - tabTouchStart.x;
        const dy = e.touches[0].clientY - tabTouchStart.y;
        if (Math.sqrt(dx * dx + dy * dy) > TAB_TAP_MOVE_PX) {
            // Scrolling the strip, not tapping a tab.
            clearTimeout(tabLongPressTimer);
            tabTouchStart = null;
        }
    }

    function handleTabTouchEnd(sheetId) {
        clearTimeout(tabLongPressTimer);
        if (tabLongPressFired || !tabTouchStart) {
            tabTouchStart = null;
            return;
        }
        tabTouchStart = null;
        if (renamingSheetId === sheetId) return; // let the input handle its own taps

        tabTouchHandled = true;
        clearTimeout(tabTouchHandledTimer);
        tabTouchHandledTimer = setTimeout(() => {
            tabTouchHandled = false;
        }, SYNTHETIC_CLICK_WINDOW_MS);

        releaseFormulaSurface();
        handleTabClick(sheetId);
    }

    function handleTabTouchCancel() {
        clearTimeout(tabLongPressTimer);
        tabTouchStart = null;
    }

    let tabMenuSheet = $derived(sheets.find((s) => s.id === tabMenuSheetId) ?? null);

    onDestroy(() => {
        clearTimeout(tabLongPressTimer);
        clearTimeout(tabTouchHandledTimer);
    });
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
                draggable={!mobileState.isMobile && renamingSheetId !== sheet.id}
                onmousedown={releaseFormulaSurface}
                onclick={() => handleTabClickEvent(sheet.id)}
                ondblclick={() => handleTabDoubleClick(sheet.id)}
                oncontextmenu={(e) => handleTabContextMenu(sheet.id, e)}
                ondragstart={(e) => handleDragStart(sheet.id, e)}
                ondragover={(e) => handleDragOver(i, e)}
                ondrop={(e) => handleDrop(i, e)}
                ondragend={handleDragEnd}
                ontouchstart={mobileState.isMobile ? (e) => handleTabTouchStart(sheet.id, e) : undefined}
                ontouchmove={mobileState.isMobile ? handleTabTouchMove : undefined}
                ontouchend={mobileState.isMobile ? () => handleTabTouchEnd(sheet.id) : undefined}
                ontouchcancel={mobileState.isMobile ? handleTabTouchCancel : undefined}
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
        <button class="tab-action-item" onclick={() => {
            const id = tabMenuSheetId;
            tabMenuSheetId = null;
            if (id) onDuplicateSheet?.(id);
        }}>
            <span class="tab-action-icon">{@html copyIcon}</span>
            Duplicate
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
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
    }

    /* Hover must not apply on touch: it sticks after a tap, so the previously
       tapped tab keeps a highlight and reads as still-selected next to the tab
       that actually is. Same reason .add-sheet-btn:hover is gated below. */
    @media (hover: hover) {
        .tab:hover {
            background: var(--hover-bg, #e2e8f0);
        }
    }

    .tab:active {
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
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
    }

    @media (hover: hover) {
        .add-sheet-btn:hover {
            background: var(--hover-bg, #e2e8f0);
            color: var(--text-color, #1e293b);
        }
    }

    .add-sheet-btn:active {
        background: var(--hover-bg, #e2e8f0);
        color: var(--text-color, #1e293b);
    }

    /* Smooth momentum scrolling for mobile tabs.
       NOTE: do NOT use `scroll-snap-type: x mandatory` here — mandatory snap makes
       mobile browsers interpret taps on the strip as pan/snap gestures, which
       swallows the tap and makes tabs feel unresponsive. `proximity` snaps only
       when the user actually scrolls, leaving taps intact. */
    .tabs-container.snap {
        scroll-snap-type: x proximity;
        -webkit-overflow-scrolling: touch;
        /* Let the browser handle horizontal pans but pass taps straight through. */
        touch-action: pan-x;
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
