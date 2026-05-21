import { FormulaError, isError, toNumber, toBoolean } from './_helpers.js';

export const lookupFunctions = {
    VLOOKUP: {
        category: 'lookup', syntax: 'VLOOKUP(search_key, range, col_index, [exact_match])',
        desc: 'Searches the first column of a range for a key and returns a value from another column in the same row. exact_match defaults to TRUE.',
        example: '=VLOOKUP(A1, B1:D10, 2)  →  value from col 2 matching A1',
        description: 'Vertical lookup', minArgs: 3, maxArgs: 4,
        call: (args) => {
            const lookupValue = args[0]; const tableArray = args[1];
            const colIndex = toNumber(args[2]); if (isError(colIndex)) return colIndex;
            const exactMatch = args[3] !== undefined ? toBoolean(args[3]) : true;
            if (isError(exactMatch)) return exactMatch;
            if (!Array.isArray(tableArray) || colIndex < 1 || colIndex > tableArray[0]?.length) return FormulaError.REF;
            for (let i = 0; i < tableArray.length; i++) {
                const row = tableArray[i]; if (!Array.isArray(row)) continue;
                const cellValue = row[0];
                if (exactMatch ? cellValue === lookupValue : cellValue >= lookupValue) return row[colIndex - 1] ?? FormulaError.NA;
            }
            return FormulaError.NA;
        }
    },

    MATCH: {
        category: 'lookup', syntax: 'MATCH(search_key, range, [match_type])',
        desc: 'Returns the position of a value in a range. match_type: 0=exact, 1=≤(sorted asc), -1=≥(sorted desc). Default is 1.',
        example: '=MATCH("Apple", A1:A10, 0)  →  row number of "Apple"',
        description: 'Position of value in range', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const key = args[0];
            const range = (Array.isArray(args[1]) ? args[1].flat(Infinity) : [args[1]]);
            const matchType = args[2] !== undefined ? toNumber(args[2]) : 1;
            if (isError(matchType)) return matchType;
            const mt = Math.trunc(matchType);
            if (mt === 0) {
                const keyStr = typeof key === 'string' ? key.toLowerCase() : key;
                for (let i = 0; i < range.length; i++) {
                    const v = range[i];
                    if (typeof v === 'string' && typeof key === 'string' ? v.toLowerCase() === keyStr : v === key) return i + 1;
                }
                return FormulaError.NA;
            }
            let bestIdx = -1;
            for (let i = 0; i < range.length; i++) {
                const v = range[i];
                if (mt === 1 && v <= key) bestIdx = i;
                else if (mt === -1 && v >= key) bestIdx = i;
            }
            return bestIdx === -1 ? FormulaError.NA : bestIdx + 1;
        }
    },

    INDEX: {
        category: 'lookup', syntax: 'INDEX(range, row_num, [col_num])',
        desc: 'Returns the value at the given row and column of a range. If col_num is omitted, returns the entire row.',
        example: '=INDEX(A1:C5, 2, 3)  →  value in row 2, col 3 of A1:C5',
        description: 'Value at row and column', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const range = args[0]; const rowNum = toNumber(args[1]);
            if (isError(rowNum)) return rowNum;
            const r = Math.trunc(rowNum);
            if (Array.isArray(range)) {
                const arr2d = Array.isArray(range[0]) ? range : range.map(v => [v]);
                const row = arr2d[r - 1]; if (!row) return FormulaError.REF;
                if (args[2] === undefined) return row.length === 1 ? row[0] : row;
                const colNum = toNumber(args[2]); if (isError(colNum)) return colNum;
                const c = Math.trunc(colNum);
                return c < 1 || c > row.length ? FormulaError.REF : row[c - 1];
            }
            return r === 1 ? range : FormulaError.REF;
        }
    },

    CHOOSE: {
        category: 'lookup', syntax: 'CHOOSE(index, value1, [value2, …])',
        desc: 'Returns the value at the given index from a list of values. index is 1-based.',
        example: '=CHOOSE(2, "Mon", "Tue", "Wed")  →  "Tue"',
        description: 'Choose from list by index', minArgs: 2, maxArgs: Infinity,
        call: (args) => {
            const idx = toNumber(args[0]); if (isError(idx)) return idx;
            const i = Math.trunc(idx);
            if (i < 1 || i >= args.length) return FormulaError.VALUE;
            return args[i];
        }
    },

    LOOKUP: {
        category: 'lookup', syntax: 'LOOKUP(search_key, lookup_range, [result_range])',
        desc: 'Searches a sorted range for a key and returns the corresponding value from result_range.',
        example: '=LOOKUP(A1, B1:B10, C1:C10)  →  matching value from C column',
        description: 'Lookup in sorted range', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const key = args[0];
            const lookup = Array.isArray(args[1]) ? args[1].flat(Infinity) : [args[1]];
            const result = args[2] !== undefined ? (Array.isArray(args[2]) ? args[2].flat(Infinity) : [args[2]]) : lookup;
            let bestIdx = -1;
            for (let i = 0; i < lookup.length; i++) {
                if (lookup[i] <= key) bestIdx = i;
                else break;
            }
            return bestIdx === -1 ? FormulaError.NA : result[bestIdx] ?? FormulaError.NA;
        }
    },
};
