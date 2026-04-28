/**
 * Automatic cell type descriptor
 *
 * Detects the type of the value at render time and formats accordingly.
 * The stored value is never transformed — only the display is affected.
 *
 * Detection order:
 *   boolean        → TRUE / FALSE
 *   http(s):// URL → the URL string (no special formatting — shown as text)
 *   finite number  → formatted with locale number separators
 *   date string    → formatted date if parseable
 *   otherwise      → plain string
 */
// Cached once at module load — avoids constructing a new Intl.NumberFormat per cell per frame.
const _numFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 });

export const automaticType = {
    id: 'automatic',
    formatValue(rawValue, _config) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return '';

        // Boolean
        if (typeof rawValue === 'boolean') {
            return rawValue ? 'TRUE' : 'FALSE';
        }

        // Number
        const num = Number(rawValue);
        if (!isNaN(num) && rawValue !== '' && typeof rawValue !== 'boolean') {
            return _numFmt.format(num);
        }

        // String value
        const str = String(rawValue);

        // Date-like strings: try ISO or common patterns
        if (typeof rawValue === 'string' && isDateLike(str)) {
            const d = new Date(str);
            if (!isNaN(d.getTime())) {
                return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
            }
        }

        return str;
    },
    parseInput(inputString) {
        if (inputString === '') return null;

        // Boolean literals
        if (inputString.trim().toUpperCase() === 'TRUE') return true;
        if (inputString.trim().toUpperCase() === 'FALSE') return false;

        // Number
        const num = Number(inputString.trim());
        if (!isNaN(num) && inputString.trim() !== '') return num;

        return inputString;
    },
    defaultStyle() {
        return {};
    }
};

/**
 * Check if a string looks like a date (ISO 8601 or MM/DD/YYYY etc.)
 * @param {string} s
 * @returns {boolean}
 */
function isDateLike(s) {
    return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s);
}

export default automaticType;
