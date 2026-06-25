/**
 * codecs/googleDoc.js — Google Docs *document*-slice paste.
 *
 * A Google Docs copy is NOT a single grid the way a Sheets/Excel copy is — it's
 * a sequence of top-level blocks (paragraphs, <br> spacers, and one-or-more
 * tables) wrapped in `<b id="docs-internal-guid-…">`. The generic HTML-table
 * decoder ({@link parseHTMLTableToRegion}) only sees the *first* table and drops
 * everything else, so an invoice/letter pasted from Docs arrives ~90% empty.
 *
 * This decoder walks the document in reading order and flattens it into one
 * region:
 *   • each table row  → a grid row, one grid column per visible <td> (colspans
 *                       collapse to a single cell so disparate tables line up);
 *   • each paragraph  → a grid row, split into columns on runs of 2+ spaces/
 *                       nbsp (Docs' way of faking tab stops), so header lines
 *                       like "Services …… Hours … Rate" align with the table
 *                       beneath them;
 *   • each <br> spacer → a blank row.
 * Inline formatting (bold/italic/colour/size/links) is preserved as cell-level
 * props when a cell is uniform, or as rich-text runs (tfr) when it is mixed.
 */

import { makeModel, emptyCell, isCellContentEmpty } from '../model.js';
import { normalizeTfr } from '../../textFormatRuns.js';
import { inferValueFromText } from './html.js';

/** Cheap sniff: only Google Docs wraps its clipboard slice in this guid marker. */
export function isGoogleDocHTML(html) {
    return typeof html === 'string' && html.includes('docs-internal-guid');
}

/**
 * Decode a Google Docs document-slice HTML string into a single-region model.
 * Returns null when the content isn't structured (no table, single block) so the
 * caller falls back to the plain-text path for inline snippets.
 * @param {string} html
 * @returns {object|null}
 */
export function decodeGoogleDoc(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.querySelector('[id^="docs-internal-guid"]') || doc.body;
    if (!root) return null;

    const tableCount = root.querySelectorAll('table').length;

    const rows = [];
    collectBlocks(root, rows);

    // Drop trailing blank rows.
    while (rows.length && rows[rows.length - 1].every(isCellContentEmpty)) rows.pop();

    // Inline / single-line snippet (no table, at most one line of content): emit a
    // single rich-text cell from the whole selection rather than column-splitting a
    // lone line. Covers bare inline spans (which produce no block rows at all, e.g.
    // a labeled field like "Invoice#  2601") as well as a single paragraph. The
    // faux-tab column splitting only makes sense inside a multi-block document.
    const contentRows = rows.filter(r => r.some(c => !isCellContentEmpty(c)));
    if (tableCount === 0 && contentRows.length <= 1) {
        const cell = runsToCell(trimRuns(collectRuns(root)));
        if (isCellContentEmpty(cell)) return null;
        return _singleCellModel(cell);
    }

    if (rows.length === 0) return null;

    const numCols = Math.max(1, ...rows.map(r => r.length));
    for (const row of rows) {
        while (row.length < numCols) row.push(emptyCell());
    }

    const region = {
        range: { startRow: 0, endRow: rows.length - 1, startCol: 0, endCol: numCols - 1 },
        cells: rows,
        borders: [],
        merges: [],
        dataValidations: [],
        conditionalFormats: [],
        rowCount: rows.length,
        colCount: numCols,
        colWidths: null,
        rowHeights: rows.map(() => null),
    };
    return makeModel({ source: 'google-doc', fingerprint: null, origin: null, regions: [region] });
}

/** Wrap a single cell as a 1×1 region model. */
function _singleCellModel(cell) {
    const region = {
        range: { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
        cells: [[cell]],
        borders: [],
        merges: [],
        dataValidations: [],
        conditionalFormats: [],
        rowCount: 1,
        colCount: 1,
        colWidths: null,
        rowHeights: [null],
    };
    return makeModel({ source: 'google-doc', fingerprint: null, origin: null, regions: [region] });
}

// ─── Block walk ──────────────────────────────────────────────────────────────

/**
 * Walk a container's children in document order, appending grid rows. Tables and
 * paragraphs are leaf blocks (we don't descend past them); other wrappers (the
 * <div align> Docs puts around each table) are recursed into.
 */
function collectBlocks(node, rows) {
    for (const child of node.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName.toLowerCase();

        if (tag === 'table') {
            collectTableRows(child, rows);
        } else if (tag === 'p' || tag === 'li' || tag === 'h1' || tag === 'h2' ||
                   tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
            rows.push(paragraphToRow(child));
        } else if (tag === 'br') {
            rows.push([emptyCell()]);
        } else {
            collectBlocks(child, rows);
        }
    }
}

/** One grid row per <tr>; one grid column per visible <td>/<th> (colspans collapse). */
function collectTableRows(table, rows) {
    // Direct rows only — guard against the (rare) nested table.
    const trs = Array.from(table.querySelectorAll('tr')).filter(tr => tr.closest('table') === table);
    for (const tr of trs) {
        const tds = Array.from(tr.children).filter(el => {
            const t = el.tagName.toLowerCase();
            return t === 'td' || t === 'th';
        });
        const row = tds.map(td => {
            const align = readAlign(td) ?? readAlign(td.querySelector('p'));
            const background = readBackground(td);
            return runsToCell(trimRuns(collectRuns(td)), { align, background });
        });
        rows.push(row.length ? row : [emptyCell()]);
    }
}

/** A paragraph → a row, split on 2+ space/nbsp into columns (Docs' faux tab stops). */
function paragraphToRow(p) {
    const runs = collectRuns(p);
    const plain = runs.map(r => r.text).join('');
    const align = readAlign(p);

    if (!plain.trim()) return [emptyCell()];

    const segments = splitRunsOnGaps(runs);
    const cells = segments
        .map(seg => runsToCell(trimRuns(seg), { align }))
        .filter(Boolean);
    return cells.length ? cells : [emptyCell()];
}

// ─── Run collection (text + inline style) ────────────────────────────────────

/**
 * Walk an element's inner DOM into a flat list of `{ text, style }` runs, where
 * style accumulates inline CSS + semantic tags down the tree. Newlines (<br>)
 * are folded into the preceding run.
 * @returns {Array<{text:string, style:object}>}
 */
function collectRuns(el) {
    const runs = [];

    function push(text, style) {
        if (!text) return;
        const last = runs[runs.length - 1];
        if (last && styleKey(last.style) === styleKey(style)) last.text += text;
        else runs.push({ text, style });
    }

    function walk(node, style) {
        if (node.nodeType === Node.TEXT_NODE) {
            push(node.textContent, style);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        if (tag === 'br') { push('\n', style); return; }

        const next = mergeStyle(style, node, tag);
        for (const c of node.childNodes) walk(c, next);
    }

    for (const c of el.childNodes) walk(c, {});
    return runs;
}

/** Derive a child run-style from a parent style + one element's CSS/semantics. */
function mergeStyle(style, node, tag) {
    const s = { ...style };
    const cs = node.style;
    if (cs) {
        const weight = cs.fontWeight?.toLowerCase?.() || '';
        const weightNum = parseInt(weight, 10);
        if (weight === 'bold' || weight === 'bolder' || (!isNaN(weightNum) && weightNum >= 600)) s.bold = true;
        else if (weight === 'normal' || weight === 'lighter' || (!isNaN(weightNum) && weightNum < 600)) delete s.bold;

        if (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique') s.italic = true;
        else if (cs.fontStyle === 'normal') delete s.italic;

        const dec = `${cs.textDecoration || ''} ${cs.textDecorationLine || ''}`.toLowerCase();
        if (dec.includes('underline')) s.underline = true;
        if (dec.includes('line-through')) s.strikethrough = true;
        if (dec.includes('none')) { delete s.underline; delete s.strikethrough; }

        const color = normalizeColor(cs.color);
        if (color) s.color = color;
        else if (cs.color) delete s.color;

        const size = parsePtSize(cs.fontSize);
        if (size) s.fontSize = size;

        const family = normalizeFamily(cs.fontFamily);
        if (family) s.fontFamily = family;
    }

    if (tag === 'b' || tag === 'strong') s.bold = true;
    if (tag === 'i' || tag === 'em')     s.italic = true;
    if (tag === 'u')                     s.underline = true;
    if (tag === 's' || tag === 'strike') s.strikethrough = true;

    const href = node.getAttribute?.('href');
    if (tag === 'a' && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        s.link = { uri: href };
    }
    return s;
}

// ─── Runs → cell ─────────────────────────────────────────────────────────────

/**
 * Build a normalized cell from a run list. Uniformly-styled content lifts its
 * formatting to cell-level props (and infers numbers/currency); mixed content
 * keeps its formatting as rich-text runs (tfr).
 */
function runsToCell(runs, { align, background } = {}) {
    const text = runs.map(r => r.text).join('');
    const base = emptyCell();
    if (align) base.horizontalAlign = align;
    if (background) base.backgroundColor = background;

    if (!text.trim()) return base;

    // Uniformity is judged on the runs that carry visible glyphs — a stray space
    // between two identically-styled runs shouldn't make a cell look "mixed".
    const glyphRuns = runs.filter(r => r.text.trim());
    const keys = new Set(glyphRuns.map(r => styleKey(r.style)));

    if (keys.size <= 1) {
        const style = glyphRuns[0]?.style || {};
        const { v, numberFormat } = inferValueFromText(text);
        const cell = { ...base, v, displayValue: text, isFormula: false, ...styleToProps(style) };
        if (numberFormat && !cell.numberFormat) cell.numberFormat = numberFormat;
        return cell;
    }

    const tfr = runsToTfr(runs, text.length);
    return { ...base, v: text, displayValue: text, isFormula: false, ...(tfr ? { tfr } : {}) };
}

function styleToProps(style) {
    const props = {};
    if (style.bold)          props.bold = true;
    if (style.italic)        props.italic = true;
    if (style.underline)     props.underline = true;
    if (style.strikethrough) props.strikethrough = true;
    if (style.color)         props.color = style.color;
    if (style.fontSize)      props.fontSize = style.fontSize;
    if (style.fontFamily)    props.fontFamily = style.fontFamily;
    return props;
}

function runsToTfr(runs, textLen) {
    let offset = 0;
    const tfr = [];
    for (const run of runs) {
        const f = run.style;
        const fmt = {};
        if (f.bold)          fmt.bold = true;
        if (f.italic)        fmt.italic = true;
        if (f.underline)     fmt.underline = true;
        if (f.strikethrough) fmt.strikethrough = true;
        if (f.color)         fmt.foregroundColor = f.color;
        if (f.fontSize)      fmt.fontSize = f.fontSize;
        if (f.fontFamily)    fmt.fontFamily = f.fontFamily;
        if (f.link)          fmt.link = f.link;
        tfr.push({ startIndex: offset, format: fmt });
        offset += run.text.length;
    }
    return normalizeTfr(tfr, textLen);
}

// ─── Splitting & trimming ────────────────────────────────────────────────────

/**
 * Split a run list at runs of 2+ space/nbsp characters, returning a list of
 * run-lists (the gaps themselves are dropped). Used to turn Docs' nbsp-padded
 * paragraph "tab stops" into real columns.
 */
function splitRunsOnGaps(runs) {
    const plain = runs.map(r => r.text).join('');
    const gap = /[  \t]{2,}/g;

    const ranges = [];
    let last = 0;
    let m;
    while ((m = gap.exec(plain)) !== null) {
        if (m.index > last) ranges.push([last, m.index]);
        last = m.index + m[0].length;
    }
    if (last < plain.length) ranges.push([last, plain.length]);
    if (ranges.length <= 1) return [runs];

    return ranges.map(([s, e]) => sliceRuns(runs, s, e));
}

/** Extract the sub-runs covering [start, end) of the concatenated text. */
function sliceRuns(runs, start, end) {
    const out = [];
    let pos = 0;
    for (const run of runs) {
        const rs = pos;
        const re = pos + run.text.length;
        pos = re;
        const from = Math.max(start, rs);
        const to = Math.min(end, re);
        if (from < to) out.push({ text: run.text.slice(from - rs, to - rs), style: run.style });
    }
    return out;
}

/** Strip leading/trailing whitespace (incl. nbsp) from the edges of a run list. */
function trimRuns(runs) {
    const out = runs.map(r => ({ ...r }));
    while (out.length) {
        const t = out[0].text.replace(/^[\s ]+/, '');
        if (t) { out[0] = { ...out[0], text: t }; break; }
        out.shift();
    }
    while (out.length) {
        const t = out[out.length - 1].text.replace(/[\s ]+$/, '');
        if (t) { out[out.length - 1] = { ...out[out.length - 1], text: t }; break; }
        out.pop();
    }
    return out;
}

// ─── Small CSS helpers ───────────────────────────────────────────────────────

function styleKey(style) {
    return `${style.bold ? 1 : 0}|${style.italic ? 1 : 0}|${style.underline ? 1 : 0}|` +
           `${style.strikethrough ? 1 : 0}|${style.color || ''}|${style.fontSize || ''}|` +
           `${style.fontFamily || ''}|${style.link?.uri || ''}`;
}

/** Font sizes are stored in points (the model's convention); Docs already emits pt. */
function parsePtSize(value) {
    if (!value) return null;
    const m = value.match(/^([\d.]+)(pt|px|em|rem)$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!n) return null;
    switch (m[2]) {
        case 'pt':  return Math.round(n);
        case 'px':  return Math.round(n * 3 / 4);
        case 'em':
        case 'rem': return Math.round(n * 12);
    }
    return null;
}

function normalizeFamily(value) {
    if (!value) return null;
    const first = value.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    return first || null;
}

/** Drop default black / transparent so cells stay clean. */
function normalizeColor(value) {
    if (!value) return null;
    const v = value.trim().toLowerCase();
    if (v === 'transparent' || v === 'inherit' || v === 'currentcolor') return null;
    if (v === '#000' || v === '#000000' || v === 'black' ||
        v === 'rgb(0, 0, 0)' || v === 'rgb(0,0,0)') return null;
    return value.trim();
}

function readAlign(el) {
    if (!el) return null;
    const a = el.style?.textAlign?.trim();
    if (a && ['left', 'center', 'right', 'justify'].includes(a)) return a;
    const attr = el.getAttribute?.('align')?.trim().toLowerCase();
    if (attr && ['left', 'center', 'right', 'justify'].includes(attr)) return attr;
    return null;
}

function readBackground(el) {
    const bg = el?.style?.backgroundColor;
    return normalizeColor(bg) ? bg.trim() : null;
}
