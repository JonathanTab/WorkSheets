/**
 * styleNormalize.js — Canonical shaping rules for stored style data.
 *
 * These rules decide what a style looks like ON DISK. They must be identical on
 * every writer, because the style palette is content-addressed: two clients that
 * apply "bold" must produce a byte-identical object or they mint two different
 * sids for the same appearance, defeating dedupe and bloating the document.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

/**
 * Style keys whose default is `false`. Storing `false` is redundant — readers
 * treat missing keys as false — so we strip them on write to keep the document
 * from accumulating zero-information entries.
 */
export const STRIP_FALSE_STYLE_KEYS = new Set([
    'bold', 'italic', 'underline', 'strikethrough', 'wrapText',
]);

/**
 * Drop keys that carry no information: null/undefined, and `false` on the
 * boolean style keys above.
 * @param {object|null|undefined} style
 * @returns {object} A new object; never null (callers treat {} as "no style")
 */
export function normalizeStyleForStorage(style) {
    const out = {};
    if (!style || typeof style !== 'object') return out;
    for (const [k, v] of Object.entries(style)) {
        if (v === undefined || v === null) continue;
        if (STRIP_FALSE_STYLE_KEYS.has(k) && v === false) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Strip default style/width from a border descriptor. Readers fall back to
 * style:'solid' and width:1 via normalizeBorderStyle, so storing them is
 * redundant. Color is always preserved — without it the entry would degrade
 * to a default-black border on read, which is a different look.
 * @param {{ style?: string, width?: number, color?: string } | null | undefined} style
 */
export function compactBorderStyle(style) {
    if (!style || typeof style !== 'object') return style ?? null;
    const out = { ...style };
    if (out.style === 'solid') delete out.style;
    if (out.width === 1) delete out.width;
    return out;
}
