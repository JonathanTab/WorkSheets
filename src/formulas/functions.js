/**
 * Formula Functions Registry
 *
 * Defines all spreadsheet functions that can be called in formulas.
 * Each function receives evaluated arguments and returns a result.
 */

/**
 * Error types for formula evaluation
 */
export const FormulaError = {
    DIV_ZERO: '#DIV/0!',
    VALUE: '#VALUE!',
    REF: '#REF!',
    NAME: '#NAME?',
    NUM: '#NUM!',
    NA: '#N/A',
    ERROR: '#ERROR!'
};

/**
 * Check if a value is an error
 * @param {any} value
 * @returns {boolean}
 */
export function isError(value) {
    return typeof value === 'string' && value.startsWith('#');
}

/**
 * Convert a value to a number
 * @param {any} value
 * @returns {number|typeof FormulaError.VALUE}
 */
function toNumber(value) {
    if (isError(value)) return value;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const num = parseFloat(value);
        return isNaN(num) ? FormulaError.VALUE : num;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    return FormulaError.VALUE;
}

/**
 * Convert a value to a string
 * @param {any} value
 * @returns {string}
 */
function toString(value) {
    if (isError(value)) return value;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return '';
}

/**
 * Convert a value to a boolean
 * @param {any} value
 * @returns {boolean|typeof FormulaError.VALUE}
 */
function toBoolean(value) {
    if (isError(value)) return value;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const upper = value.toUpperCase();
        if (upper === 'TRUE') return true;
        if (upper === 'FALSE') return false;
        return FormulaError.VALUE;
    }
    return FormulaError.VALUE;
}

/**
 * Flatten nested arrays (for ranges)
 * @param {Array} arr
 * @returns {Array}
 */
function flatten(arr) {
    const result = [];
    for (const item of arr) {
        if (Array.isArray(item)) {
            result.push(...flatten(item));
        } else {
            result.push(item);
        }
    }
    return result;
}

/**
 * Get numeric values from arguments, ignoring non-numeric
 * @param {Array} args
 * @returns {Array<number>}
 */
function getNumericValues(args) {
    const result = [];
    for (const arg of flatten(args)) {
        if (isError(arg)) return [arg];
        if (typeof arg === 'number') {
            result.push(arg);
        } else if (typeof arg === 'boolean') {
            result.push(arg ? 1 : 0);
        } else if (typeof arg === 'string') {
            // Try to convert string numbers to actual numbers
            const trimmed = arg.trim();
            if (trimmed !== '' && !isNaN(Number(trimmed))) {
                result.push(Number(trimmed));
            }
        }
        // Skip other types
    }
    return result;
}

/**
 * Normalize any value to a 2D array (rows × cols).
 * Scalars become [[v]], 1D arrays become [[v1],[v2],...].
 * @param {any} val
 * @returns {Array<Array<any>>}
 */
function to2D(val) {
    if (!Array.isArray(val)) return [[val]];
    if (val.length === 0) return [[]];
    if (!Array.isArray(val[0])) return val.map(v => [v]);
    return val;
}

/**
 * Flatten a value (scalar, 1D or 2D array) to a single flat 1D array.
 * @param {any} val
 * @returns {Array<any>}
 */
function to2DFlat(val) {
    if (!Array.isArray(val)) return [val];
    if (val.length === 0) return [];
    if (!Array.isArray(val[0])) return val;
    const out = [];
    for (const row of val) for (const v of row) out.push(v);
    return out;
}

/**
 * Build a predicate function from a SUMIF/COUNTIF criteria value.
 * Supports: exact match, ">5", ">=5", "<5", "<=5", "<>5", wildcards (star and ?).
 * @param criteria
 * @returns {Function}
 */
function makeCriteriaPredicate(criteria) {
    if (criteria === null || criteria === undefined) return (v) => v == null;
    const s = String(criteria);
    const opMatch = s.match(/^(>=|<=|<>|>|<|=)(.*)$/);
    if (opMatch) {
        const op = opMatch[1];
        const rawRhs = opMatch[2];
        const rhsNum = Number(rawRhs);
        const rhs = isNaN(rhsNum) ? rawRhs : rhsNum;
        return (v) => {
            const lhs = typeof v === 'string' && !isNaN(Number(v)) ? Number(v) : v;
            switch (op) {
                case '>':  return typeof lhs === 'number' && typeof rhs === 'number' ? lhs > rhs : String(lhs) > String(rhs);
                case '>=': return typeof lhs === 'number' && typeof rhs === 'number' ? lhs >= rhs : String(lhs) >= String(rhs);
                case '<':  return typeof lhs === 'number' && typeof rhs === 'number' ? lhs < rhs : String(lhs) < String(rhs);
                case '<=': return typeof lhs === 'number' && typeof rhs === 'number' ? lhs <= rhs : String(lhs) <= String(rhs);
                case '<>': return lhs !== rhs;
                case '=':  return lhs === rhs;
                default:   return false;
            }
        };
    }
    // Wildcard pattern (* and ?)
    if (s.includes('*') || s.includes('?')) {
        const regex = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        return (v) => regex.test(String(v ?? ''));
    }
    // Exact match (case-insensitive for strings)
    const numCriteria = Number(s);
    const exactNum = !isNaN(numCriteria) ? numCriteria : null;
    return (v) => {
        if (exactNum !== null) {
            const n = typeof v === 'number' ? v : (typeof v === 'string' && !isNaN(Number(v)) ? Number(v) : null);
            if (n !== null) return n === exactNum;
        }
        return String(v ?? '').toLowerCase() === s.toLowerCase();
    };
}

/**
 * Function registry
 */
export const functions = {
    // =========================================================================
    // Mathematical Functions
    // =========================================================================

    SUM: {
        description: 'Add all numbers',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            return nums.reduce((sum, n) => sum + n, 0);
        }
    },

    AVERAGE: {
        description: 'Average of numbers',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            if (nums.length === 0) return FormulaError.DIV_ZERO;
            return nums.reduce((sum, n) => sum + n, 0) / nums.length;
        }
    },

    COUNT: {
        description: 'Count numeric values',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            let count = 0;
            for (const arg of flatten(args)) {
                if (typeof arg === 'number') count++;
            }
            return count;
        }
    },

    COUNTA: {
        description: 'Count non-empty values',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            let count = 0;
            for (const arg of flatten(args)) {
                if (arg !== null && arg !== undefined && arg !== '') count++;
            }
            return count;
        }
    },

    MIN: {
        description: 'Minimum value',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            if (nums.length === 0) return 0;
            return Math.min(...nums);
        }
    },

    MAX: {
        description: 'Maximum value',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            if (nums.length === 0) return 0;
            return Math.max(...nums);
        }
    },

    ABS: {
        description: 'Absolute value',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]);
            if (isError(num)) return num;
            return Math.abs(num);
        }
    },

    ROUND: {
        description: 'Round to specified decimals',
        minArgs: 1,
        maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]);
            if (isError(num)) return num;
            const decimals = args[1] !== undefined ? toNumber(args[1]) : 0;
            if (isError(decimals)) return decimals;
            const factor = Math.pow(10, decimals);
            return Math.round(num * factor) / factor;
        }
    },

    FLOOR: {
        description: 'Round down to nearest integer',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]);
            if (isError(num)) return num;
            return Math.floor(num);
        }
    },

    CEILING: {
        description: 'Round up to nearest integer',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]);
            if (isError(num)) return num;
            return Math.ceil(num);
        }
    },

    SQRT: {
        description: 'Square root',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]);
            if (isError(num)) return num;
            if (num < 0) return FormulaError.NUM;
            return Math.sqrt(num);
        }
    },

    POWER: {
        description: 'Raise to power',
        minArgs: 2,
        maxArgs: 2,
        call: (args) => {
            const base = toNumber(args[0]);
            const exp = toNumber(args[1]);
            if (isError(base)) return base;
            if (isError(exp)) return exp;
            return Math.pow(base, exp);
        }
    },

    MOD: {
        description: 'Modulo (remainder)',
        minArgs: 2,
        maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]);
            const divisor = toNumber(args[1]);
            if (isError(num)) return num;
            if (isError(divisor)) return divisor;
            if (divisor === 0) return FormulaError.DIV_ZERO;
            return num % divisor;
        }
    },

    MROUND: {
        description: 'Round to nearest multiple',
        minArgs: 2,
        maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]);
            const multiple = toNumber(args[1]);
            if (isError(num)) return num;
            if (isError(multiple)) return multiple;
            if (multiple === 0) return 0;
            // number and multiple must have the same sign
            if ((num > 0 && multiple < 0) || (num < 0 && multiple > 0)) return FormulaError.NUM;
            return multiple * Math.round(num / multiple);
        }
    },

    // =========================================================================
    // Logical Functions
    // =========================================================================

    IF: {
        description: 'Conditional',
        minArgs: 2,
        maxArgs: 3,
        call: (args) => {
            const condition = toBoolean(args[0]);
            if (isError(condition)) return condition;
            return condition ? args[1] : (args[2] ?? false);
        }
    },

    AND: {
        description: 'Logical AND',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            for (const arg of flatten(args)) {
                const bool = toBoolean(arg);
                if (isError(bool)) return bool;
                if (!bool) return false;
            }
            return true;
        }
    },

    OR: {
        description: 'Logical OR',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            for (const arg of flatten(args)) {
                const bool = toBoolean(arg);
                if (isError(bool)) return bool;
                if (bool) return true;
            }
            return false;
        }
    },

    NOT: {
        description: 'Logical NOT',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const bool = toBoolean(args[0]);
            if (isError(bool)) return bool;
            return !bool;
        }
    },

    IFERROR: {
        description: 'Return alternative if error',
        minArgs: 2,
        maxArgs: 2,
        call: (args) => {
            const value = args[0];
            if (isError(value)) return args[1];
            return value;
        }
    },

    // =========================================================================
    // Text Functions
    // =========================================================================

    LEN: {
        description: 'Length of text',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]);
            if (isError(str)) return str;
            return str.length;
        }
    },

    UPPER: {
        description: 'Convert to uppercase',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]);
            if (isError(str)) return str;
            return str.toUpperCase();
        }
    },

    LOWER: {
        description: 'Convert to lowercase',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]);
            if (isError(str)) return str;
            return str.toLowerCase();
        }
    },

    TRIM: {
        description: 'Remove extra whitespace',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]);
            if (isError(str)) return str;
            return str.trim().replace(/\s+/g, ' ');
        }
    },

    LEFT: {
        description: 'Leftmost characters',
        minArgs: 1,
        maxArgs: 2,
        call: (args) => {
            const str = toString(args[0]);
            if (isError(str)) return str;
            const num = args[1] !== undefined ? toNumber(args[1]) : 1;
            if (isError(num)) return num;
            return str.slice(0, Math.max(0, num));
        }
    },

    RIGHT: {
        description: 'Rightmost characters',
        minArgs: 1,
        maxArgs: 2,
        call: (args) => {
            const str = toString(args[0]);
            if (isError(str)) return str;
            const num = args[1] !== undefined ? toNumber(args[1]) : 1;
            if (isError(num)) return num;
            return str.slice(-Math.max(0, num));
        }
    },

    MID: {
        description: 'Extract substring',
        minArgs: 3,
        maxArgs: 3,
        call: (args) => {
            const str = toString(args[0]);
            if (isError(str)) return str;
            const start = toNumber(args[1]);
            if (isError(start)) return start;
            const num = toNumber(args[2]);
            if (isError(num)) return num;
            return str.slice(Math.max(0, start - 1), Math.max(0, start - 1 + num));
        }
    },

    CONCATENATE: {
        description: 'Join text strings',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            return args.map(toString).join('');
        }
    },

    CONCAT: {
        description: 'Join text strings',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            return args.map(toString).join('');
        }
    },

    // =========================================================================
    // Lookup Functions
    // =========================================================================

    VLOOKUP: {
        description: 'Vertical lookup',
        minArgs: 3,
        maxArgs: 4,
        call: (args, context) => {
            const lookupValue = args[0];
            const tableArray = args[1];
            const colIndex = toNumber(args[2]);
            const exactMatch = args[3] !== undefined ? toBoolean(args[3]) : true;

            if (isError(colIndex)) return colIndex;
            if (isError(exactMatch)) return exactMatch;

            if (!Array.isArray(tableArray) || colIndex < 1 || colIndex > tableArray[0]?.length) {
                return FormulaError.REF;
            }

            // Search first column
            for (let i = 0; i < tableArray.length; i++) {
                const row = tableArray[i];
                if (!Array.isArray(row)) continue;

                const cellValue = row[0];
                if (exactMatch ? cellValue === lookupValue : cellValue >= lookupValue) {
                    return row[colIndex - 1] ?? FormulaError.NA;
                }
            }

            return FormulaError.NA;
        }
    },

    // =========================================================================
    // Information Functions
    // =========================================================================

    ISBLANK: {
        description: 'Check if cell is blank',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const value = args[0];
            return value === null || value === undefined || value === '';
        }
    },

    ISNUMBER: {
        description: 'Check if value is a number',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            return typeof args[0] === 'number';
        }
    },

    ISTEXT: {
        description: 'Check if value is text',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            return typeof args[0] === 'string' && !isError(args[0]);
        }
    },

    ISERROR: {
        description: 'Check if value is an error',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            return isError(args[0]);
        }
    },

    NA: {
        description: 'Return #N/A error',
        minArgs: 0,
        maxArgs: 0,
        call: () => FormulaError.NA
    },

    // =========================================================================
    // Conditional Aggregate Functions
    // =========================================================================

    SUMIF: {
        description: 'Sum cells matching a condition',
        minArgs: 2,
        maxArgs: 3,
        call: (args) => {
            const range = to2DFlat(args[0]);
            const criteria = args[1];
            const sumRange = args[2] !== undefined ? to2DFlat(args[2]) : range;
            const pred = makeCriteriaPredicate(criteria);
            let total = 0;
            for (let i = 0; i < range.length; i++) {
                if (pred(range[i])) {
                    const v = sumRange[i];
                    if (typeof v === 'number') total += v;
                    else if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) total += Number(v);
                }
            }
            return total;
        }
    },

    COUNTIF: {
        description: 'Count cells matching a condition',
        minArgs: 2,
        maxArgs: 2,
        call: (args) => {
            const range = to2DFlat(args[0]);
            const pred = makeCriteriaPredicate(args[1]);
            return range.filter(v => pred(v)).length;
        }
    },

    AVERAGEIF: {
        description: 'Average of cells matching a condition',
        minArgs: 2,
        maxArgs: 3,
        call: (args) => {
            const range = to2DFlat(args[0]);
            const criteria = args[1];
            const avgRange = args[2] !== undefined ? to2DFlat(args[2]) : range;
            const pred = makeCriteriaPredicate(criteria);
            const nums = [];
            for (let i = 0; i < range.length; i++) {
                if (pred(range[i])) {
                    const v = avgRange[i];
                    if (typeof v === 'number') nums.push(v);
                    else if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) nums.push(Number(v));
                }
            }
            if (nums.length === 0) return FormulaError.DIV_ZERO;
            return nums.reduce((s, n) => s + n, 0) / nums.length;
        }
    },

    // =========================================================================
    // Array / Spill Functions
    // =========================================================================

    FILTER: {
        description: 'Filter a range by one or more conditions',
        minArgs: 2,
        maxArgs: Infinity,
        call: (args) => {
            const range = to2D(args[0]);
            if (!range.length) return FormulaError.NA;
            // Each additional arg is a condition column (same length as range rows)
            const conditions = args.slice(1).map(c => to2DFlat(c));
            const result = [];
            for (let i = 0; i < range.length; i++) {
                if (conditions.every(cond => {
                    const v = cond[i];
                    return v != null && v !== false && v !== 0 && v !== '';
                })) {
                    result.push(range[i]);
                }
            }
            return result.length > 0 ? result : FormulaError.NA;
        }
    },

    SORT: {
        description: 'Sort a range by one or more columns',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            const range = to2D(args[0]);
            if (!range.length) return range;
            // Sort specs: (sortColIndex1, isAsc1, sortColIndex2, isAsc2, ...)
            const specs = [];
            for (let i = 1; i < args.length; i += 2) {
                const _ci = toNumber(args[i]);
                if (isError(_ci)) return _ci;
                const colIdx = Number(_ci);
                const _asc = args[i + 1] !== undefined ? toBoolean(args[i + 1]) : true;
                if (isError(_asc)) return _asc;
                specs.push({ col: colIdx - 1, asc: _asc !== false });
            }
            if (specs.length === 0) specs.push({ col: 0, asc: true });

            const sorted = [...range];
            sorted.sort((a, b) => {
                for (const { col, asc } of specs) {
                    const av = a[col] ?? null;
                    const bv = b[col] ?? null;
                    let cmp = 0;
                    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
                    else if (av == null && bv != null) cmp = -1;
                    else if (av != null && bv == null) cmp = 1;
                    else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
                    if (cmp !== 0) return asc ? cmp : -cmp;
                }
                return 0;
            });
            return sorted;
        }
    },

    UNIQUE: {
        description: 'Return unique rows from a range',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const range = to2D(args[0]);
            const seen = new Set();
            const result = [];
            for (const row of range) {
                const key = JSON.stringify(row);
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(row);
                }
            }
            return result.length > 0 ? result : FormulaError.NA;
        }
    },

    TRANSPOSE: {
        description: 'Transpose rows and columns of a range',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const range = to2D(args[0]);
            if (!range.length || !range[0].length) return FormulaError.REF;
            const rows = range.length;
            const cols = range[0].length;
            const result = [];
            for (let c = 0; c < cols; c++) {
                const newRow = [];
                for (let r = 0; r < rows; r++) {
                    newRow.push(range[r][c] ?? null);
                }
                result.push(newRow);
            }
            return result;
        }
    },

    TOCOL: {
        description: 'Flatten a range into a single column',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            const flat = to2DFlat(args[0]);
            return flat.map(v => [v]);
        }
    },

    TOROW: {
        description: 'Flatten a range into a single row',
        minArgs: 1,
        maxArgs: 1,
        call: (args) => {
            return [to2DFlat(args[0])];
        }
    },

    HSTACK: {
        description: 'Stack arrays horizontally (side by side)',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            const arrays = args.map(a => to2D(a));
            const maxRows = Math.max(...arrays.map(a => a.length));
            const result = [];
            for (let r = 0; r < maxRows; r++) {
                const row = [];
                for (const arr of arrays) {
                    const srcRow = arr[r] ?? new Array(arr[0]?.length ?? 1).fill(null);
                    row.push(...srcRow);
                }
                result.push(row);
            }
            return result;
        }
    },

    VSTACK: {
        description: 'Stack arrays vertically (one below another)',
        minArgs: 1,
        maxArgs: Infinity,
        call: (args) => {
            const arrays = args.map(a => to2D(a));
            const maxCols = Math.max(...arrays.map(a => a[0]?.length ?? 0));
            const result = [];
            for (const arr of arrays) {
                for (const row of arr) {
                    const padded = [...row];
                    while (padded.length < maxCols) padded.push(null);
                    result.push(padded);
                }
            }
            return result;
        }
    },

    TAKE: {
        description: 'Take N rows (positive from top, negative from bottom) and optionally N columns',
        minArgs: 2,
        maxArgs: 3,
        call: (args) => {
            const range = to2D(args[0]);
            const _nRows = toNumber(args[1]);
            if (isError(_nRows)) return _nRows;
            const nRows = Number(_nRows);
            const _nCols = args[2] !== undefined ? toNumber(args[2]) : null;
            if (_nCols !== null && isError(_nCols)) return _nCols;
            const nCols = _nCols !== null ? Number(_nCols) : null;

            const rows = nRows >= 0
                ? range.slice(0, nRows)
                : range.slice(range.length + nRows);

            if (nCols === null) return rows;
            return rows.map(row =>
                nCols >= 0 ? row.slice(0, nCols) : row.slice(row.length + nCols)
            );
        }
    },

    DROP: {
        description: 'Drop N rows (positive from top, negative from bottom) and optionally N columns',
        minArgs: 2,
        maxArgs: 3,
        call: (args) => {
            const range = to2D(args[0]);
            const _nRows = toNumber(args[1]);
            if (isError(_nRows)) return _nRows;
            const nRows = Number(_nRows);
            const _nCols = args[2] !== undefined ? toNumber(args[2]) : null;
            if (_nCols !== null && isError(_nCols)) return _nCols;
            const nCols = _nCols !== null ? Number(_nCols) : null;

            const rows = nRows >= 0
                ? range.slice(nRows)
                : range.slice(0, range.length + nRows);

            if (nCols === null) return rows;
            return rows.map(row =>
                nCols >= 0 ? row.slice(nCols) : row.slice(0, row.length + nCols)
            );
        }
    },

    CHOOSEROWS: {
        description: 'Select specific rows by index (1-based, negative counts from end)',
        minArgs: 2,
        maxArgs: Infinity,
        call: (args) => {
            const range = to2D(args[0]);
            const result = [];
            for (let i = 1; i < args.length; i++) {
                const _idx = toNumber(args[i]);
                if (isError(_idx)) return _idx;
                const idx = Number(_idx);
                const r = idx > 0 ? idx - 1 : range.length + idx;
                if (r < 0 || r >= range.length) return FormulaError.REF;
                result.push(range[r]);
            }
            return result;
        }
    },

    CHOOSECOLS: {
        description: 'Select specific columns by index (1-based, negative counts from end)',
        minArgs: 2,
        maxArgs: Infinity,
        call: (args) => {
            const range = to2D(args[0]);
            const colIndices = [];
            for (let i = 1; i < args.length; i++) {
                const _idx = toNumber(args[i]);
                if (isError(_idx)) return _idx;
                const idx = Number(_idx);
                const c = idx > 0 ? idx - 1 : (range[0]?.length ?? 0) + idx;
                if (c < 0 || c >= (range[0]?.length ?? 0)) return FormulaError.REF;
                colIndices.push(c);
            }
            return range.map(row => colIndices.map(c => row[c] ?? null));
        }
    },

    WRAPCOLS: {
        description: 'Wrap a flat range into columns of a given size',
        minArgs: 2,
        maxArgs: 3,
        call: (args) => {
            const flat = to2DFlat(args[0]);
            const _wc = toNumber(args[1]);
            if (isError(_wc)) return _wc;
            const wrapCount = Number(_wc);
            if (wrapCount < 1) return FormulaError.VALUE;
            const pad = args[2] !== undefined ? args[2] : null;
            const cols = Math.ceil(flat.length / wrapCount);
            const result = [];
            for (let r = 0; r < wrapCount; r++) {
                const row = [];
                for (let c = 0; c < cols; c++) {
                    row.push(flat[c * wrapCount + r] ?? pad);
                }
                result.push(row);
            }
            return result;
        }
    },

    WRAPROWS: {
        description: 'Wrap a flat range into rows of a given size',
        minArgs: 2,
        maxArgs: 3,
        call: (args) => {
            const flat = to2DFlat(args[0]);
            const _wc = toNumber(args[1]);
            if (isError(_wc)) return _wc;
            const wrapCount = Number(_wc);
            if (wrapCount < 1) return FormulaError.VALUE;
            const pad = args[2] !== undefined ? args[2] : null;
            const rows = Math.ceil(flat.length / wrapCount);
            const result = [];
            for (let r = 0; r < rows; r++) {
                const row = [];
                for (let c = 0; c < wrapCount; c++) {
                    const v = flat[r * wrapCount + c];
                    row.push(v !== undefined ? v : pad);
                }
                result.push(row);
            }
            return result;
        }
    },

    EXPAND: {
        description: 'Expand a range to given dimensions, padding with a value',
        minArgs: 3,
        maxArgs: 4,
        call: (args) => {
            const range = to2D(args[0]);
            const _tr = toNumber(args[1]);
            const _tc = toNumber(args[2]);
            if (isError(_tr) || isError(_tc)) return FormulaError.VALUE;
            const targetRows = Number(_tr);
            const targetCols = Number(_tc);
            const pad = args[3] !== undefined ? args[3] : null;
            const result = [];
            for (let r = 0; r < targetRows; r++) {
                const srcRow = range[r];
                const row = [];
                for (let c = 0; c < targetCols; c++) {
                    row.push(srcRow?.[c] ?? pad);
                }
                result.push(row);
            }
            return result;
        }
    }
};

/**
 * Get a function by name
 * @param {string} name - Function name (case-insensitive)
 * @returns {Object|null} - Function definition or null if not found
 */
export function getFunction(name) {
    return functions[name.toUpperCase()] || null;
}

/**
 * Check if a function exists
 * @param {string} name - Function name
 * @returns {boolean}
 */
export function hasFunction(name) {
    return name.toUpperCase() in functions;
}

/**
 * Register a custom function
 * @param {string} name - Function name
 * @param {Object} def - Function definition
 */
export function registerFunction(name, def) {
    functions[name.toUpperCase()] = def;
}

export default functions;
