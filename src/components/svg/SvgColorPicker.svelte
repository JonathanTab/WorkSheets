<script>
    /**
     * SvgColorPicker — floating HSV color picker popover.
     *
     * Props:
     *   color      — current hex color string (e.g. '#4f8ef7')
     *   alpha      — 0..1 opacity (default 1)
     *   showAlpha  — whether to show the alpha slider
     *   onchange({ color, alpha }) — live update while dragging
     *   oncommit()                 — called once on pointer-up (push history)
     *   onclose()                  — called when backdrop clicked
     */
    import { onMount } from 'svelte';

    let {
        color    = '#4f8ef7',
        alpha    = 1,
        showAlpha = true,
        onchange = () => {},
        oncommit = () => {},
        onclose  = () => {},
    } = $props();

    // ── Color math ────────────────────────────────────────────────────────────

    function hexToRgb(hex) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        if (hex.length !== 6) return [79, 142, 247];
        const n = parseInt(hex, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
    }

    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0;
        if (d !== 0) {
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
            else if (max === g) h = ((b - r) / d + 2) * 60;
            else h = ((r - g) / d + 4) * 60;
        }
        return [h, max === 0 ? 0 : d / max, max];
    }

    function hsvToRgb(h, s, v) {
        h = ((h % 360) + 360) % 360;
        const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
        let r = 0, g = 0, b = 0;
        if      (h < 60)  { r=c; g=x; }
        else if (h < 120) { r=x; g=c; }
        else if (h < 180) { g=c; b=x; }
        else if (h < 240) { g=x; b=c; }
        else if (h < 300) { r=x; b=c; }
        else              { r=c; b=x; }
        return [(r+m)*255, (g+m)*255, (b+m)*255];
    }

    // ── Internal HSV state (derived from incoming color) ─────────────────────

    let [initR, initG, initB] = hexToRgb(color);
    let [hue, sat, val] = rgbToHsv(initR, initG, initB);

    let hexInput = $state(color);
    let alphaVal = $state(alpha);
    let isDraggingSv = false, isDraggingHue = false, isDraggingAlpha = false;

    // ── Canvas refs ───────────────────────────────────────────────────────────
    /** @type {HTMLCanvasElement} */ let svCanvas = $state(null);
    /** @type {HTMLCanvasElement} */ let hueCanvas = $state(null);
    /** @type {HTMLCanvasElement} */ let alphaCanvas = $state(null);

    // ── Draw canvases ─────────────────────────────────────────────────────────

    function drawSv() {
        if (!svCanvas) return;
        const ctx = svCanvas.getContext('2d');
        const w = svCanvas.width, h = svCanvas.height;
        // Base hue colour → white (left) → black (bottom)
        const [hr, hg, hb] = hsvToRgb(hue, 1, 1);
        const hueColor = `rgb(${Math.round(hr)},${Math.round(hg)},${Math.round(hb)})`;
        ctx.fillStyle = hueColor;
        ctx.fillRect(0, 0, w, h);
        const wGrad = ctx.createLinearGradient(0, 0, w, 0);
        wGrad.addColorStop(0, 'rgba(255,255,255,1)');
        wGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = wGrad;
        ctx.fillRect(0, 0, w, h);
        const bGrad = ctx.createLinearGradient(0, 0, 0, h);
        bGrad.addColorStop(0, 'rgba(0,0,0,0)');
        bGrad.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = bGrad;
        ctx.fillRect(0, 0, w, h);
    }

    function drawHue() {
        if (!hueCanvas) return;
        const ctx = hueCanvas.getContext('2d');
        const w = hueCanvas.width, h = hueCanvas.height;
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        for (let i = 0; i <= 6; i++) {
            const [r, g, b] = hsvToRgb(i * 60, 1, 1);
            grad.addColorStop(i / 6, `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`);
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }

    function drawAlpha() {
        if (!alphaCanvas) return;
        const ctx = alphaCanvas.getContext('2d');
        const w = alphaCanvas.width, h = alphaCanvas.height;
        // Checkerboard
        ctx.clearRect(0, 0, w, h);
        const sz = 6;
        for (let x = 0; x < w; x += sz) {
            for (let y = 0; y < h; y += sz) {
                ctx.fillStyle = ((Math.floor(x/sz) + Math.floor(y/sz)) % 2) ? '#aaa' : '#fff';
                ctx.fillRect(x, y, sz, sz);
            }
        }
        const [r, g, b] = hsvToRgb(hue, sat, val);
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},0)`);
        grad.addColorStop(1, `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},1)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }

    onMount(() => {
        drawSv(); drawHue(); drawAlpha();
    });

    $effect(() => { hue; sat; val; drawSv(); drawAlpha(); });
    $effect(() => { hue; drawHue(); });

    // ── Current computed hex ──────────────────────────────────────────────────
    const currentHex = $derived.by(() => {
        const [r, g, b] = hsvToRgb(hue, sat, val);
        return rgbToHex(r, g, b);
    });

    // Emit on any change
    $effect(() => {
        onchange({ color: currentHex, alpha: alphaVal });
        hexInput = currentHex;
    });

    // ── SV pointer ────────────────────────────────────────────────────────────

    function svPointerDown(e) {
        isDraggingSv = true;
        svCanvas.setPointerCapture(e.pointerId);
        updateSv(e);
    }
    function svPointerMove(e) { if (isDraggingSv) updateSv(e); }
    function svPointerUp(e) { isDraggingSv = false; oncommit(); }

    function updateSv(e) {
        const r = svCanvas.getBoundingClientRect();
        sat = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        val = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    }

    // ── Hue pointer ───────────────────────────────────────────────────────────

    function huePointerDown(e) {
        isDraggingHue = true;
        hueCanvas.setPointerCapture(e.pointerId);
        updateHue(e);
    }
    function huePointerMove(e) { if (isDraggingHue) updateHue(e); }
    function huePointerUp() { isDraggingHue = false; oncommit(); }

    function updateHue(e) {
        const r = hueCanvas.getBoundingClientRect();
        hue = Math.max(0, Math.min(359.99, ((e.clientX - r.left) / r.width) * 360));
    }

    // ── Alpha pointer ─────────────────────────────────────────────────────────

    function alphaPointerDown(e) {
        isDraggingAlpha = true;
        alphaCanvas.setPointerCapture(e.pointerId);
        updateAlpha(e);
    }
    function alphaPointerMove(e) { if (isDraggingAlpha) updateAlpha(e); }
    function alphaPointerUp() { isDraggingAlpha = false; oncommit(); }

    function updateAlpha(e) {
        const r = alphaCanvas.getBoundingClientRect();
        alphaVal = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    }

    // ── Hex input ─────────────────────────────────────────────────────────────

    function handleHexInput(e) {
        const v = e.currentTarget.value.trim();
        hexInput = v;
        const hex = v.startsWith('#') ? v : '#' + v;
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
            const [r, g, b] = hexToRgb(hex);
            [hue, sat, val] = rgbToHsv(r, g, b);
        }
    }

    function handleHexCommit() { oncommit(); }

    // ── Cursor positions ──────────────────────────────────────────────────────
    const svCursorX = $derived(sat * 150);
    const svCursorY = $derived((1 - val) * 120);
    const hueCursorX = $derived((hue / 360) * 150);
    const alphaCursorX = $derived(alphaVal * 150);

    // Preview color
    const previewStyle = $derived(`background: linear-gradient(${currentHex}, ${currentHex}), url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='4' height='4' fill='%23aaa'/%3E%3Crect x='4' y='4' width='4' height='4' fill='%23aaa'/%3E%3Crect x='0' y='4' width='4' height='4' fill='%23fff'/%3E%3Crect x='4' y='0' width='4' height='4' fill='%23fff'/%3E%3C/svg%3E"); background-blend-mode: normal; opacity: ${alphaVal};`);
</script>

<!-- Backdrop to close on outside click -->
<div class="picker-backdrop" onpointerdown={onclose}></div>

<div class="color-picker" onpointerdown={(e) => e.stopPropagation()}>
    <!-- SV square -->
    <div class="sv-wrap">
        <canvas
            bind:this={svCanvas}
            width="150" height="120"
            class="sv-canvas"
            onpointerdown={svPointerDown}
            onpointermove={svPointerMove}
            onpointerup={svPointerUp}
        ></canvas>
        <!-- Cursor -->
        <div class="sv-cursor" style="left:{svCursorX}px; top:{svCursorY}px;"></div>
    </div>

    <div class="sliders">
        <!-- Hue slider -->
        <div class="slider-row">
            <div class="preview-swatch">
                <div class="preview-inner" style={previewStyle}></div>
            </div>
            <div class="hue-wrap">
                <canvas
                    bind:this={hueCanvas}
                    width="150" height="12"
                    class="hue-canvas"
                    onpointerdown={huePointerDown}
                    onpointermove={huePointerMove}
                    onpointerup={huePointerUp}
                ></canvas>
                <div class="slider-thumb" style="left:{hueCursorX}px;"></div>
            </div>
        </div>

        <!-- Alpha slider -->
        {#if showAlpha}
            <div class="slider-row">
                <div class="alpha-wrap">
                    <canvas
                        bind:this={alphaCanvas}
                        width="150" height="12"
                        class="alpha-canvas"
                        onpointerdown={alphaPointerDown}
                        onpointermove={alphaPointerMove}
                        onpointerup={alphaPointerUp}
                    ></canvas>
                    <div class="slider-thumb" style="left:{alphaCursorX}px;"></div>
                </div>
            </div>
        {/if}
    </div>

    <!-- Hex input -->
    <div class="hex-row">
        <label class="hex-label">HEX</label>
        <input
            class="hex-input"
            type="text"
            value={hexInput}
            oninput={handleHexInput}
            onblur={handleHexCommit}
            onkeydown={(e) => { if (e.key === 'Enter') handleHexCommit(); }}
            spellcheck="false"
        />
        {#if showAlpha}
            <label class="alpha-label">A</label>
            <input
                class="alpha-num"
                type="number"
                min="0" max="100" step="1"
                value={Math.round(alphaVal * 100)}
                oninput={(e) => { alphaVal = Math.max(0, Math.min(1, +e.currentTarget.value / 100)); }}
                onblur={oncommit}
            />
            <span class="alpha-pct">%</span>
        {/if}
    </div>
</div>

<style>
    .picker-backdrop {
        position: fixed;
        inset: 0;
        z-index: 198;
    }

    .color-picker {
        position: absolute;
        z-index: 199;
        background: var(--color-surface, #1a1a2e);
        border: 1px solid var(--color-border, #333);
        border-radius: 8px;
        padding: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        width: 172px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        user-select: none;
    }

    .sv-wrap {
        position: relative;
        width: 150px;
        height: 120px;
        cursor: crosshair;
        border-radius: 4px;
        overflow: hidden;
    }

    .sv-canvas {
        display: block;
        width: 150px;
        height: 120px;
        touch-action: none;
    }

    .sv-cursor {
        position: absolute;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 2px solid white;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.4);
        transform: translate(-50%, -50%);
        pointer-events: none;
    }

    .sliders {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .slider-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .preview-swatch {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: 2px solid var(--color-border, #333);
        overflow: hidden;
        flex-shrink: 0;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='4' height='4' fill='%23aaa'/%3E%3Crect x='4' y='4' width='4' height='4' fill='%23aaa'/%3E%3Crect x='0' y='4' width='4' height='4' fill='%23fff'/%3E%3Crect x='4' y='0' width='4' height='4' fill='%23fff'/%3E%3C/svg%3E");
    }

    .preview-inner {
        width: 100%;
        height: 100%;
    }

    .hue-wrap,
    .alpha-wrap {
        position: relative;
        flex: 1;
        height: 12px;
        border-radius: 6px;
        overflow: visible;
        cursor: pointer;
    }

    .hue-canvas,
    .alpha-canvas {
        display: block;
        width: 100%;
        height: 12px;
        border-radius: 6px;
        touch-action: none;
    }

    .alpha-wrap {
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='4' height='4' fill='%23aaa'/%3E%3Crect x='4' y='4' width='4' height='4' fill='%23aaa'/%3E%3Crect x='0' y='4' width='4' height='4' fill='%23fff'/%3E%3Crect x='4' y='0' width='4' height='4' fill='%23fff'/%3E%3C/svg%3E");
        background-size: 8px 8px;
        border-radius: 6px;
    }

    .slider-thumb {
        position: absolute;
        top: 50%;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: white;
        border: 2px solid rgba(0,0,0,0.3);
        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
        transform: translate(-50%, -50%);
        pointer-events: none;
    }

    .hex-row {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .hex-label,
    .alpha-label {
        font-size: 10px;
        color: var(--color-text-secondary, #888);
        flex-shrink: 0;
        width: 24px;
        text-align: center;
    }

    .hex-input {
        flex: 1;
        height: 26px;
        background: var(--color-bg, #0d0d1a);
        border: 1px solid var(--color-border, #333);
        border-radius: 4px;
        color: var(--color-text, #e0e0e0);
        font-size: 11px;
        font-family: monospace;
        padding: 0 6px;
        outline: none;
        min-width: 0;
    }

    .hex-input:focus {
        border-color: var(--color-primary, #4f46e5);
    }

    .alpha-num {
        width: 38px;
        height: 26px;
        background: var(--color-bg, #0d0d1a);
        border: 1px solid var(--color-border, #333);
        border-radius: 4px;
        color: var(--color-text, #e0e0e0);
        font-size: 11px;
        padding: 0 4px;
        outline: none;
        text-align: center;
    }

    .alpha-num:focus {
        border-color: var(--color-primary, #4f46e5);
    }

    .alpha-pct {
        font-size: 11px;
        color: var(--color-text-secondary, #888);
    }
</style>
