import * as Y from 'yjs';
import { computeSheetsDiff, countSheetsDiffChanges } from './diff/sheets.js';
export { computeSheetsDiff, countSheetsDiffChanges };

/**
 * Infer the app type from a Y.Doc's root structure when app_type column is NULL.
 * Checks for known root map keys used by each app.
 * @param {Y.Doc|null} ydoc
 * @returns {string|null}
 */
export function inferAppType(ydoc) {
    if (!ydoc) return null;
    try {
        const ss = ydoc.getMap('spreadsheet');
        if (ss?.size > 0 || ss?.get?.('sheets')) return 'sheets';
    } catch { /* ignore */ }
    return null;
}

const MAX_DEPTH = 4;

/**
 * Determine the concrete shared type class for an AbstractType instance.
 * Based on the guessType pattern from the Yjs inspector (yjs#563 workaround).
 *
 * Internal fields used (stable in Yjs 13.x):
 *   type._map        Map<string, Item>  — YMap key-value store
 *   type._length     number             — item count in linked list
 *   type._first      Item | null        — head of linked list (alias for _start)
 *   item.content     Content            — payload (ContentString / ContentFormat / ContentType / ContentAny)
 *
 * @param {Y.AbstractType} t
 * @returns {typeof Y.Map | typeof Y.Array | typeof Y.Text | null}
 */
function _guessType(t) {
    // 1. Exact constructor match (already upgraded)
    if (t.constructor === Y.Map)   return Y.Map;
    if (t.constructor === Y.Array) return Y.Array;
    if (t.constructor === Y.Text)  return Y.Text;
    // 2. Non-empty internal _map → YMap
    if (t._map && t._map.size > 0) return Y.Map;
    // 3. Non-empty linked list → YArray or YText
    if (t._length > 0) {
        const first = t._first ?? t._start;
        if (first?.content instanceof Y.ContentString ||
            first?.content instanceof Y.ContentFormat) return Y.Text;
        return Y.Array;
    }
    // 4. Empty — cannot distinguish; default to Map (most common root type)
    return Y.Map;
}

/**
 * Force a root-level doc.share entry to its concrete class via the public API.
 * doc.getMap/getArray/getText "upgrades" an AbstractType in-place and returns
 * the correctly-typed instance so public methods (keys(), get(), etc.) work.
 *
 * @param {Y.Doc} doc
 * @param {string} key
 * @returns {Y.Map | Y.Array | Y.Text | null}
 */
function _resolveType(doc, key) {
    const t = doc.share.get(key);
    if (!t) return null;
    try {
        const TypeClass = _guessType(t);
        if (TypeClass === Y.Map)   return doc.getMap(key);
        if (TypeClass === Y.Array) return doc.getArray(key);
        if (TypeClass === Y.Text)  return doc.getText(key);
        return doc.getMap(key); // fallback
    } catch {
        return null;
    }
}

/**
 * Compute a generic structural diff between two Y.Doc instances.
 * Schema-agnostic: sees only Y.Map/Y.Array/Y.Text structure and key/count changes.
 * Client apps interpret the path-based entries into human-readable summaries.
 *
 * @param {Y.Doc} docA  "from" / previous state
 * @param {Y.Doc} docB  "to" / new state
 * @returns {{ v: number, entries: object[] }}
 */
export function computeGenericDiff(docA, docB) {
    const entries = [];

    // After _resolveType, root types are properly cast. Nested types come from
    // Y.Map.get() which returns item.content.type — already a proper Y.Map/Array/Text.
    // instanceof checks work correctly on these; no need for AbstractType fallbacks.

    function isMapLike(t)   { return t instanceof Y.Map; }
    function isArrayLike(t) { return t instanceof Y.Array; }
    function isTextLike(t)  { return t instanceof Y.Text; }

    function diffMap(path, mapA, mapB, depth) {
        // Use the public Y.Map API — types are properly cast at this point.
        const keysA = new Set(mapA.keys());
        const keysB = new Set(mapB.keys());

        let added = 0, removed = 0, modified = 0;

        for (const k of keysB) if (!keysA.has(k)) added++;
        for (const k of keysA) if (!keysB.has(k)) removed++;

        for (const k of keysA) {
            if (!keysB.has(k)) continue;
            const vA = mapA.get(k);
            const vB = mapB.get(k);
            const aIsType = vA instanceof Y.AbstractType;
            const bIsType = vB instanceof Y.AbstractType;

            if (aIsType && bIsType) {
                if (depth < MAX_DEPTH) {
                    diffTypes([...path, k], vA, vB, depth + 1);
                } else {
                    // At max depth: full JSON comparison
                    if (JSON.stringify(vA.toJSON()) !== JSON.stringify(vB.toJSON())) {
                        modified++;
                    }
                }
            } else if (aIsType !== bIsType) {
                modified++;
            } else if (vA !== vB) {
                modified++;
            }
        }

        if (added > 0 || removed > 0 || modified > 0) {
            entries.push({ path, type: 'map', added, removed, modified });
        }
    }

    function diffArray(path, arrA, arrB) {
        const lenA = arrA.length;
        const lenB = arrB.length;
        const delta = lenB - lenA;

        let modified = 0;
        if (delta === 0 && lenA > 0) {
            const checkCount = Math.min(lenA, 50);
            const step = Math.max(1, Math.floor(lenA / checkCount));
            for (let i = 0; i < lenA; i += step) {
                const vA = arrA.get(i);
                const vB = arrB.get(i);
                if (vA instanceof Y.AbstractType && vB instanceof Y.AbstractType) {
                    if (JSON.stringify(vA.toJSON()) !== JSON.stringify(vB.toJSON())) modified++;
                } else if (vA !== vB) {
                    modified++;
                }
            }
        }

        if (delta !== 0 || modified > 0) {
            entries.push({ path, type: 'array', from: lenA, to: lenB, delta, modified });
        }
    }

    function diffText(path, textA, textB) {
        const strA = textA.toString();
        const strB = textB.toString();
        if (strA === strB) return;
        entries.push({
            path, type: 'text',
            inserted: Math.max(0, strB.length - strA.length),
            deleted:  Math.max(0, strA.length - strB.length),
        });
    }

    function diffTypes(path, typeA, typeB, depth) {
        if (isMapLike(typeA) && isMapLike(typeB)) {
            diffMap(path, typeA, typeB, depth);
        } else if (isArrayLike(typeA) && isArrayLike(typeB)) {
            diffArray(path, typeA, typeB);
        } else if (isTextLike(typeA) && isTextLike(typeB)) {
            diffText(path, typeA, typeB);
        }
        // Mismatched types silently skipped
    }

    // Enumerate all top-level shared types. doc.share entries are AbstractType
    // until accessed via getMap/getArray/getText — _resolveType does that upgrade.
    const allKeys = new Set([...docA.share.keys(), ...docB.share.keys()]);

    for (const key of allKeys) {
        if (key.startsWith('_')) continue;

        const typeA = _resolveType(docA, key);
        const typeB = _resolveType(docB, key);

        if (!typeA || !typeB) {
            const type = typeA ?? typeB;
            if (!type) continue;
            const typeLabel = type instanceof Y.Map ? 'map' : type instanceof Y.Array ? 'array' : 'text';
            entries.push({ path: [key], type: typeLabel, added: typeB ? 1 : 0, removed: typeA ? 1 : 0, modified: 0 });
            continue;
        }

        diffTypes([key], typeA, typeB, 1);
    }

    return { v: 1, entries };
}

/**
 * Dispatch to the correct app-specific diff function.
 * When appType is null/unknown, infers from the Y.Doc structure.
 * Returns v2 JSON for 'sheets', v1 JSON for everything else.
 * @param {string|null} appType  explicit type from DB column (may be null for legacy rows)
 * @param {Y.Doc} prevDoc
 * @param {Y.Doc} newDoc
 * @returns {{ diff: object, resolvedAppType: string|null }}
 */
export function computeAppDiff(appType, prevDoc, newDoc) {
    const resolved = appType ?? inferAppType(newDoc) ?? inferAppType(prevDoc);
    if (resolved === 'sheets') return { diff: computeSheetsDiff(prevDoc, newDoc), resolvedAppType: 'sheets' };
    return { diff: computeGenericDiff(prevDoc, newDoc), resolvedAppType: resolved };
}

/**
 * Count meaningful changes in any diff object (v1 or v2).
 * @param {object|null} diff  the parsed diff object (not the wrapper returned by computeAppDiff)
 * @returns {number}
 */
export function countDiffChanges(diff) {
    if (!diff) return 0;
    if (diff.v === 2) return countSheetsDiffChanges(diff);
    // v1 generic — delta-based count would inflate the number; return entries count instead
    if (!diff.entries?.length) return 0;
    return diff.entries.reduce((sum, e) => sum + (e.added ?? 0) + (e.removed ?? 0) + (e.modified ?? 0), 0);
}
