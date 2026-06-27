<script>
    /**
     * DocumentRepeatersPanel - central UI for managing all repeaters on a sheet.
     *
     * Mirrors the Tables panel pattern:
     *   - Left pane: list of repeaters
     *   - Right pane: repeater settings via RepeaterEditPanel
     *   - Create action: launches the existing repeater create dialog
     */

    import { close, plus, repeat } from "../../../lib/icons/index.js";
    import { selectionState } from "../../../stores/spreadsheetStore.svelte.js";
    import RepeaterCreateDialog from "./RepeaterCreateDialog.svelte";
    import RepeaterEditPanel from "./RepeaterEditPanel.svelte";

    let {
        session,
        onClose,
        initialRepeaterId = null,
    } = $props();

    let engine = $derived(session?.repeaterEngine ?? null);
    let repeaters = $derived.by(() => {
        if (!engine) return [];
        void engine.repeaterVersion;
        return engine.storeList
            .map((repId) => engine.stores.get(repId))
            .filter(Boolean);
    });

    let selectedRepeaterId = $state(/** @type {string|null} */ (null));
    let _initialApplied = $state(false);
    let showCreateDialog = $state(false);

    $effect(() => {
        if (_initialApplied || repeaters.length === 0) return;
        _initialApplied = true;
        if (initialRepeaterId && repeaters.some((rep) => rep.id === initialRepeaterId)) {
            selectedRepeaterId = initialRepeaterId;
        } else {
            selectedRepeaterId = repeaters[0]?.id ?? null;
        }
    });

    $effect(() => {
        if (selectedRepeaterId && repeaters.some((rep) => rep.id === selectedRepeaterId)) {
            return;
        }
        selectedRepeaterId = repeaters[0]?.id ?? null;
    });

    let selectedRepeater = $derived.by(() => {
        if (!selectedRepeaterId) return null;
        return repeaters.find((rep) => rep.id === selectedRepeaterId) ?? null;
    });

    function openCreateDialog() {
        if (!engine || !selectionState.range) return;
        showCreateDialog = true;
    }

    function handleCreated(repId) {
        showCreateDialog = false;
        if (repId) selectedRepeaterId = repId;
    }

    function handleCreateClosed() {
        showCreateDialog = false;
    }

    function selectRepeater(repId) {
        selectedRepeaterId = repId;
    }
</script>

<div class="panel">
    <div class="panel-header">
        <span class="panel-title">
            <span class="panel-title-icon">{@html repeat}</span>
            Repeaters
            {#if repeaters.length > 0}
                <span class="count-badge">{repeaters.length}</span>
            {/if}
        </span>
        <div class="header-actions">
            <button
                class="create-btn"
                onclick={openCreateDialog}
                disabled={!engine || !selectionState.range}
                title="Create repeater from the current selection"
            >
                <span class="btn-icon">{@html plus}</span>
                Create
            </button>
            <button class="close-btn" onclick={() => onClose?.()} aria-label="Close repeaters panel">{@html close}</button>
        </div>
    </div>

    <div class="panel-body">
        <div class="list-pane">
            {#if repeaters.length > 0}
                {#each repeaters as rep (rep.id)}
                    <button
                        class="repeater-row"
                        class:selected={selectedRepeaterId === rep.id}
                        onclick={() => selectRepeater(rep.id)}
                    >
                        <div class="repeater-row-main">
                            <span class="repeater-name">{rep.name}</span>
                            <span class="repeater-meta">{rep.count} reps · {rep.direction}</span>
                        </div>
                        <span class="repeater-template">{rep.templateRows}×{rep.templateCols}</span>
                    </button>
                {/each}
            {:else}
                <div class="empty-state">
                    <div class="empty-state-title">No repeaters yet</div>
                    <div class="empty-state-copy">Select a range, then create a repeater from this panel.</div>
                </div>
            {/if}
        </div>

        <div class="detail-pane">
            {#if selectedRepeater}
                <RepeaterEditPanel
                    repeater={selectedRepeater}
                    repeaterEngine={engine}
                    onClose={() => (selectedRepeaterId = null)}
                />
            {:else}
                <div class="detail-empty">
                    <div class="detail-empty-title">Select a repeater</div>
                    <div class="detail-empty-copy">Settings for the selected repeater appear here.</div>
                </div>
            {/if}
        </div>
    </div>
</div>

{#if showCreateDialog}
    <RepeaterCreateDialog
        onClose={handleCreateClosed}
        onCreated={handleCreated}
    />
{/if}

<style>
    .panel {
        width: 560px;
        min-width: 560px;
        max-width: min(560px, 100vw);
        height: 100%;
        display: flex;
        flex-direction: column;
        background: var(--color-surface);
        border-right: 1px solid var(--color-border);
        box-shadow: 8px 0 24px rgba(15, 23, 42, 0.08);
        overflow: hidden;
    }

    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
    }

    .panel-title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text);
    }

    .panel-title-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        color: #7c3aed;
    }

    .count-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 700;
        color: #6b21a8;
        background: rgba(124, 58, 237, 0.12);
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .create-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border: 1px solid rgba(124, 58, 237, 0.28);
        border-radius: 999px;
        background: rgba(124, 58, 237, 0.08);
        color: #6b21a8;
        font-size: 0.8125rem;
        font-weight: 600;
        cursor: pointer;
    }

    .create-btn:hover:not(:disabled) {
        background: rgba(124, 58, 237, 0.14);
    }

    .create-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .btn-icon {
        width: 14px;
        height: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .close-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
    }

    .close-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .panel-body {
        display: grid;
        grid-template-columns: 180px minmax(0, 1fr);
        min-height: 0;
        flex: 1;
    }

    .list-pane {
        min-height: 0;
        overflow: auto;
        border-right: 1px solid var(--color-border);
        background: linear-gradient(180deg, rgba(124, 58, 237, 0.02), transparent 45%);
        padding: 8px;
    }

    .repeater-row {
        width: 100%;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 10px;
        border: 1px solid transparent;
        border-radius: 10px;
        background: transparent;
        cursor: pointer;
        text-align: left;
        color: var(--color-text);
    }

    .repeater-row:hover {
        background: rgba(124, 58, 237, 0.06);
    }

    .repeater-row.selected {
        background: rgba(124, 58, 237, 0.10);
        border-color: rgba(124, 58, 237, 0.20);
    }

    .repeater-row-main {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    .repeater-name {
        font-size: 0.84375rem;
        font-weight: 600;
        line-height: 1.2;
        word-break: break-word;
    }

    .repeater-meta,
    .repeater-template {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
    }

    .repeater-template {
        white-space: nowrap;
        flex-shrink: 0;
        padding-top: 1px;
    }

    .empty-state,
    .detail-empty {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 20px 16px;
        color: var(--color-text-secondary);
    }

    .empty-state-title,
    .detail-empty-title {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text);
    }

    .empty-state-copy,
    .detail-empty-copy {
        font-size: 0.8125rem;
        line-height: 1.45;
    }

    .detail-pane {
        min-width: 0;
        min-height: 0;
        overflow: auto;
        padding: 10px;
        background: var(--color-surface);
    }
</style>
