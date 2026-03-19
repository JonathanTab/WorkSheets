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

// ─── Theme ────────────────────────────────────────────────────────────────────
const DEFAULT_THEME = {
    gridline: '#e2e8f0',
    cellBg: '#ffffff',
    defaultText: '#1e293b',
    defaultFontSize: 13,
    defaultFontFamily: 'system-ui, -apple-system, sans-serif',
    tableHeaderBg: '#f1f5f9',
    tableHeaderText: '#334155',
    tableHeaderBorder: '#94a3b8',
    tableEntryBg: '#f8fafc',
    entryPlaceholderText: '#94a3b8',
    sortIconColor: '#3b82f6',
    filterIconColor: '#94a3b8',
    filterActiveColor: '#3b82f6',
    urlColor: '#1a73e8',
    zebraFill: 'rgba(0,0,0,0.018)',
    formulaColBg: 'rgba(139,92,246,0.04)',
    accentBarWidth: 3,
};

const FILTER_BTN_WIDTH = 20; // CSS px, area reserved for filter icon on the right
const TYPE_ICON_WIDTH = 18; // CSS px, area for type icon badge

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

    /** @type {Object} */
    #theme = { ...DEFAULT_THEME };

    /** @type {string} Last font string set on ctx — avoids redundant ctx.font assignments */
    #lastFont = '';

    /**
     * @param {HTMLCanvasElement | OffscreenCanvas} canvas
     */
    constructor(canvas) {
        this.#canvas = canvas;
        if (canvas) {
            this.#ctx = canvas.getContext('2d');
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
     */
    clear() {
        if (!this.#ctx || !this.#canvas) return;
        this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
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
        this.#ctx.clearRect(
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

            // Paint each cell (backgrounds, content, custom borders, overlays)
            for (const cell of cells) {
                this.#paintCell(ctx, cell);
            }

            // Batch-draw default gridlines in one path to minimise stroke() calls.
            // gridlineOnly cells (overflow shadows) are included here so column
            // boundaries stay visible under spilled text. Overflow cells use
            // naturalWidth so their right/bottom lines stay at the column edge.
            if (showGridLines) {
                ctx.beginPath();
                ctx.strokeStyle = this.#theme.gridline;
                ctx.lineWidth = 1;
                for (const cell of cells) {
                    const { x, y, height } = cell;
                    // Use naturalWidth for overflow cells so the gridline stays
                    // at the original column boundary, not the extended edge.
                    const rightW = cell.naturalWidth ?? cell.width;
                    // right edge
                    ctx.moveTo(x + rightW - 0.5, y);
                    ctx.lineTo(x + rightW - 0.5, y + height);
                    // bottom edge
                    ctx.moveTo(x, y + height - 0.5);
                    ctx.lineTo(x + rightW, y + height - 0.5);
                }
                ctx.stroke();
            }
        } finally {
            ctx.restore(); // removes the DPR scale — back to physical pixel space
        }
    }

    /**
     * Paint sticky table headers at the top of the frozen-row band.
     * Call after all pane paints.
     *
     * @param {Array<{table:any, leftPx:number, widthPx:number, heightPx:number}>} headers
     * @param {{frozenWidth:number, frozenHeight:number, scrollLeft:number, headerHeight:number}} options
     */
    paintStickyHeaders(headers, options) {
        if (!headers?.length) return;
        const ctx = this.#ctx;
        if (!ctx) return;

        const { frozenWidth, frozenHeight, scrollLeft, headerHeight } = options;
        const dpr = this.#dpr;

        this.#lastFont = '';
        ctx.save();
        ctx.scale(dpr, dpr);

        try {
            for (const header of headers) {
                const canvasX = frozenWidth + header.leftPx - scrollLeft;
                const canvasY = frozenHeight; // just below frozen rows / at top of body area

                // Clip to entire header strip width
                ctx.save();
                ctx.beginPath();
                ctx.rect(canvasX, canvasY, header.widthPx, header.heightPx);
                ctx.clip();

                let xCursor = canvasX;
                for (let i = 0; i < header.table.columns.length; i++) {
                    const col = header.table.columns[i];
                    const colW = header.colWidths?.[i] ?? 100;
                    this.#paintTableHeaderCell(ctx, {
                        colName: col?.name ?? '',
                        sortIcon: header.table.sortColId === col?.id
                            ? (header.table.sortDir === 'asc' ? '▲' : '▼')
                            : '',
                        filterActive: !!(col?.id && header.table.filters?.get?.(col.id)),
                        x: xCursor,
                        y: canvasY,
                        width: colW,
                        height: header.heightPx,
                    });
                    xCursor += colW;
                }

                ctx.restore();
            }
        } finally {
            ctx.restore();
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

        // 4. Custom borders (overwrite specific edges)
        if (cell.borders) {
            this.#paintCustomBorders(ctx, cell.borders, x, y, width, height);
        }

        // 5. Table left accent bar (first column of each table row)
        if (cell.isFirstTableCol && cell.tableAccentColor) {
            const bw = this.#theme.accentBarWidth;
            ctx.fillStyle = cell.tableAccentColor;
            ctx.fillRect(x, y, bw, height);
        }

        // 6. Data validation invalid — red outline
        if (cell.dvInvalid) {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.75, y + 0.75, width - 1.5, height - 1.5);
        }

        // 8. Content — clip to cell interior before drawing (only when needed).
        // ctx.save()/restore() is expensive in Chrome (~8µs each). Plain single-line text
        // cells that fit within cell bounds skip this entirely; rich text, wrapText, merges,
        // and complex render types use it via the clipContent flag.
        const clipLeft = cell.isFirstTableCol ? this.#theme.accentBarWidth : 0;
        if (cell.clipContent) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + 1 + clipLeft, y + 1, width - 2 - clipLeft, height - 2);
            ctx.clip();
            this.#paintCellContent(ctx, cell);
            ctx.restore();
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

        // Check for custom paintCell from CellTypeRegistry
        if (renderType !== 'table_header' && renderType !== 'table_entry') {
            const descriptor = CellTypeRegistry.get(renderType);
            if (descriptor?.paintCell) {
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
        }

        switch (renderType) {
            case 'table_header':
                this.#paintTableHeaderContent(ctx, cell);
                break;
            case 'table_entry':
                this.#paintTableEntryContent(ctx, cell);
                break;
            case 'checkbox':
                this.#paintCheckboxContent(ctx, cell);
                break;
            case 'rating':
                this.#paintRatingContent(ctx, cell);
                break;
            case 'url':
                this.#paintUrlContent(ctx, cell);
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
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintTextContent(ctx, cell) {
        if (cell.richTextRuns) {
            this.#paintRichTextContent(ctx, cell);
            return;
        }

        const text = cell.displayValue;
        if (text === '' || text == null) return;

        const font = this.#buildFont(cell);
        if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
        ctx.fillStyle = cell.textColor || this.#theme.defaultText;

        const { x, y, width, height } = cell;
        const pad = 4;
        const hAlign = cell.hAlign || 'left';
        const vAlign = cell.vAlign || 'middle';
        const fontSize = cell.fontSize || this.#theme.defaultFontSize;

        ctx.textBaseline = 'middle';

        // Round to integer pixels for crisp, native-looking text rendering
        let textY;
        if (vAlign === 'top') {
            textY = Math.round(y + pad + fontSize / 2);
        } else if (vAlign === 'bottom') {
            textY = Math.round(y + height - pad - fontSize / 2);
        } else {
            textY = Math.round(y + height / 2);
        }

        let textX;
        if (hAlign === 'center') {
            ctx.textAlign = 'center';
            textX = Math.round(x + width / 2);
        } else if (hAlign === 'right') {
            ctx.textAlign = 'right';
            textX = Math.round(x + width - pad);
        } else {
            ctx.textAlign = 'left';
            textX = Math.round(x + pad);
        }

        ctx.fillText(text, textX, textY);

        // Decorations
        if (cell.underline || cell.strikethrough) {
            ctx.textAlign = 'left';
            const measuredX = hAlign === 'center'
                ? x + width / 2 - ctx.measureText(text).width / 2
                : hAlign === 'right'
                    ? x + width - pad - ctx.measureText(text).width
                    : x + pad;
            const tw = ctx.measureText(text).width;

            if (cell.underline) {
                ctx.strokeStyle = cell.textColor || this.#theme.defaultText;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(measuredX, textY + 7);
                ctx.lineTo(measuredX + tw, textY + 7);
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
    }

    /**
     * Paint rich-text run array with per-run font/color/decorations.
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

        // Split runs into visual lines (by \n within run text)
        const lines = [[]];
        for (const run of runs) {
            const parts = run.t.split('\n');
            for (let i = 0; i < parts.length; i++) {
                if (i > 0) lines.push([]);
                if (parts[i]) lines[lines.length - 1].push({ ...run, t: parts[i] });
            }
        }

        const lineHeight = defaultFontSize * 1.5;
        const totalTextH = lines.length * lineHeight;

        let startY;
        if (vAlign === 'top') startY = y + pad + defaultFontSize / 2;
        else if (vAlign === 'bottom') startY = y + height - pad - totalTextH + lineHeight / 2;
        else startY = y + (height - totalTextH) / 2 + lineHeight / 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y + 1, width - 2, height - 2);
        ctx.clip();
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        for (let li = 0; li < lines.length; li++) {
            const lineRuns = lines[li];
            const lineY = Math.round(startY + li * lineHeight);

            // Measure line width for alignment
            let lineW = 0;
            for (const run of lineRuns) {
                const mf = this.#buildRunFont(run, defaultFontSize, defaultFamily, defaultBold, defaultItalic);
                if (mf !== this.#lastFont) { ctx.font = mf; this.#lastFont = mf; }
                lineW += ctx.measureText(run.t).width;
            }

            let runX;
            if (hAlign === 'right') runX = Math.round(x + width - pad - lineW);
            else if (hAlign === 'center') runX = Math.round(x + (width - lineW) / 2);
            else runX = Math.round(x + pad);

            for (const run of lineRuns) {
                const font = this.#buildRunFont(run, defaultFontSize, defaultFamily, defaultBold, defaultItalic);
                if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
                const color = run.c || defaultColor;
                ctx.fillStyle = color;
                ctx.fillText(run.t, runX, lineY);

                const tw = ctx.measureText(run.t).width;
                const doUnderline = run.u !== undefined ? run.u : defaultUnderline;
                const doStrike = run.s !== undefined ? run.s : defaultStrikethrough;

                if (doUnderline || doStrike) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1;
                    if (doUnderline) {
                        ctx.beginPath();
                        ctx.moveTo(runX, lineY + defaultFontSize / 2 + 2);
                        ctx.lineTo(runX + tw, lineY + defaultFontSize / 2 + 2);
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
    }

    /**
     * Build a CSS font string for a single rich-text run, falling back to cell defaults.
     */
    #buildRunFont(run, defaultSize, defaultFamily, defaultBold, defaultItalic) {
        const bold = run.b !== undefined ? run.b : defaultBold;
        const italic = run.i !== undefined ? run.i : defaultItalic;
        const size = run.f || defaultSize;
        return `${italic ? 'italic' : 'normal'} ${bold ? 'bold' : 'normal'} ${size}px ${defaultFamily}`;
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintTableHeaderContent(ctx, cell) {
        const info = cell.tableHeaderInfo;
        if (!info) return;
        this.#paintTableHeaderCell(ctx, {
            ...info,
            x: cell.x, y: cell.y, width: cell.width, height: cell.height,
        });
    }

    /**
     * Internal table header cell painter (shared between pane cells and sticky headers).
     * @param {CanvasRenderingContext2D} ctx
     * @param {{colName:string, sortIcon:string, filterActive:boolean, x:number, y:number, width:number, height:number, typeIcon?:string, isFormula?:boolean, accentColor?:string, isFirstCol?:boolean}} opts
     */
    #paintTableHeaderCell(ctx, opts) {
        const {
            colName, sortIcon, filterActive,
            x, y, width, height,
            typeIcon, isFormula,
            accentColor = '#3b82f6',
            isFirstCol = false,
        } = opts;

        // Background
        ctx.fillStyle = this.#theme.tableHeaderBg;
        ctx.fillRect(x, y, width, height);

        // Accent top border (2px)
        ctx.fillStyle = accentColor;
        ctx.fillRect(x, y, width, 2);

        // Left accent bar for first column
        if (isFirstCol) {
            const bw = this.#theme.accentBarWidth;
            ctx.fillStyle = accentColor;
            ctx.fillRect(x, y, bw, height);
        }

        // Bottom border (thicker, muted)
        ctx.strokeStyle = this.#theme.tableHeaderBorder;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y + height - 0.75);
        ctx.lineTo(x + width, y + height - 0.75);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Right border
        ctx.strokeStyle = this.#theme.gridline;
        ctx.beginPath();
        ctx.moveTo(x + width - 0.5, y);
        ctx.lineTo(x + width - 0.5, y + height);
        ctx.stroke();

        const pad = isFirstCol ? this.#theme.accentBarWidth + 3 : 4;
        const filterAreaW = FILTER_BTN_WIDTH;
        // Reserve space for type icon badge (right of column name, left of filter)
        const typeIconW = typeIcon ? TYPE_ICON_WIDTH : 0;
        const textAreaW = width - pad - filterAreaW - typeIconW - 2;

        ctx.textBaseline = 'middle';
        const textY = Math.round(y + height / 2);

        // Column name — use same font size as regular cells for visual consistency
        const headerFont = `600 ${this.#theme.defaultFontSize}px ${this.#theme.defaultFontFamily}`;
        if (headerFont !== this.#lastFont) { ctx.font = headerFont; this.#lastFont = headerFont; }
        ctx.fillStyle = this.#theme.tableHeaderText;
        ctx.textAlign = 'left';

        ctx.save();
        ctx.beginPath();
        ctx.rect(x + pad, y, Math.max(0, textAreaW), height);
        ctx.clip();
        ctx.fillText(colName, x + pad, textY);
        ctx.restore();

        // Type icon badge (small pill right of column name area)
        if (typeIcon && typeIconW > 0) {
            const bx = x + width - filterAreaW - typeIconW;
            const bw2 = typeIconW - 2;
            const bh = 12;
            const by = Math.round(y + (height - bh) / 2);

            // Badge background
            ctx.fillStyle = isFormula ? 'rgba(139,92,246,0.12)' : 'rgba(59,130,246,0.1)';
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(bx, by, bw2, bh, 2);
            } else {
                ctx.rect(bx, by, bw2, bh);
            }
            ctx.fill();

            // Badge text
            const badgeFont = `500 9px ${this.#theme.defaultFontFamily}`;
            if (badgeFont !== this.#lastFont) { ctx.font = badgeFont; this.#lastFont = badgeFont; }
            ctx.fillStyle = isFormula ? '#7c3aed' : '#475569';
            ctx.textAlign = 'center';
            ctx.fillText(isFormula ? 'fx' : typeIcon, Math.round(bx + bw2 / 2), Math.round(by + bh / 2));
        }

        // Sort icon
        if (sortIcon) {
            const sortColor = accentColor ?? this.#theme.sortIconColor;
            const sortFont = `bold 8px ${this.#theme.defaultFontFamily}`;
            if (sortFont !== this.#lastFont) { ctx.font = sortFont; this.#lastFont = sortFont; }
            ctx.fillStyle = sortColor;
            ctx.textAlign = 'center';
            ctx.fillText(sortIcon, Math.round(x + width - filterAreaW + 1), textY - 1);
        }

        // Filter icon
        const filterFont = `${this.#theme.defaultFontSize}px ${this.#theme.defaultFontFamily}`;
        if (filterFont !== this.#lastFont) { ctx.font = filterFont; this.#lastFont = filterFont; }
        ctx.fillStyle = filterActive ? (accentColor ?? this.#theme.filterActiveColor) : this.#theme.filterIconColor;
        ctx.globalAlpha = filterActive ? 1 : 0.5;
        ctx.textAlign = 'center';
        ctx.fillText('☰', Math.round(x + width - filterAreaW / 2), textY);
        ctx.globalAlpha = 1;
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintTableEntryContent(ctx, cell) {
        const { x, y, width, height } = cell;
        const accentBarOffset = cell.isFirstTableCol ? this.#theme.accentBarWidth : 0;

        if (cell.isNonEntryCol) {
            // Formula column — show 'fx' indicator
            const fxFont = `600 ${this.#theme.defaultFontSize}px ${this.#theme.defaultFontFamily}`;
            if (fxFont !== this.#lastFont) { ctx.font = fxFont; this.#lastFont = fxFont; }
            ctx.fillStyle = 'rgba(139,92,246,0.5)';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText('fx', Math.round(x + width / 2), Math.round(y + height / 2));
            return;
        }

        const textY = Math.round(y + height / 2);

        // If the user has typed a value in this column, render it like a normal cell.
        if (cell.displayValue) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, width, height);
            ctx.clip();
            const entryFont = `${this.#theme.defaultFontSize}px ${this.#theme.defaultFontFamily}`;
            if (entryFont !== this.#lastFont) { ctx.font = entryFont; this.#lastFont = entryFont; }
            ctx.fillStyle = this.#theme.defaultText;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            ctx.fillText(cell.displayValue, Math.round(x + 4 + accentBarOffset), textY, width - 8 - accentBarOffset);
            ctx.restore();
            return;
        }

        const text = cell.placeholderText;
        if (!text) return;

        const placeholderFont = `italic ${this.#theme.defaultFontSize}px ${this.#theme.defaultFontFamily}`;
        if (placeholderFont !== this.#lastFont) { ctx.font = placeholderFont; this.#lastFont = placeholderFont; }
        ctx.fillStyle = this.#theme.entryPlaceholderText;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(text, Math.round(x + 4 + accentBarOffset), textY);
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
     * @param {CanvasRenderingContext2D} ctx
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     */
    #paintUrlContent(ctx, cell) {
        const text = cell.displayValue;
        if (!text) return;

        const font = this.#buildFont(cell);
        if (font !== this.#lastFont) { ctx.font = font; this.#lastFont = font; }
        ctx.fillStyle = this.#theme.urlColor;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        const textX = Math.round(cell.x + 4);
        const fontSize = cell.fontSize || this.#theme.defaultFontSize;
        const vAlign = cell.vAlign || 'middle';
        let textY;
        if (vAlign === 'top') {
            textY = Math.round(cell.y + 4 + fontSize / 2);
        } else if (vAlign === 'bottom') {
            textY = Math.round(cell.y + cell.height - 4 - fontSize / 2);
        } else {
            textY = Math.round(cell.y + cell.height / 2);
        }

        ctx.fillText(text, textX, textY);

        // Underline
        const tw = ctx.measureText(text).width;
        ctx.strokeStyle = this.#theme.urlColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(textX, textY + 7);
        ctx.lineTo(textX + tw, textY + 7);
        ctx.stroke();
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
        if (text) ctx.fillText(text, x + pad, y + height / 2);
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
            const lineWidth = edge.width || 1;
            ctx.lineWidth = lineWidth;

            // Calculate offset based on line width to ensure proper positioning
            // For lineWidth=1: offset=0.5 (center of pixel)
            // For lineWidth>1: offset by half the width to position stroke outside the cell
            const offset = lineWidth === 1 ? 0.5 : Math.ceil(lineWidth / 2);

            // Adjust coordinates based on edge position
            let adjustedX1 = x1, adjustedY1 = y1, adjustedX2 = x2, adjustedY2 = y2;

            if (position === 'top') {
                // Top edge: position above the cell (-offset)
                adjustedY1 = y1 - (offset - 0.5);
                adjustedY2 = y2 - (offset - 0.5);
            } else if (position === 'bottom') {
                // Bottom edge: position below the cell (+offset)
                adjustedY1 = y1 + (offset - 0.5);
                adjustedY2 = y2 + (offset - 0.5);
            } else if (position === 'left') {
                // Left edge: position left of the cell (-offset)
                adjustedX1 = x1 - (offset - 0.5);
                adjustedX2 = x2 - (offset - 0.5);
            } else if (position === 'right') {
                // Right edge: position right of the cell (+offset)
                adjustedX1 = x1 + (offset - 0.5);
                adjustedX2 = x2 + (offset - 0.5);
            }

            ctx.beginPath();
            ctx.moveTo(adjustedX1, adjustedY1);
            ctx.lineTo(adjustedX2, adjustedY2);
            ctx.stroke();
        };

        // Paint borders with proper positioning for their edges
        if (borders.top) paintEdge(borders.top, x, y, x + w, y, 'top');
        if (borders.right) paintEdge(borders.right, x + w, y, x + w, y + h, 'right');
        if (borders.bottom) paintEdge(borders.bottom, x, y + h, x + w, y + h, 'bottom');
        if (borders.left) paintEdge(borders.left, x, y, x, y + h, 'left');
    }

    // ─── Private: font / text helpers ─────────────────────────────────────────

    /**
     * Build a CSS font string from cell style properties.
     * @param {import('./CellPaintData.js').CellPaintItem} cell
     * @returns {string}
     */
    #buildFont(cell) {
        const style = cell.italic ? 'italic' : 'normal';
        const weight = cell.bold ? 'bold' : 'normal';
        const size = cell.fontSize || this.#theme.defaultFontSize;
        const family = cell.fontFamily || this.#theme.defaultFontFamily;
        return `${style} ${weight} ${size}px ${family}`;
    }
}

export default CanvasRenderer;
