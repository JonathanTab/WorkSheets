import { FormulaError, isError } from './_helpers.js';

export const infoFunctions = {
    ISBLANK: {
        category: 'info', syntax: 'ISBLANK(value)',
        desc: 'Returns TRUE if the cell or value is empty (null, undefined, or empty string).',
        example: '=ISBLANK(A1)  →  TRUE when A1 is empty\n=IF(ISBLANK(B1), "—", B1)',
        description: 'Check if cell is blank', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const value = args[0];
            return value === null || value === undefined || value === '';
        }
    },

    ISNUMBER: {
        category: 'info', syntax: 'ISNUMBER(value)',
        desc: 'Returns TRUE if the value is a number.',
        example: '=ISNUMBER(42)  →  TRUE\n=ISNUMBER("hello")  →  FALSE',
        description: 'Check if value is a number', minArgs: 1, maxArgs: 1,
        call: (args) => typeof args[0] === 'number'
    },

    ISTEXT: {
        category: 'info', syntax: 'ISTEXT(value)',
        desc: 'Returns TRUE if the value is a non-error text string.',
        example: '=ISTEXT("hello")  →  TRUE\n=ISTEXT(42)  →  FALSE',
        description: 'Check if value is text', minArgs: 1, maxArgs: 1,
        call: (args) => typeof args[0] === 'string' && !isError(args[0])
    },

    ISERROR: {
        category: 'info', syntax: 'ISERROR(value)',
        desc: 'Returns TRUE if the value is any error (#DIV/0!, #VALUE!, #REF!, etc.).',
        example: '=ISERROR(A1/B1)  →  TRUE when B1=0',
        description: 'Check if value is an error', minArgs: 1, maxArgs: 1,
        call: (args) => isError(args[0])
    },

    ISLOGICAL: {
        category: 'info', syntax: 'ISLOGICAL(value)',
        desc: 'Returns TRUE if the value is a boolean (TRUE or FALSE).',
        example: '=ISLOGICAL(TRUE())  →  TRUE\n=ISLOGICAL(1)  →  FALSE',
        description: 'Check if value is a boolean', minArgs: 1, maxArgs: 1,
        call: (args) => typeof args[0] === 'boolean'
    },

    ISNA: {
        category: 'info', syntax: 'ISNA(value)',
        desc: 'Returns TRUE if the value is the #N/A error specifically.',
        example: '=ISNA(VLOOKUP(...))  →  TRUE when not found',
        description: 'Check if value is #N/A', minArgs: 1, maxArgs: 1,
        call: (args) => args[0] === FormulaError.NA
    },

    NA: {
        category: 'info', syntax: 'NA()',
        desc: 'Returns the #N/A error value to indicate that a value is not available.',
        example: '=IFERROR(VLOOKUP(...), NA())  →  propagate not-found',
        description: 'Return #N/A error', minArgs: 0, maxArgs: 0,
        call: () => FormulaError.NA
    },

    N: {
        category: 'info', syntax: 'N(value)',
        desc: 'Converts a value to a number. Returns 1 for TRUE, 0 for FALSE, the serial for dates, 0 for text.',
        example: '=N(TRUE())  →  1\n=N("hello")  →  0',
        description: 'Convert to number', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const v = args[0];
            if (typeof v === 'number') return v;
            if (typeof v === 'boolean') return v ? 1 : 0;
            return 0;
        }
    },

    TYPE: {
        category: 'info', syntax: 'TYPE(value)',
        desc: 'Returns a number indicating the type: 1=number, 2=text, 4=boolean, 16=error, 64=array.',
        example: '=TYPE(42)  →  1\n=TYPE("hi")  →  2\n=TYPE(TRUE())  →  4',
        description: 'Type code of value', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const v = args[0];
            if (Array.isArray(v)) return 64;
            if (isError(v)) return 16;
            if (typeof v === 'boolean') return 4;
            if (typeof v === 'string') return 2;
            return 1;
        }
    },
};
