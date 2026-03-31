<script context="module">
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }
</script>

<script>
    import Button from "../../lib/ui/Button.svelte";
    import {
        close,
        download,
        zoomIn,
        zoomOut,
        play,
        pause,
        fullscreen,
        minimize,
    } from "../../lib/icons/index.js";
    import {
        getFileCategory,
        isBlobFile,
        isPreviewable,
    } from "../../lib/appTypes.js";

    let { file, blobUrl, onClose } = $props();

    let imgElement = $state(null);
    let videoElement = $state(null);
    let audioElement = $state(null);

    let zoom = $state(1);
    let isFullscreen = $state(false);
    let isPlaying = $state(false);
    let currentTime = $state(0);
    let duration = $state(0);

    $effect(() => {
        if (blobUrl) {
            // Reset state when file changes
            zoom = 1;
            isPlaying = false;
            currentTime = 0;
        }
    });

    function getViewerType(file) {
        if (!file) return "other";
        const category = getFileCategory(file.mimeType);
        const categoryKey = Object.keys(
            getFileCategory.constructor === Function ? {} : {},
        ).find((k) => false);
        return category.name?.toLowerCase() || "other";
    }

    function handleZoomIn() {
        zoom = Math.min(zoom + 0.25, 4);
    }

    function handleZoomOut() {
        zoom = Math.max(zoom - 0.25, 0.25);
    }

    function handleFullscreen() {
        const element = imgElement || videoElement?.parentElement;
        if (!element) return;

        if (!isFullscreen) {
            element.requestFullscreen?.();
        } else {
            document.exitFullscreen?.();
        }
    }

    $effect(() => {
        const handleChange = () => {
            isFullscreen = document.fullscreenElement != null;
        };
        document.addEventListener("fullscreenchange", handleChange);
        return () =>
            document.removeEventListener("fullscreenchange", handleChange);
    });

    function handleDownload() {
        if (!blobUrl || !file) return;
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = file.name || "download";
        a.click();
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return "0:00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    }

    function handleVideoPlay() {
        if (videoElement) {
            if (isPlaying) {
                videoElement.pause();
            } else {
                videoElement.play();
            }
            isPlaying = !isPlaying;
        }
    }

    function handleVideoTimeUpdate() {
        if (videoElement) {
            currentTime = videoElement.currentTime;
        }
    }

    function handleVideoLoadedMetadata() {
        if (videoElement) {
            duration = videoElement.duration;
        }
    }

    function handleSeek(e) {
        if (videoElement && duration) {
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            videoElement.currentTime = percent * duration;
        }
    }

    function handleVideoEnd() {
        isPlaying = false;
        currentTime = 0;
    }

    function getViewerTypeFromMime(mimeType) {
        if (!mimeType) return "other";
        if (mimeType.startsWith("image/")) return "image";
        if (mimeType.startsWith("video/")) return "video";
        if (mimeType.startsWith("audio/")) return "audio";
        if (mimeType === "application/pdf") return "pdf";
        return "other";
    }

    const viewerType = $derived(getViewerTypeFromMime(file?.mimeType));
</script>

<div class="file-viewer">
    <div class="viewer-header">
        <div class="file-info">
            <span class="file-name">{file?.name || "Unknown File"}</span>
            <span class="file-size"
                >{file?.size ? formatSize(file.size) : ""}</span
            >
        </div>
        <div class="viewer-actions">
            {#if viewerType === "image"}
                <button
                    class="action-btn"
                    onclick={handleZoomOut}
                    title="Zoom Out"
                >
                    {@html zoomOut}
                </button>
                <span class="zoom-level">{Math.round(zoom * 100)}%</span>
                <button
                    class="action-btn"
                    onclick={handleZoomIn}
                    title="Zoom In"
                >
                    {@html zoomIn}
                </button>
                <button
                    class="action-btn"
                    onclick={handleFullscreen}
                    title="Fullscreen"
                >
                    {@html isFullscreen ? minimize : fullscreen}
                </button>
            {/if}
            <button
                class="action-btn"
                onclick={handleDownload}
                title="Download"
            >
                {@html download}
            </button>
            <button
                class="action-btn close-btn"
                onclick={onClose}
                title="Close"
            >
                {@html close}
            </button>
        </div>
    </div>

    <div class="viewer-content" class:fullscreen={isFullscreen}>
        {#if blobUrl}
            {#if viewerType === "image"}
                <div class="image-container">
                    <img
                        bind:this={imgElement}
                        src={blobUrl}
                        alt={file?.name || "Image"}
                        style="transform: scale({zoom})"
                    />
                </div>
            {:else if viewerType === "video"}
                <div class="video-container">
                    <video
                        bind:this={videoElement}
                        src={blobUrl}
                        ontimeupdate={handleVideoTimeUpdate}
                        onloadedmetadata={handleVideoLoadedMetadata}
                        onended={handleVideoEnd}
                    />
                    <div class="video-controls">
                        <button class="play-btn" onclick={handleVideoPlay}>
                            {@html isPlaying ? pause : play}
                        </button>
                        <span class="time">{formatTime(currentTime)}</span>
                        <div class="progress-bar" onclick={handleSeek}>
                            <div
                                class="progress"
                                style="width: {(currentTime / duration) * 100}%"
                            ></div>
                        </div>
                        <span class="time">{formatTime(duration)}</span>
                    </div>
                </div>
            {:else if viewerType === "audio"}
                <div class="audio-container">
                    <div class="audio-icon">🎵</div>
                    <audio
                        bind:this={audioElement}
                        src={blobUrl}
                        ontimeupdate={handleVideoTimeUpdate}
                        onloadedmetadata={handleVideoLoadedMetadata}
                        onended={handleVideoEnd}
                    />
                    <div class="audio-controls">
                        <button class="play-btn" onclick={handleVideoPlay}>
                            {@html isPlaying ? pause : play}
                        </button>
                        <span class="time">{formatTime(currentTime)}</span>
                        <div class="progress-bar" onclick={handleSeek}>
                            <div
                                class="progress"
                                style="width: {(currentTime / duration) * 100}%"
                            ></div>
                        </div>
                        <span class="time">{formatTime(duration)}</span>
                    </div>
                </div>
            {:else if viewerType === "pdf"}
                <div class="pdf-container">
                    <iframe src={blobUrl} title={file?.name || "PDF"}></iframe>
                </div>
            {:else}
                <div class="other-container">
                    <div class="file-icon">
                        {file?.mimeType?.split("/")[0] || "file"}
                    </div>
                    <p>This file type cannot be previewed</p>
                    <Button onclick={handleDownload}>Download File</Button>
                </div>
            {/if}
        {:else}
            <div class="loading">
                <p>Loading...</p>
            </div>
        {/if}
    </div>
</div>

<style>
    .file-viewer {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--color-bg);
    }

    .viewer-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg);
        flex-shrink: 0;
    }

    .file-info {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
    }

    .file-name {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--color-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .file-size {
        font-size: 0.75rem;
        color: var(--color-text-muted);
    }

    .viewer-actions {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.15s;
    }

    .action-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .action-btn :global(svg) {
        width: 18px;
        height: 18px;
    }

    .close-btn:hover {
        background: var(--color-error, #ef4444);
        color: white;
    }

    .zoom-level {
        font-size: 0.75rem;
        color: var(--color-text-muted);
        min-width: 40px;
        text-align: center;
    }

    .viewer-content {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        background: var(--color-fill-secondary);
        padding: 1rem;
    }

    .viewer-content.fullscreen {
        background: var(--color-bg);
    }

    .image-container {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        overflow: auto;
    }

    .image-container img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        transition: transform 0.2s;
    }

    .video-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: 900px;
        background: black;
        border-radius: 8px;
        overflow: hidden;
    }

    .video-container video {
        width: 100%;
        display: block;
    }

    .video-controls,
    .audio-controls {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
        background: rgba(0, 0, 0, 0.8);
    }

    .play-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border: none;
        background: var(--color-primary);
        color: white;
        cursor: pointer;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .play-btn:hover {
        opacity: 0.9;
    }

    .play-btn :global(svg) {
        width: 18px;
        height: 18px;
    }

    .time {
        font-size: 0.75rem;
        color: white;
        min-width: 40px;
        flex-shrink: 0;
    }

    .progress-bar {
        flex: 1;
        height: 4px;
        background: rgba(255, 255, 255, 0.3);
        border-radius: 2px;
        cursor: pointer;
        overflow: hidden;
    }

    .progress {
        height: 100%;
        background: var(--color-primary);
        transition: width 0.1s;
    }

    .audio-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.5rem;
        padding: 2rem;
        background: var(--color-bg);
        border-radius: 12px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }

    .audio-icon {
        font-size: 4rem;
    }

    .pdf-container {
        width: 100%;
        height: 100%;
    }

    .pdf-container iframe {
        width: 100%;
        height: 100%;
        border: none;
    }

    .other-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        padding: 3rem;
        text-align: center;
    }

    .file-icon {
        font-size: 3rem;
        text-transform: uppercase;
        color: var(--color-text-muted);
    }

    .other-container p {
        color: var(--color-text-muted);
        margin: 0;
    }

    .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
    }
</style>
