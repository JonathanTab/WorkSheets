/**
 * pencilTool — freehand path drawing.
 */

import { round } from '../../../stores/svg/svgEditorState.svelte.js';

const NS = 'http://www.w3.org/2000/svg';

let _drawing = false;
let _ghostEl = null;

export const pencilTool = {
    id: 'pencil',
    cursor() { return 'crosshair'; },

    onPointerDown(ctx, pt, e) {
        _drawing = true;
        const el = document.createElementNS(NS, 'path');
        el.setAttribute('d', `M${round(pt.x)},${round(pt.y)}`);
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke',       ctx.state.defStroke);
        el.setAttribute('stroke-width', ctx.state.defStrokeW);
        el.setAttribute('stroke-linecap',  'round');
        el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('opacity', '0.65');
        _ghostEl = el;
        ctx.state.svgEl?.appendChild(_ghostEl);
    },

    onPointerMove(ctx, pt, e) {
        if (!_drawing || !_ghostEl) return;
        const d = _ghostEl.getAttribute('d') + ` L${round(pt.x)},${round(pt.y)}`;
        _ghostEl.setAttribute('d', d);
    },

    onPointerUp(ctx, pt, e) {
        if (!_drawing || !_ghostEl) return;
        _drawing = false;
        _ghostEl.removeAttribute('opacity');

        const valid = (_ghostEl.getAttribute('d') || '').length > 10;

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
