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

/**
 * Scan a formula content string (without leading =) and return every token
 * sorted by start position, with string literals and already-claimed spans
 * excluded via a Uint8Array mask (O(n) build, O(1) query).
 *
 * @param {string} content
 * @returns {RefToken[]}
 */
export function scanRefTokens(content) {
    const mask = new Uint8Array(content.length);
    let i = 0, m;

    // Mark string literals in mask
    while (i < content.length) {
        if (content[i] === '"') {
            const s = i++;
            while (i < content.length) {
                if (content[i++] === '"') {
                    if (content[i] === '"') i++; // escaped ""
                    else break;
                }
            }
            mask.fill(1, s, i);
        } else { i++; }
    }

    const tokens = /** @type {RefToken[]} */ ([]);

    // Cross-sheet refs first (Sheet1!A1 or Sheet1!A1:B5)
    const crossSheetRe =
        /(?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]+\$?\d+(?::\$?[A-Za-z]+\$?\d+)?/g;
    while ((m = crossSheetRe.exec(content)) !== null) {
        if (mask[m.index]) continue;
        tokens.push({ kind: m[0].includes(':') ? 'cross-sheet-range' : 'cross-sheet-cell',
                      start: m.index, end: m.index + m[0].length, text: m[0] });
        mask.fill(2, m.index, m.index + m[0].length);
    }

    // Same-sheet ranges (A1:B5)
    const rangeRe = /\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+/g;
    while ((m = rangeRe.exec(content)) !== null) {
        if (mask[m.index]) continue;
        tokens.push({ kind: 'range', start: m.index, end: m.index + m[0].length, text: m[0] });
        mask.fill(2, m.index, m.index + m[0].length);
    }

    // Single-cell refs
    const cellRe = /\$?[A-Za-z]+\$?\d+/g;
    while ((m = cellRe.exec(content)) !== null) {
        if (mask[m.index]) continue;
        tokens.push({ kind: 'cell', start: m.index, end: m.index + m[0].length, text: m[0] });
    }

    // Function names (identifier immediately before '(')
    const funcRe = /[A-Za-z_][A-Za-z0-9_]*(?=\()/g;
    while ((m = funcRe.exec(content)) !== null) {
        if (mask[m.index]) continue;
        tokens.push({ kind: 'function', start: m.index, end: m.index + m[0].length, text: m[0] });
    }

    return tokens.sort((a, b) => a.start - b.start);
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
