<script>
    import { onMount, onDestroy } from "svelte";
    import { spreadsheetSession } from "../../stores/spreadsheetStore.svelte.js";
    import storage from "../../stores/storage.js";
    import { selectionState } from "../../stores/spreadsheet/index.js";
    import { VectorPrintEngine } from "../../stores/spreadsheet/rendering/VectorPrintEngine.js";
    import { CanvasRenderer } from "../../stores/spreadsheet/rendering/CanvasRenderer.js";
    import { buildPaneData } from "../../stores/spreadsheet/rendering/CellPaintData.js";
    import { PrintEngine } from "../../stores/spreadsheet/features/PrintEngine.js";
    import { AxisMetrics } from "../../stores/spreadsheet/virtualization/AxisMetrics.svelte.js";
    import { ROW_HEIGHT, COL_WIDTH } from "../../stores/spreadsheetStore.svelte.js";

    let { onclose } = $props();

    // ── Paper sizes & constants ────────────────────────────────────────────────
    const PAPER_SIZES = [
        { key: 'A4',     label: 'A4' },
        { key: 'letter', label: 'Letter' },
        { key: 'legal',  label: 'Legal' },
        { key: 'A3',     label: 'A3' },
        { key: 'A5',     label: 'A5' },
    ];

    const PAPER_DIMS = {
        A4:     { w: 210,   h: 297   },
        letter: { w: 215.9, h: 279.4 },
        legal:  { w: 215.9, h: 355.6 },
        A3:     { w: 297,   h: 420   },
        A5:     { w: 148,   h: 210   },
    };

    // Margin presets stored in mm; displayed in inches to the user.
    const MARGIN_PRESETS = {
        normal:  { top: 19.05, bottom: 19.05, left: 19.05, right: 19.05 }, // 0.75 in
        wide:    { top: 38.1,  bottom: 38.1,  left: 38.1,  right: 38.1  }, // 1.5 in
        narrow:  { top: 12.7,  bottom: 12.7,  left: 12.7,  right: 12.7  }, // 0.5 in
    };

    const CSS_PX_PER_INCH = 96;
    const MM_PER_INCH = 25.4;

    /** Display a mm value as rounded inches. */
    const mmToIn = (mm) => +(mm / MM_PER_INCH).toFixed(2);
    /** Clamp and round an inch input value, then return mm. */
    function inToMm(v) {
        const n = parseFloat(v);
        return isNaN(n) ? 0 : Math.round(Math.max(0, Math.min(4, n)) * MM_PER_INCH * 10) / 10;
    }

    // ── Capture selection at open time ─────────────────────────────────────────
    const selectionRange = selectionState.range ? {
        areaStartRow: selectionState.range.startRow,
        areaStartCol: selectionState.range.startCol,
        areaEndRow:   selectionState.range.endRow,
        areaEndCol:   selectionState.range.endCol,
    } : null;
    const hasSelection = selectionRange !== null;

    // ── Load settings ──────────────────────────────────────────────────────────
    const saved = spreadsheetSession.activeSheetStore?.getPrintSettings() ?? {};

    let paperSize    = $state(saved.paperSize    ?? 'letter');
    let orientation  = $state(saved.orientation  ?? 'portrait');
    let marginTop    = $state(saved.marginTop    ?? 19.05); // 0.75 in
    let marginBottom = $state(saved.marginBottom ?? 19.05);
    let marginLeft   = $state(saved.marginLeft   ?? 19.05);
    let marginRight  = $state(saved.marginRight  ?? 19.05);
    let scale        = $state(saved.scale        ?? 1.0);
    /** When true, scale is re-fitted to page width whenever margins/paper/orientation change. */
    let autoFitWidth = $state(saved.autoFitWidth ?? false);
    let showGridLines = $state(saved.showGridLines ?? true);
    let printDPI     = $state(saved.printDPI     ?? 300);
    let printArea    = $state(saved.printArea    ?? 'usedArea');
    let pageOrder    = $state(saved.pageOrder    ?? 'downThenOver');
    let headerLeft   = $state(saved.headerLeft   ?? '');
    let headerCenter = $state(saved.headerCenter ?? '');
    let headerRight  = $state(saved.headerRight  ?? '');
    let footerLeft   = $state(saved.footerLeft   ?? '');
    let footerCenter = $state(saved.footerCenter ?? '');
    let footerRight  = $state(saved.footerRight  ?? '');

    // ── HF section expanded state ──────────────────────────────────────────────
    let hfExpanded = $state(!!(saved.headerLeft || saved.headerCenter || saved.headerRight || saved.footerLeft || saved.footerCenter || saved.footerRight));

    // ── Page geometry ──────────────────────────────────────────────────────────
    let pageInfo = $derived.by(() => {
        const dims = PAPER_DIMS[paperSize] ?? PAPER_DIMS.A4;
        const pw = orientation === 'landscape' ? dims.h : dims.w;
        const ph = orientation === 'landscape' ? dims.w : dims.h;
        return {
            pageW: pw,
            pageH: ph,
            printW: Math.max(1, pw - marginLeft - marginRight),
            printH: Math.max(1, ph - marginTop  - marginBottom),
        };
    });

    // ── Used area ─────────────────────────────────────────────────────────────
    function computeUsedArea(sheetStore) {
        let minRow = Infinity, maxRow = -Infinity;
        let minCol = Infinity, maxCol = -Infinity;
        sheetStore.cells.forEach((cell, key) => {
            if (!cell || !cell.exists) return;
            const comma = key.indexOf(',');
            const row = parseInt(key.slice(0, comma), 10);
            const col = parseInt(key.slice(comma + 1), 10);
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;
            if (col < minCol) minCol = col;
            if (col > maxCol) maxCol = col;
        });
        if (!isFinite(maxRow)) return null;
        return { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol };
    }

    /**
     * Like computeUsedArea but also extends bounds to cover floating images.
     * Returns row/col index bounds (for page-break computation) AND pixel extents
     * (for scale computation) as a unified object.
     * @param {import('../../stores/spreadsheet/SheetStore.svelte.js').SheetStore} sheetStore
     * @param {import('../../stores/spreadsheet/virtualization/AxisMetrics.svelte.js').AxisMetrics} rowMetrics
     * @param {import('../../stores/spreadsheet/virtualization/AxisMetrics.svelte.js').AxisMetrics} colMetrics
     */
    function computeContentBounds(sheetStore, rowMetrics, colMetrics) {
        const cellBounds = computeUsedArea(sheetStore);
        let endRow = cellBounds?.endRow ?? -1;
        let endCol = cellBounds?.endCol ?? -1;
        let startRow = cellBounds?.startRow ?? 0;
        let startCol = cellBounds?.startCol ?? 0;
        // Pixel extents (may exceed the last cell's right/bottom edge)
        let maxW = endCol >= 0 ? colMetrics.offsetOf(endCol + 1) : 0;
        let maxH = endRow >= 0 ? rowMetrics.offsetOf(endRow + 1) : 0;

        for (const img of (sheetStore.floatingImages?.values() ?? [])) {
            const imgRight  = colMetrics.offsetOf(img.anchorCol) + img.offsetX + img.width;
            const imgBottom = rowMetrics.offsetOf(img.anchorRow) + img.offsetY + img.height;
            if (imgRight  > maxW) maxW = imgRight;
            if (imgBottom > maxH) maxH = imgBottom;
            // Convert pixel extents back to row/col indices for page-break engine
            if (imgRight  > 0) {
                const imgEndCol = colMetrics.indexAtOffset(Math.max(0, imgRight - 1));
                if (imgEndCol > endCol) endCol = imgEndCol;
            }
            if (imgBottom > 0) {
                const imgEndRow = rowMetrics.indexAtOffset(Math.max(0, imgBottom - 1));
                if (imgEndRow > endRow) endRow = imgEndRow;
            }
            if (img.anchorCol < startCol) startCol = img.anchorCol;
            if (img.anchorRow < startRow) startRow = img.anchorRow;
        }

        if (endRow < 0 && endCol < 0) return null;
        endRow = Math.max(endRow, 0);
        endCol = Math.max(endCol, 0);
        return { startRow, startCol, endRow, endCol, maxW, maxH };
    }

    // ── Metrics builder ────────────────────────────────────────────────────────
    function buildMetrics(sheetStore) {
        const rowM = new AxisMetrics(sheetStore.defaultRowHeight ?? ROW_HEIGHT);
        rowM.setCount(sheetStore.rowCount);
        rowM.loadOverrides(sheetStore.getRowHeightsMap());

        const colM = new AxisMetrics(sheetStore.defaultColWidth ?? COL_WIDTH);
        colM.setCount(sheetStore.colCount);
        colM.loadOverrides(sheetStore.getColWidthsMap());

        return { rowMetrics: rowM, colMetrics: colM };
    }

    // ── Current settings snapshot ──────────────────────────────────────────────
    function currentSettings() {
        const s = {
            paperSize, orientation,
            marginTop, marginBottom, marginLeft, marginRight,
            scale, autoFitWidth, showGridLines, printDPI,
            printArea, pageOrder,
            headerLeft, headerCenter, headerRight,
            footerLeft, footerCenter, footerRight,
        };
        if (printArea === 'selection' && selectionRange) Object.assign(s, selectionRange);
        return s;
    }

    // ── Auto fit-to-width ──────────────────────────────────────────────────────
    // Re-apply fitToWidth whenever the printable width changes (margins, paper, orientation).
    $effect(() => {
        void [marginLeft, marginRight, marginTop, marginBottom, paperSize, orientation];
        if (autoFitWidth) fitToWidth();
    });

    // ── Page data (breaks + metrics) ───────────────────────────────────────────
    const _printEngine = new PrintEngine();

    let pageData = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const empty = { pages: 0, rows: 0, cols: 0, rowBreaks: [], colBreaks: [], rowMetrics: null, colMetrics: null, areaStartRow: 0, areaStartCol: 0, areaEndRow: 0, areaEndCol: 0 };
        if (!sheetStore) return empty;

        const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
        const totalRows = sheetStore.rowCount;
        const totalCols = sheetStore.colCount;

        const ps = { ...currentSettings() };
        if (ps.printArea === 'usedArea') {
            const bounds = computeContentBounds(sheetStore, rowMetrics, colMetrics);
            if (bounds) Object.assign(ps, { areaStartRow: bounds.startRow, areaStartCol: bounds.startCol, areaEndRow: bounds.endRow, areaEndCol: bounds.endCol });
        } else if (ps.printArea === 'selection' && selectionRange) {
            Object.assign(ps, selectionRange);
        }

        const { rowBreaks, colBreaks } = _printEngine.computePageBreaks(ps, rowMetrics, colMetrics, totalRows, totalCols);

        return {
            pages: rowBreaks.length * colBreaks.length,
            rows: rowBreaks.length,
            cols: colBreaks.length,
            rowBreaks, colBreaks, rowMetrics, colMetrics,
            areaStartRow: ps.areaStartRow ?? 0,
            areaStartCol: ps.areaStartCol ?? 0,
            areaEndRow:   ps.areaEndRow   ?? totalRows - 1,
            areaEndCol:   ps.areaEndCol   ?? totalCols - 1,
        };
    });

    // ── Preview state ──────────────────────────────────────────────────────────
    let previewZoom = $state(1.0);

    /** Map from page index → mounted canvas element, populated by the registerCanvas action. */
    const _pageCanvases = new Map();

    /** Svelte use: action — registers each page's canvas and schedules a render. */
    function registerCanvas(node, pageIdx) {
        _pageCanvases.set(pageIdx, node);
        scheduleRender();
        return { destroy() { _pageCanvases.delete(pageIdx); } };
    }

    // Re-render whenever anything affecting the preview changes.
    $effect(() => {
        void [showGridLines, previewZoom, pageInfo, pageData.pages];
        scheduleRender();
    });

    let renderTimer = null;
    function scheduleRender() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(doRenderAll, 80);
    }

    /** Returns the row/col range for the given page index. */
    function getPageRange(pageIdx) {
        const { rowBreaks, colBreaks, rowMetrics, colMetrics, areaEndRow, areaEndCol } = pageData;
        if (!rowMetrics || !colMetrics || !rowBreaks.length || !colBreaks.length) return null;
        const ri = Math.floor(pageIdx / colBreaks.length);
        const ci = pageIdx % colBreaks.length;
        if (ri >= rowBreaks.length || ci >= colBreaks.length) return null;
        return {
            startRow: rowBreaks[ri],
            endRow:   ri + 1 < rowBreaks.length ? rowBreaks[ri + 1] - 1 : areaEndRow,
            startCol: colBreaks[ci],
            endCol:   ci + 1 < colBreaks.length ? colBreaks[ci + 1] - 1 : areaEndCol,
        };
    }

    async function doRenderAll() {
        renderTimer = null;
        for (let i = 0; i < pageData.pages; i++) {
            const canvas = _pageCanvases.get(i);
            if (canvas) await doRenderPage(canvas, i);
        }
    }

    async function doRenderPage(canvas, pageIdx) {
        const range = getPageRange(pageIdx);
        if (!range) return;

        const sheetStore    = spreadsheetSession.activeSheetStore;
        const renderContext = spreadsheetSession.renderContext;
        const session       = spreadsheetSession;
        if (!sheetStore || !renderContext) return;

        const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
        const { startRow, endRow, startCol, endCol } = range;

        const contentLeft  = colMetrics.offsetOf(startCol);
        const contentTop   = rowMetrics.offsetOf(startRow);
        const contentW_css = Math.max(1, colMetrics.offsetOf(endCol + 1) - contentLeft);
        const contentH_css = Math.max(1, rowMetrics.offsetOf(endRow + 1) - contentTop);

        const { pageW, pageH } = pageInfo;
        const displayW   = Math.round(480 * previewZoom);
        const displayH   = Math.round(displayW * (pageH / pageW));
        const scalePerMm = displayW / pageW;

        const mT = Math.round(marginTop    * scalePerMm);
        const mB = Math.round(marginBottom * scalePerMm);
        const mL = Math.round(marginLeft   * scalePerMm);
        const mR = Math.round(marginRight  * scalePerMm);

        const areaW = displayW - mL - mR;
        const areaH = displayH - mT - mB;
        if (areaW <= 0 || areaH <= 0) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width  = displayW * dpr;
        canvas.height = displayH * dpr;
        canvas.style.width  = displayW + 'px';
        canvas.style.height = displayH + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, displayW, displayH);

        ctx.fillStyle = 'rgba(241, 245, 249, 0.6)';
        ctx.fillRect(0, 0, displayW, mT);
        ctx.fillRect(0, displayH - mB, displayW, mB);
        ctx.fillRect(0, mT, mL, areaH);
        ctx.fillRect(displayW - mR, mT, mR, areaH);

        const offscreen = document.createElement('canvas');
        const renderer  = new CanvasRenderer(offscreen);
        // Derive preview scale from the user scale (same as PDF engine) so page-break
        // invariants hold: each page's content is guaranteed to fit within (areaW, areaH).
        const rs = Math.max(0.25, scale * (MM_PER_INCH / CSS_PX_PER_INCH) * scalePerMm);
        renderer.resize(contentW_css, contentH_css, rs * dpr);

        try {
            const cells = buildPaneData({
                rowRange: { start: startRow, end: endRow,   count: endRow   - startRow + 1 },
                colRange: { start: startCol, end: endCol,   count: endCol   - startCol + 1 },
                rowMetrics, colMetrics,
                renderContext, sheetStore, session,
                selectionState: null, formulaEditState: null,
                frozenRows: 0, frozenCols: 0, frozenHeight: 0, frozenWidth: 0,
                scrollLeft: contentLeft, scrollTop: contentTop,
            });

            renderer.clear();
            renderer.paintPane(cells, { clipX: 0, clipY: 0, clipW: contentW_css, clipH: contentH_css, showGridLines });

            // Floating images
            const floatingImgs = [...(sheetStore.floatingImages?.values() ?? [])];
            if (floatingImgs.length) {
                const imgsOnPage = floatingImgs.map(img => ({
                    img,
                    x: colMetrics.offsetOf(img.anchorCol) + img.offsetX - contentLeft,
                    y: rowMetrics.offsetOf(img.anchorRow) + img.offsetY - contentTop,
                })).filter(({ img, x, y }) =>
                    x + img.width > 0 && x < contentW_css && y + img.height > 0 && y < contentH_css
                );
                if (imgsOnPage.length) {
                    await Promise.all(imgsOnPage.map(({ img }) => loadImgElement(img.blobId)));
                    const offCtx = offscreen.getContext('2d');
                    offCtx.save();
                    offCtx.scale(rs * dpr, rs * dpr);
                    for (const { img, x, y } of imgsOnPage) {
                        const loaded = _blobCache.get(img.blobId);
                        if (!loaded?.element) continue;
                        const el = loaded.element;
                        const { dx, dy, dw, dh } = fitRect(el.naturalWidth, el.naturalHeight, x, y, img.width, img.height, img.fit ?? 'contain');
                        offCtx.save();
                        offCtx.beginPath(); offCtx.rect(x, y, img.width, img.height); offCtx.clip();
                        offCtx.drawImage(el, dx, dy, dw, dh);
                        offCtx.restore();
                    }
                    offCtx.restore();
                }
            }

            ctx.save();
            ctx.beginPath();
            ctx.rect(mL, mT, areaW, areaH);
            ctx.clip();
            ctx.drawImage(offscreen, mL, mT, contentW_css * rs, contentH_css * rs);
            ctx.restore();
        } catch (_) {
            // leave white area on failure
        } finally {
            renderer.destroy();
        }

        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 0.75;
        ctx.setLineDash([3, 3]);
        for (const [x1, y1, x2, y2] of [
            [0, mT, displayW, mT], [0, displayH - mB, displayW, displayH - mB],
            [mL, 0, mL, displayH], [displayW - mR, 0, displayW - mR, displayH],
        ]) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
        ctx.setLineDash([]);
    }

    // ── Floating image rendering helpers ─────────────────────────────────────────

    /** Cache of loaded HTMLImageElements for the preview (blobId → {element, url}) */
    const _blobCache = new Map();

    /**
     * Load a blob as an HTMLImageElement, caching by blobId.
     * Uses fetch + createObjectURL so the result is safe for canvas drawImage.
     * @returns {Promise<{element:HTMLImageElement,url:string}|null>}
     */
    async function loadImgElement(blobId) {
        if (_blobCache.has(blobId)) return _blobCache.get(blobId);
        try {
            const resp = await fetch(storage.app.getBlobUrl(blobId));
            if (!resp.ok) return null;
            const blob = await resp.blob();
            const objectUrl = URL.createObjectURL(blob);
            const element = await new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => resolve(null);
                img.src = objectUrl;
            });
            if (!element) { URL.revokeObjectURL(objectUrl); return null; }
            const entry = { element, url: objectUrl };
            _blobCache.set(blobId, entry);
            return entry;
        } catch { return null; }
    }

    /**
     * Compute draw rect for an image fit mode (all values in same unit).
     * Returns the destination (dx, dy, dw, dh) to pass to ctx.drawImage / pdf.addImage.
     */
    function fitRect(srcW, srcH, dstX, dstY, dstW, dstH, fit) {
        if (!srcW || !srcH || !fit || fit === 'fill') return { dx: dstX, dy: dstY, dw: dstW, dh: dstH };
        const sa = srcW / srcH, da = dstW / dstH;
        if (fit === 'contain') {
            if (sa > da) { const dh = dstW / sa; return { dx: dstX, dy: dstY + (dstH - dh) / 2, dw: dstW, dh }; }
            else         { const dw = dstH * sa; return { dx: dstX + (dstW - dw) / 2, dy: dstY, dw, dh: dstH }; }
        }
        if (fit === 'cover') {
            if (sa > da) { const dw = dstH * sa; return { dx: dstX + (dstW - dw) / 2, dy: dstY, dw, dh: dstH }; }
            else         { const dh = dstW / sa; return { dx: dstX, dy: dstY + (dstH - dh) / 2, dw: dstW, dh }; }
        }
        if (fit === 'none') return { dx: dstX, dy: dstY, dw: srcW, dh: srcH };
        return { dx: dstX, dy: dstY, dw: dstW, dh: dstH };
    }

    onDestroy(() => {
        clearTimeout(renderTimer);
        for (const { url } of _blobCache.values()) URL.revokeObjectURL(url);
        _blobCache.clear();
    });

    // On open: apply fit-to-width if it was previously active, or if no scale was ever saved.
    onMount(() => { if (saved.scale == null || saved.autoFitWidth) fitToWidth(); });

    // ── Actions ────────────────────────────────────────────────────────────────
    function applyMarginPreset(preset) {
        const p = MARGIN_PRESETS[preset];
        marginTop = p.top; marginBottom = p.bottom;
        marginLeft = p.left; marginRight = p.right;
    }

    function fitToWidth() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
        const bounds = computeContentBounds(sheetStore, rowMetrics, colMetrics);
        const contentW_css = Math.max(1, bounds?.maxW ?? colMetrics.offsetOf(bounds?.endCol ?? sheetStore.colCount - 1 + 1));
        const printW_css   = (pageInfo.printW / MM_PER_INCH) * CSS_PX_PER_INCH;
        scale = Math.max(0.1, Math.min(4.0, Math.round((printW_css / contentW_css) * 100) / 100));
        autoFitWidth = true;
    }

    function fitToPage() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
        const bounds = computeContentBounds(sheetStore, rowMetrics, colMetrics);
        const contentW_css = Math.max(1, bounds?.maxW ?? colMetrics.offsetOf(sheetStore.colCount));
        const contentH_css = Math.max(1, bounds?.maxH ?? rowMetrics.offsetOf(sheetStore.rowCount));
        const printW_css = (pageInfo.printW / MM_PER_INCH) * CSS_PX_PER_INCH;
        const printH_css = (pageInfo.printH / MM_PER_INCH) * CSS_PX_PER_INCH;
        const scaleW = printW_css / contentW_css;
        const scaleH = printH_css / contentH_css;
        scale = Math.max(0.1, Math.min(4.0, Math.round(Math.min(scaleW, scaleH) * 100) / 100));
        autoFitWidth = false; // fit page is a one-shot, not a persistent mode
    }

    function clampScale(v) {
        const n = parseFloat(v);
        return isNaN(n) ? scale : Math.max(0.1, Math.min(4.0, Math.round(n * 100) / 100));
    }

    function saveSettings() {
        spreadsheetSession.activeSheetStore?.setPrintSettings(currentSettings());
    }

    let isExporting = $state(false);
    let isPrinting  = $state(false);
    let exportError = $state(null);

    function getPdfParams() {
        const sheetStore    = spreadsheetSession.activeSheetStore;
        const renderContext = spreadsheetSession.renderContext;
        if (!sheetStore || !renderContext) return null;
        const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
        return {
            printSettings: currentSettings(),
            renderContext,
            sheetStore,
            session: spreadsheetSession,
            rowMetrics,
            colMetrics,
            docName: spreadsheetSession.docTitle || sheetStore.name || 'sheet',
            fetchBlobFn: (blobId) => fetch(storage.app.getBlobUrl(blobId)).then(r => {
                if (!r.ok) throw new Error(`blob ${blobId}: ${r.status}`);
                return r.blob();
            }),
        };
    }

    async function handleExportPDF() {
        if (isExporting || isPrinting) return;
        const params = getPdfParams();
        if (!params) { exportError = 'No active sheet to export.'; return; }

        saveSettings();
        isExporting = true;
        exportError = null;
        try {
            const engine = new VectorPrintEngine();
            await engine.downloadPDF(params, `${params.docName}.pdf`);
        } catch (err) {
            console.error('PDF export failed:', err);
            exportError = 'Export failed — see console for details.';
        } finally {
            isExporting = false;
        }
    }

    async function handlePrint() {
        if (isExporting || isPrinting) return;
        const params = getPdfParams();
        if (!params) { exportError = 'No active sheet to export.'; return; }

        saveSettings();
        isPrinting = true;
        exportError = null;
        try {
            const engine = new VectorPrintEngine();
            const blob = await engine.generatePDF(params);
            const url  = URL.createObjectURL(blob);
            const win  = window.open(url, '_blank');
            if (!win) {
                // Popup blocked — fall back to direct download
                const a = document.createElement('a');
                a.href = url; a.download = `${params.docName}.pdf`; a.click();
            }
            // Revoke after enough time for the new tab to load the blob
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (err) {
            console.error('Print failed:', err);
            exportError = 'Print failed — see console for details.';
        } finally {
            isPrinting = false;
        }
    }

    function handleClose() { saveSettings(); onclose?.(); }

    const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
    function zoomIn()  {
        const next = ZOOM_STEPS.find(z => z > previewZoom);
        if (next) previewZoom = next;
    }
    function zoomOut() {
        const prev = [...ZOOM_STEPS].reverse().find(z => z < previewZoom);
        if (prev) previewZoom = prev;
    }
</script>

<!-- Backdrop -->
<div class="backdrop" role="dialog" aria-modal="true" aria-label="PDF Export">
    <div class="panel">

        <!-- Header -->
        <div class="panel-header">
            <h2 class="panel-title">PDF Export</h2>
            <button class="close-btn" onclick={handleClose} title="Close">✕</button>
        </div>

        <!-- Body: settings sidebar + preview -->
        <div class="panel-body">

            <!-- Settings sidebar -->
            <div class="sidebar">

                <!-- Paper & Orientation -->
                <section class="section">
                    <div class="section-title">Paper</div>
                    <div class="paper-row">
                        <select class="select" bind:value={paperSize}>
                            {#each PAPER_SIZES as ps}
                                <option value={ps.key}>{ps.label}</option>
                            {/each}
                        </select>
                        <div class="orient-btns">
                            <button
                                class="orient-btn"
                                class:active={orientation === 'portrait'}
                                onclick={() => orientation = 'portrait'}
                                title="Portrait"
                            >
                                <svg width="14" height="18" viewBox="0 0 14 18"><rect x="1" y="1" width="12" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
                            </button>
                            <button
                                class="orient-btn"
                                class:active={orientation === 'landscape'}
                                onclick={() => orientation = 'landscape'}
                                title="Landscape"
                            >
                                <svg width="18" height="14" viewBox="0 0 18 14"><rect x="1" y="1" width="16" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="paper-dims-hint">{mmToIn(pageInfo.pageW).toFixed(2)}×{mmToIn(pageInfo.pageH).toFixed(2)} in · printable {mmToIn(pageInfo.printW).toFixed(2)}×{mmToIn(pageInfo.printH).toFixed(2)} in</div>
                </section>

                <!-- Margins -->
                <section class="section">
                    <div class="section-title-row">
                        <span class="section-title">Margins</span>
                        <div class="preset-btns">
                            <button class="preset-btn" onclick={() => applyMarginPreset('normal')}>Normal</button>
                            <button class="preset-btn" onclick={() => applyMarginPreset('wide')}>Wide</button>
                            <button class="preset-btn" onclick={() => applyMarginPreset('narrow')}>Narrow</button>
                        </div>
                    </div>
                    <div class="margins-grid">
                        {#each [['Top', 'marginTop', marginTop], ['Bottom', 'marginBottom', marginBottom], ['Left', 'marginLeft', marginLeft], ['Right', 'marginRight', marginRight]] as [label, key, val]}
                            <label class="margin-label">
                                <span class="margin-name">{label}</span>
                                <input
                                    type="number" class="margin-input" min="0" max="4" step="0.05"
                                    value={mmToIn(val)}
                                    onchange={(e) => {
                                        const v = inToMm(e.target.value);
                                        if (key === 'marginTop') marginTop = v;
                                        else if (key === 'marginBottom') marginBottom = v;
                                        else if (key === 'marginLeft') marginLeft = v;
                                        else marginRight = v;
                                    }}
                                />
                                <span class="margin-unit">in</span>
                            </label>
                        {/each}
                    </div>
                </section>

                <!-- Scale -->
                <section class="section">
                    <div class="section-title-row">
                        <span class="section-title">Scale</span>
                        <span class="scale-pct">{Math.round(scale * 100)}%</span>
                    </div>
                    <input type="range" class="scale-slider" min="0.25" max="2" step="0.05"
                        bind:value={scale}
                        oninput={() => { autoFitWidth = false; scale = clampScale(scale); }}
                    />
                    <div class="fit-btns">
                        <button class="preset-btn" class:active={autoFitWidth} onclick={fitToWidth}>Fit width</button>
                        <button class="preset-btn" onclick={fitToPage}>Fit page</button>
                        <button class="preset-btn" onclick={() => { autoFitWidth = false; scale = 1.0; }}>Reset</button>
                    </div>
                </section>

                <!-- Content Options -->
                <section class="section">
                    <div class="section-title">Content</div>
                    <div class="field-row">
                        <span class="field-label">Print area</span>
                        <div class="radio-row">
                            <label class="radio-label">
                                <input type="radio" name="printArea" value="usedArea" bind:group={printArea} />
                                Used area
                            </label>
                            <label class="radio-label" class:disabled={!hasSelection}>
                                <input type="radio" name="printArea" value="selection" bind:group={printArea} disabled={!hasSelection} />
                                Selection
                            </label>
                        </div>
                    </div>
                    <div class="field-row" style="margin-top:6px;">
                        <span class="field-label">Page order</span>
                        <div class="radio-row">
                            <label class="radio-label">
                                <input type="radio" name="pageOrder" value="downThenOver" bind:group={pageOrder} />
                                Down, over
                            </label>
                            <label class="radio-label">
                                <input type="radio" name="pageOrder" value="overThenDown" bind:group={pageOrder} />
                                Over, down
                            </label>
                        </div>
                    </div>
                    <label class="checkbox-label" style="margin-top:8px;">
                        <input type="checkbox" bind:checked={showGridLines} />
                        Show gridlines
                    </label>
                    <label class="checkbox-label" style="margin-top:4px; font-size:0.775rem;">
                        <span style="color:var(--color-text-secondary);">Quality</span>
                        <select class="select-sm" bind:value={printDPI}>
                            <option value={150}>150 dpi</option>
                            <option value={200}>200 dpi</option>
                            <option value={300}>300 dpi</option>
                            <option value={400}>400 dpi</option>
                        </select>
                    </label>
                </section>

                <!-- Header / Footer (collapsible) -->
                <section class="section">
                    <button class="section-toggle" onclick={() => hfExpanded = !hfExpanded}>
                        <span class="section-title">Header / Footer</span>
                        <span class="toggle-arrow" class:open={hfExpanded}>›</span>
                    </button>
                    {#if hfExpanded}
                        <div class="hf-block">
                            <div class="hf-row-label">Header</div>
                            <div class="hf-inputs">
                                <input type="text" class="hf-input" placeholder="Left" bind:value={headerLeft} />
                                <input type="text" class="hf-input" placeholder="Center" bind:value={headerCenter} />
                                <input type="text" class="hf-input" placeholder="Right" bind:value={headerRight} />
                            </div>
                            <div class="hf-row-label" style="margin-top:6px;">Footer</div>
                            <div class="hf-inputs">
                                <input type="text" class="hf-input" placeholder="Left" bind:value={footerLeft} />
                                <input type="text" class="hf-input" placeholder="Center" bind:value={footerCenter} />
                                <input type="text" class="hf-input" placeholder="Right" bind:value={footerRight} />
                            </div>
                            <div class="hf-vars">
                                {'{page}'} {'{pages}'} {'{sheetName}'} {'{docName}'} {'{date}'} {'{time}'}
                            </div>
                        </div>
                    {/if}
                </section>

                <!-- Page count summary -->
                <div class="page-summary">
                    <span class="page-count">{pageData.pages} page{pageData.pages !== 1 ? 's' : ''}</span>
                    <span class="page-grid">{pageData.rows}r × {pageData.cols}c</span>
                </div>
            </div>

            <!-- Preview panel -->
            <div class="preview-panel">
                <!-- Toolbar: page count + zoom -->
                <div class="preview-toolbar">
                    <span class="page-count-label">
                        {pageData.pages} page{pageData.pages !== 1 ? 's' : ''}
                    </span>
                    <div class="zoom-controls">
                        <button class="zoom-btn" onclick={zoomOut} disabled={previewZoom <= ZOOM_STEPS[0]}>−</button>
                        <span class="zoom-label">{Math.round(previewZoom * 100)}%</span>
                        <button class="zoom-btn" onclick={zoomIn} disabled={previewZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}>+</button>
                    </div>
                </div>

                <!-- All pages stacked vertically -->
                <div class="preview-scroll">
                    {#if pageData.pages === 0}
                        <div class="empty-preview">No content to preview</div>
                    {:else}
                        <div class="pages-column">
                            {#each Array(pageData.pages) as _, i (i)}
                                <div class="paper-shadow">
                                    <canvas use:registerCanvas={i}></canvas>
                                </div>
                            {/each}
                        </div>
                    {/if}
                </div>
            </div>
        </div>

        <!-- Error -->
        {#if exportError}
            <div class="error-banner">{exportError}</div>
        {/if}

        <!-- Footer actions -->
        <div class="panel-footer">
            <button class="btn btn-ghost" onclick={handleClose}>Cancel</button>
            <button class="btn btn-secondary" onclick={saveSettings}>Save settings</button>
            <button class="btn btn-secondary" onclick={handlePrint} disabled={isPrinting || isExporting || pageData.pages === 0}>
                {isPrinting ? 'Opening…' : 'Print…'}
            </button>
            <button class="btn btn-primary" onclick={handleExportPDF} disabled={isExporting || isPrinting || pageData.pages === 0}>
                {isExporting ? 'Exporting…' : 'Export PDF'}
            </button>
        </div>
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .panel {
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 12px;
        box-shadow: 0 16px 60px rgba(0, 0, 0, 0.25);
        width: min(92vw, 1040px);
        height: min(90vh, 760px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    /* ── Header ── */
    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 20px 13px;
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
    }

    .panel-title {
        font-size: 0.9375rem;
        font-weight: 600;
        margin: 0;
        color: var(--color-text, #1e293b);
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 1rem;
        color: var(--color-text-secondary, #64748b);
        padding: 2px 7px;
        border-radius: 4px;
        line-height: 1;
    }
    .close-btn:hover { background: var(--color-fill, #f1f5f9); }

    /* ── Body ── */
    .panel-body {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    /* ── Settings sidebar ── */
    .sidebar {
        width: 300px;
        flex-shrink: 0;
        border-right: 1px solid var(--color-border, #e2e8f0);
        overflow-y: auto;
        padding: 16px 16px 12px;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }

    .section {
        display: flex;
        flex-direction: column;
        gap: 7px;
    }

    .section-title {
        font-size: 0.7rem;
        font-weight: 700;
        color: var(--color-text-secondary, #64748b);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .section-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .section-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
    }

    .toggle-arrow {
        font-size: 1rem;
        color: var(--color-text-secondary, #64748b);
        transform: rotate(0deg);
        transition: transform 0.15s;
        display: inline-block;
    }
    .toggle-arrow.open { transform: rotate(90deg); }

    /* Paper row */
    .paper-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .select {
        flex: 1;
        height: 28px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 5px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        font-size: 0.8125rem;
        padding: 0 6px;
        cursor: pointer;
    }
    .select:focus { outline: 2px solid var(--color-primary, #3b82f6); outline-offset: 1px; }

    .orient-btns {
        display: flex;
        gap: 3px;
    }

    .orient-btn {
        width: 28px;
        height: 28px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 5px;
        background: var(--color-fill, #f8fafc);
        color: var(--color-text-secondary, #64748b);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
    }
    .orient-btn:hover { background: var(--color-fill-2, #e2e8f0); }
    .orient-btn.active {
        background: var(--color-primary, #3b82f6);
        border-color: var(--color-primary, #3b82f6);
        color: #fff;
    }

    .paper-dims-hint {
        font-size: 0.7rem;
        color: var(--color-text-secondary, #94a3b8);
    }

    /* Margins */
    .preset-btns {
        display: flex;
        gap: 3px;
    }

    .preset-btn {
        height: 20px;
        padding: 0 7px;
        border-radius: 4px;
        font-size: 0.7rem;
        font-weight: 500;
        border: 1px solid var(--color-border, #e2e8f0);
        background: var(--color-fill, #f1f5f9);
        color: var(--color-text, #1e293b);
        cursor: pointer;
        white-space: nowrap;
    }
    .preset-btn:hover { background: var(--color-fill-2, #e2e8f0); }
    .preset-btn.active {
        background: var(--color-primary, #3b82f6);
        border-color: var(--color-primary, #3b82f6);
        color: #fff;
    }

    .margins-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 5px 10px;
    }

    .margin-label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 0.8rem;
        color: var(--color-text, #1e293b);
    }

    .margin-name {
        width: 42px;
        color: var(--color-text-secondary, #64748b);
        font-size: 0.775rem;
    }

    .margin-input {
        flex: 1;
        height: 24px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        padding: 0 5px;
        font-size: 0.8rem;
        text-align: right;
        color: var(--color-text, #1e293b);
        background: var(--color-surface, #fff);
        min-width: 0;
    }
    .margin-input:focus { outline: 2px solid var(--color-primary, #3b82f6); outline-offset: 1px; }

    .margin-unit {
        font-size: 0.7rem;
        color: var(--color-text-secondary, #94a3b8);
    }

    /* Scale */
    .scale-pct {
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--color-text, #1e293b);
    }

    .scale-slider {
        width: 100%;
        accent-color: var(--color-primary, #3b82f6);
        cursor: pointer;
    }

    .fit-btns {
        display: flex;
        gap: 4px;
    }

    /* Field rows */
    .field-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .field-label {
        font-size: 0.75rem;
        color: var(--color-text-secondary, #64748b);
    }

    .radio-row {
        display: flex;
        gap: 12px;
    }

    .radio-label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 0.8rem;
        cursor: pointer;
        color: var(--color-text, #1e293b);
    }
    .radio-label.disabled { opacity: 0.45; cursor: not-allowed; }

    .checkbox-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.8125rem;
        cursor: pointer;
        color: var(--color-text, #1e293b);
        user-select: none;
    }

    .select-sm {
        height: 22px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        font-size: 0.75rem;
        padding: 0 4px;
        cursor: pointer;
        margin-left: 4px;
    }

    /* Header / footer */
    .hf-block {
        display: flex;
        flex-direction: column;
        gap: 3px;
    }

    .hf-row-label {
        font-size: 0.7rem;
        color: var(--color-text-secondary, #64748b);
        font-weight: 500;
    }

    .hf-inputs {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 4px;
    }

    .hf-input {
        height: 24px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        padding: 0 5px;
        font-size: 0.75rem;
        color: var(--color-text, #1e293b);
        background: var(--color-surface, #fff);
        min-width: 0;
    }
    .hf-input:focus { outline: 2px solid var(--color-primary, #3b82f6); outline-offset: 1px; }

    .hf-vars {
        font-size: 0.65rem;
        color: var(--color-text-secondary, #94a3b8);
        margin-top: 3px;
        line-height: 1.6;
        font-family: monospace;
    }

    /* Page summary */
    .page-summary {
        margin-top: auto;
        padding-top: 10px;
        border-top: 1px solid var(--color-border, #e2e8f0);
        display: flex;
        align-items: baseline;
        gap: 8px;
    }

    .page-count {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text, #1e293b);
    }

    .page-grid {
        font-size: 0.75rem;
        color: var(--color-text-secondary, #64748b);
    }

    /* ── Preview panel ── */
    .preview-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        background: var(--color-fill, #f1f5f9);
    }

    .preview-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        background: var(--color-surface, #fff);
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
    }

    .page-count-label {
        font-size: 0.8125rem;
        color: var(--color-text-secondary, #64748b);
    }

    .zoom-controls {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .zoom-btn {
        width: 24px;
        height: 24px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        font-size: 1rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        line-height: 1;
    }
    .zoom-btn:hover:not(:disabled) { background: var(--color-fill, #f1f5f9); }
    .zoom-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    .zoom-label {
        font-size: 0.8rem;
        color: var(--color-text-secondary, #64748b);
        min-width: 36px;
        text-align: center;
    }

    .preview-scroll {
        flex: 1;
        overflow: auto;
        padding: 24px;
    }

    .pages-column {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 20px;
    }

    .paper-shadow {
        display: inline-block;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18), 0 1px 4px rgba(0, 0, 0, 0.1);
        border-radius: 1px;
        line-height: 0;
    }

    .paper-shadow canvas {
        display: block;
    }

    .empty-preview {
        padding: 60px 24px;
        color: var(--color-text-secondary, #94a3b8);
        font-size: 0.875rem;
        text-align: center;
    }

    /* ── Error / Footer ── */
    .error-banner {
        margin: 0 20px 10px;
        padding: 8px 12px;
        background: #fef2f2;
        color: #b91c1c;
        border: 1px solid #fecaca;
        border-radius: 5px;
        font-size: 0.8125rem;
        flex-shrink: 0;
    }

    .panel-footer {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 8px;
        padding: 12px 20px;
        border-top: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
    }

    .btn {
        height: 32px;
        padding: 0 16px;
        border-radius: 6px;
        font-size: 0.8125rem;
        font-weight: 500;
        border: 1px solid transparent;
        cursor: pointer;
        transition: background 0.08s, opacity 0.08s;
    }

    .btn-ghost {
        background: transparent;
        color: var(--color-text-secondary, #64748b);
    }
    .btn-ghost:hover { background: var(--color-fill, #f1f5f9); }

    .btn-secondary {
        background: var(--color-fill, #f1f5f9);
        color: var(--color-text, #1e293b);
        border-color: var(--color-border, #e2e8f0);
    }
    .btn-secondary:hover { background: var(--color-fill-2, #e2e8f0); }

    .btn-primary {
        background: var(--color-primary, #3b82f6);
        color: #fff;
    }
    .btn-primary:hover:not(:disabled) { background: var(--color-primary-dark, #2563eb); }
    .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
