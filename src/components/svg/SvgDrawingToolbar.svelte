<script>
    /**
     * SvgDrawingToolbar — row 2 of the SVG editor toolbar.
     * Horizontal tool palette + context-sensitive fill/stroke/font options.
     */
    import { svgEditorState } from '../../stores/svg/svgEditorState.svelte.js';
    import SvgColorPicker from './SvgColorPicker.svelte';

    // ── Tool definitions ──────────────────────────────────────────────────────
    const TOOLS = [
        { id: 'select',  label: 'Select',    key: 'V',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-7 1-4 7z"/></svg>` },
        { id: 'rect',    label: 'Rectangle', key: 'R',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="1"/></svg>` },
        { id: 'ellipse', label: 'Ellipse',   key: 'E',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="10" ry="7"/></svg>` },
        { id: 'line',    label: 'Line',      key: 'L',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="20" x2="20" y2="4"/></svg>` },
        { id: 'text',    label: 'Text',      key: 'T',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h8M12 7v12"/></svg>` },
        { id: 'pencil',  label: 'Pencil',    key: 'P',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>` },
        { id: 'node',    label: 'Node Editor', key: 'N',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20 L10 8 L16 14 L20 4"/><circle cx="4" cy="20" r="2" fill="currentColor"/><circle cx="10" cy="8" r="2" fill="currentColor"/><circle cx="16" cy="14" r="2" fill="currentColor"/><circle cx="20" cy="4" r="2" fill="currentColor"/></svg>` },
        { id: 'pen',     label: 'Pen (Bézier)', key: 'B',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20 C6 20 4 14 4 12 C4 10 6 4 12 4 C18 4 20 10 20 12"/><line x1="20" y1="12" x2="20" y2="20"/><circle cx="20" cy="20" r="2" fill="currentColor"/></svg>` },
    ];

    const FONT_FAMILIES = ['sans-serif', 'serif', 'monospace', 'Arial', 'Georgia', 'Verdana', 'Courier New', 'Trebuchet MS'];

    // ── Picker open state ─────────────────────────────────────────────────────
    let fillPickerOpen   = $state(false);
    let strokePickerOpen = $state(false);
    /** @type {HTMLElement|null} */ let fillAnchor   = $state(null);
    /** @type {HTMLElement|null} */ let strokeAnchor = $state(null);

    // ── Read effective values from selection or defaults ─────────────────────
    const sel = $derived(svgEditorState.firstSelected);
    const selType = $derived(sel?.type ?? null);
    const tool = $derived(svgEditorState.activeTool);

    // What we're working on: selected shape type, or active tool
    const context = $derived(selType ?? tool);

    const showFill   = $derived(['rect','ellipse','text','group','polygon','polyline'].includes(context));
    const showStroke = $derived(!['text'].includes(context) && context !== 'select');
    const showText   = $derived(context === 'text');
    const showCtx    = $derived(context !== 'select' || sel !== null);

    // Effective fill / stroke / etc — read from selected element, fall back to defaults
    const effFill    = $derived(sel?.el?.getAttribute('fill')         ?? svgEditorState.defFill);
    const effStroke  = $derived(sel?.el?.getAttribute('stroke')       ?? svgEditorState.defStroke);
    const effStrokeW = $derived(parseFloat(sel?.el?.getAttribute('stroke-width') ?? svgEditorState.defStrokeW));
    const effOpacity = $derived(parseFloat(sel?.el?.getAttribute('opacity') ?? '1'));
    const effFontFamily = $derived(sel?.el?.getAttribute('font-family') ?? svgEditorState.defFontFamily);
    const effFontSize   = $derived(parseFloat(sel?.el?.getAttribute('font-size')   ?? svgEditorState.defFontSize));
    const effBold   = $derived((sel?.el?.getAttribute('font-weight')  ?? 'normal') === 'bold');
    const effItalic = $derived((sel?.el?.getAttribute('font-style')   ?? 'normal') === 'italic');

    // Fill alpha (from fill-opacity attr)
    const effFillAlpha   = $derived(parseFloat(sel?.el?.getAttribute('fill-opacity')   ?? '1'));
    const effStrokeAlpha = $derived(parseFloat(sel?.el?.getAttribute('stroke-opacity') ?? '1'));

    // ── Write helpers ─────────────────────────────────────────────────────────

    function setFill(hex, alpha = effFillAlpha) {
        svgEditorState.defFill = hex;
        if (sel) {
            svgEditorState.updateAttr(sel.id, 'fill', hex);
            if (alpha < 1) svgEditorState.updateAttr(sel.id, 'fill-opacity', alpha);
            else svgEditorState.updateAttr(sel.id, 'fill-opacity', null);
        }
    }

    function setStroke(hex, alpha = effStrokeAlpha) {
        svgEditorState.defStroke = hex;
        if (sel) {
            svgEditorState.updateAttr(sel.id, 'stroke', hex);
            if (alpha < 1) svgEditorState.updateAttr(sel.id, 'stroke-opacity', alpha);
            else svgEditorState.updateAttr(sel.id, 'stroke-opacity', null);
        }
    }

    function setStrokeWidth(w) {
        svgEditorState.defStrokeW = w;
        if (sel) svgEditorState.updateAttr(sel.id, 'stroke-width', w);
    }

    function setOpacity(v) {
        if (sel) svgEditorState.updateAttr(sel.id, 'opacity', v < 1 ? v : null);
    }

    function setFontFamily(v) {
        svgEditorState.defFontFamily = v;
        if (sel) svgEditorState.updateAttr(sel.id, 'font-family', v);
    }

    function setFontSize(v) {
        svgEditorState.defFontSize = v;
        if (sel) svgEditorState.updateAttr(sel.id, 'font-size', v);
    }

    function toggleBold() {
        const next = effBold ? 'normal' : 'bold';
        if (sel) svgEditorState.updateAttr(sel.id, 'font-weight', next);
    }

    function toggleItalic() {
        const next = effItalic ? 'normal' : 'italic';
        if (sel) svgEditorState.updateAttr(sel.id, 'font-style', next);
    }

    function commitChange() {
        if (sel) svgEditorState.pushHistory();
    }

    // ── Swatch color (handle 'none' and undefined) ────────────────────────────
    function swatchStyle(color, alpha = 1) {
        if (!color || color === 'none') return 'background: transparent; border-style: dashed;';
        return `background: ${color}; opacity: ${alpha};`;
    }
</script>

<div class="drawing-toolbar">
    <!-- Tool buttons -->
    <div class="tool-group">
        {#each TOOLS as t}
            <button
                class="tool-btn"
                class:active={tool === t.id}
                onclick={() => (svgEditorState.activeTool = t.id)}
                title="{t.label} ({t.key})"
            >
                {@html t.icon}
            </button>
        {/each}
    </div>

    {#if showCtx}
        <div class="sep"></div>

        <!-- Fill color -->
        {#if showFill}
            <div class="ctx-group">
                <span class="ctx-label">Fill</span>
                <div class="swatch-wrap" bind:this={fillAnchor}>
                    <button
                        class="swatch-btn"
                        style={swatchStyle(effFill, effFillAlpha)}
                        onclick={() => { strokePickerOpen = false; fillPickerOpen = !fillPickerOpen; }}
                        title="Fill color"
                    ></button>
                    {#if fillPickerOpen}
                        <div class="picker-anchor">
                            <SvgColorPicker
                                color={effFill === 'none' ? '#4f8ef7' : effFill}
                                alpha={effFillAlpha}
                                onchange={({color, alpha}) => setFill(color, alpha)}
                                oncommit={commitChange}
                                onclose={() => (fillPickerOpen = false)}
                            />
                        </div>
                    {/if}
                </div>
                <!-- None toggle -->
                <button
                    class="none-btn"
                    class:active={effFill === 'none'}
                    onclick={() => setFill(effFill === 'none' ? svgEditorState.defFill : 'none')}
                    title="No fill"
                >∅</button>
            </div>
        {/if}

        <!-- Stroke color + width -->
        {#if showStroke}
            <div class="ctx-group">
                <span class="ctx-label">Stroke</span>
                <div class="swatch-wrap">
                    <button
                        class="swatch-btn"
                        style={swatchStyle(effStroke, effStrokeAlpha)}
                        onclick={() => { fillPickerOpen = false; strokePickerOpen = !strokePickerOpen; }}
                        title="Stroke color"
                    ></button>
                    {#if strokePickerOpen}
                        <div class="picker-anchor">
                            <SvgColorPicker
                                color={effStroke === 'none' ? '#1a1a1a' : effStroke}
                                alpha={effStrokeAlpha}
                                onchange={({color, alpha}) => setStroke(color, alpha)}
                                oncommit={commitChange}
                                onclose={() => (strokePickerOpen = false)}
                            />
                        </div>
                    {/if}
                </div>
                <button
                    class="none-btn"
                    class:active={effStroke === 'none'}
                    onclick={() => setStroke(effStroke === 'none' ? svgEditorState.defStroke : 'none')}
                    title="No stroke"
                >∅</button>
                <input
                    class="num-input sw-input"
                    type="number" min="0" max="40" step="0.5"
                    value={isNaN(effStrokeW) ? 2 : effStrokeW}
                    oninput={(e) => setStrokeWidth(+e.currentTarget.value)}
                    onchange={commitChange}
                    title="Stroke width"
                />
                <span class="unit-label">px</span>
            </div>
        {/if}

        <!-- Text controls -->
        {#if showText}
            <div class="sep"></div>
            <div class="ctx-group">
                <select
                    class="font-select"
                    value={effFontFamily}
                    onchange={(e) => { setFontFamily(e.currentTarget.value); commitChange(); }}
                    title="Font family"
                >
                    {#each FONT_FAMILIES as f}
                        <option value={f} style="font-family:{f}">{f}</option>
                    {/each}
                </select>

                <input
                    class="num-input fs-input"
                    type="number" min="6" max="288" step="1"
                    value={isNaN(effFontSize) ? 18 : effFontSize}
                    oninput={(e) => setFontSize(+e.currentTarget.value)}
                    onchange={commitChange}
                    title="Font size"
                />

                <button class="fmt-btn" class:active={effBold}   onclick={() => { toggleBold();   commitChange(); }} title="Bold"><b>B</b></button>
                <button class="fmt-btn" class:active={effItalic} onclick={() => { toggleItalic(); commitChange(); }} title="Italic"><i>I</i></button>
            </div>
        {/if}

        <!-- Opacity (when shape selected) -->
        {#if sel}
            <div class="sep"></div>
            <div class="ctx-group">
                <span class="ctx-label">Opacity</span>
                <input
                    class="opacity-slider"
                    type="range" min="0" max="1" step="0.01"
                    value={isNaN(effOpacity) ? 1 : effOpacity}
                    oninput={(e) => setOpacity(+e.currentTarget.value)}
                    onchange={commitChange}
                    title="Opacity"
                />
                <span class="unit-label">{Math.round((isNaN(effOpacity) ? 1 : effOpacity) * 100)}%</span>
            </div>
        {/if}
    {/if}
</div>

<style>
    .drawing-toolbar {
        display: flex;
        align-items: center;
        height: 36px;
        padding: 0 8px;
        gap: 4px;
        background: var(--color-surface, #1a1a2e);
        border-bottom: 1px solid var(--color-border, #2a2a4a);
        flex-shrink: 0;
        overflow-x: auto;
        user-select: none;
    }

    .tool-group {
        display: flex;
        align-items: center;
        gap: 1px;
    }

    .tool-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text-secondary, #aaa);
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
        transition: background 0.1s, color 0.1s;
    }
    .tool-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); color: var(--color-text, #fff); }
    .tool-btn.active { background: rgba(79,142,247,0.2); color: #4f8ef7; }
    .tool-btn :global(svg) { width: 16px; height: 16px; }

    .sep {
        width: 1px;
        height: 20px;
        background: var(--color-border, #2a2a4a);
        flex-shrink: 0;
        margin: 0 2px;
    }

    .ctx-group {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
    }

    .ctx-label {
        font-size: 11px;
        color: var(--color-text-secondary, #888);
        flex-shrink: 0;
    }

    .swatch-wrap {
        position: relative;
        flex-shrink: 0;
    }

    .swatch-btn {
        width: 22px;
        height: 22px;
        border-radius: 4px;
        border: 1px solid var(--color-border, #444);
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
    }

    .picker-anchor {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        z-index: 199;
    }

    .none-btn {
        width: 20px;
        height: 20px;
        border: 1px solid var(--color-border, #444);
        border-radius: 3px;
        background: transparent;
        color: var(--color-text-secondary, #888);
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        flex-shrink: 0;
    }
    .none-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); }
    .none-btn.active { color: #ef4444; border-color: #ef4444; }

    .num-input {
        height: 26px;
        border: 1px solid var(--color-border, #333);
        border-radius: 4px;
        background: var(--color-bg, #0d0d1a);
        color: var(--color-text, #e0e0e0);
        font-size: 12px;
        padding: 0 4px;
        outline: none;
        text-align: center;
        flex-shrink: 0;
    }
    .num-input:focus { border-color: var(--color-primary, #4f46e5); }

    .sw-input { width: 44px; }
    .fs-input { width: 44px; }

    .unit-label {
        font-size: 11px;
        color: var(--color-text-secondary, #888);
        flex-shrink: 0;
    }

    .font-select {
        height: 26px;
        border: 1px solid var(--color-border, #333);
        border-radius: 4px;
        background: var(--color-surface, #1a1a2e);
        color: var(--color-text, #e0e0e0);
        font-size: 12px;
        padding: 0 4px;
        cursor: pointer;
        max-width: 130px;
        flex-shrink: 0;
    }

    .fmt-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border: 1px solid var(--color-border, #333);
        border-radius: 4px;
        background: transparent;
        color: var(--color-text, #e0e0e0);
        cursor: pointer;
        font-size: 13px;
        padding: 0;
        flex-shrink: 0;
    }
    .fmt-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); }
    .fmt-btn.active { background: rgba(79,70,229,0.3); color: #818cf8; border-color: #4f46e5; }

    .opacity-slider {
        width: 72px;
        accent-color: #4f8ef7;
        flex-shrink: 0;
    }
</style>
