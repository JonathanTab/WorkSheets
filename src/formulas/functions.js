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
