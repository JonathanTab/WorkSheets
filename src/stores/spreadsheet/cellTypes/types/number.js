/**
 * Number cell type — unified numeric formatter
 *
 * Raw value: always a plain JavaScript number.
 *   - $1,234.56  is stored as  1234.56
 *   - 50%        is stored as  50  (not 0.5)
 *   - 1.23E+03   is stored as  1230
 *
 * config.subFormat:
 *   'default'    — plain number           1,234.56
 *   'currency'   — symbol + number        $1,234.56
 *   'accounting' — symbol aligned,        $ 1,234.56
 *                  negatives in parens    ($ 1,234.56)
 *   'financial'  — no symbol, negatives   1,234.56  /  (1,234.56)
 *                  in parens
 *   'percent'    — percent sign           50  →  50%
 *   'scientific' — scientific notation    1,230  →  1.23E+03
 *
 * config.decimals:       0–10  (default 2)
 * config.thousandsSep:   boolean (default true, except scientific)
 * config.symbol:         string (default '$', used for currency/accounting)
 * config.symbolAfter:    boolean (default false — symbol comes before number)
 * config.negativeStyle:  'minus' | 'parens' | 'red' | 'redParens'
 *   Defaults: 'parens' for accounting/financial, 'minus' for everything else.
 *   'red' and 'redParens' render with red text — requires CellPaintData to call getTextColor().
 */

/**
 * Core formatting function. Exported so legacy ct configs (currency / percent
 * type ids) still have a single implementation to delegate into via the
 * registry's alias normalisation.
 * @param {any} rawValue
 * @param {Object} config
 * @returns {string}
 */
export function formatNumber(rawValue, config) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return '';
    const num = Number(rawValue);
    if (isNaN(num)) return String(rawValue);

    const subFormat = config?.subFormat ?? 'default';
    const decimals = config?.decimals ?? 2;
    const thousandsSep = config?.thousandsSep ?? (subFormat !== 'scientific');
    const symbol = config?.symbol ?? '$';
    const symbolAfter = config?.symbolAfter ?? false;
    const negativeStyle = config?.negativeStyle ?? _defaultNegativeStyle(subFormat);

    const absNum = Math.abs(num);
    const isNeg = num < 0;

    switch (subFormat) {
        case 'scientific':
            return _formatScientific(num, decimals);

        case 'percent': {
            const s = _intlFmt(absNum, decimals, thousandsSep);
            return _applyNeg(`${s}%`, isNeg, negativeStyle);
        }

        case 'currency': {
            const s = _intlFmt(absNum, decimals, thousandsSep);
            const core = symbolAfter ? `${s} ${symbol}` : `${symbol}${s}`;
            return _applyNeg(core, isNeg, negativeStyle);
        }

        case 'accounting': {
            const s = _intlFmt(absNum, decimals, thousandsSep);
            const pre  = symbolAfter ? '' : `${symbol} `;
            const post = symbolAfter ? ` ${symbol}` : '';
            // Trailing space on positive rows aligns with paren-wrapped negative rows
            if (isNeg) return `(${pre}${s}${post})`;
            return `${pre}${s}${post} `;
        }

        case 'financial': {
            const s = _intlFmt(absNum, decimals, thousandsSep);
            if (isNeg) return `(${s})`;
            return `${s} `;
        }

        default: { // 'default'
            const s = _intlFmt(absNum, decimals, thousandsSep);
            return _applyNeg(s, isNeg, negativeStyle);
        }
    }
}

/**
 * Returns a CSS color string if the value should be rendered in red, otherwise null.
 * Used by CellPaintData to set item.textColor before the formatting cascade
 * so that an explicit user color still wins.
 * @param {any} rawValue
 * @param {Object} config
 * @returns {string|null}
 */
export function getNumberTextColor(rawValue, config) {
    const ns = config?.negativeStyle;
    if (ns !== 'red' && ns !== 'redParens') return null;
    const num = Number(rawValue);
    if (isNaN(num) || num >= 0) return null;
    return '#ef4444';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _defaultNegativeStyle(subFormat) {
    return (subFormat === 'accounting' || subFormat === 'financial') ? 'parens' : 'minus';
}

// Cached by "decimals|grouping" key — Intl.NumberFormat construction is expensive,
// so we reuse instances across the ~22 possible option combinations.
const _intlFmtCache = new Map();
function _intlFmt(absNum, decimals, useGrouping) {
    const key = `${decimals}|${useGrouping ? '1' : '0'}`;
    let fmt = _intlFmtCache.get(key);
    if (!fmt) {
        fmt = new Intl.NumberFormat(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
            useGrouping,
        });
        _intlFmtCache.set(key, fmt);
    }
    return fmt.format(absNum);
}

function _applyNeg(absFormatted, isNeg, negativeStyle) {
    if (!isNeg) return absFormatted;
    switch (negativeStyle) {
        case 'parens':
        case 'redParens': return `(${absFormatted})`;
        default: return `-${absFormatted}`; // 'minus', 'red'
    }
}

function _formatScientific(num, decimals) {
    // toExponential gives e.g. "1.23e+3" — normalise to "1.23E+03"
    const raw = num.toExponential(decimals);
    return raw.replace(/e([+-])(\d+)$/, (_, sign, exp) =>
        `E${sign}${exp.padStart(2, '0')}`
    );
}

// ── Descriptor ───────────────────────────────────────────────────────────────

export const numberType = {
    id: 'number',
    renderType: 'text',

    formatValue(rawValue, config) {
        return formatNumber(rawValue, config);
    },

    /**
     * Numbers always right-align (matches the default in defaultStyle); kept here
     * so untyped raw numbers also pick this up via the text descriptor.
     */
    valueAlign() {
        return 'right';
    },

    /**
     * Parse typed input into a raw number.
     * Handles: commas, currency symbols, %, parenthesised negatives "(1,234)" → -1234.
     */
    parseInput(inputString) {
        if (inputString === '' || inputString == null) return null;
        const s = String(inputString).trim();
        // Parenthesised negative: (1,234.56) → -1234.56
        const parenMatch = s.match(/^\((.+)\)$/);
        const unwrapped = parenMatch ? `-${parenMatch[1]}` : s;
        // Strip everything except digits, dot, minus, E/e (scientific)
        const clean = unwrapped.replace(/[, $%]/g, '');
        const num = Number(clean);
        return isNaN(num) ? s : num;
    },

    defaultStyle() {
        return { horizontalAlign: 'right' };
    },

    getTextColor(rawValue, config) {
        return getNumberTextColor(rawValue, config);
    },
};

export default numberType;
