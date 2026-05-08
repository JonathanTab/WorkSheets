<script>
    import { onDestroy } from "svelte";
    import { spreadsheetSession } from "../../stores/spreadsheetStore.svelte.js";
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

    const MARGIN_PRESETS = {
        normal:  { top: 19,   bottom: 19,   left: 18,   right: 18   },
        wide:    { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
        narrow:  { top: 12,   bottom: 12,   left: 6.4,  right: 6.4  },
    };

    const CSS_PX_PER_INCH = 96;
    const MM_PER_INCH = 25.4;

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

    let paperSize    = $state(saved.paperSize    ?? 'A4');
    let orientation  = $state(saved.orientation  ?? 'portrait');
    let marginTop    = $state(saved.marginTop    ?? 19);
    let marginBottom = $state(saved.marginBottom ?? 19);
    let marginLeft   = $state(saved.marginLeft   ?? 18);
    let marginRight  = $state(saved.marginRight  ?? 18);
    let scale        = $state(saved.scale        ?? 1.0);
    let showGridLines = $state(saved.showGridLines ?? true);
    let printDPI     = $state(saved.printDPI     ?? 300);
    let printArea    = $state(saved.printArea    ?? 'usedArea');
    let pageOrder    = $state(saved.pageOrder    ?? 'downThenOver');
    let headerLeft   = $state(saved.headerLeft   ?? '');
    let headerCenter = $state(saved.headerCenter ?? '');
    let headerRight  = $state(saved.headerRight  ?? '');
    let footerLeft   = $state(saved.footerLeft   ?? '');
    let footerCenter = $state(saved.footerCenter ?? '{sheetName}');
    let footerRight  = $state(saved.footerRight  ?? 'Page {page} of {pages}');

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
            scale, showGridLines, printDPI,
            printArea, pageOrder,
            headerLeft, headerCenter, headerRight,
            footerLeft, footerCenter, footerRight,
        };
        if (printArea === 'selection' && selectionRange) Object.assign(s, selectionRange);
        return s;
    }

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
            const used = computeUsedArea(sheetStore);
            if (used) Object.assign(ps, { areaStartRow: used.startRow, areaStartCol: used.startCol, areaEndRow: used.endRow, areaEndCol: used.endCol });
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
    let previewCanvasEl = $state(null);
    let previewPageIdx  = $state(0);
    let previewZoom     = $state(1.0);
    let isRendering     = $state(false);

    // Clamp page index when page count changes
    $effect(() => {
        const total = pageData.pages;
        if (total > 0 && previewPageIdx >= total) previewPageIdx = total - 1;
    });

    // Per-page row/col range for the current preview page
    let previewPageRange = $derived.by(() => {
        const { rowBreaks, colBreaks, rowMetrics, colMetrics, areaEndRow, areaEndCol } = pageData;
        if (!rowMetrics || !colMetrics || !rowBreaks.length || !colBreaks.length) return null;
        const total = rowBreaks.length * colBreaks.length;
        const idx   = Math.min(previewPageIdx, total - 1);
        const ri    = Math.floor(idx / colBreaks.length);
        const ci    = idx % colBreaks.length;
        return {
            startRow: rowBreaks[ri],
            endRow:   ri + 1 < rowBreaks.length ? rowBreaks[ri + 1] - 1 : areaEndRow,
            startCol: colBreaks[ci],
            endCol:   ci + 1 < colBreaks.length ? colBreaks[ci + 1] - 1 : areaEndCol,
            total,
            idx,
        };
    });

    // Schedule a re-render whenever anything preview-related changes
    $effect(() => {
        void [previewCanvasEl, previewPageRange, showGridLines, previewZoom, pageInfo];
        scheduleRender();
    });

    let renderTimer = null;

    function scheduleRender() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(doRenderPreview, 80);
    }

    function doRenderPreview() {
        renderTimer = null;
        const canvas = previewCanvasEl;
        const range  = previewPageRange;
        if (!canvas || !range) return;

        const sheetStore    = spreadsheetSession.activeSheetStore;
        const renderContext = spreadsheetSession.renderContext;
        const session       = spreadsheetSession;
        if (!sheetStore || !renderContext) return;

        const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
        const { startRow, endRow, startCol, endCol } = range;

        const contentLeft   = colMetrics.offsetOf(startCol);
        const contentTop    = rowMetrics.offsetOf(startRow);
        const contentW_css  = Math.max(1, colMetrics.offsetOf(endCol + 1) - contentLeft);
        const contentH_css  = Math.max(1, rowMetrics.offsetOf(endRow + 1) - contentTop);

        // Canvas layout
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

        // White paper
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, displayW, displayH);

        // Light tint on margin zones
        ctx.fillStyle = 'rgba(241, 245, 249, 0.6)';
        ctx.fillRect(0, 0, displayW, mT);
        ctx.fillRect(0, displayH - mB, displayW, mB);
        ctx.fillRect(0, mT, mL, areaH);
        ctx.fillRect(displayW - mR, mT, mR, areaH);

        // Render cells to offscreen canvas
        const offscreen = document.createElement('canvas');
        const renderer  = new CanvasRenderer(offscreen);
        const rs = Math.max(0.25, areaW / contentW_css);
        renderer.resize(contentW_css, contentH_css, rs);

        try {
            const cells = buildPaneData({
                rowRange: { start: startRow, end: endRow,   count: endRow   - startRow + 1 },
                colRange: { start: startCol, end: endCol,   count: endCol   - startCol + 1 },
                rowMetrics, colMetrics,
                renderContext, sheetStore, session,
                selectionState:   null,
                formulaEditState: null,
                frozenRows: 0, frozenCols: 0, frozenHeight: 0, frozenWidth: 0,
                scrollLeft: contentLeft,
                scrollTop:  contentTop,
            });

            renderer.clear();
            renderer.paintPane(cells, {
                clipX: 0, clipY: 0,
                clipW: contentW_css, clipH: contentH_css,
                showGridLines,
            });

            ctx.drawImage(offscreen, mL, mT, areaW, areaH);
        } catch (_) {
            // If render fails, leave white area (empty page)
        } finally {
            renderer.destroy();
        }

        // Margin guide lines
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth   = 0.75;
        ctx.setLineDash([3, 3]);
        for (const [x1, y1, x2, y2] of [
            [0, mT, displayW, mT],
            [0, displayH - mB, displayW, displayH - mB],
            [mL, 0, mL, displayH],
            [displayW - mR, 0, displayW - mR, displayH],
        ]) {
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    onDestroy(() => clearTimeout(renderTimer));

    // ── Actions ────────────────────────────────────────────────────────────────
    function applyMarginPreset(preset) {
        const p = MARGIN_PRESETS[preset];
        marginTop = p.top; marginBottom = p.bottom;
        marginLeft = p.left; marginRight = p.right;
    }

    function fitToWidth() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const { colMetrics } = buildMetrics(sheetStore);
        const totalCols = sheetStore.colCount;
        const contentW_css = colMetrics.offsetOf(totalCols);
        const printW_css   = (pageInfo.printW / MM_PER_INCH) * CSS_PX_PER_INCH;
        scale = Math.max(0.1, Math.min(4.0, Math.round((printW_css / contentW_css) * 100) / 100));
    }

    function fitToPage() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
        const totalRows = sheetStore.rowCount;
        const totalCols = sheetStore.colCount;
        const contentW_css = colMetrics.offsetOf(totalCols);
        const contentH_css = rowMetrics.offsetOf(totalRows);
        const printW_css = (pageInfo.printW / MM_PER_INCH) * CSS_PX_PER_INCH;
        const printH_css = (pageInfo.printH / MM_PER_INCH) * CSS_PX_PER_INCH;
        const scaleW = printW_css / contentW_css;
        const scaleH = printH_css / contentH_css;
        scale = Math.max(0.1, Math.min(4.0, Math.round(Math.min(scaleW, scaleH) * 100) / 100));
    }

    function clampScale(v) {
        const n = parseFloat(v);
        return isNaN(n) ? scale : Math.max(0.1, Math.min(4.0, Math.round(n * 100) / 100));
    }

    function clampMargin(v) {
        const n = parseFloat(v);
        return isNaN(n) ? 0 : Math.max(0, Math.min(100, Math.round(n * 10) / 10));
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

    // Preview navigation helpers
    function prevPage() { if (previewPageIdx > 0) previewPageIdx--; }
    function nextPage() { if (previewPageRange && previewPageIdx < previewPageRange.total - 1) previewPageIdx++; }

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
                    <div class="paper-dims-hint">{pageInfo.pageW.toFixed(0)}×{pageInfo.pageH.toFixed(0)} mm · printable {pageInfo.printW.toFixed(0)}×{pageInfo.printH.toFixed(0)} mm</div>
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
                        {#each [['Top', 'marginTop'], ['Bottom', 'marginBottom'], ['Left', 'marginLeft'], ['Right', 'marginRight']] as [label, key]}
                            <label class="margin-label">
                                <span class="margin-name">{label}</span>
                                <input
                                    type="number" class="margin-input" min="0" max="100" step="1"
                                    value={key === 'marginTop' ? marginTop : key === 'marginBottom' ? marginBottom : key === 'marginLeft' ? marginLeft : marginRight}
                                    onchange={(e) => {
                                        const v = clampMargin(e.target.value);
                                        if (key === 'marginTop') marginTop = v;
                                        else if (key === 'marginBottom') marginBottom = v;
                                        else if (key === 'marginLeft') marginLeft = v;
                                        else marginRight = v;
                                    }}
                                />
                                <span class="margin-unit">mm</span>
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
                        oninput={() => scale = clampScale(scale)}
                    />
                    <div class="fit-btns">
                        <button class="preset-btn" onclick={fitToWidth}>Fit width</button>
                        <button class="preset-btn" onclick={fitToPage}>Fit page</button>
                        <button class="preset-btn" onclick={() => scale = 1.0}>Reset</button>
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
                    <span class="page-grid">{pageData.rows}×{pageData.cols} grid</span>
                </div>
            </div>

            <!-- Preview panel -->
            <div class="preview-panel">
                <!-- Preview toolbar -->
                <div class="preview-toolbar">
                    <div class="page-nav">
                        <button class="nav-btn" onclick={prevPage} disabled={previewPageIdx === 0}>‹</button>
                        <span class="page-counter">
                            {previewPageRange ? previewPageIdx + 1 : 0} / {pageData.pages}
                        </span>
                        <button class="nav-btn" onclick={nextPage} disabled={!previewPageRange || previewPageIdx >= previewPageRange.total - 1}>›</button>
                    </div>
                    <div class="zoom-controls">
                        <button class="zoom-btn" onclick={zoomOut} disabled={previewZoom <= ZOOM_STEPS[0]}>−</button>
                        <span class="zoom-label">{Math.round(previewZoom * 100)}%</span>
                        <button class="zoom-btn" onclick={zoomIn} disabled={previewZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}>+</button>
                    </div>
                </div>

                <!-- Scrollable preview area -->
                <div class="preview-scroll">
                    <div class="preview-centering">
                        {#if pageData.pages === 0}
                            <div class="empty-preview">No content to preview</div>
                        {:else}
                            <div class="paper-shadow">
                                <canvas bind:this={previewCanvasEl}></canvas>
                            </div>
                        {/if}
                    </div>
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

    .page-nav {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .nav-btn {
        width: 28px;
        height: 28px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 5px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        font-size: 1rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        padding: 0;
    }
    .nav-btn:hover:not(:disabled) { background: var(--color-fill, #f1f5f9); }
    .nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    .page-counter {
        font-size: 0.8125rem;
        color: var(--color-text, #1e293b);
        min-width: 50px;
        text-align: center;
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

    .preview-centering {
        display: flex;
        justify-content: center;
        min-height: 100%;
        align-items: flex-start;
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
