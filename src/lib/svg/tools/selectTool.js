/**
 * selectTool — handles selection, drag-move, resize handles, rubber-band selection.
 */

import { getBBox, getTranslate, setTranslate, round } from '../../../stores/svg/svgEditorState.svelte.js';

// ── Module-level interaction state ────────────────────────────────────────────

let _dragging     = false;
let _dragStart    = null;   // { x, y } in SVG user coords
let _dragSnaps    = [];     // [{ id, el, tx, ty }] snapshot at drag start

let _resizing     = false;
let _resizeHandle = '';     // 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
let _resizeSnap   = null;   // { bbox, tx, ty, el, type, origTransform } at resize start
let _resizeStart  = null;   // { x, y } in SVG user coords

let _rubberBand   = null;   // internal: { x1, y1, x2, y2 } in SVG coords

// ── Resize math ───────────────────────────────────────────────────────────────

function doResize(pt) {
    if (!_resizeSnap) return;
    const { bbox, tx, ty, el, type, origTransform } = _resizeSnap;
    const h = _resizeHandle;
    const dx = pt.x - _resizeStart.x;
    const dy = pt.y - _resizeStart.y;

    // newX/newY are the NEW visual (on-screen) top-left of the bbox
    let newX = bbox.x, newY = bbox.y;
    let newW = bbox.w, newH = bbox.h;

    if (h.includes('w')) { newX += dx; newW = Math.max(2, newW - dx); }
    if (h.includes('e')) { newW = Math.max(2, newW + dx); }
    if (h.includes('n')) { newY += dy; newH = Math.max(2, newH - dy); }
    if (h.includes('s')) { newH = Math.max(2, newH + dy); }

    // Local coords = visual coords minus the existing translate
    const localX = newX - tx;
    const localY = newY - ty;

    switch (type) {
        case 'rect':
        case 'image':
            el.setAttribute('x', round(localX));
            el.setAttribute('y', round(localY));
            el.setAttribute('width',  round(newW));
            el.setAttribute('height', round(newH));
            break;
        case 'ellipse':
            el.setAttribute('cx', round(localX + newW / 2));
            el.setAttribute('cy', round(localY + newH / 2));
            el.setAttribute('rx', round(newW / 2));
            el.setAttribute('ry', round(newH / 2));
            break;
        default: {
            // Generic: reposition via translate + scale transform.
            // Preserves any rotation or other transforms from origTransform.
            if (bbox.w < 1 || bbox.h < 1) break;
            const sx = newW / bbox.w;
            const sy = newH / bbox.h;
            // new_t* chosen so visual bbox top-left lands at (newX, newY)
            const new_tx = newX - (bbox.x - tx) * sx;
            const new_ty = newY - (bbox.y - ty) * sy;
            // Strip old translate/scale, keep rotations etc.
            const base = origTransform
                .replace(/translate\s*\([^)]*\)/g, '')
                .replace(/scale\s*\([^)]*\)/g, '')
                .trim();
            const parts = [];
            if (new_tx !== 0 || new_ty !== 0) parts.push(`translate(${round(new_tx)},${round(new_ty)})`);
            if (sx !== 1 || sy !== 1) parts.push(`scale(${round(sx)},${round(sy)})`);
            if (base) parts.push(base);
            const tf = parts.join(' ');
            if (tf) el.setAttribute('transform', tf);
            else el.removeAttribute('transform');
            break;
        }
    }
}

// ── Tool object ───────────────────────────────────────────────────────────────

export const selectTool = {
    id: 'select',

    cursor() {
        if (_dragging) return 'move';
        return null; // use component default
    },

    isResizing() { return _resizing; },
    isDragging() { return _dragging; },

    onPointerDown(ctx, pt, e) {
        // Resize-handle clicks are routed through onHandlePointerDown, not here
        if (e.target?.dataset?.handle) return;

        const hit = ctx.findShapeAt(e);

        if (hit) {
            if (!ctx.state.selectedIds.has(hit.id)) {
                ctx.state.selectId(hit.id, e.shiftKey);
            }
            _dragging  = true;
            _dragStart = pt;
            _dragSnaps = ctx.state.selectedShapes.map(s => {
                const t = getTranslate(s.el);
                return { id: s.id, el: s.el, tx: t.x, ty: t.y };
            });
        } else if (!e.shiftKey) {
            ctx.state.clearSelection();
            _rubberBand = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
            ctx.setRubberBand(_rubberBand);
        }
    },

    onPointerMove(ctx, pt, e) {
        if (_resizing && _resizeSnap) {
            doResize(pt);
            ctx.tickOverlay();
            ctx.onChanged();
            return;
        }

        if (_dragging && _dragSnaps.length) {
            const dx = pt.x - _dragStart.x;
            const dy = pt.y - _dragStart.y;
            for (const snap of _dragSnaps) {
                setTranslate(snap.el, snap.tx + dx, snap.ty + dy);
            }
            ctx.tickOverlay();
            ctx.onChanged();
            return;
        }

        if (_rubberBand) {
            _rubberBand = { ..._rubberBand, x2: pt.x, y2: pt.y };
            ctx.setRubberBand(_rubberBand);
        }
    },

    onPointerUp(ctx, pt, e) {
        if (_resizing) {
            _resizing = false;
            _resizeSnap = null;
            ctx.state.pushHistory();
            return;
        }

        if (_dragging) {
            _dragging  = false;
            _dragSnaps = [];
            ctx.state.pushHistory();
            return;
        }

        if (_rubberBand) {
            const rb = _rubberBand;
            _rubberBand = null;
            ctx.setRubberBand(null);

            const x1 = Math.min(rb.x1, rb.x2), y1 = Math.min(rb.y1, rb.y2);
            const x2 = Math.max(rb.x1, rb.x2), y2 = Math.max(rb.y1, rb.y2);
            if (x2 - x1 > 3 || y2 - y1 > 3) {
                const ids = ctx.state.shapes
                    .filter(s => {
                        const b = getBBox(s.el);
                        const t = getTranslate(s.el);
                        const vx = b.x + t.x, vy = b.y + t.y;
                        return vx < x2 && vx + b.w > x1 && vy < y2 && vy + b.h > y1;
                    })
                    .map(s => s.id);
                ctx.state.selectIds(ids);
            }
        }
    },

    /** Called by the canvas template for resize handle pointerdown events. */
    onHandlePointerDown(ctx, pt, e, handle) {
        const sel = ctx.state.selectedShapes;
        if (sel.length !== 1) return;
        const s = sel[0];
        _resizing     = true;
        _resizeHandle = handle;
        _resizeStart  = pt;
        const b = getBBox(s.el);
        const t = getTranslate(s.el);
        _resizeSnap = {
            bbox: { ...b },
            tx: t.x, ty: t.y,
            el: s.el,
            type: s.type,
            origTransform: s.el.getAttribute('transform') || '',
        };
    },

    /** Called by the canvas for double-click on a text element. */
    onDblClick(ctx, e) {
        const hit = ctx.findShapeAt(e);
        if (hit?.type === 'text') {
            ctx.startTextEdit(hit.id);
        }
    },
};
