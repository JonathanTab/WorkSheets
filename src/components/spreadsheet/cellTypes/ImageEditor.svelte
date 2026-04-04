<script>
    /**
     * ImageEditor - Image cell editor overlay.
     *
     * Displayed when a cell with type 'image' is opened for editing.
     * Allows the user to:
     *   - Upload a new image (drag-drop or click)
     *   - Preview the current image
     *   - Change fit mode (contain / cover / fill / none)
     *   - Remove the image
     *
     * Props:
     *   value    - current blob file ID (or null/empty if no image set)
     *   docId    - parent document ID (used as parentId when creating blob files)
     *   onCommit - callback(blobId, fitMode)
     *   onCancel - callback()
     */
    import { onMount } from 'svelte';
    import storage from '../../../stores/storage.js';

    let {
        value = '',
        docId = null,
        onCommit = null,
        onCancel = null,
    } = $props();

    // Track original blobId so we can delete it if replaced
    const originalBlobId = value || null;
    // Track blobs uploaded this session for cleanup on cancel
    let sessionUploads = $state(/** @type {string[]} */ ([]));

    let isDragging = $state(false);
    let isUploading = $state(false);
    let uploadProgress = $state(0);
    let uploadError = $state(null);
    let previewUrl = $state(null);
    let pendingBlobId = $state(value || null); // will be committed on confirm
    let fit = $state('contain');
    let dropZoneEl = $state(null);
    let rootEl = $state(null);

    // Load preview URL for the current (or pending) blobId
    $effect(() => {
        const id = pendingBlobId;
        if (id) {
            previewUrl = storage.app.getBlobUrl(id);
        } else {
            previewUrl = null;
        }
    });

    async function handleFiles(files) {
        const file = files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            uploadError = 'File must be an image (PNG, JPG, GIF, WebP, etc.)';
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            uploadError = 'Image must be under 20 MB';
            return;
        }

        uploadError = null;
        isUploading = true;
        uploadProgress = 0;

        try {
            // Create a blob file record with parent = docId
            const descriptor = await storage.app.createBlob({
                title: file.name,
                file,
                filename: file.name,
                parentId: docId ?? null,
            });

            sessionUploads = [...sessionUploads, descriptor.id];
            pendingBlobId = descriptor.id;
            uploadProgress = 100;
        } catch (err) {
            uploadError = err?.message ?? 'Upload failed';
            console.error('Image upload error:', err);
        } finally {
            isUploading = false;
        }
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
        if (!dropZoneEl?.contains(e.relatedTarget)) {
            isDragging = false;
        }
    }

    function handleFileInput(e) {
        handleFiles(e.target.files);
    }

    function handleConfirm() {
        // Delete original blob if it was replaced
        if (pendingBlobId !== originalBlobId && originalBlobId) {
            storage.app.delete(originalBlobId).catch(() => {});
        }
        // Clean up intermediate session uploads that weren't committed
        for (const id of sessionUploads) {
            if (id !== pendingBlobId) {
                storage.app.delete(id).catch(() => {});
            }
        }
        onCommit?.(pendingBlobId, fit);
    }

    function handleRemove() {
        pendingBlobId = null;
        previewUrl = null;
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
    class="image-editor"
    onkeydown={handleKeydown}
    role="dialog"
    tabindex="-1"
    aria-label="Image editor"
>
    <div class="image-editor__inner" onclick={(e) => e.stopPropagation()}>

        <!-- Preview / Drop zone -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="image-editor__drop-zone"
            class:image-editor__drop-zone--dragging={isDragging}
            class:image-editor__drop-zone--has-image={!!previewUrl}
            bind:this={dropZoneEl}
            ondragover={handleDropZoneDragOver}
            ondragleave={handleDropZoneDragLeave}
            ondrop={handleDropZoneDrop}
        >
            {#if previewUrl && !isUploading}
                <img
                    src={previewUrl}
                    alt="Cell image"
                    class="image-editor__preview"
                    style="object-fit: {fit};"
                />
                <button
                    class="image-editor__remove-btn"
                    onclick={handleRemove}
                    title="Remove image"
                    aria-label="Remove image"
                >✕</button>
            {:else if isUploading}
                <div class="image-editor__uploading">
                    <div class="image-editor__progress-bar">
                        <div
                            class="image-editor__progress-fill"
                            style="width: {uploadProgress}%;"
                        ></div>
                    </div>
                    <span>Uploading…</span>
                </div>
            {:else}
                <div class="image-editor__drop-hint">
                    <div class="image-editor__drop-icon">🖼</div>
                    <div class="image-editor__drop-text">
                        Drop an image here, or<br>
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
                </div>
            {/if}
        </div>

        {#if uploadError}
            <div class="image-editor__error">{uploadError}</div>
        {/if}

        <!-- Fit mode selector -->
        {#if previewUrl}
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
        width: 280px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-sizing: border-box;
    }

    .image-editor__drop-zone {
        position: relative;
        width: 100%;
        height: 160px;
        border: 2px dashed #cbd5e1;
        border-radius: 6px;
        background: #f8fafc;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        transition: border-color 0.15s, background 0.15s;
        cursor: pointer;
        box-sizing: border-box;
    }

    .image-editor__drop-zone--dragging {
        border-color: #3b82f6;
        background: #eff6ff;
    }

    .image-editor__drop-zone--has-image {
        border-style: solid;
        border-color: #e2e8f0;
        background: #1e293b10;
    }

    .image-editor__preview {
        width: 100%;
        height: 100%;
        display: block;
    }

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

    .image-editor__drop-zone:hover .image-editor__remove-btn {
        opacity: 1;
    }

    .image-editor__uploading {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        color: #64748b;
        font-size: 0.8125rem;
    }

    .image-editor__progress-bar {
        width: 140px;
        height: 4px;
        background: #e2e8f0;
        border-radius: 2px;
        overflow: hidden;
    }

    .image-editor__progress-fill {
        height: 100%;
        background: #3b82f6;
        transition: width 0.2s;
    }

    .image-editor__drop-hint {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        pointer-events: none;
    }

    .image-editor__drop-icon {
        font-size: 28px;
        opacity: 0.5;
    }

    .image-editor__drop-text {
        font-size: 0.8rem;
        color: #64748b;
        text-align: center;
        line-height: 1.5;
        pointer-events: auto;
    }

    .image-editor__file-label {
        color: #3b82f6;
        cursor: pointer;
        text-decoration: underline;
    }

    .image-editor__file-input {
        display: none;
    }

    .image-editor__error {
        font-size: 0.75rem;
        color: #ef4444;
        background: #fef2f2;
        border-radius: 4px;
        padding: 4px 8px;
    }

    .image-editor__fit-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .image-editor__fit-label {
        font-size: 0.75rem;
        color: #64748b;
        white-space: nowrap;
    }

    .image-editor__fit-options {
        display: flex;
        gap: 4px;
    }

    .image-editor__fit-btn {
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

    .image-editor__fit-btn--active {
        background: #eff6ff;
        border-color: #93c5fd;
        color: #1d4ed8;
        font-weight: 600;
    }

    .image-editor__actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }

    .image-editor__btn {
        padding: 5px 14px;
        font-size: 0.8rem;
        border-radius: 5px;
        border: 1px solid #e2e8f0;
        cursor: pointer;
        font-weight: 500;
        transition: background 0.1s;
    }

    .image-editor__btn--cancel {
        background: #f8fafc;
        color: #475569;
    }

    .image-editor__btn--cancel:hover {
        background: #f1f5f9;
    }

    .image-editor__btn--confirm {
        background: #3b82f6;
        color: #fff;
        border-color: #2563eb;
    }

    .image-editor__btn--confirm:hover:not(:disabled) {
        background: #2563eb;
    }

    .image-editor__btn--confirm:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
</style>
