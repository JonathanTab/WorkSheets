/**
 * svg/mutations.js — pure immutable mutation functions for SvgDocument / SvgNode.
 *
 * Every function returns a NEW SvgDocument with structural sharing:
 * only the path from root → changed node is cloned; siblings are reused.
 */

import { NS, findNodeById } from './model.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function replaceNode(root, targetId, replacement) {
    if (root.id === targetId) return replacement;
    const newChildren = root.children.map(c => replaceNode(c, targetId, replacement));
    if (newChildren.every((c, i) => c === root.children[i])) return root;
    return { ...root, children: newChildren };
}

function updateDoc(doc, newRoot) {
    const defs      = newRoot.children.find(n => localName(n.type) === 'defs') ?? null;
    const namedview = newRoot.children.find(n => localName(n.type) === 'namedview') ?? null;
    const layers    = newRoot.children.filter(
        n => n.attributes['inkscape:groupmode'] === 'layer'
    );
    const grids     = namedview
        ? namedview.children.filter(n => localName(n.type) === 'grid')
        : [];
    return { ...doc, root: newRoot, defs, namedview, layers, grids };
}

function localName(type) {
    const i = type.indexOf(':');
    return i === -1 ? type : type.slice(i + 1);
}

// ── Attribute mutations ───────────────────────────────────────────────────────

/**
 * setNodeAttribute(doc, nodeId, key, value) → SvgDocument
 * value=null removes the attribute.
 */
export function setNodeAttribute(doc, nodeId, key, value) {
    const node = findNodeById(doc.root, nodeId);
    if (!node) return doc;

    let newAttrs;
    if (value === null || value === undefined) {
        newAttrs = { ...node.attributes };
        delete newAttrs[key];
    } else {
        newAttrs = { ...node.attributes, [key]: String(value) };
    }

    const newNode = { ...node, attributes: newAttrs };
    const newRoot = replaceNode(doc.root, nodeId, newNode);
    return updateDoc(doc, newRoot);
}

/**
 * setNodeAttributes(doc, nodeId, attrs) → SvgDocument
 * Batch attribute update in a single clone pass. null values remove the attribute.
 */
function setNodeAttributes(doc, nodeId, attrs) {
    const node = findNodeById(doc.root, nodeId);
    if (!node) return doc;

    const newAttrs = { ...node.attributes };
    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined) {
            delete newAttrs[key];
        } else {
            newAttrs[key] = String(value);
        }
    }

    const newNode = { ...node, attributes: newAttrs };
    const newRoot = replaceNode(doc.root, nodeId, newNode);
    return updateDoc(doc, newRoot);
}

// ── Document-level mutations ──────────────────────────────────────────────────

/**
 * updateNamedView(doc, updates) → SvgDocument
 * Merges updates into the sodipodi:namedview attributes.
 * Creates a namedview node if one doesn't exist.
 */
export function updateNamedView(doc, updates) {
    if (doc.namedview) {
        return setNodeAttributes(doc, doc.namedview.id, updates);
    }
    const nv = {
        id: `namedview_${Date.now()}`,
        type: 'sodipodi:namedview',
        ns: NS.sodipodi,
        attributes: {
            id: 'namedview0',
            ...Object.fromEntries(
                Object.entries(updates)
                    .filter(([, v]) => v !== null && v !== undefined)
                    .map(([k, v]) => [k, String(v)])
            ),
        },
        children: [],
        textContent: null,
    };
    const newRoot = { ...doc.root, children: [nv, ...doc.root.children] };
    return updateDoc(doc, newRoot);
}

/**
 * setArtboardSize(doc, w, h) → SvgDocument
 * Updates root svg width, height, and viewBox attributes.
 */
export function setArtboardSize(doc, w, h) {
    return setNodeAttributes(doc, doc.root.id, {
        width: String(w),
        height: String(h),
        viewBox: `0 0 ${w} ${h}`,
    });
}
