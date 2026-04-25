<script>
    /**
     * FileViewer - Full-screen modal for viewing a cell's attached file.
     *
     * Supports:
     *   - Images     → <img> with zoom controls
     *   - PDFs       → <iframe> embed
     *   - Text files → fetched and displayed in <pre>
     *   - Other      → download link
     *
     * Props:
     *   blobId  - blob file ID (all metadata comes from the storage registry)
     *   onClose - callback()
     */
    import { onDestroy } from 'svelte';
    import storage from '../../../stores/storage.js';
    import { getFileCategory, formatFileSize } from '../../../stores/spreadsheet/cellTypes/types/file.js';

    let {
        blobId  = null,
        onClose = null,
    } = $props();

    // Reactive storage revision — re-derives metadata when registry syncs.
    let _storageRev = $state(0);
    const _unsubStorage = storage.app.files.subscribe(() => { _storageRev++; });
    onDestroy(_unsubStorage);

    $effect(() => {
        void _storageRev;
        if (blobId && !storage.app.get(blobId)) {
            storage.app.resolveBlob(blobId).catch(() => {});
        }
    });

    let _descriptor = $derived.by(() => {
        void _storageRev;
        return blobId ? storage.app.get(blobId) : null;
    });

    let resolvedMimeType = $derived(_descriptor?.mimeType || '');
    let resolvedFilename = $derived(_descriptor?.filename || '');
    let resolvedSize     = $derived(_descriptor?.size     ?? null);

    let category  = $derived(getFileCategory(resolvedMimeType));
    let blobUrl   = $derived(blobId ? storage.app.getBlobUrl(blobId) : null);

    let textContent = $state(null);
    let textLoading = $state(false);
    let textError   = $state(null);

    // Image zoom / pan state
    let imgZoom      = $state(1);
    let imgLoaded    = $state(false);
    let panX         = $state(0);
    let panY         = $state(0);
    let isPanning    = $state(false);
    let isInteracting = $state(false); // suppresses CSS transition during wheel/drag
    let panStart     = null;
    let wrapEl       = $state(null);

    $effect(() => {
        if (category !== 'image') { imgLoaded = false; imgZoom = 1; panX = 0; panY = 0; }
    });

    // Fetch text content for text files
    $effect(() => {
        if (category === 'text' && blobUrl) {
            textLoading = true;
            textError   = null;
            fetch(blobUrl, { credentials: 'same-origin' })
                .then(r => r.text())
                .then(t => { textContent = t; })
                .catch(e => { textError = e.message ?? 'Failed to load file'; })
                .finally(() => { textLoading = false; });
        }
    });

    function handleKeydown(e) {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose?.(); }
        else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.4); }
        else if (e.key === '-')                  { e.preventDefault(); zoomBy(1 / 1.4); }
        else if (e.key === '0')                  { e.preventDefault(); zoomReset(); }
    }

    function handleBackdropClick(e) {
        if (e.target === e.currentTarget) onClose?.();
    }

    // Zoom around the current image center (for button/keyboard use)
    function zoomBy(factor) {
        const newZoom = Math.max(0.05, Math.min(16, imgZoom * factor));
        panX = panX * (newZoom / imgZoom);
        panY = panY * (newZoom / imgZoom);
        imgZoom = newZoom;
    }

    function zoomReset() { imgZoom = 1; panX = 0; panY = 0; }

    // Zoom toward the point under the cursor
    function handleWheel(e) {
        e.preventDefault();
        isInteracting = true;

        const rect   = wrapEl.getBoundingClientRect();
        const cx     = rect.left + rect.width  / 2;
        const cy     = rect.top  + rect.height / 2;
        const dx     = e.clientX - cx;
        const dy     = e.clientY - cy;

        // image-space point under cursor before zoom
        const imgPtX = (dx - panX) / imgZoom;
        const imgPtY = (dy - panY) / imgZoom;

        const factor  = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const newZoom = Math.max(0.05, Math.min(16, imgZoom * factor));

        // adjust pan so cursor-pointed pixel stays fixed
        panX    = dx - imgPtX * newZoom;
        panY    = dy - imgPtY * newZoom;
        imgZoom = newZoom;
    }

    function handleImgMouseDown(e) {
        if (e.button !== 0) return;
        isPanning    = true;
        isInteracting = true;
        panStart     = { mx: e.clientX, my: e.clientY, px: panX, py: panY };
        e.preventDefault();
    }

    function handleImgMouseMove(e) {
        if (!isPanning || !panStart) return;
        panX = panStart.px + (e.clientX - panStart.mx);
        panY = panStart.py + (e.clientY - panStart.my);
    }

    function handleImgMouseUp() {
        isPanning     = false;
        isInteracting = false;
        panStart      = null;
    }

    // Double-click toggles fit ↔ 2× zoom, zooming toward the clicked point
    function handleImgDblClick(e) {
        isInteracting = false; // allow animated transition for this one
        if (imgZoom !== 1 || panX !== 0 || panY !== 0) {
            zoomReset();
        } else {
            const rect  = wrapEl.getBoundingClientRect();
            const cx    = rect.left + rect.width  / 2;
            const cy    = rect.top  + rect.height / 2;
            const dx    = e.clientX - cx;
            const dy    = e.clientY - cy;
            const newZ  = 2.5;
            panX    = dx - (dx / imgZoom) * newZ;
            panY    = dy - (dy / imgZoom) * newZ;
            imgZoom = newZ;
        }
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fv-backdrop"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    onmousemove={handleImgMouseMove}
    onmouseup={handleImgMouseUp}
    role="dialog"
    aria-modal="true"
    aria-label="File viewer"
    tabindex="-1"
>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="fv-panel" onclick={(e) => e.stopPropagation()}>

        <!-- Header -->
        <div class="fv-header">
            <div class="fv-file-info">
                <span class="fv-filename">{resolvedFilename || 'Attachment'}</span>
                {#if resolvedSize}
                    <span class="fv-size">{formatFileSize(resolvedSize)}</span>
                {/if}
                {#if resolvedMimeType}
                    <span class="fv-mime">{resolvedMimeType}</span>
                {/if}
            </div>
            <div class="fv-actions">
                {#if category === 'image'}
                    <button class="fv-zoom-btn" onclick={() => zoomBy(1/1.4)} title="Zoom out (−)" aria-label="Zoom out">−</button>
                    <button class="fv-zoom-reset" onclick={zoomReset} title="Reset zoom (0)" aria-label="Reset zoom">{Math.round(imgZoom * 100)}%</button>
                    <button class="fv-zoom-btn" onclick={() => zoomBy(1.4)}  title="Zoom in (+)"  aria-label="Zoom in">+</button>
                    <div class="fv-sep"></div>
                {/if}
                {#if blobUrl}
                    <a class="fv-btn fv-btn--download" href={blobUrl} download={resolvedFilename || 'download'} target="_blank">
                        ↓ Download
                    </a>
                {/if}
                <button class="fv-btn fv-btn--close" onclick={() => onClose?.()} aria-label="Close">✕</button>
            </div>
        </div>

        <!-- Body -->
        <div class="fv-body">
            {#if !blobUrl}
                <div class="fv-empty">No file to display.</div>

            {:else if category === 'image'}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="fv-image-wrap"
                    class:fv-image-wrap--panning={isPanning}
                    bind:this={wrapEl}
                    onwheel={handleWheel}
                    onmousedown={handleImgMouseDown}
                    ondblclick={handleImgDblClick}
                >
                    <img
                        src={blobUrl}
                        alt={resolvedFilename || 'File attachment'}
                        class="fv-image"
                        class:fv-image--loaded={imgLoaded}
                        class:fv-image--instant={isInteracting}
                        onload={() => { imgLoaded = true; }}
                        style="transform: translate({panX}px, {panY}px) scale({imgZoom});"
                        draggable="false"
                    />
                </div>

            {:else if category === 'pdf'}
                <iframe
                    src={blobUrl}
                    title={resolvedFilename || 'PDF document'}
                    class="fv-pdf"
                    sandbox="allow-same-origin allow-scripts allow-forms"
                ></iframe>

            {:else if category === 'video'}
                <div class="fv-media-wrap">
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video src={blobUrl} class="fv-video" controls preload="metadata"></video>
                </div>

            {:else if category === 'audio'}
                <div class="fv-audio-wrap">
                    <div class="fv-audio-icon">🎵</div>
                    <div class="fv-audio-name">{resolvedFilename || 'Audio file'}</div>
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <audio src={blobUrl} class="fv-audio" controls preload="metadata"></audio>
                </div>

            {:else if category === 'text'}
                {#if textLoading}
                    <div class="fv-status">Loading…</div>
                {:else if textError}
                    <div class="fv-error">{textError}</div>
                {:else if textContent !== null}
                    <pre class="fv-text">{textContent}</pre>
                {/if}

            {:else}
                <div class="fv-download-prompt">
                    <div class="fv-download-icon">📎</div>
                    <div class="fv-download-name">{resolvedFilename || 'Attachment'}</div>
                    {#if resolvedSize}
                        <div class="fv-download-size">{formatFileSize(resolvedSize)}</div>
                    {/if}
                    <a class="fv-btn fv-btn--primary" href={blobUrl} download={resolvedFilename || 'download'} target="_blank">
                        Download File
                    </a>
                </div>
            {/if}
        </div>

    </div>
</div>

<style>
    .fv-backdrop {
        position: fixed;
        inset: 0;
        z-index: 9000;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(4px);
        animation: fv-fade-in 0.15s ease;
    }

    @keyframes fv-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
    }

    .fv-panel {
        background: var(--panel-bg, #ffffff);
        border-radius: 12px;
        box-shadow: 0 32px 80px rgba(0, 0, 0, 0.28), 0 4px 16px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        width: min(92vw, 1040px);
        height: min(90vh, 800px);
        overflow: hidden;
        animation: fv-slide-up 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes fv-slide-up {
        from { opacity: 0; transform: translateY(12px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0)    scale(1); }
    }

    /* ── Header ───────────────────────────────────────────────────────────── */

    .fv-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        flex-shrink: 0;
        min-width: 0;
        background: var(--panel-bg, #fff);
    }

    .fv-file-info {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
        flex: 1;
        overflow: hidden;
    }

    .fv-filename {
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--text-color, #1e293b);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    .fv-size {
        font-size: 0.7rem;
        color: #64748b;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .fv-mime {
        font-size: 0.65rem;
        color: #94a3b8;
        white-space: nowrap;
        flex-shrink: 0;
        font-family: monospace;
    }

    .fv-actions {
        display: flex;
        align-items: center;
        gap: 3px;
        flex-shrink: 0;
    }

    .fv-sep {
        width: 1px;
        height: 16px;
        background: #e2e8f0;
        margin: 0 3px;
    }

    /* Zoom controls — compact pill style */
    .fv-zoom-btn {
        width: 26px;
        height: 26px;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #475569;
        font-size: 1rem;
        font-weight: 700;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        transition: background 0.1s, border-color 0.1s;
        padding: 0;
    }

    .fv-zoom-btn:hover { background: #f1f5f9; border-color: #cbd5e1; }

    .fv-zoom-reset {
        min-width: 46px;
        height: 26px;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #64748b;
        font-size: 0.7rem;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.1s, color 0.1s;
        padding: 0 4px;
    }

    .fv-zoom-reset:hover { background: #f1f5f9; color: #1e293b; border-color: #cbd5e1; }

    .fv-btn {
        padding: 4px 10px;
        font-size: 0.775rem;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #475569;
        cursor: pointer;
        transition: background 0.1s;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        line-height: 1;
        height: 26px;
        box-sizing: border-box;
    }

    .fv-btn:hover { background: #f1f5f9; border-color: #cbd5e1; }

    .fv-btn--download { color: #2563eb; border-color: #bfdbfe; }
    .fv-btn--download:hover { background: #eff6ff; }

    .fv-btn--close { color: #64748b; font-size: 0.8rem; }
    .fv-btn--close:hover { background: #f1f5f9; color: #ef4444; border-color: #fca5a5; }

    .fv-btn--primary {
        background: #3b82f6;
        color: #fff;
        border-color: #2563eb;
        padding: 8px 20px;
        font-size: 0.875rem;
        height: auto;
    }

    .fv-btn--primary:hover { background: #2563eb; }

    /* ── Body ─────────────────────────────────────────────────────────────── */

    .fv-body {
        flex: 1;
        overflow: hidden;
        display: flex;
        align-items: stretch;
        min-height: 0;
    }

    /* Image viewer — dark bg, pan + smooth zoom */
    .fv-image-wrap {
        flex: 1;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #111827;
        cursor: grab;
        user-select: none;
    }

    .fv-image-wrap--panning { cursor: grabbing; }

    .fv-image {
        max-width: 100%;
        max-height: 100%;
        display: block;
        border-radius: 3px;
        transition: transform 0.12s cubic-bezier(0.25, 0.46, 0.45, 0.94);
        opacity: 0;
        transform-origin: center center;
        pointer-events: none;
        box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    }

    .fv-image--loaded {
        opacity: 1;
        transition: opacity 0.2s ease, transform 0.12s cubic-bezier(0.25, 0.46, 0.45, 0.94);
    }

    /* No transform transition during wheel/drag — avoids lag */
    .fv-image--instant {
        transition: opacity 0.2s ease !important;
    }

    .fv-pdf {
        flex: 1;
        width: 100%;
        border: none;
    }

    .fv-media-wrap {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #111827;
        padding: 16px;
        overflow: auto;
    }

    .fv-video {
        max-width: 100%;
        max-height: 100%;
        border-radius: 4px;
    }

    .fv-audio-wrap {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        padding: 32px;
        background: #f8fafc;
    }

    .fv-audio-icon { font-size: 52px; opacity: 0.4; }

    .fv-audio-name {
        font-size: 0.9375rem;
        font-weight: 600;
        color: #1e293b;
        max-width: 480px;
        text-align: center;
        word-break: break-all;
    }

    .fv-audio { width: min(480px, 100%); }

    .fv-text {
        flex: 1;
        margin: 0;
        padding: 16px 20px;
        font-size: 0.8125rem;
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
        line-height: 1.65;
        color: #1e293b;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-all;
        background: #f8fafc;
        width: 100%;
        box-sizing: border-box;
    }

    .fv-empty,
    .fv-status {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #94a3b8;
        font-size: 0.875rem;
        background: #f8fafc;
    }

    .fv-error {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ef4444;
        font-size: 0.875rem;
        padding: 16px;
        background: #f8fafc;
    }

    .fv-download-prompt {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        background: #f8fafc;
    }

    .fv-download-icon { font-size: 48px; opacity: 0.45; }

    .fv-download-name {
        font-size: 1rem;
        font-weight: 600;
        color: #1e293b;
        max-width: 480px;
        text-align: center;
        word-break: break-all;
    }

    .fv-download-size { font-size: 0.8rem; color: #64748b; }
</style>
