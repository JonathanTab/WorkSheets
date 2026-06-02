/**
 * transport/asyncClipboard.js — the navigator.clipboard (async) path.
 *
 * Used for context-menu copy/paste, and as the Chrome 104+ writer for the
 * 'web '-prefixed custom MIME type. Reading via clipboard.read() exposes the same
 * MIME set as a native paste event (custom type, html, text), so context-menu
 * paste reaches the SAME fidelity as keyboard paste — the key consistency fix.
 */

import { SCRIPTORIUM_MIME, SCRIPTORIUM_MIME_WEB, GOOGLE_COMPACT_MIME, MIME_HTML, MIME_TEXT } from '../model.js';

/**
 * Write all encodings to the system clipboard via ClipboardItem.
 * @param {{tsv:string, html:string, json:string}} formats
 * @returns {Promise<boolean>} true if the rich write succeeded
 */
export async function writeToSystem(formats) {
    const itemTypes = {
        [MIME_TEXT]: new Blob([formats.tsv],  { type: MIME_TEXT }),
        [MIME_HTML]: new Blob([formats.html], { type: MIME_HTML }),
    };
    // Chrome 104+: custom types require the 'web ' prefix as the ClipboardItem key;
    // the Blob itself uses the un-prefixed MIME.
    try { itemTypes[SCRIPTORIUM_MIME_WEB] = new Blob([formats.json], { type: SCRIPTORIUM_MIME }); }
    catch { /* unsupported */ }

    try {
        await navigator.clipboard.write([new ClipboardItem(itemTypes)]);
        return true;
    } catch {
        // Last-ditch: at least put the text on the clipboard.
        try { await navigator.clipboard.writeText(formats.tsv); } catch { /* give up */ }
        return false;
    }
}

/**
 * Read a normalized MIME bag from the system clipboard.
 * @returns {Promise<object|null>} { scriptoriumWeb?, google?, html?, text? }
 */
export async function readBagFromSystem() {
    try {
        const items = await navigator.clipboard.read();
        const bag = {};
        for (const item of items) {
            if (!bag.scriptoriumWeb && item.types.includes(SCRIPTORIUM_MIME_WEB)) {
                bag.scriptoriumWeb = await readBlobText(item, SCRIPTORIUM_MIME_WEB);
            }
            if (!bag.google && item.types.includes(GOOGLE_COMPACT_MIME)) {
                bag.google = await readBlobText(item, GOOGLE_COMPACT_MIME);
            }
            if (!bag.html && item.types.includes(MIME_HTML)) {
                bag.html = await readBlobText(item, MIME_HTML);
            }
            if (!bag.text && item.types.includes(MIME_TEXT)) {
                bag.text = await readBlobText(item, MIME_TEXT);
            }
        }
        return bag;
    } catch {
        // Rich read() unavailable/denied — fall back to readText(). Mark the bag
        // `degraded` so the caller knows it couldn't confirm what's actually on the
        // clipboard and can prefer a matching in-memory model (same-tab copy).
        try { return { text: await navigator.clipboard.readText(), degraded: true }; }
        catch { return null; }
    }
}

async function readBlobText(item, type) {
    try { return await (await item.getType(type)).text(); }
    catch { return undefined; }
}
