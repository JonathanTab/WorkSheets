<script>
    import { folder, chevronRight, chevronDown } from "../lib/icons/index.js";

    let {
        folders,
        currentFolderId,
        expandedFolders,
        onNavigate,
        onToggleExpand,
        getChildFolders,
        depth = 0,
    } = $props();

    function isExpanded(folderId) {
        return expandedFolders.has(folderId);
    }

    function isActive(folderId) {
        return currentFolderId === folderId;
    }
</script>

{#each folders as fld (fld.id)}
    {@const children = getChildFolders(fld.id)}
    {@const expanded = isExpanded(fld.id)}
    {@const active = isActive(fld.id)}
    <div class="tree-item-wrapper" style="padding-left: {depth * 12}px;">
        <button
            class="tree-item"
            class:active
            onclick={() => onNavigate(fld.id)}
        >
            {#if children.length > 0}
                <span
                    class="tree-expand"
                    onclick={(e) => onToggleExpand(fld.id, e)}
                >
                    {@html expanded ? chevronDown : chevronRight}
                </span>
            {:else}
                <span class="tree-expand placeholder"></span>
            {/if}
            <span class="tree-icon">{@html folder}</span>
            <span class="tree-name">{fld.name}</span>
        </button>
        {#if expanded && children.length > 0}
            <svelte:self
                folders={children}
                {currentFolderId}
                {expandedFolders}
                {onNavigate}
                {onToggleExpand}
                {getChildFolders}
                depth={depth + 1}
            />
        {/if}
    </div>
{/each}

<style>
    .tree-item-wrapper {
        display: flex;
        flex-direction: column;
    }

    .tree-item {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        width: 100%;
        padding: 0.375rem 0.5rem;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.8125rem;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.15s;
        text-align: left;
    }

    .tree-item:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .tree-item.active {
        background: var(--color-primary-soft);
        color: var(--color-primary);
    }

    .tree-expand {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        cursor: pointer;
        border-radius: 3px;
    }

    .tree-expand:hover {
        background: var(--color-fill-secondary);
    }

    .tree-expand :global(svg) {
        width: 12px;
        height: 12px;
    }

    .tree-expand.placeholder {
        visibility: hidden;
    }

    .tree-icon {
        display: flex;
        align-items: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        color: #f59e0b;
    }

    .tree-icon :global(svg) {
        width: 16px;
        height: 16px;
    }

    .tree-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
</style>
