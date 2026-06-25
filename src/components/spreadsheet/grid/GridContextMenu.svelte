<script>
    import {
        spreadsheetSession,
        selectionState,
    } from "../../../stores/spreadsheetStore.svelte.js";
    import {
        clipboardManager,
    } from "../../../stores/spreadsheet/index.js";
    import { clearFormatting as clearFormattingCmd } from "../../../stores/spreadsheet/formatCommands.js";
    import {
        cut as cutIcon,
        copy as copyIcon,
        paste as pasteIcon,
        trash as trashIcon,
        arrowUp,
        arrowDown,
        arrowLeft,
        arrowRight,
        merge as mergeIcon,
    } from "../../../lib/icons/index.js";
    import ContextMenu from "../../ui/ContextMenu.svelte";
    import MobileCellActionBar from "./MobileCellActionBar.svelte";
    import { mobileState } from "../../../stores/mobileState.svelte.js";
    import { getConfig as getEntryForgeConfig } from "../../../stores/spreadsheet/plugins/entryForge/entryForgeConfig.js";
    import { openSplit, openEntryForgeConfig } from "../../../stores/spreadsheet/plugins/entryForge/entryForgeUiState.svelte.js";

    /**
     * Props:
     *   visible         — show/hide signal owned by Grid.svelte
     *   position        — {x,y} screen coords set by the trigger functions
     *   onClose         — close callback (sets visible=false in Grid.svelte)
     *   containerEl     — Grid's root DOM element (for MobileCellActionBar)
     *   selectionHandleRect — mobile handle geometry (for MobileCellActionBar)
     *   activeEditPanel — current repeater/panel state from Grid.svelte
     *   onSetActiveEditPanel — setter for activeEditPanel in Grid.svelte
     *   onBeginCellEdit — Grid.svelte's beginCellEdit(row, col, opts)
     *   onShowFloatingImageInsert — opens floating image dialog in Grid.svelte
     *   onShowCreateTableDialog   — opens table create dialog in Grid.svelte
     *   onShowCreateRepeaterDialog — opens repeater create dialog in Grid.svelte
     *   onShowTablesPanel         — Grid.svelte prop for tables panel navigation
     */
    let {
        visible = false,
        position = { x: 0, y: 0 },
        onClose,
        containerEl = null,
        selectionHandleRect = null,
        activeEditPanel = null,
        onSetActiveEditPanel,
        onBeginCellEdit,
        onShowFloatingImageInsert,
        onShowCreateTableDialog,
        onShowCreateRepeaterDialog,
        onShowTablesPanel,
    } = $props();

    // ─── Local derived state from global stores ──────────────────────────────
    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let anchor = $derived(selectionState.anchor);
    let selection = $derived(selectionState.range);
    let rowCount = $derived(sheetStore?.rowCount ?? 0);
    let colCount = $derived(sheetStore?.colCount ?? 0);

    let hasAnySelection = $derived(anchor !== null);

    let selectionType = $derived.by(() => {
        const mode = selectionState.selectionMode;
        if (mode === "rows") return "row";
        if (mode === "cols") return "column";
        if (mode === "all") return "all";
        if (!selection || !sheetStore) return "none";
        const isSingle =
            selection.startRow === selection.endRow &&
            selection.startCol === selection.endCol;
        if (isSingle) return "cell";
        return "range";
    });

    let effSelRowCount = $derived.by(() => {
        if (selectionState.selectionMode === "rows") {
            return selectionState.allRowRanges.reduce((n, r) => n + r.end - r.start + 1, 0) || 1;
        }
        if (selectionState.selectionMode === "all") return rowCount;
        const rows = new Set();
        for (const rng of selectionState.allRanges)
            for (let r = rng.startRow; r <= rng.endRow; r++) rows.add(r);
        return rows.size || (selection ? selection.endRow - selection.startRow + 1 : 1);
    });

    let effSelColCount = $derived.by(() => {
        if (selectionState.selectionMode === "cols") {
            return selectionState.allColRanges.reduce((n, c) => n + c.end - c.start + 1, 0) || 1;
        }
        if (selectionState.selectionMode === "all") return colCount;
        const cols = new Set();
        for (const rng of selectionState.allRanges)
            for (let c = rng.startCol; c <= rng.endCol; c++) cols.add(c);
        return cols.size || (selection ? selection.endCol - selection.startCol + 1 : 1);
    });

    let isHeaderSelection = $derived(
        selectionType === "row" || selectionType === "column",
    );

    let tableSelectionRowType = $derived.by(() => {
        if (!anchor) return null;
        const info = spreadsheetSession.renderContext?.tableManager?.getCellInfo(anchor.row, anchor.col);
        return (info?.rowType === 'entry' || info?.rowType === 'data') ? info.rowType : null;
    });

    let canMerge = $derived.by(() => {
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return false;
        return eff.startRow !== eff.endRow || eff.startCol !== eff.endCol;
    });

    let isMergePrimary = $derived.by(() => {
        if (!anchor || !sheetStore?.mergeEngine) return false;
        return sheetStore.mergeEngine.isMergePrimary(anchor.row, anchor.col);
    });

    let tableCellInfo = $derived.by(() => {
        if (!anchor || !spreadsheetSession.tableManager) return null;
        return spreadsheetSession.tableManager.getCellInfo(anchor.row, anchor.col);
    });

    let repeaterContext = $derived.by(() => {
        if (!anchor || !spreadsheetSession.repeaterEngine) return null;
        return spreadsheetSession.repeaterEngine.getCellRepeaterContext(anchor.row, anchor.col);
    });

    let tableSelectedDataRows = $derived.by(() => {
        if (!tableCellInfo || tableCellInfo.rowType !== "data" || !spreadsheetSession.tableManager) return [];
        const table = tableCellInfo.table;
        const mode = selectionState.selectionMode;
        const indices = new Set();

        const spans = [];
        if (mode === 'range') {
            for (const rng of selectionState.allRanges) spans.push(rng);
        } else if (mode === 'rows') {
            for (const r of selectionState.allRowRanges) spans.push({ startRow: r.start, endRow: r.end });
        } else {
            const eff = selectionState.effectiveRange(rowCount, colCount);
            if (eff) spans.push(eff);
        }

        for (const span of spans) {
            for (let r = span.startRow; r <= span.endRow; r++) {
                const info = spreadsheetSession.tableManager.getCellInfo(r, table.startCol);
                if (info?.table === table && info.rowType === "data") indices.add(info.dataIndex);
            }
        }
        return indices.size > 0 ? [...indices] : [tableCellInfo.dataIndex];
    });

    // Entry Forge config for the table under the cursor (keyed by source id).
    let entryForgeConfig = $derived.by(() => {
        if (!tableCellInfo?.table || !sheetStore) return null;
        const _pv = sheetStore.pluginsVersion;
        return getEntryForgeConfig(sheetStore, tableCellInfo.table.sourceTableId);
    });

    function tableSplitEntry() {
        if (!tableCellInfo?.table) return;
        openSplit(tableCellInfo.table.id, tableCellInfo.dataIndex);
        onClose?.();
    }

    function openEntryForgeSettings() {
        if (!tableCellInfo?.table) return;
        openEntryForgeConfig(tableCellInfo.table.sourceTableId);
        onClose?.();
    }

    // ─── Action functions ────────────────────────────────────────────────────
    function copySelection() {
        if (sheetStore) clipboardManager.copy(sheetStore, spreadsheetSession);
    }
    function cutSelection() {
        if (sheetStore && spreadsheetSession.ydoc)
            clipboardManager.cut(sheetStore, spreadsheetSession, spreadsheetSession.ydoc);
    }
    /** @param {'full'|'values'|'formulas'|'formatting'|'valuesFormat'|'formulasFormat'} [mode] */
    function pasteSelection(mode = "full") {
        if (sheetStore && spreadsheetSession.ydoc)
            clipboardManager.paste(sheetStore, spreadsheetSession, spreadsheetSession.ydoc, mode);
    }
    function clearContents() {
        if (!sheetStore) return;
        const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
        if (ranges.length === 0) return;
        spreadsheetSession.ydoc?.transact(() => {
            for (const eff of ranges) {
                for (let r = eff.startRow; r <= eff.endRow; r++) {
                    for (let c = eff.startCol; c <= eff.endCol; c++) {
                        sheetStore.clearCell(r, c);
                    }
                }
            }
        });
    }
    function clearFormatting() {
        clearFormattingCmd(spreadsheetSession, selectionState);
    }
    function insertRowAbove() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const count = eff.endRow - eff.startRow + 1;
        for (let i = 0; i < count; i++) sheetStore.insertRowAt(eff.startRow);
    }
    function insertRowBelow() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const count = eff.endRow - eff.startRow + 1;
        for (let i = 0; i < count; i++) sheetStore.insertRowAt(eff.endRow + 1 + i);
    }
    function insertColumnLeft() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const count = eff.endCol - eff.startCol + 1;
        for (let i = 0; i < count; i++) sheetStore.insertColumnAt(eff.startCol);
    }
    function insertColumnRight() {
        if (!sheetStore) return;
        const eff = selectionState.effectiveRange(rowCount, colCount);
        if (!eff) return;
        const count = eff.endCol - eff.startCol + 1;
        for (let i = 0; i < count; i++) sheetStore.insertColumnAt(eff.endCol + 1 + i);
    }
    function deleteSelectedRows() {
        if (!sheetStore) return;
        const mode = selectionState.selectionMode;
        const rows = new Set();
        if (mode === 'rows') {
            for (const r of selectionState.allRowRanges)
                for (let i = r.start; i <= r.end; i++) rows.add(i);
        } else {
            const eff = selectionState.effectiveRange(rowCount, colCount);
            if (!eff) return;
            for (let i = eff.startRow; i <= eff.endRow; i++) rows.add(i);
        }
        sheetStore.deleteRowsAt([...rows]);
    }
    function deleteSelectedColumns() {
        if (!sheetStore) return;
        const mode = selectionState.selectionMode;
        const cols = new Set();
        if (mode === 'cols') {
            for (const c of selectionState.allColRanges)
                for (let i = c.start; i <= c.end; i++) cols.add(i);
        } else {
            const eff = selectionState.effectiveRange(rowCount, colCount);
            if (!eff) return;
            for (let i = eff.startCol; i <= eff.endCol; i++) cols.add(i);
        }
        const sorted = [...cols].sort((a, b) => b - a);
        for (const col of sorted) sheetStore.deleteColumnAt(col);
    }

    // ─── Table / Repeater actions ────────────────────────────────────────────
    function tableDeleteRow() {
        if (tableCellInfo?.rowType === "data")
            tableCellInfo.table.deleteRows(tableSelectedDataRows);
    }
    function tableSortAsc() {
        if (tableCellInfo?.colDef)
            tableCellInfo.table.setSort(tableCellInfo.colDef.id, "asc");
    }
    function tableSortDesc() {
        if (tableCellInfo?.colDef)
            tableCellInfo.table.setSort(tableCellInfo.colDef.id, "desc");
    }
    function tableClearSort() {
        if (tableCellInfo) tableCellInfo.table.clearSort();
    }
    function tableDelete() {
        if (tableCellInfo && spreadsheetSession.tableManager)
            spreadsheetSession.tableManager.deleteTable(tableCellInfo.table.id);
    }
    function repeaterAddOne() {
        if (repeaterContext)
            repeaterContext.repeater.setCount(Math.min(100, repeaterContext.repeater.count + 1));
    }
    function repeaterRemoveOne() {
        if (repeaterContext)
            repeaterContext.repeater.setCount(Math.max(1, repeaterContext.repeater.count - 1));
    }
    function repeaterDelete() {
        if (repeaterContext && spreadsheetSession.repeaterEngine)
            spreadsheetSession.repeaterEngine.deleteRepeater(repeaterContext.repeater.id);
    }

    // ─── Context menu items ──────────────────────────────────────────────────
    let contextMenuItems = $derived([
        {
            label: "Cut",
            icon: cutIcon,
            isSvgIcon: true,
            shortcut: "Ctrl+X",
            action: cutSelection,
            disabled: !hasAnySelection,
        },
        {
            label: "Copy",
            icon: copyIcon,
            isSvgIcon: true,
            shortcut: "Ctrl+C",
            action: copySelection,
            disabled: !hasAnySelection,
        },
        {
            label: tableSelectionRowType === 'entry' ? "Paste Rows" : "Paste",
            icon: pasteIcon,
            isSvgIcon: true,
            shortcut: "Ctrl+V",
            action: () => pasteSelection("full"),
        },
        ...(!isHeaderSelection && !tableSelectionRowType
            ? [
                  {
                      label: "Paste Special...",
                      submenu: [
                          { label: "Values Only", action: () => pasteSelection("values") },
                          { label: "Formulas Only", action: () => pasteSelection("formulas") },
                          { label: "Formatting Only", action: () => pasteSelection("formatting") },
                          { divider: true },
                          { label: "Values & Formatting", action: () => pasteSelection("valuesFormat") },
                          { label: "Formulas & Formatting", action: () => pasteSelection("formulasFormat") },
                      ],
                  },
              ]
            : []),
        {
            label: "Clear Contents",
            shortcut: "Del",
            action: clearContents,
            disabled: !hasAnySelection,
        },
        {
            label: "Clear Formatting",
            shortcut: "Ctrl+\\",
            action: () => { clearFormatting(); onClose?.(); },
            disabled: !hasAnySelection,
        },
        { divider: true },
        ...(!isHeaderSelection
            ? [
                  {
                      label: "Insert Image in Cell",
                      icon: "🖼",
                      action: () => {
                          if (anchor) {
                              sheetStore?.setCellTypeConfig(anchor.row, anchor.col, { type: "image", fit: "contain" });
                              onBeginCellEdit?.(anchor.row, anchor.col, { surface: "grid" });
                          }
                      },
                      disabled: selectionType !== "cell",
                  },
                  {
                      label: "Attach File to Cell",
                      icon: "📎",
                      action: () => {
                          if (anchor) {
                              sheetStore?.setCellTypeConfig(anchor.row, anchor.col, { type: "file" });
                              onBeginCellEdit?.(anchor.row, anchor.col, { surface: "grid" });
                          }
                      },
                      disabled: selectionType !== "cell",
                  },
                  {
                      label: "Insert Floating Image…",
                      icon: "🖼",
                      action: () => {
                          if (anchor && sheetStore) onShowFloatingImageInsert?.();
                      },
                      disabled: !anchor,
                  },
                  ...(!tableCellInfo
                      ? [
                            { divider: true },
                            {
                                label: "Merge Cells",
                                icon: mergeIcon,
                                isSvgIcon: true,
                                action: () => {
                                    if (selection && sheetStore)
                                        sheetStore.mergeCells(
                                            selection.startRow,
                                            selection.startCol,
                                            selection.endRow,
                                            selection.endCol,
                                        );
                                },
                                disabled: !canMerge,
                            },
                            {
                                label: "Unmerge Cells",
                                icon: mergeIcon,
                                isSvgIcon: true,
                                action: () => {
                                    if (anchor && sheetStore)
                                        sheetStore.unmergeCells(anchor.row, anchor.col);
                                },
                                disabled: !isMergePrimary,
                            },
                            { divider: true },
                        ]
                      : []),
              ]
            : []),
        ...(!tableCellInfo
            ? selectionType === "row"
                ? [
                      {
                          label: `Insert ${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""} Above`,
                          icon: arrowUp,
                          isSvgIcon: true,
                          action: insertRowAbove,
                      },
                      {
                          label: `Insert ${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""} Below`,
                          icon: arrowDown,
                          isSvgIcon: true,
                          action: insertRowBelow,
                      },
                      { divider: true },
                      {
                          label: `Delete ${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""}`,
                          icon: trashIcon,
                          isSvgIcon: true,
                          action: deleteSelectedRows,
                      },
                  ]
                : selectionType === "column"
                  ? [
                        {
                            label: `Insert ${effSelColCount} Column${effSelColCount > 1 ? "s" : ""} Left`,
                            icon: arrowLeft,
                            isSvgIcon: true,
                            action: insertColumnLeft,
                        },
                        {
                            label: `Insert ${effSelColCount} Column${effSelColCount > 1 ? "s" : ""} Right`,
                            icon: arrowRight,
                            isSvgIcon: true,
                            action: insertColumnRight,
                        },
                        { divider: true },
                        {
                            label: `Delete ${effSelColCount} Column${effSelColCount > 1 ? "s" : ""}`,
                            icon: trashIcon,
                            isSvgIcon: true,
                            action: deleteSelectedColumns,
                        },
                    ]
                  : [
                        {
                            label: "Insert...",
                            submenu: [
                                { label: "Row Above", icon: arrowUp, isSvgIcon: true, action: insertRowAbove },
                                { label: "Row Below", icon: arrowDown, isSvgIcon: true, action: insertRowBelow },
                                { divider: true },
                                { label: "Column Left", icon: arrowLeft, isSvgIcon: true, action: insertColumnLeft },
                                { label: "Column Right", icon: arrowRight, isSvgIcon: true, action: insertColumnRight },
                            ],
                            disabled: !hasAnySelection,
                        },
                        {
                            label: "Delete...",
                            submenu: [
                                {
                                    label: selectionType === "all"
                                        ? `${effSelRowCount} Row${effSelRowCount > 1 ? "s" : ""}`
                                        : "Row",
                                    icon: trashIcon,
                                    isSvgIcon: true,
                                    action: deleteSelectedRows,
                                },
                                {
                                    label: selectionType === "all"
                                        ? `${effSelColCount} Column${effSelColCount > 1 ? "s" : ""}`
                                        : "Column",
                                    icon: trashIcon,
                                    isSvgIcon: true,
                                    action: deleteSelectedColumns,
                                },
                            ],
                            disabled: !hasAnySelection,
                        },
                    ]
            : []),
        ...(tableCellInfo
            ? [
                  { divider: true },
                  {
                      label: `⊞ ${tableCellInfo.table.name}`,
                      disabled: true,
                  },
                  ...(tableCellInfo.rowType === "data"
                      ? [
                            {
                                label: tableSelectedDataRows.length > 1
                                    ? `Delete ${tableSelectedDataRows.length} Rows`
                                    : "Delete This Row",
                                icon: trashIcon,
                                isSvgIcon: true,
                                action: tableDeleteRow,
                            },
                            ...(entryForgeConfig?.actions?.split?.enabled && tableSelectedDataRows.length === 1
                                ? [{
                                      label: "Split Entry…",
                                      icon: "⑂",
                                      action: tableSplitEntry,
                                  }]
                                : []),
                            { divider: true },
                        ]
                      : []),
                  ...(tableCellInfo.rowType === "entry"
                      ? [
                            {
                                label: "Commit Entry (Enter)",
                                action: () => tableCellInfo.table.commitEntry(),
                            },
                            {
                                label: "Clear Entry (Esc)",
                                action: () => tableCellInfo.table.clearEntry(),
                            },
                            { divider: true },
                        ]
                      : []),
                  ...(tableCellInfo.colDef
                      ? [
                            {
                                label: "Sort Ascending",
                                action: tableSortAsc,
                                icon: tableCellInfo.table.sortColId === tableCellInfo.colDef.id && tableCellInfo.table.sortDir === "asc" ? "▲" : "△",
                            },
                            {
                                label: "Sort Descending",
                                action: tableSortDesc,
                                icon: tableCellInfo.table.sortColId === tableCellInfo.colDef.id && tableCellInfo.table.sortDir === "desc" ? "▼" : "▽",
                            },
                            {
                                label: "Clear Sort",
                                action: tableClearSort,
                                disabled: !tableCellInfo.table.sortColId,
                            },
                            { divider: true },
                            {
                                label: "Configure Column…",
                                icon: "⚙",
                                action: () => {
                                    if (tableCellInfo?.colDef) {
                                        // Column config is shared between a source table and its
                                        // views, so always resolve to the source table id — opening
                                        // this from a view must not land on the wrong table.
                                        onShowTablesPanel?.(tableCellInfo.table.sourceTableId, tableCellInfo.colDef.id);
                                    }
                                },
                            },
                            { divider: true },
                        ]
                      : []),
                  {
                      label: "Add Row",
                      icon: "+",
                      action: () => tableCellInfo.table.insertRow({}),
                  },
                  {
                      label: "Configure Table ⊞",
                      action: () => {
                          if (tableCellInfo) {
                              // From a view, jump straight to that view's own settings
                              // (column order/filters) rather than the source table's
                              // generic column list.
                              const t = tableCellInfo.table;
                              onShowTablesPanel?.(t.sourceTableId, undefined, t.isView ? t.id : undefined);
                          }
                      },
                  },
                  {
                      label: "Entry Forge Settings…",
                      icon: "⚒",
                      action: openEntryForgeSettings,
                  },
                  {
                      label: "Delete Table",
                      icon: trashIcon,
                      isSvgIcon: true,
                      action: tableDelete,
                  },
              ]
            : []),
        ...(repeaterContext
            ? [
                  { divider: true },
                  {
                      label: `↻ ${repeaterContext.repeater.name}`,
                      disabled: true,
                  },
                  {
                      label: "Repeater Settings…",
                      icon: "⚙",
                      action: () => {
                          if (repeaterContext) {
                              onSetActiveEditPanel?.(
                                  activeEditPanel?.store === repeaterContext.repeater
                                      ? null
                                      : { type: "repeater", store: repeaterContext.repeater },
                              );
                          }
                      },
                  },
                  {
                      label: "+1 Repetition",
                      action: repeaterAddOne,
                      disabled: repeaterContext.repeater.count >= 100,
                  },
                  {
                      label: "−1 Repetition",
                      action: repeaterRemoveOne,
                      disabled: repeaterContext.repeater.count <= 1,
                  },
                  {
                      label: "Delete Repeater",
                      icon: trashIcon,
                      isSvgIcon: true,
                      action: repeaterDelete,
                  },
              ]
            : []),
        ...(!tableCellInfo && !repeaterContext && selection
            ? [
                  { divider: true },
                  {
                      label: "Create Table Here",
                      icon: "⊞",
                      action: () => { onShowCreateTableDialog?.(); },
                  },
                  {
                      label: "Create Repeater",
                      icon: "↻",
                      action: () => { onShowCreateRepeaterDialog?.(); },
                  },
              ]
            : []),
    ]);
</script>

{#if visible}
    {#if mobileState.isMobile}
        <MobileCellActionBar
            rect={selectionHandleRect}
            {containerEl}
            tableInfo={tableCellInfo}
            onClose={onClose}
            onCopy={() => { copySelection(); onClose?.(); }}
            onCut={() => { cutSelection(); onClose?.(); }}
            onPaste={() => {
                if (sheetStore && spreadsheetSession.ydoc)
                    clipboardManager.paste(sheetStore, spreadsheetSession, spreadsheetSession.ydoc, "full");
                onClose?.();
            }}
            onClear={() => {
                const ranges = selectionState.allEffectiveRanges(rowCount, colCount);
                if (sheetStore && ranges.length > 0) {
                    spreadsheetSession.ydoc?.transact(() => {
                        for (const eff of ranges)
                            for (let r = eff.startRow; r <= eff.endRow; r++)
                                for (let c = eff.startCol; c <= eff.endCol; c++)
                                    sheetStore.clearCell(r, c);
                    });
                }
                onClose?.();
            }}
            onDeleteRow={() => {
                tableDeleteRow();
                onClose?.();
            }}
        />
    {:else}
        <ContextMenu
            x={position.x}
            y={position.y}
            items={contextMenuItems}
            onClose={onClose}
        />
    {/if}
{/if}
