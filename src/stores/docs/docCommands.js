/**
 * ProseMirror commands for the word processor toolbar.
 */

import { toggleMark, setBlockType, wrapIn, lift } from 'prosemirror-commands';
import { wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { TextSelection } from 'prosemirror-state';
import { inputRules, InputRule } from 'prosemirror-inputrules';
import {
    addColumnBefore, addColumnAfter, deleteColumn,
    addRowBefore, addRowAfter, deleteRow,
    mergeCells, splitCell,
    goToNextCell,
} from 'prosemirror-tables';
import { docSchema as schema } from './docSchema.js';

// ── Mark toggles ──────────────────────────────────────────────────────────────

export const toggleBold          = toggleMark(schema.marks.strong);
export const toggleItalic        = toggleMark(schema.marks.em);
export const toggleCode          = toggleMark(schema.marks.code);
export const toggleUnderline     = toggleMark(schema.marks.underline);
export const toggleStrikethrough = toggleMark(schema.marks.strikethrough);
export const toggleSuperscript   = toggleMark(schema.marks.superscript);
export const toggleSubscript     = toggleMark(schema.marks.subscript);

// ── Block type setters ────────────────────────────────────────────────────────

export function setHeading(level) { return setBlockType(schema.nodes.heading, { level }); }
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

export const toggleBulletList = (state, dispatch) => {
    if (isInList(state, schema.nodes.bullet_list)) return lift(state, dispatch);
    return wrapInList(schema.nodes.bullet_list)(state, dispatch);
};

export const toggleOrderedList = (state, dispatch) => {
    if (isInList(state, schema.nodes.ordered_list)) return lift(state, dispatch);
    return wrapInList(schema.nodes.ordered_list)(state, dispatch);
};

export const indentList  = sinkListItem(schema.nodes.list_item);
export const outdentList = liftListItem(schema.nodes.list_item);
export const splitList   = splitListItem(schema.nodes.list_item);

// ── Check list ────────────────────────────────────────────────────────────────

export const toggleCheckList = (state, dispatch) => {
    if (isInCheckList(state)) return lift(state, dispatch);
    return wrapInList(schema.nodes.check_list)(state, dispatch);
};

export function toggleCheckListItem(state, dispatch) {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === schema.nodes.check_list_item) {
            if (dispatch) {
                const pos = $from.before(d);
                dispatch(state.tr.setNodeMarkup(pos, null, {
                    ...node.attrs,
                    checked: !node.attrs.checked,
                }));
            }
            return true;
        }
    }
    return false;
}

// ── Wrappers ──────────────────────────────────────────────────────────────────

export const toggleBlockquote = (state, dispatch) => {
    if (isWrappedIn(state, schema.nodes.blockquote)) return lift(state, dispatch);
    return wrapIn(schema.nodes.blockquote)(state, dispatch);
};

// ── Inline attributes ─────────────────────────────────────────────────────────

export function setTextColor(color) { return setMarkAttr(schema.marks.textColor, { color }); }
export function setBgColor(color)   { return setMarkAttr(schema.marks.bgColor, { color }); }
export function setFontSize(size)   { return setMarkAttr(schema.marks.fontSize, { size }); }
export function setFontFamily(family) { return setMarkAttr(schema.marks.fontFamily, { family }); }

// ── Clear formatting ──────────────────────────────────────────────────────────

export function clearFormatting(state, dispatch) {
    const { selection, tr } = state;
    if (selection.empty) return false;
    const { from, to } = selection;
    if (dispatch) {
        const allMarks = [
            schema.marks.strong, schema.marks.em, schema.marks.underline,
            schema.marks.strikethrough, schema.marks.code,
            schema.marks.superscript, schema.marks.subscript,
            schema.marks.textColor, schema.marks.bgColor,
            schema.marks.fontSize, schema.marks.fontFamily,
            schema.marks.link,
        ];
        for (const mark of allMarks) tr.removeMark(from, to, mark);
        dispatch(tr);
    }
    return true;
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
    if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()));
    return true;
}

// ── Image ─────────────────────────────────────────────────────────────────────

export function insertImage(src, alt = '') {
    return (state, dispatch) => {
        if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.image.create({ src, alt, title: '' })));
        return true;
    };
}

// ── Tables (prosemirror-tables commands) ──────────────────────────────────────

export {
    addColumnBefore, addColumnAfter, deleteColumn,
    addRowBefore, addRowAfter, deleteRow,
    mergeCells, splitCell,
    goToNextCell,
};

export function insertTable(rows = 3, cols = 3) {
    return (state, dispatch) => {
        if (dispatch) {
            const headerCells = Array.from({ length: cols }, () =>
                schema.nodes.table_header.createAndFill()
            );
            const bodyRows = Array.from({ length: Math.max(0, rows - 1) }, () =>
                schema.nodes.table_row.create(null,
                    Array.from({ length: cols }, () => schema.nodes.table_cell.createAndFill())
                )
            );
            const tableNode = schema.nodes.table.create(null, [
                schema.nodes.table_row.create(null, headerCells),
                ...bodyRows,
            ]);
            dispatch(state.tr.replaceSelectionWith(tableNode).scrollIntoView());
        }
        return true;
    };
}

// ── State inspection ──────────────────────────────────────────────────────────

export function getMarkState(editorState) {
    if (!editorState) return {};
    const { selection, storedMarks, doc } = editorState;
    const { empty, from, to, $from } = selection;

    let textColor = null, bgColor = null, fontSize = null, fontFamily = null;
    let inTable = false, inTableHeader = false;

    doc.nodesBetween(from, to, node => {
        if (!node.isText) return;
        for (const m of node.marks) {
            if (m.type === schema.marks.textColor)  textColor  = m.attrs.color;
            if (m.type === schema.marks.bgColor)    bgColor    = m.attrs.color;
            if (m.type === schema.marks.fontSize)   fontSize   = m.attrs.size;
            if (m.type === schema.marks.fontFamily) fontFamily = m.attrs.family;
        }
    });

    for (const m of (storedMarks ?? [])) {
        if (m.type === schema.marks.textColor)  textColor  = m.attrs.color;
        if (m.type === schema.marks.bgColor)    bgColor    = m.attrs.color;
        if (m.type === schema.marks.fontSize)   fontSize   = m.attrs.size;
        if (m.type === schema.marks.fontFamily) fontFamily = m.attrs.family;
    }

    for (let d = $from.depth; d > 0; d--) {
        const t = $from.node(d).type;
        if (t === schema.nodes.table_cell)   { inTable = true; break; }
        if (t === schema.nodes.table_header) { inTable = true; inTableHeader = true; break; }
    }

    const blockType  = $from.parent.type;
    const blockAttrs = $from.parent.attrs;

    return {
        bold:           isMarkActive(editorState, schema.marks.strong),
        italic:         isMarkActive(editorState, schema.marks.em),
        underline:      isMarkActive(editorState, schema.marks.underline),
        strikethrough:  isMarkActive(editorState, schema.marks.strikethrough),
        code:           isMarkActive(editorState, schema.marks.code),
        superscript:    isMarkActive(editorState, schema.marks.superscript),
        subscript:      isMarkActive(editorState, schema.marks.subscript),
        blockType:      blockType.name,
        headingLevel:   blockType === schema.nodes.heading ? blockAttrs.level : null,
        align:          blockAttrs?.align ?? 'left',
        textColor,
        bgColor,
        fontSize,
        fontFamily,
        inBulletList:   isInList(editorState, schema.nodes.bullet_list),
        inOrderedList:  isInList(editorState, schema.nodes.ordered_list),
        inCheckList:    isInCheckList(editorState),
        inBlockquote:   isWrappedIn(editorState, schema.nodes.blockquote),
        inTable,
        inTableHeader,
    };
}

export function getDocStats(doc) {
    let chars = 0, words = 0;
    doc.descendants(node => {
        if (!node.isText) return;
        chars += node.text.length;
        words += node.text.trim().split(/\s+/).filter(Boolean).length;
    });
    return { chars, words };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMarkActive(state, markType) {
    const { selection, storedMarks, doc } = state;
    const { empty, from, to, $from } = selection;
    if (empty) return markType.isInSet(storedMarks ?? $from.marks()) != null;
    return doc.rangeHasMark(from, to, markType);
}

function isInList(state, listType) {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === listType) return true;
    }
    return false;
}

function isInCheckList(state) {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === schema.nodes.check_list) return true;
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

function setMarkAttr(markType, attrs) {
    return (state, dispatch) => {
        const { selection, tr } = state;
        if (selection.empty) return false;
        const { from, to } = selection;
        if (dispatch) {
            tr.removeMark(from, to, markType);
            if (Object.values(attrs).some(v => v != null)) {
                tr.addMark(from, to, markType.create(attrs));
            }
            dispatch(tr);
        }
        return true;
    };
}

// ── Input rules ───────────────────────────────────────────────────────────────

function headingRule(level) {
    const hashes = '#'.repeat(level);
    return new InputRule(
        new RegExp(`^${hashes} $`),
        (state, match, start, end) => {
            const nodeType = schema.nodes.heading;
            const $start = state.doc.resolve(start);
            if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), nodeType)) return null;
            return state.tr.delete(start, end).setBlockType(start, start, nodeType, { level });
        }
    );
}

export function buildInputRules() {
    return inputRules({
        rules: [
            headingRule(1), headingRule(2), headingRule(3),
            headingRule(4), headingRule(5), headingRule(6),
        ],
    });
}
