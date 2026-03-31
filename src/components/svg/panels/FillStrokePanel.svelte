<script>
    import { svgEditorState } from '../../../stores/svg/svgEditorState.svelte.js';
    import SvgColorPicker from '../SvgColorPicker.svelte';

    let open = $state(true);
    let fillPickerOpen   = $state(false);
    let strokePickerOpen = $state(false);

    const sel = $derived(svgEditorState.firstSelected);

    const fill        = $derived(sel?.el?.getAttribute('fill')          ?? svgEditorState.defFill);
    const fillOp      = $derived(parseFloat(sel?.el?.getAttribute('fill-opacity')   ?? '1'));
    const stroke      = $derived(sel?.el?.getAttribute('stroke')        ?? svgEditorState.defStroke);
    const strokeOp    = $derived(parseFloat(sel?.el?.getAttribute('stroke-opacity') ?? '1'));
    const strokeW     = $derived(parseFloat(sel?.el?.getAttribute('stroke-width')   ?? svgEditorState.defStrokeW));
    const dasharray   = $derived(sel?.el?.getAttribute('stroke-dasharray') ?? '');
    const linecap     = $derived(sel?.el?.getAttribute('stroke-linecap')  ?? 'round');
    const linejoin    = $derived(sel?.el?.getAttribute('stroke-linejoin') ?? 'round');

    const fillNone   = $derived(fill   === 'none');
    const strokeNone = $derived(stroke === 'none');

    function setAttr(attr, val) {
        svgEditorState.defFill; // touch to keep reactive
        if (!sel) return;
        if (val === null) sel.el.removeAttribute(attr);
        else sel.el.setAttribute(attr, String(val));
    }

    function commit() { if (sel) svgEditorState.pushHistory(); }

    function applyFill(hex, alpha) {
        svgEditorState.defFill = hex;
        setAttr('fill', hex);
        setAttr('fill-opacity', alpha < 1 ? alpha : null);
    }

    function applyStroke(hex, alpha) {
        svgEditorState.defStroke = hex;
        setAttr('stroke', hex);
        setAttr('stroke-opacity', alpha < 1 ? alpha : null);
    }

    function toggleFillNone() {
        applyFill(fillNone ? svgEditorState.defFill : 'none', fillOp);
        commit();
    }

    function toggleStrokeNone() {
        applyStroke(strokeNone ? svgEditorState.defStroke : 'none', strokeOp);
        commit();
    }

    const DASH_PRESETS = [
        { label: '—',      value: '',          title: 'Solid' },
        { label: '- -',    value: '8 4',        title: 'Dashed' },
        { label: '···',    value: '2 3',        title: 'Dotted' },
        { label: '-·-',    value: '8 3 2 3',    title: 'Dash-dot' },
    ];
    const LINECAPS  = ['butt', 'round', 'square'];
    const LINEJOINS = ['miter', 'round', 'bevel'];

    function swatchBg(color) {
        if (!color || color === 'none') return 'transparent';
        return color;
    }
</script>

<section class="panel-section">
    <button class="panel-hdr" onclick={() => (open = !open)}>
        <span>Fill &amp; Stroke</span>
        <span class="chevron" class:rotated={!open}>▾</span>
    </button>

    {#if open}
        <div class="panel-body">
            <!-- Fill -->
            <div class="row-label">Fill</div>
            <div class="row">
                <div class="swatch-wrap">
                    <button
                        class="swatch"
                        style="background:{swatchBg(fill)}; {fillNone ? 'border-style:dashed;' : ''}"
                        onclick={() => { if (!fillNone) { strokePickerOpen=false; fillPickerOpen=!fillPickerOpen; } }}
                        title="Fill color"
                    ></button>
                    {#if fillPickerOpen}
                        <div class="picker-pop">
                            <SvgColorPicker
                                color={fillNone ? '#4f8ef7' : fill}
                                alpha={isNaN(fillOp) ? 1 : fillOp}
                                onchange={({color, alpha}) => applyFill(color, alpha)}
                                oncommit={commit}
                                onclose={() => (fillPickerOpen = false)}
                            />
                        </div>
                    {/if}
                </div>
                <button class="none-btn" class:active={fillNone} onclick={toggleFillNone} title="No fill">∅</button>
                <span class="hex-tag">{fillNone ? 'none' : fill}</span>
                {#if !fillNone}
                    <input class="op-slider" type="range" min="0" max="1" step="0.01"
                        value={isNaN(fillOp) ? 1 : fillOp}
                        oninput={(e) => { setAttr('fill-opacity', +e.currentTarget.value < 1 ? +e.currentTarget.value : null); }}
                        onchange={commit}
                        title="Fill opacity"
                    />
                    <span class="op-val">{Math.round((isNaN(fillOp)?1:fillOp)*100)}%</span>
                {/if}
            </div>

            <div class="divider"></div>

            <!-- Stroke -->
            <div class="row-label">Stroke</div>
            <div class="row">
                <div class="swatch-wrap">
                    <button
                        class="swatch"
                        style="background:{swatchBg(stroke)}; {strokeNone ? 'border-style:dashed;' : ''}"
                        onclick={() => { if (!strokeNone) { fillPickerOpen=false; strokePickerOpen=!strokePickerOpen; } }}
                        title="Stroke color"
                    ></button>
                    {#if strokePickerOpen}
                        <div class="picker-pop">
                            <SvgColorPicker
                                color={strokeNone ? '#1a1a1a' : stroke}
                                alpha={isNaN(strokeOp) ? 1 : strokeOp}
                                onchange={({color, alpha}) => applyStroke(color, alpha)}
                                oncommit={commit}
                                onclose={() => (strokePickerOpen = false)}
                            />
                        </div>
                    {/if}
                </div>
                <button class="none-btn" class:active={strokeNone} onclick={toggleStrokeNone} title="No stroke">∅</button>
                <span class="hex-tag">{strokeNone ? 'none' : stroke}</span>
            </div>

            {#if !strokeNone}
                <div class="row">
                    <span class="field-label">Width</span>
                    <input class="num-input" type="number" min="0" max="100" step="0.5"
                        value={isNaN(strokeW) ? 2 : strokeW}
                        oninput={(e) => { svgEditorState.defStrokeW = +e.currentTarget.value; setAttr('stroke-width', +e.currentTarget.value); }}
                        onchange={commit}
                    />
                    <span class="unit">px</span>
                    {#if !fillNone || true}
                        <input class="op-slider" type="range" min="0" max="1" step="0.01"
                            value={isNaN(strokeOp) ? 1 : strokeOp}
                            oninput={(e) => { setAttr('stroke-opacity', +e.currentTarget.value < 1 ? +e.currentTarget.value : null); }}
                            onchange={commit}
                            title="Stroke opacity"
                        />
                        <span class="op-val">{Math.round((isNaN(strokeOp)?1:strokeOp)*100)}%</span>
                    {/if}
                </div>

                <!-- Dash presets -->
                <div class="row">
                    <span class="field-label">Dash</span>
                    <div class="btn-group">
                        {#each DASH_PRESETS as dp}
                            <button
                                class="icon-btn"
                                class:active={dasharray === dp.value}
                                onclick={() => { setAttr('stroke-dasharray', dp.value || null); commit(); }}
                                title={dp.title}
                            >{dp.label}</button>
                        {/each}
                    </div>
                </div>

                <!-- Linecap / Linejoin -->
                <div class="row">
                    <span class="field-label">Cap</span>
                    <div class="btn-group">
                        {#each LINECAPS as lc}
                            <button class="icon-btn" class:active={linecap===lc}
                                onclick={() => { setAttr('stroke-linecap', lc); commit(); }}
                                title={lc}
                            >{lc[0].toUpperCase()}</button>
                        {/each}
                    </div>
                    <span class="field-label" style="margin-left:6px">Join</span>
                    <div class="btn-group">
                        {#each LINEJOINS as lj}
                            <button class="icon-btn" class:active={linejoin===lj}
                                onclick={() => { setAttr('stroke-linejoin', lj); commit(); }}
                                title={lj}
                            >{lj[0].toUpperCase()}</button>
                        {/each}
                    </div>
                </div>
            {/if}
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
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

    .swatch-wrap { position: relative; }
    .swatch {
        width: 24px; height: 24px; border-radius: 4px;
        border: 1px solid var(--color-border, #444); cursor: pointer; padding: 0; flex-shrink: 0;
    }
    .picker-pop { position: absolute; top: calc(100% + 4px); left: 0; z-index: 200; }

    .none-btn {
        width: 22px; height: 22px; border: 1px solid var(--color-border, #444);
        border-radius: 3px; background: transparent; color: var(--color-text-secondary, #888);
        font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
    }
    .none-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); }
    .none-btn.active { color: #ef4444; border-color: #ef4444; }

    .hex-tag { font-size: 11px; color: var(--color-text-secondary, #888); font-family: monospace; }

    .op-slider { flex: 1; min-width: 40px; max-width: 60px; accent-color: #4f8ef7; }
    .op-val { font-size: 10px; color: var(--color-text-secondary, #888); min-width: 28px; }

    .divider { height: 1px; background: var(--color-border, #2a2a4a); margin: 2px 0; }

    .field-label { font-size: 11px; color: var(--color-text-secondary, #888); flex-shrink: 0; }
    .num-input {
        width: 52px; height: 24px; background: var(--color-bg, #0d0d1a);
        border: 1px solid var(--color-border, #333); border-radius: 4px;
        color: var(--color-text, #e0e0e0); font-size: 12px; padding: 0 4px; outline: none; text-align: center;
    }
    .num-input:focus { border-color: var(--color-primary, #4f46e5); }
    .unit { font-size: 11px; color: var(--color-text-secondary, #888); }

    .btn-group { display: flex; gap: 2px; }
    .icon-btn {
        height: 22px; min-width: 22px; padding: 0 5px;
        border: 1px solid var(--color-border, #333); border-radius: 3px;
        background: transparent; color: var(--color-text-secondary, #aaa);
        font-size: 11px; cursor: pointer;
    }
    .icon-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); color: var(--color-text, #fff); }
    .icon-btn.active { background: rgba(79,70,229,0.25); color: #818cf8; border-color: #4f46e5; }
</style>
