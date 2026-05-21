/**
 * formulaParser - Formula string analysis and display segmentation.
 *
 * Exports:
 *   REFERENCE_COLORS          - shared color palette for ref highlighting
 *   scanRefTokens(content)    - low-level token scanner (single regex pass)
 *   extractRangeRefs(formula) - unique ref rectangles for a formula
 *   findRefPositions(formula) - character spans of all ref tokens
 *   getCursorRefContext(...)  - decide insert/replace/append for ref picking
 *   segmentFormula(formula)   - colored segments for formula bar display
 */

import { parseCellRef } from './refCoords.js';
import { Tokenizer } from './parser.js';

// ── Color palette ─────────────────────────────────────────────────────────────

export const REFERENCE_COLORS = [
    '#ef4444', // red
    '#22c55e', // green
    '#f59e0b', // amber
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#06b6d4', // cyan
    '#f97316', // orange
    '#14b8a6', // teal
    '#a855f7', // purple
];

// ── Token scanner ─────────────────────────────────────────────────────────────

/**
 * @typedef {'cross-sheet-range'|'cross-sheet-cell'|'range'|'cell'|'function'} TokenKind
 *
 * @typedef {Object} RefToken
 * @property {TokenKind} kind
 * @property {number}    start  - index into content (no leading =)
 * @property {number}    end    - exclusive
 * @property {string}    text   - raw matched text
 */

// Token type constants from parser.js (mirrored here to avoid importing the enum object)
const _FUNCTION  = 'FUNCTION';
const _CELL_REF  = 'CELL_REF';
const _COLON     = 'COLON';
const _SHEET_REF = 'SHEET_REF';

/**
 * Scan a formula content string (without leading =) and return every token
 * sorted by start position.
 *
 * Uses parser.js's Tokenizer so lexical rules (string literals, quoted sheet
 * names, $-prefixed refs, etc.) are defined in exactly one place.
 *
 * @param {string} content
 * @returns {RefToken[]}
 */
export function scanRefTokens(content) {
    let rawTokens;
    try {
        rawTokens = new Tokenizer(content).tokenize();
    } catch {
        return [];
    }

    const tokens = /** @type {RefToken[]} */ ([]);

    for (let i = 0; i < rawTokens.length; i++) {
        const tok = rawTokens[i];

        if (tok.type === _FUNCTION) {
            tokens.push({ kind: 'function', start: tok.start, end: tok.end, text: content.slice(tok.start, tok.end) });
            continue;
        }

        if (tok.type === _SHEET_REF) {
            // SHEET_REF already consumed the '!' — next token is a CELL_REF
            const next = rawTokens[i + 1];
            if (!next || next.type !== _CELL_REF) continue;
            const afterNext = rawTokens[i + 2];
            if (afterNext?.type === _COLON) {
                const end2 = rawTokens[i + 3];
                if (end2?.type === _CELL_REF) {
                    const text = content.slice(tok.start, end2.end);
                    tokens.push({ kind: 'cross-sheet-range', start: tok.start, end: end2.end, text });
                    i += 3;
                    continue;
                }
            }
            const text = content.slice(tok.start, next.end);
            tokens.push({ kind: 'cross-sheet-cell', start: tok.start, end: next.end, text });
            i += 1;
            continue;
        }

        if (tok.type === _CELL_REF) {
            const next = rawTokens[i + 1];
            if (next?.type === _COLON) {
                const end2 = rawTokens[i + 2];
                if (end2?.type === _CELL_REF) {
                    const text = content.slice(tok.start, end2.end);
                    tokens.push({ kind: 'range', start: tok.start, end: end2.end, text });
                    i += 2;
                    continue;
                }
            }
            tokens.push({ kind: 'cell', start: tok.start, end: tok.end, text: content.slice(tok.start, tok.end) });
        }
    }

    return tokens;
}

// ── Ref descriptors ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} RefDescriptor
 * @property {string}      refStr    - Uppercased ref string, e.g. "A1:B5" or "Sheet2!C3"
 * @property {boolean}     isRange
 * @property {number}      startRow  - 0-indexed
 * @property {number}      startCol  - 0-indexed
 * @property {number}      endRow    - 0-indexed
 * @property {number}      endCol    - 0-indexed
 * @property {string|null} sheetName - non-null for cross-sheet refs
 */

/**
 * Extract one RefDescriptor per unique reference rectangle in a formula.
 * Duplicated ref strings are collapsed. Cross-sheet refs have sheetName set
 * and must be skipped when rendering the current sheet.
 *
 * @param {string} formula
 * @returns {RefDescriptor[]}
 */
export function extractRangeRefs(formula) {
    if (!formula) return [];
    const content = formula.startsWith('=') ? formula.slice(1) : formula;
    const seen = new Set();
    const results = /** @type {RefDescriptor[]} */ ([]);

    for (const tok of scanRefTokens(content)) {
        if (tok.kind === 'function') continue;
        const refStr = tok.text.toUpperCase();
        if (seen.has(refStr)) continue;
        seen.add(refStr);

        if (tok.kind === 'cross-sheet-range' || tok.kind === 'cross-sheet-cell') {
            const bang      = tok.text.indexOf('!');
            const sheetName = tok.text.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
            const cellPart  = tok.text.slice(bang + 1);
            const colon     = cellPart.indexOf(':');
            if (colon !== -1) {
                const s = parseCellRef(cellPart.slice(0, colon));
                const e = parseCellRef(cellPart.slice(colon + 1));
                if (s && e) results.push({ refStr, isRange: true, sheetName,
                    startRow: Math.min(s.row, e.row), startCol: Math.min(s.col, e.col),
                    endRow:   Math.max(s.row, e.row), endCol:   Math.max(s.col, e.col) });
            } else {
                const s = parseCellRef(cellPart);
                if (s) results.push({ refStr, isRange: false, sheetName,
                    startRow: s.row, startCol: s.col, endRow: s.row, endCol: s.col });
            }
        } else if (tok.kind === 'range') {
            const colon = tok.text.indexOf(':');
            const s = parseCellRef(tok.text.slice(0, colon));
            const e = parseCellRef(tok.text.slice(colon + 1));
            if (s && e) results.push({ refStr, isRange: true, sheetName: null,
                startRow: Math.min(s.row, e.row), startCol: Math.min(s.col, e.col),
                endRow:   Math.max(s.row, e.row), endCol:   Math.max(s.col, e.col) });
        } else {
            const s = parseCellRef(tok.text);
            if (s) results.push({ refStr, isRange: false, sheetName: null,
                startRow: s.row, startCol: s.col, endRow: s.row, endCol: s.col });
        }
    }

    return results;
}

// ── Cursor context ────────────────────────────────────────────────────────────

/**
 * Character spans of every ref token in a formula string.
 * Positions include the leading '=' offset.
 * @param {string} formula
 * @returns {Array<{start: number, end: number}>}
 */
function findRefPositions(formula) {
    if (!formula) return [];
    const content = formula.startsWith('=') ? formula.slice(1) : formula;
    const offset  = formula.startsWith('=') ? 1 : 0;
    return scanRefTokens(content)
        .filter(t => t.kind !== 'function')
        .map(t => ({ start: t.start + offset, end: t.end + offset }));
}

const OPERAND_STARTERS = new Set([',', ';', '(', '+', '-', '*', '/', '^', '&', '=', '<', '>', ':']);

/**
 * @typedef {'replace' | 'insert' | 'append'} RefInsertMode
 */

/**
 * Given a formula string and cursor position, decide what insertReference
 * should do:
 *   replace — cursor is inside an existing ref token → replace it
 *   insert  — cursor follows an operator / open-paren / '=' → insert directly
 *   append  — cursor follows a value or ')' → prepend ',' then insert
 *
 * @param {string} formula
 * @param {number} cursorPos
 * @returns {{ mode: RefInsertMode, replaceStart?: number, replaceEnd?: number }}
 */
export function getCursorRefContext(formula, cursorPos) {
    for (const pos of findRefPositions(formula)) {
        if (cursorPos >= pos.start && cursorPos <= pos.end)
            return { mode: 'replace', replaceStart: pos.start, replaceEnd: pos.end };
    }
    const lastChar = formula.slice(0, cursorPos).trimEnd().slice(-1);
    return (!lastChar || OPERAND_STARTERS.has(lastChar)) ? { mode: 'insert' } : { mode: 'append' };
}

// ── Formula bar segmentation ──────────────────────────────────────────────────

/**
 * Break a formula string into colored segments for the formula bar overlay.
 * Each segment has { text, type, color } where color is non-null for refs.
 *
 * @param {string} formula
 * @returns {Array<{text: string, type: string, color: string|null}>}
 */
export function segmentFormula(formula) {
    if (!formula) return [];

    const hasEq    = formula.startsWith('=');
    const content  = hasEq ? formula.slice(1) : formula;
    const segments = hasEq ? [{ text: '=', type: 'OPERATOR', color: null }] : [];
    const colorMap = new Map();
    let   colorIdx = 0;
    let   lastEnd  = 0;

    for (const tok of scanRefTokens(content)) {
        if (tok.start > lastEnd) _pushText(segments, content.slice(lastEnd, tok.start));

        if (tok.kind === 'function') {
            segments.push({ text: tok.text, type: 'FUNCTION', color: null });
        } else {
            const key = tok.text.toUpperCase();
            if (!colorMap.has(key)) colorMap.set(key, REFERENCE_COLORS[colorIdx++ % REFERENCE_COLORS.length]);
            const type = (tok.kind === 'range' || tok.kind === 'cross-sheet-range') ? 'RANGE' : 'CELL_REF';
            segments.push({ text: tok.text, type, color: colorMap.get(key) });
        }

        lastEnd = tok.end;
    }

    if (lastEnd < content.length) _pushText(segments, content.slice(lastEnd));
    return segments;
}

function _pushText(segments, text) {
    let cur = '', isWS = /^\s/.test(text[0] || '');
    for (const ch of text) {
        const cWS = /\s/.test(ch);
        if (cWS !== isWS) {
            if (cur) segments.push({ text: cur, type: isWS ? 'WHITESPACE' : 'TEXT', color: null });
            cur = ch; isWS = cWS;
        } else { cur += ch; }
    }
    if (cur) segments.push({ text: cur, type: isWS ? 'WHITESPACE' : 'TEXT', color: null });
}
