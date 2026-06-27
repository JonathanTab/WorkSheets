/**
 * StylePalette — content-addressed dedupe store for cell styles.
 *
 * Cell-style objects are highly repetitive: a column of currency cells, a header
 * row of bold+centered cells, etc. all carry byte-for-byte identical style
 * objects. Storing them inline in `cellStyles` duplicates that payload once per
 * cell. The palette stores each DISTINCT style object once, keyed by a hash of
 * its canonical JSON, and cells reference it as `{ s: <sid> }`.
 *
 * ## Why content-addressed (hash) ids?
 * Two clients that independently format cells the same way compute the SAME sid
 * and write the SAME value to `palette[sid]` — a no-op LWW merge. So the palette
 * converges without any coordination, which is what makes it safe for
 * offline-first editing: an offline client's `{ s: sid }` cell refs and its
 * `palette[sid]` entry both merge cleanly on reconnect.
 *
 * ## Offline safety / no GC
 * Palette entries are NEVER deleted at runtime. If we GC'd an entry that looked
 * unreferenced, an offline client holding a cell that points at it would resolve
 * to `null` (lost formatting) after merging. Orphans are tiny and bounded by the
 * number of distinct styles, so we simply keep them. The one-time offline
 * compaction (run with all clients disconnected) is the only place that prunes.
 *
 * Entries are immutable: a given sid's value never changes (a different style is
 * a different sid). That means a cell's resolved style only changes when its own
 * `{ s }` ref changes — callers don't need to observe the palette for rendering.
 */

const STYLE_REF_KEY = 's';

/**
 * Stable, recursive JSON with sorted keys so two equal styles serialise
 * identically regardless of insertion order.
 * @param {*} obj
 * @returns {string}
 */
export function canonicalize(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj) ?? 'null';
    if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/**
 * ~53-bit hash of a canonical string → base36. Two independent 32-bit FNV-1a
 * variants concatenated; collisions across the few hundred distinct styles a
 * document has are astronomically unlikely, and `intern` additionally probes on
 * collision so even a clash can never corrupt.
 * @param {string} canon
 * @returns {string}
 */
export function hashStyle(canon) {
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
    for (let i = 0; i < canon.length; i++) {
        const c = canon.charCodeAt(i);
        h1 = Math.imul((h1 ^ c) >>> 0, 0x01000193) >>> 0;
        h2 = Math.imul((h2 ^ c) >>> 0, 0x85ebca6b) >>> 0;
    }
    return h1.toString(36) + h2.toString(36);
}

/** True when a cellStyles entry is a palette reference rather than an inline style. */
export function isStyleRef(entry) {
    return !!entry && typeof entry === 'object'
        && (STYLE_REF_KEY in entry) && Object.keys(entry).length === 1;
}

export class StylePalette {
    /**
     * @param {import('y-utility/y-keyvalue').YKeyValue} kv  YKeyValue over the doc-level stylePalette Y.Array
     */
    constructor(kv) {
        this.kv = kv;
        /** @type {Map<string, string>} canonical JSON → sid */
        this.byCanon = new Map();
        /** @type {Map<string, string>} sid → canonical JSON (for collision probing) */
        this.sidToCanon = new Map();
        this._rebuild();
        // Remote peers may add entries; keep the reverse index fresh so local
        // interning reuses their sids (maximising dedupe / convergence).
        this._onChange = () => this._rebuild();
        this.kv.on('change', this._onChange);
    }

    _rebuild() {
        this.byCanon.clear();
        this.sidToCanon.clear();
        for (const [sid, { val }] of this.kv.map) {
            const canon = canonicalize(val);
            this.byCanon.set(canon, sid);
            this.sidToCanon.set(sid, canon);
        }
    }

    /**
     * Intern a plain style object, returning its sid. Returns null for an empty
     * or non-object style (caller should delete the cell's style entry instead).
     * Must be called inside a Yjs transaction (it may write a new palette entry).
     * @param {object|null} style
     * @returns {string|null}
     */
    intern(style) {
        if (!style || typeof style !== 'object' || Object.keys(style).length === 0) return null;
        const canon = canonicalize(style);
        const existing = this.byCanon.get(canon);
        if (existing) return existing;
        // New style — find a free sid (probe on the vanishingly rare hash clash).
        let sid = hashStyle(canon);
        let n = 0;
        while (this.sidToCanon.has(sid) && this.sidToCanon.get(sid) !== canon) {
            sid = hashStyle(canon) + '~' + (++n);
        }
        if (!this.sidToCanon.has(sid)) {
            this.kv.set(sid, style);
            this.sidToCanon.set(sid, canon);
            this.byCanon.set(canon, sid);
        }
        return sid;
    }

    /**
     * Resolve a cellStyles entry to its plain style object.
     *   - { s: sid }       → the palette entry (or null if dangling)
     *   - inline style obj → itself (legacy / un-migrated doc)
     *   - null/undefined   → null
     * @param {object|null|undefined} entry
     * @returns {object|null}
     */
    resolve(entry) {
        if (!entry || typeof entry !== 'object') return entry ?? null;
        if (isStyleRef(entry)) return this.kv.get(entry[STYLE_REF_KEY]) ?? null;
        return entry;
    }

    destroy() {
        this.kv.off('change', this._onChange);
    }
}

export { STYLE_REF_KEY };
