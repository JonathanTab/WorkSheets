/**
 * textTool — places text elements on click, then opens inline edit.
 */

import { round } from '../../../stores/svg/svgEditorState.svelte.js';

const NS = 'http://www.w3.org/2000/svg';

export const textTool = {
    id: 'text',
    cursor() { return 'text'; },

    onPointerDown(ctx, pt, e) {
        const el = document.createElementNS(NS, 'text');
        el.setAttribute('x', round(pt.x));
        el.setAttribute('y', round(pt.y));
        el.setAttribute('fill',        ctx.state.defFill);
        el.setAttribute('font-size',   ctx.state.defFontSize);
        el.setAttribute('font-family', ctx.state.defFontFamily);
        el.textContent = 'Text';

        const d = ctx.state.addElement(el);
        ctx.state.pushHistory();
        ctx.state.selectId(d.id);
        ctx.onChanged();

        // Open inline editor immediately so user can type
        ctx.startTextEdit(d.id);
    },

    onPointerMove(ctx, pt, e) {},
    onPointerUp(ctx, pt, e) {},
};
