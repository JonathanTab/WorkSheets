/**
 * ProseMirror find/replace plugin.
 * Decorates all matches with .find-match, and the active match with .find-match-active.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const findPluginKey = new PluginKey('find');

const EMPTY_STATE = {
    query: '',
    matchCase: false,
    matches: [],
    activeIndex: -1,
    decorations: DecorationSet.empty,
};

export function buildFindPlugin() {
    return new Plugin({
        key: findPluginKey,

        state: {
            init() { return EMPTY_STATE; },

            apply(tr, prev, _old, newState) {
                const meta = tr.getMeta(findPluginKey);
                if (!meta && !tr.docChanged) return prev;

                let { query, matchCase, activeIndex } = prev;

                if (meta) {
                    if (meta.query !== undefined) query = meta.query;
                    if (meta.matchCase !== undefined) matchCase = meta.matchCase;
                    if (meta.activeIndex !== undefined) activeIndex = meta.activeIndex;
                }

                if (!query) return EMPTY_STATE;

                // Collect all matches
                const matches = [];
                const needle = matchCase ? query : query.toLowerCase();
                newState.doc.descendants((node, pos) => {
                    if (!node.isText) return;
                    const hay = matchCase ? node.text : node.text.toLowerCase();
                    let i = 0;
                    while (true) {
                        const found = hay.indexOf(needle, i);
                        if (found < 0) break;
                        matches.push({ from: pos + found, to: pos + found + query.length });
                        i = found + 1;
                    }
                });

                const clamped = matches.length === 0 ? -1
                    : Math.max(0, Math.min(activeIndex, matches.length - 1));

                const decorations = DecorationSet.create(newState.doc, matches.map((m, i) =>
                    Decoration.inline(m.from, m.to, {
                        class: i === clamped ? 'find-match find-match-active' : 'find-match',
                    })
                ));

                return { query, matchCase, matches, activeIndex: clamped, decorations };
            },
        },

        props: {
            decorations(state) { return this.getState(state).decorations; },
        },
    });
}

// ── Commands ──────────────────────────────────────────────────────────────────

export function setFind(query, matchCase = false) {
    return (state, dispatch) => {
        if (dispatch) dispatch(state.tr.setMeta(findPluginKey, { query, matchCase, activeIndex: 0 }));
        return true;
    };
}

export function clearFind(state, dispatch) {
    if (dispatch) dispatch(state.tr.setMeta(findPluginKey, { query: '', activeIndex: -1 }));
    return true;
}

export function findNext(state, dispatch) {
    const ps = findPluginKey.getState(state);
    if (!ps?.matches.length) return false;
    const next = (ps.activeIndex + 1) % ps.matches.length;
    if (dispatch) dispatch(state.tr.setMeta(findPluginKey, { activeIndex: next }));
    return true;
}

export function findPrev(state, dispatch) {
    const ps = findPluginKey.getState(state);
    if (!ps?.matches.length) return false;
    const prev = (ps.activeIndex - 1 + ps.matches.length) % ps.matches.length;
    if (dispatch) dispatch(state.tr.setMeta(findPluginKey, { activeIndex: prev }));
    return true;
}

export function replaceActive(replaceText) {
    return (state, dispatch) => {
        const ps = findPluginKey.getState(state);
        if (!ps?.matches.length || ps.activeIndex < 0) return false;
        const m = ps.matches[ps.activeIndex];
        if (dispatch) {
            const tr = state.tr.insertText(replaceText, m.from, m.to);
            tr.setMeta(findPluginKey, { query: ps.query, matchCase: ps.matchCase, activeIndex: ps.activeIndex });
            dispatch(tr);
        }
        return true;
    };
}

export function replaceAll(replaceText) {
    return (state, dispatch) => {
        const ps = findPluginKey.getState(state);
        if (!ps?.matches.length) return false;
        if (dispatch) {
            let tr = state.tr;
            // Reverse order to preserve offsets
            for (let i = ps.matches.length - 1; i >= 0; i--) {
                const m = ps.matches[i];
                tr = tr.insertText(replaceText, m.from, m.to);
            }
            tr.setMeta(findPluginKey, { query: ps.query, matchCase: ps.matchCase, activeIndex: -1 });
            dispatch(tr);
        }
        return true;
    };
}

/** Get current find state from an EditorState (or null). */
export function getFindState(editorState) {
    return findPluginKey.getState(editorState) ?? null;
}
