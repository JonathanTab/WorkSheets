<script>
    /**
     * DriveImagePicker — grid of the user's existing Drive images.
     *
     * Picking an image here is a LOOSE REFERENCE: the document just points at the
     * existing blob id; it does NOT become an owning parent of that blob. If the
     * Drive original is later deleted the in-document image falls back to a
     * "missing image" placeholder (handled by the renderers).
     *
     * Props:
     *   onPick   - callback(blobId)
     */
    import { onDestroy } from 'svelte';
    import storage from '../../../stores/storage.js';

    let { onPick = null } = $props();

    let driveFiles = $state(/** @type {any[]} */ ([]));
    const unsub = storage.drive.files.subscribe((f) => { driveFiles = f; });
    onDestroy(unsub);

    let query = $state('');

    let images = $derived.by(() => {
        const q = query.trim().toLowerCase();
        return driveFiles
            .filter((f) => f.type === 'blob' && !f.deleted && (f.mimeType ?? '').startsWith('image/'))
            .filter((f) => !q || (f.title ?? f.filename ?? '').toLowerCase().includes(q))
            .sort((a, b) => (b.mtime ?? '').localeCompare(a.mtime ?? ''));
    });
</script>

<div class="drive-picker">
    <input
        class="drive-picker__search"
        type="text"
        placeholder="Search your Drive images…"
        bind:value={query}
    />

    {#if images.length === 0}
        <div class="drive-picker__empty">
            {#if query}
                No Drive images match “{query}”.
            {:else}
                No images in your Drive yet. Upload one from the Upload tab, or add images to your Drive.
            {/if}
        </div>
    {:else}
        <div class="drive-picker__grid">
            {#each images as f (f.id)}
                <button
                    class="drive-picker__item"
                    title={f.title ?? f.filename ?? 'Image'}
                    onclick={() => onPick?.(f.id)}
                >
                    <img
                        class="drive-picker__thumb"
                        src={storage.app.getBlobUrl(f.id)}
                        alt={f.title ?? f.filename ?? 'Drive image'}
                        loading="lazy"
                        draggable="false"
                    />
                    <span class="drive-picker__name">{f.title ?? f.filename ?? 'Image'}</span>
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .drive-picker {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
    }

    .drive-picker__search {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 9px;
        font-size: 0.8rem;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 6px;
        background: var(--surface-bg, #fff);
        color: var(--text-color, #1e293b);
        outline: none;
    }

    .drive-picker__search:focus {
        border-color: #93c5fd;
    }

    .drive-picker__empty {
        font-size: 0.78rem;
        color: #64748b;
        text-align: center;
        padding: 28px 12px;
        line-height: 1.5;
    }

    .drive-picker__grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        overflow-y: auto;
        max-height: 220px;
        padding: 2px;
    }

    .drive-picker__item {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 0;
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 6px;
        background: #f8fafc;
        cursor: pointer;
        overflow: hidden;
        transition: border-color 0.1s, box-shadow 0.1s;
    }

    .drive-picker__item:hover {
        border-color: #3b82f6;
        box-shadow: 0 0 0 1px #3b82f680;
    }

    .drive-picker__thumb {
        width: 100%;
        aspect-ratio: 1 / 1;
        object-fit: cover;
        display: block;
        background: #e2e8f0;
    }

    .drive-picker__name {
        font-size: 0.65rem;
        color: #475569;
        padding: 2px 4px 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
</style>
