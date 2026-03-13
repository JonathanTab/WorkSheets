/**
 * Rich text support for spreadsheet cells.
 *
 * NEW format: cell v field stores an HTML string when rich text is present.
 *   e.g. "<span style=\"font-weight:bold\">Hello</span> world"
 *
 * LEGACY format (backward compat): array of run objects
 *   [{ t: string, b?: true, i?: true, u?: true, s?: true, c?: string, f?: number }]
 *
 * isRichText(v)      → true for HTML strings (new format)
 * isRichTextArray(v) → true for run arrays   (legacy format)
 */

/**
 * Map from cell-level formatting property names to run-level property keys.
 * Kept for legacy run-array handling.
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
 * Returns true if the value is a legacy rich-text run array.
 * @param {any} v
 * @returns {boolean}
 */
export function isRichTextArray(v) {
    return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && 't' in v[0];
}

/**
 * Convert a rich-text value (HTML string or legacy run array) to plain text.
 * @param {any} v
 * @returns {string}
 */
export function richTextToPlain(v) {
    if (isRichTextArray(v)) return v.map(r => r.t).join('');
    if (isRichText(v)) {
        const el = document.createElement('div');
        el.innerHTML = v;
        return el.innerText || el.textContent || '';
    }
    return String(v ?? '');
}

/**
 * Convert an HTML string to a run array (for canvas renderer).
 * @param {string} htmlStr
 * @returns {Array}
 */
export function htmlStringToRuns(htmlStr) {
    const el = document.createElement('div');
    el.innerHTML = htmlStr;
    return htmlToRuns(el);
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

// ─── Legacy run-array helpers (kept for backward compat) ──────────────────────

/**
 * Convert rich-text runs to contenteditable HTML.
 * Each \n in a run becomes a new <div> block.
 * @param {Array} runs
 * @returns {string}
 */
export function runsToHtml(runs) {
    const lines = [[]];
    for (const run of runs) {
        const parts = run.t.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) lines.push([]);
            if (parts[i]) {
                lines[lines.length - 1].push({ ...run, t: parts[i] });
            }
        }
    }

    return lines.map((lineRuns, lineIdx) => {
        if (lineRuns.length === 0) return '<div><br></div>';
        const html = lineRuns.map(run => {
            const styles = [];
            if (run.b === true) styles.push('font-weight:bold');
            if (run.b === false) styles.push('font-weight:normal');
            if (run.i === true) styles.push('font-style:italic');
            if (run.i === false) styles.push('font-style:normal');
            const textDec = [];
            if (run.u) textDec.push('underline');
            if (run.s) textDec.push('line-through');
            if (textDec.length) styles.push(`text-decoration:${textDec.join(' ')}`);
            if (run.c) styles.push(`color:${run.c}`);
            if (run.f) styles.push(`font-size:${run.f}px`);
            const text = escapeHtml(run.t);
            if (styles.length) return `<span style="${styles.join(';')}">${text}</span>`;
            return text;
        }).join('');
        return lineIdx === 0 ? html : `<div>${html}</div>`;
    }).join('');
}

/**
 * Parse contenteditable DOM element into rich-text runs (legacy format).
 * @param {HTMLElement} el
 * @returns {Array}
 */
export function htmlToRuns(el) {
    const runs = [];

    function parseNode(node, style) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text) pushRun(runs, text, style);
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

        if (tag === 'b' || tag === 'strong') childStyle.b = true;
        if (tag === 'i' || tag === 'em') childStyle.i = true;
        if (tag === 'u') childStyle.u = true;
        if (tag === 's' || tag === 'strike') childStyle.s = true;

        if (tag === 'br') {
            pushRun(runs, '\n', {});
        } else if (tag === 'div' || tag === 'p') {
            if (runs.length > 0) {
                const last = runs[runs.length - 1];
                if (!last.t.endsWith('\n')) pushRun(runs, '\n', {});
            }
            for (const child of node.childNodes) parseNode(child, childStyle);
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

/**
 * Strip a run-level style property from all runs (legacy array format).
 * @param {Array} runs
 * @param {string} runProp
 * @returns {Array}
 */
export function stripRunProp(runs, runProp) {
    return mergeRuns(runs.map(r => {
        if (!(runProp in r)) return r;
        const copy = { ...r };
        delete copy[runProp];
        return copy;
    }));
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
    return `${run.b ?? ''}|${run.i ?? ''}|${run.u ? 1 : 0}|${run.s ? 1 : 0}|${run.c ?? ''}|${run.f ?? ''}`;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
