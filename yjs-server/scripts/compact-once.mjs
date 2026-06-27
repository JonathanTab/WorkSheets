/**
 * compact-once.mjs — ONE-TIME, offline-breaking CRDT compaction.
 *
 * Rebuilds each room's Y.Doc from its ALIVE content into a fresh doc, dropping
 * accumulated tombstones (historical churn — e.g. filters/printSettings/borders
 * re-written thousands of times) and collapsing the hundreds of stale clientIDs
 * a long-lived doc accrues. On the worst real docs this is ~45k structs / 94%
 * tombstones → a few thousand live structs, which is the actual load-CPU /
 * memory win (decode time scales with struct count).
 *
 * ⚠️  This is NOT offline-safe. A fresh doc has new struct identity, so any
 *     client that was offline before the compaction can no longer merge its
 *     edits — same hazard as a snapshot-restore room rotation. Only run it as a
 *     deliberate, one-shot alpha maintenance step with clients disconnected.
 *
 * Safety design:
 *   - DRY-RUN by default. Pass --apply to write anything.
 *   - NEVER overwrites the source leveldb. Writes compacted docs to a NEW dir.
 *   - Per-room verification: the rebuilt doc's toJSON() must deeply equal the
 *     source's, or the room is PASSED THROUGH unchanged (original update copied).
 *   - Rooms containing Y.Text / Y.Xml are passed through unchanged (their
 *     formatting isn't fully captured by toJSON, so we can't prove a faithful
 *     clone — and the measured bloat is in sheets, which use neither).
 *
 * Usage (run with the yjs-server STOPPED so leveldb isn't locked):
 *   node scripts/compact-once.mjs --src <leveldbDir> --out <newLeveldbDir> [--apply]
 *   node scripts/compact-once.mjs --selftest
 *
 * After a successful --apply run, the operator backs up the old dir and swaps
 * the new one into place, then restarts the server.
 */
import * as Y from 'yjs';

// ── Generic, type-faithful deep clone of a Y.Doc's alive content ──────────────

/**
 * Determine a root share entry's concrete type (entries are AbstractType until
 * accessed). Mirrors the guessType workaround used in diff.js.
 */
function guessType(t) {
    if (t.constructor === Y.Map)   return 'map';
    if (t.constructor === Y.Array) return 'array';
    if (t.constructor === Y.Text)  return 'text';
    if (t._map && t._map.size > 0) return 'map';
    if (t._length > 0) {
        const first = t._first ?? t._start;
        if (first?.content instanceof Y.ContentString ||
            first?.content instanceof Y.ContentFormat) return 'text';
        return 'array';
    }
    return 'map';
}

/** Tracks whether the walk encountered any rich-text type we can't verify. */
class CloneState { constructor() { this.richText = false; } }

/**
 * Place a source value under a parent via `setter`, recreating Y types as fresh
 * instances (attach-then-fill, top-down, so nothing relies on prelim content).
 * @param {(v:any)=>void} setter  attaches the produced value into its parent
 * @param {any} src
 * @param {CloneState} st
 */
function place(setter, src, st) {
    if (src instanceof Y.Text || src instanceof Y.XmlText ||
        src instanceof Y.XmlElement || src instanceof Y.XmlFragment ||
        src instanceof Y.XmlHook) {
        st.richText = true;            // flag — caller will pass this room through
        placeXml(setter, src, st);
        return;
    }
    if (src instanceof Y.Map) {
        const m = new Y.Map(); setter(m);
        for (const [k, v] of src) place((t) => m.set(k, t), v, st);
        return;
    }
    if (src instanceof Y.Array) {
        const a = new Y.Array(); setter(a);
        fillArray(a, src, st);
        return;
    }
    // primitive or plain object (ContentAny) — copied as-is
    setter(src);
}

/** Fill a fresh Y.Array from src, batching runs of primitives into one push(). */
function fillArray(a, src, st) {
    let buf = [];
    const flush = () => { if (buf.length) { a.push(buf); buf = []; } };
    for (const v of src) {
        const isYType = v instanceof Y.AbstractType;
        if (isYType) {
            flush();
            place((t) => a.push([t]), v, st);
        } else {
            buf.push(v);
        }
    }
    flush();
}

function placeXml(setter, src, st) {
    if (src instanceof Y.XmlText) {
        const t = new Y.XmlText(); setter(t);
        const d = src.toDelta(); if (d.length) t.applyDelta(d);
    } else if (src instanceof Y.XmlElement) {
        const e = new Y.XmlElement(src.nodeName); setter(e);
        const attrs = src.getAttributes();
        for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
        for (const child of src.toArray()) placeXml((t) => e.push([t]), child, st);
    } else if (src instanceof Y.XmlFragment) {
        const f = new Y.XmlFragment(); setter(f);
        for (const child of src.toArray()) placeXml((t) => f.push([t]), child, st);
    } else if (src instanceof Y.XmlHook) {
        const h = new Y.XmlHook(src.hookName); setter(h);
        for (const [k, v] of src) place((t) => h.set(k, t), v, st);
    } else {
        setter(src);
    }
}

/**
 * Rebuild srcDoc's alive content into a fresh Y.Doc.
 * @param {Y.Doc} srcDoc
 * @returns {{ dstDoc: Y.Doc, richText: boolean }}
 */
export function cloneAliveContent(srcDoc) {
    const dstDoc = new Y.Doc();
    const st = new CloneState();
    dstDoc.transact(() => {
        for (const key of srcDoc.share.keys()) {
            const kind = guessType(srcDoc.share.get(key));
            if (kind === 'map') {
                const src = srcDoc.getMap(key);
                const dst = dstDoc.getMap(key);
                for (const [k, v] of src) place((t) => dst.set(k, t), v, st);
            } else if (kind === 'array') {
                fillArray(dstDoc.getArray(key), srcDoc.getArray(key), st);
            } else { // text
                st.richText = true;
                const src = srcDoc.getText(key);
                const dst = dstDoc.getText(key);
                const d = src.toDelta(); if (d.length) dst.applyDelta(d);
            }
        }
    });
    return { dstDoc, richText: st.richText };
}

// ── Per-room compaction with verification ─────────────────────────────────────

function structStats(doc) {
    let structs = 0, deleted = 0;
    for (const [, arr] of doc.store.clients) {
        structs += arr.length;
        for (const s of arr) if (s.deleted) deleted++;
    }
    return { structs, deleted, actors: doc.store.clients.size };
}

/**
 * Decide how to compact one source update.
 * @param {Uint8Array} srcUpdate  encodeStateAsUpdate of the source room
 * @returns {{ action:'compact'|'passthrough', reason:string, before, after, update:Uint8Array }}
 */
export function compactUpdate(srcUpdate) {
    const srcDoc = new Y.Doc();
    Y.applyUpdate(srcDoc, srcUpdate);
    const before = structStats(srcDoc);

    const { dstDoc, richText } = cloneAliveContent(srcDoc);

    let action = 'compact', reason = 'ok';
    if (richText) {
        action = 'passthrough';
        reason = 'contains Y.Text/Y.Xml (toJSON not fully faithful)';
    } else if (JSON.stringify(srcDoc.toJSON()) !== JSON.stringify(dstDoc.toJSON())) {
        action = 'passthrough';
        reason = 'toJSON mismatch after clone';
    }

    const after = structStats(dstDoc);
    const update = action === 'compact' ? Y.encodeStateAsUpdate(dstDoc) : srcUpdate;
    srcDoc.destroy(); dstDoc.destroy();
    return { action, reason, before, after, update };
}

// ── Self-test (no leveldb needed) ─────────────────────────────────────────────

function selftest() {
    let pass = 0, fail = 0;
    const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

    // Build a base sheet doc, then generate REALISTIC churn: two clients (A, B)
    // alternately rewrite a filters entry with sync in between. Cross-client,
    // interspersed deletes don't merge (unlike a single client's), so this
    // accumulates genuine tombstones — mirroring the real server docs.
    const A = new Y.Doc();
    const root = A.getMap('spreadsheet');
    A.transact(() => {
        root.set('sheets', new Y.Map());
        const sheet = new Y.Map();
        root.get('sheets').set('s1', sheet);
        sheet.set('cellValues', new Y.Array());
        sheet.get('cellValues').push([{ key: '0,0', val: { v: 'hello' } }]);
        root.set('tableData', new Y.Map());
        const tbl = new Y.Map();
        root.get('tableData').set('t1', tbl);
        tbl.set('filters', new Y.Map());
        tbl.set('rows', new Y.Array());
        tbl.get('rows').push([(() => { const r = new Y.Map(); r.set('c0', 'x'); return r; })()]);
    });
    const B = new Y.Doc();
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
    const filtersOf = (d) => d.getMap('spreadsheet').get('tableData').get('t1').get('filters');
    for (let i = 0; i < 60; i++) {
        A.transact(() => filtersOf(A).set('c0', [i]));
        Y.applyUpdate(B, Y.encodeStateAsUpdate(A, Y.encodeStateVector(B)));
        B.transact(() => filtersOf(B).set('c0', [i + 1000]));
        Y.applyUpdate(A, Y.encodeStateAsUpdate(B, Y.encodeStateVector(A)));
    }

    const update = Y.encodeStateAsUpdate(A);
    const res = compactUpdate(update);

    ok(res.action === 'compact', `churned sheet compacts (action=${res.action}, reason=${res.reason})`);
    ok(res.before.deleted > 50, `source accumulated churn tombstones (${res.before.deleted})`);
    ok(res.before.actors === 2, `source has 2 actors (${res.before.actors})`);
    ok(res.after.deleted === 0, `compacted doc has no tombstones (${res.after.deleted})`);
    ok(res.after.actors === 1, `compacted doc collapsed to 1 actor (${res.after.actors})`);
    ok(res.after.structs < res.before.structs, `struct count dropped ${res.before.structs}→${res.after.structs}`);

    // faithfulness: content from the compacted update must equal content from the
    // source update (both reloaded from updates → consistent key ordering).
    const srcReload = new Y.Doc(); Y.applyUpdate(srcReload, update);
    const round = new Y.Doc(); Y.applyUpdate(round, res.update);
    ok(JSON.stringify(round.toJSON()) === JSON.stringify(srcReload.toJSON()),
        'compacted content equals source content');

    // rich-text doc is passed through untouched
    const rt = new Y.Doc();
    const frag = rt.getXmlFragment('prosemirror');
    rt.transact(() => { const p = new Y.XmlElement('paragraph'); frag.push([p]); const t = new Y.XmlText(); t.insert(0, 'hi'); p.push([t]); });
    const rtRes = compactUpdate(Y.encodeStateAsUpdate(rt));
    ok(rtRes.action === 'passthrough', `rich-text doc passed through (reason=${rtRes.reason})`);

    console.log(`\ncompact-once selftest: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

// ── Main (leveldb IO) ─────────────────────────────────────────────────────────

function arg(name, def = null) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? (process.argv[i + 1] ?? true) : def;
}

async function main() {
    if (process.argv.includes('--selftest')) return selftest();

    const srcDir = arg('--src');
    const outDir = arg('--out');
    const apply  = process.argv.includes('--apply');
    if (!srcDir) { console.error('Missing --src <leveldbDir>'); process.exit(2); }
    if (apply && !outDir) { console.error('--apply requires --out <newLeveldbDir>'); process.exit(2); }

    const { LeveldbPersistence } = await import('y-leveldb');
    const srcP = new LeveldbPersistence(srcDir);
    const outP = apply ? new LeveldbPersistence(outDir) : null;

    const names = await srcP.getAllDocNames();
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'} — ${names.length} rooms in ${srcDir}\n`);

    let totBefore = 0, totAfter = 0, compacted = 0, passed = 0;
    for (const room of names) {
        const srcDoc = await srcP.getYDoc(room);
        const update = Y.encodeStateAsUpdate(srcDoc);
        srcDoc.destroy();
        const res = compactUpdate(update);
        totBefore += res.before.structs;
        totAfter  += res.action === 'compact' ? res.after.structs : res.before.structs;
        if (res.action === 'compact') {
            compacted++;
            const pct = res.before.structs ? Math.round(100 * (1 - res.after.structs / res.before.structs)) : 0;
            console.log(`  compact  ${room.slice(0, 30).padEnd(31)} ${res.before.structs}→${res.after.structs} structs (-${pct}%), actors ${res.before.actors}→${res.after.actors}`);
        } else {
            passed++;
            console.log(`  pass     ${room.slice(0, 30).padEnd(31)} ${res.reason}`);
        }
        if (apply) await outP.storeUpdate(room, res.update);
    }

    console.log(`\nTotals: ${compacted} compacted, ${passed} passed through.`);
    console.log(`Structs ${totBefore} → ${totAfter} (-${totBefore ? Math.round(100 * (1 - totAfter / totBefore)) : 0}%)`);
    if (apply) console.log(`\nWrote compacted store to ${outDir}. Back up the old dir and swap it in, then restart the server.`);
    else console.log(`\nDry run only — re-run with --out <dir> --apply to write.`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
