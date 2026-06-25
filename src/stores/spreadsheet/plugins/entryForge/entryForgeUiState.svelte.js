/**
 * Shared UI trigger state for the Entry Forge plugin.
 *
 * The grid context menu sets these; the config panel (rendered from MenuBar)
 * and the split overlay (rendered from Grid) react to them. Using a small shared
 * module-level state avoids threading callbacks through MenuBar / GridContextMenu
 * / Grid for what are essentially two independent floating UIs.
 */

export const entryForgeUi = $state({
    /** Whether the config panel is open. */
    configOpen: false,

    /** Source table id to preselect in the config panel, or null to let the user pick. */
    configTableId: null,

    /**
     * Active split session request, or null.
     * @type {{ tableId: string, displayIndex: number } | null}
     */
    split: null,
});

/**
 * Open the Entry Forge config panel, optionally preselecting a table.
 * @param {string|null} [tableId]  source table id, or null to show the table picker
 */
export function openEntryForgeConfig(tableId = null) {
    entryForgeUi.configTableId = tableId;
    entryForgeUi.configOpen = true;
}

export function closeEntryForgeConfig() {
    entryForgeUi.configOpen = false;
    entryForgeUi.configTableId = null;
}

/**
 * Begin a split session on a table row.
 * @param {string} tableId  source table id
 * @param {number} displayIndex
 */
export function openSplit(tableId, displayIndex) {
    entryForgeUi.split = { tableId, displayIndex };
}

export function closeSplit() {
    entryForgeUi.split = null;
}
