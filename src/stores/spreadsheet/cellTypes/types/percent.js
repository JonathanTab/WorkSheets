/**
 * Percent cell type — backward-compatible wrapper around the number formatter.
 *
 * Storage convention: raw value 50 = 50% (NOT 0.5). Natural human value.
 * Existing cells stored with { type: 'percent', decimals } continue to work.
 * New cells should use { type: 'number', subFormat: 'percent', ... }.
 */
import { formatNumber, getNumberTextColor } from './number.js';

export const percentType = {
    id: 'percent',

    formatValue(rawValue, config) {
        return formatNumber(rawValue, {
            subFormat: 'percent',
            decimals: config?.decimals ?? 2,
            thousandsSep: config?.thousandsSep ?? false,
            negativeStyle: config?.negativeStyle ?? 'minus',
        });
    },

    parseInput(inputString) {
        if (inputString === '' || inputString == null) return null;
        const clean = String(inputString).replace(/[%\s]/g, '');
        const num = Number(clean);
        return isNaN(num) ? String(inputString) : num;
    },

    defaultStyle() {
        return { horizontalAlign: 'right' };
    },

    getTextColor(rawValue, config) {
        return getNumberTextColor(rawValue, config);
    },
};

export default percentType;
