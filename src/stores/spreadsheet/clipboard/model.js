/**
 * clipboard/model.js — The normalized clipboard representation (the "IR").
 *
 * Every clipboard source (internal extract, our own JSON, external HTML, Google
 * compact JSON, plain TSV) produces a {@link ClipboardModel}, and the single
 * `apply.js` writer consumes one. Centralizing the shape here is what makes the
 * clipboard predictable: there is exactly one cell schema and one canonical list
 * of formatting keys, used by extraction, every codec, and apply alike.
 *
 * ── ClipboardModel ────────────────────────────────────────────────────────────
 *   {
 *     version:     5,
 *     source:      'scriptorium' | 'html' | 'google' | 'google-doc' | 'tsv',
 *     fingerprint: string | null,        // identifies OUR payloads across tabs
 *     origin:      { row, col } | null,   // absolute top-left of region[0] for
 *                                         //   internal copies; null for external
 *     rows, cols:  number,                // dimensions of the primary region
 *     regions:     Region[],              // >1 only for multi-range copy
 *   }
 *
 * ── Region ────────────────────────────────────────────────────────────────────
 *   {
 *     range:  { startRow, endRow, startCol, endCol },  // absolute (internal) or
 *                                                       //   0-based (external)
 *     cells:  Cell[][],                                 // dense rows × cols
 *     borders, merges:        relative-coordinate arrays
 *     rowHeights, colWidths:  number[] | null
 *     dataValidations, conditionalFormats:  best-effort, internal payloads only
 *   }
 *
 * ── Cell ──────────────────────────────────────────────────────────────────────
 *   {
 *     v:           string|number|boolean|null,  // raw value
 *     isFormula:   boolean,
 *     formula:     string|null,    // canonical A1 (external/Google), else v holds it
 *     displayValue:string|null,    // cached computed/formatted text
 *     tfr:         Run[]|null,      // rich-text runs (hyperlinks live here as link runs)
 *     ct:          object|null,     // cell-type config (checkbox/dropdown/date)
 *     ...FORMAT_KEYS               // flat canonical formatting props (sparse)
 *   }
 *
 * Cell formatting is intentionally flat (not nested) because it mirrors exactly
 * what SheetStore stores and what every parser already produces; {@link FORMAT_KEYS}
 * is the single source of truth for which keys count as "formatting".
 */

// ─── MIME types ────────────────────────────────────────────────────────────────

/** Our app-specific MIME — readable via native copy/paste events (Firefox, Safari). */
export const SCRIPTORIUM_MIME = 'application/x-scriptorium-clipboard+json';

/**
 * 'web ' prefixed variant — required for ClipboardItem custom types in Chrome 104+.
 * When read back via navigator.clipboard.read(), the 'web ' prefix is stripped.
 */
export const SCRIPTORIUM_MIME_WEB = 'web application/x-scriptorium-clipboard+json';

/** Google Sheets internal compact format — available in native paste events. */
export const GOOGLE_COMPACT_MIME = 'application/x-vnd.google-spreadsheet-compact-table+json';

export const MIME_HTML = 'text/html';
export const MIME_TEXT = 'text/plain';

/** Meta-tag name embedding the session fingerprint inside HTML clipboard data. */
export const FINGERPRINT_META = 'x-scriptorium-id';

/** Current scriptorium JSON payload version. Clipboard data is ephemeral, so we
 *  do not maintain back-compat with older versions — only this one is emitted. */
export const MODEL_VERSION = 5;

// ─── Canonical formatting keys ─────────────────────────────────────────────────

/**
 * The single source of truth for cell-level formatting property names. Used by
 * extraction (which keys to copy off a cell), apply (which keys to write/clear),
 * and the JSON/HTML codecs. Keep names identical to SheetStore's cell schema.
 */
export const FORMAT_KEYS = Object.freeze([
    'fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strikethrough',
    'color', 'backgroundColor', 'horizontalAlign', 'verticalAlign', 'wrapText',
    'numberFormat',
]);

/** Strict-boolean format keys: absent ⇔ false, so we never serialize false. */
export const BOOLEAN_FORMAT_KEYS = Object.freeze(['bold', 'italic', 'underline', 'strikethrough']);

// ─── Factories & helpers ───────────────────────────────────────────────────────

/** A fresh empty cell. */
export function emptyCell() {
    return { v: null, isFormula: false, displayValue: null };
}

/**
 * True when a cell carries no content of any kind (value/formula/rich text).
 * Formatting is NOT content — an empty-valued cell may still carry a background
 * color, which apply() must be able to propagate.
 */
export function isCellContentEmpty(cell) {
    if (!cell) return true;
    return (cell.v === null || cell.v === undefined || cell.v === '')
        && !cell.isFormula && !cell.formula && !cell.tfr;
}

/** True when a cell carries any formatting property worth applying. */
export function cellHasFormatting(cell) {
    if (!cell) return false;
    for (const k of FORMAT_KEYS) {
        if (k in cell && cell[k] != null && cell[k] !== false) return true;
    }
    return !!cell.ct;
}

/**
 * Build a ClipboardModel from one or more regions.
 * @param {object} opts
 * @param {string} opts.source
 * @param {string|null} opts.fingerprint
 * @param {{row:number,col:number}|null} opts.origin
 * @param {Region[]} opts.regions
 */
export function makeModel({ source, fingerprint = null, origin = null, regions }) {
    const primary = regions[0];
    return {
        version: MODEL_VERSION,
        source,
        fingerprint,
        origin,
        rows: primary?.cells.length ?? 0,
        cols: primary?.cells[0]?.length ?? 0,
        regions,
    };
}

/** Generate a copy fingerprint (UUID when available). */
export function generateFingerprint() {
    return typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Convenience: the model's primary (first) region. */
export function primaryRegion(model) {
    return model?.regions?.[0] ?? null;
}

/** True when the model represents more than one copied range. */
export function isMultiRange(model) {
    return (model?.regions?.length ?? 0) > 1;
}
