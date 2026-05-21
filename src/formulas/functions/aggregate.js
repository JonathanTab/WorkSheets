import { FormulaError, isError, toNumber, to2DFlat, makeCriteriaPredicate } from './_helpers.js';

export const aggregateFunctions = {
    SUMIF: {
        category: 'aggregate', syntax: 'SUMIF(range, criteria, [sum_range])',
        desc: 'Sums cells in sum_range (or range) where the corresponding cell in range meets criteria.',
        example: '=SUMIF(A1:A10, ">5", B1:B10)  →  sum of B where A>5\n=SUMIF(A1:A10, "apples")  →  sum of A for "apples"',
        description: 'Sum cells matching a condition', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const range = to2DFlat(args[0]); const criteria = args[1];
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

    SUMIFS: {
        category: 'aggregate', syntax: 'SUMIFS(sum_range, criteria_range1, criteria1, [range2, criteria2, …])',
        desc: 'Sums cells meeting multiple conditions (all conditions must be true).',
        example: '=SUMIFS(C1:C10, A1:A10,">5", B1:B10,"Yes")  →  sum where A>5 AND B="Yes"',
        description: 'Sum cells matching multiple conditions', minArgs: 3, maxArgs: Infinity,
        call: (args) => {
            const sumRange = to2DFlat(args[0]);
            const condPairs = [];
            for (let i = 1; i + 1 < args.length; i += 2)
                condPairs.push({ range: to2DFlat(args[i]), pred: makeCriteriaPredicate(args[i + 1]) });
            let total = 0;
            for (let i = 0; i < sumRange.length; i++) {
                if (condPairs.every(p => p.pred(p.range[i]))) {
                    const v = sumRange[i];
                    if (typeof v === 'number') total += v;
                }
            }
            return total;
        }
    },

    COUNTIF: {
        category: 'aggregate', syntax: 'COUNTIF(range, criteria)',
        desc: 'Counts cells in range that meet criteria. Supports operators (>5), wildcards (*), and text.',
        example: '=COUNTIF(A1:A10, ">5")  →  count of A values above 5\n=COUNTIF(A1:A10, "Yes")',
        description: 'Count cells matching a condition', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const range = to2DFlat(args[0]);
            return range.filter(makeCriteriaPredicate(args[1])).length;
        }
    },

    COUNTIFS: {
        category: 'aggregate', syntax: 'COUNTIFS(criteria_range1, criteria1, [range2, criteria2, …])',
        desc: 'Counts cells meeting multiple conditions (all conditions must be true).',
        example: '=COUNTIFS(A1:A10,">5", B1:B10,"Yes")  →  count where both conditions match',
        description: 'Count cells matching multiple conditions', minArgs: 2, maxArgs: Infinity,
        call: (args) => {
            const condPairs = [];
            for (let i = 0; i + 1 < args.length; i += 2)
                condPairs.push({ range: to2DFlat(args[i]), pred: makeCriteriaPredicate(args[i + 1]) });
            if (!condPairs.length) return 0;
            const len = condPairs[0].range.length;
            let count = 0;
            for (let i = 0; i < len; i++)
                if (condPairs.every(p => p.pred(p.range[i]))) count++;
            return count;
        }
    },

    AVERAGEIF: {
        category: 'aggregate', syntax: 'AVERAGEIF(range, criteria, [average_range])',
        desc: 'Averages cells in average_range (or range) where the corresponding cell in range meets criteria.',
        example: '=AVERAGEIF(A1:A10, ">0", B1:B10)  →  average of B where A is positive',
        description: 'Average of cells matching a condition', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const range = to2DFlat(args[0]); const criteria = args[1];
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

    AVERAGEIFS: {
        category: 'aggregate', syntax: 'AVERAGEIFS(average_range, criteria_range1, criteria1, [range2, criteria2, …])',
        desc: 'Averages cells meeting multiple conditions.',
        example: '=AVERAGEIFS(C1:C10, A1:A10,">0", B1:B10,"Yes")',
        description: 'Average of cells matching multiple conditions', minArgs: 3, maxArgs: Infinity,
        call: (args) => {
            const avgRange = to2DFlat(args[0]);
            const condPairs = [];
            for (let i = 1; i + 1 < args.length; i += 2)
                condPairs.push({ range: to2DFlat(args[i]), pred: makeCriteriaPredicate(args[i + 1]) });
            const nums = [];
            for (let i = 0; i < avgRange.length; i++) {
                if (condPairs.every(p => p.pred(p.range[i]))) {
                    const v = avgRange[i];
                    if (typeof v === 'number') nums.push(v);
                }
            }
            return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : FormulaError.DIV_ZERO;
        }
    },

    MAXIFS: {
        category: 'aggregate', syntax: 'MAXIFS(max_range, criteria_range1, criteria1, [range2, criteria2, …])',
        desc: 'Returns the maximum value meeting all criteria.',
        example: '=MAXIFS(C1:C10, A1:A10,"East")  →  max of C where A is "East"',
        description: 'Maximum matching multiple conditions', minArgs: 3, maxArgs: Infinity,
        call: (args) => {
            const maxRange = to2DFlat(args[0]);
            const condPairs = [];
            for (let i = 1; i + 1 < args.length; i += 2)
                condPairs.push({ range: to2DFlat(args[i]), pred: makeCriteriaPredicate(args[i + 1]) });
            let max = -Infinity;
            for (let i = 0; i < maxRange.length; i++) {
                if (condPairs.every(p => p.pred(p.range[i]))) {
                    const v = Number(maxRange[i]); if (!isNaN(v) && v > max) max = v;
                }
            }
            return isFinite(max) ? max : 0;
        }
    },

    MINIFS: {
        category: 'aggregate', syntax: 'MINIFS(min_range, criteria_range1, criteria1, [range2, criteria2, …])',
        desc: 'Returns the minimum value meeting all criteria.',
        example: '=MINIFS(C1:C10, A1:A10,"East")  →  min of C where A is "East"',
        description: 'Minimum matching multiple conditions', minArgs: 3, maxArgs: Infinity,
        call: (args) => {
            const minRange = to2DFlat(args[0]);
            const condPairs = [];
            for (let i = 1; i + 1 < args.length; i += 2)
                condPairs.push({ range: to2DFlat(args[i]), pred: makeCriteriaPredicate(args[i + 1]) });
            let min = Infinity;
            for (let i = 0; i < minRange.length; i++) {
                if (condPairs.every(p => p.pred(p.range[i]))) {
                    const v = Number(minRange[i]); if (!isNaN(v) && v < min) min = v;
                }
            }
            return isFinite(min) ? min : 0;
        }
    },
};
