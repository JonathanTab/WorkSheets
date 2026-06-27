/**
 * cmFormulaKeymap - Shared Enter/Escape/Tab bindings for formula editors.
 *
 * Single-line mode (multiline: false): Enter always commits.
 * Multi-line mode (multiline: true): plain Enter inserts a newline (default
 * CodeMirror behavior, left unbound here), Mod-Enter (Ctrl/Cmd+Enter) commits.
 */
export function buildFormulaKeymap({ multiline = false, onCommit, onCancel, onTab } = {}) {
    const bindings = [
        { key: 'Escape', run: () => { onCancel?.(); return true; } },
        {
            key: 'Tab',
            run: () => { onTab?.(1); return true; },
            shift: () => { onTab?.(-1); return true; },
        },
    ];

    if (multiline) {
        bindings.push({ key: 'Mod-Enter', run: () => { onCommit?.(); return true; } });
    } else {
        bindings.push({ key: 'Enter', run: () => { onCommit?.(); return true; } });
    }

    return bindings;
}
