# Spreadsheet Performance Architecture

> Reference for performance-oriented exploration. Focus: load time, render throughput, formula cost, memory. Not a tutorial on the feature set.

---

## Data flow from user action to screen

```
User action (keystroke / scroll / table edit)
  │
  ├─ Cell edit path
  │    SpreadsheetSession.setCell() / setCellFormula()
  │      → ydoc.transact()                       [Yjs — IndexedDB + WebSocket]
  │      → SheetStore cells observer fires       [1 batch per Yjs transaction]
  │      → SheetStore.cellsVersion++             [triggers Svelte effect below]
  │      → Grid $effect reads cellsVersion
  │      → renderScheduler.invalidate('all')
  │      → requestAnimationFrame scheduled
  │      → CanvasRenderer.paintPane() × 4 panes [actual GPU work]
  │
  ├─ Scroll path (hot — fires 60× / s while scrolling)
  │    browser scroll event on event-layer div
  │      → GridVirtualizer.scrollTop / scrollLeft = newValue
  │      → Grid $effect reads scroll state
  │      → CanvasRenderer.blitScroll() + paintPane() on exposed strip
  │
  └─ Table row insert / filter / sort
       TableStore sortedFilteredRows $derived recomputes
         → TableManager.#rebuildRowIndex()       [iterates all rows, all tables]
         → tableManager.tableVersion++
         → renderScheduler.invalidate('all')
         → RAF → paintPane()
```

**Key insight**: every cell edit triggers `invalidate('all')` — all 4 panes repaint even if only 1 cell changed. This is the main render-budget cost for interactive editing.

---

## Rendering pipeline

The grid renders entirely on a single `<canvas>` element. There are no DOM nodes per cell.

```
GridVirtualizer                  AxisMetrics
  scrollTop / scrollLeft   →   offsetOf(row/col)   [O(log n) prefix-sum lookup]
  frozenRows / frozenCols  →   Pane ranges computed [4 panes: corner/top/left/body]
         │
         ▼
  buildPaneData()                SheetRenderContext
    for each visible cell   →   getCellType(row, col)         [O(1) rowIndex map lookup]
                            →   getDisplayValue(row, col)     [formula eval if "=" prefix]
                            →   getEffectiveStyle(row, col)   [merge / table style]
         │
         ▼
  RenderScheduler.invalidate()
    requestAnimationFrame coalesces multiple invalidations into 1 paint
         │
         ▼
  CanvasRenderer.paintPane(cells, options)
    ctx.save() / ctx.scale(dpr, dpr)
    for cell in cells:
      fillRect (background)
      CellTypeRegistry painter OR fillText (text)
    stroke() path (gridlines — batched into 1 call)
    #paintCustomBorders() per cell (if any)
    ctx.restore()
```

**Blit-scroll optimisation**: on scroll, `blitScroll()` copies the existing canvas pixels and only repaints the newly exposed strip — not the entire viewport.

---

## Formula evaluation

Sheet formulas (cells with `v` starting with `=`) are **evaluated on every read** during canvas painting. There is no formula result cache.

```
CanvasRenderer reads cell A1 = "=SUM(B1:B100)"
  → renderContext.getDisplayValue(0, 0)
    → sheetStore.getCellValue(0, 0) detects "=" prefix
    → formulaEngine.evaluate("=SUM(B1:B100)")
      → parseFormula()    [builds AST]
      → evaluate(ast)     [walks AST, reads B1..B100 via getCellValue]
    → returns number
```

Cost: O(formula complexity × cells referenced). If there are 30 visible formula cells, all 30 evaluate synchronously inside the RAF callback. Complex formulas referencing large ranges (e.g. `=SUM(A:A)`) are expensive every frame.

**Table computed columns** use a separate evaluator (`TableFormulaEvaluator`) with its own caching:
- `CUMSUM` / `RUNNINGIF` / `RUNNINGIFS` → `Float64Array` caches, built lazily, valid for the current `rows` snapshot
- `SUM` / `AVG` / `MIN` / `MAX` → **no cache** — iterates all rows on every call via `getColumn()`
- Column references use `#cols.find()` — O(n) linear scan per lookup

---

## Table row index

`TableManager.#rebuildRowIndex()` maintains a `Map<sheetRow, [{table, rowType, dataIndex}]>` for O(1) render-path lookups.

**When it runs**: on any `observeDeep` event on a table's `rows` Y.Array, `filters` Y.Map, or top-level table Y.Map. In a transaction that touches 50 rows, this fires 50 times (once per row mutation within the Yjs transaction's deep-observer cascade), rebuilding the entire index each time.

**Cost**: proportional to `Σ(sortedFilteredRows.length)` across all tables. For a sheet with 3 tables of 500 rows each, each rebuild iterates 1500 entries.

---

## Memory landscape

| Structure | Size driver | Notes |
|---|---|---|
| `SheetStore.cells` | `Map<"r,c", cellObj>` — one entry per non-empty cell | Frozen `EMPTY_CELL` reused for absent cells |
| `TableStore.rows` | One plain object per row with all column values | Allocated on Yjs observer |
| `TableFormulaEvaluator.#cumCache` | `Float64Array(n)` per column | Rebuilt when `rows` snapshot changes |
| Text measurement cache | `Map<"text|font", number>` — max 10 000 entries | Module-level singleton; evicts oldest 5 000 when full |
| CanvasRenderer.#wrapCache | `Map<string, Array>` — max 500 entries | Per-renderer instance; cleared on resize |
| `DocumentTableRegistry` | All `TableStore` instances for all sheets | Held for lifetime of the document session |
| Yjs doc | Encoded state vector + update log in IndexedDB | Grows with edit history; no pruning by default |

---

## Load time breakdown

```
storage.drive.loadDoc(docId)            [IndexedDB read + WebSocket handshake]
  → new Y.Doc() + apply stored updates  [Yjs CRDT replay]
  → spreadsheetSchema.initialize()      [idempotent schema migration]
  → new SheetStore(activeSheet, ydoc)
    → #syncAllCells()                   [one Map.set per non-empty cell]
    → #setupObservers()
    → new MergeEngine()
  → new TableManager(sheet, ydoc, registry)
    → new TableStore() × (tables in sheet)
    → #rebuildRowIndex()
  → new FormulaEngine()
  → Grid mounts → GridVirtualizer computes visible range
  → RenderScheduler schedules first RAF
  → CanvasRenderer.paintPane() × 4    [first paint]
```

**Dominant costs on large documents**: `#syncAllCells()` (one allocation per cell), TableStore construction (one `observeDeep` per table), and the Yjs update replay inside `loadDoc`.

---

## Confirmed bottlenecks (from Chrome profiler, 4300–4550ms scroll window)

Full scroll task breakdown for reference:

| Category | Measured | Root cause |
|---|---|---|
| `Intl.NumberFormat` construction | **35ms** | `new Intl.NumberFormat(...)` called per numeric cell per frame in `automatic.js` and `number.js` |
| `buildPaneData` (`bl`) self time | **38ms** | Per-cell style/value iteration; calls `getDisplayValue` + `getRowFormatting` per cell |
| Canvas commit | **30ms** | Browser compositor uploading canvas bitmap — proportional to canvas physical pixel area |
| Formula re-parse (`Dl` = `parseFormula`) | **23ms** | No AST cache; formula string re-parsed on every `evaluateFormula` call |
| `getCellDisplayValue` / `getRawDisplayValue` | **24ms** | Uncached formula evaluation per visible cell per frame |
| `paintPane` + `paintStickyHeaders` | **14ms** | Canvas drawing — acceptable; not the bottleneck |

### Fixes applied

| Fix | Expected saving | File(s) changed |
|---|---|---|
| Cache `Intl.NumberFormat` instance (automatic type) | ~20ms/frame | `cellTypes/types/automatic.js` |
| Cache `Intl.NumberFormat` by options key (number type) | ~15ms/frame | `cellTypes/types/number.js` |
| Cache parsed formula ASTs (`cachedParseFormula`) | ~23ms/frame | `formulas/evaluator.js`, `formulas/FormulaEngine.svelte.js` |
| Cache `SheetStore` + engines on sheet switch (LRU-3) | 200–800ms per switch | `SpreadsheetSession.svelte.js` |
| `performance.mark()` on all load/switch phases | measurement | `SpreadsheetSession.svelte.js` |
| `buildPaneData` timing in PerfMonitor | measurement | `Grid.svelte` |

### Remaining scroll bottleneck after fixes

`buildPaneData` self time (~38ms) is now the dominant remaining cost. It calls `getDisplayValue` + `getRowFormatting` for every visible cell on every full repaint. The next optimization is a display-value cache keyed on `(row, col, cellsVersion)` — when `cellsVersion` hasn't changed, skip re-evaluation entirely.

### Remaining load-time bottleneck

Use `performance.getEntriesByName('ss:sheetStore')` etc. in DevTools after a load to see which phase dominates. The load path is now instrumented with marks: `ss:load:total`, `ss:yjsLoad`, `ss:sheetStore`, `ss:tableRegistry`, `ss:tableManager`, `ss:formulaEngine`.

## Identified bottlenecks (ranked by likely impact)

| # | Area | Root cause | Status |
|---|---|---|---|
| 1 | **`Intl.NumberFormat` per cell** | Constructed fresh on every number format call | **Fixed** — module-level singleton / options cache |
| 2 | **Formula re-parse per frame** | `parseFormula()` called on every `evaluateFormula` call | **Fixed** — `cachedParseFormula` with 1K LRU cache |
| 3 | **Sheet switch: full engine rebuild** | `SheetStore` + 4 engines destroyed + recreated on every switch | **Fixed** — LRU-3 engine cache; cache hit is ~1ms |
| 4 | **`buildPaneData` per-cell overhead** | Style + value read per cell, 38ms self time for 1400-cell pane | Open — next: display-value cache keyed on cellsVersion |
| 5 | **`invalidate('all')` on any cell edit** | All 4 panes repaint even for single cell change | Open — dirty-row tracking |
| 6 | **`#rebuildRowIndex` fires per-row** | `observeDeep` fires once per row mutation | Open — debounce with `queueMicrotask` |
| 7 | **`#cols.find()` in `getValue()`** | O(n) linear scan per table cell during render | Open — pre-built `Map<colId, colDef>` |
| 8 | **Canvas commit cost** | Large physical canvas bitmap uploaded each frame | Open — reduce overscan, or offscreen canvas |

---

## Using the PerfMonitor

```js
// Browser console (DevTools):
window.__spreadsheetPerf.enable()

// ... use the spreadsheet (scroll, edit cells, insert rows) ...

window.__spreadsheetPerf.report()
// Prints per-category avg/p95/max/count.

// Visualise frame time distribution:
window.__spreadsheetPerf.frameSparkline()

// Raw data for charting:
const { 'render.frame': frames } = window.__spreadsheetPerf.data;
```

Instrumented automatically once enabled:
- `render.frame` — total ms per RAF cycle (all panes)
- `render.paintPane` — ms per individual pane
- `render.cellsPerPane` — cell count per pane paint
- `table.rebuildRowIndex` — ms per row-index rebuild
- `data.cellsVersionBump` — count of Yjs→SheetStore updates
- `text.measureHit` / `text.measureMiss` — text cache effectiveness

**To add a new measurement**, import `perfMon` from `src/stores/spreadsheet/perf/PerfMonitor.js` and call `perfMon.record(category, ms)`, `perfMon.count(category)`, or `perfMon.time(category, fn)`.

---

## Quick wins to investigate first

1. **Formula result cache** keyed on `(row, col, cellsVersion)` — eliminates re-evaluation for cells not changed since last paint.
2. **Dirty-pane tracking** — track which rows changed and only repaint panes that overlap those rows.
3. **Batch `#rebuildRowIndex`** — debounce with `queueMicrotask` so multiple row mutations in one Yjs transaction produce one rebuild instead of N.
4. **`#cols` lookup Map** in `TableFormulaEvaluator` — replace `#cols.find()` with a pre-built `Map<colId, colDef>`.
5. **Cache `TABLE_SUM` / `TABLE_AVG`** at the evaluator level — invalidate when `rows` snapshot changes.
