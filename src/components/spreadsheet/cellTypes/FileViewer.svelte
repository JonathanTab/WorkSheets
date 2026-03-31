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
     *   blobId   - blob file ID
     *   mimeType - MIME type string
     *   filename - original filename
     *   onClose  - callback()
     */
    import storage from '../../../stores/storage.js';
    import { getFileCategory, formatFileSize } from '../../../stores/spreadsheet/cellTypes/types/file.js';

    let {
        blobId   = null,
        mimeType = '',
        filename = '',
        size     = null,
        onClose  = null,
    } = $props();

    let category  = $derived(getFileCategory(mimeType));
    let blobUrl   = $derived(blobId ? storage.app.getBlobUrl(blobId) : null);

    let textContent = $state(null);
    let textLoading = $state(false);
    let textError   = $state(null);
    let imgZoom     = $state(1);

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
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            onClose?.();
        }
    }

    function handleBackdropClick(e) {
        if (e.target === e.currentTarget) onClose?.();
    }

    function zoomIn()    { imgZoom = Math.min(imgZoom + 0.25, 4); }
    function zoomOut()   { imgZoom = Math.max(imgZoom - 0.25, 0.25); }
    function zoomReset() { imgZoom = 1; }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fv-backdrop"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="File viewer"
    tabindex="-1"
>
    <div class="fv-panel" onclick={(e) => e.stopPropagation()}>

        <!-- Header -->
        <div class="fv-header">
            <div class="fv-file-info">
                <span class="fv-filename">{filename || 'Attachment'}</span>
                {#if size}
                    <span class="fv-size">{formatFileSize(size)}</span>
                {/if}
                {#if mimeType}
                    <span class="fv-mime">{mimeType}</span>
                {/if}
            </div>
            <div class="fv-actions">
                {#if category === 'image'}
                    <button class="fv-btn fv-btn--icon" onclick={zoomOut}  title="Zoom out"  aria-label="Zoom out">−</button>
                    <span   class="fv-zoom-label">{Math.round(imgZoom * 100)}%</span>
                    <button class="fv-btn fv-btn--icon" onclick={zoomIn}   title="Zoom in"   aria-label="Zoom in">+</button>
                    <button class="fv-btn fv-btn--icon" onclick={zoomReset} title="Reset zoom" aria-label="Reset zoom">⟳</button>
                    <div class="fv-sep"></div>
                {/if}
                {#if blobUrl}
                    <a class="fv-btn fv-btn--download" href={blobUrl} download={filename || true} target="_blank">
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
                <div class="fv-image-wrap">
                    <img
                        src={blobUrl}
                        alt={filename || 'File attachment'}
                        class="fv-image"
                        style="transform: scale({imgZoom}); transform-origin: center center;"
                    />
                </div>

            {:else if category === 'pdf'}
                <iframe
                    src={blobUrl}
                    title={filename || 'PDF document'}
                    class="fv-pdf"
                    sandbox="allow-same-origin allow-scripts allow-forms"
                ></iframe>

            {:else if category === 'video'}
                <div class="fv-media-wrap">
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video
                        src={blobUrl}
                        class="fv-video"
                        controls
                        preload="metadata"
                    ></video>
                </div>

            {:else if category === 'audio'}
                <div class="fv-audio-wrap">
                    <div class="fv-audio-icon">🎵</div>
                    <div class="fv-audio-name">{filename || 'Audio file'}</div>
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
                    <div class="fv-download-name">{filename || 'Attachment'}</div>
                    {#if size}
                        <div class="fv-download-size">{formatFileSize(size)}</div>
                    {/if}
                    <a class="fv-btn fv-btn--primary" href={blobUrl} download={filename || true} target="_blank">
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
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(2px);
    }

    .fv-panel {
        background: var(--panel-bg, #ffffff);
        border-radius: 10px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.3), 0 4px 16px rgba(0, 0, 0, 0.15);
        display: flex;
        flex-direction: column;
        width: min(90vw, 960px);
        height: min(88vh, 740px);
        overflow: hidden;
    }

    .fv-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color, #e2e8f0);
        flex-shrink: 0;
        min-width: 0;
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
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-color, #1e293b);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    .fv-size {
        font-size: 0.75rem;
        color: #64748b;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .fv-mime {
        font-size: 0.7rem;
        color: #94a3b8;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .fv-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
    }

    .fv-sep {
        width: 1px;
        height: 18px;
        background: #e2e8f0;
        margin: 0 4px;
    }

    .fv-zoom-label {
        font-size: 0.75rem;
        color: #64748b;
        min-width: 36px;
        text-align: center;
    }

    .fv-btn {
        padding: 4px 10px;
        font-size: 0.8rem;
        border-radius: 5px;
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
    }

    .fv-btn:hover {
        background: #f1f5f9;
        border-color: #cbd5e1;
    }

    .fv-btn--icon {
        padding: 4px 8px;
        font-size: 1rem;
        font-weight: 700;
        line-height: 1;
    }

    .fv-btn--download {
        color: #3b82f6;
        border-color: #93c5fd;
    }

    .fv-btn--download:hover {
        background: #eff6ff;
    }

    .fv-btn--close {
        font-size: 0.875rem;
        color: #64748b;
    }

    .fv-btn--primary {
        background: #3b82f6;
        color: #fff;
        border-color: #2563eb;
        padding: 8px 20px;
        font-size: 0.875rem;
    }

    .fv-btn--primary:hover {
        background: #2563eb;
    }

    .fv-body {
        flex: 1;
        overflow: hidden;
        display: flex;
        align-items: stretch;
        min-height: 0;
    }

    .fv-image-wrap {
        flex: 1;
        overflow: auto;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0f172a;
        padding: 16px;
    }

    .fv-image {
        max-width: none;
        transition: transform 0.15s;
        display: block;
        border-radius: 2px;
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
        background: #0f172a;
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
    }

    .fv-audio-icon {
        font-size: 56px;
        opacity: 0.5;
    }

    .fv-audio-name {
        font-size: 1rem;
        font-weight: 600;
        color: #1e293b;
        max-width: 480px;
        text-align: center;
        word-break: break-all;
    }

    .fv-audio {
        width: min(480px, 100%);
    }

    .fv-text {
        flex: 1;
        margin: 0;
        padding: 16px;
        font-size: 0.8125rem;
        font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
        line-height: 1.6;
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
    }

    .fv-error {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ef4444;
        font-size: 0.875rem;
        padding: 16px;
    }

    .fv-download-prompt {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
    }

    .fv-download-icon {
        font-size: 48px;
        opacity: 0.5;
    }

    .fv-download-name {
        font-size: 1rem;
        font-weight: 600;
        color: #1e293b;
        max-width: 480px;
        text-align: center;
        word-break: break-all;
    }

    .fv-download-size {
        font-size: 0.8rem;
        color: #64748b;
    }
</style>
