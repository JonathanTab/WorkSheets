<script>
    /**
     * EntryForgeOverlay — surfaces a "⇄ Mirror" button on every table row that
     * looks like an unmatched transfer (an entry whose From/To is one of the real
     * accounts, with no complementary entry yet).
     *
     * Candidates are detected live across every mirror-enabled table on the sheet.
     * Each button is parked in the gutter just left of the table's first column so
     * transfers surface at a glance without covering any cells.
     */
    import { spreadsheetSession } from '../../../../stores/spreadsheetStore.svelte.js';
    import { HEADER_WIDTH, HEADER_HEIGHT } from '../../../../stores/spreadsheet/constants.js';
    import { getConfig } from '../../../../stores/spreadsheet/plugins/entryForge/entryForgeConfig.js';
    import { findMirrorCandidates } from '../../../../stores/spreadsheet/plugins/entryForge/mirrorDetection.js';
    import { createMirrorEntry } from '../../../../stores/spreadsheet/plugins/entryForge/mirrorAction.js';
    import { resolveRangeValues } from '../../../../stores/spreadsheet/rangeRefUtils.js';

    let { virtualizer } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let tableManager = $derived(spreadsheetSession.tableManager);

    const BTN_W = 86;
    const BTN_H = 20;

    // ── Candidates (recomputed only on data / config changes, not on scroll) ───
    /** @type {Array<{tableId:string, table:any, mapping:any, displayIndex:number}>} */
    let candidates = $derived.by(() => {
        if (!sheetStore || !tableManager) return [];
        const _tv = tableManager.tableVersion;
        const _pv = sheetStore.pluginsVersion;

        const result = [];
        for (const tableId of tableManager.tableList) {
            const table = tableManager.stores.get(tableId);
            if (!table) continue;

            const cfg = getConfig(sheetStore, table.sourceTableId);
            if (!cfg?.actions?.mirror?.enabled) continue;
            const { mapping, accountsRange } = cfg;
            if (!mapping?.account || !mapping?.fromTo || !mapping?.amount) continue;

            // Resolve the document's real account names (reactive on cell edits).
            const accountNames = accountsRange ? resolveRangeValues(spreadsheetSession, accountsRange) : [];
            if (accountNames.length === 0) continue;

            for (const { displayIndex } of findMirrorCandidates(table, mapping, accountNames)) {
                result.push({ tableId, table, mapping, displayIndex });
            }
        }
        return result;
    });

    // ── Positions for every visible candidate (recomputed on scroll) ───────────
    // A button is shown for each unmatched-transfer row, parked in the gutter just
    // left of the table's first column so it surfaces without covering any cells.
    /** @type {Array<{key:string, table:any, mapping:any, displayIndex:number, x:number, y:number}>} */
    let buttons = $derived.by(() => {
        if (!virtualizer || candidates.length === 0) return [];

        const sl = virtualizer.scrollLeft;
        const st = virtualizer.scrollTop;
        const frozenW = virtualizer.frozenWidth;
        const frozenH = virtualizer.frozenHeight;
        // Fall back to generous bounds if the virtualizer hasn't measured the
        // container yet, so candidates aren't culled (or NaN-positioned) by a
        // transient 0/undefined size.
        const containerW = virtualizer.containerWidth || 100000;
        const containerH = virtualizer.containerHeight || 100000;

        const out = [];
        for (const { tableId, table, mapping, displayIndex } of candidates) {
            const gridRow = table.gridRowForDisplayIndex(displayIndex);
            const rowOff = virtualizer.rowMetrics.offsetOf(gridRow);
            const inFrozenY = frozenH > 0 && rowOff < frozenH;
            const rowH = virtualizer.getRowHeight(gridRow);
            const rowTop = HEADER_HEIGHT + rowOff - (inFrozenY ? 0 : st);

            // Skip rows scrolled out of the vertical viewport.
            if (rowTop + rowH <= HEADER_HEIGHT || rowTop >= containerH) continue;

            const leftCol = table.startCol;
            const colOff = virtualizer.colMetrics.offsetOf(leftCol);
            const inFrozenX = frozenW > 0 && colOff < frozenW;
            const tableLeftX = HEADER_WIDTH + colOff - (inFrozenX ? 0 : sl);
            const idealX = tableLeftX - BTN_W - 6;

            // Keep on-screen: never run under the row-header gutter.
            const maxX = Math.max(HEADER_WIDTH + 2, containerW - BTN_W - 6);
            const x = Math.min(Math.max(idealX, HEADER_WIDTH + 2), maxX);
            const y = rowTop + (rowH - BTN_H) / 2;

            out.push({ key: `${tableId}:${displayIndex}`, table, mapping, displayIndex, x, y });
        }
        return out;
    });

    function handleClick(btn) {
        createMirrorEntry(btn.table, btn.mapping, btn.displayIndex);
    }
</script>

{#each buttons as btn (btn.key)}
    <button
        class="mirror-btn"
        style="left:{btn.x}px; top:{btn.y}px; width:{BTN_W}px; height:{BTN_H}px;"
        onclick={() => handleClick(btn)}
        title="Create the complementary transfer entry on the other account"
    >
        <span class="ico">⇄</span><span class="lbl">Mirror</span>
    </button>
{/each}

<style>
    .mirror-btn {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        background: #059669;
        border: 1px solid #047857;
        border-radius: 10px;
        cursor: pointer;
        font-size: 11px;
        color: white;
        font-weight: 600;
        padding: 0 8px;
        pointer-events: all;
        z-index: 20;
        box-sizing: border-box;
        box-shadow: 0 1px 4px rgba(0,0,0,0.25);
        white-space: nowrap;
        transition: background 0.1s, transform 0.05s;
    }
    .mirror-btn:hover { background: #047857; }
    .mirror-btn:active { transform: translateY(1px); }
    .ico { font-size: 13px; line-height: 1; }
    .lbl { line-height: 1; }
</style>
