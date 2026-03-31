/**
 * lineTool — draws lines by click-drag.
 */

import { round } from '../../../stores/svg/svgEditorState.svelte.js';

const NS = 'http://www.w3.org/2000/svg';

let _drawing   = false;
let _drawStart = null;
let _ghostEl   = null;

export const lineTool = {
    id: 'line',
    cursor() { return 'crosshair'; },

    onPointerDown(ctx, pt, e) {
        _drawing   = true;
        _drawStart = pt;
        const el = document.createElementNS(NS, 'line');
        el.setAttribute('x1', round(pt.x));
        el.setAttribute('y1', round(pt.y));
        el.setAttribute('x2', round(pt.x));
        el.setAttribute('y2', round(pt.y));
        el.setAttribute('stroke',       ctx.state.defStroke);
        el.setAttribute('stroke-width', ctx.state.defStrokeW);
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('opacity', '0.65');
        _ghostEl = el;
        ctx.state.svgEl?.appendChild(_ghostEl);
    },

    onPointerMove(ctx, pt, e) {
        if (!_drawing || !_ghostEl) return;
        _ghostEl.setAttribute('x2', round(pt.x));
        _ghostEl.setAttribute('y2', round(pt.y));
    },

    onPointerUp(ctx, pt, e) {
        if (!_drawing || !_ghostEl) return;
        _drawing = false;
        _ghostEl.removeAttribute('opacity');

        const dx = parseFloat(_ghostEl.getAttribute('x2')) - parseFloat(_ghostEl.getAttribute('x1'));
        const dy = parseFloat(_ghostEl.getAttribute('y2')) - parseFloat(_ghostEl.getAttribute('y1'));
        const valid = Math.hypot(dx, dy) > 2;

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
