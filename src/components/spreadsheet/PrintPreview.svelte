<script>
    /**
     * PrintPreview - Non-virtualized renderer for printing
     *
     * Renders ALL cells in the print area without virtualization so that
     * the browser print dialog gets a complete static DOM to paginate.
     *
     * Usage: mount this component alongside the normal grid (hidden by default
     * via CSS, shown via `display:block` when printing).
     *
     * @media print in app.css hides the grid and shows this component.
     */

    import { PrintEngine } from "../../stores/spreadsheet/features/PrintEngine.js";

    let {
        session,
        renderContext,
        rowMetrics = null,
        colMetrics = null,
    } = $props();

    const printEngine = new PrintEngine();

    let sheetStore = $derived(
        renderContext?.sheetStore ?? session?.activeSheetStore,
    );

    let printSettings = $derived.by(() => {
        const ps = sheetStore?.getYMap()?.get("printSettings");
        return ps ? ps.toJSON() : {};
    });

    let totalRows = $derived(
        renderContext?.effectiveRowCount ?? sheetStore?.rowCount ?? 0,
    );
    let totalCols = $derived(
        renderContext?.effectiveColCount ?? sheetStore?.colCount ?? 0,
    );

    let areaStartRow = $derived(printSettings.areaStartRow ?? 0);
    let areaEndRow = $derived(
        printSettings.areaEndRow ?? Math.max(0, totalRows - 1),
    );
    let areaStartCol = $derived(printSettings.areaStartCol ?? 0);
    let areaEndCol = $derived(
        printSettings.areaEndCol ?? Math.max(0, totalCols - 1),
    );

    let pageBreaks = $derived.by(() => {
        if (!rowMetrics || !colMetrics) {
            return { rowBreaks: [areaStartRow], colBreaks: [areaStartCol] };
        }
        return printEngine.computePageBreaks(
            printSettings,
            rowMetrics,
            colMetrics,
            totalRows,
            totalCols,
        );
    });

    let printCSS = $derived(printEngine.generatePrintCSS(printSettings));

    let rowBreakSet = $derived(new Set(pageBreaks.rowBreaks));

    function getDisplayValue(row, col) {
        if (!sheetStore) return "";
        if (renderContext) return renderContext.getDisplayValue(row, col);
        return session?.getCellDisplayValue(row, col) ?? "";
    }

    function getCellStyle(row, col) {
        const cell = sheetStore?.getCell(row, col);
        if (!cell?.exists) return "";
        const s = [];
        if (cell.backgroundColor)
            s.push(`background-color:${cell.backgroundColor}`);
        if (cell.color) s.push(`color:${cell.color}`);
        if (cell.bold) s.push("font-weight:bold");
        if (cell.italic) s.push("font-style:italic");
        if (cell.fontSize) s.push(`font-size:${cell.fontSize}px`);
        if (cell.fontFamily) s.push(`font-family:${cell.fontFamily}`);
        if (cell.horizontalAlign) s.push(`text-align:${cell.horizontalAlign}`);
        return s.join(";");
    }

    function getColWidth(col) {
        if (colMetrics) return colMetrics.sizeOf(col);
        return 80;
    }

    function getRowHeight(row) {
        if (rowMetrics) return rowMetrics.sizeOf(row);
        return 24;
    }

    // Build rows array for rendering
    let printRows = $derived.by(() => {
        const rows = [];
        for (let r = areaStartRow; r <= areaEndRow; r++) {
            rows.push(r);
        }
        return rows;
    });

    let printCols = $derived.by(() => {
        const cols = [];
        for (let c = areaStartCol; c <= areaEndCol; c++) {
            cols.push(c);
        }
        return cols;
    });
</script>

<svelte:head>
    <!-- Inject print CSS dynamically -->
    <!-- Actual @media print CSS is in app.css for static inclusion -->
</svelte:head>

<!-- eslint-disable-next-line svelte/no-raw-special-elements -->
{@html `<style>${printCSS}</style>`}

<div class="print-preview">
    {#each printRows as row}
        {#if rowBreakSet.has(row) && row !== areaStartRow}
            <div class="print-page-break"></div>
        {/if}
        <div
            class="print-row"
            style="height:{getRowHeight(row)}px; display:flex;"
        >
            {#each printCols as col}
                <div
                    class="print-cell"
                    style="width:{getColWidth(col)}px; height:{getRowHeight(
                        row,
                    )}px; {getCellStyle(row, col)}"
                >
                    {getDisplayValue(row, col) ?? ""}
                </div>
            {/each}
        </div>
    {/each}
</div>

<style>
    .print-preview {
        display: none; /* shown via @media print in app.css */
        font-size: 11px;
        font-family: sans-serif;
        color: #000;
        background: #fff;
    }

    .print-row {
        align-items: stretch;
    }

    .print-cell {
        box-sizing: border-box;
        overflow: hidden;
        white-space: nowrap;
        padding: 1px 3px;
        vertical-align: middle;
        display: flex;
        align-items: center;
        border-right: 1px solid #ddd;
        border-bottom: 1px solid #ddd;
    }

    .print-page-break {
        page-break-before: always;
        break-before: page;
        height: 0;
        display: block;
    }

    @media print {
        .print-preview {
            display: block;
        }
    }
</style>
