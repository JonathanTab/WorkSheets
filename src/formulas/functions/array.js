import { FormulaError, isError, toNumber, toBoolean, to2D, to2DFlat } from './_helpers.js';

export const arrayFunctions = {
    FILTER: {
        category: 'array', syntax: 'FILTER(range, condition1, [condition2, …])',
        desc: 'Returns rows from range where all conditions are true. Each condition must be a column the same height as range.',
        example: '=FILTER(A1:C10, A1:A10>5)  →  rows where col A > 5',
        description: 'Filter a range by one or more conditions', minArgs: 2, maxArgs: Infinity,
        call: (args) => {
            const range = to2D(args[0]);
            if (!range.length) return FormulaError.NA;
            const conditions = args.slice(1).map(c => to2DFlat(c));
            const result = [];
            for (let i = 0; i < range.length; i++) {
                if (conditions.every(cond => {
                    const v = cond[i];
                    return v != null && v !== false && v !== 0 && v !== '';
                })) result.push(range[i]);
            }
            return result.length > 0 ? result : FormulaError.NA;
        }
    },

    SORT: {
        category: 'array', syntax: 'SORT(range, [sort_col, is_asc, sort_col2, is_asc2, …])',
        desc: 'Sorts a range by one or more columns. sort_col is 1-based; is_asc defaults to TRUE.',
        example: '=SORT(A1:C10)  →  sorted by first column ascending\n=SORT(A1:C10, 2, FALSE)  →  sorted by col 2 descending',
        description: 'Sort a range', minArgs: 1, maxArgs: Infinity,
        call: (args) => {
            const range = to2D(args[0]);
            if (!range.length) return range;
            const specs = [];
            for (let i = 1; i < args.length; i += 2) {
                const _ci = toNumber(args[i]); if (isError(_ci)) return _ci;
                const _asc = args[i + 1] !== undefined ? toBoolean(args[i + 1]) : true;
                if (isError(_asc)) return _asc;
                specs.push({ col: Number(_ci) - 1, asc: _asc !== false });
            }
            if (specs.length === 0) specs.push({ col: 0, asc: true });
            const sorted = [...range];
            sorted.sort((a, b) => {
                for (const { col, asc } of specs) {
                    const av = a[col] ?? null; const bv = b[col] ?? null;
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
        category: 'array', syntax: 'UNIQUE(range)',
        desc: 'Returns the unique rows from a range, preserving order of first occurrence.',
        example: '=UNIQUE(A1:A20)  →  deduplicated list',
        description: 'Return unique rows', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const range = to2D(args[0]);
            const seen = new Set(); const result = [];
            for (const row of range) {
                const key = JSON.stringify(row);
                if (!seen.has(key)) { seen.add(key); result.push(row); }
            }
            return result.length > 0 ? result : FormulaError.NA;
        }
    },

    TRANSPOSE: {
        category: 'array', syntax: 'TRANSPOSE(range)',
        desc: 'Returns the transposed range (rows become columns and vice versa).',
        example: '=TRANSPOSE(A1:C3)  →  3×3 range with rows/cols swapped',
        description: 'Transpose rows and columns', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const range = to2D(args[0]);
            if (!range.length || !range[0].length) return FormulaError.REF;
            const rows = range.length; const cols = range[0].length;
            const result = [];
            for (let c = 0; c < cols; c++) {
                const newRow = [];
                for (let r = 0; r < rows; r++) newRow.push(range[r][c] ?? null);
                result.push(newRow);
            }
            return result;
        }
    },

    TOCOL: {
        category: 'array', syntax: 'TOCOL(range)',
        desc: 'Flattens a range into a single column (each value in its own row).',
        example: '=TOCOL(A1:C3)  →  9 rows, 1 column',
        description: 'Flatten to a single column', minArgs: 1, maxArgs: 1,
        call: (args) => to2DFlat(args[0]).map(v => [v])
    },

    TOROW: {
        category: 'array', syntax: 'TOROW(range)',
        desc: 'Flattens a range into a single row.',
        example: '=TOROW(A1:C3)  →  1 row, 9 columns',
        description: 'Flatten to a single row', minArgs: 1, maxArgs: 1,
        call: (args) => [to2DFlat(args[0])]
    },

    HSTACK: {
        category: 'array', syntax: 'HSTACK(range1, [range2, …])',
        desc: 'Stacks ranges horizontally (side by side). Missing rows are filled with null.',
        example: '=HSTACK(A1:A5, B1:B5)  →  2-column array',
        description: 'Stack arrays side by side', minArgs: 1, maxArgs: Infinity,
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
        category: 'array', syntax: 'VSTACK(range1, [range2, …])',
        desc: 'Stacks ranges vertically (one below another). Missing columns are filled with null.',
        example: '=VSTACK(A1:B3, A4:B6)  →  6-row combined array',
        description: 'Stack arrays vertically', minArgs: 1, maxArgs: Infinity,
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
        category: 'array', syntax: 'TAKE(range, rows, [cols])',
        desc: 'Returns the first N rows (or last N if negative). Optionally limits columns too.',
        example: '=TAKE(A1:C10, 3)  →  first 3 rows\n=TAKE(A1:C10, -2)  →  last 2 rows',
        description: 'Take N rows from a range', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const range = to2D(args[0]);
            const _nRows = toNumber(args[1]); if (isError(_nRows)) return _nRows;
            const nRows = Number(_nRows);
            const _nCols = args[2] !== undefined ? toNumber(args[2]) : null;
            if (_nCols !== null && isError(_nCols)) return _nCols;
            const nCols = _nCols !== null ? Number(_nCols) : null;
            const rows = nRows >= 0 ? range.slice(0, nRows) : range.slice(range.length + nRows);
            if (nCols === null) return rows;
            return rows.map(row => nCols >= 0 ? row.slice(0, nCols) : row.slice(row.length + nCols));
        }
    },

    DROP: {
        category: 'array', syntax: 'DROP(range, rows, [cols])',
        desc: 'Removes the first N rows (or last N if negative). Optionally drops columns too.',
        example: '=DROP(A1:C10, 2)  →  rows 3–10\n=DROP(A1:C10, -1)  →  all but last row',
        description: 'Drop N rows from a range', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const range = to2D(args[0]);
            const _nRows = toNumber(args[1]); if (isError(_nRows)) return _nRows;
            const nRows = Number(_nRows);
            const _nCols = args[2] !== undefined ? toNumber(args[2]) : null;
            if (_nCols !== null && isError(_nCols)) return _nCols;
            const nCols = _nCols !== null ? Number(_nCols) : null;
            const rows = nRows >= 0 ? range.slice(nRows) : range.slice(0, range.length + nRows);
            if (nCols === null) return rows;
            return rows.map(row => nCols >= 0 ? row.slice(nCols) : row.slice(0, row.length + nCols));
        }
    },

    CHOOSEROWS: {
        category: 'array', syntax: 'CHOOSEROWS(range, row1, [row2, …])',
        desc: 'Selects specific rows by 1-based index. Negative index counts from end.',
        example: '=CHOOSEROWS(A1:C5, 1, 3, 5)  →  rows 1, 3, 5',
        description: 'Select rows by index', minArgs: 2, maxArgs: Infinity,
        call: (args) => {
            const range = to2D(args[0]); const result = [];
            for (let i = 1; i < args.length; i++) {
                const _idx = toNumber(args[i]); if (isError(_idx)) return _idx;
                const idx = Number(_idx);
                const r = idx > 0 ? idx - 1 : range.length + idx;
                if (r < 0 || r >= range.length) return FormulaError.REF;
                result.push(range[r]);
            }
            return result;
        }
    },

    CHOOSECOLS: {
        category: 'array', syntax: 'CHOOSECOLS(range, col1, [col2, …])',
        desc: 'Selects specific columns by 1-based index. Negative index counts from end.',
        example: '=CHOOSECOLS(A1:C5, 1, 3)  →  cols A and C only',
        description: 'Select columns by index', minArgs: 2, maxArgs: Infinity,
        call: (args) => {
            const range = to2D(args[0]); const colIndices = [];
            for (let i = 1; i < args.length; i++) {
                const _idx = toNumber(args[i]); if (isError(_idx)) return _idx;
                const idx = Number(_idx);
                const c = idx > 0 ? idx - 1 : (range[0]?.length ?? 0) + idx;
                if (c < 0 || c >= (range[0]?.length ?? 0)) return FormulaError.REF;
                colIndices.push(c);
            }
            return range.map(row => colIndices.map(c => row[c] ?? null));
        }
    },

    WRAPCOLS: {
        category: 'array', syntax: 'WRAPCOLS(range, wrap_count, [pad_value])',
        desc: 'Wraps a flat range into columns of a given size.',
        example: '=WRAPCOLS(A1:A6, 2)  →  3 rows × 2 columns',
        description: 'Wrap range into columns', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const flat = to2DFlat(args[0]);
            const _wc = toNumber(args[1]); if (isError(_wc)) return _wc;
            const wrapCount = Number(_wc); if (wrapCount < 1) return FormulaError.VALUE;
            const pad = args[2] !== undefined ? args[2] : null;
            const cols = Math.ceil(flat.length / wrapCount);
            const result = [];
            for (let r = 0; r < wrapCount; r++) {
                const row = [];
                for (let c = 0; c < cols; c++) row.push(flat[c * wrapCount + r] ?? pad);
                result.push(row);
            }
            return result;
        }
    },

    WRAPROWS: {
        category: 'array', syntax: 'WRAPROWS(range, wrap_count, [pad_value])',
        desc: 'Wraps a flat range into rows of a given size.',
        example: '=WRAPROWS(A1:A6, 2)  →  3 rows × 2 columns',
        description: 'Wrap range into rows', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const flat = to2DFlat(args[0]);
            const _wc = toNumber(args[1]); if (isError(_wc)) return _wc;
            const wrapCount = Number(_wc); if (wrapCount < 1) return FormulaError.VALUE;
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
        category: 'array', syntax: 'EXPAND(range, rows, cols, [pad_value])',
        desc: 'Expands a range to given dimensions, padding extra cells with pad_value (default null).',
        example: '=EXPAND(A1:B2, 4, 4, 0)  →  4×4 array padded with 0',
        description: 'Expand range to given size', minArgs: 3, maxArgs: 4,
        call: (args) => {
            const range = to2D(args[0]);
            const _tr = toNumber(args[1]); const _tc = toNumber(args[2]);
            if (isError(_tr) || isError(_tc)) return FormulaError.VALUE;
            const targetRows = Number(_tr); const targetCols = Number(_tc);
            const pad = args[3] !== undefined ? args[3] : null;
            const result = [];
            for (let r = 0; r < targetRows; r++) {
                const srcRow = range[r]; const row = [];
                for (let c = 0; c < targetCols; c++) row.push(srcRow?.[c] ?? pad);
                result.push(row);
            }
            return result;
        }
    },

    SEQUENCE: {
        category: 'array', syntax: 'SEQUENCE(rows, [cols], [start], [step])',
        desc: 'Generates a sequence of numbers filling rows×cols. Defaults: cols=1, start=1, step=1.',
        example: '=SEQUENCE(5)  →  1,2,3,4,5 (single column)\n=SEQUENCE(2, 3)  →  2×3 grid 1–6',
        description: 'Generate a sequence of numbers', minArgs: 1, maxArgs: 4,
        call: (args) => {
            const rows = Math.max(1, Math.trunc(toNumber(args[0]) || 1));
            const cols = args[1] !== undefined ? Math.max(1, Math.trunc(toNumber(args[1]) || 1)) : 1;
            const start = args[2] !== undefined ? (toNumber(args[2]) || 0) : 1;
            const step  = args[3] !== undefined ? (toNumber(args[3]) || 1) : 1;
            const result = [];
            let v = start;
            for (let r = 0; r < rows; r++) {
                const row = [];
                for (let c = 0; c < cols; c++) { row.push(v); v += step; }
                result.push(row);
            }
            return result;
        }
    },

    FLATTEN: {
        category: 'array', syntax: 'FLATTEN(range)',
        desc: 'Flattens a range into a single-column array of all values (same as TOCOL).',
        example: '=FLATTEN(A1:C3)  →  9 values in a column',
        description: 'Flatten to single column', minArgs: 1, maxArgs: 1,
        call: (args) => to2DFlat(args[0]).map(v => [v])
    },
};
