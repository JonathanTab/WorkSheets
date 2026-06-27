<script>
    /**
     * ImageEditor - Multi-source image picker overlay.
     *
     * Used both for image CELLS and for inserting FLOATING images. Lets the user set
     * an image from one of three sources:
     *   - Upload   : drag-drop / browse a local file (uploaded as an owned blob)
     *   - Drive    : pick an existing Drive image (LOOSE REFERENCE — not owned/copied)
     *   - URL      : fetch a remote image and store it as an owned blob
     * …plus pick a fit mode and remove the image.
     *
     * Blob ownership:
     *   Uploaded / URL blobs are created with parentId = docId (this doc owns them) and
     *   tracked in `sessionUploads` so uncommitted ones are reclaimed on cancel.
     *   Drive picks are loose references: their id is NOT added to sessionUploads, so we
     *   never release them — the Drive file remains their owner.
     *
     * Props:
     *   value    - current blob file ID (or null/empty if no image set)
     *   docId    - parent document ID (used as parentId when creating blob files)
     *   onCommit - callback(blobId, fitMode)
     *   onCancel - callback()
     */
    import { onMount } from 'svelte';
    import storage from '../../../stores/storage.js';
    import DriveImagePicker from './DriveImagePicker.svelte';

    let {
        value = '',
        docId = null,
        onCommit = null,
        onCancel = null,
    } = $props();

    // Track original blobId so we can release it (detach this doc) if replaced
    const originalBlobId = value || null;
    // Blobs THIS doc uploaded this session — reclaimed on cancel / when superseded.
    // Drive picks (loose references) are intentionally never added here.
    let sessionUploads = $state(/** @type {string[]} */ ([]));

    /** @type {'upload'|'drive'|'url'} */
    let mode = $state('upload');
    let isDragging = $state(false);
    let isUploading = $state(false);
    let uploadError = $state(null);
    let previewFailed = $state(false);
    let previewUrl = $state(null);
    let pendingBlobId = $state(value || null);
    let fit = $state('contain');
    let urlInput = $state('');
    let dropZoneEl = $state(null);
    let rootEl = $state(null);

    // Load preview URL for the current (or pending) blobId
    $effect(() => {
        const id = pendingBlobId;
        previewFailed = false;
        previewUrl = id ? storage.app.getBlobUrl(id) : null;
    });

    function validateImageFile(file) {
        if (!file.type.startsWith('image/')) {
            uploadError = 'File must be an image (PNG, JPG, GIF, WebP, etc.)';
            return false;
        }
        if (file.size > 20 * 1024 * 1024) {
            uploadError = 'Image must be under 20 MB';
            return false;
        }
        return true;
    }

    async function uploadOwnedBlob(file, title) {
        uploadError = null;
        isUploading = true;
        try {
            const descriptor = await storage.app.createBlob({
                title: title ?? file.name ?? 'image',
                file,
                filename: file.name ?? title ?? 'image',
                parentId: docId ?? null,
            });
            sessionUploads = [...sessionUploads, descriptor.id];
            pendingBlobId = descriptor.id;
            return descriptor.id;
        } catch (err) {
            uploadError = err?.message ?? 'Upload failed';
            console.error('Image upload error:', err);
            return null;
        } finally {
            isUploading = false;
        }
    }

    async function handleFiles(files) {
        const file = files?.[0];
        if (!file) return;
        if (!validateImageFile(file)) return;
        await uploadOwnedBlob(file, file.name);
    }

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
        if (!dropZoneEl?.contains(e.relatedTarget)) isDragging = false;
    }

    function handleFileInput(e) {
        handleFiles(e.target.files);
    }

    // ── Drive pick (loose reference) ──────────────────────────────────────────
    function handleDrivePick(blobId) {
        uploadError = null;
        pendingBlobId = blobId; // loose reference — not added to sessionUploads
    }

    // ── URL fetch → owned blob ────────────────────────────────────────────────
    async function handleUrlFetch() {
        const url = urlInput.trim();
        if (!url) return;
        uploadError = null;
        isUploading = true;
        try {
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error(`Could not fetch image (${res.status})`);
            const blob = await res.blob();
            if (!blob.type.startsWith('image/')) throw new Error('That URL is not an image');
            if (blob.size > 20 * 1024 * 1024) throw new Error('Image must be under 20 MB');
            const name = url.split('/').pop()?.split('?')[0] || 'image';
            const file = new File([blob], name, { type: blob.type });
            isUploading = false; // uploadOwnedBlob toggles it again
            await uploadOwnedBlob(file, name);
        } catch (err) {
            isUploading = false;
            uploadError =
                err?.message?.includes('Failed to fetch') || err?.name === 'TypeError'
                    ? 'Could not fetch that URL (the site may block cross-origin access). Try downloading it and using Upload.'
                    : (err?.message ?? 'Could not fetch that URL');
            console.error('Image URL fetch error:', err);
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    function handleConfirm() {
        // Release this document's claim on the original blob if it was replaced/cleared.
        // releaseBlob detaches only THIS doc — a shared blob survives for its other owners.
        if (pendingBlobId !== originalBlobId && originalBlobId) {
            storage.app.releaseBlob(originalBlobId, docId).catch(() => {});
        }
        // Reclaim intermediate session uploads that weren't committed.
        for (const id of sessionUploads) {
            if (id !== pendingBlobId) {
                storage.app.releaseBlob(id, docId).catch(() => {});
            }
        }
        onCommit?.(pendingBlobId, fit);
    }

    function handleRemove() {
        pendingBlobId = null;
        previewUrl = null;
        mode = 'upload';
    }

    function handleCancel() {
        // Discard any blobs uploaded during this session that differ from the original.
        for (const id of sessionUploads) {
            if (id !== originalBlobId) {
                storage.app.releaseBlob(id, docId).catch(() => {});
            }
        }
        onCancel?.();
    }

    function handleKeydown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            handleCancel();
        } else if (e.key === 'Enter' && !isUploading && mode !== 'url') {
            e.stopPropagation();
            handleConfirm();
        }
    }

    onMount(() => {
        rootEl?.focus();
    });

    const TABS = [
        { id: 'upload', label: 'Upload' },
        { id: 'drive', label: 'From Drive' },
        { id: 'url', label: 'From URL' },
    ];
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    bind:this={rootEl}
    class="image-editor"
    onkeydown={handleKeydown}
    role="dialog"
    tabindex="-1"
    aria-label="Image editor"
>
    <div class="image-editor__inner" onclick={(e) => e.stopPropagation()}>

        {#if previewUrl && !isUploading}
            <!-- Current image preview -->
            <div class="image-editor__preview-zone">
                {#if previewFailed}
                    <div class="image-editor__missing">
                        <div class="image-editor__missing-icon">🖼</div>
                        <span>Image unavailable</span>
                    </div>
                {:else}
                    <img
                        src={previewUrl}
                        alt="Selected"
                        class="image-editor__preview"
                        style="object-fit: {fit};"
                        onerror={() => (previewFailed = true)}
                    />
                {/if}
                <button
                    class="image-editor__remove-btn"
                    onclick={handleRemove}
                    title="Remove image"
                    aria-label="Remove image"
                >✕</button>
            </div>

            <!-- Fit mode selector -->
            <div class="image-editor__fit-row">
                <span class="image-editor__fit-label">Fit:</span>
                <div class="image-editor__fit-options">
                    {#each ['contain', 'cover', 'fill', 'none'] as option}
                        <button
                            class="image-editor__fit-btn"
                            class:image-editor__fit-btn--active={fit === option}
                            onclick={() => (fit = option)}
                        >{option}</button>
                    {/each}
                </div>
            </div>
        {:else}
            <!-- Source tabs -->
            <div class="image-editor__tabs" role="tablist">
                {#each TABS as tab}
                    <button
                        class="image-editor__tab"
                        class:image-editor__tab--active={mode === tab.id}
                        role="tab"
                        aria-selected={mode === tab.id}
                        onclick={() => { mode = tab.id; uploadError = null; }}
                    >{tab.label}</button>
                {/each}
            </div>

            {#if isUploading}
                <div class="image-editor__uploading">
                    <div class="image-editor__spinner"></div>
                    <span>Working…</span>
                </div>
            {:else if mode === 'upload'}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="image-editor__drop-zone"
                    class:image-editor__drop-zone--dragging={isDragging}
                    bind:this={dropZoneEl}
                    ondragover={handleDropZoneDragOver}
                    ondragleave={handleDropZoneDragLeave}
                    ondrop={handleDropZoneDrop}
                >
                    <div class="image-editor__drop-hint">
                        <div class="image-editor__drop-icon">🖼</div>
                        <div class="image-editor__drop-text">
                            Drop an image here, or
                            <label class="image-editor__file-label">
                                browse
                                <input
                                    type="file"
                                    accept="image/*"
                                    class="image-editor__file-input"
                                    onchange={handleFileInput}
                                />
                            </label>
                        </div>
                        <div class="image-editor__drop-sub">PNG, JPG, GIF, WebP · up to 20 MB</div>
                    </div>
                </div>
            {:else if mode === 'drive'}
                <DriveImagePicker onPick={handleDrivePick} />
            {:else if mode === 'url'}
                <div class="image-editor__url-row">
                    <input
                        class="image-editor__url-input"
                        type="url"
                        placeholder="https://example.com/image.png"
                        bind:value={urlInput}
                        onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleUrlFetch(); } }}
                    />
                    <button
                        class="image-editor__url-btn"
                        onclick={handleUrlFetch}
                        disabled={!urlInput.trim()}
                    >Fetch</button>
                </div>
            {/if}
        {/if}

        {#if uploadError}
            <div class="image-editor__error">{uploadError}</div>
        {/if}

        <!-- Actions -->
        <div class="image-editor__actions">
            <button
                class="image-editor__btn image-editor__btn--cancel"
                onclick={handleCancel}
            >Cancel</button>
            <button
                class="image-editor__btn image-editor__btn--confirm"
                onclick={handleConfirm}
                disabled={isUploading}
            >
                {pendingBlobId ? 'Set Image' : 'Clear'}
            </button>
        </div>
    </div>
</div>

<style>
    .image-editor {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 200;
        pointer-events: auto;
    }

    .image-editor__inner {
        background: var(--panel-bg, #ffffff);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.08);
        padding: 12px;
        width: 320px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-sizing: border-box;
    }

    /* ── Tabs ──────────────────────────────────────────────────────────────── */
    .image-editor__tabs {
        display: flex;
        gap: 2px;
        background: #f1f5f9;
        border-radius: 6px;
        padding: 2px;
    }

    .image-editor__tab {
        flex: 1;
        padding: 5px 8px;
        font-size: 0.75rem;
        font-weight: 500;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: #64748b;
        cursor: pointer;
        transition: background 0.1s, color 0.1s;
    }

    .image-editor__tab--active {
        background: #fff;
        color: #1d4ed8;
        box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    }

    /* ── Preview ───────────────────────────────────────────────────────────── */
    .image-editor__preview-zone {
        position: relative;
        width: 100%;
        height: 170px;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        background: #1e293b08;
        overflow: hidden;
    }

    .image-editor__preview {
        width: 100%;
        height: 100%;
        display: block;
    }

    .image-editor__missing {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: #94a3b8;
        font-size: 0.78rem;
    }

    .image-editor__missing-icon { font-size: 28px; opacity: 0.5; filter: grayscale(1); }

    .image-editor__remove-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: none;
        background: rgba(0,0,0,0.55);
        color: #fff;
        font-size: 11px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        padding: 0;
        opacity: 0;
        transition: opacity 0.15s;
    }

    .image-editor__preview-zone:hover .image-editor__remove-btn { opacity: 1; }

    /* ── Drop zone ─────────────────────────────────────────────────────────── */
    .image-editor__drop-zone {
        position: relative;
        width: 100%;
        height: 150px;
        border: 2px dashed #cbd5e1;
        border-radius: 6px;
        background: #f8fafc;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: border-color 0.15s, background 0.15s;
        cursor: pointer;
        box-sizing: border-box;
    }

    .image-editor__drop-zone--dragging {
        border-color: #3b82f6;
        background: #eff6ff;
    }

    .image-editor__drop-hint {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        pointer-events: none;
        text-align: center;
    }

    .image-editor__drop-icon { font-size: 28px; opacity: 0.5; }

    .image-editor__drop-text {
        font-size: 0.8rem;
        color: #64748b;
        line-height: 1.5;
        pointer-events: auto;
    }

    .image-editor__drop-sub { font-size: 0.7rem; color: #94a3b8; pointer-events: none; }

    .image-editor__file-label {
        color: #3b82f6;
        cursor: pointer;
        text-decoration: underline;
    }

    .image-editor__file-input { display: none; }

    /* ── URL ───────────────────────────────────────────────────────────────── */
    .image-editor__url-row { display: flex; gap: 6px; }

    .image-editor__url-input {
        flex: 1;
        min-width: 0;
        padding: 6px 9px;
        font-size: 0.8rem;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        outline: none;
    }

    .image-editor__url-input:focus { border-color: #93c5fd; }

    .image-editor__url-btn {
        padding: 5px 12px;
        font-size: 0.78rem;
        border-radius: 6px;
        border: 1px solid #2563eb;
        background: #3b82f6;
        color: #fff;
        cursor: pointer;
        font-weight: 500;
    }

    .image-editor__url-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── Uploading ─────────────────────────────────────────────────────────── */
    .image-editor__uploading {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 28px;
        color: #64748b;
        font-size: 0.8125rem;
    }

    .image-editor__spinner {
        width: 24px;
        height: 24px;
        border: 3px solid #e2e8f0;
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Fit ───────────────────────────────────────────────────────────────── */
    .image-editor__fit-row { display: flex; align-items: center; gap: 8px; }

    .image-editor__fit-label { font-size: 0.75rem; color: #64748b; white-space: nowrap; }

    .image-editor__fit-options { display: flex; gap: 4px; }

    .image-editor__fit-btn {
        padding: 2px 8px;
        font-size: 0.7rem;
        border-radius: 4px;
        border: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #475569;
        cursor: pointer;
        text-transform: capitalize;
    }

    .image-editor__fit-btn--active {
        background: #eff6ff;
        border-color: #93c5fd;
        color: #1d4ed8;
        font-weight: 600;
    }

    /* ── Error / actions ───────────────────────────────────────────────────── */
    .image-editor__error {
        font-size: 0.75rem;
        color: #ef4444;
        background: #fef2f2;
        border-radius: 4px;
        padding: 5px 8px;
        line-height: 1.4;
    }

    .image-editor__actions { display: flex; gap: 8px; justify-content: flex-end; }

    .image-editor__btn {
        padding: 5px 14px;
        font-size: 0.8rem;
        border-radius: 5px;
        border: 1px solid #e2e8f0;
        cursor: pointer;
        font-weight: 500;
        transition: background 0.1s;
    }

    .image-editor__btn--cancel { background: #f8fafc; color: #475569; }
    .image-editor__btn--cancel:hover { background: #f1f5f9; }

    .image-editor__btn--confirm {
        background: #3b82f6;
        color: #fff;
        border-color: #2563eb;
    }

    .image-editor__btn--confirm:hover:not(:disabled) { background: #2563eb; }
    .image-editor__btn--confirm:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
