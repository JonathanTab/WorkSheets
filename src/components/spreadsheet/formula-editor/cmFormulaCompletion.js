/**
 * cmFormulaCompletion - CodeMirror 6 autocomplete source for formula function
 * names. Reads the live `functions` registry at completion-time so runtime
 * registered TABLE_* functions (via registerFunction) are picked up for free.
 */

import { functions } from '../../../formulas/functions/index.js';

export function formulaCompletionSource(context) {
    const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_.]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    const prefix = word.text.toUpperCase();
    const options = Object.entries(functions)
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, fn]) => ({
            label: name,
            type: 'function',
            detail: fn.syntax,
            info: () => {
                const div = document.createElement('div');
                div.textContent = fn.desc ?? '';
                return div;
            },
            apply: name + '(',
        }));

    if (!options.length) return null;
    return { from: word.from, options, validFor: /^[A-Za-z_][A-Za-z0-9_.]*$/ };
}
