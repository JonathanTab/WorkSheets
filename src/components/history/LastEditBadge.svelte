<script>
    /**
     * LastEditBadge — shows "Edited 25m ago by Jon" in the document header.
     * Props:
     *   lastEdit  - { by: string, at: number (Unix ms) } | null
     */

    let { lastEdit = null } = $props();

    function timeAgo(ms) {
        const diff = Date.now() - ms;
        const minutes = Math.floor(diff / 60_000);
        const hours   = Math.floor(diff / 3_600_000);
        const days    = Math.floor(diff / 86_400_000);
        if (diff < 30_000)  return 'just now';
        if (minutes < 60)   return `${minutes}m ago`;
        if (hours < 24)     return `${hours}h ago`;
        if (days < 7)       return `${days}d ago`;
        return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // Recompute time label every 30 seconds so it stays fresh
    let label = $state('');
    $effect(() => {
        if (!lastEdit?.at) { label = ''; return; }
        const update = () => {
            label = lastEdit ? `Edited ${timeAgo(lastEdit.at)} by ${lastEdit.by}` : '';
        };
        update();
        const id = setInterval(update, 30_000);
        return () => clearInterval(id);
    });
</script>

{#if label}
    <span class="last-edit-badge" title={lastEdit ? new Date(lastEdit.at).toLocaleString() : ''}>
        {label}
    </span>
{/if}

<style>
    .last-edit-badge {
        font-size: 11px;
        color: #888;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 220px;
        cursor: default;
        line-height: 1;
    }
</style>
