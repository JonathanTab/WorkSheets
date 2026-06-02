/**
 * CanvasRenderer - Paints spreadsheet cells onto a single HTMLCanvasElement.
 *
 * ## DPR / Retina handling
 * The canvas backing store is sized at cssWidth × devicePixelRatio, but all
 * paint coordinates are in CSS pixels. Inside each paintPane() call we apply
 * ctx.scale(dpr, dpr) within a save/restore so the caller never has to think
 * about physical pixels.
 *
 * ## Extensible cell types
 * If a CellTypeRegistry descriptor defines paintCell(ctx, value, config, rect, style),
 * the renderer will call it instead of the built-in text renderer. This allows
 * future cell types (dropdowns, avatars, progress bars) to register their own
 * canvas paint logic.
 */

import { CellTypeRegistry } from '../cellTypes/index.js';
import { perfMon } from '../perf/PerfMonitor.js';
import { buildWrappedLines } from './RichTextLayout.js';
import { paintBordersCanvas } from './BorderGeometry.js';
import { getOverflowBorderSpec, getShadowBorderSpec } from './OverflowGeometry.js';
import { ptToPx, getFontMetrics, computeBaselineY, computeBaselineYForBlock } from './fontUnits.js';

// Inner padding used by the cell text painters. Symmetric on all four sides so
// 'top' / 'bottom' / 'middle' alignments share the same clamp math.
const CELL_PAD = 2;
const CELL_PAD_X = 4;

// ─── Theme ────────────────────────────────────────────────────────────────────
const DEFAULT_THEME = {
    gridline: '#e2e8f0',
    cellBg: '#ffffff',
    defaultText: '#1e293b',
    defaultFontSize: 10,
    defaultFontFamily: 'system-ui, -apple-system, sans-serif',
    tableHeaderBg: '#f1f5f9',
    tableHeaderText: '#334155',
    tableHeaderBorder: '#94a3b8',
    entryPlaceholderText: '#94a3b8',
    filterIconColor: '#94a3b8',
    filterActiveColor: '#475569',
    linkColor: '#1a73e8',
    zebraFill: 'rgba(0,0,0,0.018)',
    formulaColBg: 'rgba(0,0,0,0.015)',
};

const FILTER_BTN_WIDTH = 20; // CSS px, area reserved for filter icon on the right

export class CanvasRenderer {
    /** @type {HTMLCanvasElement | OffscreenCanvas | null} */
    #canvas = null;

    /** @type {CanvasRenderingContext2D | null} */
    #ctx = null;

    /** @type {number} */
    #dpr = 1;

    /** @type {number} CSS width */
    #cssWidth = 0;

    /** @type {number} CSS height */
    #cssHeight = 0;

    /** @type {typeof DEFAULT_THEME} */
    #theme = { ...DEFAULT_THEME };

    /** @type {string} Last font string set on ctx — avoids redundant ctx.font assignments */
    #lastFont = '';

    /** @type {Map<string, Array>} Cache for word-wrap layout results */
    #wrapCache = new Map();
    #wrapCacheMax = 500;

    /**
     * @param {HTMLCanvasElement | OffscreenCanvas} canvas
     */
    constructor(canvas) {
        this.#canvas = canvas;
        if (canvas) {
            // alpha:false allows sub-pixel antialiasing for sharper text and
            // avoids RGBA compositing overhead on each frame.
            // The print engine passes OffscreenCanvas which also supports alpha:false.
            this.#ctx = canvas.getContext('2d', { alpha: false });
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Resize the canvas backing store for a new CSS size and DPR.
     * Must be called on mount, on container resize, and on DPR change.
     *
     * @param {number} cssWidth
     * @param {number} cssHeight
     * @param {number} [dpr]  Defaults to window.devicePixelRatio
     */
    resize(cssWidth, cssHeight, dpr) {
        this.#dpr = dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;
        this.#cssWidth = cssWidth;
        this.#cssHeight = cssHeight;

        if (!this.#canvas) return;

        const physW = Math.round(cssWidth * this.#dpr);
        const physH = Math.round(cssHeight * this.#dpr);

        if (this.#canvas.width !== physW) this.#canvas.width = physW;
        if (this.#canvas.height !== physH) this.#canvas.height = physH;

        // Set CSS size only on real DOM canvas
        if (this.#canvas instanceof HTMLCanvasElement) {
            this.#canvas.style.width = cssWidth + 'px';
            this.#canvas.style.height = cssHeight + 'px';
        }
    }

    /**
     * Clear the entire canvas (physical pixels, no transform applied).
     * Uses fillRect with the background colour rather than clearRect so that
     * the alpha:false canvas never shows black pixels between paints.
     */
    clear() {
        if (!this.#ctx || !this.#canvas) return;
        this.#ctx.fillStyle = this.#theme.cellBg;
        this.#ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
    }

    /**
     * Clear a single pane region. Used for partial (non-full-canvas) repaints.
     * Coordinates are CSS pixels; internally scaled to physical pixels.
     *
     * @param {number} clipX CSS px from canvas left
     * @param {number} clipY CSS px from canvas top
     * @param {number} clipW CSS px width
     * @param {number} clipH CSS px height
     */
    clearPane(clipX, clipY, clipW, clipH) {
        if (!this.#ctx || !this.#canvas) return;
        const dpr = this.#dpr;
        this.#ctx.fillStyle = this.#theme.cellBg;
        this.#ctx.fillRect(
            Math.round(clipX * dpr),
            Math.round(clipY * dpr),
            Math.round(clipW * dpr),
            Math.round(clipH * dpr),
        );
    }

    /**
     * Shift a pane's pixels by (dx, dy) for incremental scroll rendering.
     * After calling this, only the newly exposed strip needs repainting via paintPane.
     *
     * Uses self-blit: ctx.drawImage(canvas → same canvas). Per the HTML spec the source
     * region is snapshotted before the destination is modified, so this is safe and
     * supported in all major browsers.
     *
     * The exposed strip is filled with the background colour so paintPane can overlay it.
     *
     * @param {number} dx  Scroll delta in CSS px (positive = scrolled right → content shifts left)
     * @param {number} dy  Scroll delta in CSS px (positive = scrolled down → content shifts up)
     * @param {number} clipX  Pane left in CSS px
     * @param {number} clipY  Pane top in CSS px
     * @param {number} clipW  Pane width in CSS px
     * @param {number} clipH  Pane height in CSS px
     */
    blitScroll(dx, dy, clipX, clipY, clipW, clipH) {
        const ctx = this.#ctx;
        const canvas = this.#canvas;
        if (!ctx || !canvas || (dx === 0 && dy === 0)) return;

        const dpr = this.#dpr;
        const pxX = Math.round(clipX * dpr);
        const pxY = Math.round(clipY * dpr);
        const pxW = Math.round(clipW * dpr);
        const pxH = Math.round(clipH * dpr);
        const pxDx = Math.round(dx * dpr);
        const pxDy = Math.round(dy * dpr);

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0); // physical pixel coords, no DPR scale

        // Clip to the pane so the blit doesn't bleed into adjacent frozen panes
        ctx.beginPath();
        ctx.rect(pxX, pxY, pxW, pxH);
        ctx.clip();

        // Self-blit: shift existing pixels by the scroll delta
        ctx.drawImage(canvas, pxX, pxY, pxW, pxH, pxX - pxDx, pxY - pxDy, pxW, pxH);

        // Fill the newly exposed strip(s) with background so paintPane can repaint them
        ctx.fillStyle = this.#theme.cellBg;
        if (pxDy > 0) {
            ctx.fillRect(pxX, pxY + pxH - pxDy, pxW, pxDy); // bottom strip
        } else if (pxDy < 0) {
            ctx.fillRect(pxX, pxY, pxW, -pxDy); // top strip
        }
        if (pxDx > 0) {
            ctx.fillRect(pxX + pxW - pxDx, pxY, pxDx, pxH); // right strip
        } else if (pxDx < 0) {
            ctx.fillRect(pxX, pxY, -pxDx, pxH); // left strip
        }

        ctx.restore();
    }

    /**
     * Merge partial theme overrides.
     * @param {Partial<typeof DEFAULT_THEME>} overrides
     */
    updateTheme(overrides) {
        Object.assign(this.#theme, overrides);
    }

    get theme() { return this.#theme; }

    destroy() {
        this.#canvas = null;
        this.#ctx = null;
    }

    // ─── Pane painting ────────────────────────────────────────────────────────

    /**
     * Paint one grid pane (body, top, left, or corner).
     *
     * Sets up a clip region for the pane, fills the background, then paints
     * each cell from the provided paint data array.
     *
     * @param {import('./CellPaintData.js').CellPaintItem[]} cells
     * @param {{clipX:number, clipY:number, clipW:number, clipH:number, showGridLines?:boolean}} options
     *   All values in CSS pixels (relative to the canvas element's top-left).
     *   showGridLines defaults to true; pass false to suppress default gridlines (e.g. for PDF export).
     */
    paintPane(cells, options) {
        const ctx = this.#ctx;
        if (!ctx || !cells || cells.length === 0) return;

        const { clipX, clipY, clipW, clipH, showGridLines = true } = options;
        if (clipW <= 0 || clipH <= 0) return;

        const _perfT = perfMon.enabled ? performance.now() : 0;

        const dpr = this.#dpr;

        // Reset font cache at the start of each pane so stale state from a prior
        // pane (or other canvas users) doesn't cause us to skip a needed font set.
        this.#lastFont = '';

        ctx.save();
        ctx.scale(dpr, dpr); // from here on, all coords are in CSS pixels

        try {
            // ── Pass 1: cell backgrounds, content, and gridlines ─────────────────
            // Tight clip to the pane region.
            ctx.save();
            ctx.beginPath();
            ctx.rect(clipX, clipY, clipW, clipH);
            ctx.clip();

            // Fill pane background
            ctx.fillStyle = this.#theme.cellBg;
            ctx.fillRect(clipX, clipY, clipW, clipH);

            // Paint each cell (backgrounds, content, overlays)
            for (const cell of cells) {
                this.#paintCell(ctx, cell);
            }

            // Batch-draw default gridlines in one path to minimise stroke() calls.
            // gridlineOnly cells (overflow shadows) draw only bottom edges; right edges
            // are suppressed so no intermediate column boundaries appear within an overflow span.
            // Overflow source cells draw their right edge at the full extended width.
            if (showGridLines) {
                // halfPx: offset in CSS pixels that maps to exactly 0.5 physical pixels.
                // At DPR=2 → 0.25 CSS px; at DPR=1.5 → 0.333 CSS px; at DPR=1 → 0.5 CSS px.
                // Using 0.5 (CSS px) at DPR=1.5 would land at 0.75 physical px — subpixel blur.
                const halfPx = 0.5 / dpr;
                ctx.beginPath();
                ctx.strokeStyle = this.#theme.gridline;
                ctx.lineWidth = 1 / dpr;
                for (const cell of cells) {
                    const { x, y, width, height, borders } = cell;
                    const spec = getOverflowBorderSpec(cell);
                    const gx = spec.boxX;
                    const gw = spec.boxWidth;
                    // Skip bottom gridline when the cell has a custom bottom border — the
                    // border renders on top anyway, but suppressing avoids the gridline
                    // bleeding through thin or dashed custom borders.
                    if (!borders?.bottom) {
                        ctx.moveTo(gx, y + height - halfPx);
                        ctx.lineTo(gx + gw, y + height - halfPx);
                    }
                    // right edge — suppressed for overflow shadow cells (gridlineOnly) and
                    // when the cell has a custom right border.
                    if (!cell.gridlineOnly && !borders?.right && !spec.suppressRightGridline) {
                        ctx.moveTo(gx + gw - halfPx, y);
                        ctx.lineTo(gx + gw - halfPx, y + height);
                    }
                }
                ctx.stroke();
            }

            ctx.restore(); // removes tight clip

            // ── Pass 2: custom borders ────────────────────────────────────────────
            // Strokes are inset half their width by paintBordersCanvas so they sit
            // ON the cell boundary, but corner overlap can extend up to half a
            // stroke past the cell edge — expand the clip by 4 CSS px (covers
            // widths up to ~8) so thick borders aren't clipped at pane seams.
            ctx.save();
            ctx.beginPath();
            ctx.rect(clipX - 4, clipY - 4, clipW + 8, clipH + 8);
            ctx.clip();

            // Save ctx state once for the whole pass — paintBordersCanvas resets
            // lineDash/lineCap on exit but other state (strokeStyle, lineWidth)
            // stays as the last cell's values; that's fine because every edge
            // sets them fresh.
            ctx.save();
            for (const cell of /** @type {import('./CellPaintData.js').CellPaintItem[]} */ (cells)) {
                if (!cell.borders) continue;
                const spec = cell.gridlineOnly
                    ? getShadowBorderSpec(cell)
                    : getOverflowBorderSpec(cell);
                if (spec.paintBorders) {
                    this.#paintCustomBorders(ctx, spec.paintBorders, spec.boxX, cell.y, spec.boxWidth, cell.height, dpr);
                }
            }
            ctx.restore();

            ctx.restore(); // removes expanded clip
        } finally {
            ctx.restore(); // removes the DPR scale — back to physical pixel space
        }

        if (perfMon.enabled) {
            perfMon.record('render.paintPane', performance.now() - _perfT);
            perfMon.record('render.cellsPerPane', cells.length);
        }
    }

    /**
     * Paint sticky table header (and entry) rows at the top of the scrollable
     * area when they've been scrolled past. Call after all pane paints.
     *
     * Each entry in `headers` comes from SheetRenderContext.getStickyTableHeaders()
     * and includes:
     *   leftPx, widthPx, headerHeightPx, entryHeightPx, showEntry, colWidths
     *
     * @param {Array<{table:any, leftPx:number, widthPx:number, headerHeightPx:number, entryHeightPx:number, showEntry:boolean, colWidths:number[]}>} headers
     * @param {{frozenWidth:number, frozenHeight:number, scrollLeft:number}} options
     */
    paintStickyHeaders(headers, options) {
        if (!headers?.length) return;
        const ctx = this.#ctx;
        if (!ctx) return;

        const { frozenWidth, frozenHeight, scrollLeft } = options;
        const dpr = this.#dpr;

        this.#lastFont = '';
        ctx.save();
        ctx.scale(dpr, dpr);

        try {
            for (const header of headers) {
                const rawX  = header.leftPx - scrollLeft;
                const canvasY = frozenHeight;

                const totalStickyH = header.headerHeightPx +
                    (header.showEntry ? header.entryHeightPx : 0);

                // Clip to the visible body area (don't overdraw frozen columns)
                const clipLeft = Math.max(rawX, frozenWidth);
                const clipRight = rawX + header.widthPx;
                const clipW = Math.max(0, clipRight - clipLeft);
                if (clipW <= 0) continue;

                ctx.save();
                ctx.beginPath();
                ctx.rect(clipLeft, canvasY, clipW, totalStickyH);
                ctx.clip();

                // 1. Paint header row
                let xCursor = rawX;
                for (let i = 0; i < header.table.columns.length; i++) {
                    const col  = header.table.columns[i];
                    const colW = header.colWidths?.[i] ?? 100;
                    this.#paintTableHeaderCell(ctx, {
                        colName:      col?.name ?? '',
                        filterActive: !!(col?.id && header.table.filters?.[col.id]),
                        x: xCursor,
                        y: canvasY,
                        width:  colW,
                        height: header.headerHeightPx,
                    });
                    xCursor += colW;
                }

                // 2. Paint entry row (if also scrolled past)
                if (header.showEntry) {
                    const entryY = canvasY + header.headerHeightPx;
                    xCursor = rawX;
                    for (let i = 0; i < header.table.columns.length; i++) {
                        const col  = header.table.columns[i];
                        const colW = header.colWidths?.[i] ?? 100;
                        this.#paintStickyEntryCell(ctx, {
                            col,
                            x: xCursor,
                            y: entryY,
                            width:  colW,
                            height: header.entryHeightPx,
                            entryBuffer: header.table.entryBuffer,
                        });
                        xCursor += colW;
                    }
                }

                // 3. Bottom shadow to indicate stickiness
                const shadowY = canvasY + totalStickyH;
                const shadowH = 5;
                const grad = ctx.createLinearGradient(0, shadowY, 0, shadowY + shadowH);
                grad.addColorStop(0, 'rgba(0,0,0,0.10)');
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.fillRect(clipLeft, shadowY, clipW, shadowH);

                ctx.restore();
            }
        } finally {
            ctx.restore();
        }
    }

    /**
     * Paint a single entry-row cell for a sticky table header overlay.
     * @param {CanvasRenderingContext2D} ctx
     * @param {{col:any, x:number, y:number, width:number, height:number, entryBuffer:object}} opts
     */
    #paintStickyEntryCell(ctx, opts) {
        const { col, x, y, width, height, entryBuffer } = opts;

        // Cell background
        ctx.fillStyle = this.#theme.cellBg;
        ctx.fillRect(x, y, width, height);

        const dpr = this.#dpr;
        const halfPx = 0.5 / dpr;
        const snap = (v) => Math.round(v * dpr) / dpr;

        // Gridlines (bottom + right)
        ctx.strokeStyle = this.#theme.gridline;
        ctx.lineWidth = 1 / dpr;
        ctx.beginPath();
        ctx.moveTo(x,               y + height - halfPx);
        ctx.lineTo(x + width,       y + height - halfPx);
        ctx.moveTo(x + width - halfPx, y);
        ctx.lineTo(x + width - halfPx, y + height);
        ctx.stroke();

        if (col?.isNonEntry) {
            // Formula column — show 'fx' hint
            const fxFont = `600 ${ptToPx(this.#theme.defaultFontSize)}px ${this.#theme.defaultFontFamily}`;
            if (fxFont !== this.#lastFont) { ctx.font = fxFont; this.#lastFont = fxFont; }
            ctx.fillStyle = 'rgba(100,116,139,0.35)';
            ctx.textBaseline = 'alphabetic';
            ctx.textAlign = 'center';
            const fxY = snap(computeBaselineY(y, height, 'middle', getFontMetrics(fxFont), CELL_PAD));
            ctx.fillText('fx', snap(x + width / 2), fxY);
            return;
        }

        const colId = col?.id;
        const value = colId != null ? (entryBuffer?.[colId] ?? null) : null;

        if (value != null && value !== '') {
            const font = `${ptToPx(this.#theme.defaultFontSize)}px ${this.#theme.defaultFontFamily}`;
            if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
            ctx.fillStyle = this.#theme.defaultText;
            ctx.textBaseline = 'alphabetic';
            ctx.textAlign = 'left';
            const vY = snap(computeBaselineY(y, height, 'middle', getFontMetrics(font), CELL_PAD));
            ctx.fillText(String(value), snap(x + CELL_PAD_X), vY, width - CELL_PAD_X * 2);
        }
    }

    // ─── Private: cell dispatch ───────────────────────────────────────────────

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintCell(ctx, cell) {
        // gridlineOnly = overflow-shadow cell; gridlines drawn separately, no content
        if (cell.gridlineOnly) return;

        const { x, y, width, height } = cell;
        if (width <= 0 || height <= 0) return;

        // 1. Background
        let bgColor = cell.bgColor || this.#theme.cellBg;

        // Zebra striping for table data rows
        if (cell.zebraRow && !cell.bgColor) {
            // Draw base color first, then overlay
            ctx.fillStyle = this.#theme.cellBg;
            ctx.fillRect(x, y, width, height);
            ctx.fillStyle = this.#theme.zebraFill;
            ctx.fillRect(x, y, width, height);
        } else {
            ctx.fillStyle = bgColor;
            ctx.fillRect(x, y, width, height);
        }

        // Formula column subtle tint
        if (cell.isFormulaCol) {
            ctx.fillStyle = this.#theme.formulaColBg;
            ctx.fillRect(x, y, width, height);
        }

        // Repeater copy cells (non-template): subtle overlay to hint read-only
        if (cell.isRepeaterCopy) {
            ctx.fillStyle = 'rgba(124,58,237,0.028)';
            ctx.fillRect(x, y, width, height);
        }

        // 2. Selection fills and formula highlights are now on the selection canvas
        //    (SelectionRenderer), not here. This lets selection changes repaint only
        //    the lightweight selection canvas without triggering buildPaneData.

        // 3. Default gridlines are drawn in a single batched stroke in paintPane()
        //    (not per-cell) to minimise canvas state changes.

        // 4. Custom borders — painted in a second pass in paintPane(), after grid lines.

        // 5. Data validation invalid — red outline
        if (cell.dvInvalid) {
            const _dpr = this.#dpr;
            const _off = 0.75 / _dpr;
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1.5 / _dpr;
            ctx.strokeRect(x + _off, y + _off, width - 2 * _off, height - 2 * _off);
        }

        // 8. Content — clip to cell interior before drawing (only when needed).
        // ctx.save()/restore() is expensive in Chrome (~8µs each). Plain single-line text
        // cells that fit within cell bounds skip this entirely; rich text, wrapText, merges,
        // and complex render types use it via the clipContent flag.
        if (cell.clipContent) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + 1, y + 1, width - 2, height - 2);
            ctx.clip();
            this.#paintCellContent(ctx, cell);
            ctx.restore();
            // ctx.restore() reverts ctx.font to the pre-save value, but #lastFont
            // still holds the last font set inside the save/restore block. Reset it
            // so the next cell doesn't skip a needed ctx.font assignment.
            this.#lastFont = '';
        } else {
            this.#paintCellContent(ctx, cell);
        }
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintCellContent(ctx, cell) {
        const { renderType } = cell;

        // Use pre-resolved descriptor from buildPaneData (avoids CellTypeRegistry lookup per cell)
        const descriptor = cell._descriptor;
        if (descriptor) {
            const rect = { x: cell.x, y: cell.y, width: cell.width, height: cell.height };
            const style = {
                bgColor: cell.bgColor,
                textColor: cell.textColor,
                bold: cell.bold,
                italic: cell.italic,
                fontSize: cell.fontSize,
                fontFamily: cell.fontFamily,
                hAlign: cell.hAlign,
                vAlign: cell.vAlign,
            };
            descriptor.paintCell(ctx, cell.rawValue ?? cell.displayValue, cell, rect, style, this.#theme);
            return;
        }

        // All typed cells with a paintCell descriptor are handled above.
        // Remaining renderTypes (text, number, date, etc.) render as text.
        this.#paintTextContent(ctx, cell);
    }

    // ─── Private: content painters ────────────────────────────────────────────

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {any} cell
     */
    #paintTextContent(ctx, cell) {
        if (cell.richTextRuns) {
            this.#paintRichTextContent(ctx, cell);
            return;
        }

        const text = cell.displayValue;

        // Placeholder text for empty entry cells (shown in italic, muted style)
        if ((text === '' || text == null) && cell.placeholderText) {
            const placeholderFont = `italic ${ptToPx(this.#theme.defaultFontSize * 0.9)}px ${this.#theme.defaultFontFamily}`;
            if (placeholderFont !== this.#lastFont) { ctx.font = placeholderFont; this.#lastFont = placeholderFont; }
            ctx.fillStyle = this.#theme.entryPlaceholderText || 'rgba(100,116,139,0.5)';
            ctx.textBaseline = 'alphabetic';
            ctx.textAlign = 'left';
            const _dpr = this.#dpr;
            const phMetrics = getFontMetrics(placeholderFont);
            const phY = computeBaselineY(cell.y, cell.height, 'middle', phMetrics, CELL_PAD);
            ctx.fillText(cell.placeholderText, cell.x + CELL_PAD_X, Math.round(phY * _dpr) / _dpr, cell.width - CELL_PAD_X * 2);
            if (cell.tableHeaderInfo) this.#paintHeaderFilterIcon(ctx, cell);
            return;
        }
        if (text === '' || text == null) {
            if (cell.tableHeaderInfo) this.#paintHeaderFilterIcon(ctx, cell);
            return;
        }

        // Delegate multi-line plain text to the rich text renderer
        if (text.includes('\n')) {
            this.#paintRichTextContent(ctx, { ...cell, richTextRuns: [{ t: text }] });
            return;
        }

        // Word-wrap mode: route through the rich text renderer for line breaking
        if (cell.wrapText === 'wrap' || cell.wrapText === true) {
            this.#paintRichTextContent(ctx, { ...cell, richTextRuns: [{ t: text }] });
            return;
        }

        const font = this.#buildFont(cell);
        if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
        ctx.fillStyle = cell.textColor || this.#theme.defaultText;

        const { x, y, width, height } = cell;
        const hAlign = cell.hAlign || 'left';
        const vAlign = cell.vAlign === 'center' ? 'middle' : (cell.vAlign || 'middle');

        ctx.textBaseline = 'alphabetic';

        const dpr = this.#dpr;
        const snap = (v) => Math.round(v * dpr) / dpr;
        const metrics = getFontMetrics(font);

        const textY = snap(computeBaselineY(y, height, vAlign, metrics, CELL_PAD));

        let textX;
        if (hAlign === 'center') {
            ctx.textAlign = 'center';
            textX = snap(x + width / 2);
        } else if (hAlign === 'right') {
            ctx.textAlign = 'right';
            textX = snap(x + width - CELL_PAD_X);
        } else {
            ctx.textAlign = 'left';
            textX = snap(x + CELL_PAD_X);
        }

        ctx.fillText(text, textX, textY);

        // Decorations — positioned from font metrics, not fontPx/2.
        if (cell.underline || cell.strikethrough) {
            ctx.textAlign = 'left';
            const tw = ctx.measureText(text).width;
            const measuredX = hAlign === 'center'
                ? x + width / 2 - tw / 2
                : hAlign === 'right'
                    ? x + width - CELL_PAD_X - tw
                    : x + CELL_PAD_X;

            if (cell.underline) {
                ctx.strokeStyle = cell.textColor || this.#theme.defaultText;
                ctx.lineWidth = 1 / dpr;
                const uy = snap(textY + Math.max(1, metrics.descent * 0.6));
                ctx.beginPath();
                ctx.moveTo(measuredX, uy);
                ctx.lineTo(measuredX + tw, uy);
                ctx.stroke();
            }
            if (cell.strikethrough) {
                ctx.strokeStyle = cell.textColor || this.#theme.defaultText;
                ctx.lineWidth = 1 / dpr;
                const sy = snap(textY - metrics.ascent * 0.35);
                ctx.beginPath();
                ctx.moveTo(measuredX, sy);
                ctx.lineTo(measuredX + tw, sy);
                ctx.stroke();
            }
        }

        if (cell.tableHeaderInfo) this.#paintHeaderFilterIcon(ctx, cell);
    }

    /**
     * Paint rich-text run array with per-run font/color/decorations and word-wrap.
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintRichTextContent(ctx, cell) {
        const runs = cell.richTextRuns;
        if (!runs || runs.length === 0) return;

        const { x, y, width, height } = cell;
        const hAlign = cell.hAlign || 'left';
        const vAlign = cell.vAlign === 'center' ? 'middle' : (cell.vAlign || 'middle');
        const defaultFontSize = cell.fontSize || this.#theme.defaultFontSize;
        const defaultFamily = cell.fontFamily || this.#theme.defaultFontFamily;
        const defaultColor = cell.textColor || this.#theme.defaultText;
        const defaultBold = cell.bold || false;
        const defaultItalic = cell.italic || false;
        const defaultUnderline = cell.underline || false;
        const defaultStrikethrough = cell.strikethrough || false;

        const maxWidth = width - 2 * CELL_PAD_X;

        // Split runs into logical lines (by explicit \n)
        const logicalLines = [[]];
        for (const run of runs) {
            const parts = run.t.split('\n');
            for (let i = 0; i < parts.length; i++) {
                if (i > 0) logicalLines.push([]);
                if (parts[i]) logicalLines[logicalLines.length - 1].push({ ...run, t: parts[i] });
            }
        }

        // Word-wrap each logical line into visual sub-lines (cached)
        // Build a cache key from runs content + maxWidth
        let wrapCacheKey = '';
        for (const run of runs) {
            wrapCacheKey += run.t;
            if (run.b) wrapCacheKey += '\x01b';
            if (run.i) wrapCacheKey += '\x01i';
            if (run.f) wrapCacheKey += '\x01' + run.f;
            if (run.ff) wrapCacheKey += '\x01' + run.ff;
            wrapCacheKey += '\x02';
        }
        wrapCacheKey += '\x03' + maxWidth + '\x04' + defaultFontSize + '\x04' + defaultFamily + '\x04' + (defaultBold ? 1 : 0) + '\x04' + (defaultItalic ? 1 : 0);

        let allLines = this.#wrapCache.get(wrapCacheKey);
        if (!allLines) {
            allLines = [];
            for (const logLine of logicalLines) {
                const wrapped = this.#wrapLogicalLine(ctx, logLine, maxWidth, defaultFontSize, defaultFamily, defaultBold, defaultItalic);
                for (const vl of wrapped) allLines.push(vl);
            }
            if (this.#wrapCache.size >= this.#wrapCacheMax) {
                // Evict oldest half
                const keys = this.#wrapCache.keys();
                for (let i = 0; i < this.#wrapCacheMax / 2; i++) {
                    this.#wrapCache.delete(keys.next().value);
                }
            }
            this.#wrapCache.set(wrapCacheKey, allLines);
        }

        // Use the default font's metrics for line-spacing math. Individual runs
        // may override fontSize; the default acts as the canonical line cadence
        // so mixed-size runs don't stagger vertically.
        const defaultFont = this.#buildRunFont({}, defaultFontSize, defaultFamily, defaultBold, defaultItalic);
        const defaultMetrics = getFontMetrics(defaultFont);
        const lineHeight = (defaultMetrics.ascent + defaultMetrics.descent) * 1.2;
        const totalTextH = allLines.length * lineHeight;

        // Baseline Y of the *first* line. We center the block, then offset to
        // the first baseline (which sits `ascent` below the top of the block).
        const firstLineBaseline = computeBaselineYForBlock(y, height, vAlign, defaultMetrics, totalTextH, CELL_PAD);

        const dpr = this.#dpr;
        const snap = (v) => Math.round(v * dpr) / dpr;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, width, height);
        ctx.clip();
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';

        for (let li = 0; li < allLines.length; li++) {
            const lineRuns = allLines[li];
            const lineY = snap(firstLineBaseline + li * lineHeight);

            // Use pre-computed widths stored on each fragment during wrap layout
            let lineW = 0;
            for (const run of lineRuns) lineW += run._w;

            let runX;
            if (hAlign === 'right') runX = snap(x + width - CELL_PAD_X - lineW);
            else if (hAlign === 'center') runX = snap(x + (width - lineW) / 2);
            else runX = snap(x + CELL_PAD_X);

            for (const run of lineRuns) {
                const font = this.#buildRunFont(run, defaultFontSize, defaultFamily, defaultBold, defaultItalic);
                if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
                const isLink  = !!run.link;
                const color   = isLink ? (this.#theme.linkColor ?? '#1a73e8') : (run.c || defaultColor);
                ctx.fillStyle = color;
                ctx.fillText(run.t, runX, lineY);

                const tw = run._w;
                const doUnderline = isLink || (run.u !== undefined ? run.u : defaultUnderline);
                const doStrike    = run.s !== undefined ? run.s : defaultStrikethrough;

                if (doUnderline || doStrike) {
                    const runMetrics = getFontMetrics(font);
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1 / dpr;
                    if (doUnderline) {
                        const uy = snap(lineY + Math.max(1, runMetrics.descent * 0.6));
                        ctx.beginPath();
                        ctx.moveTo(runX, uy);
                        ctx.lineTo(runX + tw, uy);
                        ctx.stroke();
                    }
                    if (doStrike) {
                        const sy = snap(lineY - runMetrics.ascent * 0.35);
                        ctx.beginPath();
                        ctx.moveTo(runX, sy);
                        ctx.lineTo(runX + tw, sy);
                        ctx.stroke();
                    }
                }

                runX += tw;
            }
        }

        ctx.restore();
        this.#lastFont = '';
    }

    /**
     * Word-wrap a single logical line of rich-text runs into visual sub-lines.
     * Delegates to the shared RichTextLayout algorithm with ctx.measureText as
     * the width function, keeping ctx.font in sync before each measurement.
     */
    #wrapLogicalLine(ctx, lineRuns, maxWidth, defaultSize, defaultFamily, defaultBold, defaultItalic) {
        if (lineRuns.length === 0) return [[]];
        return buildWrappedLines(lineRuns, maxWidth, (token, run) => {
            const font = this.#buildRunFont(run, defaultSize, defaultFamily, defaultBold, defaultItalic);
            if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
            return ctx.measureText(token).width;
        });
    }

    /**
     * Build a CSS font string for a single rich-text run, falling back to cell defaults.
     * size values are in pt; ptToPx rounds to integer CSS px for crisp rasterization.
     */
    #buildRunFont(run, defaultSize, defaultFamily, defaultBold, defaultItalic) {
        const bold = run.b !== undefined ? run.b : defaultBold;
        const italic = run.i !== undefined ? run.i : defaultItalic;
        const sizePt = run.f || defaultSize;
        const family = run.ff || defaultFamily;
        return `${italic ? 'italic' : 'normal'} ${bold ? 'bold' : 'normal'} ${ptToPx(sizePt)}px ${family}`;
    }

    /**
     * Paint the filter icon for a table header cell.
     * Called at end of #paintTextContent when cell.tableHeaderInfo is set.
     * @param {CanvasRenderingContext2D} ctx
     * @param {any} cell
     */
    #paintHeaderFilterIcon(ctx, cell) {
        const info = cell.tableHeaderInfo;
        if (!info) return;
        const { x, y, width, height } = cell;
        this.#drawMagnifyingGlass(ctx, !!info.filterActive, x, y, width, height);
    }

    /**
     * Draw a magnifying glass icon in the right side of a table header cell.
     * @param {CanvasRenderingContext2D} ctx
     * @param {boolean} active
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     */
    #drawMagnifyingGlass(ctx, active, x, y, width, height) {
        const filterAreaW = FILTER_BTN_WIDTH;
        const dpr = this.#dpr;
        const snap = (v) => Math.round(v * dpr) / dpr;
        const cx = snap(x + width - filterAreaW / 2);
        const cy = snap(y + height / 2);
        const r = 3.5;
        const handleLen = 3;
        const angle = Math.PI * 0.75;

        ctx.save();
        ctx.globalAlpha = active ? 1 : 0.65;
        ctx.strokeStyle = active ? this.#theme.filterActiveColor : '#475569';
        ctx.lineWidth = 2.25 / dpr;
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.arc(cx - 1, cy - 1, r, 0, Math.PI * 2);
        ctx.stroke();

        const hx = cx - 1 + Math.cos(angle) * r;
        const hy = cy - 1 + Math.sin(angle) * r;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx + Math.cos(angle) * handleLen, hy + Math.sin(angle) * handleLen);
        ctx.stroke();

        ctx.restore();
    }

    /**
     * Internal table header cell painter (shared between pane cells and sticky headers).
     * @param {CanvasRenderingContext2D} ctx
     * @param {{colName:string, filterActive:boolean, x:number, y:number, width:number, height:number}} opts
     */
    #paintTableHeaderCell(ctx, opts) {
        const { colName, filterActive, x, y, width, height } = opts;

        // Background (same as regular header bg — light sheet tint)
        ctx.fillStyle = this.#theme.tableHeaderBg;
        ctx.fillRect(x, y, width, height);

        const dpr = this.#dpr;
        const halfPx = 0.5 / dpr;

        // Bottom border (slightly heavier to anchor the header)
        ctx.strokeStyle = this.#theme.tableHeaderBorder;
        ctx.lineWidth = 1.5 / dpr;
        ctx.beginPath();
        ctx.moveTo(x, y + height - halfPx);
        ctx.lineTo(x + width, y + height - halfPx);
        ctx.stroke();
        ctx.lineWidth = 1 / dpr;

        // Right border
        ctx.strokeStyle = this.#theme.gridline;
        ctx.beginPath();
        ctx.moveTo(x + width - halfPx, y);
        ctx.lineTo(x + width - halfPx, y + height);
        ctx.stroke();

        const pad = CELL_PAD_X;
        const filterAreaW = FILTER_BTN_WIDTH;
        const textAreaW = width - pad - filterAreaW - 2;

        ctx.textBaseline = 'alphabetic';

        // Column name — bold, same size as regular cells
        const headerFont = `600 ${ptToPx(this.#theme.defaultFontSize)}px ${this.#theme.defaultFontFamily}`;
        if (headerFont !== this.#lastFont) { ctx.font = headerFont; this.#lastFont = headerFont; }
        ctx.fillStyle = this.#theme.tableHeaderText;
        ctx.textAlign = 'left';

        const snap = (v) => Math.round(v * dpr) / dpr;
        const textY = snap(computeBaselineY(y, height, 'middle', getFontMetrics(headerFont), CELL_PAD));

        ctx.save();
        ctx.beginPath();
        ctx.rect(x + pad, y, Math.max(0, textAreaW), height);
        ctx.clip();
        ctx.fillText(colName, snap(x + pad), textY);
        ctx.restore();

        // Filter icon — magnifying glass
        this.#drawMagnifyingGlass(ctx, filterActive, x, y, width, height);
    }

    // #paintCheckboxContent, #paintRatingContent, #paintDropdownContent removed.
    // All three types implement paintCell() on their descriptors; CanvasRenderer
    // handles them through the descriptor path in #paintCellContent above. — dropdown now uses dropdownType.paintCell() via the
    // descriptor path in #paintCellContent (CellPaintData sets _descriptor for any type
    // that exposes paintCell).

    // ─── Private: border helpers ──────────────────────────────────────────────

    /** Delegates to the shared BorderGeometry module (single source of truth). */
    #paintCustomBorders(ctx, borders, x, y, w, h, dpr = 1) {
        paintBordersCanvas(ctx, borders, x, y, w, h, dpr);
    }

    // ─── Private: font / text helpers ─────────────────────────────────────────

    /**
     * Build a CSS font string from cell style properties.
     * fontSize is stored in pt; ptToPx converts to integer CSS px so glyphs rasterize
     * on a whole-pixel grid (96dpi / 72pt-per-inch, rounded).
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     * @returns {string}
     */
    #buildFont(cell) {
        const style = cell.italic ? 'italic' : 'normal';
        const weight = cell.bold ? 'bold' : 'normal';
        const sizePt = cell.fontSize || this.#theme.defaultFontSize;
        const family = cell.fontFamily || this.#theme.defaultFontFamily;
        return `${style} ${weight} ${ptToPx(sizePt)}px ${family}`;
    }
}

export default CanvasRenderer;
