/**
 * codecs/tsv.js — text/plain tab-separated values. The universal lowest-common
 * denominator: what every other app (and a plain text editor) understands.
 */

import { makeModel, emptyCell } from '../model.js';

/**
 * Encode the model's primary region to TSV using cached display values.
 * @param {object} model
 * @returns {string}
 */
export function encodeTSV(model) {
    const cells = model.regions[0]?.cells ?? [];
    return cells.map(row =>
        row.map(cell => {
            const val = cell.displayValue ?? cell.v ?? '';
            return String(val).replace(/\t/g, '\\t').replace(/\n/g, '\\n');
        }).join('\t')
    ).join('\n');
}

/**
 * Decode a TSV / plain-text string into a single-region external model.
 * @param {string} text
 * @returns {object|null}
 */
export function decodeTSV(text) {
    if (!text) return null;
    // Normalise CRLF / CR so the last cell of each row doesn't keep a stray \r.
    const rows = text.replace(/\r\n?/g, '\n').split('\n');
    if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    if (rows.length === 0) return null;

    const cells = rows.map(row =>
        row.split('\t').map(cell => {
            if (!cell) return emptyCell();
            return { v: cell, displayValue: cell, isFormula: cell.startsWith('=') };
        })
    );

    const cols = cells[0]?.length || 0;
    const region = {
        range: { startRow: 0, endRow: cells.length - 1, startCol: 0, endCol: Math.max(0, cols - 1) },
        cells, borders: [], merges: [], dataValidations: [], conditionalFormats: [],
        rowHeights: null, colWidths: null,
        rowCount: cells.length, colCount: cols,
    };
    return makeModel({ source: 'tsv', fingerprint: null, origin: null, regions: [region] });
}
