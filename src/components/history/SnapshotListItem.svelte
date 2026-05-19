<script>
    /**
     * SnapshotListItem — bare-bones row in the version history sidebar.
     * Shows: time, author list (truncated), optional description label.
     */

    let { snap, isSelected = false, onSelect } = $props();

    function formatTime(tsMs) {
        return new Date(tsMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function formatAuthors(createdBy) {
        if (!createdBy) return null;
        const users = [...new Set(createdBy.split(',').map(s => s.trim()).filter(Boolean))];
        if (users.length === 0) return null;
        if (users.length <= 2) return users.join(', ');
        return `${users[0]}, ${users[1]}, +${users.length - 2}`;
    }

    let timeLabel   = $derived(formatTime(snap.created_at));
    let authorLabel = $derived(formatAuthors(snap.created_by));
    let isManual    = $derived(snap.trigger === 'manual');
</script>

<button
    class="snap-row {isSelected ? 'snap-row--selected' : ''}"
    onclick={onSelect}
    type="button"
    aria-pressed={isSelected}
>
    <div class="snap-dot {isManual ? 'snap-dot--manual' : ''}"></div>
    <div class="snap-body">
        <div class="snap-time">
            {timeLabel}
            {#if isManual}<span class="snap-badge">saved</span>{/if}
            {#if snap.pinned}<span class="snap-pin">★</span>{/if}
        </div>
        {#if authorLabel}
            <div class="snap-authors">{authorLabel}</div>
        {/if}
        {#if snap.description}
            <div class="snap-desc">"{snap.description}"</div>
        {/if}
    </div>
    <span class="snap-chevron">›</span>
</button>

<style>
    .snap-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
        padding: 8px 10px;
        border: none;
        background: transparent;
        text-align: left;
        cursor: pointer;
        border-left: 3px solid transparent;
        border-bottom: 1px solid #f0f0f0;
        transition: background 0.1s;
    }
    .snap-row:hover { background: #f5f5f5; }
    .snap-row--selected {
        background: #eef4ff;
        border-left-color: #4285f4;
    }

    .snap-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ccc;
        margin-top: 5px;
        flex-shrink: 0;
    }
    .snap-dot--manual { background: #4285f4; }

    .snap-body {
        flex: 1;
        min-width: 0;
    }

    .snap-time {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        font-weight: 500;
        color: #222;
    }

    .snap-badge {
        font-size: 10px;
        font-weight: 600;
        background: #e8f0fe;
        color: #4285f4;
        border-radius: 3px;
        padding: 1px 4px;
        letter-spacing: 0.02em;
    }

    .snap-pin {
        font-size: 10px;
        color: #f4a018;
    }

    .snap-authors {
        font-size: 11px;
        color: #777;
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .snap-desc {
        font-size: 11px;
        color: #555;
        font-style: italic;
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .snap-chevron {
        color: #bbb;
        font-size: 16px;
        flex-shrink: 0;
        align-self: center;
    }
</style>
