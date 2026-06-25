/**
 * Entry Forge config persistence.
 *
 * Entry Forge configs live in the per-sheet `plugins` Y.Map (the same store the
 * Horam plugin uses), one entry per table keyed `entry-forge:<tableId>`. The
 * stored JSON is intentionally generic so future entry tools can extend the
 * `actions` bag without a migration:
 *
 *   {
 *     type:        'entry-forge',
 *     tableId:     string,
 *     label:       string,
 *     mapping:     { account, fromTo, amount, date|null, notes|null },  // colIds
 *     accountsRange: string,   // A1 range listing real account names
 *     actions:     { mirror: { enabled }, split: { enabled } }
 *   }
 */

export const ENTRY_FORGE_TYPE = 'entry-forge';

/** @param {string} tableId */
export function configKey(tableId) {
    return `${ENTRY_FORGE_TYPE}:${tableId}`;
}

/** Default config for a freshly-configured table. @param {string} tableId */
export function defaultConfig(tableId) {
    return {
        type: ENTRY_FORGE_TYPE,
        tableId,
        label: 'Entry Forge',
        mapping: { account: null, fromTo: null, amount: null, date: null, notes: null },
        accountsRange: '',
        actions: { mirror: { enabled: false }, split: { enabled: false } },
    };
}

/**
 * Read the Entry Forge config for a table, or null if none.
 * @param {import('../../SheetStore.svelte.js').SheetStore} sheetStore
 * @param {string} tableId
 * @returns {object|null}
 */
export function getConfig(sheetStore, tableId) {
    const map = sheetStore?.getPluginsMap?.();
    if (!map || !tableId) return null;
    const json = map.get(configKey(tableId));
    if (!json) return null;
    try {
        const cfg = JSON.parse(json);
        return cfg?.type === ENTRY_FORGE_TYPE ? cfg : null;
    } catch {
        return null;
    }
}

/**
 * Persist the Entry Forge config for a table.
 * @param {import('../../SheetStore.svelte.js').SheetStore} sheetStore
 * @param {string} tableId
 * @param {object} config
 */
export function setConfig(sheetStore, tableId, config) {
    if (!sheetStore || !tableId) return;
    sheetStore.setPlugin(configKey(tableId), { ...config, type: ENTRY_FORGE_TYPE, tableId });
}

/**
 * Remove the Entry Forge config for a table.
 * @param {import('../../SheetStore.svelte.js').SheetStore} sheetStore
 * @param {string} tableId
 */
export function deleteConfig(sheetStore, tableId) {
    if (!sheetStore || !tableId) return;
    sheetStore.deletePlugin(configKey(tableId));
}

/**
 * List all Entry Forge configs on a sheet.
 * @param {import('../../SheetStore.svelte.js').SheetStore} sheetStore
 * @returns {Array<{ key: string, config: object }>}
 */
export function listConfigs(sheetStore) {
    const map = sheetStore?.getPluginsMap?.();
    if (!map) return [];
    const out = [];
    map.forEach((json, key) => {
        try {
            const cfg = JSON.parse(json);
            if (cfg?.type === ENTRY_FORGE_TYPE) out.push({ key, config: cfg });
        } catch { /* skip malformed */ }
    });
    return out;
}
