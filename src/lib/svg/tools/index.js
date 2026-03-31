/**
 * tools/index.js — central registry of all SVG editor tools.
 *
 * Each entry is a ToolHandler object with the interface:
 *   { id, cursor(), onPointerDown(ctx,pt,e), onPointerMove(ctx,pt,e), onPointerUp(ctx,pt,e) }
 *
 * Optional methods: onActivate(ctx), onDeactivate(ctx), onKeyDown(ctx,e), onDblClick(ctx,e)
 *
 * The ToolContext (ctx) passed to each handler provides:
 *   ctx.state          — svgEditorState singleton
 *   ctx.toSvg(cx,cy)   — convert client coords to SVG user units
 *   ctx.snap(pt)        — snap pt to grid
 *   ctx.onChanged()     — mark document dirty
 *   ctx.tickOverlay()   — force overlay recompute (call during drag)
 *   ctx.setRubberBand(rb|null) — set rubber-band rect for rendering
 *   ctx.findShapeAt(e)  — hit-test: returns shape descriptor or null
 *   ctx.startTextEdit(id) — open inline text editor for shape with given id
 */

export { selectTool }  from './selectTool.js';
export { rectTool }    from './rectTool.js';
export { ellipseTool } from './ellipseTool.js';
export { lineTool }    from './lineTool.js';
export { pencilTool }  from './pencilTool.js';
export { textTool }    from './textTool.js';
export { nodeTool }    from './nodeTool.js';
export { penTool }     from './penTool.js';

import { selectTool }  from './selectTool.js';
import { rectTool }    from './rectTool.js';
import { ellipseTool } from './ellipseTool.js';
import { lineTool }    from './lineTool.js';
import { pencilTool }  from './pencilTool.js';
import { textTool }    from './textTool.js';
import { nodeTool }    from './nodeTool.js';
import { penTool }     from './penTool.js';

/** Map of tool id → ToolHandler. */
export const TOOL_REGISTRY = {
    select:  selectTool,
    rect:    rectTool,
    ellipse: ellipseTool,
    line:    lineTool,
    pencil:  pencilTool,
    text:    textTool,
    node:    nodeTool,
    pen:     penTool,
};
