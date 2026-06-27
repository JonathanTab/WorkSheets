/**
 * cmTableFormulaHighlight - CodeMirror 6 ViewPlugin for the TABLE column-formula
 * dialect (TableColumnPanel default formulas).
 *
 * This dialect differs from the A1 cell-formula dialect handled by
 * cmFormulaHighlight.js:
 *   - No leading '=' — the whole doc is the expression.
 *   - References are column names wrapped in braces: {amount}, {status}.
 *   - Helper functions like PREV(), WINDOW(), IF() are plain identifiers.
 *
 * So we can't reuse scanRefTokens (A1 tokenizer); we scan with two simple
 * regexes: {…} brace refs (colored per unique column name) and identifier(
 * function heads.
 */

import { ViewPlugin, Decoration } from '@codemirror/view';
import { REFERENCE_COLORS } from '../../../formulas/formulaParser.js';

const BRACE_REF = /\{[^}]*\}/g;
const FUNCTION_HEAD = /\b[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/g;

function buildDecorations(doc) {
    const text = doc.toString();
    if (!text) return Decoration.none;

    const colorMap = new Map();
    let colorIdx = 0;
    const marks = [];

    let m;
    BRACE_REF.lastIndex = 0;
    while ((m = BRACE_REF.exec(text)) !== null) {
        const key = m[0].toUpperCase();
        if (!colorMap.has(key)) colorMap.set(key, REFERENCE_COLORS[colorIdx++ % REFERENCE_COLORS.length]);
        marks.push(Decoration.mark({
            attributes: { style: `color:${colorMap.get(key)}` },
        }).range(m.index, m.index + m[0].length));
    }

    FUNCTION_HEAD.lastIndex = 0;
    while ((m = FUNCTION_HEAD.exec(text)) !== null) {
        marks.push(Decoration.mark({ class: 'cm-formula-function' }).range(m.index, m.index + m[0].length));
    }

    // Decoration.set requires marks sorted by from (then startSide); brace and
    // function passes interleave, so sort before building the set.
    marks.sort((a, b) => a.from - b.from || a.startSide - b.startSide);
    return Decoration.set(marks, true);
}

export const tableFormulaHighlightPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = buildDecorations(view.state.doc);
    }
    update(update) {
        if (update.docChanged) this.decorations = buildDecorations(update.state.doc);
    }
}, { decorations: v => v.decorations });
