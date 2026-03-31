/**
 * svg/parser.js — converts an SVG string into an SvgDocument plain-object model.
 * Uses DOMParser to walk the XML tree; the resulting DOM is discarded after parsing.
 */

import { NS, NS_PREFIX, makeNode } from './model.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * parseSvgString(svgString) → SvgDocument
 * Throws if the string is not parseable XML or the root is a parseerror element.
 */
export function parseSvgString(svgString) {
    const dom = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    const rootEl = dom.documentElement;
    if (rootEl.tagName === 'parsererror' || rootEl.nodeName === 'parsererror') {
        throw new Error('SVG parse error: ' + (rootEl.textContent ?? '').slice(0, 200));
    }
    return buildDocument(rootEl);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function buildDocument(rootEl) {
    const namespaces = extractNamespaces(rootEl);
    const root = walkElement(rootEl, namespaces);

    // Locate well-known structural children by type
    const defs      = root.children.find(n => localName(n.type) === 'defs') ?? null;
    const namedview = root.children.find(n => localName(n.type) === 'namedview') ?? null;
    const layers    = root.children.filter(
        n => n.attributes['inkscape:groupmode'] === 'layer'
    );
    const grids     = namedview
        ? namedview.children.filter(n => localName(n.type) === 'grid')
        : [];

    return { root, defs, namedview, layers, grids, namespaces };
}

/**
 * extractNamespaces(el) → Record<prefix, uri>
 * Reads all xmlns:* attributes from the root element.
 */
function extractNamespaces(el) {
    const ns = {};
    for (const attr of Array.from(el.attributes)) {
        if (attr.name === 'xmlns') {
            ns[''] = attr.value;
        } else if (attr.name.startsWith('xmlns:')) {
            const prefix = attr.name.slice(6);
            ns[prefix] = attr.value;
        }
    }
    // Ensure the well-known namespaces are always included
    for (const [prefix, uri] of Object.entries(NS)) {
        if (!(prefix in ns) && Object.values(ns).includes(uri)) {
            // URI is already tracked under a different key — skip
        } else if (!(prefix in ns)) {
            // Don't add if not actually used; they'll come from the element walk
        }
    }
    return ns;
}

/**
 * walkElement(el, nsMap) → SvgNode
 * Recursively maps a DOM Element to an SvgNode.
 * All attribute names are preserved as-is (including prefixed ones like inkscape:label).
 */
function walkElement(el, nsMap) {
    const type = qualifiedName(el, nsMap);
    const attributes = {};

    for (const attr of Array.from(el.attributes)) {
        // Skip xmlns declarations — those are in namespaces
        if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue;
        attributes[attr.name] = attr.value;
    }

    // Determine node namespace URI
    const colon = type.indexOf(':');
    let nsUri = NS.svg;
    if (colon !== -1) {
        const prefix = type.slice(0, colon);
        nsUri = NS[prefix] ?? nsMap[prefix] ?? NS.svg;
    }

    const node = {
        id: nextId(),
        type,
        ns: nsUri,
        attributes,
        children: [],
        textContent: null,
    };

    // Collect direct text content (important for <text>, <tspan>, <title>, etc.)
    // and recurse into element children
    let textParts = [];
    for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3 /* TEXT_NODE */) {
            const trimmed = child.nodeValue; // preserve whitespace
            if (trimmed != null) textParts.push(trimmed);
        } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
            node.children.push(walkElement(child, nsMap));
        }
        // CDATA (4), comments (8), PIs (7) are intentionally dropped
    }

    if (textParts.length) {
        node.textContent = textParts.join('');
    }

    return node;
}

/**
 * qualifiedName(el, nsMap) → string
 * Returns the prefixed tag name (e.g. "sodipodi:namedview", "inkscape:grid", "rect").
 * Uses the element's namespace URI to look up the preferred prefix from our NS registry,
 * falling back to the element's own prefix.
 */
function qualifiedName(el, nsMap) {
    const ns = el.namespaceURI;
    const local = el.localName;

    if (!ns || ns === NS.svg) return local;

    // Prefer our canonical prefix mapping
    const canonicalPrefix = NS_PREFIX[ns];
    if (canonicalPrefix) return `${canonicalPrefix}:${local}`;

    // Fall back to the element's own prefix
    const prefix = el.prefix;
    if (prefix) return `${prefix}:${local}`;

    return local;
}

function localName(type) {
    const i = type.indexOf(':');
    return i === -1 ? type : type.slice(i + 1);
}

let _id = 1;
function nextId() { return `n${_id++}`; }
