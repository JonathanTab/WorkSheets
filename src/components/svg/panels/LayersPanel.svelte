<script>
    import { svgEditorState } from '../../../stores/svg/svgEditorState.svelte.js';

    let open = $state(true);
    let editingId = $state(null);
    let editingName = $state('');

    const hasLayers = $derived(svgEditorState.layers.length > 0);

    // Shapes grouped by layer index, plus ungrouped shapes (layer === -1)
    const shapesByLayer = $derived.by(() => {
        const map = new Map(); // lIdx → shape[]
        for (const s of svgEditorState.shapes) {
            const key = s.layer ?? -1;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(s);
        }
        return map;
    });

    // Reversed layer list so top-of-stack is first in panel
    const layersReversed = $derived([...svgEditorState.layers].reverse());

    function toggleSelect(id, e) {
        svgEditorState.selectId(id, e.shiftKey || e.ctrlKey || e.metaKey);
    }

    function toggleVisible(id, isLayer, e) {
        e.stopPropagation();
        if (isLayer) {
            const l = svgEditorState.layers.find(l => l.id === id);
            svgEditorState.setLayerVisible(id, !l?.visible);
        } else {
            const s = svgEditorState.shapes.find(s => s.id === id);
            svgEditorState.setVisible(id, !s?.visible);
        }
    }

    function toggleLock(id, isLayer, e) {
        e.stopPropagation();
        if (isLayer) {
            const l = svgEditorState.layers.find(l => l.id === id);
            svgEditorState.setLayerLocked(id, !l?.locked);
        } else {
            const s = svgEditorState.shapes.find(s => s.id === id);
            svgEditorState.setLocked(id, !s?.locked);
        }
    }

    function startRename(id, name, e) {
        e.stopPropagation();
        editingId = id;
        editingName = name;
    }

    function commitRename() {
        if (editingId && editingName.trim()) {
            svgEditorState.setName(editingId, editingName.trim());
        }
        editingId = null;
    }

    function deleteShape(id, e) {
        e.stopPropagation();
        svgEditorState.selectId(id, false);
        svgEditorState.deleteSelected();
    }

    function deleteLayer(id, e) {
        e.stopPropagation();
        svgEditorState.deleteLayer(id);
    }

    function bringUp(id, e) { e.stopPropagation(); svgEditorState.bringForward(id); }
    function sendDown(id, e) { e.stopPropagation(); svgEditorState.sendBackward(id); }

    const TYPE_ICONS = {
        rect:'▭', ellipse:'○', line:'╱', text:'T', path:'✏', image:'🖼',
        group:'◫', polygon:'⬡', polyline:'〰', unknown:'?',
    };
    function typeIcon(type) { return TYPE_ICONS[type] ?? '?'; }

    // Collapsed layers state
    let collapsedLayers = $state(new Set());
    function toggleLayerCollapse(id) {
        const next = new Set(collapsedLayers);
        if (next.has(id)) next.delete(id); else next.add(id);
        collapsedLayers = next;
    }

    // Layer colour coding
    const LAYER_COLORS = ['#4f8ef7','#f97316','#10b981','#a855f7','#ef4444','#eab308'];
    function layerColor(lIdx) { return LAYER_COLORS[lIdx % LAYER_COLORS.length]; }

    // ── Drag-to-reorder ────────────────────────────────────────────────────────

    let dragOverId = $state(null);

    function onLayerDragStart(e, layerId) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', layerId);
    }

    function onLayerDragOver(e, layerId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dragOverId = layerId;
    }

    function onLayerDragLeave() {
        dragOverId = null;
    }

    function onLayerDrop(e, targetId) {
        e.preventDefault();
        dragOverId = null;
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId && draggedId !== targetId) {
            svgEditorState.reorderLayer(draggedId, targetId);
        }
    }
</script>

<section class="panel-section">
    <button class="panel-hdr" onclick={() => (open = !open)}>
        <span>Layers &amp; Objects</span>
        <span class="count-badge">{svgEditorState.shapes.length}</span>
        <span class="chevron" class:rotated={!open}>▾</span>
    </button>

    {#if open}
        <div class="panel-body">
            <!-- Add layer button -->
            <button class="add-layer-btn" onclick={() => svgEditorState.addLayer()}>
                + Add Layer
            </button>

            {#if hasLayers}
                <!-- Layer-grouped view -->
                {#each layersReversed as layer (layer.id)}
                    {@const isActive = svgEditorState.activeLayerId === layer.id}
                    {@const isCollapsed = collapsedLayers.has(layer.id)}
                    {@const layerShapes = [...(shapesByLayer.get(layer.lIdx) ?? [])].reverse()}
                    <div
                        class="layer-section"
                        class:active-layer={isActive}
                        class:drag-over={dragOverId === layer.id}
                        draggable="true"
                        ondragstart={(e) => onLayerDragStart(e, layer.id)}
                        ondragover={(e) => onLayerDragOver(e, layer.id)}
                        ondragleave={onLayerDragLeave}
                        ondrop={(e) => onLayerDrop(e, layer.id)}
                    >
                        <!-- Layer header -->
                        <div class="layer-hdr" onclick={() => svgEditorState.setActiveLayer(layer.id)}>
                            <button class="collapse-btn" onclick={(e) => { e.stopPropagation(); toggleLayerCollapse(layer.id); }}>
                                <span class:rotated={isCollapsed}>▾</span>
                            </button>
                            <span class="layer-swatch" style="background:{layerColor(layer.lIdx)}"></span>

                            {#if editingId === layer.id}
                                <input class="name-input" bind:value={editingName}
                                    onblur={commitRename}
                                    onkeydown={(e) => { if (e.key==='Enter') commitRename(); if (e.key==='Escape') editingId=null; }}
                                    onclick={(e) => e.stopPropagation()} autofocus />
                            {:else}
                                <span class="layer-name" class:dim={!layer.visible}
                                    ondblclick={(e) => startRename(layer.id, layer.name, e)}
                                >{layer.name}</span>
                            {/if}

                            <div class="row-controls">
                                <button class="ctrl-btn" class:dim={!layer.visible}
                                    onclick={(e) => toggleVisible(layer.id, true, e)} title={layer.visible ? 'Hide' : 'Show'}>👁</button>
                                <button class="ctrl-btn" class:active={layer.locked}
                                    onclick={(e) => toggleLock(layer.id, true, e)} title={layer.locked ? 'Unlock' : 'Lock'}>{layer.locked ? '🔒' : '🔓'}</button>
                                {#if svgEditorState.layers.length > 1}
                                    <button class="ctrl-btn danger"
                                        onclick={(e) => deleteLayer(layer.id, e)} title="Delete layer">✕</button>
                                {/if}
                            </div>
                        </div>

                        <!-- Shapes in layer -->
                        {#if !isCollapsed}
                            <ul class="shape-list indented">
                                {#each layerShapes as s (s.id)}
                                    {@const isSelected = svgEditorState.selectedIds.has(s.id)}
                                    <li class="shape-row" class:selected={isSelected} class:hidden={!s.visible} class:locked={s.locked}
                                        onclick={(e) => toggleSelect(s.id, e)} role="option" aria-selected={isSelected}>
                                        <span class="type-icon">{typeIcon(s.type)}</span>
                                        {#if editingId === s.id}
                                            <input class="name-input" bind:value={editingName}
                                                onblur={commitRename}
                                                onkeydown={(e) => { if (e.key==='Enter') commitRename(); if (e.key==='Escape') editingId=null; }}
                                                onclick={(e) => e.stopPropagation()} autofocus />
                                        {:else}
                                            <span class="shape-name" ondblclick={(e) => startRename(s.id, s.name, e)} title={s.name}>{s.name}</span>
                                        {/if}
                                        <div class="row-controls">
                                            <button class="ctrl-btn" class:dim={!s.visible} onclick={(e) => toggleVisible(s.id, false, e)} title="Show/Hide">👁</button>
                                            <button class="ctrl-btn" class:active={s.locked} onclick={(e) => toggleLock(s.id, false, e)} title="Lock/Unlock">{s.locked ? '🔒' : '🔓'}</button>
                                            <button class="ctrl-btn" onclick={(e) => bringUp(s.id, e)} title="Move up">↑</button>
                                            <button class="ctrl-btn" onclick={(e) => sendDown(s.id, e)} title="Move down">↓</button>
                                            <button class="ctrl-btn danger" onclick={(e) => deleteShape(s.id, e)} title="Delete">✕</button>
                                        </div>
                                    </li>
                                {/each}
                                {#if layerShapes.length === 0}
                                    <li class="empty-layer">Empty layer</li>
                                {/if}
                            </ul>
                        {/if}
                    </div>
                {/each}

                <!-- Ungrouped shapes (not in any layer) -->
                {#if (shapesByLayer.get(-1) ?? []).length > 0}
                    <div class="layer-section">
                        <div class="layer-hdr-plain">Ungrouped</div>
                        <ul class="shape-list indented">
                            {#each [...(shapesByLayer.get(-1) ?? [])].reverse() as s (s.id)}
                                {@const isSelected = svgEditorState.selectedIds.has(s.id)}
                                <li class="shape-row" class:selected={isSelected}
                                    onclick={(e) => toggleSelect(s.id, e)} role="option" aria-selected={isSelected}>
                                    <span class="type-icon">{typeIcon(s.type)}</span>
                                    <span class="shape-name">{s.name}</span>
                                    <div class="row-controls">
                                        <button class="ctrl-btn danger" onclick={(e) => deleteShape(s.id, e)} title="Delete">✕</button>
                                    </div>
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/if}

            {:else}
                <!-- Flat list (no Inkscape layers) -->
                {#if svgEditorState.shapes.length === 0}
                    <p class="empty-hint">No objects on canvas.</p>
                {:else}
                    <ul class="shape-list">
                        {#each [...svgEditorState.shapes].reverse() as s (s.id)}
                            {@const isSelected = svgEditorState.selectedIds.has(s.id)}
                            <li class="shape-row" class:selected={isSelected} class:hidden={!s.visible} class:locked={s.locked}
                                onclick={(e) => toggleSelect(s.id, e)} role="option" aria-selected={isSelected}>
                                <span class="type-icon">{typeIcon(s.type)}</span>
                                {#if editingId === s.id}
                                    <input class="name-input" bind:value={editingName}
                                        onblur={commitRename}
                                        onkeydown={(e) => { if (e.key==='Enter') commitRename(); if (e.key==='Escape') editingId=null; }}
                                        onclick={(e) => e.stopPropagation()} autofocus />
                                {:else}
                                    <span class="shape-name" ondblclick={(e) => startRename(s.id, s.name, e)} title={s.name}>{s.name}</span>
                                {/if}
                                <div class="row-controls">
                                    <button class="ctrl-btn" class:dim={!s.visible} onclick={(e) => toggleVisible(s.id, false, e)}>👁</button>
                                    <button class="ctrl-btn" class:active={s.locked} onclick={(e) => toggleLock(s.id, false, e)}>{s.locked ? '🔒' : '🔓'}</button>
                                    <button class="ctrl-btn" onclick={(e) => bringUp(s.id, e)}>↑</button>
                                    <button class="ctrl-btn" onclick={(e) => sendDown(s.id, e)}>↓</button>
                                    <button class="ctrl-btn danger" onclick={(e) => deleteShape(s.id, e)}>✕</button>
                                </div>
                            </li>
                        {/each}
                    </ul>
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
        font-weight: 600; cursor: pointer; text-align: left; gap: 6px;
    }
    .panel-hdr:hover { background: var(--color-fill, rgba(255,255,255,0.04)); }
    .chevron { font-size: 11px; transition: transform 0.15s; margin-left: auto; }
    .chevron.rotated { transform: rotate(-90deg); }

    .count-badge {
        font-size: 10px; background: var(--color-surface, #1a1a2e);
        border: 1px solid var(--color-border, #333); border-radius: 10px;
        padding: 1px 5px; color: var(--color-text-secondary, #888);
    }

    .panel-body { padding: 4px 0 4px; }

    .add-layer-btn {
        width: calc(100% - 20px); margin: 0 10px 6px;
        height: 26px; border-radius: 4px;
        background: transparent; border: 1px dashed var(--color-border, #444);
        color: var(--color-text-secondary, #888); font-size: 11px; cursor: pointer;
    }
    .add-layer-btn:hover { background: var(--color-fill, rgba(255,255,255,0.06)); color: var(--color-text, #ddd); }

    .empty-hint {
        font-size: 11px; color: var(--color-text-secondary, #666); font-style: italic;
        margin: 0; padding: 8px 10px;
    }

    /* Layer sections */
    .layer-section { border-top: 1px solid var(--color-border, #1e1e3a); cursor: grab; }
    .layer-section.active-layer { border-left: 2px solid #4f46e5; }
    .layer-section.drag-over { outline: 2px solid #4f8ef7; outline-offset: -2px; }

    .layer-hdr {
        display: flex; align-items: center; gap: 4px;
        padding: 4px 6px 4px 8px; cursor: pointer;
        background: var(--color-surface, #12122a);
        user-select: none;
    }
    .layer-hdr:hover { background: rgba(255,255,255,0.05); }
    .layer-hdr-plain {
        padding: 4px 10px; font-size: 10px; font-weight: 600;
        color: var(--color-text-secondary, #666); text-transform: uppercase;
        letter-spacing: 0.06em; background: var(--color-surface, #12122a);
    }

    .collapse-btn {
        background: none; border: none; cursor: pointer;
        color: var(--color-text-secondary, #777); font-size: 10px; padding: 0 2px;
        line-height: 1;
    }
    .collapse-btn span { display: inline-block; transition: transform 0.15s; }
    .collapse-btn span.rotated { transform: rotate(-90deg); }

    .layer-swatch {
        width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0;
    }

    .layer-name {
        flex: 1; font-size: 12px; font-weight: 600; color: var(--color-text, #e0e0e0);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .layer-name.dim { opacity: 0.4; }

    /* Shape list */
    .shape-list { list-style: none; margin: 0; padding: 0; }
    .shape-list.indented .shape-row { padding-left: 20px; }

    .shape-row {
        display: flex; align-items: center; gap: 4px;
        padding: 3px 8px; cursor: pointer; user-select: none;
        border-left: 2px solid transparent;
    }
    .shape-row:hover { background: var(--color-fill, rgba(255,255,255,0.04)); }
    .shape-row.selected { background: rgba(79,70,229,0.12); border-left-color: #4f46e5; }
    .shape-row.hidden { opacity: 0.4; }

    .type-icon {
        font-size: 11px; color: var(--color-text-secondary, #777);
        flex-shrink: 0; width: 14px; text-align: center;
    }

    .shape-name {
        flex: 1; font-size: 12px; color: var(--color-text, #e0e0e0);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }

    .name-input {
        flex: 1; min-width: 0; height: 20px; font-size: 12px;
        background: var(--color-bg, #0d0d1a);
        border: 1px solid var(--color-primary, #4f46e5); border-radius: 3px;
        color: var(--color-text, #e0e0e0); padding: 0 4px; outline: none;
    }

    .empty-layer {
        padding: 4px 20px; font-size: 11px; color: var(--color-text-secondary, #555);
        font-style: italic;
    }

    .row-controls {
        display: flex; gap: 1px; flex-shrink: 0; opacity: 0; transition: opacity 0.1s;
    }
    .shape-row:hover .row-controls,
    .shape-row.selected .row-controls,
    .layer-hdr:hover .row-controls { opacity: 1; }

    .ctrl-btn {
        width: 20px; height: 20px; border: none; border-radius: 3px;
        background: transparent; cursor: pointer; font-size: 10px;
        display: flex; align-items: center; justify-content: center; padding: 0;
        color: var(--color-text-secondary, #888);
    }
    .ctrl-btn:hover { background: var(--color-fill, rgba(255,255,255,0.1)); color: var(--color-text, #fff); }
    .ctrl-btn.dim { opacity: 0.3; }
    .ctrl-btn.active { color: #f97316; }
    .ctrl-btn.danger:hover { color: #ef4444; }
</style>
