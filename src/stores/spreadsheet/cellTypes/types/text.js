/**
 * Text cell type — default for any cell without an explicit type.
 *
 * Storage: input is preserved verbatim (no parsing on input). Whatever the user
 * types is what's stored — including "1234", "TRUE", "01/05/2026".
 *
 * Display: light, display-only inference for ergonomic rendering.
 *   - booleans                  → "TRUE" / "FALSE"
 *   - finite numbers            → locale-formatted with grouping
 *   - date-like strings         → reformatted as MM/DD/YYYY
 *   - numeric strings           → locale-formatted
 *   - anything else             → literal
 *
 * Formula results that flow into untyped cells (e.g. a serial from TODAY())
 * arrive as numbers and render with locale grouping, NOT as dates. To display
 * a serial as a date, set the cell type to `date`.
 *
 * Value-dependent alignment: numeric raw values right-align even without an
 * explicit type (`valueAlign`).
 */

import { parseLocalDate, formatTokens, parseNumericString } from '../../../../util/dateAndNumber.js';

// Cached locale formatter — same pattern as the legacy automatic type.
// 10 fractional digits hides float artefacts like 1.1 + 2.2 = 3.3000000000000003
// while keeping enough precision for practical numbers.
const _numFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 });

// Tight prefilter for "string that might be a date" — avoids the cost of running
// the full parseLocalDate on every literal text cell.
const _DATE_LIKE = /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|[A-Za-z]{3,}\s+\d{1,2}|\d{1,2}[-/ ][A-Za-z]{3,})/;

/**
 * Returns true if v is a number or a string that parses cleanly as a number.
 * Used both for alignment and for display-time numeric formatting.
 * @param {any} v
 * @returns {boolean}
 */
function _isNumericLike(v) {
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (s === '') return false;
    return !isNaN(parseNumericString(s));
}

export const textType = {
    id: 'text',
    renderType: 'text',

    formatValue(rawValue, _config) {
        if (rawValue === null || rawValue === undefined || rawValue === '') return '';

        // Booleans
        if (typeof rawValue === 'boolean') return rawValue ? 'TRUE' : 'FALSE';

        // Numbers — locale-format. Date serials in untyped cells render as
        // numbers; users wanting a date display should set the cell type.
        if (typeof rawValue === 'number') {
            if (!Number.isFinite(rawValue)) return String(rawValue);
            return _numFmt.format(rawValue);
        }

        if (typeof rawValue === 'string') {
            // Date-like → reformat for display
            if (_DATE_LIKE.test(rawValue)) {
                const d = parseLocalDate(rawValue);
                if (d) return formatTokens(d, 'MM/DD/YYYY');
            }
            // Numeric string → locale-format
            const n = parseNumericString(rawValue.trim());
            if (!isNaN(n) && rawValue.trim() !== '') {
                return _numFmt.format(n);
            }
            return rawValue;
        }

        return String(rawValue);
    },

    parseInput(inputString) {
        if (inputString === null || inputString === undefined) return null;
        if (inputString === '') return null;
        return String(inputString);
    },

    defaultStyle() {
        return { horizontalAlign: 'left' };
    },

    /**
     * Value-dependent alignment hint. Numbers (raw or numeric strings) right-align,
     * everything else falls back to defaultStyle().
     * @param {any} rawValue
     * @returns {'left'|'right'|null}
     */
    valueAlign(rawValue) {
        return _isNumericLike(rawValue) ? 'right' : null;
    },
};

export default textType;
