import { selectionState, spreadsheetSession } from "../../../stores/spreadsheetStore.svelte.js";
import { clipboardManager, CellTypeRegistry } from "../../../stores/spreadsheet/index.js";
import { CELL_TYPE } from "../../../stores/spreadsheet/features/SheetRenderContext.svelte.js";

// ─── Series detection constants ──────────────────────────────────────────────
const FILL_MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FILL_MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const FILL_DAYS_SHORT   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const FILL_DAYS_LONG    = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const FILL_CYCLIC_LISTS = [FILL_MONTHS_SHORT, FILL_MONTHS_LONG, FILL_DAYS_SHORT, FILL_DAYS_LONG];

/**
 * Given an array of source cell values, returns a series projection function
 * `(stepIndex) => value`, or null if no arithmetic/cyclic/suffix pattern is found.
 * stepIndex is the 0-based offset from srcRange start (negative for up/left fills).
 */
function detectFillSeries(rawValues) {
    const vals = rawValues.filter(v => v !== null && v !== undefined);
    if (vals.length === 0) return null;

    // 1. Number series
    if (vals.every(v => typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v))))) {
        const nums = vals.map(Number);
        const step = nums.length === 1 ? 1 : (nums[nums.length - 1] - nums[0]) / (nums.length - 1);
        const base = nums[0];
        return (si) => {
            const result = base + si * step;
            return Number.isInteger(step) ? Math.round(result) : result;
        };
    }

    // 2. Cyclic named lists (months, weekdays)
    for (const list of FILL_CYCLIC_LISTS) {
        const lower = list.map(s => s.toLowerCase());
        const indices = vals.map(v => (typeof v === 'string' ? lower.indexOf(v.toLowerCase()) : -1));
        if (indices.every(i => i >= 0)) {
            const baseIdx = indices[0];
            const step = indices.length > 1
                ? ((indices[1] - indices[0] + list.length) % list.length) || 1
                : 1;
            const n = list.length;
            return (si) => list[((baseIdx + si * step) % n + n) % n];
        }
    }

    // 3. String + number suffix (e.g. "Q1", "Q2", "Item 1", "Item 2")
    const SFX = /^(.*?)(\d+)(\D*)$/;
    const matches = vals.map(v => {
        if (typeof v !== 'string') return null;
        const m = v.match(SFX);
        return m ? { prefix: m[1], num: parseInt(m[2], 10), padLen: m[2].length, suffix: m[3] } : null;
    });
    if (matches.every(m => m !== null)) {
        const { prefix, padLen, suffix } = matches[0];
        if (matches.every(m => m.prefix === prefix && m.suffix === suffix)) {
            const nums = matches.map(m => m.num);
            const step = nums.length === 1 ? 1 : Math.round((nums[nums.length - 1] - nums[0]) / (nums.length - 1));
            return (si) => {
                const n = Math.round(nums[0] + si * step);
                const digits = String(Math.abs(n)).padStart(padLen, '0');
                return `${prefix}${n < 0 ? '-' : ''}${digits}${suffix}`;
            };
        }
    }

    return null;
}

/**
 * Handles fill-handle drag gestures and the applyFill operation for the grid.
 *
 * Grid.svelte creates one instance and keeps deps up-to-date via property assignment.
 * `fillHandleDrag` is `$state` so the Grid.svelte template can reactively render
 * the fill-preview border and suppress the fill-handle dot during a drag.
 */
export class GridFillHandle {
    // Deps set by Grid.svelte
    sheetStore = null;
    renderContext = null;
    renderScheduler = null;
    selectionScheduler = null;
    /** @type {((localX: number, localY: number) => any) | null} */
    doHitTest = null;
    /** @type {((e: MouseEvent) => {localX: number, localY: number}) | null} */
    getLocalCoords = null;
    /** @type {((cursor: string) => void) | null} */
    onCursorChange = null;

    // Reactive state read by Grid.svelte template
    fillHandleDrag = $state(null);

    handleFillHandleMouseDown = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const range = selectionState.range;
        const anchor = selectionState.anchor;
        const srcRange = range ?? (anchor
            ? { startRow: anchor.row, endRow: anchor.row, startCol: anchor.col, endCol: anchor.col }
            : null);
        if (!srcRange) return;

        this.fillHandleDrag = { srcRange, fillRange: null, direction: null };
        this.onCursorChange?.('crosshair');

        const onMove = (moveEvent) => {
            if (!this.fillHandleDrag || !this.getLocalCoords || !this.doHitTest) return;
            const { localX, localY } = this.getLocalCoords(moveEvent);
            const hit = this.doHitTest(localX, localY);
            if (hit.region !== 'cell') return;

            const { row, col } = hit;
            const src = this.fillHandleDrag.srcRange;
            let fillRange = null;
            let direction = null;

            if (row > src.endRow) {
                direction = 'down';
                fillRange = { startRow: src.endRow + 1, endRow: row, startCol: src.startCol, endCol: src.endCol };
            } else if (row < src.startRow) {
                direction = 'up';
                fillRange = { startRow: row, endRow: src.startRow - 1, startCol: src.startCol, endCol: src.endCol };
            } else if (col > src.endCol) {
                direction = 'right';
                fillRange = { startRow: src.startRow, endRow: src.endRow, startCol: src.endCol + 1, endCol: col };
            } else if (col < src.startCol) {
                direction = 'left';
                fillRange = { startRow: src.startRow, endRow: src.endRow, startCol: col, endCol: src.startCol - 1 };
            }

            this.fillHandleDrag = { ...this.fillHandleDrag, fillRange, direction };
        };

        const onUp = () => {
            if (this.fillHandleDrag?.fillRange && this.fillHandleDrag.direction) {
                this._applyFill(this.fillHandleDrag.srcRange, this.fillHandleDrag.fillRange, this.fillHandleDrag.direction);
            }
            this.fillHandleDrag = null;
            this.onCursorChange?.('cell');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    // ─── Fill application ────────────────────────────────────────────────────

    _applyFill(srcRange, fillRange, direction) {
        const store = this.sheetStore;
        const rc = this.renderContext;
        if (!store) return;

        const writeFillValue = (r, c, value) => {
            const ct = rc?.getCellType(r, c);
            if (ct === CELL_TYPE.TABLE_DATA) {
                const info = rc?.tableManager?.getCellInfo(r, c);
                if (info?.table && info.colDef && !info.colDef.isNonEntry && info.dataIndex >= 0) {
                    const parsed = typeof value === 'string' && value.startsWith('=')
                        ? value
                        : CellTypeRegistry.parseInput({ type: info.colDef.type }, value);
                    info.table.updateCell(info.dataIndex, info.colDef.id, parsed);
                }
                return;
            }
            if (ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY) return;
            if (typeof value === 'string' && value.startsWith('=')) {
                store.setCellFormula(r, c, value);
            } else {
                store.setCellValue(r, c, value);
            }
        };

        const FORMAT_PROPS = ['fontFamily', 'fontSize', 'bold', 'italic', 'underline',
            'strikethrough', 'color', 'backgroundColor',
            'horizontalAlign', 'verticalAlign', 'wrapText', 'numberFormat'];

        const writeFillFormat = (r, c, sr, sc) => {
            const ct = rc?.getCellType(r, c);
            if (ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY) return;
            const srcCell = store.getCell(sr, sc);
            const props = {};
            for (const k of FORMAT_PROPS) {
                props[k] = srcCell?.exists && srcCell[k] !== undefined ? srcCell[k] : null;
            }
            store.setCellProperties(r, c, props);
        };

        const writeFillBorders = (r, c, sr, sc) => {
            const ct = rc?.getCellType(r, c);
            if (ct === CELL_TYPE.TABLE_DATA || ct === CELL_TYPE.TABLE_HEADER || ct === CELL_TYPE.TABLE_ENTRY) return;
            const sb = store.getCellBorders(sr, sc);

            if (!(direction === 'up' && r === fillRange.endRow)) {
                store.setCellBorder(r, c, 'bottom', sb.bottom ?? null);
            }
            if (!(direction === 'left' && c === fillRange.endCol)) {
                store.setCellBorder(r, c, 'right', sb.right ?? null);
            }
            if (c === fillRange.startCol && direction !== 'right') {
                store.setCellBorder(r, c, 'left', sb.left ?? null);
            }
        };

        const srcRows = srcRange.endRow - srcRange.startRow + 1;
        const srcCols = srcRange.endCol - srcRange.startCol + 1;
        const isVertical = direction === 'down' || direction === 'up';

        if (isVertical) {
            for (let c = srcRange.startCol; c <= srcRange.endCol; c++) {
                const laneValues = [];
                let hasFormula = false;
                for (let r = srcRange.startRow; r <= srcRange.endRow; r++) {
                    const cell = store.getCell(r, c);
                    const v = cell?.exists ? cell.v : null;
                    if (typeof v === 'string' && v.startsWith('=')) hasFormula = true;
                    laneValues.push(v);
                }
                const seriesFn = hasFormula ? null : detectFillSeries(laneValues);

                for (let r = fillRange.startRow; r <= fillRange.endRow; r++) {
                    const srcRow = srcRange.startRow + (((r - srcRange.startRow) % srcRows) + srcRows) % srcRows;
                    if (hasFormula) {
                        const cell = store.getCell(srcRow, c);
                        if (!cell?.exists) continue;
                        const v = cell.v;
                        if (v !== null && v !== undefined) {
                            const adjusted = typeof v === 'string' && v.startsWith('=')
                                ? clipboardManager.adjustFormula(v, r - srcRow, 0)
                                : v;
                            writeFillValue(r, c, adjusted);
                        }
                    } else if (seriesFn) {
                        writeFillValue(r, c, seriesFn(r - srcRange.startRow));
                    } else {
                        const cell = store.getCell(srcRow, c);
                        if (cell?.exists && cell.v !== null && cell.v !== undefined) {
                            writeFillValue(r, c, cell.v);
                        }
                    }
                    writeFillFormat(r, c, srcRow, c);
                    writeFillBorders(r, c, srcRow, c);
                }
            }
        } else {
            for (let r = srcRange.startRow; r <= srcRange.endRow; r++) {
                const laneValues = [];
                let hasFormula = false;
                for (let c = srcRange.startCol; c <= srcRange.endCol; c++) {
                    const cell = store.getCell(r, c);
                    const v = cell?.exists ? cell.v : null;
                    if (typeof v === 'string' && v.startsWith('=')) hasFormula = true;
                    laneValues.push(v);
                }
                const seriesFn = hasFormula ? null : detectFillSeries(laneValues);

                for (let c = fillRange.startCol; c <= fillRange.endCol; c++) {
                    const srcCol = srcRange.startCol + (((c - srcRange.startCol) % srcCols) + srcCols) % srcCols;
                    if (hasFormula) {
                        const cell = store.getCell(r, srcCol);
                        if (!cell?.exists) continue;
                        const v = cell.v;
                        if (v !== null && v !== undefined) {
                            const adjusted = typeof v === 'string' && v.startsWith('=')
                                ? clipboardManager.adjustFormula(v, 0, c - srcCol)
                                : v;
                            writeFillValue(r, c, adjusted);
                        }
                    } else if (seriesFn) {
                        writeFillValue(r, c, seriesFn(c - srcRange.startCol));
                    } else {
                        const cell = store.getCell(r, srcCol);
                        if (cell?.exists && cell.v !== null && cell.v !== undefined) {
                            writeFillValue(r, c, cell.v);
                        }
                    }
                    writeFillFormat(r, c, r, srcCol);
                    writeFillBorders(r, c, r, srcCol);
                }
            }
        }

        this.renderScheduler?.invalidateAll();
        this.selectionScheduler?.invalidateAll();
    }
}
