# Table System — Architecture Knowledge Base

Written as a reference for a planned overhaul. Describes the current state: data model, reactive lifecycle, rendering, formula integration, computed columns, dropdowns, and the API server. Written from code-reading; not aspirational.

---

## 1. Data Model (Yjs)

Every table lives inside a sheet's Yjs map under the key `"tables"` (a `Y.Map<tableId, Y.Map>`). Each table Y.Map holds:

```
tableYMap
  id           string
  name         string (human-readable, user-editable)
  mode         "inline" | "viewport"
  accentColor  CSS hex string
  startRow     number  (inline mode: row of the header)
  startCol     number
  sortColId    string|null
  sortDir      "asc"|"desc"
  insertSortColId  string|null
  insertSortDir    "asc"|"desc"
  vpStartRow/Col/EndRow/EndCol  (viewport mode bounds)

  columnDefs   Y.Map<colId, Y.Map>   — one entry per column
  columnOrder  Y.Array<colId>        — display order

  rows         Y.Array<Y.Map>        — data rows (insertion order, oldest first)
    each row Y.Map: colId → value    (formula/isNonEntry columns are NOT stored here)
```

Each column definition Y.Map holds: `id`, `name`, `type`, `typeConfig` (JSON string), `required`, `isNonEntry`, `formula`, `hAlign`, `textColor`, `bgColor`, `width`, `bold`, `italic`, `underline`, `fontSize`, `fontFamily`, `conditionalFormats` (JSON string).

Filters are **local session state** — not in Yjs, not synced.

---

## 2. TableStore (`features/TableStore.svelte.js`)

One instance per table, per active sheet. Created by `TableManager` when the sheet loads.

**Reactive fields (Svelte 5 `$state`):**
- `rows` — plain JS array, synced from Yjs via `#syncRows()`
- `columns` — plain JS array of column def objects, synced via `#syncColumns()`
- `sortedFilteredRows` — derived view: `rows` reversed (newest first), then filtered, then sorted
- `sortColId`, `sortDir`, `filters`, `entryBuffer`, etc.
- `cumReverse` — `$derived`: true when no sort or descending (rows are newest-first, so cumulative sums run backwards)

**Key lifecycle:**
1. Constructor: reads Yjs, calls `#syncFromYjs()` → `#rebuildView()`, attaches Yjs observers
2. Yjs observer fires on any data change → `#syncRows()` or `#syncColumns()` → `#rebuildView()`
3. `#rebuildView()`: reverses rows, applies filters, applies sort, creates a fresh `TableFormulaEvaluator` from the result

**Formula evaluation (via `TableFormulaEvaluator`):**
- `getValue(displayIndex, colId)` — for `isNonEntry` columns, calls `this.#eval.evaluateFormula(formula, rowIndex)`; otherwise reads from `sortedFilteredRows[i][colId]`
- `getColumn(colId)` — maps over `sortedFilteredRows` calling `getValue`
- `getCumulativeSum(colId, upToIndex)` — delegates to `this.#eval`
- `resolveColId(nameOrId)` — delegates to `this.#eval` (case-insensitive name→id lookup)
- `evaluateFormula(formula, rowIndex)` — public wrapper, delegates to `this.#eval`

The `#eval` (a `TableFormulaEvaluator`) is recreated from scratch on every `#rebuildView()`. It holds all cumulative caches; they are invalidated automatically because the evaluator is replaced.

**Entry buffer:** `entryBuffer` is a local `$state({})` that holds in-progress values for the new-row entry form before commit. `setEntryValue(colId, value)` writes to it; `commitEntry()` calls `insertRow(entryBuffer)`.

**Validation:** `entryErrors` tracks which entry fields fail validation (required-but-empty, type mismatch, etc.).

**Row mutation:**
- `insertRow(rowData)` — transacts into Yjs, skips `isNonEntry` columns
- `updateCell(displayIndex, colId, value)` — finds the physical Yjs row by identity, transacts
- `deleteRow(displayIndex)` / `deleteRows([...])` — Yjs transact
- `updateColumnDef(colId, patch)` — writes to `columnDefs` Y.Map
- `setColumnFormula(colId, formula|null)` — sets/clears `isNonEntry` + `formula`

**Modes:**
- `inline` — header/entry/data rows appear inside the grid at `startRow`
- `viewport` — table is rendered as a floating overlay panel; occupies `vpStartRow..vpEndRow` visually but data rows are not grid-placed

---

## 3. TableFormulaEvaluator (`features/tableFormulaEval.js`)

Pure JS class, no Svelte runes. Importable in Node.js.

**Constructor:** `(rows, columns, cumReverse = false)`
- `rows`: snapshot of sorted/filtered rows (plain objects, colId → value)
- `columns`: column def array `[{id, name, isNonEntry, formula}]`

**Public methods:**
- `evaluateFormula(formula, rowIndex)` — runs the full 4-step pipeline:
  1. Substitute `ROW`, `ROW1`, `COUNT` meta-tokens
  2. Substitute `{colRef}` references with current row's values
  3. Substitute table-specific function calls (`CUMSUM`, `RUNNINGIF`, `SUMIF`, etc.)
  4. Evaluate the resulting expression via `parseFormula` + `evaluate`
- `getValue(rowIndex, colId)` — handles formula vs stored value
- `getColumn(colId)` — array of all values (respects formula columns)
- `getRowCount()`
- `getCumulativeSum(colId, upToIndex)` — lazy Float64Array cache, respects `cumReverse`
- `resolveColId(nameOrId)` — case-insensitive name→id

**Formula DSL:**
- `{colId}` / `{column name}` — current row value substitution
- `ROW` / `ROW1` — 0-based / 1-based row index
- `COUNT` — total row count
- `SUM(col)`, `AVG(col)`, `MIN(col)`, `MAX(col)` — whole-column aggregates
- `SUMIF(sumCol, filterCol, op, val)`, `SUMIFS`, `COUNTIF`, `AVGIF`, `MINIF`, `MAXIF`
- `CUMSUM(col)` — running total up to current row
- `RUNNINGIF(sumCol, filterCol, op, val)`, `RUNNINGIFS` — running conditional sum
- After substitution, arithmetic and `IF(...)` are handled by the formula parser/evaluator

---

## 4. TableManager (`features/TableManager.svelte.js`)

One instance per active sheet, held on `SpreadsheetSession.tableManager` and wired into `SheetRenderContext.tableManager`.

**Responsibilities:**
1. Creates and owns `TableStore` instances (one per table on the sheet)
2. Maintains a `#rowIndex: Map<row, {table, rowType, dataIndex}>` for O(1) grid-row → table-row lookup
3. Answers `getCellInfo(row, col)` — returns `{table, rowType, colDef, dataIndex}` or null
4. Provides `getCellDisplayValue(row, col)` — for canvas painting
5. Registers `TABLE_*` formula functions into the sheet's `FormulaEngine`
6. Exposes `getTableByName(name)` for cross-table lookups

**Row types returned by `getCellInfo`:**
- `'header'` — the column-name header row
- `'entry'` — the new-row input row (always shown below header)
- `'data'` — a data row, with `dataIndex` as the display index into `sortedFilteredRows`

**`#rowIndex` rebuild:** called after every `#rebuildView()` (via Yjs row array observeDeep). Covers header row, entry row, and all data rows for each table.

**Formula functions registered:**
- `TABLE_GET(name, rowIndex, colId)` — single value
- `TABLE_COL(name, colId)` — flat array of all values
- `TABLE_COUNT(name)` — row count
- `TABLE_SUM`, `TABLE_AVG`, `TABLE_MIN`, `TABLE_MAX`
- `TABLE_FILTER(name, colId, op, val)` — rows matching condition as 2D array
- `TABLE_FILTERCOL(name, colId, filterColId, op, val)` — column values where condition matches
- `TABLE_FILTERCOLIFS(name, colId, col1, op1, val1, ...)` — multi-condition version
- `TABLE_LOOKUP(name, lookupCol, lookupVal, returnCol)`
- `TABLE_SUMIFS`, `TABLE_AVGIFS`

All these look up tables via `byName` which tries the active sheet's `TableManager` first, then falls back to `session.getCrossSheetTable(name)` for cross-sheet tables. The cross-sheet fallback reads raw Yjs data (no reactive TableStore).

---

## 5. SheetRenderContext (`features/SheetRenderContext.svelte.js`)

The render context bridges the reactive stores and the canvas grid. `TableManager` is wired in as `this.tableManager`.

**`getCellTypeConfig(row, col)`:**
1. If it's a table cell (`tableManager.getCellInfo` returns non-null):
   - Header rows → `null` (plain text)
   - Data/entry rows → check sheet-level cell override first, then column `typeConfig`, then bare column type
2. Otherwise → check sheet-level cell `ct` property, then infer from value

**`getCellDisplayValue(row, col)`:**
- For table data rows: calls `tableManager.getCellDisplayValue` which calls `table.getValue(dataIndex, colDef.id)`
- For table entry rows: reads from `table.entryBuffer`
- For table header rows: returns `colDef.name`

**`effectiveRowCount`:** extended by `tableManager.maxInlineTableRow` to include all table rows below the sheet's natural row count.

**`getStickyTableHeaders()`:** used by the grid to render column headers that stay visible while scrolling within a table.

---

## 6. Grid Integration (`Grid.svelte`)

The grid uses `renderContext` (derived from `spreadsheetSession.renderContext`) throughout.

**Rendering:** Canvas-based. `CellPaintData` receives `renderContext` and paints cells. Table header/entry/data rows are painted with table-specific styles (accent color, etc.).

**Cell interaction — opening an editor:**
When the user activates a cell, Grid checks `renderContext.getCellTypeConfig(row, col)`:

- `type === 'dropdown'`:
  - `source === 'list'` → uses `ct.options` array
  - `source === 'range'` → calls `resolveRangeOptions(ct.range)` (reads cell values from the sheet)
  - `source === 'table'` → calls `resolveTableColumnOptions(ct.tableName, ct.columnId)`:
    - Tries `renderContext.tableManager.getTableByName(tableName)` → `store.getColumn(...)` (same sheet, reactive, evaluates formula columns)
    - Falls back to `spreadsheetSession.getTableColumnValues(tableName, columnId)` (cross-sheet, raw Yjs snapshot)
  - If options are non-empty → opens `focusedDropdownCell` overlay
  - Otherwise → falls through to text editor
- `type === 'checkbox'` / `type === 'rating'` → handled by click, not text editor
- `type === 'date'` / `type === 'time'` / `type === 'datetime'` → opens picker
- `type === 'image'` / `type === 'file'` → opens blob picker
- Everything else → text editor

**Two paths for table vs sheet cells:**
Grid distinguishes between cells that belong to a `TableStore` (`getCellInfo` returns non-null) and plain sheet cells. For table cells:
- Commits go via `table.updateCell(dataIndex, colDef.id, value)` or `table.setEntryValue(colDef.id, value)`
- For the entry row, committing writes to the entry buffer, not directly to a row

**`resolveTableColumnOptions`:** defined locally in Grid.svelte, uses `renderContext.tableManager` for same-sheet tables and `spreadsheetSession.getTableColumnValues` for cross-sheet. Does NOT evaluate formula columns for cross-sheet case (that path goes through `SpreadsheetSession.getTableColumnValues` → `getCrossSheetTable` → temporary `TableStore` snapshot).

---

## 7. Cell Type Configurator (`toolbar/CellTypeConfigurator.svelte`)

Used both in **sheet mode** (toolbar, writes to individual cell `ct` property via `sheetStore.setCellTypeConfig`) and **controlled mode** (table column panel, writes to column `typeConfig` via a callback).

For dropdown source `'table'`:
- `availableTables()` — calls `spreadsheetSession.getAllTableDescriptors()`, which reads all sheets' tables from Yjs directly (no reactive TableStore). Returns `[{tableName, sheetId, sheetName, columns: [{id, name}]}]`
- `selectedTableColumns()` — filters `availableTables()` by `options.tableName`
- On save: stores `{ type: 'dropdown', source: 'table', tableName, columnId, allowCustom, validation }` as the cell/column type config

Column name shown in dropdown: `t.tableName (t.sheetName)` when on a different sheet.

---

## 8. SpreadsheetSession — Cross-Sheet Table Methods

`SpreadsheetSession` holds a single `tableManager` (for the active sheet only). For cross-sheet access it provides:

**`getAllTableDescriptors()`**
Reads all sheets' `tables` Y.Maps directly, without creating TableStore instances. Returns metadata only (name, columns with id+name). Used by the configurator UI to list available tables.

**`getTableColumnValues(tableName, columnId)`**
Delegates to `getCrossSheetTable` then extracts the named column. Used by `resolveTableColumnOptions` in Grid.svelte.

**`getCrossSheetTable(tableName)`**
- Iterates all sheets using `tablesMap.forEach` (not `for...of`, which is unreliable on Y.Map)
- When found: creates a temporary `TableStore(tableYMap, ydoc)`, snapshots all column values (including formula columns) into plain row objects via `store.getValue(i, colId)`, calls `store.destroy()`, returns `{sortedFilteredRows, resolveColId}`
- This is the only place a `TableStore` is created and immediately destroyed outside the normal sheet lifecycle
- Formula columns ARE evaluated in this path (unlike the old raw-Yjs approach)

**`getCrossSheetTable` is also used by `TableManager.byName` fallback** for cross-sheet `TABLE_*` formula functions. This means `TABLE_FILTERCOL` on a different sheet's table will work, but with a fresh snapshot (not reactive — formula recalculation won't auto-update).

---

## 9. SpreadsheetSession — Sheet Switching

When the active sheet changes (`switchSheet(sheetId)`):
1. Old `TableManager` is destroyed (Yjs observers unsubscribed)
2. Old `SheetRenderContext` is destroyed
3. New `TableManager` created for new sheet
4. `FormulaEngine` re-initialized → `tableManager.registerFunctions(formulaEngine, session)` re-registers all `TABLE_*` functions with the new manager
5. New `SheetRenderContext` created, wired with new `tableManager`

This means: formula functions always operate against the **active sheet's** `TableManager` for local tables, plus session-level cross-sheet snapshots for others.

---

## 10. Spreadsheet API Server (`spreadsheet-api/server.js`)

REST API wrapper over `SpreadsheetClient` (which wraps Yjs directly, no Svelte).

**Schema endpoint** (`GET /file/:fileId/sheet/:sheetId/table/:tableId/schema`):
Returns column definitions including resolved dropdown `options`. Three cases:
- `source === 'range'` → `resolveRangeOptions()` — reads cell values from the Yjs doc, evaluates `=formula` cells using `parseFormula`+`evaluate`
- `source === 'table'` → `resolveTableColumnOptions()` — searches all sheets via `client.listTables()`, reads rows via `client.getTableRows()` (raw Yjs, **no formula column evaluation**)
- Static `options` array → returned as-is

**`client.getTableRows(ydoc, sheetId, tableId)`** returns raw Yjs rows — `rowArr.toArray().map(r => r.toJSON())`. Formula/computed columns return nothing (they aren't stored in Yjs). This is a known limitation vs the browser path.

**No `TableStore` or `TableFormulaEvaluator` in the API server yet.** The `operations.js` and `SpreadsheetClient` layer is pure Yjs reads — no Svelte, no rune syntax. To evaluate formula columns server-side, `operations.js` would need to import and use `TableFormulaEvaluator` (which is plain JS and importable in Node.js).

---

## 11. Known Gaps / Inconsistencies

1. **Cross-sheet formula functions aren't reactive.** `TABLE_FILTERCOL("OtherSheet::Table", ...)` returns a snapshot. If the other sheet's data changes, the formula cell won't recalculate until the sheet is switched or the doc is reloaded.

2. **API server doesn't evaluate formula columns.** `GET .../rows` and the schema `options` resolver return only stored values. Formula columns appear empty.

3. **Dropdown `ddOptions.length > 0` gate.** If a table-sourced dropdown column is empty, the cell falls through to a text editor instead of showing an empty dropdown. This makes the "table has no data yet" state invisible to users.

4. **`getCrossSheetTable` creates and destroys a `TableStore` on every call.** This is correct and avoids observer leaks, but it's O(rows × columns) work per call since it evaluates all formula columns eagerly. For large tables called from many formula cells, this could be expensive.

5. **Filters are local session state.** Cross-sheet table access via `getCrossSheetTable` returns unfiltered rows (reversed and sorted by the Yjs sort config, but no active filter applied). This is consistent but worth documenting.

6. **`TableFormulaEvaluator` is recreated on every `#rebuildView`.** The old code had partial cache invalidation (`#markCumDirty`). The new code always builds fresh. For CUMSUM/RUNNINGIF on large tables this is more expensive per render cycle.

7. **No deduplication of dropdown options.** `resolveTableColumnOptions` returns all non-empty values including duplicates. A "Status" column with 100 rows of "Active"/"Inactive" returns 100 entries.

8. **`viewport` mode tables** are partially different: their rows are not embedded in the grid's row index (`#rowIndex` in `TableManager`), they render as overlays, and their interaction logic in Grid.svelte has separate handling.

9. **Column `typeConfig` is stored as a JSON string** in Yjs column defs. When read back in `#syncColumns`, it's parsed. This means it round-trips through JSON, which is fine but means any non-JSON-serializable values in a typeConfig would be silently lost.

10. **`SpreadsheetSession.getCrossSheetTable`** skips the active sheet (which is handled by `tableManager.getTableByName` upstream). But the implementation iterates ALL sheets including the active one — it doesn't skip — it just won't be reached because `getTableByName` would have found it first.
