/**
 * Rich text support for spreadsheet cells.
 *
 * Format: cell v field stores an HTML string when rich text is present.
 *   e.g. "<span style=\"font-weight:bold\">Hello</span> world"
 *
 * isRichText(v) → true for HTML strings
 */

/**
 * Map from cell-level formatting property names to CSS property names.
 * Used by stripHtmlProp to know which inline styles to strip when applying
 * whole-cell formatting to a rich-text cell.
 */
export const RUN_STYLE_PROP_MAP = {
    bold: 'b',
    italic: 'i',
    underline: 'u',
    strikethrough: 's',
    color: 'c',
    fontSize: 'f',
};

/**
 * Returns true if the value is a rich-text HTML string (new format).
 * Detects presence of HTML tags produced by contenteditable formatting.
 * @param {any} v
 * @returns {boolean}
 */
export function isRichText(v) {
    return typeof v === 'string' && /<(?:span|b|strong|i|em|u|s|strike|div|br)\b/i.test(v);
}

/**
 * Convert a rich-text HTML string to plain text.
 * Uses the cached runs when available to avoid a second DOM parse.
 * @param {any} v
 * @returns {string}
 */
export function richTextToPlain(v) {
    if (!isRichText(v)) return String(v ?? '');
    const cachedRuns = _htmlRunsCache.get(v);
    if (cachedRuns) return cachedRuns.map(r => r.t).join('');
    const el = document.createElement('div');
    el.innerHTML = v;
    return el.innerText || el.textContent || '';
}

/**
 * Fast plain-text extraction from already-parsed runs.
 * Use when you already have runs and just need plain text.
 * @param {Array} runs
 * @returns {string}
 */
export function runsToPlainText(runs) {
    if (!runs || runs.length === 0) return '';
    return runs.map(r => r.t).join('');
}

/**
 * Convert an HTML string to a run array (for canvas renderer).
 * Cached — DOM parsing is expensive and the same HTML appears many times
 * during scroll repaints.
 * @param {string} htmlStr
 * @returns {Array}
 */
const _htmlRunsCache = new Map();
const _HTML_RUNS_CACHE_MAX = 2000;

export function htmlStringToRuns(htmlStr) {
    const cached = _htmlRunsCache.get(htmlStr);
    if (cached) return cached;

    const el = document.createElement('div');
    el.innerHTML = htmlStr;
    const runs = htmlToRuns(el);

    if (_htmlRunsCache.size >= _HTML_RUNS_CACHE_MAX) {
        // Evict oldest half
        const keys = _htmlRunsCache.keys();
        for (let i = 0; i < _HTML_RUNS_CACHE_MAX / 2; i++) {
            _htmlRunsCache.delete(keys.next().value);
        }
    }
    _htmlRunsCache.set(htmlStr, runs);
    return runs;
}

/**
 * Invalidate the htmlStringToRuns cache (call when cell values change).
 */
export function clearHtmlRunsCache() {
    _htmlRunsCache.clear();
}

/**
 * Strip a cell-level formatting property from all inline styles in an HTML string.
 * Used when applying whole-cell formatting to a rich-text cell, so the cell-level
 * value wins uniformly.
 * @param {string} htmlStr
 * @param {string} cellPropName  e.g. 'bold', 'italic', 'color', 'fontSize'
 * @returns {string}
 */
export function stripHtmlProp(htmlStr, cellPropName) {
    const el = document.createElement('div');
    el.innerHTML = htmlStr;

    el.querySelectorAll('[style]').forEach(node => {
        if (cellPropName === 'bold') {
            node.style.removeProperty('font-weight');
        } else if (cellPropName === 'italic') {
            node.style.removeProperty('font-style');
        } else if (cellPropName === 'underline') {
            const td = (node.style.textDecoration || '').replace(/\bunderline\b/g, '').trim();
            if (td) node.style.textDecoration = td;
            else node.style.removeProperty('text-decoration');
        } else if (cellPropName === 'strikethrough') {
            const td = (node.style.textDecoration || '').replace(/\bline-through\b/g, '').trim();
            if (td) node.style.textDecoration = td;
            else node.style.removeProperty('text-decoration');
        } else if (cellPropName === 'color') {
            node.style.removeProperty('color');
        } else if (cellPropName === 'fontSize') {
            node.style.removeProperty('font-size');
        }
        if (!node.getAttribute('style')) node.removeAttribute('style');
    });

    // Remove semantic tags whose meaning matches the stripped property
    if (cellPropName === 'bold') {
        el.querySelectorAll('b, strong').forEach(n => n.replaceWith(...n.childNodes));
    } else if (cellPropName === 'italic') {
        el.querySelectorAll('i, em').forEach(n => n.replaceWith(...n.childNodes));
    } else if (cellPropName === 'underline') {
        el.querySelectorAll('u').forEach(n => n.replaceWith(...n.childNodes));
    } else if (cellPropName === 'strikethrough') {
        el.querySelectorAll('s, strike').forEach(n => n.replaceWith(...n.childNodes));
    }

    // Clean up empty unstyled spans
    el.querySelectorAll('span:not([style])').forEach(n => n.replaceWith(...n.childNodes));

    return el.innerHTML;
}

/**
 * Parse contenteditable DOM element into rich-text runs.
 * @param {HTMLElement} el
 * @returns {Array}
 */
export function htmlToRuns(el) {
    const runs = [];

    // True when the most recent \n was added as a block-boundary separator
    // (from a closing div/p), rather than from a <br> tag or text content.
    // Used to prevent a <br> immediately after a block boundary from doubling
    // the newline — while still allowing <br><br> to create a blank line.
    let lastNewlineIsBlockBoundary = false;

    function parseNode(node, style) {
        if (node.nodeType === Node.TEXT_NODE) {
            // Strip zero-width spaces inserted by insertRichLineBreak
            const text = node.textContent.replace(/\u200B/g, '');
            if (text) {
                pushRun(runs, text, style);
                lastNewlineIsBlockBoundary = false;
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName.toLowerCase();
        const childStyle = { ...style };

        const inlineStyle = node.style;
        if (inlineStyle.fontWeight === 'bold') childStyle.b = true;
        else if (inlineStyle.fontWeight === 'normal') childStyle.b = false;
        if (inlineStyle.fontStyle === 'italic') childStyle.i = true;
        else if (inlineStyle.fontStyle === 'normal') childStyle.i = false;
        if (inlineStyle.textDecoration.includes('underline')) childStyle.u = true;
        if (inlineStyle.textDecoration.includes('line-through')) childStyle.s = true;
        if (inlineStyle.color) childStyle.c = inlineStyle.color;
        if (inlineStyle.fontSize) childStyle.f = parseFloat(inlineStyle.fontSize);
        if (inlineStyle.fontFamily) childStyle.ff = inlineStyle.fontFamily;

        if (tag === 'b' || tag === 'strong') childStyle.b = true;
        if (tag === 'i' || tag === 'em') childStyle.i = true;
        if (tag === 'u') childStyle.u = true;
        if (tag === 's' || tag === 'strike') childStyle.s = true;

        if (tag === 'br') {
            if (lastNewlineIsBlockBoundary) {
                // A <br> immediately after a block boundary is part of that transition —
                // absorb it so <div>text</div><br> stays as "text\n" not "text\n\n".
                lastNewlineIsBlockBoundary = false;
            } else {
                // <br> after text or another <br>: always insert a newline.
                // This correctly turns <br><br> into a blank line (\n\n).
                pushRun(runs, '\n', {});
                lastNewlineIsBlockBoundary = false;
            }
        } else if (tag === 'div' || tag === 'p') {
            // Block elements represent a new line. Only add the separator newline
            // if there's prior content and the last run doesn't already end with \n.
            if (runs.length > 0) {
                const last = runs[runs.length - 1];
                if (!last.t.endsWith('\n')) {
                    pushRun(runs, '\n', {});
                    lastNewlineIsBlockBoundary = true;
                }
            }
            // If the div contains only a single <br> (empty line), push an extra \n
            // to represent the blank paragraph content. This preserves consecutive
            // blank lines (each <div><br></div> = one blank line = one extra \n).
            const onlyBr =
                node.childNodes.length === 1 &&
                node.childNodes[0].nodeType === Node.ELEMENT_NODE &&
                node.childNodes[0].tagName.toLowerCase() === 'br';
            if (onlyBr) {
                pushRun(runs, '\n', {});
                lastNewlineIsBlockBoundary = false;
            } else {
                for (const child of node.childNodes) parseNode(child, childStyle);
            }
            // Block end doesn't reset lastNewlineIsBlockBoundary — it was already
            // set (or not) during the separator-\n push above.
        } else {
            for (const child of node.childNodes) parseNode(child, childStyle);
        }
    }

    for (const child of el.childNodes) parseNode(child, {});

    if (runs.length > 0) {
        const last = runs[runs.length - 1];
        if (last.t === '\n') runs.pop();
        else if (last.t.endsWith('\n')) {
            last.t = last.t.slice(0, -1);
            if (!last.t) runs.pop();
        }
    }

    return mergeRuns(runs.length === 0 ? [{ t: '' }] : runs);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function pushRun(runs, text, style) {
    const run = { t: text };
    if (style.b !== undefined) run.b = style.b;
    if (style.i !== undefined) run.i = style.i;
    if (style.u) run.u = true;
    if (style.s) run.s = true;
    if (style.c) run.c = style.c;
    if (style.f) run.f = style.f;
    if (style.ff) run.ff = style.ff;

    const last = runs[runs.length - 1];
    if (last && styleKey(last) === styleKey(run)) {
        last.t += text;
    } else {
        runs.push(run);
    }
}

function mergeRuns(runs) {
    const result = [];
    for (const run of runs) {
        const last = result[result.length - 1];
        if (last && styleKey(last) === styleKey(run)) {
            last.t += run.t;
        } else {
            result.push({ ...run });
        }
    }
    return result;
}

function styleKey(run) {
    return `${run.b ?? ''}|${run.i ?? ''}|${run.u ? 1 : 0}|${run.s ? 1 : 0}|${run.c ?? ''}|${run.f ?? ''}|${run.ff ?? ''}`;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
