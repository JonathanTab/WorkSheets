/**
 * Client-side diff interpretation layer.
 *
 * The Yjs server computes a generic structural diff (path + counts, no values).
 * Each app registers an interpreter that converts that generic diff into a
 * human-readable summary for the history sidebar.
 *
 * The server diff JSON shape:
 *   { v: 1, entries: Array<{ path: string[], type: 'map'|'array'|'text', ... }>, isInitial?: true }
 *
 * Interpreter output:
 *   { summary: string, changeCount: number }
 */

/** @type {Map<string, (diff: object) => {summary: string, changeCount: number}>} */
const interpreters = new Map();

/**
 * Register an interpreter for a given app type.
 * @param {string} appType  e.g. 'sheets', 'docs', 'svg'
 * @param {(diff: object) => {summary: string, changeCount: number}} fn
 */
export function registerDiffInterpreter(appType, fn) {
    interpreters.set(appType, fn);
}

/**
 * Interpret a server diff JSON for the given app type.
 * Returns a fallback if no interpreter is registered or diff is null.
 * @param {string|null} appType
 * @param {string|null} diffJson  raw JSON string from server
 * @returns {{ summary: string, changeCount: number }}
 */
export function interpretDiff(appType, diffJson) {
    if (!diffJson) return { summary: '—', changeCount: 0 };

    let diff;
    try { diff = JSON.parse(diffJson); } catch { return { summary: '—', changeCount: 0 }; }

    if (diff.isInitial) return { summary: 'Initial version', changeCount: 0 };

    const fn = appType ? interpreters.get(appType) : null;
    if (!fn) return _genericSummary(diff);

    try {
        return fn(diff);
    } catch {
        return _genericSummary(diff);
    }
}

function _genericSummary(diff) {
    if (!diff?.entries?.length) return { summary: 'No changes', changeCount: 0 };
    const total = diff.entries.reduce((sum, e) => {
        return sum + (e.added ?? 0) + (e.removed ?? 0) + (e.modified ?? 0) + Math.abs(e.delta ?? 0);
    }, 0);
    return { summary: `${total} item${total !== 1 ? 's' : ''} changed`, changeCount: total };
}
