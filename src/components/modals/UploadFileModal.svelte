<script>
    import Button from "../../lib/ui/Button.svelte";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import {
        upload,
        close,
        fileImage,
        fileVideo,
        fileAudio,
        filePdf,
        fileArchive,
        fileCode,
        file,
    } from "../../lib/icons/index.js";
    import {
        getFileCategory,
        getAcceptedFileTypes,
    } from "../../lib/appTypes.js";

    let { onConfirm, folderId = null } = $props();

    let files = $state([]);
    let isDragging = $state(false);
    let fileInput = $state(null);
    let isUploading = $state(false);
    let error = $state(null);

    function handleFileSelect(e) {
        const selectedFiles = Array.from(e.target.files || []);
        addFiles(selectedFiles);
    }

    function addFiles(newFiles) {
        for (const file of newFiles) {
            const category = getFileCategory(file.type);
            files.push({
                id: crypto.randomUUID(),
                file,
                name: file.name,
                size: file.size,
                mimeType: file.type || "application/octet-stream",
                category,
                icon: category.icon,
                status: "pending", // pending, uploading, done, error
                progress: 0,
            });
        }
        files = files; // trigger reactivity
    }

    function removeFile(id) {
        files = files.filter((f) => f.id !== id);
    }

    function handleDrop(e) {
        e.preventDefault();
        isDragging = false;
        const droppedFiles = Array.from(e.dataTransfer.files || []);
        addFiles(droppedFiles);
    }

    function handleDragOver(e) {
        e.preventDefault();
        isDragging = true;
    }

    function handleDragLeave(e) {
        e.preventDefault();
        isDragging = false;
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    async function handleUpload() {
        if (files.length === 0) return;

        isUploading = true;
        error = null;

        try {
            await onConfirm(files, folderId);
            closeTopModal();
        } catch (e) {
            error = e.message || "Upload failed";
            console.error("Upload error:", e);
        } finally {
            isUploading = false;
        }
    }

    function getIconSvg(iconName) {
        const icons = {
            fileImage,
            fileVideo,
            fileAudio,
            filePdf,
            fileArchive,
            fileCode,
            file,
        };
        return icons[iconName] || file;
    }
</script>

<svelte:window ondragover={handleDragOver} ondrop={handleDrop} />

<div class="dialog-content">
    <div class="upload-area" class:dragging={isDragging}>
        <input
            type="file"
            multiple
            accept={getAcceptedFileTypes()}
            bind:this={fileInput}
            onchange={handleFileSelect}
        />
        <div class="upload-icon">{@html upload}</div>
        <div class="upload-text">
            <p class="upload-title">
                Drop files here or <button
                    class="link-btn"
                    onclick={() => fileInput?.click()}>browse</button
                >
            </p>
            <p class="upload-hint">
                Images, videos, audio, PDFs, archives, and more
            </p>
        </div>
    </div>

    {#if files.length > 0}
        <div class="file-list">
            {#each files as f (f.id)}
                <div class="file-item">
                    <span class="file-icon" style="color: {f.category.color}"
                        >{@html getIconSvg(f.icon)}</span
                    >
                    <div class="file-info">
                        <span class="file-name">{f.name}</span>
                        <span class="file-meta"
                            >{formatSize(f.size)} · {f.category.name}</span
                        >
                    </div>
                    <button
                        class="remove-btn"
                        onclick={() => removeFile(f.id)}
                        disabled={isUploading}
                    >
                        {@html close}
                    </button>
                </div>
            {/each}
        </div>
    {/if}

    {#if error}
        <div class="error-message">{error}</div>
    {/if}

    <div class="dialog-footer">
        <Button
            variant="secondary"
            onclick={closeTopModal}
            disabled={isUploading}>Cancel</Button
        >
        <Button
            onclick={handleUpload}
            disabled={files.length === 0 || isUploading}
        >
            {isUploading
                ? "Uploading..."
                : `Upload ${files.length} file${files.length !== 1 ? "s" : ""}`}
        </Button>
    </div>
</div>

<style>
    .dialog-content {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    .upload-area {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 2rem;
        border: 2px dashed var(--color-border);
        border-radius: 8px;
        background: var(--color-fill);
        cursor: pointer;
        transition: all 0.2s;
        position: relative;
    }

    .upload-area:hover {
        border-color: var(--color-primary);
        background: var(--color-primary-soft);
    }

    .upload-area.dragging {
        border-color: var(--color-primary);
        background: var(--color-primary-soft);
    }

    .upload-area input[type="file"] {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
    }

    .upload-icon {
        width: 48px;
        height: 48px;
        color: var(--color-text-muted);
        margin-bottom: 0.75rem;
    }

    .upload-icon :global(svg) {
        width: 48px;
        height: 48px;
    }

    .upload-text {
        text-align: center;
    }

    .upload-title {
        font-size: 0.875rem;
        color: var(--color-text);
        margin: 0 0 0.25rem 0;
    }

    .link-btn {
        background: none;
        border: none;
        color: var(--color-primary);
        cursor: pointer;
        font: inherit;
        padding: 0;
        text-decoration: underline;
    }

    .link-btn:hover {
        text-decoration: none;
    }

    .upload-hint {
        font-size: 0.75rem;
        color: var(--color-text-muted);
        margin: 0;
    }

    .file-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        max-height: 200px;
        overflow-y: auto;
    }

    .file-item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.625rem 0.75rem;
        background: var(--color-fill);
        border-radius: 6px;
    }

    .file-icon {
        display: flex;
        align-items: center;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
    }

    .file-icon :global(svg) {
        width: 20px;
        height: 20px;
    }

    .file-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }

    .file-name {
        font-size: 0.8125rem;
        color: var(--color-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .file-meta {
        font-size: 0.6875rem;
        color: var(--color-text-muted);
    }

    .remove-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        border-radius: 4px;
        flex-shrink: 0;
    }

    .remove-btn:hover:not(:disabled) {
        background: var(--color-fill-secondary);
        color: var(--color-text);
    }

    .remove-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .remove-btn :global(svg) {
        width: 14px;
        height: 14px;
    }

    .error-message {
        font-size: 0.8125rem;
        color: var(--color-error, #ef4444);
        padding: 0.5rem;
        background: color-mix(
            in srgb,
            var(--color-error, #ef4444) 10%,
            transparent
        );
        border-radius: 4px;
    }

    .dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding-top: 8px;
    }
</style>
