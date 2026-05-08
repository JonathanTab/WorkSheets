<script>
    /**
     * LinkPopover — shown when the user hovers over a cell containing a hyperlink run.
     *
     * Positioned absolutely over the grid using the hovered cell's bounding rect.
     * The link URL is opened in a new tab on button click.
     */

    let {
        /** { url: string, cellLeft: number, cellTop: number, cellWidth: number, cellHeight: number } */
        link = null,
    } = $props();

    let visible = $derived(!!link?.url);

    // Position the popover above the cell (or below if near top)
    let style = $derived.by(() => {
        if (!link) return 'display:none';
        const { cellLeft, cellTop, cellWidth, cellHeight } = link;
        const top  = cellTop - 34; // above the cell
        const left = cellLeft;
        return `left:${left}px; top:${top}px; max-width:${Math.max(cellWidth, 240)}px;`;
    });

    function openLink() {
        if (!link?.url) return;
        window.open(link.url, '_blank', 'noopener,noreferrer');
    }

    function copyLink() {
        if (!link?.url) return;
        navigator.clipboard?.writeText(link.url).catch(() => {});
    }
</script>

{#if visible}
    <div class="link-popover" style={style} role="tooltip">
        <span class="link-url" title={link.url}>{link.url}</span>
        <button class="link-btn" onclick={openLink} title="Open link">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9"/>
                <path d="M10 2h4v4"/>
                <line x1="14" y1="2" x2="8" y2="8"/>
            </svg>
            Open
        </button>
        <button class="link-btn link-btn--icon" onclick={copyLink} title="Copy URL">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="5" y="5" width="9" height="9" rx="1"/>
                <path d="M3 11V3a1 1 0 0 1 1-1h8"/>
            </svg>
        </button>
    </div>
{/if}

<style>
    .link-popover {
        position: absolute;
        z-index: 300;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        background: var(--popover-bg, #1e293b);
        color: var(--popover-text, #f1f5f9);
        border-radius: 5px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        font-size: 11px;
        pointer-events: auto;
        white-space: nowrap;
        overflow: hidden;
    }

    .link-url {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--link-color, #93c5fd);
        min-width: 0;
    }

    .link-btn {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: rgba(255,255,255,0.12);
        border: none;
        border-radius: 3px;
        color: inherit;
        font-size: 11px;
        padding: 2px 6px;
        cursor: pointer;
        flex-shrink: 0;
        white-space: nowrap;
    }

    .link-btn:hover {
        background: rgba(255,255,255,0.22);
    }

    .link-btn--icon {
        padding: 2px 4px;
    }
</style>
