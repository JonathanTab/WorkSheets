<script>
    /**
     * RepeaterEditPanel - Floating panel for configuring a repeater.
     *
     * Features:
     *   - Editable repeater name
     *   - Repetition count stepper
     *   - Gap rows stepper
     *   - Direction toggle
     *   - Template size info
     *   - Delete button
     */

    let {
        /** @type {import('../../../stores/spreadsheet/features/RepeaterEngine.svelte.js').RepeaterStore} */
        repeater,
        /** @type {import('../../../stores/spreadsheet/features/RepeaterEngine.svelte.js').RepeaterEngine} */
        repeaterEngine,
        onClose,
    } = $props();

    let count = $derived(repeater?.count ?? 1);
    let gap = $derived(repeater?.gap ?? 0);
    let direction = $derived(repeater?.direction ?? "vertical");
    let name = $derived(repeater?.name ?? "Repeater");

    let localCount = $state(1);
    let localGap = $state(0);

    // Sync local from repeater when panel opens
    $effect(() => {
        if (repeater) {
            localCount = repeater.count;
            localGap = repeater.gap;
        }
    });

    // Name editing
    let editingName = $state(false);
    let editingNameValue = $state("");

    function startNameEdit() {
        editingNameValue = name;
        editingName = true;
    }

    function commitNameEdit() {
        const n = editingNameValue.trim();
        if (n && repeater) repeater.setName(n);
        editingName = false;
    }

    function cancelNameEdit() {
        editingName = false;
    }

    function applyCount() {
        const n = parseInt(String(localCount), 10);
        if (!isNaN(n) && n >= 1 && n <= 500) {
            repeater?.setCount(n);
        }
    }

    function applyGap() {
        const n = parseInt(String(localGap), 10);
        if (!isNaN(n) && n >= 0 && n <= 100) {
            repeater?.setGap(n);
        }
    }

    function handleDelete() {
        if (repeaterEngine && repeater) {
            repeaterEngine.deleteRepeater(repeater.id);
        }
        onClose?.();
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            if (editingName) cancelNameEdit();
            else onClose?.();
        }
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="rep-edit-panel"
    onkeydown={handleKeydown}
    role="dialog"
    aria-label="Repeater settings"
>
    <!-- Accent top bar -->
    <div class="accent-top"></div>

    <!-- Header -->
    <div class="panel-header">
        <span class="panel-icon">↻</span>
        {#if editingName}
            <input
                class="name-edit-input"
                type="text"
                bind:value={editingNameValue}
                onblur={commitNameEdit}
                onkeydown={(e) => {
                    if (e.key === "Enter") { e.stopPropagation(); commitNameEdit(); }
                    else if (e.key === "Escape") { e.stopPropagation(); cancelNameEdit(); }
                }}
                autofocus
            />
        {:else}
            <button class="name-btn" onclick={startNameEdit} title="Click to rename">
                {name}
            </button>
        {/if}
        <button class="close-btn" onclick={() => onClose?.()} aria-label="Close">✕</button>
    </div>

    <div class="panel-body">
        <!-- Repetition count -->
        <div class="field-row">
            <label class="field-label" for="rep-count">Repetitions</label>
            <div class="field-controls">
                <button
                    class="step-btn"
                    onclick={() => { localCount = Math.max(1, localCount - 1); applyCount(); }}
                    disabled={localCount <= 1}
                    aria-label="Decrease">−</button
                >
                <input
                    id="rep-count"
                    type="number"
                    class="number-input"
                    min="1"
                    max="500"
                    bind:value={localCount}
                    onchange={applyCount}
                    onblur={applyCount}
                />
                <button
                    class="step-btn"
                    onclick={() => { localCount = Math.min(500, localCount + 1); applyCount(); }}
                    disabled={localCount >= 500}
                    aria-label="Increase">+</button
                >
            </div>
        </div>

        <!-- Gap -->
        <div class="field-row">
            <label class="field-label" for="rep-gap">Gap rows</label>
            <div class="field-controls">
                <button
                    class="step-btn"
                    onclick={() => { localGap = Math.max(0, localGap - 1); applyGap(); }}
                    disabled={localGap <= 0}
                    aria-label="Decrease">−</button
                >
                <input
                    id="rep-gap"
                    type="number"
                    class="number-input"
                    min="0"
                    max="100"
                    bind:value={localGap}
                    onchange={applyGap}
                    onblur={applyGap}
                />
                <button
                    class="step-btn"
                    onclick={() => { localGap = Math.min(100, localGap + 1); applyGap(); }}
                    aria-label="Increase">+</button
                >
            </div>
        </div>

        <!-- Direction -->
        <div class="field-row">
            <span class="field-label">Direction</span>
            <div class="direction-toggle">
                <button
                    class="dir-btn"
                    class:active={direction === "vertical"}
                    onclick={() => repeater?.setDirection("vertical")}
                    title="Vertical (stacked)">↕ Vertical</button
                >
                <button
                    class="dir-btn"
                    class:active={direction === "horizontal"}
                    onclick={() => repeater?.setDirection("horizontal")}
                    title="Horizontal (side by side)">↔ Horiz.</button
                >
            </div>
        </div>

        <!-- Template info -->
        <div class="field-row info-row">
            <span class="field-label">Template</span>
            <span class="field-value muted">
                {repeater
                    ? `${repeater.templateRows}r × ${repeater.templateCols}c`
                    : ""}
            </span>
        </div>

        <div class="template-hint">
            Only the template (first copy) is editable. Other copies are read-only projections.
        </div>
    </div>

    <div class="panel-footer">
        <button class="delete-btn" onclick={handleDelete}>
            🗑 Delete Repeater
        </button>
    </div>
</div>

<style>
    .rep-edit-panel {
        background: var(--cell-bg, #fff);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.14);
        width: 240px;
        font-size: 12px;
        color: var(--text-color, #1e293b);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .accent-top {
        height: 3px;
        background: #7c3aed;
        flex-shrink: 0;
    }

    .panel-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px 6px;
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        background: var(--header-bg, #f8fafc);
        flex-shrink: 0;
    }

    .panel-icon {
        font-size: 14px;
        color: #7c3aed;
        flex-shrink: 0;
    }

    .name-btn {
        flex: 1;
        background: none;
        border: none;
        font-weight: 600;
        font-size: 12px;
        color: var(--text-color, #1e293b);
        cursor: pointer;
        text-align: left;
        padding: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-bottom: 1px dashed transparent;
        min-width: 0;
    }

    .name-btn:hover {
        border-bottom-color: #c4b5fd;
        color: #7c3aed;
    }

    .name-edit-input {
        flex: 1;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid #7c3aed;
        border-radius: 3px;
        padding: 1px 5px;
        outline: none;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
        min-width: 0;
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: #94a3b8;
        font-size: 12px;
        padding: 0 2px;
        line-height: 1;
        border-radius: 3px;
        display: flex;
        align-items: center;
        flex-shrink: 0;
    }
    .close-btn:hover {
        color: #475569;
        background: #e2e8f0;
    }

    .panel-body {
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .field-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .info-row {
        margin-top: 2px;
    }

    .field-label {
        font-size: 11px;
        color: #64748b;
        flex-shrink: 0;
        min-width: 70px;
    }

    .field-value {
        font-size: 11px;
    }

    .muted {
        color: #94a3b8;
    }

    .field-controls {
        display: flex;
        align-items: center;
        gap: 3px;
    }

    .step-btn {
        background: var(--header-bg, #f1f5f9);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 4px;
        width: 22px;
        height: 22px;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #475569;
        padding: 0;
        line-height: 1;
    }
    .step-btn:hover:not(:disabled) {
        background: #e2e8f0;
    }
    .step-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .number-input {
        width: 44px;
        height: 22px;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 4px;
        text-align: center;
        font-size: 12px;
        padding: 0 2px;
        background: var(--cell-bg, #fff);
        color: var(--text-color, #1e293b);
    }
    .number-input:focus {
        outline: 2px solid #7c3aed;
        outline-offset: -1px;
    }

    .direction-toggle {
        display: flex;
        gap: 3px;
    }

    .dir-btn {
        background: var(--header-bg, #f1f5f9);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 10px;
        cursor: pointer;
        color: #64748b;
        transition: all 0.1s;
    }
    .dir-btn.active {
        background: #ede9fe;
        border-color: #7c3aed;
        color: #7c3aed;
        font-weight: 600;
    }

    .template-hint {
        font-size: 10px;
        color: #94a3b8;
        font-style: italic;
        line-height: 1.4;
        border-top: 1px solid var(--border-color, #e2e8f0);
        padding-top: 6px;
        margin-top: 2px;
    }

    .panel-footer {
        padding: 6px 10px 8px;
        border-top: 1px solid var(--border-color, #e2e8f0);
        background: var(--header-bg, #f8fafc);
    }

    .delete-btn {
        background: none;
        border: 1px solid #fca5a5;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 11px;
        color: #dc2626;
        cursor: pointer;
        width: 100%;
        text-align: left;
        transition: background 0.1s;
    }
    .delete-btn:hover {
        background: #fef2f2;
    }
</style>
