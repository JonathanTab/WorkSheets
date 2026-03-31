/**
 * ProseMirror commands for the word processor toolbar.
 */

import { toggleMark, setBlockType, wrapIn, lift, joinUp } from 'prosemirror-commands';
import { wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { docSchema as schema } from './docSchema.js';

// ── Mark toggles ──────────────────────────────────────────────────────────────

export const toggleBold        = toggleMark(schema.marks.strong);
export const toggleItalic      = toggleMark(schema.marks.em);
export const toggleCode        = toggleMark(schema.marks.code);
export const toggleUnderline   = toggleMark(schema.marks.underline);
export const toggleStrikethrough = toggleMark(schema.marks.strikethrough);

// ── Block type setters ────────────────────────────────────────────────────────

export function setHeading(level) {
    return setBlockType(schema.nodes.heading, { level });
}
export const setParagraph = setBlockType(schema.nodes.paragraph);
export const setCodeBlock = setBlockType(schema.nodes.code_block);

// ── Block alignment ───────────────────────────────────────────────────────────

export function setAlign(align) {
    return (state, dispatch) => {
        const { selection, tr } = state;
        const { from, to } = selection;
        let changed = false;

        state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type === schema.nodes.paragraph || node.type === schema.nodes.heading) {
                const newAlign = node.attrs.align === align ? null : align;
                tr.setNodeMarkup(pos, null, { ...node.attrs, align: newAlign });
                changed = true;
            }
        });

        if (changed && dispatch) dispatch(tr);
        return changed;
    };
}

// ── List commands ─────────────────────────────────────────────────────────────

export const toggleBulletList = (state, dispatch, view) => {
    // If already in bullet list, lift it; otherwise wrap
    if (isInList(state, schema.nodes.bullet_list)) {
        return lift(state, dispatch);
    }
    return wrapInList(schema.nodes.bullet_list)(state, dispatch);
};

export const toggleOrderedList = (state, dispatch, view) => {
    if (isInList(state, schema.nodes.ordered_list)) {
        return lift(state, dispatch);
    }
    return wrapInList(schema.nodes.ordered_list)(state, dispatch);
};

export const indentList  = sinkListItem(schema.nodes.list_item);
export const outdentList = liftListItem(schema.nodes.list_item);
export const splitList   = splitListItem(schema.nodes.list_item);

// ── Wrappers ──────────────────────────────────────────────────────────────────

export const toggleBlockquote = (state, dispatch) => {
    if (isWrappedIn(state, schema.nodes.blockquote)) {
        return lift(state, dispatch);
    }
    return wrapIn(schema.nodes.blockquote)(state, dispatch);
};

// ── Inline attributes ─────────────────────────────────────────────────────────

export function setTextColor(color) {
    return setMarkAttr(schema.marks.textColor, { color });
}

export function setBgColor(color) {
    return setMarkAttr(schema.marks.bgColor, { color });
}

export function setFontSize(size) {
    return setMarkAttr(schema.marks.fontSize, { size });
}

export function setFontFamily(family) {
    return setMarkAttr(schema.marks.fontFamily, { family });
}

// ── Link ──────────────────────────────────────────────────────────────────────

export function setLink(href) {
    return (state, dispatch) => {
        const { selection } = state;
        if (selection.empty) return false;
        if (dispatch) {
            const tr = state.tr;
            if (href) {
                tr.addMark(selection.from, selection.to, schema.marks.link.create({ href, title: '' }));
            } else {
                tr.removeMark(selection.from, selection.to, schema.marks.link);
            }
            dispatch(tr);
        }
        return true;
    };
}

// ── Horizontal rule ───────────────────────────────────────────────────────────

export function insertHR(state, dispatch) {
    const { tr, selection } = state;
    if (dispatch) {
        tr.replaceSelectionWith(schema.nodes.horizontal_rule.create());
        dispatch(tr);
    }
    return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isInList(state, listType) {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === listType) return true;
    }
    return false;
}

function isWrappedIn(state, nodeType) {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === nodeType) return true;
    }
    return false;
}

/**
 * Apply a mark with attrs to the selection, removing any existing instance first.
 */
function setMarkAttr(markType, attrs) {
    return (state, dispatch) => {
        const { selection, tr } = state;
        if (selection.empty) return false;
        const { from, to } = selection;

        if (dispatch) {
            // Remove existing mark of this type first, then add new one
            tr.removeMark(from, to, markType);
            if (Object.values(attrs).some(v => v != null)) {
                tr.addMark(from, to, markType.create(attrs));
            }
            dispatch(tr);
        }
        return true;
    };
}

// ── State inspection ──────────────────────────────────────────────────────────

export function getMarkState(editorState) {
    if (!editorState) return {};
    const { selection, storedMarks, doc } = editorState;
    const { empty, from, to, $from } = selection;

    const marks = empty
        ? (storedMarks ?? $from.marks())
        : doc.rangeHasMark(from, to, schema.marks.strong)
            ? [] // collect below
            : $from.marks();

    const activeMarks = new Set(
        (storedMarks ?? $from.marks()).map(m => m.type.name)
    );

    const blockType = $from.parent.type;
    const blockAttrs = $from.parent.attrs;

    // Collect mark attrs from selection
    let textColor = null, bgColor = null, fontSize = null, fontFamily = null;

    doc.nodesBetween(from, to, node => {
        if (!node.isText) return;
        for (const m of node.marks) {
            if (m.type === schema.marks.textColor)  textColor  = m.attrs.color;
            if (m.type === schema.marks.bgColor)    bgColor    = m.attrs.color;
            if (m.type === schema.marks.fontSize)   fontSize   = m.attrs.size;
            if (m.type === schema.marks.fontFamily) fontFamily = m.attrs.family;
        }
    });

    // Stored marks override
    for (const m of (storedMarks ?? [])) {
        if (m.type === schema.marks.textColor)  textColor  = m.attrs.color;
        if (m.type === schema.marks.bgColor)    bgColor    = m.attrs.color;
        if (m.type === schema.marks.fontSize)   fontSize   = m.attrs.size;
        if (m.type === schema.marks.fontFamily) fontFamily = m.attrs.family;
    }

    return {
        bold:          isMarkActive(editorState, schema.marks.strong),
        italic:        isMarkActive(editorState, schema.marks.em),
        underline:     isMarkActive(editorState, schema.marks.underline),
        strikethrough: isMarkActive(editorState, schema.marks.strikethrough),
        code:          isMarkActive(editorState, schema.marks.code),
        blockType:     blockType.name,
        headingLevel:  blockType === schema.nodes.heading ? blockAttrs.level : null,
        align:         blockAttrs.align ?? 'left',
        textColor,
        bgColor,
        fontSize,
        fontFamily,
        inBulletList:  isInList(editorState, schema.nodes.bullet_list),
        inOrderedList: isInList(editorState, schema.nodes.ordered_list),
        inBlockquote:  isWrappedIn(editorState, schema.nodes.blockquote),
    };
}

function isMarkActive(state, markType) {
    const { selection, storedMarks, doc } = state;
    const { empty, from, to, $from } = selection;
    if (empty) {
        return markType.isInSet(storedMarks ?? $from.marks()) != null;
    }
    return doc.rangeHasMark(from, to, markType);
}

// ── Input rules ───────────────────────────────────────────────────────────────
// (optional: smart quotes, dash, etc.)

import { inputRules, InputRule } from 'prosemirror-inputrules';

function headingRule(level) {
    const hashes = '#'.repeat(level);
    return new InputRule(
        new RegExp(`^${hashes} $`),
        (state, match, start, end) => {
            const nodeType = schema.nodes.heading;
            const $start = state.doc.resolve(start);
            if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), nodeType)) {
                return null;
            }
            return state.tr
                .delete(start, end)
                .setBlockType(start, start, nodeType, { level });
        }
    );
}

export function buildInputRules() {
    return inputRules({
        rules: [
            headingRule(1),
            headingRule(2),
            headingRule(3),
            headingRule(4),
            headingRule(5),
            headingRule(6),
        ],
    });
}
