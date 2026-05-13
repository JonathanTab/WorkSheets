import * as Y from 'yjs';

const MAX_DEPTH = 4;

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

    function diffMap(path, mapA, mapB, depth) {
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
                modified++; // type changed (shouldn't happen in practice)
            } else if (vA !== vB) {
                modified++;
            }
        }

        if (added > 0 || removed > 0 || modified > 0) {
            entries.push({ path, type: 'map', added, removed, modified });
        }
    }

    function diffArray(path, arrA, arrB, depth) {
        const lenA = arrA.length;
        const lenB = arrB.length;
        const delta = lenB - lenA;

        // Check for modifications within same-length arrays by sampling elements
        let modified = 0;
        if (delta === 0 && lenA > 0) {
            const checkCount = Math.min(lenA, 50);
            const step = Math.max(1, Math.floor(lenA / checkCount));
            for (let i = 0; i < lenA; i += step) {
                const vA = arrA.get(i);
                const vB = arrB.get(i);
                if (vA instanceof Y.AbstractType && vB instanceof Y.AbstractType) {
                    if (JSON.stringify(vA.toJSON()) !== JSON.stringify(vB.toJSON())) {
                        modified++;
                    }
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
        const inserted = Math.max(0, strB.length - strA.length);
        const deleted = Math.max(0, strA.length - strB.length);
        entries.push({ path, type: 'text', inserted, deleted });
    }

    function diffTypes(path, typeA, typeB, depth) {
        if (typeA instanceof Y.Map && typeB instanceof Y.Map) {
            diffMap(path, typeA, typeB, depth);
        } else if (typeA instanceof Y.Array && typeB instanceof Y.Array) {
            diffArray(path, typeA, typeB, depth);
        } else if (typeA instanceof Y.Text && typeB instanceof Y.Text) {
            diffText(path, typeA, typeB);
        }
        // Mismatched types (Map vs Array etc.) are silently skipped
    }

    // Enumerate all top-level shared types from both docs
    const allKeys = new Set([...docA.share.keys(), ...docB.share.keys()]);

    for (const key of allKeys) {
        // Skip internal Yjs metadata keys
        if (key.startsWith('_')) continue;

        const typeA = docA.share.get(key);
        const typeB = docB.share.get(key);

        if (!typeA || !typeB) {
            // Type only in one doc
            const type = (typeA ?? typeB);
            const typeLabel = type instanceof Y.Map ? 'map' : type instanceof Y.Array ? 'array' : 'text';
            entries.push({
                path: [key],
                type: typeLabel,
                added: typeB ? 1 : 0,
                removed: typeA ? 1 : 0,
                modified: 0,
            });
            continue;
        }

        diffTypes([key], typeA, typeB, 1);
    }

    return { v: 1, entries };
}
