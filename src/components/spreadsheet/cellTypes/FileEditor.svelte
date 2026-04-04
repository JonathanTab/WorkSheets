<script>
    /**
     * FileEditor - File cell editor overlay.
     *
     * Displayed when a cell with type 'file' is opened for editing.
     * Allows the user to:
     *   - Upload any file (drag-drop or browse)
     *   - Preview/view the current file
     *   - Replace the file
     *   - Remove the file
     *   - Download the current file
     *
     * Blob lifecycle:
     *   - On commit:   delete old blob if replaced; clean up intermediate uploads
     *   - On cancel:   delete any blobs uploaded during this session
     *
     * Props:
     *   value    - current blob file ID (or null/empty)
     *   docId    - parent document ID (parentId when creating blob files)
     *   ctConfig - current cell type config { type:'file', mimeType, filename, size, fit? }
     *   onCommit - callback(blobId, { mimeType, filename, size, fit? })
     *   onCancel - callback()
     */
    import { onMount, untrack } from 'svelte';
    import storage from '../../../stores/storage.js';
    import { getFileCategory, formatFileSize } from '../../../stores/spreadsheet/cellTypes/types/file.js';

    let {
        value    = '',
        docId    = null,
        ctConfig = null,
        onCommit = null,
        onCancel = null,
    } = $props();

    // Original blob from before edit opened
    const originalBlobId = value || null;

    let pendingBlobId   = $state(value || null);
    let pendingMeta     = $state({
        mimeType: ctConfig?.mimeType ?? '',
        filename:  ctConfig?.filename  ?? '',
        size:      ctConfig?.size      ?? null,
        fit:       ctConfig?.fit       ?? 'contain',
    });

    let isDragging    = $state(false);
    let isUploading   = $state(false);
    let uploadError   = $state(null);
    let dropZoneEl    = $state(null);

    function openViewer() {
        if (!pendingBlobId) return;
        window.dispatchEvent(new CustomEvent('show-file-viewer', {
            detail: {
                blobId:   pendingBlobId,
                mimeType: pendingMeta.mimeType,
                filename: pendingMeta.filename,
                size:     pendingMeta.size,
            },
        }));
    }
    let innerEl       = $state(null);
    let rootEl        = $state(null);
    let panelShift    = $state({ x: 0, y: 0 });

    // Clamp the panel to the viewport after mount
    $effect(() => {
        const el = innerEl;
        if (!el) return;
        untrack(() => {
            const rect = el.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const x = rect.right  > vw - 8 ? Math.min(0, vw - 8 - rect.right)  : 0;
            const y = rect.bottom > vh - 8 ? Math.min(0, vh - 8 - rect.bottom) : 0;
            if (x !== 0 || y !== 0) panelShift = { x, y };
        });
    });

    // Track blobs uploaded during this session for cleanup on cancel
    let sessionUploads = $state(/** @type {string[]} */ ([]));

    let category   = $derived(getFileCategory(pendingMeta.mimeType));
    let previewUrl = $derived(pendingBlobId ? storage.app.getBlobUrl(pendingBlobId) : null);

    const CATEGORY_LABELS = {
        image: 'Image',
        pdf:   'PDF',
        text:  'Text file',
        video: 'Video',
        audio: 'Audio',
        other: 'File',
    };

    const CATEGORY_ICONS = {
        image: '🖼',
        pdf:   '📄',
        text:  '📝',
        video: '🎬',
        audio: '🎵',
        other: '📎',
    };

    // ─── Upload ───────────────────────────────────────────────────────────

    async function handleFiles(files) {
        const file = files[0];
        if (!file) return;

        if (file.size > 200 * 1024 * 1024) {
            uploadError = 'File must be under 200 MB';
            return;
        }

        uploadError  = null;
        isUploading  = true;

        try {
            const descriptor = await storage.app.createBlob({
                title:    file.name,
                file,
                filename: file.name,
                parentId: docId ?? null,
            });

            sessionUploads = [...sessionUploads, descriptor.id];
            pendingBlobId  = descriptor.id;
            pendingMeta    = {
                mimeType: file.type || '',
                filename:  file.name,
                size:      file.size,
                fit:       'contain',
            };
        } catch (err) {
            uploadError = err?.message ?? 'Upload failed';
            console.error('File upload error:', err);
        } finally {
            isUploading = false;
        }
    }

    // ─── Drag-drop ────────────────────────────────────────────────────────

    function handleDropZoneDrop(e) {
        e.preventDefault();
        isDragging = false;
        const files = e.dataTransfer?.files;
        if (files?.length) handleFiles(files);
    }

    function handleDropZoneDragOver(e) {
        e.preventDefault();
        isDragging = true;
    }

    function handleDropZoneDragLeave(e) {
        if (!dropZoneEl?.contains(e.relatedTarget)) {
            isDragging = false;
        }
    }

    function handleFileInput(e) {
        handleFiles(e.target.files);
    }

    // ─── Actions ──────────────────────────────────────────────────────────

    function handleConfirm() {
        // Delete old blob if we're replacing it
        if (pendingBlobId !== originalBlobId && originalBlobId) {
            storage.app.delete(originalBlobId).catch(() => {});
        }
        // Clean up intermediate session uploads that weren't committed
        for (const id of sessionUploads) {
            if (id !== pendingBlobId) {
                storage.app.delete(id).catch(() => {});
            }
        }
        onCommit?.(pendingBlobId, { ...pendingMeta });
    }

    function handleRemove() {
        pendingBlobId = null;
        pendingMeta   = { mimeType: '', filename: '', size: null, fit: 'contain' };
    }

    function handleCancel() {
        // Clean up any blobs uploaded during this session that differ from original
        for (const id of sessionUploads) {
            if (id !== originalBlobId) {
                storage.app.delete(id).catch(() => {});
            }
        }
        onCancel?.();
    }

    function handleKeydown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            handleCancel();
        } else if (e.key === 'Enter' && !isUploading) {
            e.stopPropagation();
            handleConfirm();
        }
    }

    onMount(() => {
        rootEl?.focus();
    });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    bind:this={rootEl}
    class="fe"
    onkeydown={handleKeydown}
    role="dialog"
    tabindex="-1"
    aria-label="File editor"
>
    <div class="fe__inner" bind:this={innerEl} style={panelShift.x || panelShift.y ? `transform:translate(${panelShift.x}px,${panelShift.y}px)` : ''} onclick={(e) => e.stopPropagation()}>

        <!-- ── Existing file info / drop zone ── -->
        {#if pendingBlobId && !isUploading}
            <!-- File card -->
            <div class="fe__card">
                <!-- Preview area -->
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div
                    class="fe__preview"
                    onclick={openViewer}
                    title="Click to view"
                >
                    {#if category === 'image' && previewUrl}
                        <img
                            src={previewUrl}
                            alt={pendingMeta.filename || 'Image'}
                            class="fe__img-preview"
                        />
                    {:else}
                        <div class="fe__preview-icon fe__preview-icon--{category}">
                            {CATEGORY_ICONS[category] ?? '📎'}
                        </div>
                    {/if}
                    <div class="fe__preview-overlay">View</div>
                </div>

                <div class="fe__card-meta">
                    <div class="fe__card-name" title={pendingMeta.filename}>
                        {pendingMeta.filename || 'Attachment'}
                    </div>
                    <div class="fe__card-sub">
                        {CATEGORY_LABELS[category] ?? 'File'}
                        {#if pendingMeta.size}
                            · {formatFileSize(pendingMeta.size)}
                        {/if}
                    </div>
                    <div class="fe__card-actions">
                        <a
                            class="fe__action-btn fe__action-btn--dl"
                            href={previewUrl}
                            download={pendingMeta.filename || true}
                            target="_blank"
                            title="Download"
                        >Download</a>
                        <button
                            class="fe__action-btn fe__action-btn--remove"
                            onclick={handleRemove}
                            title="Remove file"
                        >Remove</button>
                    </div>
                </div>
            </div>

            <!-- Replace drop zone -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="fe__replace-zone"
                class:fe__replace-zone--dragging={isDragging}
                bind:this={dropZoneEl}
                ondragover={handleDropZoneDragOver}
                ondragleave={handleDropZoneDragLeave}
                ondrop={handleDropZoneDrop}
            >
                <span class="fe__replace-text">
                    Drop to replace, or
                    <label class="fe__file-label">
                        browse
                        <input
                            type="file"
                            class="fe__file-input"
                            onchange={handleFileInput}
                        />
                    </label>
                </span>
            </div>

        {:else if isUploading}
            <div class="fe__uploading">
                <div class="fe__upload-spinner"></div>
                <span>Uploading…</span>
            </div>

        {:else}
            <!-- Empty drop zone -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="fe__drop-zone"
                class:fe__drop-zone--dragging={isDragging}
                bind:this={dropZoneEl}
                ondragover={handleDropZoneDragOver}
                ondragleave={handleDropZoneDragLeave}
                ondrop={handleDropZoneDrop}
            >
                <div class="fe__drop-icon">📎</div>
                <div class="fe__drop-text">
                    Drop any file here, or
                    <label class="fe__file-label">
                        browse
                        <input
                            type="file"
                            class="fe__file-input"
                            onchange={handleFileInput}
                        />
                    </label>
                </div>
                <div class="fe__drop-hint">Images, PDFs, text, and more · up to 200 MB</div>
            </div>
        {/if}

        {#if uploadError}
            <div class="fe__error">{uploadError}</div>
        {/if}

        <!-- Image fit selector (only for image files) -->
        {#if pendingBlobId && category === 'image' && !isUploading}
            <div class="fe__fit-row">
                <span class="fe__fit-label">Fit:</span>
                <div class="fe__fit-options">
                    {#each ['contain', 'cover', 'fill', 'none'] as option}
                        <button
                            class="fe__fit-btn"
                            class:fe__fit-btn--active={pendingMeta.fit === option}
                            onclick={() => { pendingMeta = { ...pendingMeta, fit: option }; }}
                        >{option}</button>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Footer actions -->
        <div class="fe__footer">
            <button
                class="fe__btn fe__btn--cancel"
                onclick={handleCancel}
            >Cancel</button>
            <button
                class="fe__btn fe__btn--confirm"
                onclick={handleConfirm}
                disabled={isUploading}
            >OK</button>
        </div>
    </div>
</div>

<style>
    .fe {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 200;
        pointer-events: auto;
    }

    .fe__inner {
        background: var(--panel-bg, #ffffff);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.08);
        padding: 12px;
        width: 300px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-sizing: border-box;
    }

    /* ── File card ─────────────────────────────────────────────────────────── */

    .fe__card {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 10px;
    }

    /* Clickable preview area */
    .fe__preview {
        position: relative;
        width: 72px;
        height: 72px;
        border-radius: 6px;
        flex-shrink: 0;
        overflow: hidden;
        cursor: pointer;
        background: #e2e8f0;
    }

    .fe__img-preview {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }

    .fe__preview-icon {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 30px;
    }

    .fe__preview-icon--image { background: #d1fae5; }
    .fe__preview-icon--pdf   { background: #fee2e2; }
    .fe__preview-icon--text  { background: #dbeafe; }
    .fe__preview-icon--video { background: #ede9fe; }
    .fe__preview-icon--audio { background: #fef3c7; }
    .fe__preview-icon--other { background: #f1f5f9; }

    /* "View" label shown on hover */
    .fe__preview-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.45);
        color: #fff;
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.03em;
        opacity: 0;
        transition: opacity 0.12s;
    }

    .fe__preview:hover .fe__preview-overlay {
        opacity: 1;
    }

    .fe__card-meta {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .fe__card-name {
        font-size: 0.8125rem;
        font-weight: 600;
        color: #1e293b;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .fe__card-sub {
        font-size: 0.7rem;
        color: #64748b;
    }

    .fe__card-actions {
        display: flex;
        gap: 6px;
        margin-top: 4px;
        flex-wrap: wrap;
    }

    .fe__action-btn {
        padding: 2px 8px;
        font-size: 0.7rem;
        border-radius: 4px;
        border: 1px solid #e2e8f0;
        background: #fff;
        color: #475569;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        transition: background 0.1s, border-color 0.1s;
    }

    .fe__action-btn:hover {
        background: #f1f5f9;
        border-color: #cbd5e1;
    }

    .fe__action-btn--view {
        color: #3b82f6;
        border-color: #93c5fd;
    }

    .fe__action-btn--view:hover {
        background: #eff6ff;
    }

    .fe__action-btn--dl {
        color: #475569;
    }

    .fe__action-btn--remove {
        color: #ef4444;
        border-color: #fca5a5;
    }

    .fe__action-btn--remove:hover {
        background: #fef2f2;
    }

    /* ── Replace zone ──────────────────────────────────────────────────────── */

    .fe__replace-zone {
        border: 1px dashed #cbd5e1;
        border-radius: 6px;
        background: #f8fafc;
        padding: 6px 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: border-color 0.15s, background 0.15s;
    }

    .fe__replace-zone--dragging {
        border-color: #3b82f6;
        background: #eff6ff;
    }

    .fe__replace-text {
        font-size: 0.75rem;
        color: #64748b;
    }

    /* ── Empty drop zone ───────────────────────────────────────────────────── */

    .fe__drop-zone {
        border: 2px dashed #cbd5e1;
        border-radius: 8px;
        background: #f8fafc;
        padding: 24px 12px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        transition: border-color 0.15s, background 0.15s;
        cursor: pointer;
    }

    .fe__drop-zone--dragging {
        border-color: #3b82f6;
        background: #eff6ff;
    }

    .fe__drop-icon {
        font-size: 28px;
        opacity: 0.45;
        pointer-events: none;
    }

    .fe__drop-text {
        font-size: 0.8rem;
        color: #64748b;
        text-align: center;
        line-height: 1.5;
        pointer-events: none;
    }

    .fe__drop-hint {
        font-size: 0.7rem;
        color: #94a3b8;
        pointer-events: none;
    }

    /* ── Uploading ─────────────────────────────────────────────────────────── */

    .fe__uploading {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 20px;
        color: #64748b;
        font-size: 0.8125rem;
    }

    .fe__upload-spinner {
        width: 24px;
        height: 24px;
        border: 3px solid #e2e8f0;
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    /* ── Shared label/input ────────────────────────────────────────────────── */

    .fe__file-label {
        color: #3b82f6;
        cursor: pointer;
        text-decoration: underline;
        pointer-events: auto;
    }

    .fe__file-input {
        display: none;
    }

    /* ── Error ─────────────────────────────────────────────────────────────── */

    .fe__error {
        font-size: 0.75rem;
        color: #ef4444;
        background: #fef2f2;
        border-radius: 4px;
        padding: 4px 8px;
    }

    /* ── Image fit row ─────────────────────────────────────────────────────── */

    .fe__fit-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .fe__fit-label {
        font-size: 0.75rem;
        color: #64748b;
        white-space: nowrap;
    }

    .fe__fit-options {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
    }

    .fe__fit-btn {
        padding: 2px 8px;
        font-size: 0.7rem;
        border-radius: 4px;
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #475569;
        cursor: pointer;
        transition: background 0.1s, border-color 0.1s;
        text-transform: capitalize;
    }

    .fe__fit-btn--active {
        background: #eff6ff;
        border-color: #93c5fd;
        color: #1d4ed8;
        font-weight: 600;
    }

    /* ── Footer ────────────────────────────────────────────────────────────── */

    .fe__footer {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }

    .fe__btn {
        padding: 5px 14px;
        font-size: 0.8rem;
        border-radius: 5px;
        border: 1px solid #e2e8f0;
        cursor: pointer;
        font-weight: 500;
        transition: background 0.1s;
    }

    .fe__btn--cancel {
        background: #f8fafc;
        color: #475569;
    }

    .fe__btn--cancel:hover {
        background: #f1f5f9;
    }

    .fe__btn--confirm {
        background: #3b82f6;
        color: #fff;
        border-color: #2563eb;
    }

    .fe__btn--confirm:hover:not(:disabled) {
        background: #2563eb;
    }

    .fe__btn--confirm:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
</style>
