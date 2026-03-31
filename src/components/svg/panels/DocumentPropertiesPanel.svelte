<script>
    import { svgEditorState } from '../../../stores/svg/svgEditorState.svelte.js';
    import SvgColorPicker from '../SvgColorPicker.svelte';

    let open = $state(true);
    let bgPickerOpen = $state(false);

    const UNITS = ['px', 'mm', 'cm', 'in', 'pt'];

    // ── Artboard size ──────────────────────────────────────────────────────────

    let wInput = $state('');
    let hInput = $state('');

    $effect(() => {
        wInput = String(Math.round(svgEditorState.artboardW));
        hInput = String(Math.round(svgEditorState.artboardH));
    });

    function commitSize() {
        const w = parseFloat(wInput);
        const h = parseFloat(hInput);
        if (w > 0 && h > 0 && (w !== svgEditorState.artboardW || h !== svgEditorState.artboardH)) {
            svgEditorState.setArtboardSize(w, h);
        }
    }

    function onKeydown(e) {
        if (e.key === 'Enter') e.currentTarget.blur();
    }

    // ── Grid config ────────────────────────────────────────────────────────────

    let gridSxInput = $state('10');
    let gridSyInput = $state('10');

    $effect(() => {
        const g = svgEditorState.grid;
        if (g) {
            gridSxInput = String(g.spacingx);
            gridSyInput = String(g.spacingy);
        }
    });

    function commitGrid() {
        const sx = parseFloat(gridSxInput);
        const sy = parseFloat(gridSyInput);
        if (sx > 0 && sy > 0) svgEditorState.setGridSpacing(sx, sy);
    }
</script>

<section class="panel-section">
    <button class="panel-hdr" onclick={() => (open = !open)}>
        <span>Document Properties</span>
        <span class="chevron" class:rotated={!open}>▾</span>
    </button>

    {#if open}
        <div class="panel-body">

            <!-- Artboard dimensions -->
            <div class="row-label">Artboard</div>
            <div class="row size-row">
                <label class="size-field">
                    <span class="dim-label">W</span>
                    <input
                        class="num-input"
                        type="number"
                        min="1"
                        bind:value={wInput}
                        onblur={commitSize}
                        onkeydown={onKeydown}
                    />
                </label>
                <label class="size-field">
                    <span class="dim-label">H</span>
                    <input
                        class="num-input"
                        type="number"
                        min="1"
                        bind:value={hInput}
                        onblur={commitSize}
                        onkeydown={onKeydown}
                    />
                </label>
            </div>

            <div class="divider"></div>

            <!-- Page (background) color -->
            <div class="row-label">Background</div>
            <div class="row">
                <div class="swatch-wrap">
                    <button
                        class="swatch"
                        style="background:{svgEditorState.pageColor}"
                        onclick={() => (bgPickerOpen = !bgPickerOpen)}
                        title="Background color"
                    ></button>
                    {#if bgPickerOpen}
                        <div class="picker-pop">
                            <SvgColorPicker
                                color={svgEditorState.pageColor}
                                alpha={1}
                                showAlpha={false}
                                onchange={({ color }) => svgEditorState.setPageColor(color)}
                                oncommit={() => {}}
                                onclose={() => (bgPickerOpen = false)}
                            />
                        </div>
                    {/if}
                </div>
                <span class="hex-tag">{svgEditorState.pageColor}</span>
            </div>

            <div class="divider"></div>

            <!-- Document units -->
            <div class="row-label">Units</div>
            <div class="row">
                <select
                    class="select-input"
                    value={svgEditorState.docUnits}
                    onchange={(e) => svgEditorState.setDocUnits(e.currentTarget.value)}
                >
                    {#each UNITS as u}
                        <option value={u}>{u}</option>
                    {/each}
                </select>
            </div>

            <div class="divider"></div>

            <!-- Grid config -->
            <div class="row-label">Grid</div>
            <div class="row grid-toggle-row">
                <label class="toggle-label">
                    <input
                        type="checkbox"
                        checked={svgEditorState.showGrid}
                        onchange={(e) => { svgEditorState.showGrid = e.currentTarget.checked; }}
                    />
                    Show grid
                </label>
            </div>
            {#if svgEditorState.showGrid}
                <div class="row size-row">
                    <label class="size-field">
                        <span class="dim-label">Sx</span>
                        <input
                            class="num-input"
                            type="number"
                            min="1"
                            bind:value={gridSxInput}
                            onblur={commitGrid}
                            onkeydown={onKeydown}
                        />
                    </label>
                    <label class="size-field">
                        <span class="dim-label">Sy</span>
                        <input
                            class="num-input"
                            type="number"
                            min="1"
                            bind:value={gridSyInput}
                            onblur={commitGrid}
                            onkeydown={onKeydown}
                        />
                    </label>
                </div>
            {/if}
        </div>
    {/if}
</section>

<style>
    .panel-section {
        border-bottom: 1px solid var(--color-border, #333);
    }
    .panel-hdr {
        width: 100%; display: flex; justify-content: space-between; align-items: center;
        padding: 7px 10px; background: none; border: none; cursor: pointer;
        color: var(--color-text, #fff); font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.05em;
    }
    .panel-hdr:hover { background: var(--color-fill, rgba(255,255,255,0.05)); }
    .chevron { transition: transform 0.15s; font-size: 13px; }
    .chevron.rotated { transform: rotate(-90deg); }
    .panel-body { padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 4px; }
    .row-label { font-size: 10px; color: var(--color-text-secondary, #888); margin-top: 4px; }
    .row { display: flex; align-items: center; gap: 6px; }
    .size-row { display: flex; gap: 6px; }
    .size-field { display: flex; align-items: center; gap: 3px; flex: 1; }
    .dim-label { font-size: 10px; color: var(--color-text-secondary, #888); min-width: 10px; }
    .num-input {
        flex: 1; min-width: 0; height: 22px; padding: 0 4px;
        background: var(--color-input-bg, #1e1e1e); border: 1px solid var(--color-border, #333);
        border-radius: 3px; color: var(--color-text, #fff); font-size: 11px;
    }
    .num-input:focus { outline: none; border-color: #4f8ef7; }
    .swatch-wrap { position: relative; }
    .swatch {
        width: 22px; height: 22px; border-radius: 3px;
        border: 1px solid var(--color-border, #333); cursor: pointer;
    }
    .picker-pop { position: absolute; top: 26px; left: 0; z-index: 100; }
    .hex-tag { font-size: 11px; color: var(--color-text-secondary, #aaa); font-family: monospace; }
    .select-input {
        height: 22px; padding: 0 4px; font-size: 11px;
        background: var(--color-input-bg, #1e1e1e); border: 1px solid var(--color-border, #333);
        border-radius: 3px; color: var(--color-text, #fff); cursor: pointer;
    }
    .divider { height: 1px; background: var(--color-border, #333); margin: 6px 0; }
    .grid-toggle-row { display: flex; align-items: center; }
    .toggle-label { display: flex; align-items: center; gap: 5px; font-size: 11px; cursor: pointer;
        color: var(--color-text, #fff); }
    .toggle-label input { cursor: pointer; accent-color: #4f8ef7; }
</style>
