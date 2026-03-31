/**
 * ellipseTool — draws ellipses by click-drag.
 */

import { round } from '../../../stores/svg/svgEditorState.svelte.js';

const NS = 'http://www.w3.org/2000/svg';

let _drawing   = false;
let _drawStart = null;
let _ghostEl   = null;

export const ellipseTool = {
    id: 'ellipse',
    cursor() { return 'crosshair'; },

    onPointerDown(ctx, pt, e) {
        _drawing   = true;
        _drawStart = pt;
        const el = document.createElementNS(NS, 'ellipse');
        el.setAttribute('cx', round(pt.x));
        el.setAttribute('cy', round(pt.y));
        el.setAttribute('rx', '0');
        el.setAttribute('ry', '0');
        el.setAttribute('fill',         ctx.state.defFill);
        el.setAttribute('stroke',       ctx.state.defStroke);
        el.setAttribute('stroke-width', ctx.state.defStrokeW);
        el.setAttribute('opacity', '0.65');
        _ghostEl = el;
        ctx.state.svgEl?.appendChild(_ghostEl);
    },

    onPointerMove(ctx, pt, e) {
        if (!_drawing || !_ghostEl) return;
        const s = _drawStart;
        _ghostEl.setAttribute('cx', round((s.x + pt.x) / 2));
        _ghostEl.setAttribute('cy', round((s.y + pt.y) / 2));
        _ghostEl.setAttribute('rx', round(Math.abs(pt.x - s.x) / 2));
        _ghostEl.setAttribute('ry', round(Math.abs(pt.y - s.y) / 2));
    },

    onPointerUp(ctx, pt, e) {
        if (!_drawing || !_ghostEl) return;
        _drawing = false;
        _ghostEl.removeAttribute('opacity');

        const valid = parseFloat(_ghostEl.getAttribute('rx') || '0') > 1;

        if (valid) {
            const d = ctx.state.addElement(_ghostEl);
            ctx.state.pushHistory();
            ctx.state.selectId(d.id);
            ctx.onChanged();
        } else {
            _ghostEl.parentNode?.removeChild(_ghostEl);
        }
        _ghostEl = null;
    },
};
