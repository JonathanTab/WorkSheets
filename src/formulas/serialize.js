/**
 * serialize.js — AST → formula string emitter.
 *
 * Produces a formula string from an AST built by parser.js. Used by the
 * rename-rewriter to round-trip formulas after rewriting SheetRef / TABLE_*
 * literals. Output is `parseFormula`-able; whitespace from the original is
 * lost (it carries no semantic meaning).
 *
 * Sheet names that contain anything other than [A-Za-z0-9_] are wrapped in
 * single quotes, with embedded single quotes doubled — matching the parser's
 * quoted-sheet-name reader.
 *
 * Operator precedence is preserved with parentheses where needed.
 */

import { NodeType } from './parser.js';
import { toCellRef } from './refCoords.js';

const _NEEDS_QUOTE = /[^A-Za-z0-9_]/;

/** Quote a sheet name if it contains anything besides word chars. */
function quoteSheetName(name) {
    if (!_NEEDS_QUOTE.test(name)) return name;
    return `'${String(name).replace(/'/g, "''")}'`;
}

/** Build the textual form of a CellRef node honouring $-prefixes. */
function cellRefToString(node) {
    const base = toCellRef(node.row, node.col);
    // toCellRef returns "A1" — split letters/digits to insert $ marks.
    const m = base.match(/^([A-Z]+)(\d+)$/);
    if (!m) return base;
    const colStr = (node.colAbsolute ? '$' : '') + m[1];
    const rowStr = (node.rowAbsolute ? '$' : '') + m[2];
    return colStr + rowStr;
}

// Operator precedence: higher number binds tighter.
const PREC = {
    ',': 0,
    '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, 'contains': 1,
    '&': 2,
    '+': 3, '-': 3,
    '*': 4, '/': 4,
    '^': 5,
    'unary': 6,
    'postfix': 7,
    'primary': 8,
};

/** Recursively emit `node` as a string. `parentPrec` controls parenthesisation. */
function emit(node, parentPrec = 0) {
    if (!node) return '';

    switch (node.type) {
        case NodeType.NUMBER: {
            // Negative numbers handled via UNARY_OP; this is a positive literal.
            return String(node.value);
        }
        case NodeType.STRING: {
            const escaped = String(node.value).replace(/"/g, '""');
            return `"${escaped}"`;
        }
        case NodeType.CELL_REF:
            return cellRefToString(node);
        case NodeType.RANGE:
            return `${cellRefToString(node.start)}:${cellRefToString(node.end)}`;
        case NodeType.SHEET_REF:
            return `${quoteSheetName(node.sheet)}!${emit(node.ref, PREC.primary)}`;
        case NodeType.REP_VAR:
            return '$rep';
        case NodeType.ERROR_LITERAL:
            return node.value;
        case NodeType.BINARY_OP: {
            const opPrec = PREC[node.op] ?? 1;
            const left  = emit(node.left,  opPrec);
            const right = emit(node.right, opPrec + 1); // right-associativity for safety
            const inner = `${left}${node.op === 'contains' ? ' contains ' : node.op}${right}`;
            return opPrec < parentPrec ? `(${inner})` : inner;
        }
        case NodeType.UNARY_OP: {
            if (node.op === '%') {
                const operand = emit(node.operand, PREC.postfix);
                const inner = `${operand}%`;
                return PREC.postfix < parentPrec ? `(${inner})` : inner;
            }
            const operand = emit(node.operand, PREC.unary);
            const inner = `${node.op}${operand}`;
            return PREC.unary < parentPrec ? `(${inner})` : inner;
        }
        case NodeType.FUNCTION_CALL: {
            const args = (node.args ?? []).map((a) => a?.type === 'Missing' ? '' : emit(a, 0));
            return `${node.name}(${args.join(',')})`;
        }
        case 'Missing':
            return '';
        default:
            return '';
    }
}

/**
 * Serialize an AST back to a formula string, with a leading `=`.
 * @param {object|null} ast
 * @returns {string}
 */
export function serializeFormula(ast) {
    if (!ast) return '';
    return '=' + emit(ast, 0);
}
