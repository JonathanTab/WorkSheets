# Table System — Architecture Summary

Written from code, covering current state after the source/view split and the DocumentTablesPanel rework.

---

## 1. Conceptual Model

The table system has two distinct levels:

| Concept | Role | Yjs location |
|---------|------|--------------|
| **Source table** | Data + schema owner. Holds `rows`, `columnDefs`, `columnOrder`. Never appears on the grid directly. | `sheet.tables[id]` with `isSourceOnly: true` |
| **View** | A positioned rendering of a source table on a sheet. Has its own column subset, definition filters, and grid position. | `sheet.tables[viewId]` with `sourceTableId` |
| **Legacy table** | Pre-split table that is both source and view in one Y.Map entry. Fully backward compatible. | `sheet.tables[id]` with no `isSourceOnly` and no `sourceTableId` |

**Creating a table** via `TableManager.createTable()` produces two Yjs entries in one transaction: a source table and a default view (`visibleColumns: []` = show all). The user then places the view on the grid using the placement overlay.

**Column visibility rule:**
- `visibleColumns: []` (empty) → view shows all source columns; new columns auto-appear.
- `visibleColumns: [colId, ...]` (explicit) → view shows only the listed columns in that order; new source columns do **not** auto-appear.

---

## 2. Yjs Data Model

### Source table Y.Map

```
tableYMap {
  id:              string
  name:            string           (human-readable, user-editable)
  isSourceOnly:    true             (marker: data-only, not grid-placed)
  sortColId:       string | null
  sortDir:         "asc" | "desc"
  insertSortColId: string | null
  insertSortDir:   "asc" | "desc"

  columnDefs:      Y.Map<colId, Y.Map>   (keyed by column ID)
  columnOrder:     Y.Array<colId>        (display order)
  rows:            Y.Array<Y.Map>        (data rows, each colId → value)
  filters:         Y.Map                 (reserved; not currently used server-side)
}
```

Each **column definition** Y.Map:
```
{ id, name, type, typeConfig (JSON string), required,
  isNonEntry, defaultFormula,
  hAlign, textColor, bgColor, width, bold, italic, underline, fontSize,
  fontFamily, conditionalFormats (JSON string) }
```

**`defaultFormula`** (optional): A formula string evaluated when a row is inserted. The result is stored as a plain value in the row. The user can edit the cell later to override the stored value — the formula is *not* re-evaluated. Supports the full table formula DSL including `PREV`, `NEXT`, `ROWVAL`, `WINDOW` row-reference helpers and all aggregates.

**`isNonEntry`** (optional, default false): When true the cell is read-only in the grid. Independent of `defaultFormula`. When both are set, the column behaves as a pure computed column — formula values are always derived at read time and never stored.

**Migration**: Old `formula` field (the previous computed-column mechanism which tied `isNonEntry=true` + `formula` together) is automatically renamed to `defaultFormula` by `#migrateColumnsIfNeeded` on first load.

### View Y.Map

```
viewYMap {
  id:               string
  name:             string          (view's own display name)
  mode:             "inline"
  startRow:         number          (grid row of the header)
  startCol:         number          (leftmost grid column)
  sourceTableId:    string          (ID of the source table Y.Map)
  sourceSheetId:    string          (sheet that contains the source table)
  visibleColumns:   Y.Array<colId>  ([] = show all, non-empty = explicit subset)
  persistedFilters: Y.Map<colId, JSON string>  (definition filters, always applied)
}
```

### Legacy table Y.Map (backward compat)

Same shape as source tables but **without** `isSourceOnly`. The table has both schema/data AND position fields (`startRow`, `startCol`) and is both the data source and the grid display. `TableStore.isView === false`, `TableStore.isSourceOnly === false`.

---

## 3. TableStore (`features/TableStore.svelte.js`)

One `TableStore` instance per table or view entry. Owned by `DocumentTableRegistry`.

### Key reactive state (`$state`)

| Field | Description |
|-------|-------------|
| `rows` | Plain JS array synced from source `rows` Y.Array |
| `columns` | Derived column defs (respects `visibleColumns` for views) |
| `sortedFilteredRows` | `rows` reversed (newest-first) → view definition filters → ad-hoc filters → sort |
| `viewDefinitionFilters` | Transparent view filters loaded from `persistedFilters` Y.Map |
| `filters` | Ad-hoc session filters (not persisted, cleared on reload) |
| `sortColId`, `sortDir` | Inherited from source for views; own for source/legacy tables |

### Filter architecture (two layers, independent)

```
rows (reversed)
  ↓ viewDefinitionFilters   (transparent, persisted in Yjs, set via setViewFilter)
  ↓ filters                 (ad-hoc session-only, set via setFilter, cleared on reload)
  ↓ sort
= sortedFilteredRows
```

**View definition filters** — `setViewFilter(colId, op, value)` writes to `persistedFilters` Y.Map. Loaded on init via `#loadPersistedFilters()`. Observed live (undo/redo + multi-tab sync). Managed only from `DocumentTablesPanel`. Not shown in the ad-hoc filter popover.

**Ad-hoc filters** — `setFilter(colId, op, value)` writes to `this.filters` $state only. Not persisted. Managed via the filter popover / `TableEditPanel`.

### View mode (`#sourceYMap !== null`)

When `TableStore` is constructed with a `sourceTableYMap`:
- `#syncColumns()` reads from source's `columnDefs`/`columnOrder`, filtered by `visibleColumns`.
- `#syncRows()` reads from source's `rows` Y.Array.
- `#observeYjs()` attaches observers to the **source's** rows and columns (not its own).
- Mutation methods (`insertRow`, `updateCell`, `deleteRow`, `pasteRows`) write to the **source's** `rows` Y.Array.
- `setVisibleColumns(colIds)` modifies the view's own `visibleColumns` Y.Array.

### Formula evaluation

`#rebuildView()` creates a new `TableFormulaEvaluator(sortedRows, columns, cumReverse, tableResolver)` on every rebuild. The evaluator is stateless across rebuilds (fresh caches each time). `getValue(i, colId)` delegates to the evaluator for `isNonEntry` columns.

`setTableResolver(fn)` stores a callback `(name) => TableStore | null` that the evaluator uses to resolve cross-table `TABLE_*` functions. Called by `DocumentTableRegistry` immediately after construction. Triggers a rebuild if an evaluator already exists.

### Lifecycle

```
constructor → #migrateColumnsIfNeeded → #syncFromYjs → #observeYjs
                                           ↓
                            Yjs observer fires on change
                                           ↓
                         #syncRows / #syncColumns → #rebuildView
```

`destroy()` unregisters all Yjs observers. Called by `DocumentTableRegistry` when the table is deleted or the document is unloaded.

---

## 4. TableFormulaEvaluator (`features/tableFormulaEval.js`)

Pure JS, no Svelte runes. Importable in Node.js (used by both browser and API server).

**Input:** snapshot of sorted/filtered rows, column defs, `cumReverse` flag, optional `tableResolver`.

**Constructor:** `TableFormulaEvaluator(rows, columns, cumReverse, tableResolver = null)`

On construction the evaluator:
1. Builds a dependency graph from each column's `defaultFormula` (or `formula` for `isNonEntry` columns) using `{colRef}` extraction.
2. Topologically sorts columns using Kahn's algorithm. Cyclic columns are detected and produce `#CYCLE`.
3. Walks all rows in order, evaluating each column in topo order and caching results in a 2-D `computed[rowIndex][colId]` grid. `PREV`/`NEXT`/`ROWVAL` read from this cache, so cross-row references always see freshly-computed values rather than raw stored data.

**Formula DSL:**

| Token / function | Meaning |
|---|---|
| `{colId}` / `{column name}` | Current row computed value |
| `ROW` / `ROW1` | 0-based / 1-based row index |
| `COUNT` | Total row count |
| `PREV(col)` | Computed value of col in previous row (0 if none) |
| `PREV(col, default)` | Same with explicit fallback |
| `NEXT(col)` | Computed value of col in next row (null if none) |
| `NEXT(col, default)` | Same with explicit fallback |
| `ROWVAL(col, n)` | Computed value of col at absolute row index n |
| `WINDOW(col, before)` | Array of col values `[ROW-before…ROW]` — use with `AVERAGE()`, `SUM()` etc. |
| `WINDOW(col, before, after)` | Array of col values `[ROW-before…ROW+after]` |
| `SUM(col)`, `AVG(col)`, `MIN(col)`, `MAX(col)` | Whole-column aggregates |
| `SUMIF(sum, filter, op, val)` | Conditional aggregate |
| `SUMIFS(sum, col1,op1,val1,...)` | Multi-condition aggregate |
| `COUNTIF`, `AVGIF`, `MINIF`, `MAXIF` | Conditional variants |
| `RUNNINGIF(sum, filter, op, val)` | Running conditional sum up to current row |
| `RUNNINGIFS(...)` | Running multi-condition sum |

**Examples:**
- `{amount} + PREV(balance, 0)` — cumulative running balance (replaces old `CUMSUM`)
- `AVERAGE(WINDOW(amount, 2))` — 3-row sliding average
- `{price} * {qty}` — row total

**`applyDefaultFormulas(entryData)`** — called by `TableStore.insertRow`. Returns a `Map<colId, value>` of formula results for a hypothetical new row, evaluated in topo order using `entryData` as the row context. The caller merges these values into the Yjs row, storing each formula result as a plain value.

**`getValue(rowIndex, colId)`** — for `isNonEntry` columns always returns the computed cache value; for `defaultFormula` (non-`isNonEntry`) columns returns the stored value if present (user override), else the computed cache value; for regular columns returns the stored value.

**Cross-table functions (available when `tableResolver` is set):**

All `TABLE_*` functions are built as `customFunctions` and passed to the sheet formula engine, so they compose with standard functions. A leading `=` on formula strings is stripped automatically.

`getCumulativeSum(colId, upToIndex)` — still available for use by `TABLE_CUMSUM` in cross-table contexts; sums computed values via `getValue`.

---

## 5. DocumentTableRegistry (`features/DocumentTableRegistry.svelte.js`)

**One instance per open document.** Created in `SpreadsheetSession` before `TableManager`. Lives for the document's lifetime, surviving sheet switches.

### Responsibilities

- Maintains one `TableStore` per table/view across **all** sheets.
- Provides O(1) lookup by ID (`getById`) and case-insensitive name (`getByName`).
- Tracks which sheet each table/view lives on (`getSheetId`).
- Tracks view membership: `getViewsForTable(sourceId)` → `[{viewId, sheetId, store, isLegacy}]`.
- `getSourceTables()` → all source tables (new-style `isSourceOnly` + legacy combined).
- Fires `onTableChange({ sourceTableId, events, rowArr })` when any table's row data changes. `SpreadsheetSession` parses the Y.YEvents for surgical formula recalc (see §7).
- Calls `store.setTableResolver(name => this.getByName(name))` on each new store so computed column formulas can reference other tables via `TABLE_*` functions.

### Ownership

The registry **owns** all `TableStore` instances. `TableManager` **borrows** them (does not destroy on sheet switch). When a Yjs deletion fires, the registry calls `store.destroy()`.

### Legacy tables

A legacy table (no `isSourceOnly`, no `sourceTableId`) self-registers in `#viewsOf` as its own view (`viewId === tableId`). `getViewsForTable()` returns it with `isLegacy: true`. This surfaces it in `DocumentTablesPanel` as "1 view (legacy)" with limited editing options.

---

## 6. TableManager (`features/TableManager.svelte.js`)

**One instance per active sheet.** Recreated on sheet switch. Borrows stores from the registry.

### Responsibilities

- Builds and maintains `#rowIndex: Map<row, [{table, rowType, dataIndex}]>` for O(1) grid-cell → table lookup.
- Answers `getCellInfo(row, col)`, `getCellTableType(row, col)`, `getCellDisplayValue(row, col)`.
- Skips `isSourceOnly` tables in all row-index operations.
- Registers `TABLE_*` formula functions into the sheet's `FormulaEngine`.
- Provides `createTable(opts)` and `createTableView(opts)`.

### Row index layout (inline tables/views only)

```
table.startRow       → header row
table.startRow + 1   → entry row (new-row input)
table.startRow + 2 … → data rows (sortedFilteredRows[0], [1], ...)
```

Plus `BUFFER_ROWS = 10` shadow rows below the last data row.

### TABLE_* formula functions registered

All functions use `table.getValue(i, colId)` (not raw `sortedFilteredRows[i][colId]`) so computed/formula columns return correct values.

| Function | Description |
|---|---|
| `TABLE_GET(name, rowIdx, col)` | Single value |
| `TABLE_COL(name, col)` | Full column array |
| `TABLE_COUNT(name)` | Row count |
| `TABLE_SUM/AVG/MIN/MAX(name, col)` | Aggregates |
| `TABLE_CUMSUM(name, col, upTo)` | Cumulative sum |
| `TABLE_SUMIF/AVGIF/MINIF/MAXIF(name, sum, filter, op, val)` | Conditional aggregates |
| `TABLE_SUMIFS/COUNTIFS/AVGIFS(name, ...)` | Multi-condition variants |
| `TABLE_FILTERCOL(name, col, filterCol, op, val)` | Filtered column values |
| `TABLE_FILTERCOLIFS(name, col, ...)` | Multi-condition filtered column |
| `TABLE_LOOKUP(name, lookupCol, val, returnCol)` | First matching row value |
| `TABLE_FILTER(name, col, op, val)` | Legacy: row count matching condition |

Lookup order: active-sheet `TableManager.getTableByName(name)` first, then `session.getCrossSheetTable(name)` (returns live registry store) for cross-sheet tables.

### Cross-sheet formula reactivity

`DocumentTableRegistry.onTableChange` fires with `{ sourceTableId, events, rowArr }`. `SpreadsheetSession` parses the Y.YEvents to surgically dirty:

1. **Name-based deps** — formulas calling `TABLE_*` against the changed table. At parse time, the formula engine walks the AST (`extractTableDeps`) and indexes the formula under the table name (or `'*'` if the first arg is dynamic). On change, `engine.markTableDependentsDirty(name)` dirties only those formulas.
2. **Grid-coordinate deps** — formulas like `=A5` that point at a cell rendered as table data. The events give the exact `(rowYMap, colId)` that changed; each inline view of the source maps that to grid `(row, col)` via `displayIndexOf` / `gridRowForDisplayIndex` / `gridColForColumnId`. Structural changes (rows added/deleted/reordered) dirty the union of old and new data extents.

Both sets feed a single `engine.notifyCellsChanged()` batch → one `recalculateDirty()` pass.

---

## 7. SpreadsheetSession integration

### Registry lifecycle

```js
// On document load:
this.tableRegistry = new DocumentTableRegistry(root, ydoc);
this.tableRegistry.onTableChange = ({ sourceTableId, events, rowArr }) => {
    // 1. Dirty TABLE_*-by-name dependents
    // 2. Classify Y.YEvents → cell/structural changes, map to grid cells per view
    // 3. Single batched notifyCellsChanged()
};

// On each sheet switch:
this.tableManager = new TableManager(sheet, ydoc, this.tableRegistry);
```

Registry persists across sheet switches; `TableManager` is recreated.

### getCrossSheetTable(name)

Returns the live `TableStore` directly from the registry. No more create/destroy per call. Formula columns are evaluated by the live store's `TableFormulaEvaluator`.

### createTableViewOnSheet(opts)

Creates a view entry in the **target sheet's** Yjs tables map. Called by `DocumentTablesPanel` after the user confirms placement via `ViewPlacementOverlay`. Parameters: `{sourceSheetId, sourceTableId, targetSheetId, name, startRow, startCol, visibleColumns}`.

### getAllTableDescriptors()

Reads source table metadata (name, columns) directly from Yjs without instantiating stores. Skips view entries (`sourceTableId` present). Used by `CellTypeConfigurator` to list available tables for dropdown configuration.

---

## 8. SheetRenderContext (`features/SheetRenderContext.svelte.js`)

The render bridge between data stores and the canvas grid. `TableManager` is wired in as `this.tableManager`.

**`getCellType(row, col)`:** checks `tableManager.getCellTableType` first, then merge engine, then regular.

**`getCellDisplayValue(row, col)`:**
- `TABLE_HEADER` → `colDef.name`
- `TABLE_ENTRY` → `table.entryBuffer[colDef.id]`
- `TABLE_DATA` → `tableManager.getCellDisplayValue(row, col)` → `table.getValue(dataIndex, colDef.id)` (evaluates formula columns)

**`getCellTypeConfig(row, col)`:** for table data/entry cells, returns column `typeConfig` (parsed from JSON). Used by Grid to decide which cell editor to open.

**`effectiveRowCount`:** extended by `tableManager.maxInlineTableRow` so the grid scrolls far enough to show all table rows.

---

## 9. Grid integration (`Grid.svelte`)

### Cell interaction (table cells)

On `pointerdown` the Grid calls `renderContext.getCellInfo(row, col)`:

- **`TABLE_HEADER`:** click → opens `TableEditPanel` (view settings popup). Double-click → inline column rename via `FormulaBar`.
- **`TABLE_ENTRY`:** text input → `table.setEntryValue(colId, parsed)`. Enter → `table.commitEntry()` → `table.insertRow(entryBuffer)`.
- **`TABLE_DATA`:** text input → `table.updateCell(dataIndex, colId, parsed)`. Cell editor type determined by `getCellTypeConfig`.

### Dropdown cells

`source: 'table'` dropdowns: `resolveTableColumnOptions(tableName, columnId)` calls `renderContext.tableManager.getTableByName` (same-sheet, reactive store) or `spreadsheetSession.getTableColumnValues` (cross-sheet, registry store + dedup). Returns unique non-empty values from the column.

### Shadow cells

`TableManager.isTableShadowCell(row, col)` blocks editing of the buffer rows below a table's data. Skips `isSourceOnly` tables.

### View placement overlay

`ViewPlacementOverlay` is rendered inside `grid-root` at z-index 20 when `viewPlacementStore.active === true`. It overlays the full grid including headers, converts mouse position to `(row, col)` using `virtualizer.rowMetrics.indexAtOffset` and `colMetrics.indexAtOffset`, and calls `viewPlacementStore.place(row, col)` on click.

---

## 10. View Placement UI (`ViewPlacementStore` + `ViewPlacementOverlay`)

### viewPlacementStore (`stores/spreadsheet/viewPlacementStore.svelte.js`)

Singleton reactive state. API:

```js
viewPlacementStore.activate(viewName, onPlace, onCancel?)
// → Grid renders overlay
// → user clicks → onPlace(row, col) called → store resets
// → ESC / cancel → onCancel() called → store resets
```

### ViewPlacementOverlay (`features/ViewPlacementOverlay.svelte`)

Visual elements:
- **Ghost rectangle** (5 cols × 4 rows, blue border + header stripe): follows cursor, shows table footprint.
- **Cell label**: dark monospace badge showing cell reference (`B3`) adjacent to ghost.
- **Banner pill** (centered, dark): "Placing **[name]** — click the grid to set position" with:
  - Live-updating cell ref input (type `B3`, Enter to confirm).
  - **Place here** button (confirms current cell).
  - **ESC** button (cancels).
- Cursor: `crosshair` over entire grid area.

Coordinate math:
```
contentX = mouseX_in_overlay - HEADER_WIDTH  + virtualizer.scrollLeft
contentY = mouseY_in_overlay - HEADER_HEIGHT + virtualizer.scrollTop
col = colMetrics.indexAtOffset(contentX)
row = rowMetrics.indexAtOffset(contentY)
```

---

## 11. DocumentTablesPanel (`features/DocumentTablesPanel.svelte`)

**The single central UI for all table management.** Opens via the **Tables** button in the toolbar (passes through `SpreadsheetWorkspace` → `Toolbar` → `DocumentTablesPanel`).

### Layout

Two-pane (560px total):
- **Left (180px):** source table list, each showing name + row/view count. Click to select.
- **Right (380px):** detail for selected table.
  - **Header:** editable name (double-click), stats, export CSV, delete table.
  - **Columns tab:** draggable list, type badge (click to expand `TableColumnPanel` inline), formula badge, delete; "+ Add column".
  - **Views tab:** each view shows name (double-click to rename), sheet badge, column count, filter chip count, ⊹ move, → navigate, 🗑 delete.
    - **Expanded view:** visible column checkboxes, definition filter list (add/remove), position (`Move on grid…` → placement mode).

### Create view flow

1. User fills name, target sheet, columns → clicks **Create view**.
2. Panel switches active sheet to target.
3. `viewPlacementStore.activate(name, (row, col) => createTableViewOnSheet({...}))` is called.
4. User clicks on grid → view created at that position.

### Legacy tables

Shown with a grey "legacy" chip. No column visibility controls (they always show all). Move button and definition filters not available. Deleting the table (not the "view") removes both source and display.

---

## 12. TableEditPanel (`features/TableEditPanel.svelte`)

**Lightweight quick-access popup** shown when clicking a table/view header in the grid.

Contains:
- Name (click to rename) + "view" / source badge.
- "Of [Source Name]" label for views.
- Row count (filtered vs total).
- Yellow notice if view definition filters are active (points to Tables panel).
- Blue section for active ad-hoc session filters (clear individual / clear all).
- **Position** shown as A1 cell ref + **Move on grid…** button → `viewPlacementStore.activate`.
- **Open Tables panel →** button (blue).
- Footer: Delete view / Delete table.

---

## 13. API Server (`spreadsheet-api/server.js`)

REST wrapper over `SpreadsheetClient` (pure Yjs, no Svelte).

### Key endpoints for tables

| Endpoint | Notes |
|---|---|
| `GET /file/:fileId/sheet/:sheetId/tables` | Lists table IDs, names, modes |
| `GET …/table/:tableId/schema` | Returns columns with resolved dropdown `options` (evaluates formula columns via `resolveTableColumnOptions`) |
| `GET …/table/:tableId/rows[?formulas=1]` | By default uses `getTableRowsWithFormulas` (applies sort + evaluates formula columns via `TableFormulaEvaluator`). Pass `?formulas=0` for raw Yjs rows |
| `POST …/table/:tableId/rows` | Inserts a row (skips formula columns, resolves column names to IDs) |

### `getTableRowsWithFormulas` (`cli/operations.js`)

Replicates the sort logic from `TableStore.#rebuildView` and creates a `TableFormulaEvaluator` to evaluate formula columns — the same computation the browser performs. Ensures consistent values between app and API. Exported from both `operations.js` and `SpreadsheetClient`.

---

## 14. Data Flow Summary

```
User edits cell in grid
        ↓
Grid.svelte (handleEventLayerMouseDown / keyboard handler)
        ↓
table.updateCell(displayIndex, colId, value)     ← for data cells
table.setEntryValue(colId, value)                 ← for entry row
table.commitEntry() → table.insertRow(buffer)     ← on Enter in entry row
        ↓
Yjs transact writes to source rowArr
        ↓
Yjs observer fires on rowArr (TableStore + TableManager + DocumentTableRegistry)
        ↓  ┌─────────────────────────────────────────────────────────────┐
           │ TableStore: #syncRows → #rebuildView → new evaluator        │
           │   sortedFilteredRows updated ($state)                       │
           │                                                             │
           │ TableManager: #rebuildRowIndex() → tableVersion++           │
           │   grid re-paints (reads tableVersion)                       │
           │                                                             │
           │ DocumentTableRegistry: onTableChange({sourceTableId,        │
           │                                        events, rowArr})     │
           │   → SpreadsheetSession classifies events                    │
           │     → engine.markTableDependentsDirty(name)  (by-name deps) │
           │     → engine.notifyCellsChanged(cells)       (grid deps)    │
           │       → one recalculateDirty() batch                        │
           └─────────────────────────────────────────────────────────────┘
```

---

## 15. Key Design Decisions & Notes

**One TableStore per table, owned by registry.** `TableManager` borrows. No duplicate observer sets when both the active sheet and the registry reference the same table.

**`visibleColumns = []` means "all columns."** This is the intent for the default first view. A second view created via the panel always gets an explicit column list so new source columns don't silently appear in it.

**Filters are two-layer.** View definition filters (`persistedFilters` in Yjs) are always applied and always synced across sessions. Ad-hoc filters are intentionally ephemeral — they don't survive reload, aren't synced, and don't interfere with the view's defined behavior.

**Legacy combined tables work unchanged.** Any table created before the source/view split displays normally. Its `isLegacy: true` flag in `getViewsForTable()` tells the UI not to offer column-visibility or definition-filter editing (those features require a proper source/view split).

**Source tables don't have grid positions.** `startRow`/`startCol` are only meaningful on views. `isSourceOnly` tables are skipped in `#rebuildRowIndex`, `maxInlineTableRow`, and `isTableShadowCell`.

**API server uses `TableFormulaEvaluator` directly.** No Svelte, no reactive state. `getTableRowsWithFormulas` manually applies sort and creates the evaluator, matching browser behavior. Callers get `?formulas=0` to opt into raw rows if needed.

**Default formula vs. isNonEntry are independent.** A column with `defaultFormula` only gets its formula evaluated at insert time — the result is stored as a plain value, and the user can edit it at any time. `isNonEntry` is a separate read-only toggle. Only when both are set does the column act as a "pure computed" column (always derived, never stored).

**Dependency resolution ensures correct order.** The evaluator topologically sorts columns before evaluating each row. Columns that use `PREV`/`NEXT`/`ROWVAL`/`WINDOW` are evaluated row-by-row sequentially so that cross-row references always read freshly-computed values from the 2-D cache. Cycles produce `#CYCLE` rather than crashing.

**`PREV(col, 0)` replaces `CUMSUM(col)`.** The old opaque `CUMSUM` helper is removed. Users write `{amount} + PREV(balance, 0)` which is explicit, overrideable per-row, and follows the same evaluation rules as every other formula. Old docs/formulas using `CUMSUM` inside a column default formula will continue to work via the migration path but new formulas should use `PREV`.
