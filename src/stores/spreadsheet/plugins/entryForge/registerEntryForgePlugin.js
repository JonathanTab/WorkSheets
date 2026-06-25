/**
 * Registers the Entry Forge plugin with the PluginRegistry.
 *
 * Entry Forge is a general-purpose "power tool" for structured table entry.
 * Unlike the Horam plugin (a single cell-anchored import button), its UI is
 * row-oriented and lives in the grid context menu + dedicated overlays
 * (EntryForgeOverlay for mirror buttons, SplitOverlay for the split flow), so
 * the registry's generic openConfig/openImport hooks are not the entry points
 * here. Registration exists mainly so the plugin appears in listPlugins() and
 * to centralise its id/label/description.
 *
 * Import this once at app startup (done from Grid.svelte alongside the Horam
 * registration).
 */
import { registerPlugin } from '../PluginRegistry.js';
import { ENTRY_FORGE_TYPE } from './entryForgeConfig.js';

registerPlugin({
    id: ENTRY_FORGE_TYPE,
    label: 'Entry Forge',
    description: 'Power tools for structured table entry: mirrored transfers and live splits.',
    openConfig() { /* config is opened from the table context menu */ },
    openImport() { /* actions are triggered from row overlays / context menu */ },
});
