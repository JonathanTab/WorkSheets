<script>
    /**
     * RepeaterViewport - Viewport-mode repeater panel
     *
     * Renders N repetitions of the template side-by-side (horizontal direction)
     * or stacked (vertical direction) inside a fixed cell-range anchor.
     * Each repetition re-evaluates all template formulas with $rep = i.
     *
     * The panel has its own scroll container — horizontal for vertical-direction
     * repeaters (scroll through repetitions) and vertical for horizontal ones.
     */

    import { CellTypeRegistry } from "../../../stores/spreadsheet/cellTypes/index.js";

    let {
        repeater,
        /** SpreadsheetSession for accessing cell values and formula engine */
        session,
        width = 300,
        height = 200,
    } = $props();

    const ROW_HEIGHT = 24;
    const COL_WIDTH = 80;

    let count = $derived(repeater?.count ?? 0);
    let direction = $derived(repeater?.direction ?? "vertical");
    let templateRows = $derived(repeater?.templateRows ?? 0);
    let templateCols = $derived(repeater?.templateCols ?? 0);
    let tStartRow = $derived(repeater?.templateStartRow ?? 0);
    let tStartCol = $derived(repeater?.templateStartCol ?? 0);

    // For each cell in the template, build an array of (row, col) offsets
    let templateCells = $derived.by(() => {
        const cells = [];
        for (let r = 0; r < templateRows; r++) {
            const row = [];
            for (let c = 0; c < templateCols; c++) {
                row.push({ r, c });
            }
            cells.push(row);
        }
        return cells;
    });

    function getCellStyle(tRow, tCol) {
        const cell = session?.getCell(tStartRow + tRow, tStartCol + tCol);
        if (!cell?.exists) return "";
        const s = [];
        if (cell.backgroundColor)
            s.push(`background-color:${cell.backgroundColor}`);
        if (cell.color) s.push(`color:${cell.color}`);
        if (cell.bold) s.push("font-weight:bold");
        if (cell.italic) s.push("font-style:italic");
        if (cell.horizontalAlign) s.push(`text-align:${cell.horizontalAlign}`);

        // Apply cell type default styles
        const ct = session?.sheetStore?.getCellTypeConfig?.(
            tStartRow + tRow,
            tStartCol + tCol,
        );
        if (ct) {
            const descriptor = CellTypeRegistry.get(ct.type);
            if (descriptor?.defaultStyle) {
                const defaultStyle = descriptor.defaultStyle(ct);
                if (defaultStyle.underline && !cell.underline)
                    s.push("text-decoration:underline");
                if (defaultStyle.color && !cell.color)
                    s.push(`color:${defaultStyle.color}`);
            }
        }

        return s.join(";");
    }

    function getDisplayValue(repIndex, tRow, tCol) {
        const rawValue = session?.getCell(
            tStartRow + tRow,
            tStartCol + tCol,
        )?.v;
        let evalValue;

        if (typeof rawValue === "string" && rawValue.startsWith("=")) {
            if (repIndex === 0) {
                evalValue =
                    session?.getCellDisplayValue(
                        tStartRow + tRow,
                        tStartCol + tCol,
                    ) ?? "";
            } else {
                evalValue =
                    session?.formulaEngine?.evaluateWithContext(
                        tStartRow + tRow,
                        tStartCol + tCol,
                        {
                            rep: repIndex,
                        },
                    ) ?? "";
            }
        } else {
            evalValue =
                session?.getCellDisplayValue(
                    tStartRow + tRow,
                    tStartCol + tCol,
                ) ?? "";
        }

        // Apply cell type formatting
        const ct = session?.sheetStore?.getCellTypeConfig?.(
            tStartRow + tRow,
            tStartCol + tCol,
        );
        if (ct && evalValue !== "") {
            return CellTypeRegistry.formatValue(ct, evalValue);
        }

        return evalValue;
    }
</script>

<div
    class="repeater-viewport"
    class:vertical={direction === "vertical"}
    class:horizontal={direction === "horizontal"}
    style="width:{width}px; height:{height}px;"
>
    <div class="rep-scroll">
        <div
            class="rep-inner"
            style={direction === "vertical"
                ? `width:${templateCols * COL_WIDTH}px;`
                : `height:${templateRows * ROW_HEIGHT}px;`}
        >
            {#each { length: count } as _, repIdx}
                <div
                    class="rep-block"
                    style={direction === "vertical"
                        ? `width:${templateCols * COL_WIDTH}px;`
                        : `height:${templateRows * ROW_HEIGHT}px;`}
                >
                    <!-- Rep index badge -->
                    <div class="rep-badge">#{repIdx}</div>

                    <!-- Template grid -->
                    {#each templateCells as templateRow, ri}
                        <div class="rep-row" style="height:{ROW_HEIGHT}px;">
                            {#each templateRow as cell, ci}
                                <div
                                    class="rep-cell"
                                    style="width:{COL_WIDTH}px; height:{ROW_HEIGHT}px; {getCellStyle(
                                        ri,
                                        ci,
                                    )}"
                                    title={String(
                                        getDisplayValue(repIdx, ri, ci),
                                    )}
                                >
                                    <span class="rep-cell-text">
                                        {getDisplayValue(repIdx, ri, ci)}
                                    </span>
                                </div>
                            {/each}
                        </div>
                    {/each}
                </div>
            {/each}
        </div>
    </div>
</div>

<style>
    .repeater-viewport {
        background: var(--cell-bg, #fff);
        border: 1px solid var(--table-header-border, #94a3b8);
        box-sizing: border-box;
        overflow: hidden;
    }

    .rep-scroll {
        width: 100%;
        height: 100%;
        overflow: auto;
    }

    .rep-inner {
        display: flex;
    }

    .repeater-viewport.vertical .rep-inner {
        flex-direction: column;
    }

    .repeater-viewport.horizontal .rep-inner {
        flex-direction: row;
    }

    .rep-block {
        flex-shrink: 0;
        border-bottom: 2px solid var(--table-header-border, #94a3b8);
        position: relative;
        padding-top: 14px; /* room for badge */
    }

    .rep-badge {
        position: absolute;
        top: 1px;
        left: 2px;
        font-size: 9px;
        color: var(--muted, #94a3b8);
        pointer-events: none;
    }

    .rep-row {
        display: flex;
    }

    .rep-cell {
        display: flex;
        align-items: center;
        padding: 0 3px;
        border-right: 1px solid var(--cell-border, #e2e8f0);
        border-bottom: 1px solid var(--cell-border, #e2e8f0);
        box-sizing: border-box;
        overflow: hidden;
        flex-shrink: 0;
        font-size: 11px;
        background: var(--cell-bg, #fff);
    }

    .rep-cell-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
</style>
