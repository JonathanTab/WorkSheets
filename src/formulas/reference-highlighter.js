/**
 * Reference Highlighter
 *
 * Utilities for parsing formulas and creating colored reference segments
 * for display in the formula bar.
 */

// Color palette for cell references (must match FormulaEditState)
const REFERENCE_COLORS = [
    '#3b82f6', // blue
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

/**
 * Token types for formula segmentation
 */
const TokenType = {
    TEXT: 'TEXT',
    CELL_REF: 'CELL_REF',
    RANGE: 'RANGE',
    FUNCTION: 'FUNCTION',
    NUMBER: 'NUMBER',
    STRING: 'STRING',
    OPERATOR: 'OPERATOR',
    WHITESPACE: 'WHITESPACE'
};

/**
 * Segment a formula string into colored parts
 * @param {string} formula - The formula string (with or without leading =)
 * @returns {Array<{text: string, type: string, color: string | null}>}
 */
export function segmentFormula(formula) {
    if (!formula) return [];

    const segments = [];
    const colorMap = new Map();
    let colorIndex = 0;

    // Remove leading = for processing but add it as first segment
    const hasLeadingEquals = formula.startsWith('=');
    const content = hasLeadingEquals ? formula.slice(1) : formula;

    // Add the = as the first segment if present
    if (hasLeadingEquals) {
        segments.push({
            text: '=',
            type: 'OPERATOR',
            color: null
        });
    }

    let pos = 0;

    // Regex patterns
    const rangePattern = /\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+/g;
    const cellPattern = /\$?[A-Za-z]+\$?\d+/g;
    const functionPattern = /[A-Za-z_][A-Za-z0-9_]*(?=\()/g;
    const numberPattern = /\d+\.?\d*/g;
    const stringPattern = /"[^"]*"|'[^']*'/g;
    const operatorPattern = /[+\-*/^%=<>(),:]/g;

    // Find all ranges first (they contain cell refs that we don't want to double-match)
    const ranges = [];
    let match;
    while ((match = rangePattern.exec(content)) !== null) {
        ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }

    // Find all individual cell refs that are NOT part of ranges
    const cells = [];
    while ((match = cellPattern.exec(content)) !== null) {
        const isInRange = ranges.some(r => match.index >= r.start && match.index < r.end);
        if (!isInRange) {
            cells.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
        }
    }

    // Find functions
    const functions = [];
    while ((match = functionPattern.exec(content)) !== null) {
        functions.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }

    // Build a combined list of special tokens with their positions
    const tokens = [];

    for (const r of ranges) {
        tokens.push({ ...r, type: TokenType.RANGE });
    }
    for (const c of cells) {
        tokens.push({ ...c, type: TokenType.CELL_REF });
    }
    for (const f of functions) {
        tokens.push({ ...f, type: TokenType.FUNCTION });
    }

    // Sort by start position
    tokens.sort((a, b) => a.start - b.start);

    // Build segments
    let lastEnd = 0;

    for (const token of tokens) {
        // Add any text before this token
        if (token.start > lastEnd) {
            const betweenText = content.slice(lastEnd, token.start);
            // Split into whitespace and other text
            const parts = splitTextAndWhitespace(betweenText);
            for (const part of parts) {
                segments.push(part);
            }
        }

        // Add the token with color
        if (token.type === TokenType.RANGE || token.type === TokenType.CELL_REF) {
            const refKey = token.text.toUpperCase();
            if (!colorMap.has(refKey)) {
                colorMap.set(refKey, REFERENCE_COLORS[colorIndex % REFERENCE_COLORS.length]);
                colorIndex++;
            }
            segments.push({
                text: token.text,
                type: token.type,
                color: colorMap.get(refKey)
            });
        } else if (token.type === TokenType.FUNCTION) {
            segments.push({
                text: token.text,
                type: TokenType.FUNCTION,
                color: null
            });
        }

        lastEnd = token.end;
    }

    // Add any remaining text
    if (lastEnd < content.length) {
        const remainingText = content.slice(lastEnd);
        const parts = splitTextAndWhitespace(remainingText);
        for (const part of parts) {
            segments.push(part);
        }
    }

    return segments;
}

/**
 * Split text into whitespace and non-whitespace parts
 * @param {string} text
 * @returns {Array<{text: string, type: string, color: null}>}
 */
function splitTextAndWhitespace(text) {
    const parts = [];
    let current = '';
    let isWhitespace = /^\s/.test(text[0] || '');

    for (const char of text) {
        const charIsWhitespace = /\s/.test(char);
        if (charIsWhitespace !== isWhitespace) {
            if (current) {
                parts.push({
                    text: current,
                    type: isWhitespace ? TokenType.WHITESPACE : TokenType.TEXT,
                    color: null
                });
            }
            current = char;
            isWhitespace = charIsWhitespace;
        } else {
            current += char;
        }
    }

    if (current) {
        parts.push({
            text: current,
            type: isWhitespace ? TokenType.WHITESPACE : TokenType.TEXT,
            color: null
        });
    }

    return parts;
}

/**
 * Get a color for a reference by index
 * @param {number} index
 * @returns {string}
 */
export function getReferenceColor(index) {
    return REFERENCE_COLORS[index % REFERENCE_COLORS.length];
}

/**
 * Check if a string is a valid cell reference
 * @param {string} str
 * @returns {boolean}
 */
export function isCellReference(str) {
    return /^\$?[A-Za-z]+\$?\d+$/.test(str);
}

/**
 * Check if a string is a valid range reference
 * @param {string} str
 * @returns {boolean}
 */
export function isRangeReference(str) {
    return /^\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+$/.test(str);
}

export default {
    segmentFormula,
    getReferenceColor,
    isCellReference,
    isRangeReference,
    REFERENCE_COLORS,
    TokenType
};
