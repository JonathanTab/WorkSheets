<script>
    /**
     * DocStatusBar — bottom status bar for the document editor.
     * Shows page count, word count, view mode toggle, and zoom slider.
     */
    import { getDocStats } from '../../stores/docs/docCommands.js';

    let {
        editorState = null,
        editorMount = null,
        zoom = $bindable(100),
        viewMode = $bindable('paginated'),
        pageHeightPx = 1056,
        topMarginPx = 96,
        bottomMarginPx = 96,
    } = $props();

    const ZOOM_MIN = 50;
    const ZOOM_MAX = 200;

    let wordCount = $derived.by(() => {
        if (!editorState) return 0;
        return getDocStats(editorState.doc).words;
    });

    let charCount = $derived.by(() => {
        if (!editorState) return 0;
        return getDocStats(editorState.doc).chars;
    });

    let pageCount = $derived.by(() => {
        if (!editorMount || viewMode === 'pageless') return 1;
        const contentH = editorMount.scrollHeight || 0;
        const usableH = pageHeightPx - topMarginPx - bottomMarginPx;
        return Math.max(1, Math.ceil(contentH / usableH));
    });

    function setZoom(val) {
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(val)));
    }

    function handleZoomInput(e) {
        setZoom(Number(e.target.value));
    }

    function handleZoomKey(e) {
        if (e.key === 'Enter') {
            const v = parseInt(e.target.value);
            if (!isNaN(v)) setZoom(v);
            e.target.blur();
        }
    }

    let showStats = $state(false);
    let zoomInputFocused = $state(false);
    let zoomInputVal = $state(String(zoom));

    $effect(() => { zoomInputVal = String(zoom); });
</script>

<div class="status-bar" role="status" aria-label="Document status">
    <!-- Left: page / word count -->
    <div class="sb-section left">
        <span class="sb-item page-info">
            Page {pageCount === 1 ? '1' : '1'} of {pageCount}
        </span>
        <span class="sb-sep"></span>
        <button
            class="sb-item stats-btn"
            onclick={() => showStats = !showStats}
            title="Word and character count"
        >
            {wordCount.toLocaleString()} word{wordCount !== 1 ? 's' : ''}
        </button>
        {#if showStats}
            <div class="stats-popup" role="tooltip">
                <div class="stats-row">
                    <span>Words</span><span class="stats-val">{wordCount.toLocaleString()}</span>
                </div>
                <div class="stats-row">
                    <span>Characters</span><span class="stats-val">{charCount.toLocaleString()}</span>
                </div>
            </div>
        {/if}
    </div>

    <!-- Center: view mode toggle -->
    <div class="sb-section center">
        <div class="view-toggle" role="group" aria-label="View mode">
            <button
                class="view-btn"
                class:active={viewMode === 'paginated'}
                onclick={() => viewMode = 'paginated'}
                title="Paginated view"
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <line x1="3" y1="9" x2="21" y2="9"/>
                    <line x1="3" y1="15" x2="21" y2="15"/>
                </svg>
                Pages
            </button>
            <button
                class="view-btn"
                class:active={viewMode === 'pageless'}
                onclick={() => viewMode = 'pageless'}
                title="Pageless (continuous) view"
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="4" y1="6" x2="20" y2="6"/>
                    <line x1="4" y1="10" x2="20" y2="10"/>
                    <line x1="4" y1="14" x2="20" y2="14"/>
                    <line x1="4" y1="18" x2="20" y2="18"/>
                </svg>
                Pageless
            </button>
        </div>
    </div>

    <!-- Right: zoom control -->
    <div class="sb-section right">
        <button
            class="zoom-step"
            onclick={() => setZoom(zoom - 10)}
            title="Zoom out"
            disabled={zoom <= ZOOM_MIN}
        >−</button>
        <input
            type="range"
            class="zoom-slider"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step="5"
            value={zoom}
            oninput={handleZoomInput}
            title="Zoom: {zoom}%"
            aria-label="Zoom level"
        />
        <button
            class="zoom-step"
            onclick={() => setZoom(zoom + 10)}
            title="Zoom in"
            disabled={zoom >= ZOOM_MAX}
        >+</button>
        <button
            class="zoom-label"
            title="Reset zoom to 100%"
            onclick={() => setZoom(100)}
        >{zoom}%</button>
    </div>
</div>

{#if showStats}
    <div class="stats-backdrop" onclick={() => showStats = false}></div>
{/if}

<style>
    .status-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 26px;
        padding: 0 10px;
        background: var(--color-bg-secondary, #f2f2f7);
        border-top: 1px solid var(--color-border, #c6c6c8);
        flex-shrink: 0;
        font-size: 11px;
        color: var(--color-text-secondary, #3c3c43);
        user-select: none;
        position: relative;
        z-index: 10;
    }

    .sb-section {
        display: flex;
        align-items: center;
        gap: 6px;
        position: relative;
    }

    .sb-section.center {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
    }

    .sb-item {
        font-size: 11px;
        color: var(--color-text-secondary);
        white-space: nowrap;
    }

    .sb-sep {
        width: 1px;
        height: 12px;
        background: var(--color-border);
    }

    .stats-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 11px;
        color: var(--color-text-secondary);
        padding: 1px 3px;
        border-radius: 3px;
    }
    .stats-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .stats-popup {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        padding: 8px 12px;
        box-shadow: 0 4px 12px rgba(0,0,0,.15);
        min-width: 160px;
        z-index: 50;
    }
    .stats-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        font-size: 11px;
        padding: 2px 0;
        color: var(--color-text);
    }
    .stats-val {
        font-weight: 600;
        color: var(--color-primary);
    }

    .stats-backdrop {
        position: fixed;
        inset: 0;
        z-index: 49;
    }

    /* View mode toggle */
    .view-toggle {
        display: flex;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        overflow: hidden;
    }
    .view-btn {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 1px 8px;
        border: none;
        background: transparent;
        font-size: 10px;
        color: var(--color-text-secondary);
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.1s;
    }
    .view-btn + .view-btn {
        border-left: 1px solid var(--color-border);
    }
    .view-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }
    .view-btn.active {
        background: var(--color-primary, #007AFF);
        color: white;
    }
    .view-btn svg { flex-shrink: 0; }

    /* Zoom */
    .zoom-step {
        width: 18px;
        height: 18px;
        border: 1px solid var(--color-border);
        border-radius: 3px;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        flex-shrink: 0;
    }
    .zoom-step:hover:not(:disabled) {
        background: var(--color-fill);
        color: var(--color-text);
    }
    .zoom-step:disabled { opacity: 0.4; cursor: default; }

    .zoom-slider {
        width: 80px;
        height: 3px;
        accent-color: var(--color-primary, #007AFF);
        cursor: pointer;
        flex-shrink: 0;
    }

    .zoom-label {
        background: none;
        border: 1px solid var(--color-border);
        border-radius: 3px;
        padding: 1px 5px;
        font-size: 10px;
        color: var(--color-text-secondary);
        cursor: pointer;
        min-width: 36px;
        text-align: center;
        white-space: nowrap;
    }
    .zoom-label:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .page-info {
        white-space: nowrap;
    }

    @media (max-width: 600px) {
        .sb-section.center { display: none; }
        .zoom-slider { width: 60px; }
    }
</style>
