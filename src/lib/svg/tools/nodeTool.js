/**
 * nodeTool — node/path editor.
 *
 * Enter this tool by pressing N or double-clicking a path with the select tool.
 * When active and a path is being edited, updates toolOverlayData so
 * NodeEditorOverlay can render anchor nodes and control handles.
 *
 * Drag state is managed here; subsequent pointermove/pointerup events arrive
 * via the canvas-level handlers in SvgEditor.svelte.
 *
 * Extra methods called directly by SvgEditor:
 *   onNodePointerDown(ctx, pt, e, segIdx)
 *   onHandlePointerDown(ctx, pt, e, segIdx, handleType)  handleType: 'in' | 'out'
 */

import { parsePath, serializePath, moveAnchor, moveInHandle, moveOutHandle, deleteNodes } from '../pathData.js';

// ── Module-level state ────────────────────────────────────────────────────────

/** @type {Element|null} Live DOM <path> element being edited */
let _pathEl       = null;
/** @type {any[]} Working copy of path segments (absolute) */
let _segments     = [];
/** @type {Set<number>} Indices of selected anchor nodes */
let _selectedNodes = new Set();
/**
 * @type {null | {
 *   type: 'anchor'|'in'|'out',
 *   segIdx: number,
 *   startPt: {x:number,y:number},
 *   origSegs: any[]
 * }}
 */
let _drag = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _beginEdit(ctx, shapeId) {
    const s = ctx.state.shapes.find(s => s.id === shapeId);
    if (!s || s.tag !== 'path') return;
    _pathEl        = s.el;
    _segments      = parsePath(s.el.getAttribute('d') ?? '');
    _selectedNodes = new Set();
    _drag          = null;
    ctx.state.selectId(shapeId);
    _pushOverlay(ctx);
}

function _endEdit(ctx) {
    _pathEl        = null;
    _segments      = [];
    _selectedNodes = new Set();
    _drag          = null;
    ctx.state.toolOverlayData = null;
}

function _pushOverlay(ctx) {
    if (!_pathEl) return;
    ctx.state.toolOverlayData = {
        type:          'nodeEditor',
        pathId:        _pathEl.getAttribute('data-id') ?? '',
        segments:      _segments,
        selectedNodes: new Set(_selectedNodes),
    };
}

function _writeToDom() {
    if (_pathEl) {
        _pathEl.setAttribute('d', serializePath(_segments));
    }
}

function _deleteSelectedNodes(ctx) {
    if (!_selectedNodes.size) return;
    _segments      = deleteNodes(_segments, [..._selectedNodes]);
    _selectedNodes = new Set();
    _writeToDom();
    ctx.state.pushHistory();
    ctx.onChanged();
    _pushOverlay(ctx);
}

// ── Tool object ───────────────────────────────────────────────────────────────

export const nodeTool = {
    id: 'node',
    cursor() { return 'default'; },

    onActivate(ctx) {
        // If a path is already selected, immediately begin editing it
        const sel = ctx.state.selectedShapes;
        if (sel.length === 1 && sel[0].tag === 'path') {
            _beginEdit(ctx, sel[0].id);
        }
    },

    onDeactivate(ctx) {
        _endEdit(ctx);
    },

    onPointerDown(ctx, pt, e) {
        // Clicks on node/handle circles are handled by onNodePointerDown /
        // onHandlePointerDown before this fires — the circles stop propagation.
        // Reaching here means the user clicked on empty canvas or a non-path shape.

        const hit = ctx.findShapeAt(e);
        if (hit && hit.tag === 'path') {
            // Click on a path: begin/switch editing
            _beginEdit(ctx, hit.id);
        } else {
            // Click on empty space: deselect all nodes
            _selectedNodes = new Set();
            _pushOverlay(ctx);
        }
    },

    onPointerMove(ctx, pt, e) {
        if (!_drag) return;

        const dx = pt.x - _drag.startPt.x;
        const dy = pt.y - _drag.startPt.y;

        if (_drag.type === 'anchor') {
            // Move all selected anchors together
            let segs = _drag.origSegs.map(s => ({ ...s }));
            for (const idx of _selectedNodes) {
                segs = moveAnchor(segs, idx, dx, dy);
            }
            _segments = segs;
        } else if (_drag.type === 'in') {
            const orig = _drag.origSegs[_drag.segIdx];
            let nx, ny;
            if (orig.type === 'C')      { nx = orig.x2 + dx; ny = orig.y2 + dy; }
            else if (orig.type === 'Q') { nx = orig.x1 + dx; ny = orig.y1 + dy; }
            else return;
            _segments = moveInHandle(_drag.origSegs.map(s => ({ ...s })), _drag.segIdx, nx, ny);
        } else if (_drag.type === 'out') {
            const origNext = _drag.origSegs[_drag.segIdx + 1];
            if (!origNext) return;
            const nx = origNext.x1 + dx;
            const ny = origNext.y1 + dy;
            _segments = moveOutHandle(_drag.origSegs.map(s => ({ ...s })), _drag.segIdx, nx, ny);
        }

        _writeToDom();
        _pushOverlay(ctx);
        ctx.tickOverlay();
    },

    onPointerUp(ctx, pt, e) {
        if (!_drag) return;
        _drag = null;
        ctx.state.pushHistory();
        ctx.onChanged();
    },

    onKeyDown(ctx, e) {
        if (e.key === 'Escape') {
            _selectedNodes = new Set();
            _pushOverlay(ctx);
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && _selectedNodes.size > 0) {
            e.preventDefault();
            _deleteSelectedNodes(ctx);
        }
        if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
            // Select all nodes
            e.preventDefault();
            _selectedNodes = new Set(
                _segments.map((_, i) => i).filter(i => _segments[i].type !== 'Z')
            );
            _pushOverlay(ctx);
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            _cycleNode(e.shiftKey);
            _pushOverlay(ctx);
        }
    },

    onDblClick(ctx, e) {
        const hit = ctx.findShapeAt(e);
        if (hit?.tag === 'path') {
            // Double-click on a path: switch to editing it (or add node — Phase 4+)
            _beginEdit(ctx, hit.id);
        } else {
            // Double-click on canvas: exit node editor
            _endEdit(ctx);
            ctx.state.activeTool = 'select';
        }
    },

    // ── Called by SvgEditor from overlay events ───────────────────────────────

    /** Pointer press on an anchor node diamond in the overlay. */
    onNodePointerDown(ctx, pt, e, segIdx) {
        if (!e.shiftKey) {
            if (!_selectedNodes.has(segIdx)) {
                _selectedNodes = new Set([segIdx]);
            }
        } else {
            _selectedNodes = new Set(_selectedNodes);
            if (_selectedNodes.has(segIdx)) _selectedNodes.delete(segIdx);
            else _selectedNodes.add(segIdx);
        }
        _drag = {
            type:     'anchor',
            segIdx,
            startPt:  { ...pt },
            origSegs: _segments.map(s => ({ ...s })),
        };
        _pushOverlay(ctx);
    },

    /**
     * Pointer press on a control handle circle in the overlay.
     * handleType: 'in' | 'out'
     */
    onHandlePointerDown(ctx, pt, e, segIdx, handleType) {
        _drag = {
            type:     handleType,
            segIdx,
            startPt:  { ...pt },
            origSegs: _segments.map(s => ({ ...s })),
        };
    },
};

// ── Private helpers ───────────────────────────────────────────────────────────

function _cycleNode(reverse) {
    const anchors = _segments.map((_, i) => i).filter(i => _segments[i].type !== 'Z');
    if (!anchors.length) return;
    const last = [..._selectedNodes].pop();
    const idx  = anchors.indexOf(last ?? -1);
    let next;
    if (reverse) next = anchors[(idx - 1 + anchors.length) % anchors.length];
    else         next = anchors[(idx + 1) % anchors.length];
    _selectedNodes = new Set([next]);
}
