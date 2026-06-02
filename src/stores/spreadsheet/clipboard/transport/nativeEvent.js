/**
 * transport/nativeEvent.js — the DataTransfer (native event) path.
 *
 * On a native `copy`/`cut` event we can call setData() synchronously with custom
 * MIME types — the only way to write them on Firefox and Safari. On a native
 * `paste` event we get the full MIME set including Google's compact JSON, which
 * Chromium restricts to native paste events.
 */

import { SCRIPTORIUM_MIME, SCRIPTORIUM_MIME_WEB, GOOGLE_COMPACT_MIME, MIME_HTML, MIME_TEXT } from '../model.js';

/**
 * Write all encodings onto a native copy/cut event's DataTransfer.
 * @param {ClipboardEvent} e
 * @param {{tsv:string, html:string, json:string}} formats
 */
export function writeToDataTransfer(e, formats) {
    e.clipboardData.setData(MIME_TEXT, formats.tsv);
    e.clipboardData.setData(MIME_HTML, formats.html);
    // Custom MIME — honored by Firefox/Safari here; Chrome ignores non-standard
    // types on the event and instead receives the 'web '-prefixed type via the
    // async ClipboardItem write that runs alongside this.
    try { e.clipboardData.setData(SCRIPTORIUM_MIME, formats.json); } catch { /* browser may reject */ }
}

/**
 * Read a normalized MIME bag from a native paste event's DataTransfer.
 * @param {DataTransfer} dt
 * @returns {object} { scriptorium?, scriptoriumWeb?, google?, html?, text? }
 */
export function readBagFromDataTransfer(dt) {
    const bag = {};
    const scriptorium = dt.getData(SCRIPTORIUM_MIME);
    if (scriptorium) bag.scriptorium = scriptorium;
    const scriptoriumWeb = dt.getData(SCRIPTORIUM_MIME_WEB);
    if (scriptoriumWeb) bag.scriptoriumWeb = scriptoriumWeb;
    const google = dt.getData(GOOGLE_COMPACT_MIME);
    if (google) bag.google = google;
    const html = dt.getData(MIME_HTML);
    if (html) bag.html = html;
    const text = dt.getData(MIME_TEXT);
    if (text) bag.text = text;
    return bag;
}
