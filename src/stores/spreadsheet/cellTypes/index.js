/**
 * Registry for cell types in the spreadsheet.
 */

const registry = new Map();

export const CellTypeRegistry = {
    /**
     * Register a new cell type descriptor
     * @param {Object} descriptor
     */
    register(descriptor) {
        registry.set(descriptor.id, descriptor);
    },

    /**
     * Get a cell type descriptor by ID
     * @param {string} id
     * @returns {Object|undefined}
     */
    get(id) {
        return registry.get(id) || registry.get('text');
    },

    /**
     * Format a raw value for display based on config
     * @param {Object} ct - Cell type config { type, ...options }
     * @param {any} rawValue
     * @returns {string}
     */
    formatValue(ct, rawValue) {
        if (rawValue === undefined || rawValue === null) return '';
        const typeId = ct?.type || 'text';
        const descriptor = this.get(typeId);
        if (descriptor && typeof descriptor.formatValue === 'function') {
            return descriptor.formatValue(rawValue, ct);
        }
        return String(rawValue);
    },

    /**
     * Parse user input into a stored value based on config
     * @param {Object} ct - Cell type config
     * @param {string} inputString
     * @returns {any}
     */
    parseInput(ct, inputString) {
        const typeId = ct?.type || 'text';
        const descriptor = this.get(typeId);
        if (descriptor && typeof descriptor.parseInput === 'function') {
            return descriptor.parseInput(inputString, ct);
        }
        return inputString;
    },

    /**
     * Get default style overrides for a cell type
     * @param {Object} ct - Cell type config
     * @returns {Object}
     */
    getDefaultStyle(ct) {
        const typeId = ct?.type || 'text';
        const descriptor = this.get(typeId);
        if (descriptor && typeof descriptor.defaultStyle === 'function') {
            return descriptor.defaultStyle(ct);
        }
        return {};
    }
};

import numberType from './types/number.js';
import currencyType from './types/currency.js';
import percentType from './types/percent.js';
import dateType from './types/date.js';
import checkboxType from './types/checkbox.js';
import ratingType from './types/rating.js';
import urlType from './types/url.js';

// Default 'text' type
CellTypeRegistry.register({
    id: 'text',
    formatValue: (val) => String(val),
    parseInput: (val) => val,
    defaultStyle: () => ({ horizontalAlign: 'left' })
});

// Register all types
CellTypeRegistry.register(numberType);
CellTypeRegistry.register(currencyType);
CellTypeRegistry.register(percentType);
CellTypeRegistry.register(dateType);
CellTypeRegistry.register(checkboxType);
CellTypeRegistry.register(ratingType);
CellTypeRegistry.register(urlType);

export default CellTypeRegistry;
