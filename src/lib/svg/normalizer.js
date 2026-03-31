/**
 * svg/normalizer.js — SVG Normalization Pipeline
 *
 * Converts any SVG (Figma export, Adobe Illustrator, plain SVG) into
 * Inkscape-canonical format. Pure model transform — no DOM, no side effects.
 * Returns a new SvgDocument and an array of warning strings.
 *
 * Stages:
 *   1. Namespace enforcement      — add required xmlns declarations to namespaces map
 *   2. sodipodi:namedview         — create if missing, patch missing attributes
 *   3. CSS style expansion        — expand `style="..."` attributes to individual attrs
 *   4. <style> sheet normalisation — hoist CSS class rules to inline attrs (best-effort)
 *   5. Layer detection            — promote top-level <g> groups to layers if none exist
 *   6. inkscape:label backfill    — add missing labels from id or auto-name
 *   7. Metadata scaffold          — add empty <metadata>/<rdf:RDF> if missing
 *   8. AI / Illustrator cleanup   — strip Adobe-specific processing instructions & attrs
 */

import { NS, makeNode, cloneNode, findNodes } from './model.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * normalizeSvgDocument(doc) → { doc: SvgDocument, warnings: string[] }
 * All stages are applied in order. Input document is NOT mutated.
 */
export function normalizeSvgDocument(doc) {
    const warnings = [];
    let d = deepCloneDoc(doc);

    d = stage1_namespaces(d, warnings);
    d = stage2_namedview(d, warnings);
    d = stage3_expandStyles(d, warnings);
    d = stage4_styleSheets(d, warnings);
    d = stage5_layers(d, warnings);
    d = stage6_labels(d, warnings);
    d = stage7_metadata(d, warnings);
    d = stage8_aiCleanup(d, warnings);

    return { doc: d, warnings };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deep-clone an SvgDocument so all stages can mutate freely */
function deepCloneDoc(doc) {
    const root = cloneNode(doc.root);
    // Re-derive structural references from the cloned tree
    const defs      = root.children.find(n => localName(n.type) === 'defs') ?? null;
    const namedview = root.children.find(n => localName(n.type) === 'namedview') ?? null;
    const layers    = root.children.filter(
        n => n.attributes['inkscape:groupmode'] === 'layer'
    );
    const grids     = namedview
        ? namedview.children.filter(n => localName(n.type) === 'grid')
        : [];
    return {
        root,
        defs,
        namedview,
        layers,
        grids,
        namespaces: { ...doc.namespaces },
    };
}

function localName(type) {
    const i = type.indexOf(':');
    return i === -1 ? type : type.slice(i + 1);
}

function setAttr(node, key, value) {
    node.attributes[key] = value;
}

function hasAttr(node, key) {
    return Object.prototype.hasOwnProperty.call(node.attributes, key);
}

// ── Stage 1: Namespace enforcement ────────────────────────────────────────────

const REQUIRED_NAMESPACES = {
    dc:       NS.dc,
    cc:       NS.cc,
    rdf:      NS.rdf,
    xlink:    NS.xlink,
    sodipodi: NS.sodipodi,
    inkscape: NS.inkscape,
};

function stage1_namespaces(doc, warnings) {
    let added = [];
    for (const [prefix, uri] of Object.entries(REQUIRED_NAMESPACES)) {
        if (!doc.namespaces[prefix]) {
            doc.namespaces[prefix] = uri;
            added.push(prefix);
        }
    }
    // Ensure default SVG namespace
    if (!doc.namespaces[''] && !doc.namespaces['svg']) {
        doc.namespaces[''] = NS.svg;
        added.push('xmlns');
    }
    if (added.length) {
        warnings.push(`Stage 1: added missing namespace declarations: ${added.join(', ')}`);
    }
    return doc;
}

// ── Stage 2: sodipodi:namedview ───────────────────────────────────────────────

const NAMEDVIEW_DEFAULTS = {
    id:                        'namedview0',
    pagecolor:                 '#ffffff',
    bordercolor:               '#666666',
    borderopacity:             '1.0',
    'inkscape:document-units': 'px',
    showgrid:                  'false',
};

function stage2_namedview(doc, warnings) {
    if (!doc.namedview) {
        // Find or create a namedview node in root.children
        const nv = makeNode('sodipodi:namedview', { ...NAMEDVIEW_DEFAULTS });
        // Insert right after <defs> if present, otherwise at position 0
        const defsIdx = doc.root.children.findIndex(n => localName(n.type) === 'defs');
        if (defsIdx !== -1) {
            doc.root.children.splice(defsIdx + 1, 0, nv);
        } else {
            doc.root.children.unshift(nv);
        }
        doc.namedview = nv;
        warnings.push('Stage 2: created missing sodipodi:namedview');
    } else {
        // Patch any missing defaults
        const nv = doc.namedview;
        let patched = [];
        for (const [k, v] of Object.entries(NAMEDVIEW_DEFAULTS)) {
            if (!hasAttr(nv, k)) {
                setAttr(nv, k, v);
                patched.push(k);
            }
        }
        if (patched.length) {
            warnings.push(`Stage 2: patched namedview missing attrs: ${patched.join(', ')}`);
        }
    }

    // Ensure inkscape:current-layer points to a real layer id
    const nv = doc.namedview;
    const currentLayer = nv.attributes['inkscape:current-layer'];
    const layerIds = doc.layers.map(l => l.attributes.id).filter(Boolean);
    if (layerIds.length && (!currentLayer || !layerIds.includes(currentLayer))) {
        setAttr(nv, 'inkscape:current-layer', layerIds[0]);
    }

    return doc;
}

// ── Stage 3: CSS style attribute expansion ────────────────────────────────────

// Properties that are presentational SVG attributes (safe to expand)
const PRESENTATION_PROPS = new Set([
    'fill', 'fill-opacity', 'fill-rule',
    'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-miterlimit',
    'opacity', 'display', 'visibility',
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'text-anchor', 'text-decoration', 'letter-spacing', 'word-spacing',
    'color', 'color-interpolation', 'color-rendering',
    'clip-path', 'clip-rule', 'mask', 'overflow', 'pointer-events',
    'stop-color', 'stop-opacity',
    'marker', 'marker-start', 'marker-mid', 'marker-end',
    'paint-order', 'shape-rendering', 'image-rendering', 'text-rendering',
    'dominant-baseline', 'alignment-baseline', 'baseline-shift',
    'vector-effect', 'mix-blend-mode', 'isolation',
    'cursor',
]);

function parseCssDeclarations(styleStr) {
    const result = {};
    for (const decl of styleStr.split(';')) {
        const colon = decl.indexOf(':');
        if (colon === -1) continue;
        const prop = decl.slice(0, colon).trim().toLowerCase();
        const val  = decl.slice(colon + 1).trim();
        if (prop && val) result[prop] = val;
    }
    return result;
}

function expandStyleAttr(node) {
    const styleStr = node.attributes['style'];
    if (!styleStr) return;

    const decls = parseCssDeclarations(styleStr);
    let remaining = [];

    for (const [prop, val] of Object.entries(decls)) {
        if (PRESENTATION_PROPS.has(prop)) {
            // Only set if not already an explicit attribute (explicit attr wins)
            if (!hasAttr(node, prop)) {
                setAttr(node, prop, val);
            }
        } else {
            remaining.push(`${prop}:${val}`);
        }
    }

    if (remaining.length) {
        node.attributes['style'] = remaining.join(';');
    } else {
        delete node.attributes['style'];
    }
}

function stage3_expandStyles(doc, warnings) {
    let count = 0;
    const allNodes = findNodes(doc.root, n => hasAttr(n, 'style'));
    for (const node of allNodes) {
        expandStyleAttr(node);
        count++;
    }
    if (count) {
        warnings.push(`Stage 3: expanded style="" attributes on ${count} element(s)`);
    }
    return doc;
}

// ── Stage 4: <style> sheet normalization ──────────────────────────────────────
//
// Best-effort: parse simple class selectors (.foo { ... }) and apply the
// declarations to elements that carry those classes. Only processes class
// selectors (e.g., .foo, .bar). Complex selectors (combinators, pseudo-classes,
// specificity conflicts) are left in place with a warning.

function parseStyleSheet(cssText) {
    // Map: className → { prop: value, ... }
    const rules = {};
    const ruleRe = /\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(cssText)) !== null) {
        const cls = m[1];
        const decls = parseCssDeclarations(m[2]);
        rules[cls] = decls;
    }
    return rules;
}

function stage4_styleSheets(doc, warnings) {
    if (!doc.defs) return doc;

    const styleNodes = doc.defs.children.filter(n => localName(n.type) === 'style');
    if (!styleNodes.length) return doc;

    let totalApplied = 0;

    for (const styleNode of styleNodes) {
        const cssText = styleNode.textContent ?? '';
        if (!cssText.trim()) continue;

        const rules = parseStyleSheet(cssText);
        if (!Object.keys(rules).length) continue;

        // Walk all elements and apply matching class rules
        const allElements = findNodes(doc.root, n => hasAttr(n, 'class'));
        for (const node of allElements) {
            const classes = (node.attributes['class'] ?? '').split(/\s+/).filter(Boolean);
            for (const cls of classes) {
                if (rules[cls]) {
                    for (const [prop, val] of Object.entries(rules[cls])) {
                        if (PRESENTATION_PROPS.has(prop) && !hasAttr(node, prop)) {
                            setAttr(node, prop, val);
                            totalApplied++;
                        }
                    }
                }
            }
        }
    }

    if (totalApplied) {
        warnings.push(`Stage 4: applied ${totalApplied} CSS class rule(s) to elements`);
    }

    return doc;
}

// ── Stage 5: Layer detection ──────────────────────────────────────────────────
//
// If the document has no Inkscape layers, promote top-level <g> elements
// to layers. If there are no top-level <g> elements at all, wrap all
// non-structural content in a default layer.

const STRUCTURAL_TYPES = new Set(['defs', 'namedview', 'metadata', 'title', 'desc', 'style']);

function isStructural(node) {
    return STRUCTURAL_TYPES.has(localName(node.type));
}

function stage5_layers(doc, warnings) {
    if (doc.layers.length > 0) return doc; // already has layers

    const topGroups = doc.root.children.filter(
        n => localName(n.type) === 'g' && !isStructural(n)
    );

    if (topGroups.length > 0) {
        // Promote each top-level <g> to a layer
        let i = 1;
        for (const g of topGroups) {
            setAttr(g, 'inkscape:groupmode', 'layer');
            if (!hasAttr(g, 'inkscape:label')) {
                const existingLabel = g.attributes['id'] ?? `Layer ${i}`;
                setAttr(g, 'inkscape:label', existingLabel);
            }
            if (!hasAttr(g, 'id')) {
                setAttr(g, 'id', `layer${i}`);
            }
            i++;
        }
        doc.layers = topGroups;
        warnings.push(`Stage 5: promoted ${topGroups.length} top-level <g> group(s) to layers`);
    } else {
        // No top-level groups — wrap all drawable content in a new layer
        const drawables = doc.root.children.filter(n => !isStructural(n));
        if (drawables.length > 0) {
            const layer = makeNode('g', {
                id: 'layer1',
                'inkscape:groupmode': 'layer',
                'inkscape:label': 'Layer 1',
            }, drawables);
            // Remove drawables from root and insert the layer in their place
            const firstIdx = doc.root.children.indexOf(drawables[0]);
            doc.root.children = [
                ...doc.root.children.slice(0, firstIdx),
                layer,
                ...doc.root.children.slice(firstIdx).filter(n => !drawables.includes(n)),
            ];
            doc.layers = [layer];
            warnings.push(`Stage 5: wrapped ${drawables.length} element(s) into a new default layer`);
        }
    }

    // Update namedview inkscape:current-layer
    if (doc.namedview && doc.layers.length) {
        const firstLayerId = doc.layers[0].attributes['id'];
        if (firstLayerId) {
            setAttr(doc.namedview, 'inkscape:current-layer', firstLayerId);
        }
    }

    return doc;
}

// ── Stage 6: inkscape:label backfill ─────────────────────────────────────────

const LABEL_TAGS = new Set(['g', 'rect', 'ellipse', 'circle', 'line', 'path',
    'polygon', 'polyline', 'text', 'image', 'use']);

function stage6_labels(doc, warnings) {
    // Only backfill layers — individual shape labels are optional and would add noise
    let count = 0;
    for (const layer of doc.layers) {
        if (!hasAttr(layer, 'inkscape:label')) {
            const label = layer.attributes['id'] ?? `Layer ${count + 1}`;
            setAttr(layer, 'inkscape:label', label);
            count++;
        }
    }
    if (count) {
        warnings.push(`Stage 6: backfilled inkscape:label on ${count} layer(s)`);
    }
    return doc;
}

// ── Stage 7: Metadata scaffold ────────────────────────────────────────────────

function stage7_metadata(doc, warnings) {
    const hasMetadata = doc.root.children.some(n => localName(n.type) === 'metadata');
    if (hasMetadata) return doc;

    // Build minimal RDF metadata scaffold
    const rdfWork = makeNode('cc:Work', { 'rdf:about': '' }, [
        makeNode('dc:format', {}, []),
        makeNode('dc:type', { 'rdf:resource': 'http://purl.org/dc/dcmitype/StillImage' }),
    ]);
    rdfWork.children[0].textContent = 'image/svg+xml';

    const rdfRdf = makeNode('rdf:RDF', {}, [rdfWork]);
    const metadata = makeNode('metadata', { id: 'metadata0' }, [rdfRdf]);

    // Insert after namedview/defs
    const nvIdx = doc.root.children.findIndex(n => localName(n.type) === 'namedview');
    const insertAt = nvIdx !== -1 ? nvIdx + 1 : 0;
    doc.root.children.splice(insertAt, 0, metadata);

    warnings.push('Stage 7: added minimal RDF metadata scaffold');
    return doc;
}

// ── Stage 8: AI / Illustrator cleanup ────────────────────────────────────────

// Illustrator adds these on the root <svg> element
const AI_ROOT_ATTRS = [
    'i:pageBounds', 'i:viewOrigin', 'i:rulerOrigin',
    'i:isTimeSVG', 'i:pageBoundsRect', 'i:extraContentType',
    'adobe:spaceBefore', 'adobe:spaceAfter', 'xmlns:i', 'xmlns:x', 'xmlns:adobe',
    'xml:space', // usually 'preserve' — harmless but AI artifact
];

// Attributes that AI sets on all elements
const AI_ELEMENT_ATTRS = [
    'i:knockout',
];

// AI-specific element types to remove
const AI_ELEMENT_TYPES = new Set([
    'foreignObject',     // sometimes used by AI for embedded images metadata
]);

function stage8_aiCleanup(doc, warnings) {
    let removedAttrs = 0;
    let removedElements = 0;

    // Strip root-level AI attributes
    for (const attr of AI_ROOT_ATTRS) {
        if (hasAttr(doc.root, attr)) {
            delete doc.root.attributes[attr];
            removedAttrs++;
        }
    }
    // Remove xmlns:i and xmlns:adobe from namespace map
    for (const prefix of ['i', 'x', 'adobe']) {
        if (doc.namespaces[prefix] && !NS[prefix]) {
            delete doc.namespaces[prefix];
        }
    }

    // Walk all nodes and strip AI element attributes
    const allNodes = findNodes(doc.root, () => true);
    for (const node of allNodes) {
        for (const attr of AI_ELEMENT_ATTRS) {
            if (hasAttr(node, attr)) {
                delete node.attributes[attr];
                removedAttrs++;
            }
        }
    }

    // Remove AI-specific element types (only from defs, not content layers)
    if (doc.defs) {
        const before = doc.defs.children.length;
        doc.defs.children = doc.defs.children.filter(
            n => !AI_ELEMENT_TYPES.has(localName(n.type))
        );
        removedElements += before - doc.defs.children.length;
    }

    if (removedAttrs || removedElements) {
        warnings.push(
            `Stage 8: removed ${removedAttrs} AI/Illustrator attribute(s)` +
            (removedElements ? ` and ${removedElements} element(s)` : '')
        );
    }

    return doc;
}
