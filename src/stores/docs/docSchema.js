/**
 * ProseMirror schema for the word processor.
 * Extends prosemirror-schema-basic with lists, alignment, color, underline, etc.
 */

import { Schema } from 'prosemirror-model';
import { nodes as basicNodes, marks as basicMarks } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';

// Extended paragraph node with text alignment
const paragraph = {
    ...basicNodes.paragraph,
    attrs: { align: { default: null } },
    parseDOM: [
        {
            tag: 'p',
            getAttrs(dom) {
                return { align: dom.style.textAlign || null };
            },
        },
    ],
    toDOM(node) {
        const { align } = node.attrs;
        const style = align ? `text-align:${align}` : null;
        return ['p', style ? { style } : {}, 0];
    },
};

// Headings with alignment
function makeHeading(level) {
    return {
        ...basicNodes.heading,
        attrs: { level: { default: level }, align: { default: null } },
        parseDOM: [
            {
                tag: `h${level}`,
                getAttrs(dom) {
                    return { level, align: dom.style.textAlign || null };
                },
            },
        ],
        toDOM(node) {
            const { align } = node.attrs;
            const style = align ? `text-align:${align}` : null;
            return [`h${node.attrs.level}`, style ? { style } : {}, 0];
        },
    };
}

const blockquote = {
    ...basicNodes.blockquote,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM() { return ['blockquote', 0]; },
};

const code_block = {
    ...basicNodes.code_block,
    attrs: { params: { default: '' } },
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM() { return ['pre', ['code', 0]]; },
};

// Base node spec
const baseNodeSpec = {
    doc:          basicNodes.doc,
    paragraph,
    blockquote,
    horizontal_rule: basicNodes.horizontal_rule,
    heading:      makeHeading(1), // placeholder — we define per-level below
    code_block,
    text:         basicNodes.text,
    image:        basicNodes.image,
    hard_break:   basicNodes.hard_break,
};

// Custom marks
const customMarks = {
    ...basicMarks,

    underline: {
        parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
        toDOM() { return ['u', 0]; },
    },

    strikethrough: {
        parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
        toDOM() { return ['s', 0]; },
    },

    textColor: {
        attrs: { color: { default: null } },
        parseDOM: [
            {
                style: 'color',
                getAttrs: (v) => ({ color: v }),
            },
        ],
        toDOM(mark) {
            return ['span', { style: `color:${mark.attrs.color}`, 'data-mark': 'textColor' }, 0];
        },
    },

    bgColor: {
        attrs: { color: { default: null } },
        parseDOM: [
            {
                style: 'background-color',
                getAttrs: (v) => ({ color: v }),
            },
        ],
        toDOM(mark) {
            return ['span', { style: `background-color:${mark.attrs.color}`, 'data-mark': 'bgColor' }, 0];
        },
    },

    fontSize: {
        attrs: { size: { default: null } },
        parseDOM: [
            {
                style: 'font-size',
                getAttrs: (v) => ({ size: v }),
            },
        ],
        toDOM(mark) {
            return ['span', { style: `font-size:${mark.attrs.size}` }, 0];
        },
    },

    fontFamily: {
        attrs: { family: { default: null } },
        parseDOM: [
            {
                style: 'font-family',
                getAttrs: (v) => ({ family: v }),
            },
        ],
        toDOM(mark) {
            return ['span', { style: `font-family:${mark.attrs.family}` }, 0];
        },
    },
};

// Build schema — addListNodes inserts ordered_list, bullet_list, list_item
const nodesWithLists = addListNodes(
    new Schema({ nodes: baseNodeSpec, marks: customMarks }).spec.nodes,
    'paragraph block*',
    'block',
);

export const docSchema = new Schema({
    nodes: nodesWithLists,
    marks: customMarks,
});
