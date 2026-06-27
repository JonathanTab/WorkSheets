/**
 * cmFormulaTheme - EditorView theming for the formula editor.
 *
 * Mirrors the CSS custom properties the existing formula bar wrappers set
 * (FormulaBar.svelte .input-wrap, MobileInputBar.svelte .entry-input-wrap)
 * so dark-mode/theme-swapping keeps working without host changes.
 */

import { EditorView } from '@codemirror/view';

const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const baseTheme = EditorView.theme({
    '&': {
        height: '100%',
        color: 'var(--text-color, #1e293b)',
        backgroundColor: 'transparent',
        fontFamily: FONT_STACK,
        // Inherit from the host wrapper rather than hardcoding a size — some
        // hosts (e.g. MobileInputBar's .entry-input-wrap) set font-size: 16px
        // specifically to prevent iOS Safari's auto-zoom-on-focus behavior.
        fontSize: 'inherit',
    },
    '&.cm-editor.cm-focused': {
        outline: 'none',
    },
    '.cm-content': {
        padding: '0',
        caretColor: 'var(--text-color, #1e293b)',
        fontFamily: 'inherit',
    },
    '.cm-line': {
        padding: '0',
    },
    '.cm-scroller': {
        fontFamily: 'inherit',
        lineHeight: 'inherit',
    },
    '.cm-placeholder': {
        color: 'var(--color-text-secondary, #94a3b8)',
        fontStyle: 'normal',
    },
    '.cm-formula-function': {
        color: 'var(--function-color, #7c3aed)',
    },
    '.cm-tooltip-autocomplete': {
        fontFamily: FONT_STACK,
        fontSize: '0.8125rem',
    },
});

const singleLineTheme = EditorView.theme({
    '&': { height: '100%' },
    '.cm-scroller': {
        overflowX: 'auto',
        overflowY: 'hidden',
        whiteSpace: 'pre',
        // Hide the horizontal scrollbar. In a one-line, cell-height editor a
        // ~15px scrollbar would eat most of the editing area and cover the text
        // (the old <input>-based FormulaInput hid it the same way). The content
        // still scrolls horizontally; only the scrollbar chrome is suppressed.
        scrollbarWidth: 'none',
    },
    '.cm-scroller::-webkit-scrollbar': {
        display: 'none',
    },
    '.cm-content': {
        whiteSpace: 'pre',
    },
});

const multiLineTheme = EditorView.theme({
    '&': { height: 'auto' },
    '.cm-scroller': {
        overflowX: 'hidden',
        overflowY: 'auto',
        maxHeight: '220px',
    },
});

export function formulaTheme(multiline) {
    return [baseTheme, multiline ? multiLineTheme : singleLineTheme];
}
