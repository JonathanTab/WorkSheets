/**
 * codecs/googleCompact.js — decode Google Sheets' internal compact JSON
 * (`application/x-vnd.google-spreadsheet-compact-table+json`).
 *
 * This format carries typed values, formulas (R1C1), number formats, colors and
 * validations that Google's HTML omits or muddles. When available we decode it
 * and let an accompanying HTML region (if any) supply borders / extra formatting.
 *
 * Decode-only: we never WRITE this format.
 */

import { numToCol } from '../../../../formulas/refs.js';
import { makeModel } from '../model.js';

/**
 * @param {string} jsonStr            compact JSON string
 * @param {object|null} htmlRegion    region parsed from text/html (optional)
 * @returns {object|null} a single-region external model
 */
export function decodeGoogleCompact(jsonStr, htmlRegion = null) {
    const region = parseCompactToRegion(jsonStr, htmlRegion);
    if (!region) return null;
    return makeModel({ source: 'google', fingerprint: null, origin: null, regions: [region] });
}

// ─── RLE / color / formula helpers ─────────────────────────────────────────────

function decodeRLE(arr) {
    const result = [];
    let i = 0;
    while (i < arr.length) {
        if (arr[i] < 0) {
            const count = Math.abs(arr[i]);
            const val = arr[i + 1];
            for (let j = 0; j < count; j++) result.push(val);
            i += 2;
        } else {
            result.push(arr[i]);
            i++;
        }
    }
    return result;
}

function packedRGBToHex(packed) {
    const b = packed & 0xFF;
    const g = (packed >> 8) & 0xFF;
    const r = (packed >> 16) & 0xFF;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function r1c1ToA1(formula, baseRow, baseCol) {
    if (!formula) return formula;
    let expr = formula.startsWith('=') ? formula.slice(1) : formula;
    expr = expr.replace(/R(\[(-?\d+)\]|(\d+))?C(\[(-?\d+)\]|(\d+))?/g,
        (match, _rPart, rRel, rAbs, _cPart, cRel, cAbs) => {
            let row, col;
            let rowAbsolute = false, colAbsolute = false;
            if (rRel !== undefined)      { row = baseRow + parseInt(rRel, 10); }
            else if (rAbs !== undefined) { row = parseInt(rAbs, 10) - 1; rowAbsolute = true; }
            else                         { row = baseRow; }
            if (cRel !== undefined)      { col = baseCol + parseInt(cRel, 10); }
            else if (cAbs !== undefined) { col = parseInt(cAbs, 10) - 1; colAbsolute = true; }
            else                         { col = baseCol; }
            if (row < 0 || col < 0) return '#REF!';
            const colStr = numToCol(col);
            const rowStr = String(row + 1);
            return `${colAbsolute ? '$' : ''}${colStr}${rowAbsolute ? '$' : ''}${rowStr}`;
        });
    return '=' + expr;
}

function parseGSheetsValidation(rule) {
    if (!rule) return null;
    const inner = rule['1'];
    if (!inner) return null;
    const condDef = inner['1'];
    if (!condDef) return null;
    const type = condDef['1'];
    const items = condDef['2'];
    if (type === 24 && Array.isArray(items)) {
        const options = items
            .map(item => item?.['5']?.['2']?.['2'] || item?.['5']?.['1']?.['2'] || null)
            .filter(Boolean);
        if (options.length > 0) return { type: 'dropdown', options, strict: inner['6'] === 1, message: inner['2'] || '' };
    }
    if (type === 31) return { type: 'checkbox' };
    return null;
}

// ─── Main parse ────────────────────────────────────────────────────────────────

function parseCompactToRegion(jsonStr, htmlRegion) {
    let compact;
    try { compact = JSON.parse(jsonStr); }
    catch (e) { console.warn('Failed to parse Google Sheets compact JSON:', e); return null; }

    const dims = compact['15'] || {};
    const numRows = dims['1'] || 0;
    const numCols = dims['2'] || 0;
    if (numRows === 0 || numCols === 0) return null;

    const cellStream  = decodeRLE(compact['2'] || []);
    const pools       = compact['3'] || {};
    const typeSeq     = pools['1'] || [];
    const numPool     = pools['3'] || [];
    const strPool     = pools['4'] || [];
    const specialPool = pools['5'] || [];

    const formatDescs  = compact['4'] || [];
    const formatStream = decodeRLE(compact['5'] || []);

    const formulaPool      = compact['8'] || [];
    const formulaStreamRaw = compact['9'] || [];

    const hyperlinkPool = compact['16'] || [];
    const validationRules = compact['10'] || [];

    const grid = Array.from({ length: numRows }, () => Array(numCols).fill(null));
    const merges = [];

    let numIdx = 0, strIdx = 0, specialIdx = 0, typeIdx = 0, hyperlinkIdx = 0;
    const mergePrimaries = [];

    for (let pos = 0; pos < cellStream.length && pos < numRows * numCols; pos++) {
        const code = cellStream[pos];
        const row = Math.floor(pos / numCols);
        const col = pos % numCols;

        if (code === 194) { grid[row][col] = { v: null, displayValue: null, isFormula: false }; continue; }
        if (code === 0)   { grid[row][col] = { v: null, displayValue: null, isFormula: false, _mergeSecondary: true }; continue; }

        let v = null, displayValue = null, isFormula = false;
        if (code !== 210) {
            if (typeIdx < typeSeq.length) {
                const vType = typeSeq[typeIdx++];
                if (vType === 1 && numIdx < numPool.length)      { v = numPool[numIdx++]; displayValue = v; }
                else if (vType === 2 && strIdx < strPool.length) { v = strPool[strIdx++]; displayValue = v; }
                else if (vType === 3 && specialIdx < specialPool.length) {
                    const spec = specialPool[specialIdx++];
                    v = spec?.['4'] === 1; displayValue = v ? 'TRUE' : 'FALSE';
                }
            }
        }
        if (code === 203 || code === 210 || code === 211) isFormula = true;
        if (code === 1219) mergePrimaries.push({ row, col });

        const cellData = { v, displayValue, isFormula };
        if (code === 2755 && hyperlinkIdx < hyperlinkPool.length) {
            const uri = hyperlinkPool[hyperlinkIdx++];
            if (uri && typeof v === 'string' && v !== '') {
                cellData.tfr = [{ startIndex: 0, format: { link: { uri } } }];
            }
        }
        grid[row][col] = cellData;
    }

    // Merge extents
    for (const mp of mergePrimaries) {
        let endRow = mp.row, endCol = mp.col;
        for (let c = mp.col + 1; c < numCols; c++) { if (grid[mp.row]?.[c]?._mergeSecondary) endCol = c; else break; }
        for (let r = mp.row + 1; r < numRows; r++) { if (grid[r]?.[mp.col]?._mergeSecondary) endRow = r; else break; }
        if (endRow > mp.row || endCol > mp.col) merges.push({ relStartRow: mp.row, relStartCol: mp.col, relEndRow: endRow, relEndCol: endCol });
    }

    // Formulas map 1:1 to formula-code cells in order.
    const formulaCells = [];
    for (let pos = 0; pos < cellStream.length && pos < numRows * numCols; pos++) {
        const code = cellStream[pos];
        if (code === 203 || code === 210 || code === 211) formulaCells.push({ row: Math.floor(pos / numCols), col: pos % numCols });
    }
    if (formulaStreamRaw.length > 0 && formulaPool.length > 0) {
        const formulaStream = decodeRLE(formulaStreamRaw);
        const limit = Math.min(formulaStream.length, formulaCells.length);
        for (let i = 0; i < limit; i++) {
            const poolIdx = formulaStream[i];
            if (poolIdx == null || poolIdx < 0 || poolIdx >= formulaPool.length) continue;
            const { row, col } = formulaCells[i];
            const cell = grid[row]?.[col];
            if (!cell) continue;
            cell.formula = r1c1ToA1(formulaPool[poolIdx], row, col);
            cell.isFormula = true;
        }
    }

    // Format descriptors
    for (let pos = 0; pos < formatStream.length && pos < numRows * numCols; pos++) {
        const fmtIdx = formatStream[pos];
        if (fmtIdx == null || fmtIdx < 0 || fmtIdx >= formatDescs.length) continue;
        const row = Math.floor(pos / numCols);
        const col = pos % numCols;
        const cell = grid[row]?.[col];
        const fmt = formatDescs[fmtIdx];
        if (!cell || !fmt) continue;

        if (fmt['3'])  cell.numberFormat = fmt['3']['2'] || null;
        if (fmt['4'])  cell.backgroundColor = packedRGBToHex(fmt['4']['2'] || 0);
        if (fmt['9']  != null) cell.horizontalAlign = fmt['9'] === 1 ? 'center' : fmt['9'] === 2 ? 'right' : null;
        if (fmt['10'] != null) cell.verticalAlign = fmt['10'] === 0 ? 'top' : fmt['10'] === 1 ? 'middle' : 'bottom';
        if (fmt['14']) cell.color = packedRGBToHex(fmt['14']['2'] || 0);
        if (fmt['15']) cell.fontFamily = fmt['15'];
        if (fmt['16']) cell.fontSize = Math.round(fmt['16'] * 4 / 3);
        if (fmt['21']) cell.wrapText = true;

        // Field "2" is a packed flag bitfield. Only 0x20/0x40 are font toggles
        // (bold/italic). 0x04 is Google's "this cell carries a border" flag (it
        // is set exactly on descriptors that also have a "5" border block) — it
        // is NOT underline, and reading it as such stamped phantom underlines on
        // the rows following a bordered cell. Underline/strikethrough are carried
        // reliably by Google's HTML as text-decoration, which is authoritative in
        // the merge below, so we don't derive them from these ambiguous bits.
        const bits = fmt['2'] || 0;
        if (bits & 0x20) cell.bold = true;
        if (bits & 0x40) cell.italic = true;
    }

    // Merge HTML formatting on top (HTML authoritative for content/styles; compact back-fills).
    let outputCells = grid;
    const htmlCells = htmlRegion?.cells;
    if (htmlCells?.length) {
        const htmlRows = htmlCells.length;
        const htmlCols = htmlCells[0]?.length || 0;
        const FORMAT_KEYS = [
            'numberFormat', 'backgroundColor', 'color', 'fontFamily', 'fontSize',
            'horizontalAlign', 'verticalAlign', 'wrapText',
            'bold', 'italic', 'underline', 'strikethrough',
        ];
        outputCells = Array.from({ length: htmlRows }, (_, r) =>
            Array.from({ length: htmlCols }, (_, c) => {
                const htmlCell = htmlCells[r]?.[c] || { v: null, displayValue: null, isFormula: false };
                const compactCell = grid[r]?.[c] || null;
                const out = { ...htmlCell };
                // Google delivers hyperlinks in the compact stream as a link tfr.
                // Back-fill it (the 'url' cell type was retired) unless the HTML
                // path already produced inline runs for this cell.
                if (!out.tfr && compactCell?.tfr) out.tfr = compactCell.tfr;
                if (compactCell) for (const k of FORMAT_KEYS) if (out[k] == null && compactCell[k] != null) out[k] = compactCell[k];
                if (compactCell?.formula) { out.formula = compactCell.formula; out.isFormula = true; }
                else if (!out.formula && typeof out.v === 'string' && out.v.startsWith('=')) { out.formula = out.v; out.isFormula = true; }
                return out;
            })
        );
    }

    const parsedValidations = [];
    for (const rule of validationRules) { const dv = parseGSheetsValidation(rule); if (dv) parsedValidations.push(dv); }

    for (let r = 0; r < numRows; r++) for (let c = 0; c < numCols; c++) if (grid[r][c]) delete grid[r][c]._mergeSecondary;

    const rowCount = htmlRegion?.rowCount || numRows;
    const colCount = htmlRegion?.colCount || numCols;
    return {
        range: { startRow: 0, endRow: rowCount - 1, startCol: 0, endCol: Math.max(0, colCount - 1) },
        cells: outputCells,
        borders: htmlRegion?.borders || [],
        merges: htmlRegion?.merges || merges,
        dataValidations: parsedValidations,
        conditionalFormats: [],
        rowCount, colCount,
        colWidths: htmlRegion?.colWidths || null,
        rowHeights: htmlRegion?.rowHeights || null,
    };
}
