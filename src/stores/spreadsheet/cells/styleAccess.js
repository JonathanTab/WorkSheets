/**
 * styleAccess.js — Shared read/write path for interned cell styles (schema v9).
 *
 * Since v9, `cellStyles` entries are `{ s: <sid> }` references into the
 * doc-level content-addressed palette at `root.stylePalette` (see StylePalette.js).
 * Reading a cell's style therefore means resolving that ref, and writing one
 * means interning the style object first.
 *
 * Every consumer must go through here. Writing an inline style object straight
 * into `cellStyles` still *renders* (StylePalette.resolve tolerates legacy
 * inline entries) but bypasses dedupe, so it re-duplicates the payload the
 * palette exists to collapse — which is how the Node API silently bloated docs
 * before this module existed.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules — so SheetStore
 * (browser), the REST API and the MCP server share one implementation.
 */

import * as Y from 'yjs';
import { YKeyValue } from 'y-utility/y-keyvalue';
import { StylePalette } from './StylePalette.js';
import { normalizeStyleForStorage } from './styleNormalize.js';
import { YJS_ORIGIN } from '../yjsOrigins.js';

/**
 * Per-doc palette cache for callers that don't manage a lifecycle of their own
 * (the API server, batch ops). Keyed weakly so docs can still be GC'd.
 * @type {WeakMap<Y.Doc, StylePalette>}
 */
const sharedPalettes = new WeakMap();

/**
 * Ensure `root.stylePalette` exists and return the backing Y.Array.
 *
 * Normally the v9 migration creates it before anything reads the doc; this
 * lazy-create is the safety net for fresh docs and tests.
 * @param {Y.Doc} ydoc
 * @returns {Y.Array<any>}
 */
export function ensureStylePaletteArray(ydoc) {
    const root = ydoc.getMap('spreadsheet');
    let palArr = root.get('stylePalette');
    if (!(palArr instanceof Y.Array)) {
        ydoc.transact(() => {
            palArr = new Y.Array();
            root.set('stylePalette', palArr);
        }, YJS_ORIGIN.MIGRATION);
    }
    return /** @type {Y.Array<any>} */ (palArr);
}

/**
 * Create a NEW palette instance bound to the doc.
 *
 * The instance subscribes to palette changes, so the caller owns its lifecycle
 * and must call `.destroy()` when done. Use this when you have a natural
 * teardown point (SheetStore.unload); otherwise prefer getStylePalette().
 * @param {Y.Doc} ydoc
 * @returns {StylePalette}
 */
export function attachStylePalette(ydoc) {
    return new StylePalette(new YKeyValue(ensureStylePaletteArray(ydoc)));
}

/**
 * Get a shared, per-doc palette instance, creating it on first use.
 *
 * Never destroyed — intended for long-lived server processes where docs are
 * opened and closed but a single palette per doc is correct and cheap.
 * @param {Y.Doc} ydoc
 * @returns {StylePalette}
 */
export function getStylePalette(ydoc) {
    let p = sharedPalettes.get(ydoc);
    if (!p) {
        p = attachStylePalette(ydoc);
        sharedPalettes.set(ydoc, p);
    }
    return p;
}

/**
 * Resolve a cell's stored style entry to a plain style object.
 *
 * Handles both `{ s: sid }` refs (v9+) and legacy inline styles on
 * un-migrated docs. Returns null when the cell has no style.
 * @param {StylePalette} palette
 * @param {YKeyValue|null} stylesKV
 * @param {string} key  "row,col"
 * @returns {object|null}
 */
export function readCellStyle(palette, stylesKV, key) {
    if (!stylesKV) return null;
    return palette.resolve(stylesKV.get(key));
}

/**
 * Intern a style object and store the cell's `{ s }` ref.
 *
 * Deletes the entry entirely for an empty style, and skips the write when the
 * resulting sid is unchanged so re-applying identical formatting doesn't churn
 * the CRDT (every redundant set is a permanent tombstone).
 *
 * Must be called inside a Yjs transaction.
 * @param {StylePalette} palette
 * @param {YKeyValue|null} stylesKV
 * @param {string} key  "row,col"
 * @param {object|null} style  Complete style object (not a patch)
 */
export function writeCellStyle(palette, stylesKV, key, style) {
    if (!stylesKV) return;
    // Normalise before interning: the palette is content-addressed, so an
    // un-stripped `{bold:false}` would mint a different sid than the client's
    // `{}` for the same appearance.
    const normalized = normalizeStyleForStorage(style);
    if (Object.keys(normalized).length === 0) {
        if (stylesKV.has(key)) stylesKV.delete(key);
        return;
    }
    const sid = palette.intern(normalized);
    const cur = stylesKV.get(key);
    if (cur && cur.s === sid) return;
    stylesKV.set(key, { s: sid });
}

/**
 * Merge a patch into a cell's existing style and write the result.
 *
 * Keys whose patch value is null/undefined are REMOVED from the style, which is
 * how callers clear a single property (e.g. `{ bold: null }` un-bolds without
 * disturbing the rest of the cell's formatting).
 *
 * Must be called inside a Yjs transaction.
 * @param {StylePalette} palette
 * @param {YKeyValue|null} stylesKV
 * @param {string} key  "row,col"
 * @param {object} patch
 * @returns {object|null} The resulting style object, or null if now empty
 */
export function mergeCellStyle(palette, stylesKV, key, patch) {
    if (!stylesKV) return null;
    const current = readCellStyle(palette, stylesKV, key) ?? {};
    const next = { ...current };
    for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete next[k];
        else next[k] = v;
    }
    const result = Object.keys(next).length > 0 ? next : null;
    writeCellStyle(palette, stylesKV, key, result);
    return result;
}
