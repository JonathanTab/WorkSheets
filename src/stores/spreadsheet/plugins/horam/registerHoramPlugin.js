/**
 * Registers the horam time-import plugin with the PluginRegistry.
 * Import this once at app startup (e.g. from SpreadsheetSession or the top-level app).
 */
import { registerPlugin } from '../PluginRegistry.js';
import { openModal } from '../../../../lib/ui/modalStore.svelte.js';

let HoramImportModal = null;

registerPlugin({
    id: 'horam-time-import',
    label: 'Horam Time Import',
    description: 'Pull tracked time totals per user from a Horam workspace doc.',

    openConfig(sheetStore) {
        // The config panel is opened via MenuBar — nothing extra needed here.
    },

    async openImport(sheetStore, pluginId, config) {
        if (!HoramImportModal) {
            const mod = await import('../../../../components/spreadsheet/plugins/horam/HoramImportModal.svelte');
            HoramImportModal = mod.default;
        }
        openModal(HoramImportModal, { sheetStore, pluginId, config });
    },
});
