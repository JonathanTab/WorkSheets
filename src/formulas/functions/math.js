import { FormulaError, isError, toNumber, getNumericValues, flatten, parseNumericString } from './_helpers.js';

export const mathFunctions = {
    SUM: {
        category: 'math', syntax: 'SUM(value1, [value2, …])',
        desc: 'Returns the sum of all numeric values. Accepts individual values, cell references, and ranges.',
        example: '=SUM(A1:A10)  →  sum of rows 1–10\n=SUM(A1, B1, C1)  →  sum of three cells',
        description: 'Add all numbers', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            return nums.reduce((sum, n) => sum + n, 0);
        }
    },

    AVERAGE: {
        category: 'math', syntax: 'AVERAGE(value1, [value2, …])',
        desc: 'Returns the arithmetic mean of all numeric values. Non-numeric values are ignored.',
        example: '=AVERAGE(B1:B5)  →  average of five values',
        description: 'Average of numbers', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            if (nums.length === 0) return FormulaError.DIV_ZERO;
            return nums.reduce((sum, n) => sum + n, 0) / nums.length;
        }
    },

    COUNT: {
        category: 'math', syntax: 'COUNT(value1, [value2, …])',
        desc: 'Counts cells that contain numbers. Text and empty cells are not counted.',
        example: '=COUNT(A1:A20)  →  how many cells contain numbers',
        description: 'Count numeric values', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            let count = 0;
            for (const arg of flatten(args)) { if (typeof arg === 'number') count++; }
            return count;
        }
    },

    COUNTA: {
        category: 'math', syntax: 'COUNTA(value1, [value2, …])',
        desc: 'Counts all non-empty cells regardless of type (numbers, text, dates, etc.).',
        example: '=COUNTA(A1:A20)  →  how many cells are non-empty',
        description: 'Count non-empty values', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            let count = 0;
            for (const arg of flatten(args)) { if (arg !== null && arg !== undefined && arg !== '') count++; }
            return count;
        }
    },

    MIN: {
        category: 'math', syntax: 'MIN(value1, [value2, …])',
        desc: 'Returns the smallest value in a set of numbers.',
        example: '=MIN(A1:A10)  →  lowest number in range',
        description: 'Minimum value', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            if (nums.length === 0) return 0;
            return Math.min(...nums);
        }
    },

    MAX: {
        category: 'math', syntax: 'MAX(value1, [value2, …])',
        desc: 'Returns the largest value in a set of numbers.',
        example: '=MAX(A1:A10)  →  highest number in range',
        description: 'Maximum value', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            if (nums.length === 0) return 0;
            return Math.max(...nums);
        }
    },

    ABS: {
        category: 'math', syntax: 'ABS(number)',
        desc: 'Returns the absolute (non-negative) value of a number.',
        example: '=ABS(-5)  →  5\n=ABS(A1)  →  positive version of A1',
        description: 'Absolute value', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return Math.abs(num);
        }
    },

    ROUND: {
        category: 'math', syntax: 'ROUND(number, [decimals])',
        desc: 'Rounds a number to the specified number of decimal places. Defaults to 0.',
        example: '=ROUND(3.14159, 2)  →  3.14\n=ROUND(2.5)  →  3',
        description: 'Round to specified decimals', minArgs: 1, maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            const decimals = args[1] !== undefined ? toNumber(args[1]) : 0;
            if (isError(decimals)) return decimals;
            const factor = Math.pow(10, decimals);
            return Math.round(num * factor) / factor;
        }
    },

    FLOOR: {
        category: 'math', syntax: 'FLOOR(number)',
        desc: 'Rounds a number down to the nearest integer (toward negative infinity).',
        example: '=FLOOR(3.7)  →  3\n=FLOOR(-1.2)  →  -2',
        description: 'Round down to nearest integer', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return Math.floor(num);
        }
    },

    CEILING: {
        category: 'math', syntax: 'CEILING(number)',
        desc: 'Rounds a number up to the nearest integer (toward positive infinity).',
        example: '=CEILING(3.2)  →  4\n=CEILING(-1.7)  →  -1',
        description: 'Round up to nearest integer', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return Math.ceil(num);
        }
    },

    SQRT: {
        category: 'math', syntax: 'SQRT(number)',
        desc: 'Returns the square root of a non-negative number.',
        example: '=SQRT(16)  →  4\n=SQRT(A1)  →  square root of A1',
        description: 'Square root', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            if (num < 0) return FormulaError.NUM;
            return Math.sqrt(num);
        }
    },

    POWER: {
        category: 'math', syntax: 'POWER(base, exponent)',
        desc: 'Returns base raised to the power of exponent.',
        example: '=POWER(2, 10)  →  1024\n=POWER(9, 0.5)  →  3',
        description: 'Raise to power', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const base = toNumber(args[0]); const exp = toNumber(args[1]);
            if (isError(base)) return base; if (isError(exp)) return exp;
            return Math.pow(base, exp);
        }
    },

    MOD: {
        category: 'math', syntax: 'MOD(number, divisor)',
        desc: 'Returns the remainder after dividing number by divisor. Result has the same sign as divisor.',
        example: '=MOD(10, 3)  →  1\n=MOD(A1, 2)  →  0 if A1 is even',
        description: 'Modulo (remainder)', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]); const divisor = toNumber(args[1]);
            if (isError(num)) return num; if (isError(divisor)) return divisor;
            if (divisor === 0) return FormulaError.DIV_ZERO;
            return num % divisor;
        }
    },

    MROUND: {
        category: 'math', syntax: 'MROUND(number, multiple)',
        desc: 'Rounds a number to the nearest multiple of another number.',
        example: '=MROUND(7, 3)  →  6\n=MROUND(5.7, 0.5)  →  5.5',
        description: 'Round to nearest multiple', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]); const multiple = toNumber(args[1]);
            if (isError(num)) return num; if (isError(multiple)) return multiple;
            if (multiple === 0) return 0;
            if ((num > 0 && multiple < 0) || (num < 0 && multiple > 0)) return FormulaError.NUM;
            return multiple * Math.round(num / multiple);
        }
    },

    INT: {
        category: 'math', syntax: 'INT(number)',
        desc: 'Rounds a number down to the nearest integer (same as FLOOR for positive numbers).',
        example: '=INT(3.9)  →  3\n=INT(-1.1)  →  -2',
        description: 'Round down to integer', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return Math.floor(num);
        }
    },

    TRUNC: {
        category: 'math', syntax: 'TRUNC(number, [decimals])',
        desc: 'Truncates a number toward zero to the specified number of decimals.',
        example: '=TRUNC(3.9)  →  3\n=TRUNC(-1.9)  →  -1',
        description: 'Truncate toward zero', minArgs: 1, maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            const decimals = args[1] !== undefined ? toNumber(args[1]) : 0;
            if (isError(decimals)) return decimals;
            const factor = Math.pow(10, decimals);
            return Math.trunc(num * factor) / factor;
        }
    },

    ROUNDUP: {
        category: 'math', syntax: 'ROUNDUP(number, decimals)',
        desc: 'Rounds a number away from zero to the specified number of decimal places.',
        example: '=ROUNDUP(3.1, 0)  →  4\n=ROUNDUP(-3.1, 0)  →  -4',
        description: 'Round away from zero', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]); const decimals = toNumber(args[1]);
            if (isError(num)) return num; if (isError(decimals)) return decimals;
            const factor = Math.pow(10, decimals);
            return num >= 0 ? Math.ceil(num * factor) / factor : -Math.ceil(-num * factor) / factor;
        }
    },

    ROUNDDOWN: {
        category: 'math', syntax: 'ROUNDDOWN(number, decimals)',
        desc: 'Rounds a number toward zero to the specified number of decimal places.',
        example: '=ROUNDDOWN(3.9, 0)  →  3\n=ROUNDDOWN(-3.9, 0)  →  -3',
        description: 'Round toward zero', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]); const decimals = toNumber(args[1]);
            if (isError(num)) return num; if (isError(decimals)) return decimals;
            const factor = Math.pow(10, decimals);
            return num >= 0 ? Math.floor(num * factor) / factor : -Math.floor(-num * factor) / factor;
        }
    },

    SIGN: {
        category: 'math', syntax: 'SIGN(number)',
        desc: 'Returns 1 if positive, -1 if negative, 0 if zero.',
        example: '=SIGN(-5)  →  -1\n=SIGN(3)  →  1\n=SIGN(0)  →  0',
        description: 'Sign of number', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return Math.sign(num);
        }
    },

    LOG: {
        category: 'math', syntax: 'LOG(number, [base])',
        desc: 'Returns the logarithm of a number to a specified base. Base defaults to 10.',
        example: '=LOG(100)  →  2\n=LOG(8, 2)  →  3',
        description: 'Logarithm', minArgs: 1, maxArgs: 2,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            const base = args[1] !== undefined ? toNumber(args[1]) : 10;
            if (isError(base)) return base;
            if (num <= 0 || base <= 0 || base === 1) return FormulaError.NUM;
            return Math.log(num) / Math.log(base);
        }
    },

    LN: {
        category: 'math', syntax: 'LN(number)',
        desc: 'Returns the natural logarithm (base e) of a number.',
        example: '=LN(1)  →  0\n=LN(EXP(1))  →  1',
        description: 'Natural logarithm', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            if (num <= 0) return FormulaError.NUM;
            return Math.log(num);
        }
    },

    EXP: {
        category: 'math', syntax: 'EXP(number)',
        desc: 'Returns e raised to the power of number.',
        example: '=EXP(1)  →  2.718…\n=EXP(0)  →  1',
        description: 'Exponential', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return Math.exp(num);
        }
    },

    PI: {
        category: 'math', syntax: 'PI()',
        desc: 'Returns the value of π (3.14159…).',
        example: '=PI()  →  3.14159…\n=PI()*R^2  →  area of circle with radius R',
        description: 'Pi constant', minArgs: 0, maxArgs: 0,
        call: () => Math.PI
    },

    RAND: {
        category: 'math', syntax: 'RAND()',
        desc: 'Returns a random number between 0 (inclusive) and 1 (exclusive). Recalculates on each change.',
        example: '=RAND()  →  0.47…\n=RAND()*100  →  random 0–100',
        description: 'Random number 0–1', minArgs: 0, maxArgs: 0,
        call: () => Math.random()
    },

    RANDBETWEEN: {
        category: 'math', syntax: 'RANDBETWEEN(bottom, top)',
        desc: 'Returns a random integer between bottom and top (inclusive).',
        example: '=RANDBETWEEN(1, 10)  →  random integer 1–10',
        description: 'Random integer in range', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const lo = toNumber(args[0]); const hi = toNumber(args[1]);
            if (isError(lo)) return lo; if (isError(hi)) return hi;
            return Math.floor(Math.random() * (Math.floor(hi) - Math.ceil(lo) + 1)) + Math.ceil(lo);
        }
    },

    PRODUCT: {
        category: 'math', syntax: 'PRODUCT(value1, [value2, …])',
        desc: 'Multiplies all numeric values together.',
        example: '=PRODUCT(2, 3, 4)  →  24\n=PRODUCT(A1:A5)  →  product of range',
        description: 'Product of numbers', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 1 && isError(nums[0])) return nums[0];
            if (nums.length === 0) return 0;
            return nums.reduce((p, n) => p * n, 1);
        }
    },

    SUMPRODUCT: {
        category: 'math', syntax: 'SUMPRODUCT(array1, [array2, …])',
        desc: 'Multiplies corresponding elements of arrays and returns their sum.',
        example: '=SUMPRODUCT(A1:A3, B1:B3)  →  A1*B1 + A2*B2 + A3*B3',
        description: 'Sum of products', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const arrays = args.map(a => {
                const flat = [];
                for (const v of (Array.isArray(a) ? a.flat(Infinity) : [a])) {
                    const n = toNumber(v);
                    flat.push(isError(n) ? 0 : n);
                }
                return flat;
            });
            const len = Math.min(...arrays.map(a => a.length));
            let sum = 0;
            for (let i = 0; i < len; i++) sum += arrays.reduce((p, a) => p * (a[i] ?? 0), 1);
            return sum;
        }
    },

    FACT: {
        category: 'math', syntax: 'FACT(number)',
        desc: 'Returns the factorial of a non-negative integer.',
        example: '=FACT(5)  →  120\n=FACT(0)  →  1',
        description: 'Factorial', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            const n = Math.trunc(num);
            if (n < 0) return FormulaError.NUM;
            let result = 1;
            for (let i = 2; i <= n; i++) result *= i;
            return result;
        }
    },

    COMBIN: {
        category: 'math', syntax: 'COMBIN(n, k)',
        desc: 'Returns the number of combinations of n items taken k at a time.',
        example: '=COMBIN(5, 2)  →  10',
        description: 'Combinations', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const n = toNumber(args[0]); const k = toNumber(args[1]);
            if (isError(n)) return n; if (isError(k)) return k;
            const ni = Math.trunc(n), ki = Math.trunc(k);
            if (ki < 0 || ki > ni) return FormulaError.NUM;
            if (ki === 0 || ki === ni) return 1;
            let result = 1;
            for (let i = 0; i < ki; i++) result = result * (ni - i) / (i + 1);
            return Math.round(result);
        }
    },

    GCD: {
        category: 'math', syntax: 'GCD(number1, [number2, …])',
        desc: 'Returns the greatest common divisor of the given integers.',
        example: '=GCD(12, 8)  →  4\n=GCD(24, 36, 48)  →  12',
        description: 'Greatest common divisor', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args).map(Math.trunc);
            if (nums.length === 0) return 0;
            const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
            return nums.reduce((a, b) => gcd(Math.abs(a), Math.abs(b)), 0);
        }
    },

    LCM: {
        category: 'math', syntax: 'LCM(number1, [number2, …])',
        desc: 'Returns the least common multiple of the given integers.',
        example: '=LCM(4, 6)  →  12\n=LCM(3, 4, 5)  →  60',
        description: 'Least common multiple', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args).map(Math.trunc);
            if (nums.length === 0) return 0;
            const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
            const lcm = (a, b) => { const g = gcd(Math.abs(a), Math.abs(b)); return g === 0 ? 0 : Math.abs(a * b) / g; };
            return nums.reduce(lcm, 1);
        }
    },

    QUOTIENT: {
        category: 'math', syntax: 'QUOTIENT(numerator, denominator)',
        desc: 'Returns the integer part of a division.',
        example: '=QUOTIENT(10, 3)  →  3',
        description: 'Integer division', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const n = toNumber(args[0]); const d = toNumber(args[1]);
            if (isError(n)) return n; if (isError(d)) return d;
            if (d === 0) return FormulaError.DIV_ZERO;
            return Math.trunc(n / d);
        }
    },

    EVEN: {
        category: 'math', syntax: 'EVEN(number)',
        desc: 'Rounds a number up to the nearest even integer.',
        example: '=EVEN(3)  →  4\n=EVEN(-1)  →  -2',
        description: 'Round up to even', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            const n = Math.ceil(Math.abs(num));
            const even = n % 2 === 0 ? n : n + 1;
            return num >= 0 ? even : -even;
        }
    },

    ODD: {
        category: 'math', syntax: 'ODD(number)',
        desc: 'Rounds a number up to the nearest odd integer.',
        example: '=ODD(4)  →  5\n=ODD(-2)  →  -3',
        description: 'Round up to odd', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            const n = Math.ceil(Math.abs(num));
            const odd = n % 2 === 1 ? n : n + 1;
            return num >= 0 ? odd : -odd;
        }
    },

    ISODD: {
        category: 'math', syntax: 'ISODD(number)',
        desc: 'Returns TRUE if the number is odd.',
        example: '=ISODD(3)  →  TRUE\n=ISODD(4)  →  FALSE',
        description: 'Check if odd', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return Math.trunc(Math.abs(num)) % 2 === 1;
        }
    },

    ISEVEN: {
        category: 'math', syntax: 'ISEVEN(number)',
        desc: 'Returns TRUE if the number is even.',
        example: '=ISEVEN(4)  →  TRUE\n=ISEVEN(3)  →  FALSE',
        description: 'Check if even', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return Math.trunc(Math.abs(num)) % 2 === 0;
        }
    },

    LARGE: {
        category: 'math', syntax: 'LARGE(range, k)',
        desc: 'Returns the k-th largest value in a range. k=1 returns the maximum.',
        example: '=LARGE(A1:A10, 1)  →  largest\n=LARGE(A1:A10, 2)  →  second largest',
        description: 'K-th largest value', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const nums = getNumericValues([args[0]]).sort((a, b) => b - a);
            const k = toNumber(args[1]); if (isError(k)) return k;
            const idx = Math.trunc(k) - 1;
            if (idx < 0 || idx >= nums.length) return FormulaError.NUM;
            return nums[idx];
        }
    },

    SMALL: {
        category: 'math', syntax: 'SMALL(range, k)',
        desc: 'Returns the k-th smallest value in a range. k=1 returns the minimum.',
        example: '=SMALL(A1:A10, 1)  →  smallest\n=SMALL(A1:A10, 2)  →  second smallest',
        description: 'K-th smallest value', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const nums = getNumericValues([args[0]]).sort((a, b) => a - b);
            const k = toNumber(args[1]); if (isError(k)) return k;
            const idx = Math.trunc(k) - 1;
            if (idx < 0 || idx >= nums.length) return FormulaError.NUM;
            return nums[idx];
        }
    },

    MEDIAN: {
        category: 'math', syntax: 'MEDIAN(value1, [value2, …])',
        desc: 'Returns the median (middle value) of the given numbers.',
        example: '=MEDIAN(1, 2, 3, 4, 5)  →  3\n=MEDIAN(A1:A10)',
        description: 'Median value', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args).sort((a, b) => a - b);
            if (nums.length === 0) return FormulaError.NUM;
            const mid = Math.floor(nums.length / 2);
            return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
        }
    },

    STDEV: {
        category: 'math', syntax: 'STDEV(value1, [value2, …])',
        desc: 'Returns the sample standard deviation of the given numbers.',
        example: '=STDEV(A1:A10)  →  sample std dev',
        description: 'Sample standard deviation', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length < 2) return FormulaError.DIV_ZERO;
            const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
            const variance = nums.reduce((s, n) => s + (n - mean) ** 2, 0) / (nums.length - 1);
            return Math.sqrt(variance);
        }
    },

    STDEVP: {
        category: 'math', syntax: 'STDEVP(value1, [value2, …])',
        desc: 'Returns the population standard deviation.',
        example: '=STDEVP(A1:A10)  →  population std dev',
        description: 'Population standard deviation', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 0) return FormulaError.DIV_ZERO;
            const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
            const variance = nums.reduce((s, n) => s + (n - mean) ** 2, 0) / nums.length;
            return Math.sqrt(variance);
        }
    },

    VAR: {
        category: 'math', syntax: 'VAR(value1, [value2, …])',
        desc: 'Returns the sample variance of the given numbers.',
        example: '=VAR(A1:A10)  →  sample variance',
        description: 'Sample variance', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length < 2) return FormulaError.DIV_ZERO;
            const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
            return nums.reduce((s, n) => s + (n - mean) ** 2, 0) / (nums.length - 1);
        }
    },

    VARP: {
        category: 'math', syntax: 'VARP(value1, [value2, …])',
        desc: 'Returns the population variance.',
        example: '=VARP(A1:A10)  →  population variance',
        description: 'Population variance', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const nums = getNumericValues(args);
            if (nums.length === 0) return FormulaError.DIV_ZERO;
            const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
            return nums.reduce((s, n) => s + (n - mean) ** 2, 0) / nums.length;
        }
    },

    RANK: {
        category: 'math', syntax: 'RANK(number, range, [order])',
        desc: 'Returns the rank of a number in a list. order=0 (default) ranks descending; order=1 ranks ascending.',
        example: '=RANK(A1, A1:A10)  →  rank from largest\n=RANK(A1, A1:A10, 1)  →  rank from smallest',
        description: 'Rank in range', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            const nums = getNumericValues([args[1]]);
            const order = args[2] !== undefined ? toNumber(args[2]) : 0;
            if (isError(order)) return order;
            const sorted = [...nums].sort((a, b) => order ? a - b : b - a);
            const idx = sorted.indexOf(num);
            return idx === -1 ? FormulaError.NA : idx + 1;
        }
    },

    PERCENTILE: {
        category: 'math', syntax: 'PERCENTILE(range, k)',
        desc: 'Returns the k-th percentile of values in a range. k is between 0 and 1.',
        example: '=PERCENTILE(A1:A10, 0.9)  →  90th percentile',
        description: 'K-th percentile', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const nums = getNumericValues([args[0]]).sort((a, b) => a - b);
            const k = toNumber(args[1]); if (isError(k)) return k;
            if (k < 0 || k > 1) return FormulaError.NUM;
            if (nums.length === 0) return FormulaError.NUM;
            const idx = k * (nums.length - 1);
            const lo = Math.floor(idx); const hi = Math.ceil(idx);
            return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
        }
    },
};
