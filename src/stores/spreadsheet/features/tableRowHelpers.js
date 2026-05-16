/**
 * tableRowHelpers.js - Shared row-ordering utilities for table operations.
 *
 * Used by both TableStore (browser) and operations.js (CLI/server).
 * Must remain free of browser APIs, Svelte, and Node-only modules.
 */

/** @param {any} a @param {any} b */
export function cmpValues(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
}

/**
 * Ensure all rows in rowArr have a _pos field, assigning one based on current Y.Array order.
 * rawIndex 0 = oldest = display bottom → lowest _pos; last index = newest = display top.
 * Must be called inside a Yjs transaction.
 * @param {import('yjs').Array<any>} rowArr
 */
export function initPos(rowArr) {
    const n = rowArr.length;
    for (let i = 0; i < n; i++) {
        const r = rowArr.get(i);
        if (r && r.get('_pos') == null) r.set('_pos', (i + 1) * 1000);
    }
}

/**
 * Compute a _pos for inserting a row at the correct insertSort position.
 * Reads _pos and colId values directly from rowArr (safe within a Yjs transaction).
 * Null/empty values always sort to the top regardless of direction.
 * @param {import('yjs').Array<any>} rowArr
 * @param {string} colId
 * @param {'asc'|'desc'} dir
 * @param {any} newVal
 * @param {number} [excludeRawIndex]  Raw index of a row to skip (for repositioning an existing row).
 * @returns {number}
 */
export function computeInsertPos(rowArr, colId, dir, newVal, excludeRawIndex = -1) {
    const dirMult = dir === 'asc' ? -1 : 1;
    const sorted = [];
    for (let i = 0; i < rowArr.length; i++) {
        if (i === excludeRawIndex) continue;
        const r = rowArr.get(i);
        sorted.push({ val: r?.get?.(colId), pos: r?.get?.('_pos') ?? 0 });
    }
    sorted.sort((a, b) => b.pos - a.pos);
    if (!sorted.length) return 1000;
    if (newVal == null || newVal === '') return sorted[0].pos + 1000;
    for (let i = 0; i < sorted.length; i++) {
        if (dirMult * cmpValues(sorted[i].val, newVal) <= 0) {
            const abovePos = i > 0 ? sorted[i - 1].pos : null;
            return abovePos == null ? sorted[i].pos + 1000 : (abovePos + sorted[i].pos) / 2;
        }
    }
    return Math.max(0, sorted[sorted.length - 1].pos - 1000);
}
