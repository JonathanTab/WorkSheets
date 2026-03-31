/**
 * svg/mutations.js — pure immutable mutation functions for SvgDocument / SvgNode.
 *
 * Every function returns a NEW SvgDocument with structural sharing:
 * only the path from root → changed node is cloned; siblings are reused.
 */

import { NS, cloneNode, parentOf, findNodeById } from './model.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * replaceNode(root, targetId, replacement) → SvgNode
 * Returns a new root with the target node replaced. Uses structural sharing.
 */
function replaceNode(root, targetId, replacement) {
    if (root.id === targetId) return replacement;
    const newChildren = root.children.map(c => replaceNode(c, targetId, replacement));
    // If no child changed, reuse the same array reference
    if (newChildren.every((c, i) => c === root.children[i])) return root;
    return { ...root, children: newChildren };
}

/**
 * updateDoc(doc, newRoot) → SvgDocument
 * Rebuilds the document with a new root, recomputing the cached references.
 */
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
export function setNodeAttributes(doc, nodeId, attrs) {
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

// ── Tree mutations ────────────────────────────────────────────────────────────

/**
 * addNode(doc, parentId, node, insertBeforeId?) → SvgDocument
 * Appends a new node under the parent, or inserts before insertBeforeId.
 */
export function addNode(doc, parentId, node, insertBeforeId = null) {
    const parent = findNodeById(doc.root, parentId);
    if (!parent) return doc;

    let newChildren;
    if (insertBeforeId) {
        const idx = parent.children.findIndex(c => c.id === insertBeforeId);
        if (idx === -1) {
            newChildren = [...parent.children, node];
        } else {
            newChildren = [...parent.children.slice(0, idx), node, ...parent.children.slice(idx)];
        }
    } else {
        newChildren = [...parent.children, node];
    }

    const newParent = { ...parent, children: newChildren };
    const newRoot = replaceNode(doc.root, parentId, newParent);
    return updateDoc(doc, newRoot);
}

/**
 * removeNode(doc, nodeId) → SvgDocument
 */
export function removeNode(doc, nodeId) {
    const parent = parentOf(doc.root, nodeId);
    if (!parent) return doc;

    const newParent = { ...parent, children: parent.children.filter(c => c.id !== nodeId) };
    const newRoot = replaceNode(doc.root, parent.id, newParent);
    return updateDoc(doc, newRoot);
}

/**
 * moveNode(doc, nodeId, newParentId, insertBeforeId?) → SvgDocument
 * Removes nodeId from its current parent and inserts under newParentId.
 */
export function moveNode(doc, nodeId, newParentId, insertBeforeId = null) {
    const node = findNodeById(doc.root, nodeId);
    if (!node) return doc;

    // Remove from current parent first
    let intermediate = removeNode(doc, nodeId);

    // Insert under new parent (node identity preserved)
    return addNode(intermediate, newParentId, node, insertBeforeId);
}

/**
 * reorderNode(doc, nodeId, direction) → SvgDocument
 * direction: 'forward' | 'backward' | 'front' | 'back'
 */
export function reorderNode(doc, nodeId, direction) {
    const parent = parentOf(doc.root, nodeId);
    if (!parent) return doc;

    const children = [...parent.children];
    const idx = children.findIndex(c => c.id === nodeId);
    if (idx === -1) return doc;

    let newIdx;
    if (direction === 'forward')  newIdx = Math.min(idx + 1, children.length - 1);
    if (direction === 'backward') newIdx = Math.max(idx - 1, 0);
    if (direction === 'front')    newIdx = children.length - 1;
    if (direction === 'back')     newIdx = 0;
    if (newIdx == null || newIdx === idx) return doc;

    const [moved] = children.splice(idx, 1);
    children.splice(newIdx, 0, moved);

    const newParent = { ...parent, children };
    const newRoot = replaceNode(doc.root, parent.id, newParent);
    return updateDoc(doc, newRoot);
}

// ── Transform mutations ───────────────────────────────────────────────────────

/**
 * updateTranslate(doc, nodeId, tx, ty) → SvgDocument
 * Rewrites only the translate(...) portion of the transform attribute.
 */
export function updateTranslate(doc, nodeId, tx, ty) {
    const node = findNodeById(doc.root, nodeId);
    if (!node) return doc;

    const existing = node.attributes['transform'] ?? '';
    const without = existing.replace(/translate\([^)]*\)/, '').trim();
    const translate = (tx !== 0 || ty !== 0) ? `translate(${r(tx)},${r(ty)})` : '';
    const newTransform = [translate, without].filter(Boolean).join(' ');

    const newAttrs = { ...node.attributes };
    if (newTransform) {
        newAttrs['transform'] = newTransform;
    } else {
        delete newAttrs['transform'];
    }

    const newNode = { ...node, attributes: newAttrs };
    const newRoot = replaceNode(doc.root, nodeId, newNode);
    return updateDoc(doc, newRoot);
}

function r(n) { return Math.round(n * 100) / 100; }

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
    // namedview missing — create one and prepend to root children
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
