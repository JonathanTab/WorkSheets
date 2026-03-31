/**
 * svg/serializer.js — converts an SvgDocument back to a well-formed SVG string.
 * Preserves all Inkscape namespaces, attributes, and metadata.
 */

import { NS } from './model.js';

// Elements that should be self-closing when they have no children and no textContent
const VOID_ELEMENTS = new Set([
    'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect',
    'image', 'use', 'stop', 'animate', 'animatetransform', 'animatemotion', 'set',
    'grid', 'guide', 'page',
]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * serializeDocument(doc) → string
 * Returns a complete SVG string including XML declaration and namespace declarations.
 */
export function serializeDocument(doc) {
    const lines = ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>'];
    lines.push(serializeNode(doc.root, doc.namespaces, 0, true));
    return lines.join('\n');
}

/**
 * serializeToElement(doc) → SVGSVGElement
 * Serializes the document and re-parses it to produce a live SVGSVGElement for mounting.
 * Sets overflow="visible" so shapes outside the viewBox remain visible during editing.
 */
export function serializeToElement(doc) {
    const str = serializeDocument(doc);
    const dom = new DOMParser().parseFromString(str, 'image/svg+xml');
    const el = dom.documentElement;
    if (el.tagName === 'parsererror') {
        throw new Error('Serializer produced invalid SVG: ' + el.textContent?.slice(0, 200));
    }
    el.setAttribute('overflow', 'visible');
    return el;
}

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Canonical namespace prefix order matching what Inkscape writes.
 * Prefixes not in this list are appended afterwards in insertion order.
 */
const NS_CANONICAL_ORDER = ['', 'dc', 'cc', 'rdf', 'svg', 'xlink', 'sodipodi', 'inkscape'];

/**
 * buildCanonicalNsDecls(nsMap) → string
 * Returns a space-prefixed string of xmlns declarations in Inkscape canonical order.
 */
function buildCanonicalNsDecls(nsMap) {
    let result = '';
    const emitted = new Set();

    // Emit in canonical order first
    for (const prefix of NS_CANONICAL_ORDER) {
        if (prefix in nsMap) {
            result += prefix === ''
                ? ` xmlns="${escapeAttr(nsMap[prefix])}"`
                : ` xmlns:${prefix}="${escapeAttr(nsMap[prefix])}"`;
            emitted.add(prefix);
        }
    }

    // Emit any remaining namespaces (not in canonical order)
    for (const [prefix, uri] of Object.entries(nsMap)) {
        if (!emitted.has(prefix)) {
            result += prefix === ''
                ? ` xmlns="${escapeAttr(uri)}"`
                : ` xmlns:${prefix}="${escapeAttr(uri)}"`;
        }
    }

    // Guarantee the default SVG namespace is always declared
    if (!emitted.has('') && !emitted.has('svg')) {
        result = ` xmlns="${NS.svg}"` + result;
    }

    return result;
}

/**
 * serializeNode(node, nsMap, depth, isRoot) → string
 */
function serializeNode(node, nsMap, depth, isRoot = false) {
    const indent = '  '.repeat(depth);
    const tag = node.type; // already prefixed e.g. "sodipodi:namedview"
    const localTag = tag.includes(':') ? tag.split(':')[1] : tag;
    const isVoid = VOID_ELEMENTS.has(localTag) && !node.children.length && !node.textContent;

    // Build attribute string
    let attrStr = '';

    // For the root <svg> element, inject namespace declarations in canonical Inkscape order
    if (isRoot) {
        const nsDecls = buildCanonicalNsDecls(nsMap);
        attrStr += nsDecls;
    }

    for (const [key, value] of Object.entries(node.attributes)) {
        // Skip xmlns declarations that belong in the root (already emitted above)
        if (isRoot && (key === 'xmlns' || key.startsWith('xmlns:'))) continue;
        if (!isRoot && (key === 'xmlns' || key.startsWith('xmlns:'))) continue;
        attrStr += ` ${key}="${escapeAttr(value)}"`;
    }

    if (isVoid) {
        return `${indent}<${tag}${attrStr} />`;
    }

    const open = `${indent}<${tag}${attrStr}>`;
    const close = `</${tag}>`;

    // No children, no textContent → compact closed tag
    if (!node.children.length && !node.textContent) {
        return `${open}${close}`;
    }

    // Has only text content (no element children) → inline
    if (!node.children.length && node.textContent != null) {
        return `${open}${escapeText(node.textContent)}${close}`;
    }

    // Has element children
    const childLines = [];
    if (node.textContent) {
        childLines.push(`${'  '.repeat(depth + 1)}${escapeText(node.textContent)}`);
    }
    for (const child of node.children) {
        childLines.push(serializeNode(child, nsMap, depth + 1));
    }

    return `${open}\n${childLines.join('\n')}\n${indent}${close}`;
}

function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeText(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
