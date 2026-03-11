# Canvas Grid Architecture — Implementation Plan

## Executive Summary

**Current state:** The grid renders hundreds of absolutely-positioned `<div>` elements inside `VirtualPane` Svelte components. Each cell is a DOM node with inline styles for position, dimensions, text formatting, borders, and background. Tables, repeaters, checkboxes, and ratings are Svelte sub-components mounted per-cell. Selection, anchor highlight, and the cell editor are DOM overlays inside `GridOverlays.svelte`.

**Target state (Google Sheets pattern):**
- **Canvas layer** — A single `<canvas>` element renders ALL cell backgrounds, gridlines, borders, text, cell content (including table headers/data, repeater cells, checkbox/rating icons, sticky table headers), and the selection highlight fill.
- **DOM overlay layer** — Sits on top of canvas. Contains: column/row headers (kept as DOM for resize handles), the selection border outline, the active cell editor (`<input>`/picker), formula reference highlights, context menus, table filter popovers, and table entry row inputs (only when focused).
- **Invisible event layer** — A transparent div covering the canvas area that captures mouse/keyboard events and maps pixel coordinates → cell coordinates using the existing `AxisMetrics` / `GridVirtualizer`.

This is exactly the pattern Google Sheets uses: canvas for painting (fast, no DOM overhead), DOM only for interactive elements that need native behavior.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│ Grid.svelte (container)                           │
│ ┌──────────────────────────────────────────────┐ │
│ │ scroll-proxy (overflow:auto, z:1)            │ │  ← handles native scrollbars
│ │  └─ scroll-spacer (totalW × totalH)          │ │
│ ├──────────────────────────────────────────────┤ │
│ │ canvas-layer (z:2)                           │ │
│ │  └─ <canvas> (single canvas, 4 clip regions)│ │  ← all cell rendering
│ ├──────────────────────────────────────────────┤ │
│ │ dom-overlay-layer (z:3, pointer-events:none) │ │
│ │  ├─ ColHeaders.svelte (DOM, pe:auto)         │ │  ← resize handles need DOM
│ │  ├─ RowHeaders.svelte (DOM, pe:auto)         │ │  ← resize handles need DOM
│ │  ├─ corner-cell (DOM, pe:auto)               │ │
│ │  ├─ SelectionBorder (DOM div, pe:none)       │ │  ← 2px blue outline only
│ │  ├─ CellEditor (DOM input, pe:auto)          │ │  ← edit input (on focus)
│ │  ├─ FormulaHighlights (DOM divs, pe:none)    │ │
│ │  ├─ TableFilterPopovers (DOM, pe:auto)       │ │  ← popover dropdowns
│ │  └─ TableEntryInputs (DOM, pe:auto)          │ │  ← only when field focused
│ ├──────────────────────────────────────────────┤ │
│ │ event-layer (z:4, transparent, pe:auto)      │ │  ← catches all mouse events
│ └──────────────────────────────────────────────┘ │
│ ContextMenu, Dialogs (portalled)                  │
└──────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### Single Canvas vs. Multiple Canvases for Frozen Panes

**Decision: Single `<canvas>` with clip-region rendering.**

Using a single canvas saves RAM (one backing buffer instead of four) and avoids context switching between WebGL/2D contexts. The renderer paints each pane region in sequence using `ctx.save()` / `ctx.rect()` / `ctx.clip()` / `ctx.restore()`:

1. Paint body pane (clipped to body viewport area)
2. Paint left frozen pane (clipped to left strip)
3. Paint top frozen pane (clipped to top strip)
4. Paint corner frozen pane (clipped to corner area)

Frozen pane contents are also cached to an `OffscreenCanvas` bitmap and only repainted when the frozen region's cell data changes (not on scroll).

### Extensible Cell Type Painting

**Decision: Plugin architecture with `CellTypePainter` interface.**

Each cell type in `CellTypeRegistry` gains an optional `paintCell(ctx, value, config, rect, style)` method and a `paintEditor?: SvelteComponent` for when the cell is being edited. This allows future types (dropdowns, avatars, progress bars, sparklines) to register their own canvas paint logic:

```js
CellTypeRegistry.register({
  id: 'checkbox',
  formatValue: (val) => ...,
  paintCell(ctx, value, config, rect, style) {
    // Draw checkbox icon using canvas paths
  },
  // Optional: Svelte component to mount when this cell is focused/edited
  editorComponent: CheckboxEditor,
  handlesClick: true,
});
```

The `CanvasRenderer` calls `descriptor.paintCell()` if it exists; otherwise falls back to standard `ctx.fillText()` for text rendering.

### Sticky Table Headers

**Decision: Rendered on canvas, not DOM.**

When an inline table's header row scrolls past the top, the sticky header is painted directly onto the canvas in the frozen-top clip region. This avoids mixing canvas and DOM for grid content and keeps the visual consistency tight.

### Table Entry Row

**Decision: Canvas-painted by default; DOM `<input>` appears only on focus.**

The entry row cells are painted on canvas as empty placeholder cells with light background. When a user clicks/focuses an entry cell, a positioned DOM `<input>` overlay appears at that cell's coordinates. On blur/commit, the DOM input is removed and the canvas repaints.

### PDF-Based Printing

**Decision: Use `jsPDF` library for client-side PDF generation.**

`jsPDF` (~30KB gzipped) generates proper vector text PDFs. The existing `PrintEngine.computePageBreaks()` computes page boundaries, then an offscreen high-DPI canvas renders each page and feeds it into jsPDF.

---

## Phase 0: New Infrastructure (No visible changes)

### 0.1 — `CellTypePainter` Protocol Extension

**File:** `src/stores/spreadsheet/cellTypes/index.js` (modify)

Add `paintCell` method to the `CellTypeRegistry` protocol. Each cell type descriptor can optionally provide:

```js
{
  id: 'checkbox',
  formatValue: ...,

  // NEW: Canvas paint method
  // Called by CanvasRenderer for each visible cell of this type
  paintCell(ctx, value, config, rect, style) {
    // rect = { x, y, width, height }
    // style = { bgColor, textColor, font, hAlign, vAlign }
    // Paint checkbox icon
  },

  // NEW: Optional Svelte component for editing this cell type
  // Mounted as DOM overlay when cell is in edit/focus mode
  editorComponent: null, // or import('...CheckboxEditor.svelte')

  // EXISTING
  handlesClick: true,
  parseInput: ...,
  defaultStyle: ...,
}
```

Add `paintCell` implementations to existing types:
- **text** — default `ctx.fillText()` (handled by CanvasRenderer base path, no `paintCell` needed)
- **number/currency/percent/date** — no `paintCell` needed (formatted text)
- **checkbox** — canvas path drawing (rounded rect + checkmark)
- **rating** — canvas star paths (filled/unfilled)
- **url** — blue underlined text via canvas

**New file:** `src/stores/spreadsheet/cellTypes/painters.js`

Contains shared canvas drawing utilities:
```js
export function drawCheckbox(ctx, x, y, size, checked, color)
export function drawStar(ctx, cx, cy, outerR, innerR, filled, color)
export function drawRating(ctx, x, y, width, height, value, max, color)
export function drawUnderlinedText(ctx, text, x, y, color)
```

### 0.2 — `CellPaintData` Builder

**New file:** `src/stores/spreadsheet/rendering/CellPaintData.js`

Flattened, cache-friendly cell rendering data structure optimized for canvas iteration. Replaces the `renderCells` derived array in VirtualPane.

```js
/**
 * CellPaintData - Pre-computed flat arrays for efficient canvas painting.
 *
 * Built once per render cycle from SheetRenderContext + AxisMetrics.
 * Avoids per-cell object allocation during the paint loop.
 */
export class CellPaintData {
  constructor() {
    this.count = 0;
    this.capacity = 0;

    // Core position arrays (typed for cache locality)
    this.rows = null;      // Int32Array
    this.cols = null;      // Int32Array
    this.xs = null;        // Float64Array - pixel X position
    this.ys = null;        // Float64Array - pixel Y position
    this.widths = null;    // Float64Array
    this.heights = null;   // Float64Array

    // Cell type enum (0=regular, 1=merge_primary, 2=table_header, etc.)
    this.types = null;     // Uint8Array

    // Text rendering
    this.displayValues = [];   // string[]
    this.fontStrings = [];     // pre-built "bold 12px sans-serif"
    this.textColors = [];      // string[]
    this.bgColors = [];        // string[] ('' = default white)

    // Alignment (0=left, 1=center, 2=right)
    this.hAligns = null;   // Uint8Array
    // Vertical align (0=top, 1=middle, 2=bottom)
    this.vAligns = null;   // Uint8Array

    // Flags
    this.wrapText = null;  // Uint8Array (boolean)
    this.bold = null;      // Uint8Array
    this.italic = null;    // Uint8Array
    this.underline = null; // Uint8Array
    this.strikethrough = null; // Uint8Array

    // Sparse maps for special cell types
    this.cellTypeConfigs = new Map();   // index → { type, ...config }
    this.tableInfos = new Map();       // index → { table, cellType, colIndex, dataIndex }
    this.repeaterContexts = new Map(); // index → { repIndex, templateRow, templateCol }

    // Border data (sparse - most cells have no custom borders)
    this.borders = new Map(); // index → { top, right, bottom, left }

    // Selection state
    this.selected = null;  // Uint8Array (boolean)
    this.isAnchor = null;  // Uint8Array (boolean)

    // Formula highlight (sparse)
    this.formulaHighlights = new Map(); // index → color string
  }

  ensureCapacity(needed) { ... }

  /**
   * Build paint data for a pane from the render context.
   *
   * @param {Object} params
   * @param {AxisRange} params.rowRange
   * @param {AxisRange} params.colRange
   * @param {AxisMetrics} params.rowMetrics
   * @param {AxisMetrics} params.colMetrics
   * @param {SheetRenderContext} params.renderContext
   * @param {SheetStore} params.sheetStore
   * @param {SpreadsheetSession} params.session
   * @param {SelectionState} params.selectionState
   * @param {FormulaEditState} params.formulaEditState
   * @param {number} params.scrollX - pane scroll offset X
   * @param {number} params.scrollY - pane scroll offset Y
   */
  build(params) { ... }

  clear() { ... }
}
```

### 0.3 — `CanvasRenderer` Class

**New file:** `src/stores/spreadsheet/rendering/CanvasRenderer.js`

Framework-agnostic class that paints cells onto a canvas context.

```js
/**
 * CanvasRenderer - Paints spreadsheet cells onto a canvas.
 *
 * Responsible for:
 * - Gridlines
 * - Cell backgrounds
 * - Cell text (with font, color, alignment, wrap, overflow)
 * - Custom cell type rendering (checkbox, rating, etc.)
 * - Borders (custom per-cell borders)
 * - Table headers, data, entry placeholders
 * - Repeater cells
 * - Merged cells
 * - Selection fill highlight
 * - Sticky table headers
 *
 * Uses devicePixelRatio for Retina-crisp rendering.
 */
export class CanvasRenderer {
  #ctx = null;
  #canvas = null;
  #dpr = 1;
  #width = 0;   // CSS pixels
  #height = 0;  // CSS pixels

  // Theme colors (configurable via CSS custom properties)
  #theme = {
    gridlineColor: '#e2e8f0',
    cellBg: '#ffffff',
    cellHoverBg: '#f8fafc',
    selectionFill: 'rgba(59, 130, 246, 0.08)',
    selectionBorder: '#3b82f6',
    anchorBorder: '#3b82f6',
    headerBg: '#f1f5f9',
    headerText: '#64748b',
    tableHeaderBg: '#f1f5f9',
    tableHeaderBorder: '#94a3b8',
    tableHeaderText: '#334155',
    defaultTextColor: '#1e293b',
    defaultFont: '13px system-ui, -apple-system, sans-serif',
  };

  constructor(canvas) { ... }

  // --- Lifecycle ---
  resize(cssWidth, cssHeight) { ... }
  setDPR(dpr) { ... }
  clear() { ... }
  destroy() { ... }

  // --- Theme ---
  updateTheme(themeOverrides) { ... }

  // --- Main paint entry point ---

  /**
   * Paint a single pane (body, top, left, or corner).
   * Caller is responsible for setting up clip region before calling.
   *
   * @param {CellPaintData} paintData - pre-computed cell data
   * @param {Object} options
   * @param {number} options.clipX - clip region origin X (CSS px)
   * @param {number} options.clipY - clip region origin Y
   * @param {number} options.clipW - clip region width
   * @param {number} options.clipH - clip region height
   * @param {number} options.offsetX - scroll offset X
   * @param {number} options.offsetY - scroll offset Y
   * @param {boolean} options.paintGridlines - whether to draw gridlines
   * @param {boolean} options.paintSelection - whether to draw selection fill
   */
  paintPane(paintData, options) {
    const ctx = this.#ctx;
    const dpr = this.#dpr;

    ctx.save();

    // Set up clip region
    ctx.beginPath();
    ctx.rect(
      options.clipX * dpr, options.clipY * dpr,
      options.clipW * dpr, options.clipH * dpr
    );
    ctx.clip();

    // Paint layers in order
    this.#paintCellBackgrounds(paintData, options);
    this.#paintGridlines(paintData, options);
    this.#paintBorders(paintData, options);
    this.#paintSelectionFill(paintData, options);
    this.#paintCellContent(paintData, options);

    ctx.restore();
  }

  /**
   * Paint sticky table headers into the frozen-top region.
   */
  paintStickyHeaders(stickyHeaders, options) { ... }

  // --- Internal paint methods ---
  #paintCellBackgrounds(paintData, options) { ... }
  #paintGridlines(paintData, options) { ... }
  #paintBorders(paintData, options) { ... }
  #paintSelectionFill(paintData, options) { ... }
  #paintCellContent(paintData, options) { ... }
  #paintTextCell(ctx, text, font, color, rect, hAlign, vAlign, wrap, underline, strikethrough) { ... }
  #paintCustomCell(ctx, descriptor, value, config, rect, style) { ... }

  // --- Utility ---
  #buildFontString(bold, italic, fontSize, fontFamily) { ... }
  #measureText(text, font) { ... } // with cache
}
```

### 0.4 — `RenderScheduler` Class

**New file:** `src/stores/spreadsheet/rendering/RenderScheduler.js`

Batches paint requests using `requestAnimationFrame` to avoid redundant repaints.

```js
/**
 * RenderScheduler - Batches and deduplicates paint requests.
 *
 * When data/selection/scroll changes, multiple reactive effects may fire.
 * The scheduler coalesces them into a single RAF paint call.
 */
export class RenderScheduler {
  #dirty = new Set();      // which panes need repaint: 'body','top','left','corner','all'
  #rafId = null;
  #paintCallback = null;

  constructor(paintCallback) {
    this.#paintCallback = paintCallback;
  }

  /**
   * Mark a pane as needing repaint.
   * @param {'body'|'top'|'left'|'corner'|'all'} [pane='all']
   */
  invalidate(pane = 'all') {
    if (pane === 'all') {
      this.#dirty.add('body');
      this.#dirty.add('top');
      this.#dirty.add('left');
      this.#dirty.add('corner');
    } else {
      this.#dirty.add(pane);
    }
    this.#scheduleFrame();
  }

  /** Force immediate synchronous paint (for print/export). */
  flush() {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    if (this.#dirty.size > 0) {
      const panes = new Set(this.#dirty);
      this.#dirty.clear();
      this.#paintCallback(panes);
    }
  }

  destroy() {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
  }

  #scheduleFrame() {
    if (this.#rafId !== null) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = null;
      const panes = new Set(this.#dirty);
      this.#dirty.clear();
      this.#paintCallback(panes);
    });
  }
}
```

### 0.5 — `HitTestEngine` Class

**New file:** `src/stores/spreadsheet/rendering/HitTestEngine.js`

Converts pixel coordinates from mouse events to cell addresses.

```js
/**
 * HitTestEngine - Maps pixel coordinates to cell (row, col) and UI region.
 *
 * Accounts for frozen panes, headers, scroll offsets, and resize zones.
 */
export class HitTestEngine {
  #virtualizer = null;

  /**
   * @param {GridVirtualizer} virtualizer
   */
  setVirtualizer(virtualizer) {
    this.#virtualizer = virtualizer;
  }

  /**
   * Perform a hit test at the given coordinates.
   *
   * @param {number} localX - X relative to grid container left edge
   * @param {number} localY - Y relative to grid container top edge
   * @param {Object} layout - { headerWidth, headerHeight, frozenWidth, frozenHeight }
   * @returns {{
   *   row: number,
   *   col: number,
   *   pane: 'body'|'top'|'left'|'corner'|null,
   *   region: 'cell'|'colHeader'|'rowHeader'|'corner'|'colResize'|'rowResize'|null,
   *   resizeIndex?: number
   * }}
   */
  hitTest(localX, localY, layout) {
    const { headerWidth, headerHeight, frozenWidth, frozenHeight } = layout;
    const v = this.#virtualizer;
    if (!v) return { row: -1, col: -1, pane: null, region: null };

    // Determine region
    const inHeaders = localX < headerWidth || localY < headerHeight;
    const inCorner = localX < headerWidth && localY < headerHeight;

    if (inCorner) {
      return { row: -1, col: -1, pane: null, region: 'corner' };
    }

    if (localY < headerHeight) {
      // Column header area
      const col = this.#resolveCol(localX - headerWidth, frozenWidth, v);
      const resizeZone = this.#checkColResizeZone(localX - headerWidth, col, frozenWidth, v);
      return {
        row: -1, col,
        pane: null,
        region: resizeZone ? 'colResize' : 'colHeader',
        resizeIndex: resizeZone ? col : undefined
      };
    }

    if (localX < headerWidth) {
      // Row header area
      const row = this.#resolveRow(localY - headerHeight, frozenHeight, v);
      const resizeZone = this.#checkRowResizeZone(localY - headerHeight, row, frozenHeight, v);
      return {
        row, col: -1,
        pane: null,
        region: resizeZone ? 'rowResize' : 'rowHeader',
        resizeIndex: resizeZone ? row : undefined
      };
    }

    // Cell area
    const contentX = localX - headerWidth;
    const contentY = localY - headerHeight;

    const inFrozenX = contentX < frozenWidth;
    const inFrozenY = contentY < frozenHeight;

    const col = this.#resolveCol(contentX, frozenWidth, v);
    const row = this.#resolveRow(contentY, frozenHeight, v);

    let pane = 'body';
    if (inFrozenX && inFrozenY) pane = 'corner';
    else if (inFrozenY) pane = 'top';
    else if (inFrozenX) pane = 'left';

    return { row, col, pane, region: 'cell' };
  }

  /**
   * Get the CSS cursor for a hit test result.
   */
  getCursor(hitResult) {
    switch (hitResult.region) {
      case 'colResize': return 'col-resize';
      case 'rowResize': return 'row-resize';
      case 'colHeader': return 'pointer';
      case 'rowHeader': return 'pointer';
      case 'corner': return 'pointer';
      case 'cell': return 'cell';
      default: return 'default';
    }
  }

  #resolveCol(contentX, frozenWidth, v) { ... }
  #resolveRow(contentY, frozenHeight, v) { ... }
  #checkColResizeZone(contentX, col, frozenWidth, v) { ... }
  #checkRowResizeZone(contentY, row, frozenHeight, v) { ... }
}
```

---

## Phase 1: Canvas Cell Rendering (Replace VirtualPane)

### 1.1 — Modify `Grid.svelte` — Canvas Architecture

**File:** `src/components/spreadsheet/Grid.svelte` (heavy rewrite)

Replace the four `<VirtualPane>` instances with a single `<canvas>` element and a DOM overlay layer.

**Template structure (simplified):**

```svelte
<div class="grid-root" bind:this={containerEl}>
  <!-- Native scroll proxy (unchanged) -->
  <div class="scroll-proxy" bind:this={scrollEl} onscroll={handleScroll}>
    <div class="scroll-spacer" style={spacerStyle()}></div>
  </div>

  {#if renderPlan && virtualizer}
    <!-- Canvas layer -->
    <canvas
      bind:this={canvasEl}
      class="grid-canvas"
      width={canvasPixelWidth}
      height={canvasPixelHeight}
      style="width:{containerWidth}px; height:{containerHeight}px;"
    ></canvas>

    <!-- DOM overlay layer (pointer-events: none by default) -->
    <div class="dom-overlay-layer">
      <!-- Corner cell (select-all button) -->
      <div class="corner-cell" ... ></div>

      <!-- Column headers (DOM for resize handles) -->
      <ColHeaders ... />

      <!-- Row headers (DOM for resize handles) -->
      <RowHeaders ... />

      <!-- Selection border outline (DOM div) -->
      {#if selectionBounds}
        <div class="selection-border" style={selectionBorderStyle}></div>
      {/if}

      <!-- Anchor outline (DOM div) -->
      {#if anchorBounds}
        <div class="anchor-border" style={anchorBorderStyle}></div>
      {/if}

      <!-- Cell editor (DOM input, only when editing) -->
      {#if isEditing && editorBounds}
        <div class="cell-editor" style={editorStyle}>
          <input ... />
          <!-- formula overlay, picker, etc. -->
        </div>
      {/if}

      <!-- Formula reference highlights -->
      {#each formulaHighlightRects as rect}
        <div class="formula-highlight" style={rect.style}></div>
      {/each}

      <!-- Table filter popovers (DOM) -->
      {#each activeFilterPopovers as popover}
        <TableFilterPopover ... />
      {/each}

      <!-- Table entry row inputs (DOM, only when focused) -->
      {#if focusedEntryCell}
        <div class="entry-input-overlay" style={entryInputStyle}>
          <input ... />
        </div>
      {/if}
    </div>

    <!-- Event capture layer (transparent, catches all mouse events) -->
    <div
      class="event-layer"
      onmousedown={handleMouseDown}
      onmousemove={handleMouseMove}
      ondblclick={handleDblClick}
      oncontextmenu={handleContextMenu}
      style="cursor: {currentCursor}"
    ></div>
  {/if}
</div>
```

**Key changes:**

1. **Remove** all `<VirtualPane>` component usage
2. **Add** single `<canvas>` element sized to container
3. **Add** DOM overlay layer for headers, selection border, editor
4. **Add** transparent event layer that delegates to `HitTestEngine`
5. **Wire** `$effect` blocks to build `CellPaintData` and trigger `RenderScheduler`

### 1.2 — Event Handling Refactor

Replace per-cell DOM event handlers with centralized event layer:

```js
// All mouse interaction goes through the event layer
function handleMouseDown(e) {
  const hit = hitTestEngine.hitTest(
    e.clientX - containerRect.left,
    e.clientY - containerRect.top,
    { headerWidth: HEADER_WIDTH, headerHeight: HEADER_HEIGHT,
      frozenWidth: renderPlan.frozenWidth, frozenHeight: renderPlan.frozenHeight }
  );

  switch (hit.region) {
    case 'corner':
      selectionState.selectAll();
      break;
    case 'colHeader':
      selectionState.selectColumn(hit.col);
      break;
    case 'rowHeader':
      selectionState.selectRow(hit.row);
      break;
    case 'colResize':
      startColResize(hit.resizeIndex, e);
      break;
    case 'rowResize':
      startRowResize(hit.resizeIndex, e);
      break;
    case 'cell':
      handleCellMouseDown(hit.row, hit.col, e);
      break;
  }
}

function handleMouseMove(e) {
  const hit = hitTestEngine.hitTest(...);

  // Update cursor
  currentCursor = hitTestEngine.getCursor(hit);

  // Extend selection if dragging
  if (selectionState.isSelecting && hit.region === 'cell') {
    selectionState.extendSelection(hit.row, hit.col);
  }

  // Track hovered cell for canvas hover highlight (optional)
  hoveredRow = hit.row;
  hoveredCol = hit.col;
}
```

### 1.3 — Rendering Pipeline

The rendering pipeline is driven by Svelte `$effect` blocks:

```js
// Effect 1: Build paint data when data changes
$effect(() => {
  // Touch reactive dependencies
  const cells = sheetStore?.cells;
  const bordersVer = sheetStore?.bordersVersion;
  const mergeVer = renderContext?.mergeEngine?.version;
  const sel = selectionState.range;
  const anch = selectionState.anchor;
  const plan = renderPlan;

  if (!plan || !virtualizer || !sheetStore) return;

  // Build paint data for each pane
  untrack(() => {
    bodyPaintData.build({ rowRange: plan.plans.body.rowRange, ... });
    if (plan.plans.top.rowRange.count > 0) topPaintData.build({ ... });
    if (plan.plans.left.colRange.count > 0) leftPaintData.build({ ... });
    if (plan.plans.corner.rowRange.count > 0) cornerPaintData.build({ ... });

    renderScheduler.invalidateAll();
  });
});

// Effect 2: Invalidate on scroll (scroll changes visible range → new paint data)
$effect(() => {
  virtualizer?.scrollTop;
  virtualizer?.scrollLeft;
  // Scroll triggers renderPlan change which triggers Effect 1
});

// The render scheduler calls this on RAF:
function performPaint(dirtyPanes) {
  if (!canvasRenderer || !canvasEl) return;

  canvasRenderer.clear();

  // Paint each dirty pane
  if (dirtyPanes.has('body')) {
    canvasRenderer.paintPane(bodyPaintData, {
      clipX: HEADER_WIDTH + renderPlan.frozenWidth,
      clipY: HEADER_HEIGHT + renderPlan.frozenHeight,
      clipW: renderPlan.bodyViewportWidth,
      clipH: renderPlan.bodyViewportHeight,
      ...
    });
  }

  if (dirtyPanes.has('top') && topPaintData.count > 0) {
    canvasRenderer.paintPane(topPaintData, { ... });
  }

  if (dirtyPanes.has('left') && leftPaintData.count > 0) {
    canvasRenderer.paintPane(leftPaintData, { ... });
  }

  if (dirtyPanes.has('corner') && cornerPaintData.count > 0) {
    canvasRenderer.paintPane(cornerPaintData, { ... });
  }

  // Paint sticky table headers onto canvas
  const stickyHeaders = renderContext?.getStickyTableHeaders(...);
  if (stickyHeaders?.length > 0) {
    canvasRenderer.paintStickyHeaders(stickyHeaders, { ... });
  }
}
```

### 1.4 — Selection & Anchor DOM Overlays

The selection fill (blue tint) is painted on canvas. The selection border (2px solid blue rectangle) and anchor border are thin DOM `<div>` elements positioned absolutely:

```js
let selectionBounds = $derived.by(() => {
  if (!selection || !virtualizer) return null;
  // Compute pixel rect for the selection range, accounting for pane/scroll
  return computeSelectionRect(selection, virtualizer, renderPlan);
});

let selectionBorderStyle = $derived.by(() => {
  if (!selectionBounds) return '';
  return `left:${selectionBounds.left}px; top:${selectionBounds.top}px; ` +
         `width:${selectionBounds.width}px; height:${selectionBounds.height}px;`;
});
```

### 1.5 — `GridOverlays.svelte` Simplification

**File:** `src/components/spreadsheet/grid/GridOverlays.svelte` (heavy simplify)

This component is drastically simplified. It no longer renders selection fill or cell content. It only provides:

1. Cell editor input positioning and lifecycle
2. Formula colored overlay (for formula editing mode)
3. `FormulaValuePopup`

The selection border and anchor outline move up to `Grid.svelte` directly (simpler positioning since they're just absolutely-positioned divs).

---

## Phase 2: Table & Repeater Canvas Rendering

### 2.1 — Table Header Rendering

Table headers are painted on canvas by `CanvasRenderer`:

- Background: `#f1f5f9` (theme color)
- Bottom border: 2px solid `#94a3b8`
- Text: bold, `#334155`, left-aligned
- Sort icon: `▲` or `▼` character painted as text on the right side

The filter button icon (`☰`) is also painted on canvas. When clicked (detected via `HitTestEngine`), a DOM `TableFilterPopover` is mounted at the correct position.

**Hit test for table headers:**

```js
// In handleMouseDown:
if (hit.region === 'cell') {
  const cellType = renderContext.getCellType(hit.row, hit.col);

  if (cellType === CELL_TYPE.TABLE_HEADER) {
    const info = renderContext.tableManager.getCellInfo(hit.row, hit.col);

    // Check if click is on the filter icon region (right 18px of cell)
    const cellRect = getCellRect(hit.row, hit.col);
    const localX = mouseX - cellRect.left;
    if (localX > cellRect.width - 20) {
      // Open filter popover
      openFilterPopover(info.table, info.colDef, cellRect);
    } else {
      // Toggle sort
      handleSortClick(info.table, info.colDef);
    }
    return;
  }

  // ... normal cell handling
}
```

### 2.2 — Table Data Rendering

Table data cells are painted identically to regular cells but with values sourced from `TableManager.getCellDisplayValue()`. The `CellPaintData.build()` method already handles this through `SheetRenderContext.getDisplayValue()`.

Conditional formatting for table data cells:
- Column-level conditional formats are evaluated during `CellPaintData.build()`
- Results are stored in `bgColors[]` and `textColors[]` arrays
- No special canvas logic needed

### 2.3 — Table Entry Row

Entry row cells are painted on canvas with a light grey background and placeholder text. When a user clicks an entry cell:

1. `HitTestEngine` identifies it as `CELL_TYPE.TABLE_ENTRY`
2. A DOM `<input>` is mounted at the cell's pixel position
3. On blur/Enter, the input commits via `table.setEntryValue()` / `table.commitEntry()`
4. DOM input is removed, canvas repaints

```js
let focusedEntryCell = $state(null); // { row, col, table, colDef, rect }

// In handleCellMouseDown:
if (cellType === CELL_TYPE.TABLE_ENTRY) {
  const info = renderContext.tableManager.getCellInfo(hit.row, hit.col);
  const rect = getCellRect(hit.row, hit.col);
  focusedEntryCell = { row: hit.row, col: hit.col, table: info.table, colDef: info.colDef, rect };
  return;
}
```

### 2.4 — Repeater Cells

Repeater cells are regular cells with mapped coordinates. During `CellPaintData.build()`, the `SheetRenderContext.getDisplayValue()` call already resolves repeater context and evaluates formulas with `$rep`. No special canvas treatment needed.

### 2.5 — Sticky Table Headers (Canvas)

When an inline table's header row scrolls past the top of the viewport:

1. `renderContext.getStickyTableHeaders()` detects this condition (unchanged logic)
2. The `CanvasRenderer.paintStickyHeaders()` method paints the header row onto the canvas in the frozen-top clip region
3. This paints over whatever body content is at that Y position, creating the "sticky" effect

```js
paintStickyHeaders(stickyHeaders, options) {
  for (const header of stickyHeaders) {
    // Paint at y = frozenHeight (top of body area), regardless of scroll
    // Paint background, text, sort icons, filter icon for each column
    this.#paintStickyHeaderRow(header.table, header.columns, {
      x: header.leftPx - options.scrollLeft + options.headerWidth,
      y: options.headerHeight,
      width: header.widthPx,
      height: header.heightPx,
    });
  }
}
```

### 2.6 — Viewport-mode Tables/Repeaters

Viewport-mode tables and repeaters currently render as positioned DOM overlays. In the canvas model:

- **Data display:** Painted on canvas within their anchor rect
- **Entry row:** DOM overlay input on focus (same as inline entry)
- **Filter popovers:** DOM overlay (same as inline)

During `CellPaintData.build()`, viewport-occupied cells (`CELL_TYPE.VIEWPORT_OCCUPIED`) are skipped. Instead, a separate paint pass handles viewport panels:

```js
// In performPaint():
for (const panel of renderContext.viewportPanels) {
  const rect = virtualizer.getCellRangeRect(...);
  // Paint panel content into the body canvas clip region
  canvasRenderer.paintViewportPanel(panel, rect, options);
}
```

---

## Phase 3: PDF Print Engine

### 3.1 — New Dependency: jsPDF

**File:** `package.json` (add dependency)

```json
{
  "dependencies": {
    "jspdf": "^2.5.2"
  }
}
```

### 3.2 — `CanvasPrintEngine` Class

**New file:** `src/stores/spreadsheet/rendering/CanvasPrintEngine.js`

Replaces the current `PrintPreview.svelte` + browser print approach.

```js
import { jsPDF } from 'jspdf';

/**
 * CanvasPrintEngine - Generates PDF from spreadsheet data using canvas rendering.
 *
 * Uses the same CanvasRenderer that paints the on-screen grid, but targets
 * an offscreen canvas at print resolution (300 DPI).
 *
 * ## Process
 * 1. Compute page breaks using existing PrintEngine.computePageBreaks()
 * 2. For each page:
 *    a. Create offscreen canvas at page pixel dimensions (300 DPI)
 *    b. Build CellPaintData for the page's cell range
 *    c. Paint using CanvasRenderer
 *    d. Export canvas as image and add to jsPDF page
 * 3. Return PDF blob
 */
export class CanvasPrintEngine {
  #printEngine;  // existing PrintEngine for page break computation

  constructor() {
    this.#printEngine = new PrintEngine();
  }

  /**
   * Generate a PDF blob for the current sheet.
   *
   * @param {Object} params
   * @param {Object} params.printSettings
   * @param {SheetStore} params.sheetStore
   * @param {SheetRenderContext} params.renderContext
   * @param {SpreadsheetSession} params.session
   * @param {AxisMetrics} params.rowMetrics
   * @param {AxisMetrics} params.colMetrics
   * @param {SelectionState} params.selectionState
   * @returns {Promise<Blob>} PDF blob
   */
  async generatePDF(params) {
    const { printSettings, sheetStore, renderContext, session,
            rowMetrics, colMetrics } = params;

    const totalRows = renderContext?.effectiveRowCount ?? sheetStore.rowCount;
    const totalCols = renderContext?.effectiveColCount ?? sheetStore.colCount;

    // 1. Compute page breaks
    const { rowBreaks, colBreaks } = this.#printEngine.computePageBreaks(
      printSettings, rowMetrics, colMetrics, totalRows, totalCols
    );

    // 2. Determine page dimensions
    const orientation = printSettings.orientation ?? 'portrait';
    const paperSize = this.#getPaperSizeMM(printSettings.paperSize ?? 'A4');
    const printDPI = 300;
    const pxPerMM = printDPI / 25.4;

    const pageWidthMM = orientation === 'landscape' ? paperSize.height : paperSize.width;
    const pageHeightMM = orientation === 'landscape' ? paperSize.width : paperSize.height;
    const marginTop = printSettings.marginTop ?? 10;
    const marginBottom = printSettings.marginBottom ?? 10;
    const marginLeft = printSettings.marginLeft ?? 10;
    const marginRight = printSettings.marginRight ?? 10;

    const printableWidthPx = (pageWidthMM - marginLeft - marginRight) * pxPerMM;
    const printableHeightPx = (pageHeightMM - marginTop - marginBottom) * pxPerMM;

    // 3. Create jsPDF document
    const pdf = new jsPDF({
      orientation,
      unit: 'mm',
      format: [pageWidthMM, pageHeightMM],
    });

    // 4. Create offscreen canvas + renderer
    const offscreen = new OffscreenCanvas(
      Math.ceil(printableWidthPx),
      Math.ceil(printableHeightPx)
    );
    const renderer = new CanvasRenderer(offscreen);
    renderer.setDPR(1); // We handle DPI via canvas size
    renderer.resize(printableWidthPx, printableHeightPx);

    // 5. Build CellPaintData for each page and render
    const paintData = new CellPaintData();
    let isFirstPage = true;

    for (let ri = 0; ri < rowBreaks.length; ri++) {
      for (let ci = 0; ci < colBreaks.length; ci++) {
        const startRow = rowBreaks[ri];
        const endRow = ri + 1 < rowBreaks.length
          ? rowBreaks[ri + 1] - 1
          : (printSettings.areaEndRow ?? totalRows - 1);
        const startCol = colBreaks[ci];
        const endCol = ci + 1 < colBreaks.length
          ? colBreaks[ci + 1] - 1
          : (printSettings.areaEndCol ?? totalCols - 1);

        // Build paint data for this page's range
        paintData.build({
          rowRange: { start: startRow, end: endRow, count: endRow - startRow + 1 },
          colRange: { start: startCol, end: endCol, count: endCol - startCol + 1 },
          rowMetrics, colMetrics, renderContext, sheetStore, session,
          selectionState: null, // no selection in print
          formulaEditState: null,
          scrollX: rowMetrics.offsetOf(startRow),
          scrollY: colMetrics.offsetOf(startCol),
        });

        // Scale factor to fit content into printable area
        const contentWidth = colMetrics.offsetOf(endCol + 1) - colMetrics.offsetOf(startCol);
        const contentHeight = rowMetrics.offsetOf(endRow + 1) - rowMetrics.offsetOf(startRow);
        const scaleX = printableWidthPx / contentWidth;
        const scaleY = printableHeightPx / contentHeight;
        const scale = Math.min(scaleX, scaleY, printDPI / 96); // don't scale up beyond print DPI

        // Paint
        renderer.clear();
        renderer.paintPane(paintData, {
          clipX: 0, clipY: 0,
          clipW: printableWidthPx, clipH: printableHeightPx,
          offsetX: colMetrics.offsetOf(startCol),
          offsetY: rowMetrics.offsetOf(startRow),
          paintGridlines: printSettings.showGridLines ?? true,
          paintSelection: false,
          scale,
        });

        // Add page to PDF
        if (!isFirstPage) pdf.addPage();
        isFirstPage = false;

        const imgData = offscreen.transferToImageBitmap
          ? await createImageBitmap(offscreen).then(bmp => {
              // Convert to data URL via temporary canvas
              const tmp = document.createElement('canvas');
              tmp.width = offscreen.width;
              tmp.height = offscreen.height;
              tmp.getContext('2d').drawImage(bmp, 0, 0);
              return tmp.toDataURL('image/png');
            })
          : offscreen.getContext('2d').canvas.toDataURL('image/png');

        pdf.addImage(imgData, 'PNG',
          marginLeft, marginTop,
          pageWidthMM - marginLeft - marginRight,
          pageHeightMM - marginTop - marginBottom
        );
      }
    }

    // 6. Return blob
    renderer.destroy();
    return pdf.output('blob');
  }

  /**
   * Generate and trigger download of a PDF.
   */
  async downloadPDF(params, filename = 'spreadsheet.pdf') {
    const blob = await this.generatePDF(params);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  #getPaperSizeMM(key) {
    const sizes = {
      A4: { width: 210, height: 297 },
      letter: { width: 215.9, height: 279.4 },
      legal: { width: 215.9, height: 355.6 },
      A3: { width: 297, height: 420 },
      A5: { width: 148, height: 210 },
    };
    return sizes[key] ?? sizes.A4;
  }
}
```

### 3.3 — Update PrintPreview / Menu Integration

- **Delete** `src/components/spreadsheet/PrintPreview.svelte`
- **Add** "Export PDF" / "Print" action in `MenuBar.svelte` that calls `CanvasPrintEngine.downloadPDF()`
- **Remove** `@media print` CSS for the old DOM-based print preview
- Optionally add a print preview dialog that shows rendered page thumbnails before exporting

---

## Phase 4: Performance Optimizations

### 4.1 — Frozen Pane Bitmap Caching

Frozen panes (corner, top, left) change infrequently (only when frozen region cell data changes, not on scroll). Cache their rendered output:

```js
class FrozenPaneCache {
  #cornerBitmap = null;   // ImageBitmap or OffscreenCanvas
  #topBitmap = null;
  #leftBitmap = null;
  #cornerDirty = true;
  #topDirty = true;
  #leftDirty = true;

  invalidate(pane) { ... }

  // Returns cached bitmap or null if dirty
  getBitmap(pane) {
    if (pane === 'corner' && !this.#cornerDirty) return this.#cornerBitmap;
    return null;
  }

  // Store newly rendered bitmap
  setBitmap(pane, bitmap) { ... }
}
```

In the paint loop:
```js
// For frozen panes, check cache first
const cachedCorner = frozenCache.getBitmap('corner');
if (cachedCorner) {
  ctx.drawImage(cachedCorner, cornerClipX, cornerClipY);
} else {
  canvasRenderer.paintPane(cornerPaintData, { ... });
  frozenCache.setBitmap('corner', captureRegion(cornerClipX, cornerClipY, cornerW, cornerH));
}
```

### 4.2 — Scroll Bitmap Blitting

On scroll, instead of repainting the entire body pane:

1. Calculate scroll delta (dx, dy in pixels)
2. If delta is small enough (< 50% of viewport), use `ctx.drawImage()` to shift existing content
3. Only paint the newly revealed strip (row or column strip)

```js
function optimizedScrollPaint(prevScrollX, prevScrollY, newScrollX, newScrollY) {
  const dx = newScrollX - prevScrollX;
  const dy = newScrollY - prevScrollY;

  // If scroll delta is too large, full repaint
  if (Math.abs(dx) > bodyWidth * 0.5 || Math.abs(dy) > bodyHeight * 0.5) {
    return fullRepaint();
  }

  // Blit existing content
  ctx.save();
  ctx.beginPath();
  ctx.rect(bodyClipX, bodyClipY, bodyClipW, bodyClipH);
  ctx.clip();
  ctx.drawImage(canvas, -dx * dpr, -dy * dpr);

  // Paint newly revealed strip
  if (dy > 0) {
    // Scrolled down — paint bottom strip
    paintStrip('bottom', dy);
  } else if (dy < 0) {
    // Scrolled up — paint top strip
    paintStrip('top', -dy);
  }
  // Similar for horizontal

  ctx.restore();
}
```

### 4.3 — Dirty Region Tracking

Track which cells changed and only repaint their rectangles:

```js
class DirtyTracker {
  #dirtyRects = [];  // Array of { x, y, w, h }
  #fullDirty = false;

  markCellDirty(row, col) {
    const rect = getCellRect(row, col);
    this.#dirtyRects.push(rect);
  }

  markFullDirty() {
    this.#fullDirty = true;
  }

  getDirtyRegion() {
    if (this.#fullDirty) return null; // full repaint
    if (this.#dirtyRects.length === 0) return []; // nothing to paint

    // Merge overlapping rects into a bounding box
    return mergeBoundingBox(this.#dirtyRects);
  }

  clear() {
    this.#dirtyRects = [];
    this.#fullDirty = false;
  }
}
```

### 4.4 — Text Measurement Cache Sharing

The existing `measureTextWidth()` cache in `SheetRenderContext.svelte.js` uses a separate canvas context. Share this with `CanvasRenderer`:

```js
// In CanvasRenderer:
#textMeasureCache = new Map();

#measureText(text, font) {
  const key = `${text}|${font}`;
  let width = this.#textMeasureCache.get(key);
  if (width !== undefined) return width;

  this.#ctx.save();
  this.#ctx.font = font;
  width = this.#ctx.measureText(text).width;
  this.#ctx.restore();

  this.#textMeasureCache.set(key, width);

  // Evict if cache too large
  if (this.#textMeasureCache.size > 20000) {
    const keys = this.#textMeasureCache.keys();
    for (let i = 0; i < 10000; i++) {
      this.#textMeasureCache.delete(keys.next().value);
    }
  }

  return width;
}
```

### 4.5 — DPR-Aware Resize

Watch `window.devicePixelRatio` changes:

```js
// In Grid.svelte onMount:
const dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
function onDPRChange() {
  canvasRenderer.setDPR(window.devicePixelRatio);
  canvasRenderer.resize(containerWidth, containerHeight);
  renderScheduler.invalidateAll();
}
dprQuery.addEventListener('change', onDPRChange);
```

---

## Phase 5: Code Cleanup & File Changes

### Files to DELETE

| File | Reason |
|------|--------|
| `src/components/spreadsheet/grid/VirtualPane.svelte` | Replaced by canvas rendering |
| `src/components/spreadsheet/features/TableDataCell.svelte` | Painted on canvas |
| `src/components/spreadsheet/features/TableHeaderCell.svelte` | Painted on canvas (filter popover stays separate) |
| `src/components/spreadsheet/features/RepeaterViewport.svelte` | Painted on canvas |
| `src/components/spreadsheet/features/TableViewport.svelte` | Painted on canvas |
| `src/components/spreadsheet/cellTypes/CheckboxCell.svelte` | Painted on canvas |
| `src/components/spreadsheet/cellTypes/RatingCell.svelte` | Painted on canvas |
| `src/components/spreadsheet/PrintPreview.svelte` | Replaced by PDF engine |

### Files to HEAVILY MODIFY

| File | Changes |
|------|---------|
| `src/components/spreadsheet/Grid.svelte` | New canvas + overlay + event layer architecture |
| `src/components/spreadsheet/grid/GridOverlays.svelte` | Simplified to editor + formula popup only |
| `src/stores/spreadsheet/features/PrintEngine.js` | Keep page break logic, remove CSS generation |
| `src/stores/spreadsheet/features/SheetRenderContext.svelte.js` | Add `buildCellPaintData()` helper method |
| `src/stores/spreadsheet/cellTypes/index.js` | Add `paintCell` protocol to registry |
| `src/stores/spreadsheet/cellTypes/types/checkbox.js` | Add `paintCell()` method |
| `src/stores/spreadsheet/cellTypes/types/rating.js` | Add `paintCell()` method |
| `src/stores/spreadsheet/cellTypes/types/url.js` | Add `paintCell()` method |
| `src/app.css` | Remove `@media print` rules for old print preview |

### NEW Files

| File | Purpose |
|------|---------|
| `src/stores/spreadsheet/rendering/CanvasRenderer.js` | Main canvas paint engine |
| `src/stores/spreadsheet/rendering/RenderScheduler.js` | RAF-based paint batching |
| `src/stores/spreadsheet/rendering/CellPaintData.js` | Flat array cell data builder |
| `src/stores/spreadsheet/rendering/HitTestEngine.js` | Pixel → cell coordinate mapping |
| `src/stores/spreadsheet/rendering/CanvasPrintEngine.js` | PDF generation using jsPDF |
| `src/stores/spreadsheet/rendering/index.js` | Barrel exports |
| `src/stores/spreadsheet/cellTypes/painters.js` | Shared canvas drawing utilities (checkbox, star, etc.) |

### Files UNCHANGED

| File | Reason |
|------|--------|
| All stores (`SheetStore`, `SelectionState`, `EditSessionState`, `SpreadsheetSession`, etc.) | Data layer, no rendering |
| All formula engine files | Pure computation |
| `GridVirtualizer.svelte.js` and `AxisMetrics.svelte.js` | Still compute visible ranges |
| `ColHeaders.svelte` and `RowHeaders.svelte` | Stay as DOM |
| All toolbar components | Not grid rendering |
| `ContextMenu.svelte` | DOM popover |
| `FormulaBar.svelte` | DOM component |
| `TableStore.svelte.js`, `TableManager.svelte.js`, `RepeaterEngine.svelte.js` | Data stores |
| `TableEntryBox.svelte`, `TableEntryCell.svelte` | Entry form (will be simplified but conceptually same) |
| `TableFilterPopover.svelte` | DOM popover |
| `TableCreateDialog.svelte`, `RepeaterCreateDialog.svelte` | DOM dialogs |
| `MergeEngine.svelte.js` | Data store |
| `ClipboardManager.svelte.js` | Clipboard logic |

---

## Implementation Order

### Step 1: Infrastructure (no visual changes)
1. Add `jspdf` dependency to `package.json`
2. Create `src/stores/spreadsheet/rendering/` directory
3. Implement `CellPaintData.js`
4. Implement `CanvasRenderer.js` (gridlines + text + backgrounds)
5. Implement `RenderScheduler.js`
6. Implement `HitTestEngine.js`
7. Add `paintCell()` to checkbox and rating cell type descriptors
8. Create `painters.js` with canvas drawing utilities

### Step 2: Canvas grid (main visual switch)
1. Rewrite `Grid.svelte` with canvas + overlay + event layer
2. Simplify `GridOverlays.svelte` to editor-only
3. Wire paint data building → render scheduler → canvas paint
4. Wire event layer → hit test engine → existing handlers
5. Test basic cell rendering, scrolling, selection, editing

### Step 3: Tables & Repeaters on canvas
1. Add table header painting to `CanvasRenderer`
2. Add table data cell painting
3. Add table entry row placeholder painting + focused DOM input
4. Add sticky table header painting
5. Add repeater cell painting
6. Add viewport panel painting
7. Wire filter popover DOM overlay to hit test

### Step 4: PDF print
1. Implement `CanvasPrintEngine.js`
2. Add "Export PDF" / "Print" menu action
3. Delete `PrintPreview.svelte`
4. Remove old print CSS

### Step 5: Performance optimizations
1. Frozen pane bitmap caching
2. Scroll bitmap blitting
3. Dirty region tracking
4. Text measurement cache consolidation
5. DPR-aware resize

### Step 6: Cleanup
1. Delete removed files
2. Remove dead imports
3. Update any remaining references to deleted components
4. Final testing pass

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Text rendering quality (blurry) | Medium | Use `devicePixelRatio` scaling, sub-pixel alignment |
| Right-to-left (RTL) text | Low | Use `ctx.direction = 'rtl'` when needed |
| Performance regression during scroll | Low | Scroll bitmap blitting, overscan |
| Complex cell types (future dropdowns) | Low | Plugin `paintCell()` architecture handles this |
| Canvas memory on large displays | Low | Single canvas is ~16-20MB max at 4K + Retina |
| Print quality | Low | 300 DPI offscreen canvas + jsPDF vector text option |
| Browser compat | Very Low | Canvas 2D is universally supported |

---

## Testing Checklist

- [ ] Regular cell text rendering (all fonts, sizes, colors, alignment)
- [ ] Bold, italic, underline, strikethrough text decoration
- [ ] Cell background colors
- [ ] Cell borders (all styles, widths, colors)
- [ ] Merged cells (spanning multiple rows/cols)
- [ ] Text overflow into empty adjacent cells
- [ ] Wrap text cells
- [ ] Checkbox cells (checked/unchecked)
- [ ] Rating cells (filled/unfilled stars)
- [ ] URL cells (blue underlined text)
- [ ] Number/currency/percent/date formatting
- [ ] Selection highlight (blue fill)
- [ ] Anchor cell outline
- [ ] Cell editor input (text, formula, date picker)
- [ ] Formula reference highlights
- [ ] Formula value popup
- [ ] Inline table headers (sort icon, filter button)
- [ ] Inline table data rows
- [ ] Inline table entry row (canvas + focused DOM input)
- [ ] Sticky table headers (on scroll)
- [ ] Viewport-mode tables
- [ ] Repeater cells (vertical/horizontal)
- [ ] Frozen rows and columns
- [ ] Scroll performance (60fps target)
- [ ] Column/row resize (drag handles)
- [ ] Context menu positioning
- [ ] Keyboard navigation (arrows, tab, enter)
- [ ] Copy/paste/cut
- [ ] Undo/redo
- [ ] PDF export (page breaks, margins, orientation)
- [ ] Retina/HiDPI display crispness
- [ ] Window resize
- [ ] Sheet switching
