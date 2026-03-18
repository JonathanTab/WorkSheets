<script>
    import { spreadsheetSession } from "../../stores/spreadsheetStore.svelte.js";
    import { selectionState } from "../../stores/spreadsheet/index.js";
    import { VectorPrintEngine } from "../../stores/spreadsheet/rendering/VectorPrintEngine.js";
    import { PrintEngine } from "../../stores/spreadsheet/features/PrintEngine.js";
    import { AxisMetrics } from "../../stores/spreadsheet/virtualization/AxisMetrics.svelte.js";
    import { ROW_HEIGHT, COL_WIDTH } from "../../stores/spreadsheetStore.svelte.js";

    let { onclose } = $props();

    // ── Paper sizes ────────────────────────────────────────────────────────────
    const PAPER_SIZES = [
        { key: 'A4',     label: 'A4 (210×297 mm)' },
        { key: 'letter', label: 'Letter (8.5×11 in)' },
        { key: 'legal',  label: 'Legal (8.5×14 in)' },
        { key: 'A3',     label: 'A3 (297×420 mm)' },
        { key: 'A5',     label: 'A5 (148×210 mm)' },
    ];

    const PAPER_DIMS = {
        A4:     { w: 210,   h: 297   },
        letter: { w: 215.9, h: 279.4 },
        legal:  { w: 215.9, h: 355.6 },
        A3:     { w: 297,   h: 420   },
        A5:     { w: 148,   h: 210   },
    };

    // Margin presets (mm)
    const MARGIN_PRESETS = {
        normal:  { top: 19,   bottom: 19,   left: 18,   right: 18   },
        wide:    { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
        narrow:  { top: 19,   bottom: 19,   left: 6.4,  right: 6.4  },
    };

    // ── Capture selection at panel open time ───────────────────────────────────
    const selectionRange = selectionState.range ? {
        areaStartRow: selectionState.range.startRow,
        areaStartCol: selectionState.range.startCol,
        areaEndRow:   selectionState.range.endRow,
        areaEndCol:   selectionState.range.endCol,
    } : null;

    const hasSelection = selectionRange !== null;

    // ── Read current settings from SheetStore ──────────────────────────────────
    function readSettings() {
        return spreadsheetSession.activeSheetStore?.getPrintSettings() ?? {};
    }

    let saved = readSettings();

    // Local reactive state
    let paperSize     = $state(saved.paperSize     ?? 'A4');
    let orientation   = $state(saved.orientation   ?? 'portrait');
    let marginTop     = $state(saved.marginTop     ?? 19);
    let marginBottom  = $state(saved.marginBottom  ?? 19);
    let marginLeft    = $state(saved.marginLeft    ?? 18);
    let marginRight   = $state(saved.marginRight   ?? 18);
    let scale         = $state(saved.scale         ?? 1.0);
    let showGridLines = $state(saved.showGridLines ?? true);
    let printDPI      = $state(saved.printDPI      ?? 300);
    let printArea     = $state(saved.printArea     ?? 'usedArea'); // 'usedArea' | 'selection'
    let pageOrder     = $state(saved.pageOrder     ?? 'downThenOver'); // 'downThenOver' | 'overThenDown'

    // Header/Footer (left/center/right for each)
    let headerLeft    = $state(saved.headerLeft    ?? '');
    let headerCenter  = $state(saved.headerCenter  ?? '');
    let headerRight   = $state(saved.headerRight   ?? '');
    let footerLeft    = $state(saved.footerLeft    ?? '');
    let footerCenter  = $state(saved.footerCenter  ?? '{sheetName}');
    let footerRight   = $state(saved.footerRight   ?? 'Page {page} of {pages}');

    // ── Derived page info ──────────────────────────────────────────────────────
    const CSS_PX_PER_INCH = 96;
    const MM_PER_INCH = 25.4;

    let pageInfo = $derived.by(() => {
        const dims = PAPER_DIMS[paperSize] ?? PAPER_DIMS.A4;
        const pw = orientation === 'landscape' ? dims.h : dims.w;
        const ph = orientation === 'landscape' ? dims.w : dims.h;
        const printW = pw - marginLeft - marginRight;
        const printH = ph - marginTop  - marginBottom;
        return {
            pageW: pw,
            pageH: ph,
            printW: Math.max(1, printW),
            printH: Math.max(1, printH),
        };
    });

    // Compute the bounding box of cells with actual data.
    function computeUsedAreaFromStore(sheetStore) {
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

    // Rich page data: count + break positions + metrics (for preview).
    let pageData = $derived.by(() => {
        const sheetStore = spreadsheetSession.activeSheetStore;
        const fallback = { pages: 0, rows: 0, cols: 0, rowBreaks: [], colBreaks: [], rowMetrics: null, colMetrics: null, areaStartRow: 0, areaStartCol: 0, areaEndRow: 0, areaEndCol: 0 };
        if (!sheetStore) return fallback;

        const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
        const totalRows = sheetStore.rowCount;
        const totalCols = sheetStore.colCount;

        // Build effective print settings with correct area bounds
        const ps = { ...currentSettings() };
        if (ps.printArea === 'usedArea') {
            const used = computeUsedAreaFromStore(sheetStore);
            if (used) Object.assign(ps, { areaStartRow: used.startRow, areaStartCol: used.startCol, areaEndRow: used.endRow, areaEndCol: used.endCol });
        } else if (ps.printArea === 'selection' && selectionRange) {
            Object.assign(ps, selectionRange);
        }

        const engine = new PrintEngine();
        const { rowBreaks, colBreaks } = engine.computePageBreaks(ps, rowMetrics, colMetrics, totalRows, totalCols);

        return {
            pages: rowBreaks.length * colBreaks.length,
            rows:  rowBreaks.length,
            cols:  colBreaks.length,
            rowBreaks,
            colBreaks,
            rowMetrics,
            colMetrics,
            areaStartRow: ps.areaStartRow ?? 0,
            areaStartCol: ps.areaStartCol ?? 0,
            areaEndRow:   ps.areaEndRow   ?? totalRows - 1,
            areaEndCol:   ps.areaEndCol   ?? totalCols - 1,
        };
    });

    // Preview canvas dimensions (for the paper preview widget)
    let previewDims = $derived.by(() => {
        const MAX_W = 160, MAX_H = 200;
        const { pageW, pageH } = pageInfo;
        const ratio = pageW / pageH;
        let w = MAX_W, h = MAX_W / ratio;
        if (h > MAX_H) { h = MAX_H; w = MAX_H * ratio; }
        const scale_px = w / pageW;
        return {
            w: Math.round(w),
            h: Math.round(h),
            marginTopPx:    Math.round(marginTop    * scale_px),
            marginBottomPx: Math.round(marginBottom * scale_px),
            marginLeftPx:   Math.round(marginLeft   * scale_px),
            marginRightPx:  Math.round(marginRight  * scale_px),
        };
    });

    // Page break positions mapped into the paper preview widget.
    // Models the content as a mini-map: all pages tiled within the printable area box.
    let previewBreaks = $derived.by(() => {
        const { rowBreaks, colBreaks, rowMetrics, colMetrics, areaStartRow, areaStartCol, areaEndRow, areaEndCol } = pageData;
        if (!rowMetrics || !colMetrics) return { hLines: [], vLines: [] };

        const { marginTopPx, marginBottomPx, marginLeftPx, marginRightPx, w: pvW, h: pvH } = previewDims;
        const printAreaW = pvW - marginLeftPx - marginRightPx;
        const printAreaH = pvH - marginTopPx  - marginBottomPx;

        const startRowOff = rowMetrics.offsetOf(areaStartRow);
        const startColOff = colMetrics.offsetOf(areaStartCol);
        const totalContentH = rowMetrics.offsetOf(areaEndRow + 1) - startRowOff;
        const totalContentW = colMetrics.offsetOf(areaEndCol + 1) - startColOff;

        if (totalContentW <= 0 || totalContentH <= 0) return { hLines: [], vLines: [] };

        // Scale factor: map total content extent → preview print area
        const scaleX = printAreaW / totalContentW;
        const scaleY = printAreaH / totalContentH;

        const hLines = rowBreaks.slice(1).map(r =>
            marginTopPx + (rowMetrics.offsetOf(r) - startRowOff) * scaleY
        );
        const vLines = colBreaks.slice(1).map(c =>
            marginLeftPx + (colMetrics.offsetOf(c) - startColOff) * scaleX
        );

        return { hLines, vLines };
    });

    // ── Helpers ────────────────────────────────────────────────────────────────
    function currentSettings() {
        const s = {
            paperSize, orientation,
            marginTop, marginBottom, marginLeft, marginRight,
            scale, showGridLines, printDPI,
            printArea, pageOrder,
            headerLeft, headerCenter, headerRight,
            footerLeft, footerCenter, footerRight,
        };
        // Embed selection bounds when printing selection
        if (printArea === 'selection' && selectionRange) {
            Object.assign(s, selectionRange);
        }
        return s;
    }

    function buildMetrics(sheetStore) {
        const rowM = new AxisMetrics(sheetStore.defaultRowHeight ?? ROW_HEIGHT);
        rowM.setCount(sheetStore.rowCount);
        const rowMeta = sheetStore.getYMap()?.get('rowMeta');
        const heights = new Map();
        if (rowMeta) {
            rowMeta.forEach((meta, key) => {
                const h = meta.get('height');
                if (h !== undefined) heights.set(parseInt(key, 10), h);
            });
        }
        rowM.loadOverrides(heights);

        const colM = new AxisMetrics(sheetStore.defaultColWidth ?? COL_WIDTH);
        colM.setCount(sheetStore.colCount);
        const colMeta = sheetStore.getYMap()?.get('colMeta');
        const widths = new Map();
        if (colMeta) {
            colMeta.forEach((meta, key) => {
                const w = meta.get('width');
                if (w !== undefined) widths.set(parseInt(key, 10), w);
            });
        }
        colM.loadOverrides(widths);

        return { rowMetrics: rowM, colMetrics: colM };
    }

    // Auto-scale: fit all columns on one page width
    function fitToWidth() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        const { colMetrics } = buildMetrics(sheetStore);
        const totalCols = sheetStore.colCount;
        const contentW_css = colMetrics.offsetOf(totalCols); // total width in CSS px
        const printW_mm = pageInfo.printW;
        const printW_css = (printW_mm / MM_PER_INCH) * CSS_PX_PER_INCH;
        const autoScale = printW_css / contentW_css;
        scale = Math.max(0.1, Math.min(4.0, Math.round(autoScale * 100) / 100));
    }

    // ── Actions ────────────────────────────────────────────────────────────────
    function applyMarginPreset(preset) {
        const p = MARGIN_PRESETS[preset];
        marginTop    = p.top;
        marginBottom = p.bottom;
        marginLeft   = p.left;
        marginRight  = p.right;
    }

    function saveSettings() {
        const sheetStore = spreadsheetSession.activeSheetStore;
        if (!sheetStore) return;
        sheetStore.setPrintSettings(currentSettings());
    }

    let isExporting = $state(false);
    let exportError = $state(null);

    async function handleExportPDF() {
        if (isExporting) return;
        const sheetStore  = spreadsheetSession.activeSheetStore;
        const renderContext = spreadsheetSession.renderContext;
        if (!sheetStore || !renderContext) {
            exportError = 'No active sheet to export.';
            return;
        }

        saveSettings();

        isExporting = true;
        exportError = null;
        try {
            const { rowMetrics, colMetrics } = buildMetrics(sheetStore);
            const engine = new VectorPrintEngine();
            const docName = spreadsheetSession.docTitle || sheetStore.name || 'sheet';
            await engine.downloadPDF(
                {
                    printSettings: currentSettings(),
                    renderContext,
                    sheetStore,
                    session: spreadsheetSession,
                    rowMetrics,
                    colMetrics,
                    docName,
                },
                `${docName}.pdf`,
            );
        } catch (err) {
            console.error('PDF export failed:', err);
            exportError = 'Export failed — see console for details.';
        } finally {
            isExporting = false;
        }
    }

    function handleClose() {
        saveSettings();
        onclose?.();
    }

    // Clamp scale to reasonable range
    function clampScale(v) {
        const n = parseFloat(v);
        if (isNaN(n)) return scale;
        return Math.max(0.1, Math.min(4.0, Math.round(n * 100) / 100));
    }

    function clampMargin(v) {
        const n = parseFloat(v);
        if (isNaN(n)) return 0;
        return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
    }
</script>

<!-- Modal backdrop -->
<div class="backdrop" role="dialog" aria-modal="true" aria-label="Page Setup">
    <div class="panel">
        <!-- Header -->
        <div class="panel-header">
            <h2 class="panel-title">Page Setup</h2>
            <button class="close-btn" onclick={handleClose} title="Close">✕</button>
        </div>

        <div class="panel-body">
            <!-- Left column: settings -->
            <div class="settings-col">

                <!-- Paper & Orientation -->
                <section class="section">
                    <div class="section-label">Paper</div>
                    <select class="select" bind:value={paperSize}>
                        {#each PAPER_SIZES as ps}
                            <option value={ps.key}>{ps.label}</option>
                        {/each}
                    </select>
                    <div class="orientation-row">
                        <label class="radio-label">
                            <input type="radio" name="orientation" value="portrait" bind:group={orientation} />
                            <span class="orient-icon">⬜</span> Portrait
                        </label>
                        <label class="radio-label">
                            <input type="radio" name="orientation" value="landscape" bind:group={orientation} />
                            <span class="orient-icon orient-icon--land">⬜</span> Landscape
                        </label>
                    </div>
                </section>

                <!-- Margins -->
                <section class="section">
                    <div class="section-label-row">
                        <span class="section-label">Margins (mm)</span>
                        <div class="preset-btns">
                            <button class="preset-btn" onclick={() => applyMarginPreset('normal')}>Normal</button>
                            <button class="preset-btn" onclick={() => applyMarginPreset('wide')}>Wide</button>
                            <button class="preset-btn" onclick={() => applyMarginPreset('narrow')}>Narrow</button>
                        </div>
                    </div>
                    <div class="margins-grid">
                        <label class="margin-label">
                            Top
                            <input type="number" class="margin-input" min="0" max="100" step="1"
                                bind:value={marginTop}
                                onchange={() => marginTop = clampMargin(marginTop)} />
                        </label>
                        <label class="margin-label">
                            Bottom
                            <input type="number" class="margin-input" min="0" max="100" step="1"
                                bind:value={marginBottom}
                                onchange={() => marginBottom = clampMargin(marginBottom)} />
                        </label>
                        <label class="margin-label">
                            Left
                            <input type="number" class="margin-input" min="0" max="100" step="1"
                                bind:value={marginLeft}
                                onchange={() => marginLeft = clampMargin(marginLeft)} />
                        </label>
                        <label class="margin-label">
                            Right
                            <input type="number" class="margin-input" min="0" max="100" step="1"
                                bind:value={marginRight}
                                onchange={() => marginRight = clampMargin(marginRight)} />
                        </label>
                    </div>
                </section>

                <!-- Scale -->
                <section class="section">
                    <div class="section-label">Scale</div>
                    <div class="scale-row">
                        <input type="range" class="scale-slider" min="0.25" max="2" step="0.05"
                            bind:value={scale}
                            oninput={() => scale = clampScale(scale)} />
                        <input type="number" class="scale-input" min="0.1" max="4" step="0.05"
                            bind:value={scale}
                            onchange={() => scale = clampScale(scale)} />
                        <span class="scale-pct">{Math.round(scale * 100)}%</span>
                        <button class="preset-btn" onclick={fitToWidth} title="Auto-scale to fit all columns on one page width">Fit width</button>
                    </div>
                </section>

                <!-- Print Area & Page Order -->
                <section class="section">
                    <div class="section-label">Print Area</div>
                    <div class="radio-group">
                        <label class="radio-label">
                            <input type="radio" name="printArea" value="usedArea" bind:group={printArea} />
                            Sheet (used area)
                        </label>
                        <label class="radio-label" class:disabled={!hasSelection}>
                            <input type="radio" name="printArea" value="selection" bind:group={printArea} disabled={!hasSelection} />
                            Selection{hasSelection ? '' : ' (no selection)'}
                        </label>
                    </div>
                    <div class="section-label" style="margin-top:8px;">Page Order</div>
                    <div class="radio-group">
                        <label class="radio-label">
                            <input type="radio" name="pageOrder" value="downThenOver" bind:group={pageOrder} />
                            Down, then over
                        </label>
                        <label class="radio-label">
                            <input type="radio" name="pageOrder" value="overThenDown" bind:group={pageOrder} />
                            Over, then down
                        </label>
                    </div>
                </section>

                <!-- Options -->
                <section class="section">
                    <div class="section-label">Options</div>
                    <label class="checkbox-label">
                        <input type="checkbox" bind:checked={showGridLines} />
                        Show gridlines
                    </label>
                    <label class="checkbox-label" style="margin-top:6px;">
                        <span class="field-label">Print quality:</span>
                        <select class="select-sm" bind:value={printDPI}>
                            <option value={150}>150 DPI (fast)</option>
                            <option value={200}>200 DPI</option>
                            <option value={300}>300 DPI (recommended)</option>
                            <option value={400}>400 DPI (high quality)</option>
                        </select>
                    </label>
                </section>

                <!-- Header & Footer -->
                <section class="section">
                    <div class="section-label">Header</div>
                    <div class="hf-grid">
                        <input type="text" class="hf-input" placeholder="Left" bind:value={headerLeft} />
                        <input type="text" class="hf-input" placeholder="Center" bind:value={headerCenter} />
                        <input type="text" class="hf-input" placeholder="Right" bind:value={headerRight} />
                    </div>
                    <div class="section-label" style="margin-top:8px;">Footer</div>
                    <div class="hf-grid">
                        <input type="text" class="hf-input" placeholder="Left" bind:value={footerLeft} />
                        <input type="text" class="hf-input" placeholder="Center" bind:value={footerCenter} />
                        <input type="text" class="hf-input" placeholder="Right" bind:value={footerRight} />
                    </div>
                    <div class="hf-hint">
                        Variables: <code>{'{page}'}</code> <code>{'{pages}'}</code> <code>{'{sheetName}'}</code> <code>{'{docName}'}</code> <code>{'{date}'}</code> <code>{'{time}'}</code>
                    </div>
                </section>

                <!-- Page count estimate -->
                <section class="section info-section">
                    <div class="info-row">
                        <span class="info-icon">📄</span>
                        <span class="info-text">
                            {pageData.pages} page{pageData.pages !== 1 ? 's' : ''}
                            ({pageData.rows} row × {pageData.cols} col)
                        </span>
                    </div>
                    <div class="info-row">
                        <span class="info-text muted">
                            Printable area: {pageInfo.printW.toFixed(0)}×{pageInfo.printH.toFixed(0)} mm
                        </span>
                    </div>
                </section>
            </div>

            <!-- Right column: paper preview -->
            <div class="preview-col">
                <div class="preview-label">Preview</div>
                <div
                    class="paper-preview"
                    style="width:{previewDims.w}px; height:{previewDims.h}px;"
                >
                    <div
                        class="print-area"
                        style="
                            top:{previewDims.marginTopPx}px;
                            bottom:{previewDims.marginBottomPx}px;
                            left:{previewDims.marginLeftPx}px;
                            right:{previewDims.marginRightPx}px;
                        "
                    >
                        {#if showGridLines}
                            <div class="grid-hint"></div>
                        {/if}
                    </div>

                    <!-- Page break lines overlay -->
                    <svg
                        style="position:absolute;inset:0;pointer-events:none;overflow:visible;"
                        width={previewDims.w}
                        height={previewDims.h}
                    >
                        {#each previewBreaks.hLines as y}
                            <line
                                x1={previewDims.marginLeftPx} y1={y}
                                x2={previewDims.w - previewDims.marginRightPx} y2={y}
                                stroke="#3b82f6" stroke-width="0.75" stroke-dasharray="3 2"
                            />
                        {/each}
                        {#each previewBreaks.vLines as x}
                            <line
                                x1={x} y1={previewDims.marginTopPx}
                                x2={x} y2={previewDims.h - previewDims.marginBottomPx}
                                stroke="#3b82f6" stroke-width="0.75" stroke-dasharray="3 2"
                            />
                        {/each}
                    </svg>

                    <div class="margin-label-top">{marginTop}</div>
                    <div class="margin-label-bottom">{marginBottom}</div>
                    <div class="margin-label-left">{marginLeft}</div>
                    <div class="margin-label-right">{marginRight}</div>
                </div>
            </div>
        </div>

        <!-- Error -->
        {#if exportError}
            <div class="error-banner">{exportError}</div>
        {/if}

        <!-- Footer actions -->
        <div class="panel-footer">
            <button class="btn btn-secondary" onclick={handleClose}>Cancel</button>
            <button class="btn btn-secondary" onclick={saveSettings}>Save Settings</button>
            <button
                class="btn btn-primary"
                onclick={handleExportPDF}
                disabled={isExporting}
            >
                {#if isExporting}Exporting…{:else}Export PDF{/if}
            </button>
        </div>
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .panel {
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 10px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.22);
        width: 680px;
        max-width: 96vw;
        max-height: 92vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px 12px;
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
    }

    .panel-title {
        font-size: 1rem;
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
        padding: 2px 6px;
        border-radius: 4px;
        line-height: 1;
    }
    .close-btn:hover { background: var(--color-fill, #f1f5f9); }

    .panel-body {
        display: flex;
        gap: 24px;
        padding: 18px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
    }

    .settings-col {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-width: 0;
    }

    .preview-col {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
    }

    .preview-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text-secondary, #64748b);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .section {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .section-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text-secondary, #64748b);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .section-label-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .preset-btns {
        display: flex;
        gap: 4px;
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

    .select {
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

    .select-sm {
        height: 24px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        font-size: 0.75rem;
        padding: 0 4px;
        cursor: pointer;
        margin-left: 6px;
    }

    .orientation-row {
        display: flex;
        gap: 16px;
    }

    .radio-label {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 0.8125rem;
        cursor: pointer;
        color: var(--color-text, #1e293b);
    }

    .radio-label.disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .radio-group {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
    }

    .orient-icon {
        font-size: 1.1rem;
        line-height: 1;
    }
    .orient-icon--land {
        display: inline-block;
        transform: rotate(90deg);
    }

    .margins-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px 12px;
    }

    .margin-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 0.8125rem;
        color: var(--color-text, #1e293b);
        gap: 6px;
    }

    .margin-input {
        width: 60px;
        height: 24px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        padding: 0 5px;
        font-size: 0.8125rem;
        text-align: right;
        color: var(--color-text, #1e293b);
        background: var(--color-surface, #fff);
    }
    .margin-input:focus { outline: 2px solid var(--color-primary, #3b82f6); outline-offset: 1px; }

    .scale-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .scale-slider {
        flex: 1;
        accent-color: var(--color-primary, #3b82f6);
    }

    .scale-input {
        width: 55px;
        height: 24px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        padding: 0 5px;
        font-size: 0.8125rem;
        text-align: right;
        color: var(--color-text, #1e293b);
        background: var(--color-surface, #fff);
    }

    .scale-pct {
        font-size: 0.8125rem;
        color: var(--color-text-secondary, #64748b);
        min-width: 34px;
    }

    .checkbox-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.8125rem;
        cursor: pointer;
        color: var(--color-text, #1e293b);
        user-select: none;
    }

    .field-label {
        color: var(--color-text-secondary, #64748b);
    }

    /* Header/Footer */
    .hf-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 5px;
    }

    .hf-input {
        height: 24px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        padding: 0 6px;
        font-size: 0.75rem;
        color: var(--color-text, #1e293b);
        background: var(--color-surface, #fff);
        min-width: 0;
    }
    .hf-input:focus { outline: 2px solid var(--color-primary, #3b82f6); outline-offset: 1px; }

    .hf-hint {
        font-size: 0.7rem;
        color: var(--color-text-secondary, #64748b);
        margin-top: 2px;
        line-height: 1.5;
    }
    .hf-hint code {
        background: var(--color-fill, #f1f5f9);
        border-radius: 3px;
        padding: 0 3px;
        font-size: 0.68rem;
    }

    .info-section {
        background: var(--color-fill, #f8fafc);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 6px;
        padding: 8px 10px;
        gap: 4px;
    }

    .info-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .info-icon { font-size: 0.875rem; }

    .info-text {
        font-size: 0.8125rem;
        color: var(--color-text, #1e293b);
    }
    .info-text.muted { color: var(--color-text-secondary, #64748b); }

    /* Paper preview widget */
    .paper-preview {
        position: relative;
        background: #fff;
        border: 1px solid #cbd5e1;
        box-shadow: 2px 3px 10px rgba(0,0,0,0.12);
        flex-shrink: 0;
    }

    .print-area {
        position: absolute;
        border: 1px dashed #94a3b8;
        background: #f8fafc;
        overflow: hidden;
    }

    .grid-hint {
        position: absolute;
        inset: 0;
        background-image:
            repeating-linear-gradient(#e2e8f0 0, #e2e8f0 1px, transparent 1px, transparent 12px),
            repeating-linear-gradient(90deg, #e2e8f0 0, #e2e8f0 1px, transparent 1px, transparent 18px);
        opacity: 0.5;
    }

    .margin-label-top,
    .margin-label-bottom,
    .margin-label-left,
    .margin-label-right {
        position: absolute;
        font-size: 8px;
        color: #94a3b8;
        pointer-events: none;
    }
    .margin-label-top    { top: 2px; left: 50%; transform: translateX(-50%); }
    .margin-label-bottom { bottom: 2px; left: 50%; transform: translateX(-50%); }
    .margin-label-left   { left: 2px; top: 50%; transform: translateY(-50%) rotate(-90deg); transform-origin: center; }
    .margin-label-right  { right: 2px; top: 50%; transform: translateY(-50%) rotate(90deg); transform-origin: center; }

    /* Footer */
    .panel-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
    }

    .btn {
        height: 30px;
        padding: 0 14px;
        border-radius: 5px;
        font-size: 0.8125rem;
        font-weight: 500;
        border: 1px solid transparent;
        cursor: pointer;
        transition: all 0.08s ease;
    }

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
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .error-banner {
        margin: 0 18px 12px;
        padding: 8px 12px;
        background: #fef2f2;
        color: #b91c1c;
        border: 1px solid #fecaca;
        border-radius: 5px;
        font-size: 0.8125rem;
    }
</style>
