<script>
    /**
     * SnapshotListItem — a single row in the history snapshot list.
     * Props:
     *   snap         - SnapshotMeta (includes diff_json, app_type)
     *   summary      - { summary: string, changeCount: number } from interpretDiff
     *   isSelected   - bool, highlight this row
     *   onSelect     - () => void
     */

    let { snap, summary = null, isSelected = false, onSelect } = $props();

    function formatTime(tsMs) {
        return new Date(tsMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function formatTrigger(trigger) {
        return {
            auto:        'Auto-saved',
            manual:      'Saved',
            room_empty:  'Session end',
            session_end: 'Session end',
            session_cap: 'Checkpoint',
        }[trigger] ?? trigger;
    }

    function formatUsers(createdBy) {
        if (!createdBy) return null;
        const names = createdBy.split(',').map(s => s.trim()).filter(Boolean);
        if (names.length === 0) return null;
        if (names.length === 1) return names[0];
        if (names.length === 2) return `${names[0]} & ${names[1]}`;
        return `${names[0]} +${names.length - 1} others`;
    }

    function badgeClass(count) {
        if (!count) return 'badge-neutral';
        if (count < 5) return 'badge-low';
        if (count < 20) return 'badge-mid';
        return 'badge-high';
    }

    let users    = $derived(formatUsers(snap.created_by));
    let badgeCls = $derived(badgeClass(summary?.changeCount ?? 0));
</script>

<button
    class="snap-item {isSelected ? 'snap-item--selected' : ''}"
    onclick={onSelect}
    aria-pressed={isSelected}
>
    <div class="snap-main">
        <div class="snap-top-row">
            <span class="snap-time">{formatTime(snap.created_at)}</span>
            <span class="snap-trigger">{formatTrigger(snap.trigger)}</span>
            {#if summary !== null}
                {#if summary.changeCount > 0}
                    <span class="snap-badge {badgeCls}">{summary.changeCount}</span>
                {:else if summary.summary !== '—'}
                    <span class="snap-badge badge-neutral">0</span>
                {:else}
                    <span class="snap-badge badge-neutral">—</span>
                {/if}
            {:else}
                <span class="snap-badge badge-neutral">—</span>
            {/if}
        </div>

        {#if snap.description}
            <div class="snap-desc">"{snap.description}"</div>
        {/if}

        {#if summary?.summary && summary.summary !== '—' && summary.summary !== 'No changes' && summary.summary !== 'Initial version'}
            <div class="snap-summary">{summary.summary}</div>
        {:else if summary?.summary === 'Initial version'}
            <div class="snap-summary snap-summary--initial">Initial version</div>
        {/if}

        {#if users}
            <div class="snap-users">{users}</div>
        {/if}
    </div>
    <span class="snap-chevron">›</span>
</button>

<style>
    .snap-item {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 8px 12px;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        border-bottom: 1px solid #f0f0f0;
        transition: background 0.1s;
    }
    .snap-item:hover { background: #f5f5f5; }
    .snap-item--selected { background: #eef4ff; }

    .snap-main { flex: 1; min-width: 0; }

    .snap-top-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 2px;
    }

    .snap-time {
        font-size: 12px;
        font-weight: 600;
        color: #222;
    }

    .snap-trigger {
        font-size: 10px;
        color: #888;
        background: #f0f0f0;
        padding: 1px 5px;
        border-radius: 3px;
    }

    .snap-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 5px;
        border-radius: 10px;
        margin-left: auto;
        flex-shrink: 0;
    }
    .badge-neutral  { background: #eee; color: #666; }
    .badge-low      { background: #e6f4ea; color: #2d7a2d; }
    .badge-mid      { background: #fff3cd; color: #7a5c00; }
    .badge-high     { background: #fde8e8; color: #a00; }

    .snap-desc {
        font-size: 11px;
        color: #555;
        font-style: italic;
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .snap-summary {
        font-size: 11px;
        color: #555;
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .snap-summary--initial { color: #999; font-style: italic; }

    .snap-users {
        font-size: 10px;
        color: #888;
        margin-top: 1px;
    }

    .snap-chevron {
        color: #bbb;
        font-size: 16px;
        flex-shrink: 0;
    }
</style>
