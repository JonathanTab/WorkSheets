/**
 * ExternalDocManager
 *
 * Loads and caches external Yjs spreadsheet documents for use in IMPORTRANGE formulas.
 *
 * Usage:
 *   const mgr = new ExternalDocManager(storage, () => formulaEngine.recalculateAll());
 *   const value = mgr.getRange('abc123fileId', 'Sheet1!A1:B10');
 *   // Returns '#LOADING' the first time, triggers async load, then recalculates.
 */

import { parseFormula } from '../../formulas/parser.js';
import { evaluate } from '../../formulas/evaluator.js';
import { FormulaError } from '../../formulas/functions.js';

/** Sentinel returned while a doc is being loaded. */
export const LOADING_VALUE = '#LOADING';

/**
 * Parse a spreadsheet URL or bare file ID into the file ID string.
 * Accepts:
 *   - Full URL containing /d/{id}
 *   - Bare alphanumeric ID
 * @param {string} urlOrId
 * @returns {string|null}
 */
export function parseFileId(urlOrId) {
    if (!urlOrId) return null;
    const s = String(urlOrId).trim();
    // Match .../d/{id}/... or .../d/{id}
    const m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    // Bare ID (no slashes, no spaces)
    if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
    return s;
}

/**
 * Parse a range string like "Sheet1!A1:B10", "'My Sheet'!C3", or "A1:B10".
 * Returns { sheetName, startRow, startCol, endRow, endCol } (all 0-based).
 * @param {string} rangeStr
 * @returns {{sheetName:string|null, startRow:number, startCol:number, endRow:number, endCol:number}|null}
 */
export function parseRangeString(rangeStr) {
    if (!rangeStr) return null;
    let s = String(rangeStr).trim();

    let sheetName = null;
    const bangIdx = s.indexOf('!');
    if (bangIdx !== -1) {
        sheetName = s.slice(0, bangIdx).replace(/^'|'$/g, ''); // strip surrounding quotes
        s = s.slice(bangIdx + 1);
    }

    // Convert column letters (A, B, ..., AA) to 0-based column index
    const colLetterToIndex = (letters) => {
        let n = 0;
        for (const ch of letters.toUpperCase()) {
            n = n * 26 + (ch.charCodeAt(0) - 64);
        }
        return n - 1;
    };

    const m = s.match(/^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/);
    if (!m) return null;

    const startCol = colLetterToIndex(m[1]);
    const startRow = parseInt(m[2]) - 1;
    const endCol = m[3] ? colLetterToIndex(m[3]) : startCol;
    const endRow = m[4] ? parseInt(m[4]) - 1 : startRow;

    return { sheetName, startRow, startCol, endRow, endCol };
}

export class ExternalDocManager {
    /** @type {any} FileRegistry storage instance */
    #storage;

    /** @type {Function} Called when any doc becomes ready so formulas can recalculate */
    #onDocReady;

    /**
     * Cache of loaded docs.
     * @type {Map<string, {status: 'loading'|'ready'|'error', ydoc: any, root: any, error: any}>}
     */
    #cache = new Map();

    /**
     * @param {any} storage - The FileRegistry / storage singleton
     * @param {Function} onDocReady - Called with fileId when a doc finishes loading
     */
    constructor(storage, onDocReady) {
        this.#storage = storage;
        this.#onDocReady = onDocReady;
    }

    /**
     * Get a range from an external spreadsheet.
     * Returns the values as a 2D array if the doc is loaded,
     * '#LOADING' if the load is in progress (and triggers loading),
     * or a FormulaError string on failure.
     *
     * @param {string} fileIdOrUrl
     * @param {string} rangeStr  e.g. "Sheet1!A1:B10"
     * @returns {any[][] | string}
     */
    getRange(fileIdOrUrl, rangeStr) {
        const fileId = parseFileId(fileIdOrUrl);
        if (!fileId) return FormulaError.REF;

        const entry = this.#cache.get(fileId);

        if (!entry) {
            // Kick off async load and return loading sentinel
            this.#loadDoc(fileId);
            return LOADING_VALUE;
        }

        if (entry.status === 'loading') return LOADING_VALUE;
        if (entry.status === 'error') return FormulaError.REF;

        // Doc is ready — read the requested range
        return this.#readRange(entry.root, rangeStr);
    }

    /**
     * True if any doc is currently being loaded.
     * @returns {boolean}
     */
    get isLoading() {
        for (const { status } of this.#cache.values()) {
            if (status === 'loading') return true;
        }
        return false;
    }

    /**
     * Release all cached docs. Does NOT unload them from YjsRuntime (they may
     * be open in other parts of the app).
     */
    destroy() {
        this.#cache.clear();
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    /** @param {string} fileId */
    async #loadDoc(fileId) {
        // Guard against double-loading
        if (this.#cache.has(fileId)) return;
        this.#cache.set(fileId, { status: 'loading', ydoc: null, root: null, error: null });

        try {
            const ydoc = await this.#storage.drive.loadDoc(fileId, { recordOpen: false });
            const root = ydoc.getMap('spreadsheet');
            this.#cache.set(fileId, { status: 'ready', ydoc, root, error: null });
            this.#onDocReady?.(fileId);
        } catch (err) {
            console.warn('[ExternalDocManager] Failed to load doc', fileId, err);
            this.#cache.set(fileId, { status: 'error', ydoc: null, root: null, error: err });
        }
    }

    /**
     * Read a range from an already-loaded doc root.
     * @param {any} root  Y.Map 'spreadsheet'
     * @param {string} rangeStr
     * @returns {any[][] | string}
     */
    #readRange(root, rangeStr) {
        const parsed = parseRangeString(rangeStr);
        if (!parsed) return FormulaError.REF;

        const { sheetName, startRow, startCol, endRow, endCol } = parsed;

        const sheetsMap = root.get('sheets');
        const sheetOrder = root.get('sheetOrder');
        if (!sheetsMap || !sheetOrder) return FormulaError.REF;

        // Locate the target sheet Y.Map
        let targetSheet = null;
        if (sheetName) {
            sheetsMap.forEach((sheet) => {
                if (!targetSheet && sheet.get('name') === sheetName) {
                    targetSheet = sheet;
                }
            });
        } else {
            const firstId = sheetOrder.get(0);
            if (firstId) targetSheet = sheetsMap.get(firstId);
        }

        if (!targetSheet) return FormulaError.REF;

        const cells = targetSheet.get('cells');
        if (!cells) return FormulaError.REF;

        // Build result 2D array
        const result = [];
        for (let r = startRow; r <= endRow; r++) {
            const row = [];
            for (let c = startCol; c <= endCol; c++) {
                row.push(this.#evalCell(cells, r, c, new Set()));
            }
            result.push(row);
        }
        return result;
    }

    /**
     * Recursively evaluate a cell value in an external doc's cells Y.Map.
     * Follows formula chains with cycle detection.
     * @param {any} cells  Y.Map<"row,col", Y.Map>
     * @param {number} r
     * @param {number} c
     * @param {Set<string>} visited
     * @returns {any}
     */
    #evalCell(cells, r, c, visited) {
        const k = `${r},${c}`;
        if (visited.has(k)) return FormulaError.REF; // circular ref guard
        const cm = cells.get(k);
        if (!cm) return null;
        const v = cm.get?.('v');
        if (v === undefined || v === null) return null;

        if (typeof v === 'string' && v.startsWith('=')) {
            const nextVisited = new Set(visited);
            nextVisited.add(k);
            try {
                const ast = parseFormula(v);
                if (!ast) return null;
                return evaluate(
                    ast,
                    (gr, gc) => this.#evalCell(cells, gr, gc, nextVisited),
                    {},
                    null,
                    null
                );
            } catch {
                return FormulaError.ERROR;
            }
        }

        // Coerce numeric strings
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
            return Number(v);
        }
        return v;
    }
}
