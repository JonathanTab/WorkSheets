/**
 * Currency cell type — backward-compatible wrapper around the number formatter.
 *
 * Existing cells stored with { type: 'currency', decimals, symbol } continue to
 * render correctly. New cells should use { type: 'number', subFormat: 'currency', ... }.
 */
import { formatNumber, getNumberTextColor } from './number.js';

export const currencyType = {
    id: 'currency',

    formatValue(rawValue, config) {
        return formatNumber(rawValue, {
            subFormat: 'currency',
            symbol: config?.symbol ?? '$',
            symbolAfter: config?.symbolAfter ?? false,
            decimals: config?.decimals ?? 2,
            thousandsSep: config?.thousandsSep ?? true,
            negativeStyle: config?.negativeStyle ?? 'minus',
        });
    },

    parseInput(inputString) {
        if (inputString === '' || inputString == null) return null;
        const clean = String(inputString).replace(/[, $]/g, '');
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

export default currencyType;
