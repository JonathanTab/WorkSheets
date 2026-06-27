/**
 * cmFormulaHighlight - CodeMirror 6 ViewPlugin that colors formula references
 * and function names, reusing scanRefTokens/REFERENCE_COLORS from
 * formulaParser.js so colors stay identical to the existing formula bar.
 */

import { ViewPlugin, Decoration } from '@codemirror/view';
import { scanRefTokens, REFERENCE_COLORS } from '../../../formulas/formulaParser.js';

function buildDecorations(doc) {
    const text = doc.toString();
    if (!text.startsWith('=')) return Decoration.none;

    const content = text.slice(1);
    const offset = 1;
    const colorMap = new Map();
    let colorIdx = 0;
    const marks = [];

    for (const tok of scanRefTokens(content)) {
        if (tok.kind === 'function') {
            marks.push(Decoration.mark({ class: 'cm-formula-function' }).range(tok.start + offset, tok.end + offset));
            continue;
        }
        const key = tok.text.toUpperCase();
        if (!colorMap.has(key)) colorMap.set(key, REFERENCE_COLORS[colorIdx++ % REFERENCE_COLORS.length]);
        marks.push(Decoration.mark({
            attributes: { style: `color:${colorMap.get(key)}` },
        }).range(tok.start + offset, tok.end + offset));
    }

    return Decoration.set(marks, true);
}

export const formulaHighlightPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = buildDecorations(view.state.doc);
    }
    update(update) {
        if (update.docChanged) this.decorations = buildDecorations(update.state.doc);
    }
}, { decorations: v => v.decorations });
