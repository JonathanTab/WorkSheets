<script>
    /**
     * FloatingImagePanel — properties popover for the selected floating image.
     *
     * Portals to <body> (so it escapes the grid's `contain:layout`) and positions
     * itself just above the selected image (or below if there isn't room above).
     *
     * Props:
     *   img        - the floating-image record (reactive values)
     *   anchor     - { x, y, w, h } viewport rect of the image
     *   onUpdate   - callback(changes)  → sheetStore.updateFloatingImage
     *   onReplace  - callback()         → open the image picker to swap the source
     *   onDelete   - callback()         → remove the image
     */
    let { img, anchor, onUpdate = null, onReplace = null, onDelete = null } = $props();

    /** Move the node to <body> on mount so fixed positioning isn't contained/clipped. */
    function portal(node) {
        document.body.appendChild(node);
        return { destroy() { node.remove(); } };
    }

    const PANEL_W = 248;
    const PANEL_H = 320; // approximate, for above/below decision

    let pos = $derived.by(() => {
        if (!anchor) return { left: 0, top: 0 };
        const gap = 10;
        let left = anchor.x + anchor.w / 2 - PANEL_W / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - PANEL_W - 8));
        // Prefer above; flip below if it would clip the top.
        let top = anchor.y - PANEL_H - gap;
        if (top < 8) top = Math.min(anchor.y + anchor.h + gap, window.innerHeight - PANEL_H - 8);
        top = Math.max(8, top);
        return { left, top };
    });

    const FITS = ['contain', 'cover', 'fill', 'none'];
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    use:portal
    class="fip"
    style="left:{pos.left}px; top:{pos.top}px;"
    onmousedown={(e) => e.stopPropagation()}
    onclick={(e) => e.stopPropagation()}
>
    <div class="fip__header">
        <span class="fip__title">Image</span>
        <button class="fip__icon-btn" title="Replace image" onclick={() => onReplace?.()} aria-label="Replace image">⤓</button>
        <button class="fip__icon-btn fip__icon-btn--danger" title="Delete image" onclick={() => onDelete?.()} aria-label="Delete image">🗑</button>
    </div>

    <label class="fip__row">
        <span class="fip__label">Fit</span>
        <select class="fip__select" value={img.fit} onchange={(e) => onUpdate?.({ fit: e.currentTarget.value })}>
            {#each FITS as f}<option value={f}>{f}</option>{/each}
        </select>
    </label>

    <label class="fip__row">
        <span class="fip__label">Opacity</span>
        <input
            class="fip__range" type="range" min="0.1" max="1" step="0.05"
            value={img.opacity}
            oninput={(e) => onUpdate?.({ opacity: Number(e.currentTarget.value) })}
        />
        <span class="fip__val">{Math.round((img.opacity ?? 1) * 100)}%</span>
    </label>

    <label class="fip__row">
        <span class="fip__label">Radius</span>
        <input
            class="fip__range" type="range" min="0" max="60" step="1"
            value={img.borderRadius}
            oninput={(e) => onUpdate?.({ borderRadius: Number(e.currentTarget.value) })}
        />
        <span class="fip__val">{img.borderRadius ?? 0}</span>
    </label>

    <div class="fip__row">
        <span class="fip__label">Border</span>
        <input
            class="fip__range" type="range" min="0" max="12" step="1"
            value={img.borderWidth}
            oninput={(e) => onUpdate?.({ borderWidth: Number(e.currentTarget.value) })}
        />
        <span class="fip__val">{img.borderWidth ?? 0}</span>
        <input
            class="fip__color" type="color"
            value={img.borderColor || '#000000'}
            oninput={(e) => onUpdate?.({ borderColor: e.currentTarget.value })}
            title="Border color"
        />
    </div>

    <label class="fip__field">
        <span class="fip__label">Alt text</span>
        <input
            class="fip__input" type="text" placeholder="Describe the image"
            value={img.alt}
            oninput={(e) => onUpdate?.({ alt: e.currentTarget.value })}
        />
    </label>

    <label class="fip__field">
        <span class="fip__label">Caption</span>
        <input
            class="fip__input" type="text" placeholder="Shown under the image"
            value={img.caption}
            oninput={(e) => onUpdate?.({ caption: e.currentTarget.value })}
        />
    </label>
</div>

<style>
    .fip {
        position: fixed;
        z-index: 1000;
        width: 248px;
        box-sizing: border-box;
        background: var(--panel-bg, #fff);
        border: 1px solid var(--border-color, #e2e8f0);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 0.78rem;
        color: #1e293b;
    }

    .fip__header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding-bottom: 6px;
        border-bottom: 1px solid #f1f5f9;
    }

    .fip__title { font-weight: 600; flex: 1; }

    .fip__icon-btn {
        width: 24px;
        height: 24px;
        border: 1px solid #e2e8f0;
        border-radius: 5px;
        background: #f8fafc;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        padding: 0;
    }

    .fip__icon-btn:hover { background: #f1f5f9; border-color: #cbd5e1; }
    .fip__icon-btn--danger:hover { background: #fef2f2; border-color: #fca5a5; }

    .fip__row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .fip__label {
        width: 52px;
        flex-shrink: 0;
        color: #64748b;
        font-size: 0.72rem;
    }

    .fip__select {
        flex: 1;
        padding: 3px 6px;
        font-size: 0.75rem;
        border: 1px solid #e2e8f0;
        border-radius: 5px;
        background: #fff;
        text-transform: capitalize;
    }

    .fip__range { flex: 1; min-width: 0; accent-color: #3b82f6; }

    .fip__val {
        width: 34px;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: #475569;
        font-size: 0.72rem;
    }

    .fip__color {
        width: 26px;
        height: 22px;
        padding: 0;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        background: none;
        cursor: pointer;
    }

    .fip__field {
        display: flex;
        flex-direction: column;
        gap: 3px;
    }

    .fip__input {
        padding: 5px 8px;
        font-size: 0.75rem;
        border: 1px solid #e2e8f0;
        border-radius: 5px;
        outline: none;
    }

    .fip__input:focus { border-color: #93c5fd; }
</style>
