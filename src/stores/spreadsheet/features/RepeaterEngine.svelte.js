/**
 * RepeaterEngine - Manages all inline repeaters for a sheet
 *
 * A repeater is a group of template cells (templateStartRow..templateEndRow ×
 * templateStartCol..templateEndCol) that is repeated N times either vertically
 * or horizontally. Each repetition evaluates all template formulas with
 * $rep = 0, 1, 2, … so that formulas can produce per-repetition values.
 *
 * ## Storage in Yjs
 *   sheet.get('repeaters') → Y.Map<repeaterId, Y.Map>
 *   Each repeater Y.Map:
 *     id, name, templateStartRow, templateEndRow, templateStartCol, templateEndCol,
 *     direction ('vertical'|'horizontal'), count (number), gap (number)
 *
 * ## Inline position arithmetic (vertical direction, gap=0):
 *   repIndex = floor((row - templateStartRow) / templateRows)
 *   localRow  = (row - templateStartRow) % templateRows
 *   Physical row → template row = templateStartRow + localRow
 *
 * ## $rep is 0-based
 *   Rep 0 uses the actual template cells (no re-evaluation needed).
 *   Reps 1…N re-evaluate template formulas with context { rep: repIndex }.
 */

import * as Y from "yjs";

// ─── RepeaterStore ────────────────────────────────────────────────────────────

export class RepeaterStore {
    /** @type {import('yjs').Map} */
    #repYMap;
    /** @type {import('yjs').Doc} */
    #ydoc;
    /** @type {Function | null} */
    #onChanged;
    /** @type {Function[]} */
    #observers = [];

    // ── Identity ──────────────────────────────────────────────────────────────
    id = $state("");
    name = $state("Repeater");

    // ── Template bounds ───────────────────────────────────────────────────────
    templateStartRow = $state(0);
    templateEndRow = $state(0);
    templateStartCol = $state(0);
    templateEndCol = $state(0);

    // ── Repeat config ─────────────────────────────────────────────────────────
    direction = $state("vertical"); // 'vertical' | 'horizontal'
    count = $state(1); // total reps (0-based, so count=3 → $rep 0,1,2)
    gap = $state(0); // empty rows (vertical) or cols (horizontal) between reps

    // ── Derived geometry ──────────────────────────────────────────────────────
    get templateRows() {
        return this.templateEndRow - this.templateStartRow + 1;
    }
    get templateCols() {
        return this.templateEndCol - this.templateStartCol + 1;
    }

    /** Number of sheet rows the inline repeater occupies (vertical direction) */
    get inlineExtentRows() {
        if (this.direction !== "vertical") return this.templateRows;
        return this.count * this.templateRows + Math.max(0, this.count - 1) * this.gap;
    }

    /** Number of sheet cols the inline repeater occupies (horizontal direction) */
    get inlineExtentCols() {
        if (this.direction !== "horizontal") return this.templateCols;
        return this.count * this.templateCols + Math.max(0, this.count - 1) * this.gap;
    }

    /** Last sheet row the inline repeater reaches */
    get inlineEndRow() {
        return this.templateStartRow + this.inlineExtentRows - 1;
    }

    /** Last sheet col the inline repeater reaches */
    get inlineEndCol() {
        return this.templateStartCol + this.inlineExtentCols - 1;
    }

    /**
     * @param {import('yjs').Map} repYMap
     * @param {import('yjs').Doc} ydoc
     * @param {Function | null} [onChanged] Called when any config changes (used by RepeaterEngine to bump version)
     */
    constructor(repYMap, ydoc, onChanged = null) {
        this.#repYMap = repYMap;
        this.#ydoc = ydoc;
        this.#onChanged = onChanged;
        this.#syncFromYjs();
        this.#observeYjs();
    }

    // ─── Yjs sync ─────────────────────────────────────────────────────────────

    #syncFromYjs() {
        const m = this.#repYMap;
        this.id = m.get("id") ?? "";
        this.name = m.get("name") ?? "Repeater";
        this.templateStartRow = m.get("templateStartRow") ?? 0;
        this.templateEndRow = m.get("templateEndRow") ?? 0;
        this.templateStartCol = m.get("templateStartCol") ?? 0;
        this.templateEndCol = m.get("templateEndCol") ?? 0;
        this.direction = m.get("direction") ?? "vertical";
        this.count = m.get("count") ?? 1;
        this.gap = m.get("gap") ?? 0;
    }

    #observeYjs() {
        const obs = () => {
            this.#syncFromYjs();
            this.#onChanged?.();
        };
        this.#repYMap.observe(obs);
        this.#observers.push(() => this.#repYMap.unobserve(obs));
    }

    // ─── Cell context API ─────────────────────────────────────────────────────

    /**
     * Map a physical (row, col) to repeater context if it falls within this repeater.
     * Returns null if the cell is not part of this repeater.
     *
     * @param {number} row
     * @param {number} col
     * @returns {{ repIndex: number, templateRow: number, templateCol: number } | null}
     */
    getCellContext(row, col) {
        if (this.direction === "vertical") {
            // Column must be in range
            if (col < this.templateStartCol || col > this.templateEndCol) return null;
            const offset = row - this.templateStartRow;
            if (offset < 0 || offset >= this.inlineExtentRows) return null;
            const span = this.templateRows + this.gap;
            const repIndex = Math.floor(offset / span);
            if (repIndex >= this.count) return null;
            const localRow = offset % span;
            if (localRow >= this.templateRows) return null; // gap row — not part of repeater
            return {
                repIndex,
                templateRow: this.templateStartRow + localRow,
                templateCol: col,
            };
        }

        // Horizontal direction
        if (row < this.templateStartRow || row > this.templateEndRow) return null;
        const offset = col - this.templateStartCol;
        if (offset < 0 || offset >= this.inlineExtentCols) return null;
        const span = this.templateCols + this.gap;
        const repIndex = Math.floor(offset / span);
        if (repIndex >= this.count) return null;
        const localCol = offset % span;
        if (localCol >= this.templateCols) return null; // gap col
        return {
            repIndex,
            templateRow: row,
            templateCol: this.templateStartCol + localCol,
        };
    }

    /**
     * Returns true if (row, col) is occupied by any part of this inline repeater.
     */
    containsCell(row, col) {
        return this.getCellContext(row, col) !== null;
    }

    // ─── Mutation API ─────────────────────────────────────────────────────────

    setCount(count) {
        this.#ydoc.transact(() => this.#repYMap.set("count", count));
    }

    setGap(gap) {
        this.#ydoc.transact(() => this.#repYMap.set("gap", gap));
    }

    setDirection(direction) {
        this.#ydoc.transact(() => this.#repYMap.set("direction", direction));
    }

    setName(name) {
        this.#ydoc.transact(() => this.#repYMap.set("name", name));
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    destroy() {
        for (const cleanup of this.#observers) cleanup();
        this.#observers = [];
    }
}

// ─── RepeaterEngine ───────────────────────────────────────────────────────────

export class RepeaterEngine {
    /** @type {import('yjs').Map} */
    #repeatersYMap;
    /** @type {import('yjs').Doc} */
    #ydoc;
    /** @type {Function[]} */
    #observers = [];

    /** repeaterId → RepeaterStore */
    stores = new Map();

    /** Reactive list of repeater IDs */
    storeList = $state([]);

    /**
     * Incremented whenever any repeater is added, removed, or its config changes.
     * Grid tracks this to trigger repaints when repeater structure changes.
     */
    repeaterVersion = $state(0);

    /**
     * @param {import('yjs').Map} sheet  The sheet Y.Map
     * @param {import('yjs').Doc} ydoc
     */
    constructor(sheet, ydoc) {
        this.#ydoc = ydoc;
        this.#repeatersYMap = sheet.get("repeaters");

        if (!this.#repeatersYMap) return; // Older doc — no-op

        // Hydrate existing repeaters
        this.#repeatersYMap.forEach((repYMap, repId) => {
            this.#addStore(repId, repYMap);
        });

        // Observe add/remove
        const obs = (event) => {
            event.changes.keys.forEach((change, repId) => {
                if (change.action === "add") {
                    const repYMap = this.#repeatersYMap.get(repId);
                    if (repYMap) this.#addStore(repId, repYMap);
                } else if (change.action === "delete") {
                    this.#removeStore(repId);
                }
            });
        };
        this.#repeatersYMap.observe(obs);
        this.#observers.push(() => this.#repeatersYMap.unobserve(obs));
    }

    #addStore(repId, repYMap) {
        if (this.stores.has(repId)) return;
        const store = new RepeaterStore(repYMap, this.#ydoc, () => this.repeaterVersion++);
        this.stores.set(repId, store);
        this.storeList = [...this.storeList, repId];
        this.repeaterVersion++;
    }

    #removeStore(repId) {
        const store = this.stores.get(repId);
        if (store) {
            store.destroy();
            this.stores.delete(repId);
            this.storeList = this.storeList.filter((id) => id !== repId);
            this.repeaterVersion++;
        }
    }

    // ─── SheetRenderContext API ───────────────────────────────────────────────

    /**
     * Returns the repeater context for (row, col) if it belongs to any inline
     * repeater, or null otherwise.
     * @param {number} row
     * @param {number} col
     * @returns {{ repeater: RepeaterStore, repIndex: number, templateRow: number, templateCol: number } | null}
     */
    getCellRepeaterContext(row, col) {
        for (const store of this.stores.values()) {
            const ctx = store.getCellContext(row, col);
            if (ctx) return { repeater: store, ...ctx };
        }
        return null;
    }

    /**
     * Get display value for a repeater cell.
     * For rep 0: delegates to the normal formula engine path.
     * For rep > 0: evaluates the template cell's formula with $rep = repIndex.
     *
     * @param {number} row
     * @param {number} col
     * @param {import('../SpreadsheetSession.svelte.js').SpreadsheetSession} session
     * @returns {any}
     */
    getCellDisplayValue(row, col, session) {
        const ctx = this.getCellRepeaterContext(row, col);
        if (!ctx) return "";

        if (ctx.repIndex === 0) {
            // Template cell — normal display value
            return session.getCellDisplayValue(ctx.templateRow, ctx.templateCol);
        }

        // Non-template rep — evaluate with $rep context
        const rawValue = session.getCell(ctx.templateRow, ctx.templateCol)?.v;
        if (typeof rawValue === "string" && rawValue.startsWith("=")) {
            // Has formula — evaluate with $rep = repIndex
            return (
                session.formulaEngine?.evaluateWithContext(ctx.templateRow, ctx.templateCol, {
                    rep: ctx.repIndex,
                }) ?? ""
            );
        }

        // Static value — same for all reps
        return session.getCellDisplayValue(ctx.templateRow, ctx.templateCol);
    }

    /**
     * Maximum sheet row occupied by any inline vertical repeater.
     */
    get maxInlineExtentRow() {
        let max = 0;
        for (const store of this.stores.values()) {
            if (store.direction === "vertical" && store.inlineEndRow > max) {
                max = store.inlineEndRow;
            }
        }
        return max;
    }

    // ─── Repeater CRUD ────────────────────────────────────────────────────────

    /**
     * Create a new inline repeater.
     * @param {{ name?: string, templateStartRow: number, templateEndRow: number,
     *           templateStartCol: number, templateEndCol: number,
     *           direction?: string, count?: number, gap?: number }} opts
     * @returns {string} repeaterId
     */
    createRepeater(opts) {
        if (!this.#repeatersYMap) return "";
        const repId = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        this.#ydoc.transact(() => {
            const rm = new Y.Map();
            rm.set("id", repId);
            rm.set("name", opts.name ?? "Repeater");
            rm.set("templateStartRow", opts.templateStartRow);
            rm.set("templateEndRow", opts.templateEndRow);
            rm.set("templateStartCol", opts.templateStartCol);
            rm.set("templateEndCol", opts.templateEndCol);
            rm.set("direction", opts.direction ?? "vertical");
            rm.set("count", opts.count ?? 1);
            rm.set("gap", opts.gap ?? 0);
            this.#repeatersYMap.set(repId, rm);
        });

        return repId;
    }

    /**
     * Delete a repeater by ID.
     */
    deleteRepeater(repId) {
        if (!this.#repeatersYMap) return;
        this.#ydoc.transact(() => this.#repeatersYMap.delete(repId));
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    destroy() {
        for (const cleanup of this.#observers) cleanup();
        this.#observers = [];
        for (const store of this.stores.values()) store.destroy();
        this.stores.clear();
        this.storeList = [];
    }
}

export default RepeaterEngine;
