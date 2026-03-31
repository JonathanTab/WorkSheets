/**
 * svgEditorState — central store for SVG editor interaction state.
 *
 * Fully supports Inkscape SVG format:
 *   - inkscape:label used as element/layer names
 *   - inkscape:groupmode="layer" groups recognised as layers
 *   - sodipodi:namedview parsed for guides, grids, page settings
 *   - All namespaced data preserved through model-based serialisation
 *   - New documents written as valid Inkscape SVG with namedview + default layer
 *
 * Architecture: hybrid model + live DOM.
 *   - SvgDocument (plain JS objects) is the source of truth for load/save/undo.
 *   - A live SVGSVGElement is derived from the model for rendering and interaction.
 *   - Interactive edits (drag, resize) write directly to the live DOM for performance.
 *   - pushHistory() reconciles the DOM back into the model via _syncModelFromDom().
 */

import { parseSvgString } from '../../lib/svg/parser.js';
import { serializeDocument, serializeToElement } from '../../lib/svg/serializer.js';
import { normalizeSvgDocument } from '../../lib/svg/normalizer.js';
import {
    setNodeAttribute,
    updateNamedView as updateNamedViewMutation,
    setArtboardSize as setArtboardSizeMutation,
} from '../../lib/svg/mutations.js';
// model.js utilities are used indirectly via parser/serializer/mutations

// ── Namespaces ────────────────────────────────────────────────────────────────

const NS_SVG      = 'http://www.w3.org/2000/svg';
const NS_INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape';
const NS_SODIPODI = 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd';

// ── Unit conversion (96 DPI baseline) ────────────────────────────────────────

const UNIT_TO_PX = {
    px: 1, mm: 96 / 25.4, cm: 96 / 2.54,
    in: 96, pt: 96 / 72, pc: 96 / 6,
};

/** Parse a length string like "210mm", "8.5in", "600px", "600" → user units (px) */
function parseLength(str) {
    if (str == null || str === '') return 0;
    const m = String(str).match(/^([-\d.eE+]+)\s*(px|mm|cm|in|pt|pc)?$/);
    if (!m) return parseFloat(str) || 0;
    return parseFloat(m[1]) * (UNIT_TO_PX[m[2] || 'px'] || 1);
}

// ── ID generator ─────────────────────────────────────────────────────────────

const MAX_HISTORY = 60;
let _nextId = 1;
function uid() { return `s${_nextId++}`; }

// ── Shape descriptor helpers ──────────────────────────────────────────────────

const SUPPORTED_TAGS = new Set([
    'rect','ellipse','circle','line','text','path','image','g','polygon','polyline',
]);

function tagToType(tag) {
    if (tag === 'circle') return 'ellipse';
    if (SUPPORTED_TAGS.has(tag)) return tag === 'g' ? 'group' : tag;
    return 'unknown';
}

function makeDescriptor(el) {
    const tag = (el.tagName?.toLowerCase() ?? '').split(':').pop();
    const type = tagToType(tag);
    if (!el.hasAttribute('data-id')) el.setAttribute('data-id', uid());
    const id = el.getAttribute('data-id');
    // Prefer inkscape:label, then data-name, then auto-generate
    const name = el.getAttribute('inkscape:label')
              || el.getAttribute('data-name')
              || autoName(type, id);
    return {
        id, el, type, tag,
        name,
        locked:  el.getAttribute('data-locked') === 'true',
        visible: el.getAttribute('display') !== 'none',
    };
}

function autoName(type, id) {
    const map = {
        rect:'Rectangle', ellipse:'Ellipse', line:'Line',
        text:'Text', path:'Path', image:'Image',
        group:'Group', unknown:'Element',
        polygon:'Polygon', polyline:'Polyline',
    };
    return (map[type] ?? 'Element') + ' ' + id.slice(1);
}

// ── Bbox / transform helpers ──────────────────────────────────────────────────

function getBBox(el) {
    try {
        const b = el.getBBox();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
    } catch {
        return { x: 0, y: 0, w: 0, h: 0 };
    }
}

function getTranslate(el) {
    const t = el.getAttribute('transform') || '';
    const m = t.match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/);
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

function setTranslate(el, tx, ty) {
    const t = el.getAttribute('transform') || '';
    const replaced = t.replace(/translate\([^)]*\)/, '').trim();
    const prefix = (tx !== 0 || ty !== 0) ? `translate(${round(tx)},${round(ty)})` : '';
    const final = [prefix, replaced].filter(Boolean).join(' ');
    if (final) el.setAttribute('transform', final);
    else el.removeAttribute('transform');
}

function round(n) { return Math.round(n * 100) / 100; }

// ── Tags to skip when building interactive shapes list ────────────────────────

const SKIP_TAGS = new Set([
    'defs','style','title','desc','metadata',
    'lineargradient','radialgradient','pattern',
    'filter','clippath','mask','marker','symbol',
    'fegaussianblur','feblend','fecolormatrix','fecomponenttransfer',
    'fecomposite','feconvolvematrix','fediffuselighting','fedisplacementmap',
    'feflood','fefunca','fefuncb','fefuncg','fefuncr','feimage','femerge',
    'femergenode','femorphology','feoffset','fespecularlighting','fetile',
    'feturbulence','script','animate','animatetransform','animatemotion',
    'set','mpath','stop','use','view',
    // Inkscape/Sodipodi metadata elements
    'namedview','guide','grid','page',
    // Inkscape flowtext (non-standard, treated as opaque)
    'flowroot','flowregion','flowpara','flowi','flowspan',
]);

// ── Walk SVG children to build descriptor list ────────────────────────────────
// Recognises inkscape:groupmode="layer" groups and recurses into them.

function walkChildren(parent, layerIdx, layersOut, shapesOut) {
    for (const el of Array.from(parent.children)) {
        const tag = (el.tagName?.toLowerCase() ?? '').split(':').pop();
        if (SKIP_TAGS.has(tag)) continue;

        // Layer group?
        if (el.getAttribute('inkscape:groupmode') === 'layer') {
            const lid = el.getAttribute('id') || uid();
            const lname = el.getAttribute('inkscape:label') || lid;
            const lIdx = layersOut.length;
            layersOut.push({
                id: lid, el, name: lname, lIdx,
                visible: el.getAttribute('display') !== 'none',
                locked: el.getAttribute('data-locked') === 'true',
            });
            walkChildren(el, lIdx, layersOut, shapesOut);
        } else {
            const d = makeDescriptor(el);
            d.layer = layerIdx;
            shapesOut.push(d);
        }
    }
}

// ── Inkscape SVG template for new documents ───────────────────────────────────

function createInkscapeSvg(w = 800, h = 600) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   width="${w}"
   height="${h}"
   viewBox="0 0 ${w} ${h}"
   version="1.1"
   id="svg0">
  <sodipodi:namedview
     pagecolor="#ffffff"
     bordercolor="#666666"
     borderopacity="1.0"
     inkscape:document-units="px"
     showgrid="false"
     inkscape:current-layer="layer1"
     id="namedview0" />
  <defs id="defs0" />
  <g
     inkscape:groupmode="layer"
     inkscape:label="Layer 1"
     id="layer1" />
</svg>`;
}

const EMPTY_SVG = createInkscapeSvg(800, 600);

// ── Main editor state class ───────────────────────────────────────────────────

class SvgEditorState {
    // View state
    zoom = $state(1);
    panX = $state(0);
    panY = $state(0);

    // Tool
    activeTool = $state('select');

    // Document
    /** @type {SVGSVGElement|null} */ svgEl = $state(null);
    artboardW = $state(800);
    artboardH = $state(600);

    // Shapes index (flat; shapes inside layers included)
    shapes = $state(/** @type {any[]} */ ([]));

    // Layers (inkscape:groupmode="layer" groups)
    layers = $state(/** @type {any[]} */ ([]));

    // Active layer ID (new shapes go here)
    activeLayerId = $state(/** @type {string|null} */ (null));

    // Selection
    selectedIds = $state(/** @type {Set<string>} */ (new Set()));

    // Inkscape namedview data
    guides     = $state(/** @type {any[]} */ ([]));
    grid       = $state(/** @type {any|null} */ (null));
    pageColor  = $state('#ffffff');
    docUnits   = $state('px');
    showGuides = $state(true);

    /** @type {Element|null} */ _namedview = null;

    // Internal document model (source of truth for load/save/undo)
    /** @type {import('../../lib/svg/model.js').SvgDocument|null} */ svgDocument = $state(null);

    // History / clipboard
    _history = [];
    _histIdx = -1;
    _clipboard = [];

    // Draw defaults
    defFill       = $state('#4f8ef7');
    defStroke     = $state('#1a1a1a');
    defStrokeW    = $state(2);
    defFontSize   = $state(18);
    defFontFamily = $state('sans-serif');

    // Options
    clipToArtboard = $state(false);
    showGrid       = $state(false);

    // Tool overlay data (used by node editor, gradient handles, etc. in Phase 3+)
    toolOverlayData = $state(null);

    // Normalization warnings from the last loadFromString() call (empty for new documents)
    normalizationWarnings = $state([]);

    // Cursor coordinates (updated by canvas on pointermove for status bar)
    cursorX = $state(0);
    cursorY = $state(0);

    // ── Load ──────────────────────────────────────────────────────────────────

    loadFromString(svgString, { normalize = true } = {}) {
        let doc;
        try {
            doc = parseSvgString(svgString || EMPTY_SVG);
        } catch (e) {
            console.error('[svgEditorState] SVG parse error', e);
            doc = parseSvgString(EMPTY_SVG);
        }

        if (normalize) {
            try {
                const result = normalizeSvgDocument(doc);
                doc = result.doc;
                this.normalizationWarnings = result.warnings;
                if (result.warnings.length) {
                    console.info('[svgEditorState] normalization:', result.warnings);
                }
            } catch (e) {
                console.warn('[svgEditorState] normalization failed, using raw doc', e);
                this.normalizationWarnings = [];
            }
        } else {
            this.normalizationWarnings = [];
        }

        this.svgDocument = doc;
        const root = serializeToElement(doc);
        this.svgEl = root;
        this.selectedIds = new Set();
        this._applyDocToState(doc);
        this._history = [serializeDocument(doc)];
        this._histIdx = 0;
    }

    // ── Apply document model to editor state ─────────────────────────────────

    _applyDocToState(doc) {
        // Artboard dimensions — viewBox takes priority
        const rootAttrs = doc.root.attributes;
        const vb = rootAttrs['viewBox'];
        if (vb) {
            const parts = vb.trim().split(/[\s,]+/).map(Number);
            if (parts.length === 4) {
                this.artboardW = parts[2];
                this.artboardH = parts[3];
            }
        } else {
            this.artboardW = parseLength(rootAttrs['width']  || '800') || 800;
            this.artboardH = parseLength(rootAttrs['height'] || '600') || 600;
        }

        // Grab live DOM namedview reference (for DOM-direct operations like addGuide/addLayer)
        const nvList = this.svgEl?.getElementsByTagNameNS(NS_SODIPODI, 'namedview');
        this._namedview = nvList?.length > 0 ? nvList[0] : null;

        const nv = doc.namedview;
        if (!nv) {
            this.guides    = [];
            this.grid      = null;
            this.docUnits  = 'px';
            this.pageColor = '#ffffff';
            this._rebuildShapes();
            return;
        }

        const nvAttrs = nv.attributes;
        this.docUnits  = nvAttrs['inkscape:document-units'] || 'px';
        const rawPageColor = nvAttrs['pagecolor'] || '#ffffff';
        // Treat 'none' / 'transparent' as white — an invisible artboard would look
        // like a black canvas and confuse users.
        this.pageColor = (rawPageColor === 'none' || rawPageColor === 'transparent')
            ? '#ffffff'
            : rawPageColor;

        const sgAttr = nvAttrs['showgrid'];
        if (sgAttr != null) this.showGrid = sgAttr === 'true';

        const curLayer = nvAttrs['inkscape:current-layer'];
        if (curLayer) this.activeLayerId = curLayer;

        // Parse guides from model namedview children
        const guideNodes = nv.children.filter(n => n.type === 'sodipodi:guide' || n.type === 'guide');
        const guideEls   = this._namedview
            ? Array.from(this._namedview.getElementsByTagNameNS(NS_SODIPODI, 'guide'))
            : [];
        const guides = [];
        guideNodes.forEach((gn, i) => {
            const a = gn.attributes;
            const pos    = a['position']    || '0,0';
            const orient = a['orientation'] || '0,1';
            const [px, py] = pos.split(',').map(Number);
            const [dx, dy] = orient.split(',').map(Number);
            guides.push({
                id:    a['id'] || uid(),
                x:     px || 0,
                y:     py || 0,
                dx:    dx || 0,
                dy:    dy || 1,
                label: a['inkscape:label'] || '',
                el:    guideEls[i] ?? null,
            });
        });
        this.guides = guides;

        // Parse grid from model (doc.grids)
        const gridNode = doc.grids[0] ?? null;
        if (gridNode) {
            const ga = gridNode.attributes;
            const gUnits = ga['units'] || 'px';
            const toGridPx = UNIT_TO_PX[gUnits] || 1;
            // Also grab live DOM grid element for DOM-direct setGridSpacing
            const gridEls = this._namedview
                ? Array.from(this._namedview.getElementsByTagNameNS(NS_INKSCAPE, 'grid'))
                : [];
            this.grid = {
                el:       gridEls[0] ?? null,
                nodeId:   gridNode.id,
                type:     ga['type']     || 'xygrid',
                spacingx: (parseFloat(ga['spacingx'] || '10')) * toGridPx,
                spacingy: (parseFloat(ga['spacingy'] || '10')) * toGridPx,
                originx:  (parseFloat(ga['originx']  || '0'))  * toGridPx,
                originy:  (parseFloat(ga['originy']  || '0'))  * toGridPx,
                visible:  ga['visible'] !== 'false',
                enabled:  ga['enabled'] !== 'false',
            };
            if (this.grid.visible) this.showGrid = true;
        } else {
            this.grid = null;
        }

        this._rebuildShapes();
    }

    // ── Namedview write-back (called before model serialisation) ─────────────

    _updateNamedViewInModel() {
        if (!this.svgDocument) return;
        const updates = {
            'inkscape:zoom': String(round(this.zoom)),
            showgrid: this.showGrid ? 'true' : 'false',
        };
        if (this.activeLayerId) {
            updates['inkscape:current-layer'] = this.activeLayerId;
        }
        if (this.svgDocument.grids.length > 0) {
            const gridId = this.svgDocument.grids[0].id;
            this.svgDocument = setNodeAttribute(
                this.svgDocument, gridId, 'visible', this.showGrid ? 'true' : 'false'
            );
        }
        this.svgDocument = updateNamedViewMutation(this.svgDocument, updates);
    }

    // ── Ensure namedview exists (DOM + model) ─────────────────────────────────

    _ensureNamedView() {
        // Ensure in model
        if (this.svgDocument && !this.svgDocument.namedview) {
            this.svgDocument = updateNamedViewMutation(this.svgDocument, {
                id: 'namedview0',
                pagecolor: '#ffffff',
                'inkscape:document-units': 'px',
                showgrid: 'false',
            });
        }
        // Ensure live DOM ref
        if (!this._namedview && this.svgEl) {
            const nvList = this.svgEl.getElementsByTagNameNS(NS_SODIPODI, 'namedview');
            if (nvList.length > 0) {
                this._namedview = nvList[0];
            } else {
                const nv = document.createElementNS(NS_SODIPODI, 'namedview');
                nv.setAttribute('id', 'namedview0');
                nv.setAttribute('pagecolor', '#ffffff');
                nv.setAttribute('inkscape:document-units', 'px');
                nv.setAttribute('showgrid', 'false');
                this.svgEl.insertBefore(nv, this.svgEl.firstChild);
                this._namedview = nv;
            }
        }
    }

    // ── Serialise ─────────────────────────────────────────────────────────────

    getSvgString() {
        if (!this.svgDocument) return EMPTY_SVG;
        this._syncModelFromDom();
        this._updateNamedViewInModel();
        return serializeDocument(this.svgDocument);
    }

    // ── Rebuild shapes index from live DOM ────────────────────────────────────

    _rebuildShapes() { this._rebuildShapesFromDom(); }

    _rebuildShapesFromDom() {
        if (!this.svgEl) { this.shapes = []; this.layers = []; return; }
        const shapesOut = [];
        const layersOut = [];
        walkChildren(this.svgEl, -1, layersOut, shapesOut);
        this.layers = layersOut;
        this.shapes = shapesOut;

        // If we found layers but activeLayerId isn't set, pick last (topmost)
        if (layersOut.length > 0 && !this.activeLayerId) {
            this.activeLayerId = layersOut[layersOut.length - 1].id;
        }
    }

    // ── History ───────────────────────────────────────────────────────────────

    pushHistory() {
        if (!this.svgEl) return;
        this._syncModelFromDom();
        const snap = serializeDocument(this.svgDocument);
        this._history = this._history.slice(0, this._histIdx + 1);
        this._history.push(snap);
        if (this._history.length > MAX_HISTORY) this._history.shift();
        this._histIdx = this._history.length - 1;
    }

    undo() {
        if (this._histIdx <= 0) return;
        this._histIdx--;
        this._restoreSnapshot(this._history[this._histIdx]);
    }

    redo() {
        if (this._histIdx >= this._history.length - 1) return;
        this._histIdx++;
        this._restoreSnapshot(this._history[this._histIdx]);
    }

    _restoreSnapshot(snap) {
        let doc;
        try { doc = parseSvgString(snap); }
        catch (e) { console.error('[svgEditorState] snapshot restore failed', e); return; }

        this.svgDocument = doc;
        const root = serializeToElement(doc);
        if (this.svgEl?.parentElement) {
            this.svgEl.parentElement.replaceChild(root, this.svgEl);
        }
        this.svgEl = root;
        this.selectedIds = new Set();
        this._applyDocToState(doc);
    }

    // ── Selection ─────────────────────────────────────────────────────────────

    selectId(id, additive = false) {
        if (additive) {
            const next = new Set(this.selectedIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            this.selectedIds = next;
        } else {
            this.selectedIds = new Set([id]);
        }
    }

    selectIds(ids) { this.selectedIds = new Set(ids); }
    clearSelection() { this.selectedIds = new Set(); }
    selectAll() { this.selectedIds = new Set(this.shapes.map(s => s.id)); }

    get selectedShapes() {
        return this.shapes.filter(s => this.selectedIds.has(s.id));
    }

    get firstSelected() {
        return this.shapes.find(s => this.selectedIds.has(s.id)) ?? null;
    }

    // ── Shape mutation ────────────────────────────────────────────────────────

    addElement(el) {
        if (!this.svgEl) return null;
        if (!el.hasAttribute('data-id')) el.setAttribute('data-id', uid());

        // Append to active layer, or root SVG if no layers
        let parent = this.svgEl;
        let layerIdx = -1;
        if (this.activeLayerId && this.layers.length > 0) {
            const layer = this.layers.find(l => l.id === this.activeLayerId);
            if (layer) { parent = layer.el; layerIdx = layer.lIdx; }
        }

        parent.appendChild(el);
        const d = makeDescriptor(el);
        d.layer = layerIdx;
        this.shapes = [...this.shapes, d];
        return d;
    }

    deleteSelected() {
        if (this.selectedIds.size === 0) return;
        this.pushHistory();
        for (const s of this.selectedShapes) {
            if (s.locked) continue;
            s.el.parentNode?.removeChild(s.el);
        }
        this.shapes = this.shapes.filter(s => !this.selectedIds.has(s.id) || s.locked);
        this.selectedIds = new Set();
    }

    updateAttr(id, attr, value) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return;
        if (value === null || value === '') s.el.removeAttribute(attr);
        else s.el.setAttribute(attr, String(value));
    }

    moveSelected(dx, dy) {
        for (const s of this.selectedShapes) {
            if (s.locked) continue;
            const cur = getTranslate(s.el);
            setTranslate(s.el, cur.x + dx, cur.y + dy);
        }
    }

    // ── Z-order ───────────────────────────────────────────────────────────────

    bringForward(id) {
        const s = this.shapes.find(s => s.id === id);
        if (!s || !s.el.nextElementSibling) return;
        this.pushHistory();
        s.el.parentNode.insertBefore(s.el.nextElementSibling, s.el);
        this._rebuildShapes();
    }

    sendBackward(id) {
        const s = this.shapes.find(s => s.id === id);
        if (!s || !s.el.previousElementSibling) return;
        this.pushHistory();
        s.el.parentNode.insertBefore(s.el, s.el.previousElementSibling);
        this._rebuildShapes();
    }

    bringToFront(id) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return;
        this.pushHistory();
        s.el.parentNode.appendChild(s.el);
        this._rebuildShapes();
    }

    sendToBack(id) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return;
        this.pushHistory();
        s.el.parentNode.insertBefore(s.el, s.el.parentNode.firstElementChild);
        this._rebuildShapes();
    }

    // ── Clipboard ─────────────────────────────────────────────────────────────

    static _FRAG_OPEN  = '<svg-fragment xmlns="http://www.w3.org/2000/svg">';
    static _FRAG_CLOSE = '</svg-fragment>';

    async copySelected() {
        const shapes = this.selectedShapes;
        if (!shapes.length) return;
        const html = shapes.map(s => s.el.outerHTML).join('\n');
        const text = SvgEditorState._FRAG_OPEN + '\n' + html + '\n' + SvgEditorState._FRAG_CLOSE;
        this._clipboard = shapes.map(s => s.el.outerHTML);
        try { await navigator.clipboard.writeText(text); } catch { /* fallback to internal */ }
    }

    async pasteClipboard() {
        if (!this.svgEl) return;
        let htmlFragments = this._clipboard;
        try {
            const text = await navigator.clipboard.readText();
            if (text.includes('<svg-fragment')) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, 'text/xml');
                const frag = doc.documentElement;
                if (frag && !frag.querySelector('parsererror')) {
                    htmlFragments = Array.from(frag.children).map(el => el.outerHTML);
                }
            }
        } catch { /* use internal fallback */ }
        if (!htmlFragments.length) return;
        this.pushHistory();
        const newIds = [];
        const ns = NS_SVG;
        for (const html of htmlFragments) {
            const tmp = document.createElementNS(ns, 'g');
            tmp.innerHTML = html;
            const el = tmp.firstElementChild;
            if (!el) continue;
            const cur = getTranslate(el);
            setTranslate(el, cur.x + 16, cur.y + 16);
            el.setAttribute('data-id', uid());
            // Paste into active layer or root
            let parent = this.svgEl;
            let layerIdx = -1;
            if (this.activeLayerId && this.layers.length > 0) {
                const layer = this.layers.find(l => l.id === this.activeLayerId);
                if (layer) { parent = layer.el; layerIdx = layer.lIdx; }
            }
            parent.appendChild(el);
            const d = makeDescriptor(el);
            d.layer = layerIdx;
            this.shapes = [...this.shapes, d];
            newIds.push(d.id);
        }
        this.selectedIds = new Set(newIds);
    }

    async cutSelected() {
        await this.copySelected();
        this.deleteSelected();
    }

    // ── Align ─────────────────────────────────────────────────────────────────

    alignSelected(type) {
        const sel = this.selectedShapes.filter(s => !s.locked);
        if (sel.length < 1) return;
        this.pushHistory();

        const boxes = sel.map(s => {
            const b = getBBox(s.el), t = getTranslate(s.el);
            return { s, b, t, vx: b.x + t.x, vy: b.y + t.y };
        });
        const minX = Math.min(...boxes.map(b => b.vx));
        const minY = Math.min(...boxes.map(b => b.vy));
        const maxX = Math.max(...boxes.map(b => b.vx + b.b.w));
        const maxY = Math.max(...boxes.map(b => b.vy + b.b.h));
        const cX = (minX + maxX) / 2;
        const cY = (minY + maxY) / 2;

        for (const { s, b, t, vx, vy } of boxes) {
            let dx = 0, dy = 0;
            switch (type) {
                case 'left':    dx = minX - vx; break;
                case 'centerH': dx = cX - (vx + b.w / 2); break;
                case 'right':   dx = maxX - (vx + b.w); break;
                case 'top':     dy = minY - vy; break;
                case 'centerV': dy = cY - (vy + b.h / 2); break;
                case 'bottom':  dy = maxY - (vy + b.h); break;
            }
            setTranslate(s.el, t.x + dx, t.y + dy);
        }
    }

    distributeSelected(dir) {
        const sel = this.selectedShapes.filter(s => !s.locked);
        if (sel.length < 3) return;
        this.pushHistory();

        const boxes = sel.map(s => {
            const b = getBBox(s.el), t = getTranslate(s.el);
            return { s, b, t, vx: b.x + t.x, vy: b.y + t.y };
        });
        if (dir === 'h') {
            boxes.sort((a, b) => a.vx - b.vx);
            const span = boxes[boxes.length - 1].vx - boxes[0].vx;
            const step = span / (boxes.length - 1);
            const startX = boxes[0].vx;
            boxes.forEach(({ s, t, vx }, i) => {
                setTranslate(s.el, t.x + (startX + i * step) - vx, t.y);
            });
        } else {
            boxes.sort((a, b) => a.vy - b.vy);
            const span = boxes[boxes.length - 1].vy - boxes[0].vy;
            const step = span / (boxes.length - 1);
            const startY = boxes[0].vy;
            boxes.forEach(({ s, t, vy }, i) => {
                setTranslate(s.el, t.x, t.y + (startY + i * step) - vy);
            });
        }
    }

    // ── Position / Size / Rotation ───────────────────────────────────────────

    getVisualBBox(id) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return null;
        const b = getBBox(s.el);
        const t = getTranslate(s.el);
        return { x: round(b.x + t.x), y: round(b.y + t.y), w: round(b.w), h: round(b.h) };
    }

    setPosition(id, x, y) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return;
        const b = getBBox(s.el);
        setTranslate(s.el, x - b.x, y - b.y);
    }

    setSize(id, w, h) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return;
        const el = s.el;
        switch (s.type) {
            case 'rect':
            case 'image':
                el.setAttribute('width',  round(w));
                el.setAttribute('height', round(h));
                break;
            case 'ellipse':
                el.setAttribute('rx', round(w / 2));
                el.setAttribute('ry', round(h / 2));
                break;
        }
    }

    getRotation(id) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return 0;
        const t = s.el.getAttribute('transform') || '';
        const m = t.match(/rotate\(\s*([-\d.]+)/);
        return m ? parseFloat(m[1]) : 0;
    }

    setRotation(id, deg) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return;
        // Use inkscape:transform-center-x/y if present, else element bbox center
        const tcx = parseFloat(s.el.getAttribute('inkscape:transform-center-x') || '');
        const tcy = parseFloat(s.el.getAttribute('inkscape:transform-center-y') || '');
        let cx, cy;
        if (!isNaN(tcx) && !isNaN(tcy)) {
            const b = getBBox(s.el);
            cx = round(b.x + b.w / 2 + tcx);
            cy = round(b.y + b.h / 2 + tcy);
        } else {
            const b = getBBox(s.el);
            cx = round(b.x + b.w / 2);
            cy = round(b.y + b.h / 2);
        }
        const t = s.el.getAttribute('transform') || '';
        const noRot = t.replace(/rotate\([^)]*\)/g, '').trim();
        const rot = deg !== 0 ? `rotate(${round(deg)},${cx},${cy})` : '';
        const final = [noRot, rot].filter(Boolean).join(' ');
        if (final) s.el.setAttribute('transform', final);
        else s.el.removeAttribute('transform');
        // Write back rotation center offset for Inkscape compatibility
        if (deg !== 0) {
            const b = getBBox(s.el);
            s.el.setAttribute('inkscape:transform-center-x', round(cx - (b.x + b.w / 2)));
            s.el.setAttribute('inkscape:transform-center-y', round(cy - (b.y + b.h / 2)));
        } else {
            s.el.removeAttribute('inkscape:transform-center-x');
            s.el.removeAttribute('inkscape:transform-center-y');
        }
    }

    // ── Lock / visibility ─────────────────────────────────────────────────────

    setLocked(id, locked) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return;
        s.locked = locked;
        if (locked) s.el.setAttribute('data-locked', 'true');
        else s.el.removeAttribute('data-locked');
        this.shapes = [...this.shapes];
    }

    setVisible(id, visible) {
        const s = this.shapes.find(s => s.id === id);
        if (!s) return;
        s.visible = visible;
        if (visible) s.el.removeAttribute('display');
        else s.el.setAttribute('display', 'none');
        this.shapes = [...this.shapes];
    }

    setName(id, name) {
        // Check if it's a shape or a layer
        const s = this.shapes.find(s => s.id === id);
        if (s) {
            s.name = name;
            s.el.setAttribute('data-name', name);
            s.el.setAttribute('inkscape:label', name);
            this.shapes = [...this.shapes];
            return;
        }
        const l = this.layers.find(l => l.id === id);
        if (l) {
            l.name = name;
            l.el.setAttribute('inkscape:label', name);
            this.layers = [...this.layers];
        }
    }

    // ── Layer management ──────────────────────────────────────────────────────

    addLayer(name) {
        if (!this.svgEl) return;
        this._ensureNamedView();
        const g = document.createElementNS(NS_SVG, 'g');
        const id = 'layer_' + uid();
        g.setAttribute('id', id);
        g.setAttribute('inkscape:groupmode', 'layer');
        g.setAttribute('inkscape:label', name || `Layer ${this.layers.length + 1}`);
        this.svgEl.appendChild(g);
        this._rebuildShapes();
        this.activeLayerId = id;
        if (this._namedview) this._namedview.setAttribute('inkscape:current-layer', id);
        this.pushHistory();
    }

    setActiveLayer(id) {
        if (this.layers.find(l => l.id === id)) {
            this.activeLayerId = id;
            if (this._namedview) this._namedview.setAttribute('inkscape:current-layer', id);
        }
    }

    setLayerVisible(id, visible) {
        const l = this.layers.find(l => l.id === id);
        if (!l) return;
        l.visible = visible;
        if (visible) l.el.removeAttribute('display');
        else l.el.setAttribute('display', 'none');
        this.layers = [...this.layers];
    }

    setLayerLocked(id, locked) {
        const l = this.layers.find(l => l.id === id);
        if (!l) return;
        l.locked = locked;
        if (locked) l.el.setAttribute('data-locked', 'true');
        else l.el.removeAttribute('data-locked');
        this.layers = [...this.layers];
        // Also update shapes in this layer
        this.shapes = this.shapes.map(s => {
            if (s.layer === l.lIdx) { s.locked = locked; }
            return s;
        });
    }

    deleteLayer(id) {
        const l = this.layers.find(l => l.id === id);
        if (!l || this.layers.length <= 1) return; // don't delete last layer
        this.pushHistory();
        l.el.parentNode?.removeChild(l.el);
        this._rebuildShapes();
        if (this.activeLayerId === id) {
            this.activeLayerId = this.layers[0]?.id ?? null;
        }
    }

    // ── Guide management ──────────────────────────────────────────────────────

    addGuide(x, y, horizontal = true) {
        if (!this.svgEl) return;
        this._ensureNamedView();
        const g = document.createElementNS(NS_SODIPODI, 'guide');
        const id = 'guide_' + uid();
        g.setAttribute('id', id);
        g.setAttribute('position', `${round(x)},${round(y)}`);
        g.setAttribute('orientation', horizontal ? '0,1' : '1,0');
        this._namedview.appendChild(g);
        const guide = { id, x, y, dx: horizontal ? 0 : 1, dy: horizontal ? 1 : 0, label: '', el: g };
        this.guides = [...this.guides, guide];
    }

    removeGuide(id) {
        const g = this.guides.find(g => g.id === id);
        if (g?.el) g.el.parentNode?.removeChild(g.el);
        this.guides = this.guides.filter(g => g.id !== id);
    }

    // ── Grid management ───────────────────────────────────────────────────────

    setGridSpacing(spacingx, spacingy) {
        if (!this.grid) {
            // Create grid element
            this._ensureNamedView();
            const ge = document.createElementNS(NS_INKSCAPE, 'grid');
            ge.setAttribute('type', 'xygrid');
            ge.setAttribute('units', 'px');
            ge.setAttribute('spacingx', spacingx);
            ge.setAttribute('spacingy', spacingy);
            ge.setAttribute('originx', '0');
            ge.setAttribute('originy', '0');
            ge.setAttribute('visible', 'true');
            ge.setAttribute('enabled', 'true');
            this._namedview.appendChild(ge);
            this.grid = { el: ge, type: 'xygrid', spacingx, spacingy, originx: 0, originy: 0, visible: true, enabled: true };
        } else {
            this.grid.spacingx = spacingx;
            this.grid.spacingy = spacingy;
            this.grid.el?.setAttribute('spacingx', spacingx);
            this.grid.el?.setAttribute('spacingy', spacingy);
            this.grid = { ...this.grid };
        }
    }

    // ── Model / DOM sync ──────────────────────────────────────────────────────

    /**
     * _syncModelFromDom() — reconciles the internal model from the live DOM.
     * Called at every pushHistory() to catch direct DOM edits (drag, resize, draw).
     */
    _syncModelFromDom() {
        if (!this.svgEl) return;
        try {
            const str = new XMLSerializer().serializeToString(this.svgEl);
            this.svgDocument = parseSvgString(str);
        } catch (e) {
            console.warn('[svgEditorState] model sync failed', e);
        }
    }

    /**
     * _remountDom() — rebuilds the live SVGSVGElement from the current model.
     * Called when document-level changes (artboard size, page color) require a full DOM rebuild.
     */
    _remountDom() {
        if (!this.svgDocument) return;
        const root = serializeToElement(this.svgDocument);
        if (this.svgEl?.parentElement) {
            this.svgEl.parentElement.replaceChild(root, this.svgEl);
        }
        this.svgEl = root;
        this.selectedIds = new Set();
        // Re-acquire live _namedview ref
        const nvList = root.getElementsByTagNameNS(NS_SODIPODI, 'namedview');
        this._namedview = nvList.length > 0 ? nvList[0] : null;
        this._rebuildShapesFromDom();
    }

    // ── Document properties ───────────────────────────────────────────────────

    setArtboardSize(w, h) {
        if (!this.svgDocument) return;
        this._syncModelFromDom();
        this.svgDocument = setArtboardSizeMutation(this.svgDocument, w, h);
        this.artboardW = w;
        this.artboardH = h;
        this._remountDom();
        this.pushHistory();
    }

    setPageColor(color) {
        this.pageColor = color;
        if (!this.svgDocument) return;
        this.svgDocument = updateNamedViewMutation(this.svgDocument, { pagecolor: color });
        // Update live DOM namedview directly too
        if (this._namedview) this._namedview.setAttribute('pagecolor', color);
    }

    setDocUnits(units) {
        this.docUnits = units;
        if (!this.svgDocument) return;
        this.svgDocument = updateNamedViewMutation(this.svgDocument, { 'inkscape:document-units': units });
        if (this._namedview) this._namedview.setAttribute('inkscape:document-units', units);
    }

    // ── Attribute editor ──────────────────────────────────────────────────────

    /**
     * getNodeAttributes(id) → Record<string, string>
     * Returns all attributes of the model node with the given data-id.
     */
    getNodeAttributes(shapeId) {
        const node = this._findModelNodeByDataId(shapeId);
        return node ? { ...node.attributes } : {};
    }

    _findModelNodeByDataId(dataId) {
        if (!this.svgDocument) return null;
        const queue = [this.svgDocument.root];
        while (queue.length) {
            const n = queue.shift();
            if (n.attributes['data-id'] === dataId) return n;
            queue.push(...n.children);
        }
        return null;
    }

    /**
     * setNodeAttributeRaw(shapeId, key, value) — sets an attribute both in the model
     * and on the live DOM element for immediate visual feedback.
     * value=null removes the attribute.
     */
    setNodeAttributeRaw(shapeId, key, value) {
        // Update live DOM element immediately
        const s = this.shapes.find(s => s.id === shapeId);
        if (s?.el) {
            if (value === null || value === undefined) s.el.removeAttribute(key);
            else s.el.setAttribute(key, String(value));
            // Reflect name change in shapes index
            if (key === 'inkscape:label' || key === 'data-name') {
                s.name = value ?? autoName(s.type, s.id);
                this.shapes = [...this.shapes];
            }
        }
        // Also update model (will be reconciled at next pushHistory anyway, but keep in sync)
        const node = this._findModelNodeByDataId(shapeId);
        if (node && this.svgDocument) {
            this.svgDocument = setNodeAttribute(this.svgDocument, node.id, key, value ?? null);
        }
    }

    // ── Group / Ungroup ───────────────────────────────────────────────────────

    groupSelected() {
        const sel = this.selectedShapes.filter(s => !s.locked);
        if (sel.length < 2) return;

        const g = document.createElementNS(NS_SVG, 'g');
        const gid = uid();
        g.setAttribute('data-id', gid);
        g.setAttribute('inkscape:label', `Group ${gid}`);
        // Insert before the first selected element in its parent
        const firstEl = sel[0].el;
        firstEl.parentNode.insertBefore(g, firstEl);
        for (const s of sel) g.appendChild(s.el);

        this._rebuildShapesFromDom();
        this.selectId(gid);
        this.pushHistory();
    }

    ungroupSelected() {
        const sel = this.selectedShapes.filter(s => s.type === 'group' && !s.locked);
        if (!sel.length) return;

        const newIds = [];
        for (const s of sel) {
            const parent = s.el.parentNode;
            const children = Array.from(s.el.children);
            for (const child of children) {
                parent.insertBefore(child, s.el);
                if (!child.hasAttribute('data-id')) child.setAttribute('data-id', uid());
                newIds.push(child.getAttribute('data-id'));
            }
            parent.removeChild(s.el);
        }

        this._rebuildShapesFromDom();
        this.selectIds(newIds);
        this.pushHistory();
    }

    // ── Layer reorder ─────────────────────────────────────────────────────────

    reorderLayer(draggedId, beforeId) {
        if (!this.svgDocument || !this.svgEl) return;
        this._syncModelFromDom();

        // Find the two layer DOM elements and reorder in live DOM
        const draggedLayer = this.layers.find(l => l.id === draggedId);
        const beforeLayer  = beforeId ? this.layers.find(l => l.id === beforeId) : null;
        if (!draggedLayer) return;

        const parent = draggedLayer.el.parentNode;
        if (!parent) return;
        parent.removeChild(draggedLayer.el);
        if (beforeLayer?.el && beforeLayer.el.parentNode === parent) {
            parent.insertBefore(draggedLayer.el, beforeLayer.el);
        } else {
            parent.appendChild(draggedLayer.el);
        }

        this._syncModelFromDom();
        this._rebuildShapesFromDom();
        this.pushHistory();
    }

    // ── Zoom helpers ──────────────────────────────────────────────────────────

    setZoom(z, originX = 0, originY = 0) {
        const clamped = Math.min(8, Math.max(0.05, z));
        const scale = clamped / this.zoom;
        this.panX = originX - scale * (originX - this.panX);
        this.panY = originY - scale * (originY - this.panY);
        this.zoom = clamped;
    }

    fitToView(containerW, containerH) {
        const pad = 48;
        const scaleX = (containerW - pad * 2) / this.artboardW;
        const scaleY = (containerH - pad * 2) / this.artboardH;
        const z = Math.min(scaleX, scaleY, 2);
        this.zoom = z;
        this.panX = (containerW - this.artboardW * z) / 2;
        this.panY = (containerH - this.artboardH * z) / 2;
    }
}

export const svgEditorState = new SvgEditorState();
export { getBBox, getTranslate, setTranslate, round, uid, makeDescriptor, parseLength };
