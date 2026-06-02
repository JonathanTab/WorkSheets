/**
 * codecs/scriptorium.js — our own full-fidelity JSON format (v5).
 *
 * This is the ONLY encoding that round-trips every property, including formulas,
 * cell-types, rich text, validations and conditional formats. It rides on the
 * system clipboard as a custom MIME type, so a copy in one tab pastes with full
 * fidelity in another tab/window (or even after the source tab closes).
 *
 * Clipboard payloads are ephemeral, so there is no back-compat with older
 * versions — we emit and accept v5 only.
 */

import { MODEL_VERSION, makeModel } from '../model.js';

/**
 * Serialize a ClipboardModel to a v5 JSON string.
 * @param {object} model
 * @returns {string}
 */
export function encodeScriptoriumJSON(model) {
    return JSON.stringify({
        version: MODEL_VERSION,
        source: 'scriptorium',
        fingerprint: model.fingerprint ?? null,
        origin: model.origin ?? null,
        regions: model.regions.map(serializeRegion),
    });
}

function serializeRegion(region) {
    return {
        range: {
            startRow: region.range.startRow, endRow: region.range.endRow,
            startCol: region.range.startCol, endCol: region.range.endCol,
        },
        cells:              region.cells,
        borders:            region.borders            || [],
        merges:             region.merges             || [],
        dataValidations:    region.dataValidations    || [],
        conditionalFormats: region.conditionalFormats || [],
        rowHeights:         region.rowHeights          ?? null,
        colWidths:          region.colWidths           ?? null,
    };
}

/**
 * Parse a v5 JSON string into a ClipboardModel, or null if it is not ours.
 * @param {string} jsonStr
 * @returns {object|null}
 */
export function decodeScriptoriumJSON(jsonStr) {
    let json;
    try { json = JSON.parse(jsonStr); }
    catch { return null; }
    if (!json || json.source !== 'scriptorium' || !Array.isArray(json.regions)) return null;

    const regions = json.regions.map(deserializeRegion).filter(Boolean);
    if (regions.length === 0) return null;

    const origin = json.origin
        ?? (regions[0].range
            ? { row: regions[0].range.startRow, col: regions[0].range.startCol }
            : null);

    return makeModel({ source: 'scriptorium', fingerprint: json.fingerprint ?? null, origin, regions });
}

function deserializeRegion(item) {
    if (!item || !Array.isArray(item.cells)) return null;
    return {
        range: item.range,
        cells:              item.cells,
        borders:            item.borders            || [],
        merges:             item.merges             || [],
        dataValidations:    item.dataValidations    || [],
        conditionalFormats: item.conditionalFormats || [],
        rowHeights:         item.rowHeights          ?? null,
        colWidths:          item.colWidths           ?? null,
        rowCount: item.cells.length,
        colCount: item.cells[0]?.length || 0,
    };
}
