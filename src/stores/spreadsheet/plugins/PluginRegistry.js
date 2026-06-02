/**
 * PluginRegistry — minimal registry for spreadsheet plugins.
 *
 * A plugin descriptor has:
 *   id:          string — unique type identifier stored in Y.Map config
 *   label:       string — human-readable name shown in menus
 *   description: string — short description
 *   openConfig:  (sheetStore, pluginId?) => void — opens the config panel
 *   openImport:  (sheetStore, pluginId, config) => void — runs the import action
 */

/** @type {Map<string, {id:string, label:string, description:string, openConfig:Function, openImport:Function}>} */
const registry = new Map();

export function registerPlugin(descriptor) {
    registry.set(descriptor.id, descriptor);
}

/** @returns {Array} all registered plugin descriptors */
export function listPlugins() {
    return [...registry.values()];
}

/** @param {string} id @returns {object|undefined} */
export function getPlugin(id) {
    return registry.get(id);
}
