/**
 * Rich text support for spreadsheet cells.
 *
 * A cell value (v) can be an array of "runs":
 *   [{ t: string, b?: true, i?: true, u?: true, s?: true, c?: string, f?: number }]
 *
 * Where:
 *   t = text content (may contain \n for line breaks)
 *   b = bold override (true/false; undefined = inherit cell-level)
 *   i = italic override
 *   u = underline override
 *   s = strikethrough override
 *   c = color override (CSS color string)
 *   f = fontSize override (number in px)
 *
 * Cell-level formatting (bold, italic, color, etc.) serves as the default.
 * Run-level properties override the cell-level default for that run.
 * When whole-cell formatting is applied, run-level overrides for that
 * property are stripped so the cell-level value uniformly applies.
 */

/**
 * Map from cell-level formatting property names to run-level property keys.
 * Only properties that have a run-level equivalent are listed here.
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
 * Returns true if the value is a rich-text run array.
 * @param {any} v
 * @returns {boolean}
 */
export function isRichText(v) {
    return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && 't' in v[0];
}

/**
 * Convert a rich-text run array to a plain string.
 * @param {Array} runs
 * @returns {string}
 */
export function richTextToPlain(runs) {
    return runs.map(r => r.t).join('');
}

/**
 * Convert rich-text runs to contenteditable HTML.
 * Each \n in a run becomes a new <div> block (browser contenteditable convention).
 * @param {Array} runs
 * @returns {string}
 */
export function runsToHtml(runs) {
    // Split runs by \n to get logical lines
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
        // First line has no wrapper (contenteditable implicit first line)
        return lineIdx === 0 ? html : `<div>${html}</div>`;
    }).join('');
}

/**
 * Parse contenteditable DOM element into rich-text runs.
 * @param {HTMLElement} el
 * @returns {Array}
 */
export function htmlToRuns(el) {
    const runs = [];

    function parseNode(node, style) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text) {
                pushRun(runs, text, style);
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName.toLowerCase();
        const childStyle = { ...style };

        // Read inline styles
        const inlineStyle = node.style;
        if (inlineStyle.fontWeight === 'bold') childStyle.b = true;
        else if (inlineStyle.fontWeight === 'normal') childStyle.b = false;
        if (inlineStyle.fontStyle === 'italic') childStyle.i = true;
        else if (inlineStyle.fontStyle === 'normal') childStyle.i = false;
        if (inlineStyle.textDecoration.includes('underline')) childStyle.u = true;
        if (inlineStyle.textDecoration.includes('line-through')) childStyle.s = true;
        if (inlineStyle.color) childStyle.c = inlineStyle.color;
        if (inlineStyle.fontSize) childStyle.f = parseFloat(inlineStyle.fontSize);

        // Semantic tags
        if (tag === 'b' || tag === 'strong') childStyle.b = true;
        if (tag === 'i' || tag === 'em') childStyle.i = true;
        if (tag === 'u') childStyle.u = true;
        if (tag === 's' || tag === 'strike') childStyle.s = true;

        if (tag === 'br') {
            pushRun(runs, '\n', {});
        } else if (tag === 'div' || tag === 'p') {
            // Block element = new line (except the very first block which is the implicit first line)
            if (runs.length > 0) {
                // Only add newline if the last character wasn't already a newline
                const last = runs[runs.length - 1];
                if (!last.t.endsWith('\n')) {
                    pushRun(runs, '\n', {});
                }
            }
            for (const child of node.childNodes) {
                parseNode(child, childStyle);
            }
        } else {
            for (const child of node.childNodes) {
                parseNode(child, childStyle);
            }
        }
    }

    for (const child of el.childNodes) {
        parseNode(child, {});
    }

    // Trim trailing newline that browsers add
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
 * Strip a run-level style property from all runs (used when applying whole-cell formatting).
 * Returns new runs array (does not mutate).
 * @param {Array} runs
 * @param {string} runProp  e.g. 'b', 'i', 'c', 'f'
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
