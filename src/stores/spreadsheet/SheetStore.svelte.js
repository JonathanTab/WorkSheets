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
import { createCellYMap } from './schema.js';
import {
    CELL_KEYS,
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

    /** @type {Y.Map} Y.Map<string, Y.Map> - key is "row,col", value is cell Y.Map */
    #cells;

    /** @type {Y.Map} Y.Map<string, Object> - key is "h,row,col" or "v,row,col", value is border style */
    #borders;

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

    // --- Reactive Border Version ---
    // Incremented when borders change to trigger re-renders
    bordersVersion = $state(0);

    // --- Metadata Version Tracking ---
    // Incremented when row heights or column widths change for cache invalidation
    rowMetaVersion = $state(0);
    colMetaVersion = $state(0);

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
        this.#cells = sheet.get('cells');
        this.#borders = sheet.get('borders');

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
    }

    #syncAllCells() {
        // Build initial state map from Y.Map
        const newCells = new Map();

        this.#cells.forEach((cellYMap, key) => {
            newCells.set(key, this.#processCellYMap(cellYMap));
        });

        // Assign to reactive state
        this.cells = newCells;
    }

    #processCellYMap(cellMap) {
        // Extract only what we need for rendering
        // Reading from Y.Map is synchronous
        // Note: v may contain a formula (starting with "=") or a raw value
        return {
            v: cellMap.get(CELL_KEYS.VALUE),
            t: cellMap.get(CELL_KEYS.TYPE),
            ct: cellMap.get(CELL_TYPE_CONFIG_KEY),
            // Formatting
            fontFamily: cellMap.get('fontFamily'),
            fontSize: cellMap.get('fontSize'),
            bold: cellMap.get('bold'),
            italic: cellMap.get('italic'),
            underline: cellMap.get('underline'),
            strikethrough: cellMap.get('strikethrough'),
            color: cellMap.get('color'),
            backgroundColor: cellMap.get('backgroundColor'),
            border: cellMap.get('border'),
            horizontalAlign: cellMap.get('horizontalAlign'),
            verticalAlign: cellMap.get('verticalAlign'),
            wrapText: cellMap.get('wrapText'),
            numberFormat: cellMap.get('numberFormat'),
            exists: true
        };
    }

    #setupObservers() {
        // 1. Observe Sheet Props
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
        };
        this.#sheet.observe(sheetObserver);

        // 2. Observe Cells Y.Map directly
        const cellObserver = (event) => {
            // Handle changes to the cells map
            event.changes.keys.forEach((change, key) => {
                if (change.action === 'add' || change.action === 'update') {
                    const cellYMap = this.#cells.get(key);
                    if (cellYMap) {
                        this.cells.set(key, this.#processCellYMap(cellYMap));
                    }
                } else if (change.action === 'delete') {
                    this.cells.delete(key);
                }
            });
        };

        // 3. Observe cell content changes deeply (for property updates within cells)
        const cellContentObserver = (events) => {
            for (const event of events) {
                // Check if this is a change to a cell's content (not the cells map itself)
                if (event.path.length > 0 && event.target !== this.#cells) {
                    const cellKey = event.path[0];
                    if (typeof cellKey !== 'string') continue;

                    const cellYMap = this.#cells.get(cellKey);
                    if (cellYMap) {
                        this.cells.set(cellKey, this.#processCellYMap(cellYMap));
                    }
                }
            }
        };

        this.#cells.observe(cellObserver);
        this.#cells.observeDeep(cellContentObserver);

        // 4. Observe Borders Y.Map for reactivity
        const bordersObserver = () => {
            // Increment version to trigger re-renders in Grid
            this.bordersVersion++;
            this.#cellBorderCache.clear();
        };
        this.#borders.observe(bordersObserver);

        this.#cleanup = () => {
            this.#sheet.unobserve(sheetObserver);
            this.#cells.unobserve(cellObserver);
            this.#cells.unobserveDeep(cellContentObserver);
            this.#borders.unobserve(bordersObserver);
        };
    }

    // --- Public API ---

    /**
     * Get a cell's reactive state.
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
        return this.#cells.has(key);
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
            let cellMap = this.#cells.get(key);
            if (value === '' || value === null || value === undefined) {
                if (cellMap) {
                    // If cell has other properties (formatting), just clear the value
                    const hasOtherProps = Array.from(cellMap.keys()).some(
                        k => k !== CELL_KEYS.VALUE
                    );
                    if (hasOtherProps) {
                        cellMap.delete(CELL_KEYS.VALUE);
                    } else {
                        this.#cells.delete(key);
                    }
                }
            } else {
                if (!cellMap) {
                    cellMap = createCellYMap({ v: value });
                    this.#cells.set(key, cellMap);
                } else {
                    cellMap.set(CELL_KEYS.VALUE, value);
                }
            }
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
            // If formula is empty/null, clear the cell
            if (!formula || formula === '') {
                const cellMap = this.#cells.get(key);
                if (cellMap) {
                    // If cell has other properties (formatting), just clear the value
                    const hasOtherProps = Array.from(cellMap.keys()).some(
                        k => k !== CELL_KEYS.VALUE
                    );
                    if (hasOtherProps) {
                        cellMap.delete(CELL_KEYS.VALUE);
                    } else {
                        this.#cells.delete(key);
                    }
                }
                return;
            }

            // Ensure formula starts with =
            const normalizedFormula = formula.startsWith('=') ? formula : '=' + formula;

            // Set the formula as the value
            let cellMap = this.#cells.get(key);
            if (!cellMap) {
                cellMap = createCellYMap({ v: normalizedFormula });
                this.#cells.set(key, cellMap);
            } else {
                cellMap.set(CELL_KEYS.VALUE, normalizedFormula);
            }
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
            let cellMap = this.#cells.get(key);
            if (!cellMap) {
                cellMap = createCellYMap(props);
                this.#cells.set(key, cellMap);
            } else {
                for (const [k, v] of Object.entries(props)) {
                    if (v === undefined) cellMap.delete(k);
                    else cellMap.set(k, v);
                }
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
            this.#cells.delete(key);
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

        const rowMeta = this.#sheet.get('rowMeta');
        const rMeta = rowMeta?.get(String(row));
        if (rMeta?.has(CELL_TYPE_CONFIG_KEY)) return rMeta.get(CELL_TYPE_CONFIG_KEY);

        const colMeta = this.#sheet.get('colMeta');
        const cMeta = colMeta?.get(String(col));
        if (cMeta?.has(CELL_TYPE_CONFIG_KEY)) return cMeta.get(CELL_TYPE_CONFIG_KEY);

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
     * Set column-level type config
     * @param {number} col
     * @param {Object} ct
     */
    setColTypeConfig(col, ct) {
        let colMeta = this.#sheet.get('colMeta');
        if (!colMeta) {
            colMeta = new Y.Map();
            this.#sheet.set('colMeta', colMeta);
        }

        this.#ydoc.transact(() => {
            let meta = colMeta.get(String(col));
            if (!meta) {
                meta = new Y.Map();
                colMeta.set(String(col), meta);
            }
            if (ct === null) meta.delete(CELL_TYPE_CONFIG_KEY);
            else meta.set(CELL_TYPE_CONFIG_KEY, ct);
        });
        this.colMetaVersion++;
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
            this.#cells.forEach((cellYMap, key) => {
                const [row, col] = key.split(',').map(Number);
                if (row >= rowIndex) {
                    cellsToShift.push({ key, row, col, cellYMap });
                }
            });

            // Delete old keys and create new ones (in reverse order to avoid overwrites)
            cellsToShift.sort((a, b) => b.row - a.row);
            for (const { key, row, col, cellYMap } of cellsToShift) {
                const newKey = `${row + 1},${col}`;
                const cellData = this.#processCellYMapToData(cellYMap);

                // Adjust formula references if the cell contains a formula
                if (cellData.v && typeof cellData.v === 'string' && cellData.v.startsWith('=')) {
                    cellData.v = this.#adjustFormulaForRowInsert(cellData.v, rowIndex);
                }

                // Delete old cell and create new one
                this.#cells.delete(key);
                const newCellMap = createCellYMap(cellData);
                this.#cells.set(newKey, newCellMap);
            }

            // 2. Shift borders
            this.#shiftBordersForRowInsert(rowIndex);

            // 3. Shift row metadata
            this.#shiftRowMetaForInsert(rowIndex);

            // 4. Shift features (merges, tables, repeaters)
            this.mergeEngine.shiftAxes('row', rowIndex, 1);
            this.#shiftTables('row', rowIndex, 1);
            this.#shiftRepeaters('row', rowIndex, 1);

            // 5. Increment rowCount
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
            this.#cells.forEach((cellYMap, key) => {
                const [row, col] = key.split(',').map(Number);
                if (col >= colIndex) {
                    cellsToShift.push({ key, row, col, cellYMap });
                }
            });

            // Delete old keys and create new ones (in reverse order by column to avoid overwrites)
            cellsToShift.sort((a, b) => b.col - a.col);
            for (const { key, row, col, cellYMap } of cellsToShift) {
                const newKey = `${row},${col + 1}`;
                const cellData = this.#processCellYMapToData(cellYMap);

                // Adjust formula references if the cell contains a formula
                if (cellData.v && typeof cellData.v === 'string' && cellData.v.startsWith('=')) {
                    cellData.v = this.#adjustFormulaForColInsert(cellData.v, colIndex);
                }

                // Delete old cell and create new one
                this.#cells.delete(key);
                const newCellMap = createCellYMap(cellData);
                this.#cells.set(newKey, newCellMap);
            }

            // 2. Shift borders
            this.#shiftBordersForColInsert(colIndex);

            // 3. Shift column metadata
            this.#shiftColMetaForInsert(colIndex);

            // 4. Shift features
            this.mergeEngine.shiftAxes('col', colIndex, 1);
            this.#shiftTables('col', colIndex, 1);
            this.#shiftRepeaters('col', colIndex, 1);

            // 5. Increment colCount
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
            const keysToDelete = [];
            this.#cells.forEach((cellYMap, key) => {
                const [row, col] = key.split(',').map(Number);
                if (row === rowIndex) {
                    keysToDelete.push(key);
                }
            });
            for (const key of keysToDelete) {
                this.#cells.delete(key);
            }

            // 2. Shift all cells below rowIndex up by 1
            const cellsToShift = [];
            this.#cells.forEach((cellYMap, key) => {
                const [row, col] = key.split(',').map(Number);
                if (row > rowIndex) {
                    cellsToShift.push({ key, row, col, cellYMap });
                }
            });

            // Shift cells up (in forward order since we're moving up)
            cellsToShift.sort((a, b) => a.row - b.row);
            for (const { key, row, col, cellYMap } of cellsToShift) {
                const newKey = `${row - 1},${col}`;
                const cellData = this.#processCellYMapToData(cellYMap);

                // Adjust formula references
                if (cellData.v && typeof cellData.v === 'string' && cellData.v.startsWith('=')) {
                    cellData.v = this.#adjustFormulaForRowDelete(cellData.v, rowIndex);
                }

                // Delete old cell and create new one
                this.#cells.delete(key);
                const newCellMap = createCellYMap(cellData);
                this.#cells.set(newKey, newCellMap);
            }

            // 3. Shift borders
            this.#shiftBordersForRowDelete(rowIndex);

            // 4. Shift row metadata
            this.#shiftRowMetaForDelete(rowIndex);

            // 5. Shift features
            this.mergeEngine.shiftAxes('row', rowIndex, -1);
            this.#shiftTables('row', rowIndex, -1);
            this.#shiftRepeaters('row', rowIndex, -1);

            // 6. Decrement rowCount
            const currentRowCount = this.#sheet.get('rowCount') ?? DEFAULT_ROW_COUNT;
            this.#sheet.set('rowCount', Math.max(1, currentRowCount - 1));
        });
    }

    /**
     * Delete a column at the specified index (shifts existing columns left)
     * @param {number} colIndex - The index of the column to delete
     */
    deleteColumnAt(colIndex) {
        this.#ydoc.transact(() => {
            // 1. Delete all cells in the column
            const keysToDelete = [];
            this.#cells.forEach((cellYMap, key) => {
                const [row, col] = key.split(',').map(Number);
                if (col === colIndex) {
                    keysToDelete.push(key);
                }
            });
            for (const key of keysToDelete) {
                this.#cells.delete(key);
            }

            // 2. Shift all cells to the right of colIndex left by 1
            const cellsToShift = [];
            this.#cells.forEach((cellYMap, key) => {
                const [row, col] = key.split(',').map(Number);
                if (col > colIndex) {
                    cellsToShift.push({ key, row, col, cellYMap });
                }
            });

            // Shift cells left (in forward order by column)
            cellsToShift.sort((a, b) => a.col - b.col);
            for (const { key, row, col, cellYMap } of cellsToShift) {
                const newKey = `${row},${col - 1}`;
                const cellData = this.#processCellYMapToData(cellYMap);

                // Adjust formula references
                if (cellData.v && typeof cellData.v === 'string' && cellData.v.startsWith('=')) {
                    cellData.v = this.#adjustFormulaForColDelete(cellData.v, colIndex);
                }

                // Delete old cell and create new one
                this.#cells.delete(key);
                const newCellMap = createCellYMap(cellData);
                this.#cells.set(newKey, newCellMap);
            }

            // 3. Shift borders
            this.#shiftBordersForColDelete(colIndex);

            // 4. Shift column metadata
            this.#shiftColMetaForDelete(colIndex);

            // 5. Shift features
            this.mergeEngine.shiftAxes('col', colIndex, -1);
            this.#shiftTables('col', colIndex, -1);
            this.#shiftRepeaters('col', colIndex, -1);

            // 6. Decrement colCount
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
            const cellMap = this.#cells.get(key);
            if (cellMap) {
                cellMap.delete(CELL_KEYS.VALUE);
            }
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
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }

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
                this.#borders.delete(edgeKey);
            } else {
                this.#borders.set(edgeKey, style);
            }
        });
    }

    // --- Helper methods for insert/delete operations ---

    /**
     * Extract all data from a cell Y.Map as a plain object
     * @param {Y.Map} cellYMap
     * @returns {Object}
     */
    #processCellYMapToData(cellYMap) {
        const data = {};
        cellYMap.forEach((value, key) => {
            data[key] = value;
        });
        return data;
    }

    /**
     * Adjust formula references when a row is inserted
     * @param {string} formula
     * @param {number} insertedRowIndex
     * @returns {string}
     */
    #adjustFormulaForRowInsert(formula, insertedRowIndex) {
        return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, col, rowAbs, row) => {
            const rowNum = parseInt(row, 10);
            // Adjust if row reference is at or below the inserted row (and not absolute)
            if (!rowAbs && rowNum >= insertedRowIndex) {
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
        return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, col, rowAbs, row) => {
            const rowNum = parseInt(row, 10);
            if (!rowAbs) {
                if (rowNum > deletedRowIndex) {
                    return `${colAbs}${col}${rowAbs}${rowNum - 1}`;
                } else if (rowNum === deletedRowIndex) {
                    // Reference to deleted row becomes error
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
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }
        if (!this.#borders) return;

        const bordersToShift = [];

        this.#borders.forEach((value, key) => {
            const [type, rowStr, colStr] = key.split(',');
            const row = Number(rowStr);
            const col = Number(colStr);

            if (row >= rowIndex) {
                bordersToShift.push({ key, row, col, type, value });
            }
        });

        // Shift borders down (in reverse order by row to avoid key collisions)
        bordersToShift.sort((a, b) => b.row - a.row);
        for (const { key, row, col, type, value } of bordersToShift) {
            this.#borders.delete(key);
            this.#borders.set(`${type},${row + 1},${col}`, value);
        }
    }

    /**
     * Shift borders when a column is inserted
     * All borders (horizontal and vertical) with col >= colIndex must have their col increased by 1.
     * No borders need to be deleted (the new column is empty).
     * @param {number} colIndex
     */
    #shiftBordersForColInsert(colIndex) {
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }
        if (!this.#borders) return;

        const bordersToShift = [];

        this.#borders.forEach((value, key) => {
            const [type, rowStr, colStr] = key.split(',');
            const row = Number(rowStr);
            const col = Number(colStr);

            if (col >= colIndex) {
                bordersToShift.push({ key, row, col, type, value });
            }
        });

        // Shift borders right (in reverse order by col to avoid key collisions)
        bordersToShift.sort((a, b) => b.col - a.col);
        for (const { key, row, col, type, value } of bordersToShift) {
            this.#borders.delete(key);
            this.#borders.set(`${type},${row},${col + 1}`, value);
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
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }
        if (!this.#borders) return;

        const bordersToDelete = [];
        const bordersToShift = [];

        this.#borders.forEach((value, key) => {
            const [type, rowStr, colStr] = key.split(',');
            const row = Number(rowStr);
            const col = Number(colStr);

            if (type === 'h') {
                if (row === rowIndex - 1) {
                    // Top border of the deleted row – remove it
                    bordersToDelete.push(key);
                } else if (row >= rowIndex) {
                    // Horizontal borders below the deleted row – shift up
                    bordersToShift.push({ key, newRow: row - 1, col, type, value });
                }
            } else if (type === 'v') {
                if (row === rowIndex) {
                    // Vertical borders exactly on the deleted row – remove them
                    bordersToDelete.push(key);
                } else if (row > rowIndex) {
                    // Vertical borders for rows below – shift up
                    bordersToShift.push({ key, newRow: row - 1, col, type, value });
                }
            }
        });

        // Delete obsolete borders
        for (const key of bordersToDelete) {
            this.#borders.delete(key);
        }

        // Shift remaining borders (in forward order since we're moving up)
        bordersToShift.sort((a, b) => a.newRow - b.newRow);
        for (const { key, newRow, col, type, value } of bordersToShift) {
            this.#borders.delete(key);
            this.#borders.set(`${type},${newRow},${col}`, value);
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
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }
        if (!this.#borders) return;

        const bordersToDelete = [];
        const bordersToShift = [];

        this.#borders.forEach((value, key) => {
            const [type, rowStr, colStr] = key.split(',');
            const row = Number(rowStr);
            const col = Number(colStr);

            if (type === 'h') {
                if (col === colIndex) {
                    // Horizontal borders in the deleted column – remove them
                    bordersToDelete.push(key);
                } else if (col > colIndex) {
                    // Horizontal borders to the right – shift left
                    bordersToShift.push({ key, row, newCol: col - 1, type, value });
                }
            } else if (type === 'v') {
                if (col === colIndex - 1) {
                    // Left border of the deleted column – remove it
                    bordersToDelete.push(key);
                } else if (col >= colIndex) {
                    // Vertical borders to the right – shift left
                    bordersToShift.push({ key, row, newCol: col - 1, type, value });
                }
            }
        });

        // Delete obsolete borders
        for (const key of bordersToDelete) {
            this.#borders.delete(key);
        }

        // Shift remaining borders (in forward order since we're moving left)
        bordersToShift.sort((a, b) => a.newCol - b.newCol);
        for (const { key, row, newCol, type, value } of bordersToShift) {
            this.#borders.delete(key);
            this.#borders.set(`${type},${row},${newCol}`, value);
        }
    }

    /**
     * Shift row metadata when a row is inserted
     * @param {number} rowIndex
     */
    #shiftRowMetaForInsert(rowIndex) {
        const rowMeta = this.#sheet.get('rowMeta');
        if (!rowMeta) return;

        // Collect metadata for rows at or below the inserted row
        const metaToShift = [];
        rowMeta.forEach((meta, key) => {
            const row = parseInt(key, 10);
            if (row >= rowIndex) {
                metaToShift.push({ key, row, data: meta.toJSON() });
            }
        });

        // Shift metadata down (in reverse order)
        metaToShift.sort((a, b) => b.row - a.row);
        for (const { key, row, data } of metaToShift) {
            rowMeta.delete(key);
            const newMeta = new Y.Map();
            for (const [k, v] of Object.entries(data)) {
                newMeta.set(k, v);
            }
            rowMeta.set(String(row + 1), newMeta);
        }
    }

    /**
     * Shift column metadata when a column is inserted
     * @param {number} colIndex
     */
    #shiftColMetaForInsert(colIndex) {
        const colMeta = this.#sheet.get('colMeta');
        if (!colMeta) return;

        // Collect metadata for columns at or to the right of the inserted column
        const metaToShift = [];
        colMeta.forEach((meta, key) => {
            const col = parseInt(key, 10);
            if (col >= colIndex) {
                metaToShift.push({ key, col, data: meta.toJSON() });
            }
        });

        // Shift metadata right (in reverse order)
        metaToShift.sort((a, b) => b.col - a.col);
        for (const { key, col, data } of metaToShift) {
            colMeta.delete(key);
            const newMeta = new Y.Map();
            for (const [k, v] of Object.entries(data)) {
                newMeta.set(k, v);
            }
            colMeta.set(String(col + 1), newMeta);
        }
    }

    /**
     * Shift row metadata when a row is deleted
     * @param {number} rowIndex
     */
    #shiftRowMetaForDelete(rowIndex) {
        const rowMeta = this.#sheet.get('rowMeta');
        if (!rowMeta) return;

        // Delete metadata for the deleted row
        rowMeta.delete(String(rowIndex));

        // Shift metadata up for rows below the deleted row
        const metaToShift = [];
        rowMeta.forEach((meta, key) => {
            const row = parseInt(key, 10);
            if (row > rowIndex) {
                metaToShift.push({ key, row, data: meta.toJSON() });
            }
        });

        metaToShift.sort((a, b) => a.row - b.row);
        for (const { key, row, data } of metaToShift) {
            rowMeta.delete(key);
            const newMeta = new Y.Map();
            for (const [k, v] of Object.entries(data)) {
                newMeta.set(k, v);
            }
            rowMeta.set(String(row - 1), newMeta);
        }
    }

    /**
     * Shift column metadata when a column is deleted
     * @param {number} colIndex
     */
    #shiftColMetaForDelete(colIndex) {
        const colMeta = this.#sheet.get('colMeta');
        if (!colMeta) return;

        // Delete metadata for the deleted column
        colMeta.delete(String(colIndex));

        // Shift metadata left for columns to the right of the deleted column
        const metaToShift = [];
        colMeta.forEach((meta, key) => {
            const col = parseInt(key, 10);
            if (col > colIndex) {
                metaToShift.push({ key, col, data: meta.toJSON() });
            }
        });

        metaToShift.sort((a, b) => a.col - b.col);
        for (const { key, col, data } of metaToShift) {
            colMeta.delete(key);
            const newMeta = new Y.Map();
            for (const [k, v] of Object.entries(data)) {
                newMeta.set(k, v);
            }
            colMeta.set(String(col - 1), newMeta);
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
        const rowMeta = this.#sheet.get('rowMeta');
        if (!rowMeta) return this.defaultRowHeight ?? 24;

        const meta = rowMeta.get(String(rowIndex));
        return meta?.get('height') ?? this.defaultRowHeight ?? 24;
    }

    /**
     * Set row height
     * @param {number} rowIndex
     * @param {number} height
     */
    setRowHeight(rowIndex, height) {
        let rowMeta = this.#sheet.get('rowMeta');
        if (!rowMeta) {
            rowMeta = new Y.Map();
            this.#sheet.set('rowMeta', rowMeta);
        }

        this.#ydoc.transact(() => {
            let meta = rowMeta.get(String(rowIndex));
            if (!meta) {
                meta = new Y.Map();
                rowMeta.set(String(rowIndex), meta);
            }
            meta.set('height', height);
        });

        // Increment version for position cache invalidation
        this.rowMetaVersion++;
    }

    /**
     * Get column width (returns default if not set)
     * @param {number} colIndex
     * @returns {number}
     */
    getColWidth(colIndex) {
        const colMeta = this.#sheet.get('colMeta');
        if (!colMeta) return this.defaultColWidth ?? 100;

        const meta = colMeta.get(String(colIndex));
        return meta?.get('width') ?? this.defaultColWidth ?? 100;
    }

    /**
     * Set column width
     * @param {number} colIndex
     * @param {number} width
     */
    setColWidth(colIndex, width) {
        let colMeta = this.#sheet.get('colMeta');
        if (!colMeta) {
            colMeta = new Y.Map();
            this.#sheet.set('colMeta', colMeta);
        }

        this.#ydoc.transact(() => {
            let meta = colMeta.get(String(colIndex));
            if (!meta) {
                meta = new Y.Map();
                colMeta.set(String(colIndex), meta);
            }
            meta.set('width', width);
        });

        // Increment version for position cache invalidation
        this.colMetaVersion++;
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
        // Ensure borders map exists
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }

        const cacheKey = `${row},${col}`;
        const cached = this.#cellBorderCache.get(cacheKey);
        if (cached) return cached;

        const borders = {
            // Horizontal edge above (row-1, col) = top border
            top: this.#borders?.get(`h,${row - 1},${col}`) || null,
            // Horizontal edge below (row, col) = bottom border
            bottom: this.#borders?.get(`h,${row},${col}`) || null,
            // Vertical edge left (row, col-1) = left border
            left: this.#borders?.get(`v,${row},${col - 1}`) || null,
            // Vertical edge right (row, col) = right border
            right: this.#borders?.get(`v,${row},${col}`) || null
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
        // Ensure borders map exists
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }

        this.#ydoc.transact(() => {
            if (style === null) {
                this.#borders.delete(edgeKey);
            } else {
                this.#borders.set(edgeKey, style);
            }
        });
    }

    /**
     * Apply multiple borders at once (for border picker operations)
     * @param {Array<Object>} instructions - Array of { edgeKey, style }
     */
    applyBorders(instructions) {
        // Ensure borders map exists
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }

        this.#ydoc.transact(() => {
            for (const { edgeKey, style } of instructions) {
                if (style === null) {
                    this.#borders.delete(edgeKey);
                } else {
                    this.#borders.set(edgeKey, style);
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
        // Ensure borders map exists
        if (!this.#borders) {
            this.#borders = this.#sheet.get('borders');
        }

        const keysToDelete = [];

        // Horizontal edges within the range
        for (let r = startRow - 1; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                const key = `h,${r},${c}`;
                if (this.#borders.has(key)) {
                    keysToDelete.push(key);
                }
            }
        }

        // Vertical edges within the range
        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol - 1; c <= endCol; c++) {
                const key = `v,${r},${c}`;
                if (this.#borders.has(key)) {
                    keysToDelete.push(key);
                }
            }
        }

        this.#ydoc.transact(() => {
            for (const key of keysToDelete) {
                this.#borders.delete(key);
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

    /**
     * Get the cells Y.Map
     * @returns {Y.Map}
     */
    getCells() {
        return this.#cells;
    }

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
