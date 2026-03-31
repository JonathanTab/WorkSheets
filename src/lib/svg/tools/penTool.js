/**
 * penTool — Bézier pen for drawing paths.
 *
 * Interaction model (Inkscape-like):
 *   Click         → add a straight anchor point
 *   Click+drag    → add a smooth anchor point with pulled handles
 *   Click on first anchor (within snap radius) → close the path
 *   Enter / double-click → commit the path and switch to select
 *   Escape        → undo last point (or cancel if only one point)
 *
 * The in-progress path is shown via toolOverlayData { type: 'pen', ... }
 * so NodeEditorOverlay can render it. The path is NOT added to the document
 * model until committed.
 *
 * On commit: creates a <path> element and calls ctx.state.addElement(el).
 */

import { serializePath } from '../pathData.js';

const NS_SVG = 'http://www.w3.org/2000/svg';

// ── Module-level state ────────────────────────────────────────────────────────

/** @type {any[]} Segments built so far */
let _segments   = [];
/** @type {{x:number,y:number}|null} Current cursor position for preview line */
let _previewPt  = null;
/** @type {{x:number,y:number}|null} Point of the current pointer-down (for handle drag) */
let _downPt     = null;
/** Whether the user is currently dragging out a handle */
let _draggingHandle = false;
/** Whether we just received a dblclick (suppresses the preceding pointerdown commit) */
let _dblClickPending = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _reset(ctx) {
    _segments        = [];
    _previewPt       = null;
    _downPt          = null;
    _draggingHandle  = false;
    _dblClickPending = false;
    ctx.state.toolOverlayData = null;
}

function _pushOverlay(ctx) {
    ctx.state.toolOverlayData = {
        type:      'pen',
        segments:  _segments,
        previewPt: _previewPt,
    };
}

function _commit(ctx) {
    if (_segments.length < 2) {
        _reset(ctx);
        return;
    }
    const el = document.createElementNS(NS_SVG, 'path');
    el.setAttribute('d',            serializePath(_segments));
    el.setAttribute('fill',         'none');
    el.setAttribute('stroke',       ctx.state.defStroke);
    el.setAttribute('stroke-width', String(ctx.state.defStrokeW));
    const d = ctx.state.addElement(el);
    ctx.state.pushHistory();
    ctx.onChanged();
    // Switch to node editor for the newly created path
    if (d?.id) {
        ctx.state.activeTool = 'node';
        // nodeTool.onActivate will pick up the selection automatically
        ctx.state.selectId(d.id);
    }
    _reset(ctx);
}

function _closePath(ctx) {
    _segments = [..._segments, { type: 'Z' }];
    _commit(ctx);
}

/** Distance between two points */
function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

/** The close-path snap radius in SVG user units */
function _closeRadius(ctx) { return 8 / ctx.state.zoom; }

// ── Tool object ───────────────────────────────────────────────────────────────

export const penTool = {
    id:  'pen',
    cursor() { return 'crosshair'; },

    onActivate(ctx) {
        _reset(ctx);
    },

    onDeactivate(ctx) {
        // Commit whatever we have if enough points
        if (_segments.length >= 2) _commit(ctx);
        else _reset(ctx);
    },

    onPointerDown(ctx, pt, e) {
        if (_dblClickPending) {
            // This pointerdown is the second click of a dblclick — ignore it
            _dblClickPending = false;
            return;
        }

        _downPt = { ...pt };
        _draggingHandle = false;

        if (_segments.length === 0) {
            // Start a new path
            _segments = [{ type: 'M', x: pt.x, y: pt.y }];
        } else {
            // Check if clicking near the first anchor → close the path
            const first = _segments[0];
            if (dist(pt, { x: first.x, y: first.y }) < _closeRadius(ctx) && _segments.length > 2) {
                _closePath(ctx);
                return;
            }
            // Add a new anchor (straight line for now; may become C on drag)
            _segments = [..._segments, { type: 'L', x: pt.x, y: pt.y }];
        }

        _pushOverlay(ctx);
    },

    onPointerMove(ctx, pt, e) {
        _previewPt = { ...pt };

        if (_downPt && e.buttons === 1 && !_draggingHandle) {
            // User has pressed and is dragging: turn the last anchor into a smooth C node
            const d = dist(pt, _downPt);
            if (d > 3 / ctx.state.zoom) {
                _draggingHandle = true;
            }
        }

        if (_draggingHandle && _downPt && _segments.length >= 1) {
            const dx = pt.x - _downPt.x;
            const dy = pt.y - _downPt.y;
            const lastIdx = _segments.length - 1;
            const anchor  = _segments[lastIdx];
            // Replace the last segment with a C, where:
            //   x2,y2 = dragged out-handle (toward cursor)
            //   x1,y1 = reflected in-handle (symmetric for smooth node)
            const newLast = {
                type: 'C',
                x1: anchor.x - dx,  // in-handle (mirrored)
                y1: anchor.y - dy,
                x2: anchor.x + dx,  // out-handle (dragged)
                y2: anchor.y + dy,
                x:  anchor.x,
                y:  anchor.y,
            };
            _segments = [..._segments.slice(0, lastIdx), newLast];
        }

        _pushOverlay(ctx);
        ctx.tickOverlay();
    },

    onPointerUp(ctx, pt, e) {
        _downPt         = null;
        _draggingHandle = false;
    },

    onKeyDown(ctx, e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            _commit(ctx);
            ctx.state.activeTool = 'select';
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            if (_segments.length > 1) {
                // Undo last point
                _segments = _segments.slice(0, -1);
                _pushOverlay(ctx);
            } else {
                _reset(ctx);
                ctx.state.activeTool = 'select';
            }
        }
    },

    onDblClick(ctx, e) {
        // Double-click: the first click already added a point via pointerdown.
        // Remove the spurious point, commit, then mark the flag so the
        // browser's trailing pointerdown (fired after dblclick) is ignored.
        // NOTE: _commit() calls _reset() which would clear the flag, so we
        // must set _dblClickPending AFTER _commit.
        if (_segments.length > 1) {
            // Remove the point added by the second click of the dblclick
            _segments = _segments.slice(0, -1);
        }
        _commit(ctx);
        _dblClickPending = true;
        ctx.state.activeTool = 'select';
    },
};
