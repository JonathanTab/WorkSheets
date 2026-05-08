/**
 * SheetStore - Reactive Facade for Sheet Data
 *
 * Consolidates CellModel, CellStore, and SheetModel functionality.
 * Uses a single Yjs observer and a reactive object map for efficient updates.
 *
 * ## Key Principles
 * 1. Yjs is the ONLY source of truth for sheet data
 * 2. ONE observer on cells Y.Map for all cell changes
 * 3. Reactive cells object keyed by "row,col" for fine-grained updates
 * 4. No version counters - Svelte 5 detects object mutations directly
 * 5. Single `v` field stores value OR formula (formulas start with "=")
 */
import * as Y from 'yjs';
import { YKeyValue } from 'y-utility/y-keyvalue';
import { applyFormatToRange, normalizeTfr } from './textFormatRuns.js';
import { perfMon } from './perf/PerfMonitor.js';
import {
    CELL_KEYS,
    CELL_VALUE_KEYS,
    CELL_TYPE_CONFIG_KEY,
    DEFAULT_ROW_COUNT,
    DEFAULT_COL_COUNT
} from './constants.js';
import { MergeEngine } from './features/MergeEngine.svelte.js';

// Frozen empty object for non-existent cells (prevents allocation churn)
const EMPTY_CELL = Object.freeze({ v: undefined, exists: false });

export class SheetStore {
    /** @type {Y.Map} */
    #sheet;

    /** @type {Y.Doc} */
    #ydoc;

    /** @type {YKeyValue|null} cell values store — { v, t } per "row,col" */
    #cellValuesKV = null;

    /** @type {YKeyValue|null} cell styles store — formatting + ct + protected per "row,col" */
    #cellStylesKV = null;

    /** @type {YKeyValue|null} row metadata — { height, hidden, ...formatting } per row index */
    #rowMetaKV = null;

    /** @type {YKeyValue|null} col metadata — { width, hidden, ...formatting } per col index */
    #colMetaKV = null;

    /** @type {Y.Array} backing Y.Array for the YKeyValue borders store */
    #borders;

    /** @type {YKeyValue} YKeyValue wrapper for #borders */
    #bordersKV;

    /** @type {Function | null} */
    #cleanup = null;

    /** @type {Map<string, { top: any, right: any, bottom: any, left: any }>} */
    #cellBorderCache = new Map();

    // --- Reactive Sheet Properties ---
    id = $state('');
    name = $state('');
    rowCount = $state(DEFAULT_ROW_COUNT);
    colCount = $state(DEFAULT_COL_COUNT);
    frozenRows = $state(0);
    frozenColumns = $state(0);
    defaultRowHeight = $state(undefined);
    defaultColWidth = $state(undefined);
    hidden = $state(false);
    tabColor = $state(undefined);

    // --- Reactive Cell Data ---
    // Key: "row,col" -> Value: Cell Object { v, style, exists }
    // Note: v contains either a raw value OR a formula string (starting with "=")
    cells = $state(new Map());

    /**
     * Incremented whenever any cell is added, updated, or deleted.
     * Grid tracks this (not the Map reference) because Svelte 5 doesn't
     * track Map.set/delete mutations unless you read Map contents in the effect.
     */
    cellsVersion = $state(0);

    // --- Reactive Border Version ---
    // Incremented when borders change to trigger re-renders
    bordersVersion = $state(0);

    // --- Metadata Version Tracking ---
    // Incremented when row heights or column widths change for cache invalidation
    rowMetaVersion = $state(0);
    colMetaVersion = $state(0);

    // --- Print Settings Version ---
    // Incremented when print settings change (triggers page break re-computation)
    printSettingsVersion = $state(0);

    // --- Floating Images ---
    // Key: imageId (string) -> Value: { id, blobId, anchorRow, anchorCol, offsetX, offsetY, width, height, fit }
    floatingImages = $state(new Map());
    floatingImagesVersion = $state(0);

    // --- Conditional Formats Version ---
    cfVersion = $state(0);

    // --- Merge Engine ---
    /** @type {MergeEngine} */
    mergeEngine = null;

    /**
     * Create a SheetStore
     * @param {Y.Map} sheet - The sheet Y.Map
     * @param {Y.Doc} ydoc - The Y.Doc instance
     */
    constructor(sheet, ydoc) {
        this.#sheet = sheet;
        this.#ydoc = ydoc;
        const cvArr = sheet.get('cellValues');
        const csArr = sheet.get('cellStyles');
        if (cvArr instanceof Y.Array) this.#cellValuesKV = new YKeyValue(cvArr);
        if (csArr instanceof Y.Array) this.#cellStylesKV = new YKeyValue(csArr);
        // rowMeta / colMeta are initialized with observers in #setupObservers → tryAttachRowMeta/tryAttachColMeta

        this.#borders = sheet.get('borders');
        if (this.#borders) this.#bordersKV = new YKeyValue(this.#borders);

        // 1. Synchronous initial sync
        this.#syncSheetProps();
        this.#syncAllCells();

        // 2. Setup Observers (Push updates to state)
        this.#setupObservers();

        // 3. Initialize MergeEngine (reactive merge index)
        this.mergeEngine = new MergeEngine(sheet, ydoc);
    }

    // --- Initialization & Sync ---

    #syncSheetProps() {
        this.id = this.#sheet.get('id') ?? '';
        this.name = this.#sheet.get('name') ?? '';
        this.rowCount = this.#sheet.get('rowCount') ?? DEFAULT_ROW_COUNT;
        this.colCount = this.#sheet.get('colCount') ?? DEFAULT_COL_COUNT;
        this.frozenRows = this.#sheet.get('frozenRows') ?? 0;
        this.frozenColumns = this.#sheet.get('frozenColumns') ?? 0;
        this.defaultRowHeight = this.#sheet.get('defaultRowHeight');
        this.defaultColWidth = this.#sheet.get('defaultColWidth');
        this.hidden = this.#sheet.get('hidden') ?? false;
        this.tabColor = this.#sheet.get('tabColor');
        this.#syncFloatingImages();
    }

    #syncFloatingImages() {
        const ymap = this.#sheet.get('floatingImages');
        if (!ymap) { this.floatingImages = new Map(); return; }
        const result = new Map();
        ymap.forEach((v, id) => {
            result.set(id, this.#normalizeFloatingImage(id, v));
        });
        this.floatingImages = result;
    }

    #normalizeFloatingImage(id, v) {
        if (v instanceof Y.Map) {
            return {
                id,
                blobId:     v.get('blobId') ?? '',
                anchorRow:  v.get('anchorRow') ?? 0,
                anchorCol:  v.get('anchorCol') ?? 0,
                offsetX:    v.get('offsetX') ?? 0,
                offsetY:    v.get('offsetY') ?? 0,
                width:      v.get('width') ?? 200,
                height:     v.get('height') ?? 150,
                fit:        v.get('fit') ?? 'contain',
            };
        }
        return { id, blobId: '', anchorRow: 0, anchorCol: 0, offsetX: 0, offsetY: 0, width: 200, height: 150, fit: 'contain', ...v };
    }

    #syncAllCells() {
        const newCells = new Map();
        const allKeys = new Set([
            ...(this.#cellValuesKV?.map.keys() ?? []),
            ...(this.#cellStylesKV?.map.keys() ?? []),
        ]);
        for (const key of allKeys) {
            newCells.set(key, this.#processCellData(key));
        }
        this.cells = newCells;
    }

    /** Merge cellValues + cellStyles into a single plain render object for key "row,col". */
    #processCellData(key) {
        const val = this.#cellValuesKV?.get(key);
        const sty = this.#cellStylesKV?.get(key);
        return {
            v:               val?.v,
            t:               val?.t,
            tfr:             val?.tfr,
            ct:              sty?.ct,
            protected:       sty?.protected,
            fontFamily:      sty?.fontFamily,
            fontSize:        sty?.fontSize,
            bold:            sty?.bold,
            italic:          sty?.italic,
            underline:       sty?.underline,
            strikethrough:   sty?.strikethrough,
            color:           sty?.color,
            backgroundColor: sty?.backgroundColor,
            border:          sty?.border,
            horizontalAlign: sty?.horizontalAlign,
            verticalAlign:   sty?.verticalAlign,
            wrapText:        sty?.wrapText,
            numberFormat:    sty?.numberFormat,
            exists: true,
        };
    }

    /** Return merged plain data object for a cell key, or null if the cell does not exist. */
    #getCellData(key) {
        const val = this.#cellValuesKV?.get(key);
        const sty = this.#cellStylesKV?.get(key);
        if (!val && !sty) return null;
        return { ...(sty ?? {}), ...(val ?? {}) };
    }

    /** Split a plain data object and write its parts to cellValues / cellStyles. */
    #setCellData(key, data) {
        if (!data) { this.#deleteCellData(key); return; }
        const valData = {};
        const styData = {};
        for (const [k, v] of Object.entries(data)) {
            if (v === undefined) continue;
            if (CELL_VALUE_KEYS.has(k)) valData[k] = v;
            else styData[k] = v;
        }
        if (Object.keys(valData).length > 0) this.#cellValuesKV?.set(key, valData);
        else this.#cellValuesKV?.delete(key);
        if (Object.keys(styData).length > 0) this.#cellStylesKV?.set(key, styData);
        else this.#cellStylesKV?.delete(key);
    }

    /** Delete a cell from both stores. */
    #deleteCellData(key) {
        this.#cellValuesKV?.delete(key);
        this.#cellStylesKV?.delete(key);
    }

    /** Set of all cell keys present in either store. */
    #allCellKeys() {
        return new Set([
            ...(this.#cellValuesKV?.map.keys() ?? []),
            ...(this.#cellStylesKV?.map.keys() ?? []),
        ]);
    }

    #setupObservers() {
        // 5-pre. Targeted rowMeta / colMeta observers for remote resize syncing.
        //
        // Strategy: observe each meta Y.Map DIRECTLY rather than using a broad
        // observeDeep on #sheet (which would fire for every cell change).
        //   - If the map already exists at construction time, attach immediately.
        //   - If it is created later (first resize), the sheetObserver detects the
        //     new key and attaches the observer then.
        //   - For local writes, setRowHeight/setColWidth still increment the version
        //     counter manually (synchronous, before the next microtask); the same
        //     increment from the observer is a harmless no-op because the $effect in
        //     Grid is idempotent.
        const rowMetaHandler = () => { this.rowMetaVersion++; };
        const colMetaHandler = () => { this.colMetaVersion++; };

        const tryAttachRowMeta = () => {
            const arr = this.#sheet.get('rowMeta');
            if (!(arr instanceof Y.Array)) return;
            if (arr === this.#rowMetaKV?.yarray) return;
            this.#rowMetaKV?.off('change', rowMetaHandler);
            this.#rowMetaKV = new YKeyValue(arr);
            this.#rowMetaKV.on('change', rowMetaHandler);
        };
        const tryAttachColMeta = () => {
            const arr = this.#sheet.get('colMeta');
            if (!(arr instanceof Y.Array)) return;
            if (arr === this.#colMetaKV?.yarray) return;
            this.#colMetaKV?.off('change', colMetaHandler);
            this.#colMetaKV = new YKeyValue(arr);
            this.#colMetaKV.on('change', colMetaHandler);
        };

        // Observe conditionalFormats Y.Array for remote changes
        /** @type {import('yjs').Array<any>|null} */
        let cfArray = null;
        const cfHandler = () => { this.cfVersion++; };
        const tryAttachCF = () => {
            const arr = this.#sheet.get('conditionalFormats');
            if (arr && arr !== cfArray) {
                if (cfArray) cfArray.unobserve(cfHandler);
                cfArray = arr;
                arr.observe(cfHandler);
            }
        };

        // Attach to any maps that already exist (e.g. doc loaded with prior resizes).
        tryAttachRowMeta();
        tryAttachColMeta();
        tryAttachCF();

        // 1. Observe Sheet Props (and detect first-time creation of meta maps)
        const sheetObserver = (event) => {
            // Directly update reactive properties
            if (event.keysChanged.has('name')) this.name = this.#sheet.get('name');
            if (event.keysChanged.has('rowCount')) this.rowCount = this.#sheet.get('rowCount') ?? DEFAULT_ROW_COUNT;
            if (event.keysChanged.has('colCount')) this.colCount = this.#sheet.get('colCount') ?? DEFAULT_COL_COUNT;
            if (event.keysChanged.has('frozenRows')) this.frozenRows = this.#sheet.get('frozenRows') ?? 0;
            if (event.keysChanged.has('frozenColumns')) this.frozenColumns = this.#sheet.get('frozenColumns') ?? 0;
            if (event.keysChanged.has('defaultRowHeight')) this.defaultRowHeight = this.#sheet.get('defaultRowHeight');
            if (event.keysChanged.has('defaultColWidth')) this.defaultColWidth = this.#sheet.get('defaultColWidth');
            if (event.keysChanged.has('hidden')) this.hidden = this.#sheet.get('hidden') ?? false;
            if (event.keysChanged.has('tabColor')) this.tabColor = this.#sheet.get('tabColor');
            // Detect when rowMeta/colMeta are first added to the sheet (e.g. from a
            // remote peer doing the first resize, or on first local resize before the
            // transaction fires our own handlers).
            if (event.keysChanged.has('rowMeta')) tryAttachRowMeta();
            if (event.keysChanged.has('colMeta')) tryAttachColMeta();
            if (event.keysChanged.has('printSettings')) {
                // tryAttachPrintSettings is defined later in the same scope;
                // closures evaluate at call time so this is safe.
                tryAttachPrintSettings(); // eslint-disable-line no-use-before-define
                this.printSettingsVersion++;
            }
            if (event.keysChanged.has('floatingImages')) {
                tryAttachFloatingImages(); // eslint-disable-line no-use-before-define
                this.#syncFloatingImages();
                this.floatingImagesVersion++;
            }
            if (event.keysChanged.has('conditionalFormats')) {
                tryAttachCF();
                this.cfVersion++;
            }
        };
        this.#sheet.observe(sheetObserver);

        // 2. Observe cellValues YKeyValue changes (value + type updates)
        const cellValueObserver = (changes) => {
            for (const [key, change] of changes) {
                if (change.action === 'delete') {
                    if (!this.#cellStylesKV?.has(key)) this.cells.delete(key);
                    else this.cells.set(key, this.#processCellData(key));
                } else {
                    this.cells.set(key, this.#processCellData(key));
                }
            }
            this.cellsVersion++;
            perfMon.count('data.cellsVersionBump');
        };
        this.#cellValuesKV?.on('change', cellValueObserver);

        // 3. Observe cellStyles YKeyValue changes (formatting + ct + protected updates)
        const cellStyleObserver = (changes) => {
            for (const [key, change] of changes) {
                if (change.action === 'delete') {
                    if (!this.#cellValuesKV?.has(key)) this.cells.delete(key);
                    else this.cells.set(key, this.#processCellData(key));
                } else {
                    this.cells.set(key, this.#processCellData(key));
                }
            }
            this.cellsVersion++;
            perfMon.count('data.cellsVersionBump');
        };
        this.#cellStylesKV?.on('change', cellStyleObserver);

        // 4. Observe borders YKeyValue for reactivity
        const bordersObserver = () => {
            this.bordersVersion++;
            this.#cellBorderCache.clear();
        };
        this.#bordersKV?.on('change', bordersObserver);

        // 5. Observe printSettings Y.Map changes
        let printSettingsMap = null;
        const printSettingsHandler = () => { this.printSettingsVersion++; };
        const tryAttachPrintSettings = () => {
            const map = this.#sheet.get('printSettings');
            if (map && map !== printSettingsMap) {
                if (printSettingsMap) printSettingsMap.unobserve(printSettingsHandler);
                printSettingsMap = map;
                printSettingsMap.observe(printSettingsHandler);
            }
        };
        tryAttachPrintSettings();

        // 6. Observe floatingImages Y.Map changes
        let floatingImagesMap = null;
        const floatingImagesHandler = () => {
            this.#syncFloatingImages();
            this.floatingImagesVersion++;
        };
        const tryAttachFloatingImages = () => {
            const map = this.#sheet.get('floatingImages');
            if (map && map !== floatingImagesMap) {
                if (floatingImagesMap) floatingImagesMap.unobserveDeep(floatingImagesHandler);
                floatingImagesMap = map;
                floatingImagesMap.observeDeep(floatingImagesHandler);
            }
        };
        tryAttachFloatingImages();

        this.#cleanup = () => {
            this.#sheet.unobserve(sheetObserver);
            this.#cellValuesKV?.off('change', cellValueObserver);
            this.#cellStylesKV?.off('change', cellStyleObserver);
            this.#bordersKV?.off('change', bordersObserver);
            this.#rowMetaKV?.off('change', rowMetaHandler);
            this.#colMetaKV?.off('change', colMetaHandler);
            if (printSettingsMap) printSettingsMap.unobserve(printSettingsHandler);
            if (floatingImagesMap) floatingImagesMap.unobserveDeep(floatingImagesHandler);
        };
    }

    // --- Public API ---

    // ─── Floating Image Methods ────────────────────────────────────────────────

    /**
     * Add a new floating image to the sheet.
     * @param {{ blobId: string, anchorRow: number, anchorCol: number, offsetX?: number, offsetY?: number, width?: number, height?: number, fit?: string }} opts
     * @returns {string} The new image ID
     */
    addFloatingImage(opts) {
        const id = crypto.randomUUID ? crypto.randomUUID() : `fi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        this.#ydoc.transact(() => {
            let ymap = this.#sheet.get('floatingImages');
            if (!ymap) {
                ymap = new Y.Map();
                this.#sheet.set('floatingImages', ymap);
            }
            const img = new Y.Map();
            img.set('blobId',    opts.blobId ?? '');
            img.set('anchorRow', opts.anchorRow ?? 0);
            img.set('anchorCol', opts.anchorCol ?? 0);
            img.set('offsetX',   opts.offsetX ?? 0);
            img.set('offsetY',   opts.offsetY ?? 0);
            img.set('width',     opts.width ?? 200);
            img.set('height',    opts.height ?? 150);
            img.set('fit',       opts.fit ?? 'contain');
            ymap.set(id, img);
        });
        return id;
    }

    /**
     * Update properties of an existing floating image.
     * @param {string} id
     * @param {Partial<{blobId,anchorRow,anchorCol,offsetX,offsetY,width,height,fit}>} changes
     */
    updateFloatingImage(id, changes) {
        const ymap = this.#sheet.get('floatingImages');
        if (!ymap) return;
        const img = ymap.get(id);
        if (!img || !(img instanceof Y.Map)) return;
        this.#ydoc.transact(() => {
            for (const [k, v] of Object.entries(changes)) {
                img.set(k, v);
            }
        });
    }

    /**
     * Remove a floating image from the sheet.
     * @param {string} id
     */
    removeFloatingImage(id) {
        const ymap = this.#sheet.get('floatingImages');
        if (!ymap) return;
        this.#ydoc.transact(() => {
            ymap.delete(id);
        });
    }

    // ─── Cell Methods ──────────────────────────────────────────────────────────

    /**
     * Get a cell's reactive state.
     * Returns reactive object if exists, or frozen empty cell constant.
     * Returns reactive object if exists, or frozen empty cell constant.
     * @param {number} row
     * @param {number} col
     * @returns {Object} Cell object with { v, exists, ...formatting }
     */
    getCell(row, col) {
        const key = `${row},${col}`;
        return this.cells.get(key) || EMPTY_CELL;
    }

    /**
     * Check if a cell exists
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    hasCell(row, col) {
        const key = `${row},${col}`;
        return (this.#cellValuesKV?.has(key) ?? false) || (this.#cellStylesKV?.has(key) ?? false);
    }

    /**
     * Check if a cell's value is a formula
     * @param {number} row
     * @param {number} col
     * @returns {boolean}
     */
    isFormula(row, col) {
        const cell = this.getCell(row, col);
        return cell.exists && typeof cell.v === 'string' && cell.v.startsWith('=');
    }

    /**
     * Set cell value (overwrites any existing value/formula)
     * @param {number} row
     * @param {number} col
     * @param {any} value
     */
    setCellValue(row, col, value) {
        const key = `${row},${col}`;
        this.#ydoc.transact(() => {
            if (value === '' || value === null || value === undefined) {
                this.#cellValuesKV?.delete(key);
            } else {
                const current = this.#cellValuesKV?.get(key) ?? {};
                // Clear any stale tfr when setting a plain value
                const upd = { ...current, v: value };
                delete upd.tfr;
                this.#cellValuesKV?.set(key, upd);
            }
        });
    }

    /**
     * Set cell plain text value + optional TextFormatRuns in one transaction.
     * @param {number} row
     * @param {number} col
     * @param {string} value   plain text
     * @param {Array|null} tfr text format runs (null = no inline formatting)
     */
    setCellValueWithRuns(row, col, value, tfr) {
        const key = `${row},${col}`;
        this.#ydoc.transact(() => {
            if (value === '' || value === null || value === undefined) {
                this.#cellValuesKV?.delete(key);
                return;
            }
            const current = this.#cellValuesKV?.get(key) ?? {};
            const upd = { ...current, v: value };
            if (tfr && tfr.length > 0) upd.tfr = tfr;
            else delete upd.tfr;
            this.#cellValuesKV?.set(key, upd);
        });
    }

    /**
     * Set cell formula (stores formula string in v field)
     * @param {number} row
     * @param {number} col
     * @param {string} formula
     */
    setCellFormula(row, col, formula) {
        const key = `${row},${col}`;
        this.#ydoc.transact(() => {
            if (!formula || formula === '') {
                this.#cellValuesKV?.delete(key);
                return;
            }
            const normalized = formula.startsWith('=') ? formula : '=' + formula;
            const current = this.#cellValuesKV?.get(key) ?? {};
            this.#cellValuesKV?.set(key, { ...current, v: normalized });
        });
    }

    /**
     * Set cell formatting/properties
     * @param {number} row
     * @param {number} col
     * @param {Object} props
     */
    setCellProperties(row, col, props) {
        const key = `${row},${col}`;
        this.#ydoc.transact(() => {
            const valUpdates = {};
            const styUpdates = {};
            for (const [k, v] of Object.entries(props)) {
                if (CELL_VALUE_KEYS.has(k)) valUpdates[k] = v;
                else styUpdates[k] = v;
            }

            // When a whole-cell format property is set, strip any matching run-level
            // overrides from tfr so the cell-level value wins uniformly.
            const TFR_PROP_MAP = {
                bold: 'bold', italic: 'italic', underline: 'underline',
                strikethrough: 'strikethrough', color: 'foregroundColor',
                fontSize: 'fontSize', fontFamily: 'fontFamily',
            };
            const strippedProps = Object.keys(styUpdates)
                .map(p => TFR_PROP_MAP[p])
                .filter(Boolean);
            if (strippedProps.length > 0) {
                const cellVals = this.#cellValuesKV?.get(key);
                const existingTfr = cellVals?.tfr;
                if (existingTfr?.length) {
                    const plainText = cellVals?.v ?? '';
                    let newTfr = existingTfr;
                    for (const prop of strippedProps) {
                        newTfr = applyFormatToRange(
                            newTfr, 0, plainText.length,
                            { [prop]: null }, plainText.length
                        );
                    }
                    valUpdates.tfr = normalizeTfr(newTfr, plainText.length);
                }
            }

            if (Object.keys(valUpdates).length > 0) {
                const cur = this.#cellValuesKV?.get(key) ?? {};
                const upd = { ...cur };
                for (const [k, v] of Object.entries(valUpdates)) {
                    if (v === undefined || v === null) delete upd[k]; else upd[k] = v;
                }
                if (Object.keys(upd).length > 0) this.#cellValuesKV?.set(key, upd);
                else this.#cellValuesKV?.delete(key);
            }

            if (Object.keys(styUpdates).length > 0) {
                const cur = this.#cellStylesKV?.get(key) ?? {};
                const upd = { ...cur };
                for (const [k, v] of Object.entries(styUpdates)) {
                    if (v === undefined) delete upd[k]; else upd[k] = v;
                }
                if (Object.keys(upd).length > 0) this.#cellStylesKV?.set(key, upd);
                else this.#cellStylesKV?.delete(key);
            }
        });
    }

    /**
     * Clear a cell completely
     * @param {number} row
     * @param {number} col
     */
    clearCell(row, col) {
        const key = `${row},${col}`;
        this.#ydoc.transact(() => {
            this.#deleteCellData(key);
        });
    }

    /**
     * Get effective cell type config merging col -> row -> cell
     * @param {number} row
     * @param {number} col
     * @returns {Object|null}
     */
    getCellTypeConfig(row, col) {
        const cell = this.getCell(row, col);
        if (cell.ct) return cell.ct;

        const rMeta = this.#rowMetaKV?.get(String(row));
        if (rMeta?.[CELL_TYPE_CONFIG_KEY] !== undefined) return rMeta[CELL_TYPE_CONFIG_KEY];

        const cMeta = this.#colMetaKV?.get(String(col));
        if (cMeta?.[CELL_TYPE_CONFIG_KEY] !== undefined) return cMeta[CELL_TYPE_CONFIG_KEY];

        return null;
    }

    /**
     * Set cell-level type config
     * @param {number} row
     * @param {number} col
     * @param {Object} ct
     */
    setCellTypeConfig(row, col, ct) {
        this.setCellProperties(row, col, { [CELL_TYPE_CONFIG_KEY]: ct });
    }

    /**
     * Get row-level formatting properties (from rowMeta).
     * Returns null if none set.
     * @param {number} rowIndex
     * @returns {Object|null}
     */
    getRowFormatting(rowIndex) {
        const meta = this.#rowMetaKV?.get(String(rowIndex));
        if (!meta) return null;
        const fmt = {};
        const keys = ['fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strikethrough',
            'color', 'backgroundColor', 'horizontalAlign', 'verticalAlign', 'wrapText'];
        let hasAny = false;
        for (const k of keys) {
            if (meta[k] !== undefined) { fmt[k] = meta[k]; hasAny = true; }
        }
        return hasAny ? fmt : null;
    }

    /**
     * Set row-level formatting properties (written to rowMeta).
     * Pass null for a property value to remove it.
     * @param {number} rowIndex
     * @param {Object} props
     */
    setRowFormatting(rowIndex, props) {
        if (!this.#rowMetaKV) return;
        this.#ydoc.transact(() => {
            const cur = this.#rowMetaKV.get(String(rowIndex)) ?? {};
            const upd = { ...cur };
            for (const [k, v] of Object.entries(props)) {
                if (v === null || v === undefined) delete upd[k];
                else upd[k] = v;
            }
            if (Object.keys(upd).length > 0) this.#rowMetaKV.set(String(rowIndex), upd);
            else this.#rowMetaKV.delete(String(rowIndex));
        });
    }

    /**
     * Get column-level formatting properties (from colMeta).
     * Returns null if none set.
     * @param {number} colIndex
     * @returns {Object|null}
     */
    getColFormatting(colIndex) {
        const meta = this.#colMetaKV?.get(String(colIndex));
        if (!meta) return null;
        const fmt = {};
        const keys = ['fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strikethrough',
            'color', 'backgroundColor', 'horizontalAlign', 'verticalAlign', 'wrapText'];
        let hasAny = false;
        for (const k of keys) {
            if (meta[k] !== undefined) { fmt[k] = meta[k]; hasAny = true; }
        }
        return hasAny ? fmt : null;
    }

    /**
     * Set column-level formatting properties (written to colMeta).
     * Pass null for a property value to remove it.
     * @param {number} colIndex
     * @param {Object} props
     */
    setColFormatting(colIndex, props) {
        if (!this.#colMetaKV) return;
        this.#ydoc.transact(() => {
            const cur = this.#colMetaKV.get(String(colIndex)) ?? {};
            const upd = { ...cur };
            for (const [k, v] of Object.entries(props)) {
                if (v === null || v === undefined) delete upd[k];
                else upd[k] = v;
            }
            if (Object.keys(upd).length > 0) this.#colMetaKV.set(String(colIndex), upd);
            else this.#colMetaKV.delete(String(colIndex));
        });
    }

    /**
     * Resolve the effective visual style for a cell by applying the same
     * col→row→cell cascade that CellPaintData uses, so the inline editor
     * can match the canvas exactly.
     *
     * @param {number} row
     * @param {number} col
     * @returns {{ fontSize:number|null, fontFamily:string|null, bold:boolean, italic:boolean, underline:boolean, strikethrough:boolean, color:string|null, backgroundColor:string|null, horizontalAlign:string|null, verticalAlign:string|null, wrapText:boolean }}
     */
    getEffectiveCellStyle(row, col) {
        const out = {
            fontSize: null, fontFamily: null, bold: false, italic: false,
            underline: false, strikethrough: false, color: null,
            backgroundColor: null, horizontalAlign: null, verticalAlign: null, wrapText: false,
        };
        const apply = (src) => {
            if (!src) return;
            if (src.fontSize != null)         out.fontSize        = src.fontSize;
            if (src.fontFamily != null)        out.fontFamily       = src.fontFamily;
            if (src.bold)                      out.bold             = true;
            if (src.italic)                    out.italic           = true;
            if (src.underline)                 out.underline        = true;
            if (src.strikethrough)             out.strikethrough    = true;
            if (src.color != null)             out.color            = src.color;
            if (src.backgroundColor != null)   out.backgroundColor  = src.backgroundColor;
            if (src.horizontalAlign != null)   out.horizontalAlign  = src.horizontalAlign;
            if (src.verticalAlign != null)     out.verticalAlign    = src.verticalAlign;
            if (src.wrapText)                  out.wrapText         = true;
        };
        apply(this.getColFormatting(col));
        apply(this.getRowFormatting(row));
        const cell = this.getCell(row, col);
        if (cell?.exists) apply(cell);
        return out;
    }

    /**
     * Set column-level type config
     * @param {number} col
     * @param {Object} ct
     */
    setColTypeConfig(col, ct) {
        if (!this.#colMetaKV) return;
        this.#ydoc.transact(() => {
            const cur = this.#colMetaKV.get(String(col)) ?? {};
            if (ct === null) { const { [CELL_TYPE_CONFIG_KEY]: _, ...rest } = cur; this.#colMetaKV.set(String(col), rest); }
            else this.#colMetaKV.set(String(col), { ...cur, [CELL_TYPE_CONFIG_KEY]: ct });
        });
    }

    /**
     * Set row-level type config
     * @param {number} row
     * @param {Object|null} ct
     */
    setRowTypeConfig(row, ct) {
        if (!this.#rowMetaKV) return;
        this.#ydoc.transact(() => {
            const cur = this.#rowMetaKV.get(String(row)) ?? {};
            if (ct === null) { const { [CELL_TYPE_CONFIG_KEY]: _, ...rest } = cur; this.#rowMetaKV.set(String(row), rest); }
            else this.#rowMetaKV.set(String(row), { ...cur, [CELL_TYPE_CONFIG_KEY]: ct });
        });
    }

    // --- Sheet Property Setters ---

    setName(name) { this.#sheet.set('name', name); }
    setRowCount(count) { this.#sheet.set('rowCount', count); }
    setColCount(count) { this.#sheet.set('colCount', count); }
    setFrozenRows(count) { this.#sheet.set('frozenRows', count); }
    setFrozenColumns(count) { this.#sheet.set('frozenColumns', count); }
    setDefaultRowHeight(height) { this.#sheet.set('defaultRowHeight', height); }
    setDefaultColWidth(width) { this.#sheet.set('defaultColWidth', width); }
    setHidden(hidden) { this.#sheet.set('hidden', hidden); }
    setTabColor(color) {
        if (color === undefined) {
            this.#sheet.delete('tabColor');
        } else {
            this.#sheet.set('tabColor', color);
        }
    }

    // --- Row/Column Operations ---

    /**
     * Insert a row at the specified index (shifts existing rows down)
     * @param {number} rowIndex - The index where the new row should be inserted
     */
    insertRowAt(rowIndex) {
        this.#ydoc.transact(() => {
            // 1. Shift all cells at or below rowIndex down by 1
            const cellsToShift = [];
            for (const key of this.#allCellKeys()) {
                const [row, col] = key.split(',').map(Number);
                if (row >= rowIndex) cellsToShift.push({ key, row, col });
            }

            cellsToShift.sort((a, b) => b.row - a.row);
            for (const { key, row, col } of cellsToShift) {
                const newKey = `${row + 1},${col}`;
                const cellData = this.#getCellData(key);
                if (cellData?.v && typeof cellData.v === 'string' && cellData.v.startsWith('=')) {
                    cellData.v = this.#adjustFormulaForRowInsert(cellData.v, rowIndex);
                }
                this.#deleteCellData(key);
                if (cellData) this.#setCellData(newKey, cellData);
            }

            // 2. Adjust formulas in non-shifted cells (rows above the insertion)
            this.#adjustFormulasInCells(
                (row) => row >= rowIndex + 1,
                (formula) => this.#adjustFormulaForRowInsert(formula, rowIndex)
            );

            // 3. Shift borders
            this.#shiftBordersForRowInsert(rowIndex);

            // 4. Shift row metadata
            this.#shiftRowMetaForInsert(rowIndex);

            // 5. Shift features (merges, tables, repeaters)
            this.mergeEngine.shiftAxes('row', rowIndex, 1);
            this.#shiftTables('row', rowIndex, 1);
            this.#shiftRepeaters('row', rowIndex, 1);

            // 6. Increment rowCount
            const currentRowCount = this.#sheet.get('rowCount') ?? DEFAULT_ROW_COUNT;
            this.#sheet.set('rowCount', currentRowCount + 1);
        });
    }

    /**
     * Insert a column at the specified index (shifts existing columns right)
     * @param {number} colIndex - The index where the new column should be inserted
     */
    insertColumnAt(colIndex) {
        this.#ydoc.transact(() => {
            // 1. Shift all cells at or to the right of colIndex right by 1
            const cellsToShift = [];
            for (const key of this.#allCellKeys()) {
                const [row, col] = key.split(',').map(Number);
                if (col >= colIndex) cellsToShift.push({ key, row, col });
            }

            cellsToShift.sort((a, b) => b.col - a.col);
            for (const { key, row, col } of cellsToShift) {
                const newKey = `${row},${col + 1}`;
                const cellData = this.#getCellData(key);
                if (cellData?.v && typeof cellData.v === 'string' && cellData.v.startsWith('=')) {
                    cellData.v = this.#adjustFormulaForColInsert(cellData.v, colIndex);
                }
                this.#deleteCellData(key);
                if (cellData) this.#setCellData(newKey, cellData);
            }

            // 2. Adjust formulas in non-shifted cells (columns left of the insertion)
            this.#adjustFormulasInCells(
                (row, col) => col >= colIndex + 1,
                (formula) => this.#adjustFormulaForColInsert(formula, colIndex)
            );

            // 3. Shift borders
            this.#shiftBordersForColInsert(colIndex);

            // 4. Shift column metadata
            this.#shiftColMetaForInsert(colIndex);

            // 5. Shift features
            this.mergeEngine.shiftAxes('col', colIndex, 1);
            this.#shiftTables('col', colIndex, 1);
            this.#shiftRepeaters('col', colIndex, 1);

            // 6. Increment colCount
            const currentColCount = this.#sheet.get('colCount') ?? DEFAULT_COL_COUNT;
            this.#sheet.set('colCount', currentColCount + 1);
        });
    }

    /**
     * Delete a row at the specified index (shifts existing rows up)
     * @param {number} rowIndex - The index of the row to delete
     */
    deleteRowAt(rowIndex) {
        this.#ydoc.transact(() => {
            // 1. Delete all cells in the row
            for (const key of this.#allCellKeys()) {
                const [row] = key.split(',').map(Number);
                if (row === rowIndex) this.#deleteCellData(key);
            }

            // 2. Shift all cells below rowIndex up by 1
            const cellsToShift = [];
            for (const key of this.#allCellKeys()) {
                const [row, col] = key.split(',').map(Number);
                if (row > rowIndex) cellsToShift.push({ key, row, col });
            }

            cellsToShift.sort((a, b) => a.row - b.row);
            for (const { key, row, col } of cellsToShift) {
                const newKey = `${row - 1},${col}`;
                const cellData = this.#getCellData(key);
                if (cellData?.v && typeof cellData.v === 'string' && cellData.v.startsWith('=')) {
                    cellData.v = this.#adjustFormulaForRowDelete(cellData.v, rowIndex);
                }
                this.#deleteCellData(key);
                if (cellData) this.#setCellData(newKey, cellData);
            }

            // 3. Adjust formulas in non-shifted cells (rows above the deletion)
            this.#adjustFormulasInCells(
                (row) => row >= rowIndex,
                (formula) => this.#adjustFormulaForRowDelete(formula, rowIndex)
            );

            // 4. Shift borders
            this.#shiftBordersForRowDelete(rowIndex);

            // 5. Shift row metadata
            this.#shiftRowMetaForDelete(rowIndex);

            // 6. Shift features
            this.mergeEngine.shiftAxes('row', rowIndex, -1);
            this.#shiftTables('row', rowIndex, -1);
            this.#shiftRepeaters('row', rowIndex, -1);

            // 7. Decrement rowCount
            const currentRowCount = this.#sheet.get('rowCount') ?? DEFAULT_ROW_COUNT;
            this.#sheet.set('rowCount', Math.max(1, currentRowCount - 1));
        });
    }

    /**
     * Delete multiple rows in a single Yjs transaction.
     * O(cells) instead of O(n × cells) — does all shifting in one pass.
     * @param {number[]} rowIndices
     */
    deleteRowsAt(rowIndices) {
        if (!rowIndices.length) return;

        // Sort ascending, deduplicate
        const sorted = [...new Set(rowIndices)].sort((a, b) => a - b);
        const deletedSet = new Set(sorted);

        // Number of deleted rows strictly below index r (= how far r shifts up)
        const shiftFor = (r) => {
            let lo = 0, hi = sorted.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < r) lo = mid + 1; else hi = mid; }
            return lo;
        };

        // Apply formula adjustment for all deletions in descending order
        const adjustFormula = (formula) => {
            let result = formula;
            for (let i = sorted.length - 1; i >= 0; i--) {
                result = this.#adjustFormulaForRowDelete(result, sorted[i]);
            }
            return result;
        };

        this.#ydoc.transact(() => {
            // ── 1. Cells ───────────────────────────────────────────────────────
            const allKeys = [...this.#allCellKeys()];
            const toDelete = [];
            const toMove   = []; // { key, row, col, newRow } where newRow !== row
            const toUpdate = []; // { key }  formula-only in-place update

            for (const key of allKeys) {
                const [row, col] = key.split(',').map(Number);
                if (deletedSet.has(row)) {
                    toDelete.push(key);
                    continue;
                }
                const shift = shiftFor(row);
                const valData = this.#cellValuesKV?.get(key);
                const hasFormula = typeof valData?.v === 'string' && valData.v.startsWith('=');
                if (shift > 0) {
                    toMove.push({ key, row, col, newRow: row - shift, hasFormula, valData });
                } else if (hasFormula) {
                    toUpdate.push({ key, valData });
                }
            }

            for (const key of toDelete) this.#deleteCellData(key);

            // Move cells ascending so we never overwrite a destination that hasn't been vacated
            toMove.sort((a, b) => a.row - b.row);
            for (const { key, col, newRow, hasFormula, valData } of toMove) {
                const newKey = `${newRow},${col}`;
                const cellData = this.#getCellData(key);
                if (hasFormula && cellData) cellData.v = adjustFormula(valData.v);
                this.#deleteCellData(key);
                if (cellData) this.#setCellData(newKey, cellData);
            }

            // In-place formula update for non-moved cells
            for (const { key, valData } of toUpdate) {
                this.#cellValuesKV?.set(key, { ...valData, v: adjustFormula(valData.v) });
            }

            // ── 2. Borders ─────────────────────────────────────────────────────
            if (this.#bordersKV) {
                const bToDelete = [];
                const bToMove   = [];
                for (const [key, { val: value }] of this.#bordersKV.map) {
                    const [type, rowStr, colStr] = key.split(',');
                    const row = Number(rowStr);
                    const col = Number(colStr);
                    if (type === 'h') {
                        if (deletedSet.has(row) || deletedSet.has(row + 1)) { bToDelete.push(key); }
                        else {
                            const shift = shiftFor(row);
                            if (shift > 0) bToMove.push({ key, newKey: `h,${row - shift},${col}`, value });
                        }
                    } else if (type === 'v') {
                        if (deletedSet.has(row)) { bToDelete.push(key); }
                        else {
                            const shift = shiftFor(row);
                            if (shift > 0) bToMove.push({ key, newKey: `v,${row - shift},${col}`, value });
                        }
                    }
                }
                for (const key of bToDelete) this.#bordersKV.delete(key);
                bToMove.sort((a, b) => a.newKey.localeCompare(b.newKey));
                for (const { key, newKey, value } of bToMove) {
                    this.#bordersKV.delete(key);
                    this.#bordersKV.set(newKey, value);
                }
            }

            // ── 3. Row metadata ────────────────────────────────────────────────
            if (this.#rowMetaKV) {
                const rmToDelete = [];
                const rmToMove   = [];
                for (const [key, { val: data }] of this.#rowMetaKV.map) {
                    const row = parseInt(key, 10);
                    if (deletedSet.has(row)) { rmToDelete.push(key); }
                    else {
                        const shift = shiftFor(row);
                        if (shift > 0) rmToMove.push({ key, newKey: String(row - shift), data });
                    }
                }
                for (const key of rmToDelete) this.#rowMetaKV.delete(key);
                rmToMove.sort((a, b) => parseInt(a.newKey) - parseInt(b.newKey));
                for (const { key, newKey, data } of rmToMove) {
                    this.#rowMetaKV.delete(key);
                    this.#rowMetaKV.set(newKey, data);
                }
            }

            // ── 4. Merges / tables / repeaters (apply each deletion descending) ─
            for (let i = sorted.length - 1; i >= 0; i--) {
                const rowIndex = sorted[i];
                this.mergeEngine.shiftAxes('row', rowIndex, -1);
                this.#shiftTables('row', rowIndex, -1);
                this.#shiftRepeaters('row', rowIndex, -1);
            }

            // ── 5. Row count ───────────────────────────────────────────────────
            const cur = this.#sheet.get('rowCount') ?? DEFAULT_ROW_COUNT;
            this.#sheet.set('rowCount', Math.max(1, cur - sorted.length));
        });
    }

    /**
     * Delete a column at the specified index (shifts existing columns left)
     * @param {number} colIndex - The index of the column to delete
     */
    deleteColumnAt(colIndex) {
        this.#ydoc.transact(() => {
            // 1. Delete all cells in the column
            for (const key of this.#allCellKeys()) {
                const [, col] = key.split(',').map(Number);
                if (col === colIndex) this.#deleteCellData(key);
            }

            // 2. Shift all cells to the right of colIndex left by 1
            const cellsToShift = [];
            for (const key of this.#allCellKeys()) {
                const [row, col] = key.split(',').map(Number);
                if (col > colIndex) cellsToShift.push({ key, row, col });
            }

            cellsToShift.sort((a, b) => a.col - b.col);
            for (const { key, row, col } of cellsToShift) {
                const newKey = `${row},${col - 1}`;
                const cellData = this.#getCellData(key);
                if (cellData?.v && typeof cellData.v === 'string' && cellData.v.startsWith('=')) {
                    cellData.v = this.#adjustFormulaForColDelete(cellData.v, colIndex);
                }
                this.#deleteCellData(key);
                if (cellData) this.#setCellData(newKey, cellData);
            }

            // 3. Adjust formulas in non-shifted cells (columns left of the deletion)
            this.#adjustFormulasInCells(
                (row, col) => col >= colIndex,
                (formula) => this.#adjustFormulaForColDelete(formula, colIndex)
            );

            // 4. Shift borders
            this.#shiftBordersForColDelete(colIndex);

            // 5. Shift column metadata
            this.#shiftColMetaForDelete(colIndex);

            // 6. Shift features
            this.mergeEngine.shiftAxes('col', colIndex, -1);
            this.#shiftTables('col', colIndex, -1);
            this.#shiftRepeaters('col', colIndex, -1);

            // 7. Decrement colCount
            const currentColCount = this.#sheet.get('colCount') ?? DEFAULT_COL_COUNT;
            this.#sheet.set('colCount', Math.max(1, currentColCount - 1));
        });
    }

    /**
     * Clear only the cell value (keeps formatting)
     * @param {number} row
     * @param {number} col
     */
    clearCellValue(row, col) {
        const key = `${row},${col}`;
        this.#ydoc.transact(() => {
            const cur = this.#cellValuesKV?.get(key);
            if (!cur) return;
            const { v: _v, ...rest } = cur;
            if (Object.keys(rest).length > 0) this.#cellValuesKV.set(key, rest);
            else this.#cellValuesKV.delete(key);
        });
    }

    /**
     * Set a border on a specific cell edge
     * @param {number} row
     * @param {number} col
     * @param {string} edge - 'top', 'bottom', 'left', 'right'
     * @param {Object | null} style - { style, width, color } or null to remove
     */
    setCellBorder(row, col, edge, style) {
        // Ensure borders map exists
        if (!this.#bordersKV) return;

        let edgeKey;
        switch (edge) {
            case 'top':
                edgeKey = `h,${row - 1},${col}`;
                break;
            case 'bottom':
                edgeKey = `h,${row},${col}`;
                break;
            case 'left':
                edgeKey = `v,${row},${col - 1}`;
                break;
            case 'right':
                edgeKey = `v,${row},${col}`;
                break;
            default:
                return;
        }

        this.#ydoc.transact(() => {
            if (style === null) {
                this.#bordersKV.delete(edgeKey);
            } else {
                this.#bordersKV.set(edgeKey, style);
            }
        });
    }

    // --- Helper methods for insert/delete operations ---

    /**
     * Adjust formulas in cells that were not shifted during a row/col insert or delete.
     * @param {function} shouldSkip - (row, col) => boolean, returns true for cells already adjusted
     * @param {function} adjustFn - (formula) => string, the formula adjustment function
     */
    #adjustFormulasInCells(shouldSkip, adjustFn) {
        for (const [key, { val: data }] of (this.#cellValuesKV?.map ?? [])) {
            const [row, col] = key.split(',').map(Number);
            if (shouldSkip(row, col)) continue;
            const v = data.v;
            if (v && typeof v === 'string' && v.startsWith('=')) {
                const adjusted = adjustFn(v);
                if (adjusted !== v) {
                    this.#cellValuesKV.set(key, { ...data, v: adjusted });
                }
            }
        }
    }

    /**
     * Adjust formula references when a row is inserted
     * @param {string} formula
     * @param {number} insertedRowIndex
     * @returns {string}
     */
    #adjustFormulaForRowInsert(formula, insertedRowIndex) {
        // insertedRowIndex is 0-based internal; formula rows are 1-based
        const formulaRow = insertedRowIndex + 1;
        return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, col, rowAbs, row) => {
            const rowNum = parseInt(row, 10);
            if (!rowAbs && rowNum >= formulaRow) {
                return `${colAbs}${col}${rowAbs}${rowNum + 1}`;
            }
            return match;
        });
    }

    /**
     * Adjust formula references when a column is inserted
     * @param {string} formula
     * @param {number} insertedColIndex
     * @returns {string}
     */
    #adjustFormulaForColInsert(formula, insertedColIndex) {
        return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, col, rowAbs, row) => {
            // Adjust if column reference is at or right of the inserted column (and not absolute)
            if (!colAbs) {
                const colNum = this.#colToNum(col);
                if (colNum >= insertedColIndex) {
                    return `${colAbs}${this.#numToCol(colNum + 1)}${rowAbs}${row}`;
                }
            }
            return match;
        });
    }

    /**
     * Adjust formula references when a row is deleted
     * @param {string} formula
     * @param {number} deletedRowIndex
     * @returns {string}
     */
    #adjustFormulaForRowDelete(formula, deletedRowIndex) {
        // deletedRowIndex is 0-based internal; formula rows are 1-based
        const formulaRow = deletedRowIndex + 1;
        return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, col, rowAbs, row) => {
            const rowNum = parseInt(row, 10);
            if (!rowAbs) {
                if (rowNum > formulaRow) {
                    return `${colAbs}${col}${rowAbs}${rowNum - 1}`;
                } else if (rowNum === formulaRow) {
                    return `#REF!`;
                }
            }
            return match;
        });
    }

    /**
     * Adjust formula references when a column is deleted
     * @param {string} formula
     * @param {number} deletedColIndex
     * @returns {string}
     */
    #adjustFormulaForColDelete(formula, deletedColIndex) {
        return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, col, rowAbs, row) => {
            if (!colAbs) {
                const colNum = this.#colToNum(col);
                if (colNum > deletedColIndex) {
                    return `${colAbs}${this.#numToCol(colNum - 1)}${rowAbs}${row}`;
                } else if (colNum === deletedColIndex) {
                    // Reference to deleted column becomes error
                    return `#REF!`;
                }
            }
            return match;
        });
    }

    /**
     * Convert column letters to number (A=0, B=1, etc.)
     * @param {string} col
     * @returns {number}
     */
    #colToNum(col) {
        let num = 0;
        for (let i = 0; i < col.length; i++) {
            num = num * 26 + (col.charCodeAt(i) - 64);
        }
        return num - 1;
    }

    /**
     * Convert number to column letters
     * @param {number} num
     * @returns {string}
     */
    #numToCol(num) {
        let col = '';
        num++;
        while (num > 0) {
            num--;
            col = String.fromCharCode(65 + (num % 26)) + col;
            num = Math.floor(num / 26);
        }
        return col;
    }

    /**
     * Shift borders when a row is inserted
     * All borders (horizontal and vertical) with row >= rowIndex must have their row increased by 1.
     * No borders need to be deleted (the new row is empty).
     * @param {number} rowIndex
     */
    #shiftBordersForRowInsert(rowIndex) {
        if (!this.#bordersKV) return;

        const bordersToShift = [];
        for (const [key, { val: value }] of this.#bordersKV.map) {
            const [type, rowStr, colStr] = key.split(',');
            const row = Number(rowStr);
            const col = Number(colStr);
            if (row >= rowIndex) bordersToShift.push({ key, row, col, type, value });
        }

        bordersToShift.sort((a, b) => b.row - a.row);
        for (const { key, row, col, type, value } of bordersToShift) {
            this.#bordersKV.delete(key);
            this.#bordersKV.set(`${type},${row + 1},${col}`, value);
        }
    }

    /**
     * Shift borders when a column is inserted
     * All borders (horizontal and vertical) with col >= colIndex must have their col increased by 1.
     * No borders need to be deleted (the new column is empty).
     * @param {number} colIndex
     */
    #shiftBordersForColInsert(colIndex) {
        if (!this.#bordersKV) return;

        const bordersToShift = [];
        for (const [key, { val: value }] of this.#bordersKV.map) {
            const [type, rowStr, colStr] = key.split(',');
            const row = Number(rowStr);
            const col = Number(colStr);
            if (col >= colIndex) bordersToShift.push({ key, row, col, type, value });
        }

        bordersToShift.sort((a, b) => b.col - a.col);
        for (const { key, row, col, type, value } of bordersToShift) {
            this.#bordersKV.delete(key);
            this.#bordersKV.set(`${type},${row},${col + 1}`, value);
        }
    }

    /**
     * Shift borders when a row is deleted
     *
     * Horizontal borders:
     * - Delete the border that was the top edge of the deleted row: "h, rowIndex-1, *"
     * - Shift all horizontal borders with row >= rowIndex up by 1
     *
     * Vertical borders:
     * - Delete all vertical borders that belonged to the deleted row: "v, rowIndex, *"
     * - Shift all vertical borders with row > rowIndex up by 1
     *
     * @param {number} rowIndex
     */
    #shiftBordersForRowDelete(rowIndex) {
        if (!this.#bordersKV) return;

        const bordersToDelete = [];
        const bordersToShift = [];

        for (const [key, { val: value }] of this.#bordersKV.map) {
            const [type, rowStr, colStr] = key.split(',');
            const row = Number(rowStr);
            const col = Number(colStr);

            if (type === 'h') {
                if (row === rowIndex - 1) {
                    bordersToDelete.push(key);
                } else if (row >= rowIndex) {
                    bordersToShift.push({ key, newRow: row - 1, col, type, value });
                }
            } else if (type === 'v') {
                if (row === rowIndex) {
                    bordersToDelete.push(key);
                } else if (row > rowIndex) {
                    bordersToShift.push({ key, newRow: row - 1, col, type, value });
                }
            }
        }

        for (const key of bordersToDelete) this.#bordersKV.delete(key);

        bordersToShift.sort((a, b) => a.newRow - b.newRow);
        for (const { key, newRow, col, type, value } of bordersToShift) {
            this.#bordersKV.delete(key);
            this.#bordersKV.set(`${type},${newRow},${col}`, value);
        }
    }

    /**
     * Shift borders when a column is deleted
     *
     * Horizontal borders:
     * - Delete all horizontal borders in the deleted column: "h, *, colIndex"
     * - Shift all horizontal borders with col > colIndex left by 1
     *
     * Vertical borders:
     * - Delete the border that was the left edge of the deleted column: "v, *, colIndex-1"
     * - Shift all vertical borders with col >= colIndex left by 1
     *
     * @param {number} colIndex
     */
    #shiftBordersForColDelete(colIndex) {
        if (!this.#bordersKV) return;

        const bordersToDelete = [];
        const bordersToShift = [];

        for (const [key, { val: value }] of this.#bordersKV.map) {
            const [type, rowStr, colStr] = key.split(',');
            const row = Number(rowStr);
            const col = Number(colStr);

            if (type === 'h') {
                if (col === colIndex) {
                    bordersToDelete.push(key);
                } else if (col > colIndex) {
                    bordersToShift.push({ key, row, newCol: col - 1, type, value });
                }
            } else if (type === 'v') {
                if (col === colIndex - 1) {
                    bordersToDelete.push(key);
                } else if (col >= colIndex) {
                    bordersToShift.push({ key, row, newCol: col - 1, type, value });
                }
            }
        }

        for (const key of bordersToDelete) this.#bordersKV.delete(key);

        bordersToShift.sort((a, b) => a.newCol - b.newCol);
        for (const { key, row, newCol, type, value } of bordersToShift) {
            this.#bordersKV.delete(key);
            this.#bordersKV.set(`${type},${row},${newCol}`, value);
        }
    }

    /**
     * Shift row metadata when a row is inserted
     * @param {number} rowIndex
     */
    #shiftRowMetaForInsert(rowIndex) {
        if (!this.#rowMetaKV) return;
        const toShift = [];
        for (const [key, { val: data }] of this.#rowMetaKV.map) {
            const row = parseInt(key, 10);
            if (row >= rowIndex) toShift.push({ key, row, data });
        }
        toShift.sort((a, b) => b.row - a.row);
        for (const { key, row, data } of toShift) {
            this.#rowMetaKV.delete(key);
            this.#rowMetaKV.set(String(row + 1), data);
        }
    }

    /**
     * Shift column metadata when a column is inserted
     * @param {number} colIndex
     */
    #shiftColMetaForInsert(colIndex) {
        if (!this.#colMetaKV) return;
        const toShift = [];
        for (const [key, { val: data }] of this.#colMetaKV.map) {
            const col = parseInt(key, 10);
            if (col >= colIndex) toShift.push({ key, col, data });
        }
        toShift.sort((a, b) => b.col - a.col);
        for (const { key, col, data } of toShift) {
            this.#colMetaKV.delete(key);
            this.#colMetaKV.set(String(col + 1), data);
        }
    }

    /**
     * Shift row metadata when a row is deleted
     * @param {number} rowIndex
     */
    #shiftRowMetaForDelete(rowIndex) {
        if (!this.#rowMetaKV) return;
        this.#rowMetaKV.delete(String(rowIndex));
        const toShift = [];
        for (const [key, { val: data }] of this.#rowMetaKV.map) {
            const row = parseInt(key, 10);
            if (row > rowIndex) toShift.push({ key, row, data });
        }
        toShift.sort((a, b) => a.row - b.row);
        for (const { key, row, data } of toShift) {
            this.#rowMetaKV.delete(key);
            this.#rowMetaKV.set(String(row - 1), data);
        }
    }

    /**
     * Shift column metadata when a column is deleted
     * @param {number} colIndex
     */
    #shiftColMetaForDelete(colIndex) {
        if (!this.#colMetaKV) return;
        this.#colMetaKV.delete(String(colIndex));
        const toShift = [];
        for (const [key, { val: data }] of this.#colMetaKV.map) {
            const col = parseInt(key, 10);
            if (col > colIndex) toShift.push({ key, col, data });
        }
        toShift.sort((a, b) => a.col - b.col);
        for (const { key, col, data } of toShift) {
            this.#colMetaKV.delete(key);
            this.#colMetaKV.set(String(col - 1), data);
        }
    }

    /**
     * Shift tables coordinates
     * @param {'row'|'col'} axis
     * @param {number} atIndex
     * @param {number} delta
     */
    #shiftTables(axis, atIndex, delta) {
        const tables = this.#sheet.get('tables');
        if (!tables) return;

        const startKey = axis === 'row' ? 'startRow' : 'startCol';
        const vpStartKey = axis === 'row' ? 'vpStartRow' : 'vpStartCol';
        const vpEndKey = axis === 'row' ? 'vpEndRow' : 'vpEndCol';

        tables.forEach((tm) => {
            const mode = tm.get('mode') ?? 'inline';
            const start = tm.get(startKey);

            if (delta > 0) {
                if (start >= atIndex) tm.set(startKey, start + delta);
            } else {
                if (start > atIndex) tm.set(startKey, start + delta);
                else if (start === atIndex && axis === 'col') {
                    // Column deletion might affect table width, but we don't have endCol for inline
                }
            }

            if (mode === 'viewport') {
                const vpStart = tm.get(vpStartKey);
                const vpEnd = tm.get(vpEndKey);
                if (vpStart === undefined || vpEnd === undefined) return;

                if (delta > 0) {
                    if (vpStart >= atIndex) {
                        tm.set(vpStartKey, vpStart + delta);
                        tm.set(vpEndKey, vpEnd + delta);
                    } else if (vpEnd >= atIndex) {
                        tm.set(vpEndKey, vpEnd + delta);
                    }
                } else {
                    if (vpStart > atIndex) {
                        tm.set(vpStartKey, vpStart + delta);
                        tm.set(vpEndKey, vpEnd + delta);
                    } else if (vpStart <= atIndex && vpEnd >= atIndex) {
                        tm.set(vpEndKey, Math.max(vpStart, vpEnd + delta));
                    }
                }
            }
        });
    }

    /**
     * Shift repeaters coordinates
     * @param {'row'|'col'} axis
     * @param {number} atIndex
     * @param {number} delta
     */
    #shiftRepeaters(axis, atIndex, delta) {
        const repeaters = this.#sheet.get('repeaters');
        if (!repeaters) return;

        const startKey = axis === 'row' ? 'templateStartRow' : 'templateStartCol';
        const endKey = axis === 'row' ? 'templateEndRow' : 'templateEndCol';
        const vpStartKey = axis === 'row' ? 'vpStartRow' : 'vpStartCol';
        const vpEndKey = axis === 'row' ? 'vpEndRow' : 'vpEndCol';

        repeaters.forEach((rm) => {
            const mode = rm.get('mode') ?? 'inline';
            const start = rm.get(startKey);
            const end = rm.get(endKey);

            if (delta > 0) {
                if (start >= atIndex) {
                    rm.set(startKey, start + delta);
                    rm.set(endKey, end + delta);
                } else if (end >= atIndex) {
                    rm.set(endKey, end + delta);
                }
            } else {
                if (start > atIndex) {
                    rm.set(startKey, start + delta);
                    rm.set(endKey, end + delta);
                } else if (start <= atIndex && end >= atIndex) {
                    rm.set(endKey, Math.max(start, end + delta));
                }
            }

            if (mode === 'viewport') {
                const vpStart = rm.get(vpStartKey);
                const vpEnd = rm.get(vpEndKey);
                if (vpStart === undefined || vpEnd === undefined) return;

                if (delta > 0) {
                    if (vpStart >= atIndex) {
                        rm.set(vpStartKey, vpStart + delta);
                        rm.set(vpEndKey, vpEnd + delta);
                    } else if (vpEnd >= atIndex) {
                        rm.set(vpEndKey, vpEnd + delta);
                    }
                } else {
                    if (vpStart > atIndex) {
                        rm.set(vpStartKey, vpStart + delta);
                        rm.set(vpEndKey, vpEnd + delta);
                    } else if (vpStart <= atIndex && vpEnd >= atIndex) {
                        rm.set(vpEndKey, Math.max(vpStart, vpEnd + delta));
                    }
                }
            }
        });
    }

    /**
     * Get row height (returns default if not set)
     * @param {number} rowIndex
     * @returns {number}
     */
    getRowHeight(rowIndex) {
        return this.#rowMetaKV?.get(String(rowIndex))?.height ?? this.defaultRowHeight ?? 24;
    }

    /**
     * Set row height
     * @param {number} rowIndex
     * @param {number} height
     */
    setRowHeight(rowIndex, height) {
        if (!this.#rowMetaKV) return;
        this.#ydoc.transact(() => {
            const cur = this.#rowMetaKV.get(String(rowIndex)) ?? {};
            this.#rowMetaKV.set(String(rowIndex), { ...cur, height });
        });
    }

    /**
     * Get column width (returns default if not set)
     * @param {number} colIndex
     * @returns {number}
     */
    getColWidth(colIndex) {
        return this.#colMetaKV?.get(String(colIndex))?.width ?? this.defaultColWidth ?? 100;
    }

    /**
     * Set column width
     * @param {number} colIndex
     * @param {number} width
     */
    setColWidth(colIndex, width) {
        if (!this.#colMetaKV) return;
        this.#ydoc.transact(() => {
            const cur = this.#colMetaKV.get(String(colIndex)) ?? {};
            this.#colMetaKV.set(String(colIndex), { ...cur, width });
        });
    }

    /** @returns {Map<number, number>} All custom row heights (index → px) */
    getRowHeightsMap() {
        const result = new Map();
        if (!this.#rowMetaKV) return result;
        for (const [key, { val: data }] of this.#rowMetaKV.map) {
            if (data?.height !== undefined) result.set(parseInt(key, 10), data.height);
        }
        return result;
    }

    /** @returns {Map<number, number>} All custom column widths (index → px) */
    getColWidthsMap() {
        const result = new Map();
        if (!this.#colMetaKV) return result;
        for (const [key, { val: data }] of this.#colMetaKV.map) {
            if (data?.width !== undefined) result.set(parseInt(key, 10), data.width);
        }
        return result;
    }

    // --- Merges ---

    /**
     * Merge a rectangular range of cells.
     * @param {number} startRow
     * @param {number} startCol
     * @param {number} endRow
     * @param {number} endCol
     */
    mergeCells(startRow, startCol, endRow, endCol) {
        this.mergeEngine.mergeCells(startRow, startCol, endRow, endCol);
    }

    /**
     * Unmerge the merge whose primary cell is at (startRow, startCol).
     * @param {number} startRow
     * @param {number} startCol
     */
    unmergeCells(startRow, startCol) {
        this.mergeEngine.unmergeCells(startRow, startCol);
    }

    /**
     * Get all merges (reactive, from MergeEngine)
     * @returns {Array<Object>}
     */
    getMerges() {
        return this.mergeEngine.merges;
    }

    /**
     * Find merge containing a cell (O(1) via MergeEngine index)
     * @param {number} row
     * @param {number} col
     * @returns {Object | null}
     */
    getMergeAt(row, col) {
        return this.mergeEngine.getMergeAt(row, col);
    }

    // --- Conditional Formats ---

    /**
     * Get all conditional format rules
     * @returns {Array<Y.Map>}
     */
    getConditionalFormats() {
        const cf = this.#sheet.get('conditionalFormats');
        return cf ? cf.toArray() : [];
    }

    // --- Borders (Edge-based) ---

    /**
     * Get borders for a specific cell by looking up edge keys
     * @param {number} row
     * @param {number} col
     * @returns {Object} { top, bottom, left, right } - each is border style or null
     */
    getCellBorders(row, col) {
        const cacheKey = `${row},${col}`;
        const cached = this.#cellBorderCache.get(cacheKey);
        if (cached) return cached;

        const borders = {
            top:    this.#bordersKV?.get(`h,${row - 1},${col}`) || null,
            bottom: this.#bordersKV?.get(`h,${row},${col}`) || null,
            left:   this.#bordersKV?.get(`v,${row},${col - 1}`) || null,
            right:  this.#bordersKV?.get(`v,${row},${col}`) || null,
        };

        this.#cellBorderCache.set(cacheKey, borders);
        return borders;
    }

    /**
     * Set a border on a specific edge
     * @param {string} edgeKey - "h,row,col" or "v,row,col"
     * @param {Object | null} style - { style, width, color } or null to remove
     */
    setBorder(edgeKey, style) {
        if (!this.#bordersKV) return;
        this.#ydoc.transact(() => {
            if (style === null) {
                this.#bordersKV.delete(edgeKey);
            } else {
                this.#bordersKV.set(edgeKey, style);
            }
        });
    }

    /**
     * Apply multiple borders at once (for border picker operations)
     * @param {Array<Object>} instructions - Array of { edgeKey, style }
     */
    applyBorders(instructions) {
        if (!this.#bordersKV) return;
        this.#ydoc.transact(() => {
            for (const { edgeKey, style } of instructions) {
                if (style === null) {
                    this.#bordersKV.delete(edgeKey);
                } else {
                    this.#bordersKV.set(edgeKey, style);
                }
            }
        });
    }

    /**
     * Clear all borders in a range
     * @param {number} startRow
     * @param {number} endRow
     * @param {number} startCol
     * @param {number} endCol
     */
    clearBordersInRange(startRow, endRow, startCol, endCol) {
        if (!this.#bordersKV) return;

        const keysToDelete = [];

        for (let r = startRow - 1; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                const key = `h,${r},${c}`;
                if (this.#bordersKV.has(key)) keysToDelete.push(key);
            }
        }

        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol - 1; c <= endCol; c++) {
                const key = `v,${r},${c}`;
                if (this.#bordersKV.has(key)) keysToDelete.push(key);
            }
        }

        this.#ydoc.transact(() => {
            for (const key of keysToDelete) this.#bordersKV.delete(key);
        });
    }

    // --- Conditional Formatting ---

    /**
     * Get all conditional format rules for this sheet.
     * Returns a plain JS array of rule objects.
     * @returns {Array<Object>}
     */
    getConditionalFormats() {
        const arr = this.#sheet.get('conditionalFormats');
        if (!arr) return [];
        return arr.toArray();
    }

    /**
     * Add a conditional format rule.
     * Rule: { id, startRow, startCol, endRow, endCol, condition, threshold, style }
     * @param {Object} rule
     */
    addConditionalFormat(rule) {
        this.#ydoc.transact(() => {
            let arr = this.#sheet.get('conditionalFormats');
            if (!arr) {
                arr = new Y.Array();
                this.#sheet.set('conditionalFormats', arr);
            }
            arr.push([rule]);
        });
        this.cfVersion++;
    }

    /**
     * Update a conditional format rule by id.
     * @param {string} id
     * @param {Object} updates
     */
    updateConditionalFormat(id, updates) {
        this.#ydoc.transact(() => {
            const arr = this.#sheet.get('conditionalFormats');
            if (!arr) return;
            const rules = arr.toArray();
            const idx = rules.findIndex(r => r.id === id);
            if (idx === -1) return;
            arr.delete(idx, 1);
            arr.insert(idx, [{ ...rules[idx], ...updates }]);
        });
        this.cfVersion++;
    }

    /**
     * Delete a conditional format rule by id.
     * @param {string} id
     */
    deleteConditionalFormat(id) {
        this.#ydoc.transact(() => {
            const arr = this.#sheet.get('conditionalFormats');
            if (!arr) return;
            const rules = arr.toArray();
            const idx = rules.findIndex(r => r.id === id);
            if (idx !== -1) arr.delete(idx, 1);
        });
        this.cfVersion++;
    }

    // --- Data Validation ---

    /**
     * Get all data validation rules for this sheet.
     * @returns {Array<Object>}
     */
    getDataValidations() {
        const arr = this.#sheet.get('dataValidations');
        if (!arr) return [];
        return arr.toArray();
    }

    /**
     * Add a data validation rule.
     * Rule: { id, startRow, startCol, endRow, endCol, type, options, message, strict }
     * @param {Object} rule
     */
    addDataValidation(rule) {
        this.#ydoc.transact(() => {
            let arr = this.#sheet.get('dataValidations');
            if (!arr) {
                arr = new Y.Array();
                this.#sheet.set('dataValidations', arr);
            }
            arr.push([rule]);
        });
    }

    /**
     * Update a data validation rule by id.
     * @param {string} id
     * @param {Object} updates
     */
    updateDataValidation(id, updates) {
        this.#ydoc.transact(() => {
            const arr = this.#sheet.get('dataValidations');
            if (!arr) return;
            const rules = arr.toArray();
            const idx = rules.findIndex(r => r.id === id);
            if (idx === -1) return;
            arr.delete(idx, 1);
            arr.insert(idx, [{ ...rules[idx], ...updates }]);
        });
    }

    /**
     * Delete a data validation rule by id.
     * @param {string} id
     */
    deleteDataValidation(id) {
        this.#ydoc.transact(() => {
            const arr = this.#sheet.get('dataValidations');
            if (!arr) return;
            const rules = arr.toArray();
            const idx = rules.findIndex(r => r.id === id);
            if (idx !== -1) arr.delete(idx, 1);
        });
    }

    /**
     * Clear all formatting from a range of cells (keeps values).
     * @param {number} startRow
     * @param {number} startCol
     * @param {number} endRow
     * @param {number} endCol
     */
    clearRangeFormatting(startRow, startCol, endRow, endCol) {
        this.#ydoc.transact(() => {
            for (const [key] of (this.#cellStylesKV?.map ?? [])) {
                const [r, c] = key.split(',').map(Number);
                if (r >= startRow && r <= endRow && c >= startCol && c <= endCol) {
                    this.#cellStylesKV.delete(key);
                }
            }
        });
    }

    /**
     * Adjust formula references by a row/col offset (relative refs only).
     * @param {string} formula
     * @param {number} rowOffset
     * @param {number} colOffset
     * @returns {string}
     */
    #adjustFormulaByOffset(formula, rowOffset, colOffset) {
        if (rowOffset === 0 && colOffset === 0) return formula;
        return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, col, rowAbs, row) => {
            const colNum = this.#colToNum(col);
            const rowNum = parseInt(row, 10);
            const newCol = colAbs ? col : this.#numToCol(colNum + colOffset);
            const newRow = rowAbs ? row : String(rowNum + rowOffset);
            return `${colAbs}${newCol}${rowAbs}${newRow}`;
        });
    }

    /**
     * Fill down: copy source row values+formatting down through the range.
     * @param {number} startRow  source row
     * @param {number} startCol
     * @param {number} endRow
     * @param {number} endCol
     */
    fillDown(startRow, startCol, endRow, endCol) {
        this.#ydoc.transact(() => {
            for (let c = startCol; c <= endCol; c++) {
                const srcKey = `${startRow},${c}`;
                const srcData = this.#getCellData(srcKey);
                for (let r = startRow + 1; r <= endRow; r++) {
                    const dstKey = `${r},${c}`;
                    if (srcData) {
                        const data = { ...srcData };
                        if (data.v && typeof data.v === 'string' && data.v.startsWith('=')) {
                            data.v = this.#adjustFormulaByOffset(data.v, r - startRow, 0);
                        }
                        this.#setCellData(dstKey, data);
                    } else {
                        this.#deleteCellData(dstKey);
                    }
                }
            }
        });
    }

    /**
     * Fill right: copy source col values+formatting right through the range.
     * @param {number} startRow
     * @param {number} startCol  source col
     * @param {number} endRow
     * @param {number} endCol
     */
    fillRight(startRow, startCol, endRow, endCol) {
        this.#ydoc.transact(() => {
            for (let r = startRow; r <= endRow; r++) {
                const srcKey = `${r},${startCol}`;
                const srcData = this.#getCellData(srcKey);
                for (let c = startCol + 1; c <= endCol; c++) {
                    const dstKey = `${r},${c}`;
                    if (srcData) {
                        const data = { ...srcData };
                        if (data.v && typeof data.v === 'string' && data.v.startsWith('=')) {
                            data.v = this.#adjustFormulaByOffset(data.v, 0, c - startCol);
                        }
                        this.#setCellData(dstKey, data);
                    } else {
                        this.#deleteCellData(dstKey);
                    }
                }
            }
        });
    }

    // --- Print Settings ---

    /**
     * Get all print settings as a plain object.
     * @returns {Object}
     */
    getPrintSettings() {
        const ps = this.#sheet.get('printSettings');
        if (!ps) return {};
        const result = {};
        ps.forEach((v, k) => { result[k] = v; });
        return result;
    }

    /**
     * Merge updates into the print settings Y.Map.
     * @param {Object} updates  Key/value pairs to set
     */
    setPrintSettings(updates) {
        if (!updates || typeof updates !== 'object') return;
        this.#ydoc.transact(() => {
            let ps = this.#sheet.get('printSettings');
            if (!ps) {
                ps = new Y.Map();
                this.#sheet.set('printSettings', ps);
            }
            for (const [k, v] of Object.entries(updates)) {
                ps.set(k, v);
            }
        });
    }

    // --- Yjs Access (for advanced use) ---

    /**
     * Get the sheet's Y.Map
     * @returns {Y.Map}
     */
    getYMap() {
        return this.#sheet;
    }

    /** Expose cellValuesKV for external callers (e.g. SpreadsheetSession formula observer). */
    get cellValuesKV() { return this.#cellValuesKV; }

    // --- Lifecycle ---

    /**
     * Cleanup when no longer needed
     */
    destroy() {
        this.mergeEngine?.destroy();
        if (this.#cleanup) {
            this.#cleanup();
            this.#cleanup = null;
        }
    }
}

export default SheetStore;
