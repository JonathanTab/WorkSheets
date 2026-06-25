/**
 * transport/index.js — ties codecs to the two physical transports and provides
 * the single encode/decode entry points the manager uses.
 *
 *   encodeModel(model)  → { tsv, html, json }   (all wire formats)
 *   decodeBag(bag)      → { model, isInternal } | null   (one priority chain,
 *                          identical for keyboard and context-menu paste)
 */

import { encodeTSV, decodeTSV } from '../codecs/tsv.js';
import { encodeHTML, decodeHTML, parseHTMLTableToRegion } from '../codecs/html.js';
import { encodeScriptoriumJSON, decodeScriptoriumJSON } from '../codecs/scriptorium.js';
import { decodeGoogleCompact } from '../codecs/googleCompact.js';
import { decodeGoogleDoc, isGoogleDocHTML } from '../codecs/googleDoc.js';

export { writeToSystem, readBagFromSystem } from './asyncClipboard.js';
export { writeToDataTransfer, readBagFromDataTransfer } from './nativeEvent.js';

/**
 * Produce all wire formats for a model.
 * @param {object} model
 * @returns {{tsv:string, html:string, json:string}}
 */
export function encodeModel(model) {
    return {
        tsv:  encodeTSV(model),
        html: encodeHTML(model.regions[0], model.fingerprint),
        json: encodeScriptoriumJSON(model),
    };
}

/**
 * Decode a normalized MIME bag into a model + provenance, via one priority chain:
 *   1. our JSON (custom MIME, native or 'web '-prefixed) → full fidelity, internal
 *   2. Google compact (+ HTML for borders/format)        → external
 *   3. Google Docs document slice (multi-block flatten)   → external
 *   4. HTML table                                         → external
 *   5. plain text / TSV                                   → external
 *
 * @param {{scriptorium?:string, scriptoriumWeb?:string, google?:string, html?:string, text?:string}} bag
 * @returns {{ model:object, isInternal:boolean } | null}
 */
export function decodeBag(bag) {
    if (!bag) return null;

    // 1. Our own JSON — either custom type works.
    for (const raw of [bag.scriptorium, bag.scriptoriumWeb]) {
        if (!raw) continue;
        const model = decodeScriptoriumJSON(raw);
        if (model) return { model, isInternal: true };
    }

    // 2. Google compact, enriched with HTML formatting/borders if present.
    if (bag.google) {
        const htmlRegion = bag.html ? parseHTMLTableToRegion(bag.html) : null;
        const model = decodeGoogleCompact(bag.google, htmlRegion);
        if (model) return { model, isInternal: false };
    }

    // 3. Google Docs document slice — a sequence of tables + paragraphs, not a
    //    single grid. Flatten the whole document before the generic table decoder
    //    (which would otherwise grab only the first table).
    if (bag.html && isGoogleDocHTML(bag.html)) {
        const model = decodeGoogleDoc(bag.html);
        if (model) return { model, isInternal: false };
    }

    // 4. HTML table.
    if (bag.html) {
        const model = decodeHTML(bag.html);
        if (model) return { model, isInternal: false };
    }

    // 5. Plain text / TSV.
    if (bag.text) {
        const model = decodeTSV(bag.text);
        if (model) return { model, isInternal: false };
    }

    return null;
}

/**
 * Does this bag carry our fingerprint? Used to validate that an in-memory model
 * is still the thing on the system clipboard (cross-app overwrite detection).
 * @param {object} bag
 * @param {string} fingerprint
 */
export function bagMatchesFingerprint(bag, fingerprint) {
    if (!bag || !fingerprint) return false;
    for (const raw of [bag.scriptorium, bag.scriptoriumWeb]) {
        if (raw && raw.includes(fingerprint)) return true;
    }
    if (bag.html && bag.html.includes(`content="${fingerprint}"`)) return true;
    return false;
}
