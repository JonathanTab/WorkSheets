<script>
    import { svgEditorState } from '../../../stores/svg/svgEditorState.svelte.js';

    let open = $state(true);

    const selCount = $derived(svgEditorState.selectedIds.size);
    const sel = $derived(svgEditorState.firstSelected);

    // Position / size from first selected shape
    const vbbox = $derived(sel ? svgEditorState.getVisualBBox(sel.id) : null);
    const x = $derived(vbbox ? Math.round(vbbox.x * 10) / 10 : 0);
    const y = $derived(vbbox ? Math.round(vbbox.y * 10) / 10 : 0);
    const w = $derived(vbbox ? Math.round(vbbox.w * 10) / 10 : 0);
    const h = $derived(vbbox ? Math.round(vbbox.h * 10) / 10 : 0);

    // Rotation
    const rot = $derived(sel ? Math.round(svgEditorState.getRotation(sel.id) * 10) / 10 : 0);

    let lockAspect = $state(false);

    function align(type) {
        svgEditorState.alignSelected(type);
    }
    function distribute(dir) {
        svgEditorState.distributeSelected(dir);
    }

    function setX(val) {
        if (!sel) return;
        svgEditorState.setPosition(sel.id, +val, y);
        svgEditorState.pushHistory();
    }
    function setY(val) {
        if (!sel) return;
        svgEditorState.setPosition(sel.id, x, +val);
        svgEditorState.pushHistory();
    }
    function setW(val) {
        if (!sel) return;
        const nw = +val;
        const nh = lockAspect && w > 0 ? (nw / w) * h : h;
        svgEditorState.setSize(sel.id, nw, nh);
        svgEditorState.pushHistory();
    }
    function setH(val) {
        if (!sel) return;
        const nh = +val;
        const nw = lockAspect && h > 0 ? (nh / h) * w : w;
        svgEditorState.setSize(sel.id, nw, nh);
        svgEditorState.pushHistory();
    }
    function setRot(val) {
        if (!sel) return;
        svgEditorState.setRotation(sel.id, +val);
        svgEditorState.pushHistory();
    }
</script>

<section class="panel-section">
    <button class="panel-hdr" onclick={() => (open = !open)}>
        <span>Align &amp; Transform</span>
        <span class="chevron" class:rotated={!open}>▾</span>
    </button>

    {#if open}
        <div class="panel-body">

            <!-- Align buttons -->
            <div class="row-label">Align</div>
            <div class="align-grid">
                <button class="align-btn" onclick={() => align('left')}    title="Align left edges">⊣</button>
                <button class="align-btn" onclick={() => align('centerH')} title="Center horizontally">⊕</button>
                <button class="align-btn" onclick={() => align('right')}   title="Align right edges">⊢</button>
                <button class="align-btn" onclick={() => align('top')}     title="Align top edges">⊤</button>
                <button class="align-btn" onclick={() => align('centerV')} title="Center vertically">⊕</button>
                <button class="align-btn" onclick={() => align('bottom')}  title="Align bottom edges">⊥</button>
            </div>

            <!-- Distribute (needs ≥3 shapes) -->
            {#if selCount >= 3}
                <div class="row-label" style="margin-top:4px">Distribute</div>
                <div class="row">
                    <button class="dist-btn" onclick={() => distribute('h')} title="Distribute horizontally">
                        ↔ H
                    </button>
                    <button class="dist-btn" onclick={() => distribute('v')} title="Distribute vertically">
                        ↕ V
                    </button>
                </div>
            {/if}

            <div class="divider"></div>

            <!-- Position & Size -->
            <div class="row-label">Position &amp; Size</div>
            <div class="row">
                <span class="field-label">X</span>
                <input class="num-input" type="number" step="1"
                    value={x} disabled={!sel}
                    onchange={(e) => setX(e.currentTarget.value)}
                />
                <span class="field-label" style="margin-left:4px">Y</span>
                <input class="num-input" type="number" step="1"
                    value={y} disabled={!sel}
                    onchange={(e) => setY(e.currentTarget.value)}
                />
            </div>
            <div class="row">
                <span class="field-label">W</span>
                <input class="num-input" type="number" min="0" step="1"
                    value={w} disabled={!sel}
                    onchange={(e) => setW(e.currentTarget.value)}
                />
                <button class="lock-btn" class:active={lockAspect}
                    onclick={() => (lockAspect = !lockAspect)}
                    title={lockAspect ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                >⛓</button>
                <span class="field-label">H</span>
                <input class="num-input" type="number" min="0" step="1"
                    value={h} disabled={!sel}
                    onchange={(e) => setH(e.currentTarget.value)}
                />
            </div>

            <!-- Rotation -->
            <div class="row">
                <span class="field-label">Rotate</span>
                <input class="num-input" type="number" min="-360" max="360" step="1"
                    value={rot} disabled={!sel}
                    onchange={(e) => setRot(e.currentTarget.value)}
                />
                <span class="unit">°</span>
            </div>
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
    .row { display: flex; align-items: center; gap: 4px; }

    .align-grid {
        display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px;
    }
    .align-btn {
        height: 26px; border: 1px solid var(--color-border, #333); border-radius: 3px;
        background: transparent; color: var(--color-text-secondary, #aaa);
        font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .align-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); color: var(--color-text, #fff); }

    .dist-btn {
        flex: 1; height: 26px; border: 1px solid var(--color-border, #333); border-radius: 3px;
        background: transparent; color: var(--color-text-secondary, #aaa);
        font-size: 11px; cursor: pointer;
    }
    .dist-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); color: var(--color-text, #fff); }

    .divider { height: 1px; background: var(--color-border, #2a2a4a); margin: 2px 0; }

    .field-label { font-size: 11px; color: var(--color-text-secondary, #888); flex-shrink: 0; }
    .num-input {
        width: 52px; height: 24px; background: var(--color-bg, #0d0d1a);
        border: 1px solid var(--color-border, #333); border-radius: 4px;
        color: var(--color-text, #e0e0e0); font-size: 12px; padding: 0 4px; outline: none; text-align: center;
    }
    .num-input:focus { border-color: var(--color-primary, #4f46e5); }
    .num-input:disabled { opacity: 0.4; cursor: not-allowed; }
    .unit { font-size: 11px; color: var(--color-text-secondary, #888); }

    .lock-btn {
        width: 22px; height: 22px; border: 1px solid var(--color-border, #333);
        border-radius: 3px; background: transparent; cursor: pointer;
        font-size: 12px; display: flex; align-items: center; justify-content: center; padding: 0;
    }
    .lock-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); }
    .lock-btn.active { color: #818cf8; border-color: #4f46e5; }
</style>
