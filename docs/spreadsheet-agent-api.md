# Spreadsheet API for agents

Programmatic access to Scriptorium spreadsheets, designed so an AI agent can
**author** documents — build them, format them, repair them — not just read
cells and append rows.

Three consumers, one implementation:

| Surface | Entry point | For |
|---|---|---|
| Browser client | `src/stores/spreadsheet/**` | The Svelte app |
| MCP server | `npm run mcp` | AI agents (tool calls) |
| REST server | `npm run api` | Scripts and other services |

All three go through the shared operations layer at
**`src/stores/spreadsheet/ops/`**. That is the point: the API used to
re-implement operations against the raw Yjs schema and drifted from the client
— most visibly when schema v9 interned cell styles into a palette and the API
kept writing (and returning) the old inline shape. One implementation makes
that class of drift impossible.

---

## The shared ops layer

Pure JS — no Svelte, no DOM, no Node-only modules — so it runs unchanged in the
browser and in Node.

| Module | Responsibility |
|---|---|
| `context.js` | Document traversal, sheet resolution, **schema-lockstep guard**, `OpError` |
| `cellOps.js` | Cells and ranges in A1 notation — values, formulas, styles |
| `formatOps.js` | The design surface — widths, heights, merges, borders, freeze, conditional formats |
| `sheetOps.js` | Sheet lifecycle and structural row/column edits (with formula-reference rewriting) |
| `tableOps.js` | Structured tables — creation, schema, validated row CRUD |
| `docOps.js` | `describeDocument()` orientation, `applyBatch()` atomic batches |
| `inspectOps.js` | Diagnostics for repair workflows |
| `evalOps.js` | Formula evaluation without the reactive engine |
| `tableRead.js` | Pure table read helpers |

Supporting shared modules: `src/formulas/a1.js` (A1 notation, built on
`refs.js`), `src/stores/spreadsheet/cells/styleAccess.js` (palette-aware style
read/write), `cells/styleNormalize.js` (canonical on-disk style shape),
`features/tableCreate.js` (source-table + view builders, shared with
`TableManager`).

Run `npm run verify` after touching any of it — `scripts/verify-ops.mjs`
exercises the layer against an in-memory `Y.Doc` with no network or browser.

---

## Design decisions that matter when calling it

**A1 notation everywhere.** `getRange(doc, 'Sheet 1', 'B2:D10')`, not
`(1, 1, 9, 3)`. Models reliably fumble 0-based integer offsets and natively
speak A1. Sheets resolve by name *or* id, so an agent that just listed sheets
doesn't need a second lookup.

**Reads evaluate formulas by default.** A formula cell returns `60`, with the
formula text alongside as `formula: "=SUM(A2:A4)"`. Pass `evaluate: false` for
the raw stored value. `TABLE_*` functions resolve server-side too, via a
Node-side adapter over the browser's `buildTableFunctions`.

**Styles resolve and intern through the palette.** Reads return
`{ bold: true, backgroundColor: '#eee' }`, never a raw `{ s: <sid> }` ref.
Writes normalize (stripping `false` booleans) and intern, so identical
formatting on two cells reuses one palette entry instead of duplicating the
payload the palette exists to collapse.

**Writes echo what was persisted**, so a caller can confirm the result without
a follow-up read.

**Errors are structured.** Every failure is an `OpError` with a `code`
(`SHEET_NOT_FOUND`, `VALIDATION_FAILED`, `MERGE_OVERLAP`, `SCHEMA_TOO_NEW`, …)
and `details` that usually name the valid alternatives. Agents branch on the
code and self-correct rather than parsing prose.

**Schema lockstep is enforced at runtime.** Client and API both import
`SCHEMA_VERSION` from `constants.js`, so they cannot drift at build time.
`prepareForWrite()` closes the runtime half: a document written by *newer* code
is refused (`SCHEMA_TOO_NEW`) rather than corrupted by a stale writer; an
*older* document is migrated forward with the same `spreadsheetSchema.migrate`
the client runs.

**Agent writes are attributable.** Every mutation is tagged with the
`YJS_ORIGIN.API` transaction origin, distinct from `UI`, so agent edits can be
filtered separately from a human's undo stack in history.

---

## A transaction rule you must know

`YKeyValue` rebuilds its lookup map from a `Y.Array` observer, and **Yjs fires
observers at transaction cleanup**. Inside a single transaction:

- `kv.get()` / `kv.has()` / iterating `kv.map` all return **pre-transaction**
  state — they do not see writes made earlier in the same transaction.
- `kv.set()` dedupes against that stale map, so writing the same key twice in
  one transaction can leave **duplicate entries** in the backing array.

Two consequences already baked into the layer:

1. `sheetOps` shifts cells and rewrites formulas in a **single read → compute →
   write pass**. Doing it in two passes reads pre-shift state and writes the
   adjusted formula back to the vacated key.
2. `applyBatch` runs each op in **its own transaction** rather than one shared
   one, so a batch that formats a cell it just wrote behaves as expected.
   Rollback is still all-or-nothing, via an `UndoManager` scoped to the `API`
   origin.

When writing new ops: read everything you need up front, and `kv.delete(key)`
before `kv.set(key, …)` if a key might be written twice in one transaction.

---

## MCP server

```sh
SCRIPTORIUM_API_KEY=... npm run mcp
```

Speaks MCP over stdio (newline-delimited JSON-RPC 2.0). The protocol is
implemented directly rather than via `@modelcontextprotocol/sdk` because
`spreadsheet-api` deliberately declares no dependencies and shares the parent
`node_modules` — a second copy of `yjs` breaks `instanceof Y.Array` checks in
`schema.js` and silently makes cell reads return `null`.

**stdout carries protocol frames only.** Diagnostics go to stderr; anything
else written to stdout corrupts the stream.

22 tools, grouped:

- **Orient** — `list_spreadsheets`, `describe_spreadsheet`, `inspect_spreadsheet`
- **Read** — `get_range`, `get_used_range`
- **Write** — `set_cell`, `set_range`, `clear_range`
- **Design** — `format_range`, `set_layout`, `set_borders`, `merge_cells`,
  `add_conditional_format`
- **Structure** — `modify_structure`, `manage_sheets`
- **Tables** — `create_table`, `get_table_schema`, `get_table_rows`,
  `append_table_rows`, `update_table_row`, `delete_table_row`
- **Batch** — `apply_batch`

`describe_spreadsheet` is the intended first call on an unfamiliar document: it
returns every sheet with its used range, frozen panes, merges and a data
preview, plus every table with its column schema — replacing an N+1 walk.

Tool failures return as `isError` content carrying the `OpError` code and
details, so the agent can correct itself rather than seeing a protocol error.

---

## REST server

```sh
SCRIPTORIUM_API_KEY=... npm run api      # :3456, Bearer auth forwarded to Scriptorium
```

Existing endpoints (`/files`, `/file/:id/sheets`, `.../table/:id/rows`,
`.../cell`, `/blobs`) keep their signatures — `operations.js` is now a
back-compat façade over the shared layer, so they inherit the palette and
formula fixes without callers changing.

Added:

| Endpoint | Purpose |
|---|---|
| `GET /file/:id/describe[?sample=N]` | One-call structure + preview |
| `GET /file/:id/inspect[?sheet=…]` | Diagnostics |
| `GET /file/:id/sheet/:sheet/range/:a1` | A1 read (`?formulas=1`, `?styles=1`, `?evaluate=0`) |
| `POST /file/:id/sheet/:sheet/range/:a1` | `{ values?, props?, style? }` |
| `POST /file/:id/batch` | `{ operations: [...] }`, atomic |

`OpError` codes map onto HTTP status (404 not-found, 409 conflict, 422
validation, 413 range-too-large).

---

## Safety

Agent writes land on live documents. Three things stand between an agent and a
bad edit:

1. **Schema guard** — refuses to write documents newer than the code.
2. **Validation before write** — table rows are checked against their column
   schema (types, dropdown options, required, computed-column rejection), and
   `appendRows` validates the whole batch before writing any of it.
3. **Server-side checkpointing** — the yjs backend already snapshots history,
   and API writes carry the `api` origin, so agent edits are identifiable when
   reviewing or rolling back.

Guard rails also cap range operations at 50,000 cells and refuse merges that
overlap an existing one rather than silently destroying a layout.
