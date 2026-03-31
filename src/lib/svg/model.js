/**
 * svg/model.js — SvgNode / SvgDocument types and tree utilities.
 * No DOM imports — works in any JS context.
 */

// ── Namespace registry ────────────────────────────────────────────────────────

export const NS = {
    svg:      'http://www.w3.org/2000/svg',
    inkscape: 'http://www.inkscape.org/namespaces/inkscape',
    sodipodi: 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
    dc:       'http://purl.org/dc/elements/1.1/',
    cc:       'http://creativecommons.org/ns#',
    rdf:      'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    xlink:    'http://www.w3.org/1999/xlink',
    xml:      'http://www.w3.org/XML/1998/namespace',
};

/** Reverse map: URI → prefix */
export const NS_PREFIX = Object.fromEntries(Object.entries(NS).map(([k, v]) => [v, k]));

// ── Node factory ──────────────────────────────────────────────────────────────

let _nodeId = 1;
function nextNodeId() { return `n${_nodeId++}`; }

/**
 * makeNode(type, attrs?, children?) → SvgNode
 * type may include a namespace prefix: "sodipodi:namedview", "inkscape:grid"
 * ns is resolved from the prefix using the NS registry, defaulting to NS.svg.
 *
 * @param {string} type
 * @param {Record<string,string>} [attrs]
 * @param {SvgNode[]} [children]
 * @returns {SvgNode}
 */
export function makeNode(type, attrs = {}, children = []) {
    const colon = type.indexOf(':');
    let ns = NS.svg;
    if (colon !== -1) {
        const prefix = type.slice(0, colon);
        ns = NS[prefix] ?? NS.svg;
    }
    return {
        id: nextNodeId(),
        type,
        ns,
        attributes: { ...attrs },
        children: [...children],
        textContent: null,
    };
}

// ── Tree utilities ────────────────────────────────────────────────────────────

/**
 * findNodeById(root, id) → SvgNode | null
 * Depth-first search by the node's `id` field (internal model ID, not SVG id attribute).
 */
export function findNodeById(root, id) {
    if (root.id === id) return root;
    for (const child of root.children) {
        const found = findNodeById(child, id);
        if (found) return found;
    }
    return null;
}

/**
 * findNodeByAttr(root, attrName, attrValue) → SvgNode | null
 * Finds first node with the given attribute value (depth-first).
 */
export function findNodeByAttr(root, attrName, attrValue) {
    if (root.attributes[attrName] === attrValue) return root;
    for (const child of root.children) {
        const found = findNodeByAttr(child, attrName, attrValue);
        if (found) return found;
    }
    return null;
}

/**
 * findNodes(root, predicate) → SvgNode[]
 * Breadth-first search returning all matching nodes.
 */
export function findNodes(root, predicate) {
    const result = [];
    const queue = [root];
    while (queue.length) {
        const node = queue.shift();
        if (predicate(node)) result.push(node);
        queue.push(...node.children);
    }
    return result;
}

/**
 * cloneNode(node) → SvgNode
 * Deep clone — new object identities throughout.
 */
export function cloneNode(node) {
    return {
        id: node.id,
        type: node.type,
        ns: node.ns,
        attributes: { ...node.attributes },
        children: node.children.map(cloneNode),
        textContent: node.textContent,
    };
}

/**
 * parentOf(root, targetId) → SvgNode | null
 * Returns the parent node whose children array contains the node with the given id.
 */
export function parentOf(root, targetId) {
    for (const child of root.children) {
        if (child.id === targetId) return root;
        const found = parentOf(child, targetId);
        if (found) return found;
    }
    return null;
}

// ── Document-level queries ────────────────────────────────────────────────────

/**
 * getLayers(doc) → SvgNode[]
 * Returns all g elements with inkscape:groupmode="layer" in document order.
 * Only scans direct children of root (top-level layers).
 */
export function getLayers(doc) {
    return doc.root.children.filter(
        n => n.attributes['inkscape:groupmode'] === 'layer'
    );
}

/**
 * getAttr(node, key) → string | null
 */
export function getAttr(node, key) {
    return node.attributes[key] ?? null;
}

// ── Document skeleton ─────────────────────────────────────────────────────────

/**
 * makeDocumentSkeleton(w, h) → SvgDocument
 * Produces a new Inkscape-compatible document model with namedview + default layer.
 */
export function makeDocumentSkeleton(w = 800, h = 600) {
    const namedview = makeNode('sodipodi:namedview', {
        id: 'namedview0',
        pagecolor: '#ffffff',
        bordercolor: '#666666',
        borderopacity: '1.0',
        'inkscape:document-units': 'px',
        showgrid: 'false',
        'inkscape:current-layer': 'layer1',
    });

    const defs = makeNode('defs', { id: 'defs0' });

    const layer = makeNode('g', {
        id: 'layer1',
        'inkscape:groupmode': 'layer',
        'inkscape:label': 'Layer 1',
    });

    const root = makeNode('svg', {
        id: 'svg0',
        xmlns: NS.svg,
        'xmlns:dc': NS.dc,
        'xmlns:cc': NS.cc,
        'xmlns:rdf': NS.rdf,
        'xmlns:svg': NS.svg,
        'xmlns:sodipodi': NS.sodipodi,
        'xmlns:inkscape': NS.inkscape,
        width: String(w),
        height: String(h),
        viewBox: `0 0 ${w} ${h}`,
        version: '1.1',
    }, [namedview, defs, layer]);

    return {
        root,
        defs,
        namedview,
        layers: [layer],
        grids: [],
        namespaces: {
            dc: NS.dc, cc: NS.cc, rdf: NS.rdf,
            svg: NS.svg, sodipodi: NS.sodipodi, inkscape: NS.inkscape,
        },
    };
}
