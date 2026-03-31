<script>
    import { openModal, closeModal } from "../../lib/ui/modalStore.svelte.js";
    import DeleteSheetModal from "../modals/DeleteSheetModal.svelte";
    import SelectionStats from "./SelectionStats.svelte";

    let {
        sheets = [],
        activeSheetId = null,
        onSheetChange,
        onAddSheet,
        onDeleteSheet,
        onRenameSheet,
    } = $props();

    let renamingSheetId = $state(null);
    let renameValue = $state("");

    function handleAddSheet() {
        const name = `Sheet ${sheets.length + 1}`;
        onAddSheet(name);
    }

    function handleTabClick(sheetId) {
        if (sheetId !== activeSheetId) {
            onSheetChange(sheetId);
        }
    }

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

    function handleTabDoubleClick(sheetId) {
        startRenaming(sheetId);
    }

    function handleDeleteClick(sheetId) {
        if (sheets.length <= 1) return; // Can't delete last sheet
        const sheet = sheets.find((s) => s.id === sheetId);
        if (sheet) {
            openModal(DeleteSheetModal, {
                sheetName: sheet.name,
                onConfirm: () => {
                    onDeleteSheet(sheetId);
                    closeModal();
                },
            });
        }
    }
</script>

<div class="sheet-tabs">
    <div class="tabs-container">
        {#each sheets as sheet (sheet.id)}
            <button
                class="tab"
                class:active={sheet.id === activeSheetId}
                onclick={() => handleTabClick(sheet.id)}
                ondblclick={() => handleTabDoubleClick(sheet.id)}
            >
                {#if renamingSheetId === sheet.id}
                    <input
                        class="tab-rename-input"
                        type="text"
                        bind:value={renameValue}
                        onclick={(e) => e.stopPropagation()}
                        onblur={() => finishRenaming(sheet.id)}
                        onkeydown={(e) => {
                            if (e.key === "Enter") {
                                finishRenaming(sheet.id);
                            } else if (e.key === "Escape") {
                                cancelRenaming();
                            }
                        }}
                        autofocus
                    />
                {:else}
                    <span class="tab-name">{sheet.name}</span>
                    {#if sheets.length > 1}
                        <button
                            class="tab-delete"
                            onclick={(e) => {
                                e.stopPropagation();
                                handleDeleteClick(sheet.id);
                            }}
                            title="Delete sheet"
                        >
                            ×
                        </button>
                    {/if}
                {/if}
            </button>
        {/each}
    </div>
    <button class="add-sheet-btn" onclick={handleAddSheet} title="Add sheet">
        +
    </button>
    <SelectionStats />
</div>

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
        gap: 0.25rem;
        padding: 0 0.75rem;
        height: 28px;
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        cursor: pointer;
        font-size: 0.8125rem;
        color: var(--text-muted, #64748b);
        white-space: nowrap;
        transition: all 0.15s;
        box-sizing: border-box;
    }

    .tab:hover {
        background: var(--hover-bg, #e2e8f0);
    }

    .tab.active {
        color: var(--text-color, #1e293b);
        border-bottom-color: var(--active-color, #3b82f6);
        background: var(--active-bg, #ffffff);
    }

    .tab-name {
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .tab-rename-input {
        width: 100px;
        min-width: 60px;
        height: 20px;
        padding: 0 4px;
        border: 1px solid var(--active-color, #3b82f6);
        border-radius: 3px;
        font-size: 0.8125rem;
        background: white;
        color: var(--text-color, #1e293b);
        font-family: inherit;
        box-sizing: border-box;
    }

    .tab-rename-input:focus {
        outline: none;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }

    .tab-delete {
        display: none;
        width: 16px;
        height: 16px;
        border: none;
        background: transparent;
        color: var(--text-muted, #64748b);
        cursor: pointer;
        font-size: 1rem;
        line-height: 1;
        border-radius: 4px;
    }

    .tab:hover .tab-delete {
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .tab-delete:hover {
        background: var(--danger-bg, #fee2e2);
        color: var(--danger-color, #ef4444);
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

    /* ── Mobile: bigger touch targets ── */
    @media (pointer: coarse), (max-width: 768px) {
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
        /* Show delete button always on touch (no hover) */
        .tab .tab-delete {
            display: flex;
            align-items: center;
            justify-content: center;
        }
    }
</style>
