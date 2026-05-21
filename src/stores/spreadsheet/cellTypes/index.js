/**
 * Registry for cell types in the spreadsheet.
 *
 * Each descriptor exposes a subset of:
 *   id              string             — unique type id ('text', 'number', ...)
 *   renderType      string             — how CellPaintData paints the cell:
 *                                        'text' (default) | 'checkbox' | 'rating' |
 *                                        'image' | 'file' | 'dropdown'
 *   formatValue     (raw, config)→str  — render-time formatter
 *   parseInput      (str, config)→any  — input parser
 *   defaultStyle    (config)→object    — type-level style defaults (alignment, color, …)
 *   valueAlign      (raw)→'left'|'right'|null
 *                                      — value-dependent alignment override
 *   getTextColor    (raw, config)→str  — optional value-dependent text color
 *   getEditorComponent ()→{component}  — custom editor (date-picker, image-picker, …)
 *   paintCell       (ctx, val, …)      — custom canvas painter
 *   configPanel     Svelte component   — optional per-type options panel
 *   handlesClick    boolean            — type intercepts mouse clicks (checkbox, rating)
 *
 * Legacy type ids (currency, percent, automatic) were retired in schema v5.
 * The schema migration in schema.js rewrites all persisted cells. Any cell
 * with a stale type id falls back to the 'text' descriptor via registry.get().
 */

/** @type {Map<string, any>} */
const registry = new Map();

/**
 * Normalise a ct config — a no-op for modern configs; returns null for null/undefined.
 * The legacy alias remapping was removed after schema v5 migration.
 * @param {{ type: string, [key: string]: any } | null | undefined} ct
 * @returns {{ type: string, [key: string]: any } | null}
 */
function normaliseCt(ct) {
    return ct ?? null;
}

export const CellTypeRegistry = {
    /** @param {any} descriptor */
    register(descriptor) {
        registry.set(descriptor.id, descriptor);
    },

    /**
     * Get a descriptor by id. Falls back to the text descriptor for unknown ids.
     * @param {string} id
     * @returns {any}
     */
    get(id) {
        return registry.get(id) ?? registry.get('text');
    },

    normaliseCt,

    /**
     * @param {{ type: string, [key: string]: any } | null | undefined} ct
     * @param {any} rawValue
     * @returns {string}
     */
    formatValue(ct, rawValue) {
        if (rawValue === undefined || rawValue === null) return '';
        const normalised = normaliseCt(ct);
        const descriptor = this.get(normalised?.type || 'text');
        if (typeof descriptor.formatValue === 'function') {
            return descriptor.formatValue(rawValue, normalised);
        }
        return String(rawValue);
    },

    /**
     * @param {{ type: string, [key: string]: any } | null | undefined} ct
     * @param {any} inputString
     * @returns {any}
     */
    parseInput(ct, inputString) {
        const normalised = normaliseCt(ct);
        const descriptor = this.get(normalised?.type || 'text');
        if (typeof descriptor.parseInput === 'function') {
            return descriptor.parseInput(inputString, normalised);
        }
        return inputString;
    },

    /**
     * @param {{ type: string, [key: string]: any } | null | undefined} ct
     * @param {any} rawValue
     * @returns {string | null}
     */
    getTextColor(ct, rawValue) {
        const normalised = normaliseCt(ct);
        const descriptor = this.get(normalised?.type || 'text');
        if (typeof descriptor.getTextColor === 'function') {
            return descriptor.getTextColor(rawValue, normalised);
        }
        return null;
    },

    /**
     * @param {{ type: string, [key: string]: any } | null | undefined} ct
     * @returns {object}
     */
    getDefaultStyle(ct) {
        const normalised = normaliseCt(ct);
        const descriptor = this.get(normalised?.type || 'text');
        if (typeof descriptor.defaultStyle === 'function') {
            return descriptor.defaultStyle(normalised);
        }
        return {};
    },
};

// ── Type registrations ──────────────────────────────────────────────────────

import textType     from './types/text.js';
import numberType   from './types/number.js';
import dateType     from './types/date.js';
import checkboxType from './types/checkbox.js';
import ratingType   from './types/rating.js';
import dropdownType from './types/dropdown.js';
import imageType    from './types/image.js';
import fileType     from './types/file.js';
import urlType      from './types/url.js';

CellTypeRegistry.register(textType);     // default — must be registered before anything else relies on the fallback
CellTypeRegistry.register(numberType);
CellTypeRegistry.register(dateType);
CellTypeRegistry.register(checkboxType);
CellTypeRegistry.register(ratingType);
CellTypeRegistry.register(dropdownType);
CellTypeRegistry.register(imageType);
CellTypeRegistry.register(fileType);
CellTypeRegistry.register(urlType);

export default CellTypeRegistry;
