<script>
    import { svgEditorState } from '../../../stores/svg/svgEditorState.svelte.js';

    let open = $state(true);

    const sel = $derived(svgEditorState.firstSelected);
    const isText = $derived(sel?.type === 'text');

    const fontSize   = $derived(parseFloat(sel?.el?.getAttribute('font-size')   ?? svgEditorState.defFontSize));
    const fontFamily = $derived(sel?.el?.getAttribute('font-family') ?? svgEditorState.defFontFamily);
    const fontWeight = $derived(sel?.el?.getAttribute('font-weight') ?? 'normal');
    const fontStyle  = $derived(sel?.el?.getAttribute('font-style')  ?? 'normal');
    const textDecor  = $derived(sel?.el?.getAttribute('text-decoration') ?? 'none');
    const textAnchor = $derived(sel?.el?.getAttribute('text-anchor') ?? 'start');
    const lineHeight = $derived(parseFloat(sel?.el?.getAttribute('line-height') ?? '1.2'));

    const FAMILIES = [
        'sans-serif', 'serif', 'monospace',
        'Arial', 'Verdana', 'Helvetica', 'Tahoma',
        'Georgia', 'Times New Roman',
        'Courier New', 'Trebuchet MS',
    ];

    function setAttr(attr, val) {
        if (!sel) {
            // update defaults
            if (attr === 'font-size')   svgEditorState.defFontSize = val;
            if (attr === 'font-family') svgEditorState.defFontFamily = val;
            return;
        }
        if (val === null || val === undefined) sel.el.removeAttribute(attr);
        else sel.el.setAttribute(attr, String(val));
    }

    function commit() { if (sel) svgEditorState.pushHistory(); }

    function toggleWeight() {
        const next = fontWeight === 'bold' ? 'normal' : 'bold';
        setAttr('font-weight', next);
        commit();
    }
    function toggleStyle() {
        const next = fontStyle === 'italic' ? 'normal' : 'italic';
        setAttr('font-style', next);
        commit();
    }
    function toggleDecor(val) {
        const next = textDecor === val ? 'none' : val;
        setAttr('text-decoration', next === 'none' ? null : next);
        commit();
    }
    function setAnchor(a) {
        setAttr('text-anchor', a);
        commit();
    }
</script>

<section class="panel-section">
    <button class="panel-hdr" onclick={() => (open = !open)}>
        <span>Text &amp; Font</span>
        <span class="chevron" class:rotated={!open}>▾</span>
    </button>

    {#if open}
        <div class="panel-body">
            {#if sel && !isText}
                <p class="hint">Select a text element to edit font properties.</p>
            {:else}
                <!-- Font family -->
                <div class="row">
                    <span class="field-label">Font</span>
                    <select class="family-select"
                        value={fontFamily}
                        onchange={(e) => { setAttr('font-family', e.currentTarget.value); commit(); }}
                    >
                        {#each FAMILIES as f}
                            <option value={f} style="font-family:{f}">{f}</option>
                        {/each}
                    </select>
                </div>

                <!-- Size -->
                <div class="row">
                    <span class="field-label">Size</span>
                    <input class="num-input" type="number" min="1" max="999" step="1"
                        value={isNaN(fontSize) ? 18 : fontSize}
                        oninput={(e) => { setAttr('font-size', +e.currentTarget.value); }}
                        onchange={commit}
                    />
                    <span class="unit">px</span>
                </div>

                <!-- Style toggles -->
                <div class="row">
                    <span class="field-label">Style</span>
                    <div class="btn-group">
                        <button class="fmt-btn" class:active={fontWeight === 'bold'}
                            onclick={toggleWeight} title="Bold"><b>B</b></button>
                        <button class="fmt-btn" class:active={fontStyle === 'italic'}
                            onclick={toggleStyle} title="Italic"><i>I</i></button>
                        <button class="fmt-btn" class:active={textDecor === 'underline'}
                            onclick={() => toggleDecor('underline')} title="Underline"><u>U</u></button>
                        <button class="fmt-btn" class:active={textDecor === 'line-through'}
                            onclick={() => toggleDecor('line-through')} title="Strikethrough"><s>S</s></button>
                    </div>
                </div>

                <!-- Alignment -->
                <div class="row">
                    <span class="field-label">Align</span>
                    <div class="btn-group">
                        <button class="icon-btn" class:active={textAnchor === 'start'}
                            onclick={() => setAnchor('start')} title="Left">&#8676;</button>
                        <button class="icon-btn" class:active={textAnchor === 'middle'}
                            onclick={() => setAnchor('middle')} title="Center">&#8596;</button>
                        <button class="icon-btn" class:active={textAnchor === 'end'}
                            onclick={() => setAnchor('end')} title="Right">&#8677;</button>
                    </div>
                </div>

                <!-- Line height -->
                {#if isText}
                <div class="row">
                    <span class="field-label">Leading</span>
                    <input class="num-input" type="number" min="0.5" max="5" step="0.1"
                        value={isNaN(lineHeight) ? 1.2 : lineHeight}
                        oninput={(e) => { setAttr('line-height', +e.currentTarget.value); }}
                        onchange={commit}
                    />
                    <span class="unit">×</span>
                </div>
                {/if}
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

    .hint { font-size: 11px; color: var(--color-text-secondary, #666); font-style: italic; margin: 0; }

    .row { display: flex; align-items: center; gap: 6px; }
    .field-label { font-size: 11px; color: var(--color-text-secondary, #888); flex-shrink: 0; min-width: 36px; }

    .family-select {
        flex: 1; height: 26px; background: var(--color-bg, #0d0d1a);
        border: 1px solid var(--color-border, #333); border-radius: 4px;
        color: var(--color-text, #e0e0e0); font-size: 12px; padding: 0 4px; outline: none;
    }
    .family-select:focus { border-color: var(--color-primary, #4f46e5); }

    .num-input {
        width: 52px; height: 24px; background: var(--color-bg, #0d0d1a);
        border: 1px solid var(--color-border, #333); border-radius: 4px;
        color: var(--color-text, #e0e0e0); font-size: 12px; padding: 0 4px; outline: none; text-align: center;
    }
    .num-input:focus { border-color: var(--color-primary, #4f46e5); }
    .unit { font-size: 11px; color: var(--color-text-secondary, #888); }

    .btn-group { display: flex; gap: 2px; }
    .fmt-btn, .icon-btn {
        height: 24px; min-width: 24px; padding: 0 6px;
        border: 1px solid var(--color-border, #333); border-radius: 3px;
        background: transparent; color: var(--color-text-secondary, #aaa);
        font-size: 12px; cursor: pointer;
    }
    .fmt-btn:hover, .icon-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); color: var(--color-text, #fff); }
    .fmt-btn.active, .icon-btn.active { background: rgba(79,70,229,0.25); color: #818cf8; border-color: #4f46e5; }
</style>
