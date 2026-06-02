/**
 * refRewriter.js — Rename-aware formula rewriting.
 *
 * Two entry points:
 *   rewriteSheetRefsInFormula(formula, oldName, newName)
 *     - rewrites any =SheetName!A1 / 'SheetName'!A1:B2 references
 *   rewriteTableRefsInFormula(formula, oldName, newName)
 *     - rewrites any TABLE_*('SheetName', ...) literal first arguments
 *
 * Both work on the AST (via parser.js) then re-emit via serialize.js, so
 * quoting / escaping / precedence is regenerated correctly.
 *
 * For column DSL formulas (defaultFormula / formula on a column, which contain
 * `{colName}` markers that the AST parser can't handle), use the *DslColumn
 * variants which do a literal-protected regex pass.
 */

import { NodeType, parseFormula } from './parser.js';
import { serializeFormula } from './serialize.js';

/**
 * Walk an AST and mutate any SheetRef node whose `sheet` matches `oldName`.
 * Mutation is in place; caller must `serializeFormula` to get the new string.
 * @param {object} node
 * @param {string} oldName
 * @param {string} newName
 * @returns {boolean} true if any node was rewritten
 */
function walkAndRewriteSheet(node, oldName, newName) {
    if (!node) return false;
    let changed = false;
    if (node.type === NodeType.SHEET_REF && node.sheet === oldName) {
        node.sheet = newName;
        changed = true;
    }
    if (node.left)    changed = walkAndRewriteSheet(node.left, oldName, newName) || changed;
    if (node.right)   changed = walkAndRewriteSheet(node.right, oldName, newName) || changed;
    if (node.operand) changed = walkAndRewriteSheet(node.operand, oldName, newName) || changed;
    if (node.args)    for (const a of node.args) changed = walkAndRewriteSheet(a, oldName, newName) || changed;
    if (node.ref)     changed = walkAndRewriteSheet(node.ref, oldName, newName) || changed;
    return changed;
}

/**
 * Walk an AST and mutate any TABLE_*(name, ...) call where `args[0]` is a
 * string literal matching `oldName` (case-insensitive).
 * @param {object} node
 * @param {string} oldUpper - oldName.toUpperCase()
 * @param {string} newName
 * @returns {boolean}
 */
function walkAndRewriteTable(node, oldUpper, newName) {
    if (!node) return false;
    let changed = false;
    if (node.type === NodeType.FUNCTION_CALL && typeof node.name === 'string' && node.name.startsWith('TABLE_')) {
        const first = node.args?.[0];
        if (first?.type === NodeType.STRING && String(first.value).toUpperCase() === oldUpper) {
            first.value = newName;
            changed = true;
        }
    }
    if (node.left)    changed = walkAndRewriteTable(node.left, oldUpper, newName) || changed;
    if (node.right)   changed = walkAndRewriteTable(node.right, oldUpper, newName) || changed;
    if (node.operand) changed = walkAndRewriteTable(node.operand, oldUpper, newName) || changed;
    if (node.args)    for (const a of node.args) changed = walkAndRewriteTable(a, oldUpper, newName) || changed;
    if (node.ref)     changed = walkAndRewriteTable(node.ref, oldUpper, newName) || changed;
    return changed;
}

/**
 * Rewrite all =SheetName!… references in a formula string.
 * Returns the new formula, or the original string when no rewrite was needed
 * (so callers can cheaply skip Yjs writes).
 * @param {string} formula
 * @param {string} oldName
 * @param {string} newName
 * @returns {string}
 */
export function rewriteSheetRefsInFormula(formula, oldName, newName) {
    if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
    if (!formula.includes(oldName)) return formula;
    let ast;
    try { ast = parseFormula(formula); } catch { return formula; }
    if (!ast) return formula;
    const changed = walkAndRewriteSheet(ast, oldName, newName);
    return changed ? serializeFormula(ast) : formula;
}

/**
 * Rewrite all TABLE_*("name", …) literal references in a formula string.
 * @param {string} formula
 * @param {string} oldName
 * @param {string} newName
 * @returns {string}
 */
export function rewriteTableRefsInFormula(formula, oldName, newName) {
    if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
    if (!formula.toUpperCase().includes(oldName.toUpperCase())) return formula;
    let ast;
    try { ast = parseFormula(formula); } catch { return formula; }
    if (!ast) return formula;
    const changed = walkAndRewriteTable(ast, oldName.toUpperCase(), newName);
    return changed ? serializeFormula(ast) : formula;
}

// ── DSL (column formula) variants — literal-protected regex ──────────────────

const _STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/** Run fn with all quoted literals replaced with NUL placeholders; restores on return. */
function withLiteralProtection(str, fn) {
    const lits = [];
    const stripped = String(str).replace(_STRING_LITERAL_RE, (m) => {
        lits.push(m);
        return `\x00${lits.length - 1}\x00`;
    });
    const result = fn(stripped);
    if (!lits.length) return result;
    return result.replace(/\x00(\d+)\x00/g, (_p, i) => lits[+i]);
}

/**
 * Rewrite TABLE_*("name", …) literals in a *column DSL formula* (the kind
 * stored on column.defaultFormula / column.formula that contains `{colName}`
 * markers). We can't parseFormula it because of the braces, so this uses a
 * literal-protected regex pass instead.
 *
 * @param {string} formula
 * @param {string} oldName
 * @param {string} newName
 * @returns {string}
 */
export function rewriteTableRefsInDslColumn(formula, oldName, newName) {
    if (typeof formula !== 'string' || !formula) return formula;
    const oldUpper = oldName.toUpperCase();
    if (!formula.toUpperCase().includes(oldUpper)) return formula;
    return withLiteralProtection(formula, (s) => {
        // Match TABLE_<FUNC>(<whitespace><quoted "name" OR 'name'>)
        return s.replace(/(\bTABLE_[A-Z_]+\s*\(\s*)(["'])([^"']+)\2/gi, (full, prefix, q, name) => {
            if (name.toUpperCase() === oldUpper) {
                return `${prefix}${q}${newName}${q}`;
            }
            return full;
        });
    });
}

/**
 * Rewrite =SheetName!… references in a column DSL formula. Same constraints
 * as the table variant above.
 */
export function rewriteSheetRefsInDslColumn(formula, oldName, newName) {
    if (typeof formula !== 'string' || !formula) return formula;
    if (!formula.includes(oldName)) return formula;
    return withLiteralProtection(formula, (s) => {
        // Match bare `OldName!` or quoted `'OldName'!`.
        // Bare form must follow a word boundary or beginning-of-string.
        const bare = new RegExp(
            `(^|[^A-Za-z0-9_'])${escapeRegex(oldName)}!`,
            'g'
        );
        let out = s.replace(bare, (_m, lead) => `${lead}${quoteSheetIfNeeded(newName)}!`);
        const quoted = new RegExp(`'${escapeRegex(oldName)}'!`, 'g');
        out = out.replace(quoted, () => `${quoteSheetIfNeeded(newName)}!`);
        return out;
    });
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteSheetIfNeeded(name) {
    if (/^[A-Za-z0-9_]+$/.test(name)) return name;
    return `'${String(name).replace(/'/g, "''")}'`;
}
