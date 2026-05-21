import { FormulaError, isError, toBoolean, flatten } from './_helpers.js';

export const logicFunctions = {
    IF: {
        category: 'logic', syntax: 'IF(condition, value_if_true, [value_if_false])',
        desc: 'Returns value_if_true when condition is true, value_if_false otherwise. value_if_false defaults to FALSE.',
        example: '=IF(A1>10, "High", "Low")\n=IF(ISBLANK(B1), "empty", B1)',
        description: 'Conditional', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const condition = toBoolean(args[0]);
            if (isError(condition)) return condition;
            return condition ? args[1] : (args[2] ?? false);
        }
    },

    AND: {
        category: 'logic', syntax: 'AND(value1, [value2, …])',
        desc: 'Returns TRUE if all arguments are true. Short-circuits on first FALSE.',
        example: '=AND(A1>0, B1>0)  →  TRUE only if both positive\n=AND(A1:A5)  →  all must be truthy',
        description: 'Logical AND', minArgs: 1, maxArgs: Infinity,
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
        category: 'logic', syntax: 'OR(value1, [value2, …])',
        desc: 'Returns TRUE if any argument is true.',
        example: '=OR(A1="Yes", A1="Y")  →  accept either value',
        description: 'Logical OR', minArgs: 1, maxArgs: Infinity,
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
        category: 'logic', syntax: 'NOT(value)',
        desc: 'Reverses the logical value of its argument.',
        example: '=NOT(A1>10)  →  TRUE when A1 is 10 or less',
        description: 'Logical NOT', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const bool = toBoolean(args[0]);
            if (isError(bool)) return bool;
            return !bool;
        }
    },

    IFERROR: {
        category: 'logic', syntax: 'IFERROR(value, value_if_error)',
        desc: 'Returns value_if_error if the first argument evaluates to any error, otherwise returns value.',
        example: '=IFERROR(A1/B1, 0)  →  0 when B1 is empty\n=IFERROR(VLOOKUP(...), "Not found")',
        description: 'Return alternative if error', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const value = args[0];
            if (isError(value)) return args[1];
            return value;
        }
    },

    XOR: {
        category: 'logic', syntax: 'XOR(value1, [value2, …])',
        desc: 'Returns TRUE if an odd number of arguments are true (exclusive OR).',
        example: '=XOR(TRUE, FALSE)  →  TRUE\n=XOR(TRUE, TRUE)  →  FALSE',
        description: 'Exclusive OR', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            let trueCount = 0;
            for (const arg of flatten(args)) {
                const bool = toBoolean(arg);
                if (isError(bool)) return bool;
                if (bool) trueCount++;
            }
            return trueCount % 2 === 1;
        }
    },

    IFS: {
        category: 'logic', syntax: 'IFS(condition1, value1, [condition2, value2, …])',
        desc: 'Checks a series of conditions and returns the value paired with the first TRUE condition.',
        example: '=IFS(A1>=90,"A", A1>=80,"B", A1>=70,"C", TRUE,"F")',
        description: 'Multiple conditions', minArgs: 2, maxArgs: Infinity,
        call: (args) => {
            for (let i = 0; i + 1 < args.length; i += 2) {
                const cond = toBoolean(args[i]);
                if (isError(cond)) return cond;
                if (cond) return args[i + 1];
            }
            return FormulaError.NA;
        }
    },

    IFNA: {
        category: 'logic', syntax: 'IFNA(value, value_if_na)',
        desc: 'Returns value_if_na only if the first argument is #N/A. Other errors propagate.',
        example: '=IFNA(VLOOKUP(...), "Not found")',
        description: 'Return alternative on #N/A', minArgs: 2, maxArgs: 2,
        call: (args) => {
            return args[0] === FormulaError.NA ? args[1] : args[0];
        }
    },

    SWITCH: {
        category: 'logic', syntax: 'SWITCH(expression, value1, result1, [value2, result2, …], [default])',
        desc: 'Matches an expression against a list of values and returns the corresponding result.',
        example: '=SWITCH(A1, 1,"Jan", 2,"Feb", 3,"Mar", "Other")',
        description: 'Switch/case expression', minArgs: 3, maxArgs: Infinity,
        call: (args) => {
            const expr = args[0];
            for (let i = 1; i + 1 < args.length; i += 2) {
                if (expr === args[i]) return args[i + 1];
            }
            if (args.length % 2 === 0) return args[args.length - 1]; // default
            return FormulaError.NA;
        }
    },

    TRUE: {
        category: 'logic', syntax: 'TRUE()',
        desc: 'Returns the logical value TRUE.',
        example: '=IF(TRUE(), "yes", "no")  →  "yes"',
        description: 'Logical TRUE', minArgs: 0, maxArgs: 0,
        call: () => true
    },

    FALSE: {
        category: 'logic', syntax: 'FALSE()',
        desc: 'Returns the logical value FALSE.',
        example: '=IF(FALSE(), "yes", "no")  →  "no"',
        description: 'Logical FALSE', minArgs: 0, maxArgs: 0,
        call: () => false
    },
};
