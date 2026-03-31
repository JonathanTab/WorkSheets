<script>
    import { arrowRight, penTool } from '../../lib/icons/index.js';

    let {
        title = 'Untitled Drawing',
        isDirty = false,
        isSaving = false,
        onClose = () => {},
        onSave = () => {},
    } = $props();
</script>

<div class="svg-toolbar">
    <div class="toolbar-left">
        <button class="back-btn" onclick={onClose} title="Back to drive">
            {@html arrowRight}
        </button>
        <div class="doc-icon">{@html penTool}</div>
        <span class="doc-title">{title}</span>
        {#if isDirty}
            <span class="dirty-indicator" title="Unsaved changes">●</span>
        {/if}
    </div>
    <div class="toolbar-right">
        <button
            class="save-btn"
            onclick={onSave}
            disabled={isSaving || !isDirty}
            title="Save drawing (Ctrl+S)"
        >
            {isSaving ? 'Saving…' : 'Save'}
        </button>
    </div>
</div>

<style>
    .svg-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 44px;
        padding: 0 12px;
        background: var(--color-surface, #1a1a2e);
        border-bottom: 1px solid var(--color-border, #2a2a4a);
        flex-shrink: 0;
        gap: 8px;
    }

    .toolbar-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1;
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
        /* Rotate arrow to point left */
        transform: rotate(180deg);
    }

    .back-btn:hover {
        background: var(--color-hover, #2a2a4a);
        color: var(--color-text, #fff);
    }

    .back-btn :global(svg) {
        width: 16px;
        height: 16px;
    }

    .doc-icon {
        display: flex;
        align-items: center;
        color: #f97316;
        flex-shrink: 0;
    }

    .doc-icon :global(svg) {
        width: 16px;
        height: 16px;
    }

    .doc-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--color-text, #fff);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .dirty-indicator {
        color: var(--color-accent, #4f46e5);
        font-size: 10px;
        flex-shrink: 0;
    }

    .toolbar-right {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }

    .save-btn {
        padding: 5px 14px;
        font-size: 13px;
        font-weight: 500;
        background: var(--color-accent, #4f46e5);
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        transition: opacity 0.15s;
    }

    .save-btn:hover:not(:disabled) {
        opacity: 0.85;
    }

    .save-btn:disabled {
        opacity: 0.4;
        cursor: default;
    }
</style>
