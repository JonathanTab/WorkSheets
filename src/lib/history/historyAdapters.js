/**
 * App history adapter registry.
 * Each workspace registers its adapter on mount so the history system
 * knows how to diff and visually render changes for that app type.
 *
 * Adapter shape:
 *   {
 *     diffFn: (docA: Y.Doc, docB: Y.Doc) => DiffResult,
 *     ViewerComponent: SvelteComponent,   // receives { prevDoc, snapDoc, diff }
 *     isContentChange: (update: Uint8Array) => boolean,  // filter noise
 *   }
 */

/** @type {Map<string, object>} */
const adapters = new Map();

/**
 * @param {string} appType  e.g. 'sheets', 'docs', 'svg'
 * @param {{ diffFn: Function, ViewerComponent: any, isContentChange: Function }} adapter
 */
export function registerHistoryAdapter(appType, adapter) {
    adapters.set(appType, adapter);
}

/**
 * @param {string} appType
 * @returns {{ diffFn: Function, ViewerComponent: any, isContentChange: Function } | undefined}
 */
export function getHistoryAdapter(appType) {
    return adapters.get(appType);
}
