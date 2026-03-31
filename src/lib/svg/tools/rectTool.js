/**
 * rectTool — draws rectangles by click-drag.
 */

import { round } from '../../../stores/svg/svgEditorState.svelte.js';

const NS = 'http://www.w3.org/2000/svg';

let _drawing   = false;
let _drawStart = null;
let _ghostEl   = null;

export const rectTool = {
    id: 'rect',
    cursor() { return 'crosshair'; },

    onPointerDown(ctx, pt, e) {
        _drawing   = true;
        _drawStart = pt;
        const el = document.createElementNS(NS, 'rect');
        el.setAttribute('x', round(pt.x));
        el.setAttribute('y', round(pt.y));
        el.setAttribute('width',  '0');
        el.setAttribute('height', '0');
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
        const x = Math.min(s.x, pt.x), y = Math.min(s.y, pt.y);
        _ghostEl.setAttribute('x', round(x));
        _ghostEl.setAttribute('y', round(y));
        _ghostEl.setAttribute('width',  round(Math.abs(pt.x - s.x)));
        _ghostEl.setAttribute('height', round(Math.abs(pt.y - s.y)));
    },

    onPointerUp(ctx, pt, e) {
        if (!_drawing || !_ghostEl) return;
        _drawing = false;
        _ghostEl.removeAttribute('opacity');

        const valid = parseFloat(_ghostEl.getAttribute('width')  || '0') > 2
                   && parseFloat(_ghostEl.getAttribute('height') || '0') > 2;

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
