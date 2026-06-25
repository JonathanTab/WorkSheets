/**
 * _helpers.js — shared utilities for formula function implementations.
 *
 * Exported from here so each domain file imports from one place instead of
 * duplicating the same helpers (toNumber, flatten, etc.) across every file.
 */

import { coerceToSerial } from '../dateCore.js';

// ── Error types ───────────────────────────────────────────────────────────────

export const FormulaError = {
    DIV_ZERO: '#DIV/0!',
    VALUE:    '#VALUE!',
    REF:      '#REF!',
    NAME:     '#NAME?',
    NUM:      '#NUM!',
    NA:       '#N/A',
    NULL:     '#NULL!',
    ERROR:    '#ERROR!',
    CIRC:     '#CIRC!',
    SPILL:    '#SPILL!',
};

/**
 * Map from an error literal string (#REF!, #N/A, …) to its FormulaError constant.
 * Used by the parser to convert literal error tokens to runtime error values.
 */
export const ERROR_LITERALS = new Set(Object.values(FormulaError));

export function isError(value) {
    return typeof value === 'string' && value.startsWith('#');
}

// ── Numeric string parser ─────────────────────────────────────────────────────

const _THOUSANDS_RE = /^-?(\d{1,3})(,\d{3})*(\.\d+)?$/;

/**
 * Parse a human-readable numeric string to a number.
 * Handles: currency symbols ($€£¥₹₽₩₪), thousands separators, trailing %, accounting parens.
 * Returns NaN if the string cannot be interpreted as a number.
 */
export function parseNumericString(str) {
    if (typeof str !== 'string') return NaN;
    let s = str.trim();
    if (s === '') return NaN;

    let negative = false;
    if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1).trim(); }

    let percent = false;
    if (s.endsWith('%')) { percent = true; s = s.slice(0, -1).trim(); }

    s = s.replace(/^[$€£¥₹₽₩₪]\s*/, '');
    if (_THOUSANDS_RE.test(s)) s = s.replace(/,/g, '');

    const n = Number(s);
    if (isNaN(n)) return NaN;

    let result = n;
    if (percent)  result /= 100;
    if (negative) result = -result;
    return result;
}

// ── Type coercions ────────────────────────────────────────────────────────────

export function toNumber(value) {
    if (isError(value)) return value;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        // Blank cell (substituted as "" by table column-ref DSL) coerces to 0,
        // matching how blank cells behave elsewhere in arithmetic. Functions
        // that must reject an explicit empty string (VALUE, NUMBERVALUE) guard
        // for '' themselves before calling toNumber.
        if (value === '') return 0;
        const num = parseNumericString(value);
        if (!isNaN(num)) return num;
        const serial = coerceToSerial(value);
        if (serial !== null) return serial;
        return FormulaError.VALUE;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value == null) return 0;
    return FormulaError.VALUE;
}

export function toDateSerial(value) {
    if (isError(value)) return value;
    if (typeof value === 'number') return value;
    const s = coerceToSerial(value);
    if (s !== null) return s;
    return FormulaError.VALUE;
}

export function toString(value) {
    if (isError(value)) return value;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return '';
}

export function toBoolean(value) {
    if (isError(value)) return value;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const upper = value.toUpperCase();
        if (upper === 'TRUE')  return true;
        if (upper === 'FALSE') return false;
        return FormulaError.VALUE;
    }
    return FormulaError.VALUE;
}

export function toHolidaySerials(value) {
    if (value == null) return [];
    const flat = [];
    const arr = Array.isArray(value) ? value : [value];
    for (const item of arr) {
        if (Array.isArray(item)) {
            for (const v of item) { const s = coerceToSerial(v); if (s !== null) flat.push(Math.floor(s)); }
        } else {
            const s = coerceToSerial(item); if (s !== null) flat.push(Math.floor(s));
        }
    }
    return flat;
}

// ── Array utilities ───────────────────────────────────────────────────────────

export function flatten(arr) {
    const result = [];
    for (const item of arr) {
        if (Array.isArray(item)) result.push(...flatten(item));
        else result.push(item);
    }
    return result;
}

export function getNumericValues(args) {
    const result = [];
    for (const arg of flatten(args)) {
        if (isError(arg)) return [arg];
        if (typeof arg === 'number') result.push(arg);
        else if (typeof arg === 'boolean') result.push(arg ? 1 : 0);
        else if (typeof arg === 'string') {
            const n = parseNumericString(arg);
            if (!isNaN(n)) result.push(n);
        }
    }
    return result;
}

export function to2D(val) {
    if (!Array.isArray(val)) return [[val]];
    if (val.length === 0) return [[]];
    if (!Array.isArray(val[0])) return val.map(v => [v]);
    return val;
}

export function to2DFlat(val) {
    if (!Array.isArray(val)) return [val];
    if (val.length === 0) return [];
    if (!Array.isArray(val[0])) return val;
    const out = [];
    for (const row of val) for (const v of row) out.push(v);
    return out;
}

// ── Criteria predicate ────────────────────────────────────────────────────────

export function makeCriteriaPredicate(criteria) {
    if (criteria === null || criteria === undefined) return (v) => v == null;
    const s = String(criteria);
    const opMatch = s.match(/^(>=|<=|<>|>|<|=)(.*)$/);
    if (opMatch) {
        const op = opMatch[1];
        const rawRhs = opMatch[2];
        const rhsNum = parseNumericString(rawRhs);
        const rhs = isNaN(rhsNum) ? rawRhs : rhsNum;
        return (v) => {
            const _n = typeof v === 'string' ? parseNumericString(v) : NaN;
            const lhs = typeof v === 'string' && !isNaN(_n) ? _n : v;
            switch (op) {
                case '>':  return typeof lhs === 'number' && typeof rhs === 'number' ? lhs > rhs  : String(lhs) > String(rhs);
                case '>=': return typeof lhs === 'number' && typeof rhs === 'number' ? lhs >= rhs : String(lhs) >= String(rhs);
                case '<':  return typeof lhs === 'number' && typeof rhs === 'number' ? lhs < rhs  : String(lhs) < String(rhs);
                case '<=': return typeof lhs === 'number' && typeof rhs === 'number' ? lhs <= rhs : String(lhs) <= String(rhs);
                case '<>': return lhs !== rhs;
                case '=':  return lhs === rhs;
                default:   return false;
            }
        };
    }
    if (s.includes('*') || s.includes('?')) {
        const regex = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        return (v) => regex.test(String(v ?? ''));
    }
    const numCriteria = parseNumericString(s);
    const exactNum = !isNaN(numCriteria) ? numCriteria : null;
    return (v) => {
        if (exactNum !== null) {
            const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseNumericString(v) : NaN);
            if (!isNaN(n)) return n === exactNum;
        }
        return String(v ?? '').toLowerCase() === s.toLowerCase();
    };
}
