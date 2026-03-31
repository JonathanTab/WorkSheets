<script>
    import { svgEditorState } from '../../../stores/svg/svgEditorState.svelte.js';

    let open = $state(true);
    let pngScale = $state(2);
    let jpegQuality = $state(0.9);
    let bgColor = $state('#ffffff');
    let isExporting = $state(false);

    const artboardW = $derived(svgEditorState.artboardW);
    const artboardH = $derived(svgEditorState.artboardH);

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    function exportSvg() {
        const str = svgEditorState.getSvgString();
        const blob = new Blob([str], { type: 'image/svg+xml' });
        downloadBlob(blob, 'drawing.svg');
    }

    async function exportRaster(format) {
        if (isExporting || !svgEditorState.svgEl) return;
        isExporting = true;
        try {
            const svgStr = svgEditorState.getSvgString();
            const w = Math.round(artboardW * pngScale);
            const h = Math.round(artboardH * pngScale);

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');

            // Fill background
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, w, h);

            // Draw SVG via Image
            const blob = new Blob([svgStr], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => { ctx.drawImage(img, 0, 0, w, h); resolve(); };
                img.onerror = reject;
                img.src = url;
            });
            URL.revokeObjectURL(url);

            canvas.toBlob(
                (b) => { if (b) downloadBlob(b, `drawing.${format}`); },
                format === 'jpeg' ? 'image/jpeg' : 'image/png',
                format === 'jpeg' ? jpegQuality : undefined
            );
        } catch (e) {
            console.error('[ExportPanel] export error', e);
        } finally {
            isExporting = false;
        }
    }
</script>

<section class="panel-section">
    <button class="panel-hdr" onclick={() => (open = !open)}>
        <span>Export</span>
        <span class="chevron" class:rotated={!open}>▾</span>
    </button>

    {#if open}
        <div class="panel-body">
            <!-- Canvas info -->
            <div class="row-label">Canvas</div>
            <div class="info-row">
                <span class="dim-text">{artboardW} × {artboardH} px</span>
            </div>

            <!-- Background color -->
            <div class="row">
                <span class="field-label">Background</span>
                <input type="color" class="color-input"
                    bind:value={bgColor}
                    title="Background color for raster export"
                />
                <span class="hex-tag">{bgColor}</span>
            </div>

            <div class="divider"></div>

            <!-- SVG Export -->
            <div class="row-label">SVG</div>
            <button class="export-btn" onclick={exportSvg}>
                ↓ Download SVG
            </button>

            <div class="divider"></div>

            <!-- PNG Export -->
            <div class="row-label">PNG</div>
            <div class="row">
                <span class="field-label">Scale</span>
                <div class="btn-group">
                    {#each [1, 2, 4] as s}
                        <button class="scale-btn" class:active={pngScale === s}
                            onclick={() => (pngScale = s)}
                        >{s}×</button>
                    {/each}
                </div>
                <span class="dim-text">{Math.round(artboardW * pngScale)}×{Math.round(artboardH * pngScale)}</span>
            </div>
            <button class="export-btn" onclick={() => exportRaster('png')} disabled={isExporting}>
                {isExporting ? '…' : '↓ Download PNG'}
            </button>

            <div class="divider"></div>

            <!-- JPEG Export -->
            <div class="row-label">JPEG</div>
            <div class="row">
                <span class="field-label">Quality</span>
                <input class="op-slider" type="range" min="0.1" max="1" step="0.05"
                    bind:value={jpegQuality}
                />
                <span class="op-val">{Math.round(jpegQuality * 100)}%</span>
            </div>
            <button class="export-btn" onclick={() => exportRaster('jpeg')} disabled={isExporting}>
                {isExporting ? '…' : '↓ Download JPEG'}
            </button>
        </div>
    {/if}
</section>

<style>
    .panel-section { border-bottom: 1px solid var(--color-border, #2a2a4a); }

    .panel-hdr {
        display: flex; align-items: center; justify-content: space-between;
        width: 100%; padding: 8px 10px; background: transparent;
        border: none; color: var(--color-text, #e0e0e0); font-size: 12px;
        font-weight: 600; cursor: pointer; text-align: left;
    }
    .panel-hdr:hover { background: var(--color-fill, rgba(255,255,255,0.04)); }
    .chevron { font-size: 11px; transition: transform 0.15s; }
    .chevron.rotated { transform: rotate(-90deg); }

    .panel-body { padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 6px; }

    .row-label { font-size: 11px; color: var(--color-text-secondary, #888); font-weight: 600; margin-top: 2px; }
    .row { display: flex; align-items: center; gap: 6px; }
    .info-row { font-size: 11px; color: var(--color-text-secondary, #777); }
    .dim-text { font-size: 10px; color: var(--color-text-secondary, #666); }

    .field-label { font-size: 11px; color: var(--color-text-secondary, #888); flex-shrink: 0; }
    .hex-tag { font-size: 11px; color: var(--color-text-secondary, #888); font-family: monospace; }

    .color-input {
        width: 26px; height: 26px; padding: 1px; border-radius: 4px;
        border: 1px solid var(--color-border, #444); cursor: pointer; background: none;
    }

    .divider { height: 1px; background: var(--color-border, #2a2a4a); margin: 2px 0; }

    .export-btn {
        width: 100%; height: 30px; border-radius: 5px;
        background: var(--color-primary, #4f46e5); color: #fff;
        border: none; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .export-btn:hover:not(:disabled) { background: #6366f1; }
    .export-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn-group { display: flex; gap: 2px; }
    .scale-btn {
        height: 22px; min-width: 28px; padding: 0 4px;
        border: 1px solid var(--color-border, #333); border-radius: 3px;
        background: transparent; color: var(--color-text-secondary, #aaa);
        font-size: 11px; cursor: pointer;
    }
    .scale-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); }
    .scale-btn.active { background: rgba(79,70,229,0.25); color: #818cf8; border-color: #4f46e5; }

    .op-slider { flex: 1; min-width: 40px; accent-color: #4f8ef7; }
    .op-val { font-size: 10px; color: var(--color-text-secondary, #888); min-width: 28px; }
</style>
