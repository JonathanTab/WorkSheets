<script>
    /**
     * PluginOverlay — renders plugin action buttons positioned over their anchor cells.
     *
     * Reads plugin configs from the active sheet's `plugins` Y.Map.
     * Each entry is a JSON string with at minimum { type, anchorRow, anchorCol, label }.
     * Clicking the button calls the registered plugin's openImport handler.
     */
    import { spreadsheetSession } from '../../../stores/spreadsheetStore.svelte.js';
    import { HEADER_WIDTH, HEADER_HEIGHT } from '../../../stores/spreadsheet/constants.js';
    import { getPlugin } from '../../../stores/spreadsheet/plugins/PluginRegistry.js';

    let { virtualizer } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);

    /** @type {Array<{pluginId:string, config:any, x:number, y:number, w:number, h:number}>} */
    let buttons = $derived.by(() => {
        if (!virtualizer || !sheetStore) return [];

        // Track pluginsVersion so this recomputes when plugins are added/removed/changed
        const _pv = sheetStore.pluginsVersion;

        const pluginsMap = sheetStore.getPluginsMap?.();
        if (!pluginsMap) return [];

        const sl = virtualizer.scrollLeft;
        const st = virtualizer.scrollTop;
        const frozenW = virtualizer.frozenWidth;
        const frozenH = virtualizer.frozenHeight;

        const result = [];

        pluginsMap.forEach((jsonStr, pluginId) => {
            let config;
            try { config = JSON.parse(jsonStr); } catch { return; }

            const { anchorRow, anchorCol } = config;
            if (anchorRow == null || anchorCol == null) return;

            const colOff = virtualizer.colMetrics.offsetOf(anchorCol);
            const rowOff = virtualizer.rowMetrics.offsetOf(anchorRow);

            const inFrozenX = frozenW > 0 && colOff < frozenW;
            const inFrozenY = frozenH > 0 && rowOff < frozenH;

            const x = HEADER_WIDTH + colOff - (inFrozenX ? 0 : sl);
            const y = HEADER_HEIGHT + rowOff - (inFrozenY ? 0 : st);

            const w = virtualizer.getColWidth(anchorCol);
            const h = virtualizer.getRowHeight(anchorRow);

            result.push({ pluginId, config, x, y, w, h });
        });

        return result;
    });

    function handleClick(pluginId, config) {
        const plugin = getPlugin(config.type);
        if (!plugin) return;
        plugin.openImport(sheetStore, pluginId, config);
    }
</script>

{#each buttons as btn (btn.pluginId)}
    <button
        class="plugin-btn"
        style="left:{btn.x}px; top:{btn.y}px; width:{btn.w}px; height:{btn.h}px;"
        onclick={() => handleClick(btn.pluginId, btn.config)}
        title={btn.config.label ?? 'Run plugin'}
    >
        <span class="plugin-btn-icon">⟳</span>
        <span class="plugin-btn-label">{btn.config.label ?? 'Import'}</span>
    </button>
{/each}

<style>
    .plugin-btn {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        color: #1d4ed8;
        font-weight: 500;
        padding: 0 6px;
        pointer-events: all;
        overflow: hidden;
        white-space: nowrap;
        z-index: 10;
        box-sizing: border-box;
        transition: background 0.1s;
    }
    .plugin-btn:hover {
        background: #dbeafe;
    }
    .plugin-btn-icon {
        font-size: 13px;
        flex-shrink: 0;
    }
    .plugin-btn-label {
        overflow: hidden;
        text-overflow: ellipsis;
    }
</style>
