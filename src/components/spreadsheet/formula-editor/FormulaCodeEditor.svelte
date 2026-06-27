<script>
    /**
     * FormulaCodeEditor - CodeMirror 6 based formula/text editor.
     *
     * Drop-in replacement for FormulaInput.svelte's prop/callback contract,
     * plus richer editing: token-accurate reference coloring, function-name
     * autocomplete, bracket matching/closing, and optional multi-line mode.
     *
     * Props:
     *   value        — current text (controlled)
     *   readonly     — disables editing
     *   onInput(value, selStart, selEnd)
     *   onSelect(selStart, selEnd)
     *   onKeydown(e)
     *   onBlur(e)
     *   onCommit()        — fired on Enter (single-line) / Mod-Enter (multiline)
     *   onCancel()        — fired on Escape
     *   onTab(dir)         — fired on Tab (dir=1) / Shift-Tab (dir=-1)
     *   multiline    — false (default): fixed height, no wrap, Enter commits.
     *                  true: wraps, grows up to a max height, Enter inserts a
     *                  newline and Mod-Enter commits.
     *   placeholder  — placeholder text
     *   inputClass   — extra CSS class on the root element
     *   dialect      — 'cell' (default, A1 refs, highlights after '=') or 'table'
     *                  (TableColumnPanel: {colName} brace refs, no leading '=')
     *   selStart/selEnd — desired caret position to apply when caretSync bumps
     *   caretSync    — counter; bump to apply selStart/selEnd programmatically
     *                  (e.g. after a formula ref is inserted by clicking the grid)
     *
     * Exports:
     *   focus()          — focus the editor
     *   insertText(text)  — insert text at the current selection (replaces it)
     *   el               — the CodeMirror editable element (view.contentDOM), for
     *                      focus/blur and document.activeElement checks. Must be
     *                      contentDOM, NOT the outer view.dom: view.dom is not
     *                      focusable, so el.focus() on it kicks focus out of the
     *                      editor and fires a spurious blur (→ premature commit).
     *                      Not an <input> — has no selectionStart/setSelectionRange.
     */

    import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
    import { EditorState } from '@codemirror/state';
    import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
    import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
    import { bracketMatching } from '@codemirror/language';

    import { untrack } from 'svelte';

    import { formulaHighlightPlugin } from './cmFormulaHighlight.js';
    import { tableFormulaHighlightPlugin } from './cmTableFormulaHighlight.js';
    import { formulaCompletionSource } from './cmFormulaCompletion.js';
    import { formulaTheme } from './cmFormulaTheme.js';
    import { buildFormulaKeymap } from './cmFormulaKeymap.js';

    let {
        value      = '',
        readonly   = false,
        onInput    = null,
        onSelect   = null,
        onKeydown  = null,
        onBlur     = null,
        onCommit   = null,
        onCancel   = null,
        onTab      = null,
        multiline  = false,
        placeholder = '',
        inputClass = '',
        // 'cell'  — A1 dialect: highlights only when text starts with '=', colors
        //           cell/range refs + function names (cmFormulaHighlight).
        // 'table' — TableColumnPanel dialect: no leading '=', colors {colName}
        //           brace refs + function names (cmTableFormulaHighlight).
        dialect    = 'cell',
        selStart   = null,
        selEnd     = null,
        caretSync  = 0,
    } = $props();

    let containerEl = $state(null);
    /** @type {EditorView | null} */
    let view = null;
    // Mirrors view.dom once the view is created, so hosts can read `el` as a
    // plain property (inputComponent.el.focus()) the same way they did with
    // FormulaInput.svelte's bind:this-backed export — view.dom isn't available
    // until the mount effect runs, so this can't be a bind:this target itself.
    let elState = $state(null);

    // Tracks the doc text the editor itself last emitted via onInput, so the
    // value-reconciliation effect below can tell "external value change" apart
    // from "our own onInput echoed back through the host's state".
    let lastEmittedValue = value;

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function buildExtensions() {
        const readonlyExtensions = readonly
            ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
            : [];

        return [
            history(),
            dialect === 'table' ? tableFormulaHighlightPlugin : formulaHighlightPlugin,
            bracketMatching(),
            closeBrackets(),
            autocompletion({ override: [formulaCompletionSource], activateOnTyping: true }),
            placeholderExt(placeholder),
            formulaTheme(multiline),
            multiline ? EditorView.lineWrapping : [],
            keymap.of([
                ...buildFormulaKeymap({
                    multiline,
                    onCommit: () => onCommit?.(),
                    onCancel: () => onCancel?.(),
                    onTab: (dir) => onTab?.(dir),
                }),
                ...closeBracketsKeymap,
                ...historyKeymap,
                ...defaultKeymap,
            ]),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    const text = update.state.doc.toString();
                    lastEmittedValue = text;
                    const sel = update.state.selection.main;
                    onInput?.(text, sel.from, sel.to);
                } else if (update.selectionSet) {
                    const sel = update.state.selection.main;
                    onSelect?.(sel.from, sel.to);
                }
            }),
            EditorView.domEventHandlers({
                keydown: (e) => { onKeydown?.(e); return false; },
                blur: (e) => { onBlur?.(e); return false; },
            }),
            ...readonlyExtensions,
        ];
    }

    // Create the EditorView exactly once, keyed only on containerEl. The body
    // reads `value` and the prop-derived extensions, but those must NOT become
    // effect dependencies: `value` changes on every keystroke, so tracking it
    // would destroy+recreate the view per character — which blurs the focused
    // .cm-content and fires a spurious commit. Doc/extension changes are instead
    // handled incrementally by the reconcile effects below. So read containerEl
    // as the sole dependency, then build the view inside untrack().
    $effect(() => {
        const parent = containerEl;
        if (!parent) return;
        untrack(() => {
            view = new EditorView({
                state: EditorState.create({ doc: value, extensions: buildExtensions() }),
                parent,
            });
            elState = view.contentDOM;
            lastEmittedValue = value;
        });
        return () => { view?.destroy(); view = null; elState = null; };
    });

    // Re-create the editor when readonly/multiline/placeholder change — these
    // affect the extension set, not just the doc, so a plain reconfigure call
    // would need to track each piece; a remount is simpler and infrequent.
    let _skipFirstReconfigure = true;
    $effect(() => {
        void readonly; void multiline; void placeholder; void dialect;
        if (_skipFirstReconfigure) { _skipFirstReconfigure = false; return; }
        if (!view) return;
        const doc = view.state.doc.toString();
        const sel = view.state.selection.main;
        view.destroy();
        view = new EditorView({
            state: EditorState.create({
                doc,
                selection: { anchor: clamp(sel.anchor, 0, doc.length), head: clamp(sel.head, 0, doc.length) },
                extensions: buildExtensions(),
            }),
            parent: containerEl,
        });
        elState = view.contentDOM;
    });

    // Reconcile caretSync bumps (e.g. grid-click ref insertion) — sets doc text
    // (if changed) and selection in one atomic transaction.
    let _lastCaretSync = caretSync;
    $effect(() => {
        const sync = caretSync;
        if (sync === _lastCaretSync) return;
        _lastCaretSync = sync;
        if (!view) return;
        const docText = view.state.doc.toString();
        const s = clamp(selStart ?? 0, 0, docText.length);
        const e = clamp(selEnd ?? s, 0, docText.length);
        const changes = (value !== docText) ? { from: 0, to: docText.length, insert: value } : undefined;
        lastEmittedValue = value;
        view.dispatch({
            ...(changes ? { changes } : {}),
            selection: { anchor: s, head: e },
            scrollIntoView: true,
        });
        view.focus();
    });

    // Reconcile external value changes not accompanied by a caretSync bump
    // (e.g. switching cells). Guarded against echoing our own onInput.
    $effect(() => {
        const next = value;
        if (!view || next === lastEmittedValue) return;
        const docText = view.state.doc.toString();
        if (next === docText) { lastEmittedValue = next; return; }
        lastEmittedValue = next;
        view.dispatch({ changes: { from: 0, to: docText.length, insert: next } });
    });

    // ── Public API ────────────────────────────────────────────────────────────

    export function focus() {
        setTimeout(() => view?.focus(), 0);
    }

    export function insertText(text) {
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
            scrollIntoView: true,
        });
        view.focus();
    }

    export { elState as el };
</script>

<div class="formula-code-editor {inputClass}" class:is-multiline={multiline} bind:this={containerEl}></div>

<style>
    .formula-code-editor {
        width: 100%;
        height: 100%;
        overflow: hidden;
    }

    .formula-code-editor.is-multiline {
        height: auto;
    }
</style>
