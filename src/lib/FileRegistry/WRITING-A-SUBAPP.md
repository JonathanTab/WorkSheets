# Writing a Yjs Sub-App

This guide is for anyone adding a new collaborative document type to Scriptorium (a new editor, a new viewer, anything that owns its own Yjs document shape). It explains the load / init / migration contract every sub-app inherits from `FileRegistry` and shows where each piece plugs in.

The spreadsheet sub-app is the reference implementation — when in doubt, look at `src/stores/spreadsheet/schema.js` and `src/stores/spreadsheet/SpreadsheetSession.svelte.js`. The docs sub-app (`src/stores/docs/`) was written before this contract existed and should be migrated to it (see "Migrating an existing sub-app" at the end).

---

## What FileRegistry already handles for you

You should not write code for any of these — they happen automatically once your sub-app conforms to the contract:

- **WebSocket + IndexedDB sync** with offline queue and reconnection.
- **Awareness / presence** (collaborative cursors are wired through `provider.awareness`).
- **File CRUD** (create, rename, move, delete, share) via `storage.drive.*` / `storage.app.*`.
- **Snapshots and restore** via the server's `/api/snapshots` endpoints and `HistoryManager`.
- **Cross-tab BroadcastChannel** for local state coherence.
- **First-open biasing** — when you load a doc that wasn't created on this device, the runtime waits for server state instead of returning early with an empty doc.
- **Missed-rotation detection** — if a snapshot restore rotated the roomId while you were offline, the stale IndexedDB DB is dropped and a `missed-rotation` event fires.
- **Init-success verification** — if your initializer throws or writes nothing, the half-created file is rolled back.
- **Schema-version stamp + skip + read-only** — handled by `prepareDocForUse` (see below).

What you *do* write is small:

1. An `AppSchema` describing your doc's root shape and migrations.
2. A session class (or store) that calls `prepareDocForUse` on load.
3. A `createDocument` helper that calls `storage.drive.createAndInitializeFile`.

That's it.

---

## The contract: `AppSchema`

Every sub-app exports an `AppSchema` object. Its shape is defined in `src/lib/FileRegistry/yjsDocLifecycle.js`:

```js
/** @type {import('$lib/FileRegistry/yjsDocLifecycle.js').AppSchema} */
export const mySubAppSchema = {
    // Top-level Y.Map key — uniquely identifies your doc shape.
    // Pick something descriptive; do not collide with other sub-apps.
    rootKey: 'mydoc',

    // Integer schema version. Bump this every time you ship a migration.
    // Stored as a plain integer constant in your sub-app's constants file.
    version: parseInt(MYDOC_SCHEMA_VERSION),

    // Optional — defaults shown.
    metadataKey: 'metadata',
    schemaVersionKey: 'schemaVersion',

    // Return true when the doc has your expected root structure.
    // Used to distinguish a populated doc from a never-initialized one.
    // Must be cheap (called on every load).
    isStructureValid: (ydoc) => {
        const root = ydoc.getMap('mydoc');
        return root.get('content') instanceof Y.Map;
    },

    // Idempotent. Creates the root structure on an empty Y.Doc.
    // The lifecycle helper guarantees this is only called when the
    // server has confirmed the doc is genuinely empty.
    initialize: (ydoc) => {
        const root = ydoc.getMap('mydoc');
        if (root.get('content')) return; // belt-and-braces idempotency
        ydoc.transact(() => {
            // Build your initial structure.
            root.set('metadata', new Y.Map());
            root.set('content', new Y.Map());
            // The lifecycle helper will stamp metadata.schemaVersion for
            // you when migrate() runs, but you can stamp directly here too:
            //   stampSchemaVersion(ydoc, mySubAppSchema)
        }, MY_MIGRATION_ORIGIN);
    },

    // Forward-only migrations. Idempotent (so old clients applying part
    // of the chain don't break newer ones). MUST NOT create the root
    // structure — that's `initialize`'s job. After all migrations run,
    // stamp the doc with the current version (or call stampSchemaVersion).
    migrate: (ydoc) => {
        // Skip when stamped current. The lifecycle helper already does
        // this before calling, but keep the guard for direct callers.
        const stamped = readSchemaVersion(ydoc, mySubAppSchema);
        if (stamped != null && stamped >= mySubAppSchema.version) return;

        const root = ydoc.getMap('mydoc');

        // v2 — example: rename a key
        // (Yjs cannot re-parent existing Y types; deep-copy if needed.)
        // ...

        // v3 — example: add a missing sub-collection to existing docs
        // ...

        stampSchemaVersion(ydoc, mySubAppSchema, MY_MIGRATION_ORIGIN);
    },
};
```

---

## The five rules

These come from real bugs we've already fixed. Internalize them.

### 1. Never create root structure outside `initialize`

If `isStructureValid` returns false, you might be looking at a brand-new doc, **or** at a doc whose server state hasn't arrived yet. If you create the root structure speculatively, Yjs LWW (last-writer-wins on Y.Map) will make your local writes win against the real server data, silently overwriting it.

`prepareDocForUse` handles this correctly: it waits for server sync, and only calls `initialize` after the server has *confirmed* the doc is empty.

If you ever find yourself writing `if (!root.get('content')) root.set('content', new Y.Map())` in a load path, you're about to corrupt data. Stop.

### 2. Migrations are forward-only and idempotent

- **Forward-only**: there is no down-migration. A newer client may add fields; older clients see those fields as unknown and `prepareDocForUse` opens the doc read-only so they can't drop them.
- **Idempotent**: re-running a migration must be a no-op. Two clients on different versions may both try to migrate the same doc; each migration must guard with `.has()` / `instanceof` checks before transforming.
- **Tagged**: wrap every migration write in `ydoc.transact(fn, YOUR_MIGRATION_ORIGIN)`. The UndoManager filters by origin, so migrations stay out of the user's undo stack.

### 3. Yjs types cannot be re-parented

Setting an existing `Y.Map` under a new key (or moving a `Y.Array` into another container) **corrupts the CRDT tree**. When a migration needs to relocate data, deep-copy into fresh Y types and delete the old. See `_v6CloneSourceTable` in `src/stores/spreadsheet/schema.js` for the canonical pattern.

### 4. Bump `SCHEMA_VERSION` on every shipping migration

Any time you add code to your `migrate` function that touches an existing doc shape, increment your constant **and** update `public/schema-version.json`'s `minSchemaVersion` if old clients can no longer write valid data. The version stamp is what lets `prepareDocForUse` open newer-than-client docs read-only.

### 5. UI state never goes in Yjs

Selection, scroll position, modal open state, hover, drag previews — these are local. Yjs is for **document content**. The collaboration cursor / presence layer goes through `provider.awareness`, not the doc.

---

## Setting up a new sub-app — step by step

### Step 1: Constants

Create `src/stores/<myapp>/constants.js`:

```js
export const MYDOC_SCHEMA_VERSION = '1';
```

Also pick a Y-transaction origin for migrations:

```js
// src/stores/<myapp>/yjsOrigins.js
export const MY_YJS_ORIGIN = {
    MIGRATION: Symbol('mydoc:migration'),
    LOCAL:     Symbol('mydoc:local'),
    REMOTE:    Symbol('mydoc:remote'),
};
```

### Step 2: Schema

Create `src/stores/<myapp>/schema.js`. Export both the migration object **and** an `AppSchema`:

```js
import * as Y from 'yjs';
import { MYDOC_SCHEMA_VERSION } from './constants.js';
import { MY_YJS_ORIGIN } from './yjsOrigins.js';
import {
    readSchemaVersion,
    stampSchemaVersion,
} from '$lib/FileRegistry/yjsDocLifecycle.js';

const migrateTransact = (ydoc, fn) => ydoc.transact(fn, MY_YJS_ORIGIN.MIGRATION);

export function initializeDocument(ydoc) {
    const root = ydoc.getMap('mydoc');
    if (root.get('content')) return;
    migrateTransact(ydoc, () => {
        const meta = new Y.Map();
        meta.set('createdAt', Date.now());
        root.set('metadata', meta);
        root.set('content', new Y.Map());
    });
}

export const mydocSchema = {
    version: MYDOC_SCHEMA_VERSION,
    migrate: (ydoc) => {
        const root = ydoc.getMap('mydoc');
        if (!root.get('content')) return; // never create structure here

        const stamped = readSchemaVersion(ydoc, mydocAppSchema);
        if (stamped != null && stamped >= parseInt(MYDOC_SCHEMA_VERSION)) return;

        // …your migrations…

        stampSchemaVersion(ydoc, mydocAppSchema, MY_YJS_ORIGIN.MIGRATION);
    },
};

/** @type {import('$lib/FileRegistry/yjsDocLifecycle.js').AppSchema} */
export const mydocAppSchema = {
    rootKey: 'mydoc',
    version: parseInt(MYDOC_SCHEMA_VERSION),
    isStructureValid: (ydoc) => ydoc.getMap('mydoc').get('content') instanceof Y.Map,
    initialize: (ydoc) => initializeDocument(ydoc),
    migrate: (ydoc) => mydocSchema.migrate(ydoc),
};
```

### Step 3: Session

Create `src/stores/<myapp>/<MyApp>Session.svelte.js`. The load method is mostly boilerplate that calls `prepareDocForUse`:

```js
import { log } from '$util/log.js';
import storage from '../storage.js';
import { mydocAppSchema, initializeDocument } from './schema.js';
import { prepareDocForUse } from '$lib/FileRegistry/yjsDocLifecycle.js';

export class MyAppSession {
    docId        = $state(null);
    ydoc         = $state.raw(null);
    isLoading    = $state(false);
    error        = $state(null);
    readOnly     = $state(false);
    readOnlyReason = $state(null);
    /** @type {Array<{id:string,severity:'info'|'warn',message:string}>} */
    notices      = $state([]);

    #cleanupMissedRotation = null;

    async load(docId) {
        this.isLoading = true;
        this.error = null;
        try {
            await this.unload();
            const ydoc = await storage.drive.loadDoc(docId);

            const prep = await prepareDocForUse({
                ydoc,
                waitForServerSync: () => storage.drive.waitForServerSync(docId),
                schema: mydocAppSchema,
                log,
            });

            this.readOnly       = prep.readOnly;
            this.readOnlyReason = prep.readOnlyReason;
            this.notices = [];
            if (prep.recovery === 'auto-initialized') {
                this.#pushNotice('warn',
                    'This file was empty on the server and has been re-initialized as a blank document.');
            }

            // Subscribe to missed-rotation events for THIS doc only.
            this.#cleanupMissedRotation?.();
            const onMissed = (payload) => {
                if (payload?.fileId !== docId) return;
                this.#pushNotice('warn',
                    'This document was restored from a snapshot while you were offline. ' +
                    'Any offline edits have been discarded — the restored version is now active.');
            };
            storage.on('missed-rotation', onMissed);
            this.#cleanupMissedRotation = () => storage.off('missed-rotation', onMissed);

            this.docId = docId;
            this.ydoc  = ydoc;
            // …wire your store/observers here…
        } catch (e) {
            this.error = e.message;
        } finally {
            this.isLoading = false;
        }
    }

    async unload() {
        this.#cleanupMissedRotation?.();
        this.#cleanupMissedRotation = null;
        // …teardown observers etc…
        this.docId = null;
        this.ydoc = null;
        this.readOnly = false;
        this.readOnlyReason = null;
        this.notices = [];
    }

    #pushNotice(severity, message) {
        this.notices = [
            ...this.notices,
            { id: `n-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, severity, message },
        ];
    }

    dismissNotice(id) {
        this.notices = this.notices.filter(n => n.id !== id);
    }
}
```

### Step 4: Create helper

Pair every sub-app with a top-level `createDocument` that uses `createAndInitializeFile`:

```js
export async function createMyDocument(title) {
    return storage.drive.createAndInitializeFile({
        title,
        app: 'mydoc',                // see Step 5
        initializer: (ydoc) => {
            initializeDocument(ydoc);
        },
    });
}
```

`createAndInitializeFile` verifies the initializer wrote content (via `ydoc.store.clients.size`). If it didn't, the half-created file is rolled back automatically — both online (server file row deleted) and offline (local row + queued mutation removed).

### Step 5: Register the app type with the server

In `src/components/<MyApp>Workspace.svelte` (or wherever you mount the editor), construct `HistoryManager` with the app type and a way to read the schema version off the live doc:

```svelte
<script>
    import { HistoryManager } from '$lib/history/HistoryManager.svelte.js';
    import { readSchemaVersion } from '$lib/FileRegistry/yjsDocLifecycle.js';
    import { mydocAppSchema } from '$stores/mydoc/schema.js';

    const hm = new HistoryManager({
        fileId: docId,
        registry,
        appType: 'mydoc',                   // sent to the server for snapshot tagging
        onAfterRestore: () => mydocSession.reload(),
        getSchemaVersion: () => {
            const live = mydocSession.ydoc;
            return live ? readSchemaVersion(live, mydocAppSchema) : null;
        },
    });
</script>
```

The `appType` you pass also flows through to `YjsRuntime.load(docId, roomId, appType)`, where the Yjs server uses it to attribute snapshot diffs to the right app.

### Step 6: Read-only and notice UI

`prepareDocForUse` returns a read-only mode when a doc was written under a newer schema than the client. Two things you have to wire up in your sub-app's UI:

1. **Block writes** when `session.readOnly` is true. Disable toolbars, intercept keyboard input, refuse drag operations — whatever mutation paths your app has. If you skip this, a stale client will happily corrupt the newer-schema doc on first edit.
2. **Surface `session.notices`** as a dismissible banner. These are the "auto-init recovery" and "missed-rotation" warnings. A trivial component:

```svelte
{#each session.notices as n (n.id)}
    <div class="banner {n.severity}">
        {n.message}
        <button onclick={() => session.dismissNotice(n.id)}>×</button>
    </div>
{/each}
```

And a banner for `readOnly`:

```svelte
{#if session.readOnly}
    <div class="banner warn">
        {session.readOnlyReason}
        <button onclick={() => location.reload()}>Reload</button>
    </div>
{/if}
```

---

## When and how to ship a migration

1. Write the migration function. It must:
   - Detect the old shape (`.has()` / `instanceof`).
   - Transform it idempotently.
   - Be tagged with your MIGRATION origin.
2. Add it to your `migrate` function **after** all prior migration steps (the chain runs in order on docs that have never been migrated).
3. Bump `MYDOC_SCHEMA_VERSION` by one.
4. If old clients can no longer participate (their writes would lose newer fields), also bump `minSchemaVersion` in `public/schema-version.json`. Old clients will be force-reloaded on next app open.
5. Test against a snapshot of a real production doc from one version back — and from two versions back, if you've been around that long. Migrations are CRDT operations and can race if you're sloppy.

The lifecycle helper guarantees:
- A doc stamped at the current client version skips the migration chain entirely (fast warm loads).
- A doc stamped at a newer version opens read-only — no chain runs.
- An unstamped doc (pre-stamping era) runs the full chain.

---

## Things to NOT do

- ❌ **Don't write to the doc in a Svelte `$effect` that runs on load before `prepareDocForUse` returns.** Effects fire on the first reactivity tick, which is before server sync confirms structure. Any write at that point can race the server's real data and win via LWW.
- ❌ **Don't catch errors from `prepareDocForUse` and create the structure anyway.** That defeats the entire safety mechanism. If you get "Document is not available offline," show that message — don't paper over it.
- ❌ **Don't store the schema version as a string.** It's an integer for a reason. String comparison breaks once you cross 10.
- ❌ **Don't share an `AppSchema` between two sub-apps.** Each app owns its own `rootKey`. Sharing produces docs that two apps both think they own.
- ❌ **Don't call `runtime.initialize()` directly.** Always go through `storage.drive.createAndInitializeFile()` so the init-verification + rollback paths run.
- ❌ **Don't bypass `prepareDocForUse` to "save time."** The race conditions it guards against took multiple incidents to surface; reimplementing them inline will reintroduce them.

---

## Server-side touchpoints

For most sub-apps you don't touch the server at all. The few places it knows about app types:

- **`appType` URL param** on the WS upgrade — set automatically when you pass `appType` to `HistoryManager` (which flows into `YjsRuntime.load`).
- **`POST /api/snapshots { appType, schemaVersion }`** — also set automatically once `HistoryManager` is wired with `getSchemaVersion`.
- **Snapshot diff computation** in `yjs-server/diff.js` dispatches to per-app diff functions by `appType`. If you want the version-history viewer to show meaningful change summaries for your app, add a diff function here. Without one, the viewer falls back to a generic "X changes" message — the doc still works fine.

The server treats your doc's bytes as opaque Yjs updates. It does not understand your schema and will not block writes based on version mismatch — that protection lives entirely on the client via the version stamp and `prepareDocForUse`.

---

## Migrating an existing sub-app to this contract

The docs sub-app (`src/stores/docs/docStore.svelte.js`) was written before this contract existed. To bring it into compliance:

1. Move structure-initializing writes (the `if (!metaMap.get('createdAt')) …` block) into a dedicated `initializeDocument(ydoc)` function.
2. Define an `AppSchema` (`rootKey: 'document'`, `isStructureValid: (ydoc) => ydoc.getXmlFragment('document').length > 0` — or whatever your shape predicates).
3. Replace the manual `waitForServerSync` + speculative default-setting with one call to `prepareDocForUse`.
4. Pipe `schemaVersion` through `HistoryManager` so manual snapshots are tagged.
5. Bump your `SCHEMA_VERSION` from "1" to "2" (the stamping change *is* a schema change — the first stamped doc moves from "unknown" to "known").

After this, your sub-app gets all the runtime protections (read-only on newer docs, missed-rotation detection, init verification) automatically.

---

## Reference: file map

```
src/lib/FileRegistry/
  yjsDocLifecycle.js     ← AppSchema, prepareDocForUse, readSchemaVersion, stampSchemaVersion
  FileRegistry.js        ← createAndInitializeFile, loadDoc, createSnapshot
  core/YjsRuntime.js     ← load(opts.expectExistingState), onMissedRotation, clearAndSwitchRoom
  offlineMode.js         ← getLastOpenedRoom / recordOpenedRoom / forgetOpenedRoom

src/lib/history/
  HistoryManager.svelte.js ← getSchemaVersion option

src/lib/schemaVersionGuard.js ← boot-time min-version check (forces reload on stale clients)

src/stores/spreadsheet/    ← reference implementation
  schema.js                  ← spreadsheetAppSchema + spreadsheetSchema.migrate
  SpreadsheetSession.svelte.js ← #doLoad calls prepareDocForUse
  constants.js               ← SCHEMA_VERSION, META_KEYS

yjs-server/
  server.js              ← POST /api/snapshots accepts schemaVersion
  db.js                  ← snapshots.schema_version column
  diff.js                ← per-appType diff dispatch
```
