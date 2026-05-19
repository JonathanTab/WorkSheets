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

import { drawCheckbox, drawRating } from '../cellTypes/painters.js';
import { CellTypeRegistry } from '../cellTypes/index.js';
import { perfMon } from '../perf/PerfMonitor.js';

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
    urlColor: '#1a73e8',
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
            // Set up clip region for this pane
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
                ctx.lineWidth = 1;
                for (const cell of cells) {
                    const { x, y, width, height, borders } = cell;
                    // Skip bottom gridline when the cell has a custom bottom border — the
                    // border renders on top anyway, but suppressing avoids the gridline
                    // bleeding through thin or dashed custom borders.
                    if (!borders?.bottom) {
                        ctx.moveTo(x, y + height - halfPx);
                        ctx.lineTo(x + width, y + height - halfPx);
                    }
                    // right edge — suppressed for overflow shadow cells (gridlineOnly) and
                    // when the cell has a custom right border.
                    if (!cell.gridlineOnly && !borders?.right) {
                        ctx.moveTo(x + width - halfPx, y);
                        ctx.lineTo(x + width - halfPx, y + height);
                    }
                }
                ctx.stroke();
            }

            // Paint custom borders after gridlines so they always render on top.
            for (const cell of /** @type {import('./CellPaintData.js').CellPaintItem[]} */ (cells)) {
                if (!cell.gridlineOnly && cell.borders) {
                    this.#paintCustomBorders(ctx, cell.borders, cell.x, cell.y, cell.width, cell.height);
                }
            }
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
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x,               y + height - halfPx);
        ctx.lineTo(x + width,       y + height - halfPx);
        ctx.moveTo(x + width - halfPx, y);
        ctx.lineTo(x + width - halfPx, y + height);
        ctx.stroke();

        const textY = snap(y + height / 2);

        if (col?.isNonEntry) {
            // Formula column — show 'fx' hint
            const fxFont = `600 ${this.#theme.defaultFontSize * 4 / 3}px ${this.#theme.defaultFontFamily}`;
            if (fxFont !== this.#lastFont) { ctx.font = fxFont; this.#lastFont = fxFont; }
            ctx.fillStyle = 'rgba(100,116,139,0.35)';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText('fx', snap(x + width / 2), textY);
            return;
        }

        const colId = col?.id;
        const value = colId != null ? (entryBuffer?.[colId] ?? null) : null;

        if (value != null && value !== '') {
            const font = `${this.#theme.defaultFontSize * 4 / 3}px ${this.#theme.defaultFontFamily}`;
            if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
            ctx.fillStyle = this.#theme.defaultText;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            ctx.fillText(String(value), snap(x + 4), textY, width - 8);
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
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.75, y + 0.75, width - 1.5, height - 1.5);
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

        switch (renderType) {
            case 'checkbox':
                this.#paintCheckboxContent(ctx, cell);
                break;
            case 'rating':
                this.#paintRatingContent(ctx, cell);
                break;
            case 'dropdown':
                this.#paintDropdownContent(ctx, cell);
                break;
            default:
                this.#paintTextContent(ctx, cell);
        }
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
            const placeholderFont = `italic ${this.#theme.defaultFontSize * 4 / 3 * 0.9}px ${this.#theme.defaultFontFamily}`;
            if (placeholderFont !== this.#lastFont) { ctx.font = placeholderFont; this.#lastFont = placeholderFont; }
            ctx.fillStyle = this.#theme.entryPlaceholderText || 'rgba(100,116,139,0.5)';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const _dpr = this.#dpr;
            ctx.fillText(cell.placeholderText, cell.x + 4, Math.round((cell.y + cell.height / 2) * _dpr) / _dpr, cell.width - 8);
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
        const pad = 4;
        const hAlign = cell.hAlign || 'left';
        const vAlign = cell.vAlign || 'middle';
        // fontSize is stored in pt; convert to CSS px for layout measurements.
        const fontPx = (cell.fontSize || this.#theme.defaultFontSize) * 4 / 3;

        ctx.textBaseline = 'middle';

        // Snap to physical pixel boundaries: Math.round(v * dpr) / dpr ensures the
        // canvas draws at an integer physical pixel, not a fractional one.
        // Plain Math.round() only gives integer CSS pixels, which at DPR=1.5 can still
        // land on a half physical pixel (e.g. CSS 11 → 16.5 phys px).
        const dpr = this.#dpr;
        const snap = (v) => Math.round(v * dpr) / dpr;

        const minTextY = snap(y + 1 + fontPx / 2);
        let textY;
        if (vAlign === 'top') {
            textY = snap(y + pad + fontPx / 2);
        } else if (vAlign === 'bottom') {
            textY = Math.max(snap(y + height - pad - fontPx / 2), minTextY);
        } else {
            textY = Math.max(snap(y + height / 2), minTextY);
        }

        let textX;
        if (hAlign === 'center') {
            ctx.textAlign = 'center';
            textX = snap(x + width / 2);
        } else if (hAlign === 'right') {
            ctx.textAlign = 'right';
            textX = snap(x + width - pad);
        } else {
            ctx.textAlign = 'left';
            textX = snap(x + pad);
        }

        ctx.fillText(text, textX, textY);

        // Decorations
        if (cell.underline || cell.strikethrough) {
            ctx.textAlign = 'left';
            const tw = ctx.measureText(text).width;
            const measuredX = hAlign === 'center'
                ? x + width / 2 - tw / 2
                : hAlign === 'right'
                    ? x + width - pad - tw
                    : x + pad;

            if (cell.underline) {
                ctx.strokeStyle = cell.textColor || this.#theme.defaultText;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(measuredX, textY + fontPx / 2 + 1);
                ctx.lineTo(measuredX + tw, textY + fontPx / 2 + 1);
                ctx.stroke();
            }
            if (cell.strikethrough) {
                ctx.strokeStyle = cell.textColor || this.#theme.defaultText;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(measuredX, textY);
                ctx.lineTo(measuredX + tw, textY);
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
        const pad = 4;
        const hAlign = cell.hAlign || 'left';
        const vAlign = cell.vAlign || 'middle';
        const defaultFontSize = cell.fontSize || this.#theme.defaultFontSize;
        const defaultFamily = cell.fontFamily || this.#theme.defaultFontFamily;
        const defaultColor = cell.textColor || this.#theme.defaultText;
        const defaultBold = cell.bold || false;
        const defaultItalic = cell.italic || false;
        const defaultUnderline = cell.underline || false;
        const defaultStrikethrough = cell.strikethrough || false;

        const maxWidth = width - 2 * pad;
        // fontSize is stored in pt; convert to CSS px for layout.
        const defaultFontPx = defaultFontSize * 4 / 3;

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

        // lineHeight in CSS px, using the converted font size.
        const lineHeight = defaultFontPx * 1.5;
        const totalTextH = allLines.length * lineHeight;

        // Minimum startY so the first line's baseline never appears above the top pad
        const minStartY = y + pad + defaultFontPx / 2;

        let startY;
        if (vAlign === 'top') {
            startY = minStartY;
        } else if (vAlign === 'bottom') {
            // Last line center at y + height - pad - fontPx/2; solve for startY.
            startY = y + height - pad - defaultFontPx / 2 - (totalTextH - lineHeight);
        } else {
            // Center — clamp so first line doesn't bleed above the cell when content overflows
            startY = Math.max(y + (height - totalTextH) / 2 + lineHeight / 2, minStartY);
        }

        const dpr = this.#dpr;
        const snap = (v) => Math.round(v * dpr) / dpr;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y + 1, width - 2, height - 2);
        ctx.clip();
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        for (let li = 0; li < allLines.length; li++) {
            const lineRuns = allLines[li];
            const lineY = snap(startY + li * lineHeight);

            // Use pre-computed widths stored on each fragment during wrap layout
            let lineW = 0;
            for (const run of lineRuns) lineW += run._w;

            let runX;
            if (hAlign === 'right') runX = snap(x + width - pad - lineW);
            else if (hAlign === 'center') runX = snap(x + (width - lineW) / 2);
            else runX = snap(x + pad);

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
                    // runFontSize is in pt; convert to px for the offset calculation.
                    const runFontPx = (run.f || defaultFontSize) * 4 / 3;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1;
                    if (doUnderline) {
                        const underlineY = lineY + runFontPx / 2 + 1;
                        ctx.beginPath();
                        ctx.moveTo(runX, underlineY);
                        ctx.lineTo(runX + tw, underlineY);
                        ctx.stroke();
                    }
                    if (doStrike) {
                        ctx.beginPath();
                        ctx.moveTo(runX, lineY);
                        ctx.lineTo(runX + tw, lineY);
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
     * Word-wrap a single logical line (array of runs) to fit within maxWidth.
     * Returns an array of visual lines (each an array of run objects with text).
     * @param {CanvasRenderingContext2D} ctx
     * @param {Array} lineRuns
     * @param {number} maxWidth
     * @param {number} defaultSize
     * @param {string} defaultFamily
     * @param {boolean} defaultBold
     * @param {boolean} defaultItalic
     * @returns {Array<Array>}
     */
    #wrapLogicalLine(ctx, lineRuns, maxWidth, defaultSize, defaultFamily, defaultBold, defaultItalic) {
        if (lineRuns.length === 0) return [[]];

        const visualLines = [[]];
        let lineWidth = 0;

        for (const run of lineRuns) {
            const font = this.#buildRunFont(run, defaultSize, defaultFamily, defaultBold, defaultItalic);
            if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }

            // Split text into tokens (words and whitespace), keeping delimiters
            const tokens = run.t.split(/(\s+)/);

            for (const token of tokens) {
                if (!token) continue;
                const isWS = !token.trim();
                const tokenW = ctx.measureText(token).width;

                // Skip leading whitespace on a new line
                if (lineWidth === 0 && isWS) continue;

                if (!isWS && lineWidth > 0 && lineWidth + tokenW > maxWidth) {
                    // Word doesn't fit — start a new visual line
                    visualLines.push([]);
                    lineWidth = 0;
                }

                const lastLine = visualLines[visualLines.length - 1];
                const lastFrag = lastLine[lastLine.length - 1];
                // Merge with last fragment if same run (same style key)
                if (lastFrag && lastFrag._runRef === run) {
                    lastFrag.t += token;
                    lastFrag._w += tokenW;
                } else {
                    lastLine.push({ ...run, t: token, _runRef: run, _w: tokenW });
                }
                lineWidth += tokenW;
            }
        }

        // Remove the _runRef helper before returning
        for (const line of visualLines) {
            for (const frag of line) delete frag._runRef;
        }

        // Drop any empty trailing lines (shouldn't happen, but guard)
        while (visualLines.length > 1 && visualLines[visualLines.length - 1].length === 0) {
            visualLines.pop();
        }

        return visualLines;
    }

    /**
     * Build a CSS font string for a single rich-text run, falling back to cell defaults.
     * size values are in pt; multiply by 4/3 to get CSS px.
     */
    #buildRunFont(run, defaultSize, defaultFamily, defaultBold, defaultItalic) {
        const bold = run.b !== undefined ? run.b : defaultBold;
        const italic = run.i !== undefined ? run.i : defaultItalic;
        const sizePt = run.f || defaultSize;
        const family = run.ff || defaultFamily;
        return `${italic ? 'italic' : 'normal'} ${bold ? 'bold' : 'normal'} ${sizePt * 4 / 3}px ${family}`;
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
        ctx.lineWidth = 2.25;
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
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y + height - halfPx);
        ctx.lineTo(x + width, y + height - halfPx);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Right border
        ctx.strokeStyle = this.#theme.gridline;
        ctx.beginPath();
        ctx.moveTo(x + width - halfPx, y);
        ctx.lineTo(x + width - halfPx, y + height);
        ctx.stroke();

        const pad = 4;
        const filterAreaW = FILTER_BTN_WIDTH;
        const textAreaW = width - pad - filterAreaW - 2;

        ctx.textBaseline = 'middle';
        const textY = Math.round((y + height / 2) * dpr) / dpr;

        // Column name — bold, same size as regular cells
        const headerFont = `600 ${this.#theme.defaultFontSize * 4 / 3}px ${this.#theme.defaultFontFamily}`;
        if (headerFont !== this.#lastFont) { ctx.font = headerFont; this.#lastFont = headerFont; }
        ctx.fillStyle = this.#theme.tableHeaderText;
        ctx.textAlign = 'left';

        const snap = (v) => Math.round(v * dpr) / dpr;

        ctx.save();
        ctx.beginPath();
        ctx.rect(x + pad, y, Math.max(0, textAreaW), height);
        ctx.clip();
        ctx.fillText(colName, snap(x + pad), textY);
        ctx.restore();

        // Filter icon — magnifying glass
        this.#drawMagnifyingGlass(ctx, filterActive, x, y, width, height);
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintCheckboxContent(ctx, cell) {
        const checked = !!cell.rawValue;
        const size = Math.min(16, cell.height - 4, cell.width - 4);
        const cx = cell.x + (cell.width - size) / 2;
        const cy = cell.y + (cell.height - size) / 2;
        drawCheckbox(ctx, cx, cy, size, checked);
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintRatingContent(ctx, cell) {
        drawRating(ctx, cell.x, cell.y, cell.width, cell.height, cell.rawValue ?? 0, cell.ratingMax ?? 5);
    }

    /**
     * Paint a dropdown cell: text value + a ▾ chevron on the right.
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintDropdownContent(ctx, cell) {
        const arrowW = 16;
        const pad = 4;
        const { x, y, width, height } = cell;
        const dpr = this.#dpr;
        const snap = (v) => Math.round(v * dpr) / dpr;
        const text = cell.displayValue || '';
        const font = this.#buildFont(cell);
        if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
        ctx.fillStyle = cell.textColor || this.#theme.defaultText;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        // Clip text to leave room for the arrow
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + pad, y, width - arrowW - pad * 2, height);
        ctx.clip();
        if (text) ctx.fillText(text, snap(x + pad), snap(y + height / 2));
        ctx.restore();

        // Draw dropdown arrow
        const arrowX = x + width - arrowW / 2;
        const arrowY = y + height / 2;
        const arrowSize = 4;
        ctx.fillStyle = '#64748b';
        ctx.beginPath();
        ctx.moveTo(arrowX - arrowSize, arrowY - arrowSize / 2);
        ctx.lineTo(arrowX + arrowSize, arrowY - arrowSize / 2);
        ctx.lineTo(arrowX, arrowY + arrowSize / 2);
        ctx.closePath();
        ctx.fill();
    }

    // ─── Private: border helpers ──────────────────────────────────────────────

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {{top?,right?,bottom?,left?}} borders
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     */
    #paintCustomBorders(ctx, borders, x, y, w, h) {
        const paintEdge = (edge, x1, y1, x2, y2, position = 'center') => {
            if (!edge) return;
            ctx.strokeStyle = edge.color || '#000000';
            ctx.lineCap = 'square'; // extends stroke past endpoints to fill corners
            const lineWidth = edge.width || 1;
            const edgeStyle = edge.style || 'solid';

            // Calculate offset based on line width to ensure proper positioning
            // For lineWidth=1: offset=0.5 (center of pixel)
            // For lineWidth>1: offset by half the width to position stroke outside the cell
            const offset = lineWidth === 1 ? 0.5 : Math.ceil(lineWidth / 2);

            // Adjust coordinates based on edge position
            const adjust = (ax1, ay1, ax2, ay2) => {
                let bx1 = ax1, by1 = ay1, bx2 = ax2, by2 = ay2;
                if (position === 'top') { by1 -= (offset - 0.5); by2 -= (offset - 0.5); }
                else if (position === 'bottom') { by1 += (offset - 0.5); by2 += (offset - 0.5); }
                else if (position === 'left') { bx1 -= (offset - 0.5); bx2 -= (offset - 0.5); }
                else if (position === 'right') { bx1 += (offset - 0.5); bx2 += (offset - 0.5); }
                return [bx1, by1, bx2, by2];
            };

            if (edgeStyle === 'double') {
                // Draw two thin parallel lines, 2px apart
                ctx.lineWidth = 1;
                ctx.setLineDash([]);
                const gap = 2;
                const isH = (y1 === y2);
                // Line 1 (inward offset -gap)
                let [ax1, ay1, ax2, ay2] = adjust(x1, y1, x2, y2);
                if (isH) { ay1 -= gap; ay2 -= gap; } else { ax1 -= gap; ax2 -= gap; }
                ctx.beginPath(); ctx.moveTo(ax1, ay1); ctx.lineTo(ax2, ay2); ctx.stroke();
                // Line 2 (outward offset +gap)
                let [bx1, by1, bx2, by2] = adjust(x1, y1, x2, y2);
                if (isH) { by1 += gap; by2 += gap; } else { bx1 += gap; bx2 += gap; }
                ctx.beginPath(); ctx.moveTo(bx1, by1); ctx.lineTo(bx2, by2); ctx.stroke();
            } else {
                ctx.lineWidth = lineWidth;
                ctx.setLineDash(edgeStyle === 'dashed' ? [4, 4] : []);
                const [ax1, ay1, ax2, ay2] = adjust(x1, y1, x2, y2);
                ctx.beginPath();
                ctx.moveTo(ax1, ay1);
                ctx.lineTo(ax2, ay2);
                ctx.stroke();
                if (edgeStyle === 'dashed') ctx.setLineDash([]);
            }
        };

        // Paint borders with proper positioning for their edges
        if (borders.top) paintEdge(borders.top, x, y, x + w, y, 'top');
        if (borders.right) paintEdge(borders.right, x + w, y, x + w, y + h, 'right');
        if (borders.bottom) paintEdge(borders.bottom, x, y + h, x + w, y + h, 'bottom');
        if (borders.left) paintEdge(borders.left, x, y, x, y + h, 'left');
        ctx.lineCap = 'butt'; // restore default
    }

    // ─── Private: font / text helpers ─────────────────────────────────────────

    /**
     * Build a CSS font string from cell style properties.
     * fontSize is stored in pt; multiply by 4/3 to convert to CSS px (96dpi / 72pt-per-inch).
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     * @returns {string}
     */
    #buildFont(cell) {
        const style = cell.italic ? 'italic' : 'normal';
        const weight = cell.bold ? 'bold' : 'normal';
        const sizePt = cell.fontSize || this.#theme.defaultFontSize;
        const family = cell.fontFamily || this.#theme.defaultFontFamily;
        return `${style} ${weight} ${sizePt * 4 / 3}px ${family}`;
    }
}

export default CanvasRenderer;
