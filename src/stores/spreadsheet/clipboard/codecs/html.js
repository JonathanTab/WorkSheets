/**
 * codecs/html.js — text/html `<table>` encoding.
 *
 * HTML is the lingua-franca of rich cross-app clipboard: Excel, Google Sheets,
 * Word, web pages all read and write it. We embed a fingerprint <meta> so that a
 * paste can recognise our own HTML and reach for the full-fidelity JSON instead.
 *
 * Encode: Region → HTML table. Decode: HTML string → single-region model.
 */

import { buildRenderRuns, normalizeTfr } from '../../textFormatRuns.js';
import { makeModel, emptyCell, FINGERPRINT_META } from '../model.js';

// ─── Encode ────────────────────────────────────────────────────────────────────

/**
 * @param {object} region   primary region of the model
 * @param {string|null} fingerprint  session fingerprint, embedded as <meta>
 * @returns {string}
 */
export function encodeHTML(region, fingerprint = null) {
    const data = region;
    const mergeMap = {};
    for (const m of (data.merges || [])) {
        const rowspan = m.relEndRow - m.relStartRow + 1;
        const colspan = m.relEndCol - m.relStartCol + 1;
        mergeMap[`${m.relStartRow},${m.relStartCol}`] = { rowspan, colspan, isPrimary: true };
        for (let r = m.relStartRow; r <= m.relEndRow; r++) {
            for (let c = m.relStartCol; c <= m.relEndCol; c++) {
                if (r !== m.relStartRow || c !== m.relStartCol) mergeMap[`${r},${c}`] = { isPrimary: false };
            }
        }
    }

    const borderMap = {};
    for (const b of (data.borders || [])) borderMap[`${b.relRow},${b.relCol},${b.edge}`] = b;

    const fingerprintMeta = fingerprint ? `<meta name="${FINGERPRINT_META}" content="${fingerprint}">` : '';
    let html = `<meta charset="utf-8">${fingerprintMeta}<table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">`;

    if (data.colWidths?.some(w => w != null)) {
        html += '<colgroup>';
        for (const w of data.colWidths) html += w ? `<col width="${w}"/>` : '<col/>';
        html += '</colgroup>';
    }

    for (let ri = 0; ri < data.cells.length; ri++) {
        const row = data.cells[ri];
        const rh = data.rowHeights?.[ri];
        html += rh ? `<tr style="height:${rh}px;">` : '<tr>';

        for (let ci = 0; ci < row.length; ci++) {
            const mergeInfo = mergeMap[`${ri},${ci}`];
            if (mergeInfo && !mergeInfo.isPrimary) continue;

            const cell = row[ci];
            const styles = ['overflow:hidden', 'padding:2px 3px 2px 3px'];

            for (const edge of ['top', 'right', 'bottom', 'left']) {
                const b = borderMap[`${ri},${ci},${edge}`];
                if (b) styles.push(`border-${edge}:${b.width}px ${b.style} ${b.color}`);
            }

            if (cell.fontFamily)       styles.push(`font-family:${cell.fontFamily}`);
            if (cell.fontSize)         styles.push(`font-size:${cell.fontSize}pt`);
            if (cell.bold)             styles.push('font-weight:bold');
            if (cell.italic)           styles.push('font-style:italic');
            const textDecor = [];
            if (cell.underline)        textDecor.push('underline');
            if (cell.strikethrough)    textDecor.push('line-through');
            if (textDecor.length)      styles.push(`text-decoration:${textDecor.join(' ')}`);
            if (cell.color)            styles.push(`color:${cell.color}`);
            if (cell.backgroundColor)  styles.push(`background-color:${cell.backgroundColor}`);
            if (cell.horizontalAlign)  styles.push(`text-align:${cell.horizontalAlign}`);
            if (cell.verticalAlign)    styles.push(`vertical-align:${cell.verticalAlign}`);
            if (cell.wrapText === false) styles.push('white-space:nowrap');

            let spanAttrs = '';
            if (mergeInfo?.isPrimary) {
                if (mergeInfo.rowspan > 1) spanAttrs += ` rowspan="${mergeInfo.rowspan}"`;
                if (mergeInfo.colspan > 1) spanAttrs += ` colspan="${mergeInfo.colspan}"`;
            }

            html += `<td${spanAttrs} style="${styles.join(';')}">${cellContentHtml(cell)}</td>`;
        }
        html += '</tr>';
    }

    html += '</table>';
    return html;
}

function cellContentHtml(cell) {
    const str = String(cell.v ?? cell.displayValue ?? '');
    if (cell.tfr && str) return serializeRichTextHtml(str, cell.tfr);
    const escaped = escapeHtml(str);
    return cell.url ? `<a href="${escapeHtml(cell.url)}">${escaped}</a>` : escaped;
}

function serializeRichTextHtml(plainText, tfr) {
    const runs = buildRenderRuns(plainText, tfr);
    return runs.map(run => {
        const parts = run.t.split('\n');
        const encoded = parts.map((part, idx) => {
            const esc = escapeHtml(part);
            return idx < parts.length - 1 ? (esc ? `${esc}<br>` : '<br>') : esc;
        }).join('');

        const styles = [];
        if (run.f)           styles.push(`font-size:${run.f}pt`);
        if (run.ff)          styles.push(`font-family:${run.ff}`);
        if (run.b === true)  styles.push('font-weight:bold');
        if (run.b === false) styles.push('font-weight:normal');
        if (run.i === true)  styles.push('font-style:italic');
        if (run.i === false) styles.push('font-style:normal');
        const dec = [];
        if (run.u) dec.push('underline');
        if (run.s) dec.push('line-through');
        if (dec.length) styles.push(`text-decoration:${dec.join(' ')}`);
        if (run.c) styles.push(`color:${run.c}`);

        const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
        if (run.link) return `<a href="${escapeHtml(run.link)}"${styleAttr}>${encoded}</a>`;
        return styles.length ? `<span${styleAttr}>${encoded}</span>` : encoded;
    }).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Decode ────────────────────────────────────────────────────────────────────

/**
 * Parse an HTML clipboard string into a single-region external model.
 * @param {string} html
 * @returns {object|null}
 */
export function decodeHTML(html) {
    const region = parseHTMLTableToRegion(html);
    if (!region) return null;
    return makeModel({ source: 'html', fingerprint: null, origin: null, regions: [region] });
}

/**
 * Parse HTML into a Region (also used by the Google codec to merge HTML
 * formatting/borders into the compact-JSON grid). Returns null on no table.
 */
export function parseHTMLTableToRegion(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;

    const isGoogleSheets = html.includes('google-sheets-html-origin') || html.includes('data-sheets-root');

    const colWidths = [];
    for (const col of table.querySelectorAll('colgroup col')) {
        const w = col.getAttribute('width');
        colWidths.push(w ? parseInt(w, 10) : null);
    }

    const tableRows = Array.from(table.querySelectorAll('tr'));
    const numRows = tableRows.length;
    if (numRows === 0) return null;

    let numCols = colWidths.length;
    if (numCols === 0) {
        for (const tr of tableRows) {
            let count = 0;
            for (const td of tr.querySelectorAll('td, th')) count += parseInt(td.getAttribute('colspan') || '1', 10);
            if (count > numCols) numCols = count;
        }
    }
    if (numCols === 0) return null;

    const grid         = Array.from({ length: numRows }, () => Array(numCols).fill(null));
    const spanOccupied = Array.from({ length: numRows }, () => Array(numCols).fill(false));
    const rowHeights   = [];
    const collectedBorders = [];
    const merges = [];

    for (let ri = 0; ri < numRows; ri++) {
        const tr = tableRows[ri];
        const trStyle = tr.getAttribute('style') || '';
        const hMatch = trStyle.match(/height:\s*(\d+)px/);
        rowHeights.push(hMatch ? parseInt(hMatch[1], 10) : null);

        const tds = Array.from(tr.querySelectorAll('td, th'));
        let tdIdx = 0;
        let ci = 0;

        while (tdIdx < tds.length && ci < numCols) {
            while (ci < numCols && spanOccupied[ri][ci]) ci++;
            if (ci >= numCols) break;

            const td = tds[tdIdx++];
            const rowspan = Math.max(1, parseInt(td.getAttribute('rowspan') || '1', 10));
            const colspan = Math.max(1, parseInt(td.getAttribute('colspan') || '1', 10));

            if (rowspan > 1 || colspan > 1) {
                merges.push({ relStartRow: ri, relStartCol: ci, relEndRow: ri + rowspan - 1, relEndCol: ci + colspan - 1 });
            }
            for (let dr = 0; dr < rowspan; dr++) {
                for (let dc = 0; dc < colspan; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const sr = ri + dr, sc = ci + dc;
                    if (sr < numRows && sc < numCols) spanOccupied[sr][sc] = true;
                }
            }

            const tdStyle = td.getAttribute('style') || '';
            grid[ri][ci] = parseHTMLCell(td, tdStyle, isGoogleSheets);

            const cellBorders = parseCellBorderCSS(tdStyle, isGoogleSheets);
            for (const [edge, borderStyle] of Object.entries(cellBorders)) {
                if (edge === 'top' || edge === 'bottom') {
                    const bRow = edge === 'bottom' ? ri + rowspan - 1 : ri;
                    for (let dc = 0; dc < colspan; dc++) collectedBorders.push({ relRow: bRow, relCol: ci + dc, edge, ...borderStyle });
                } else {
                    const bCol = edge === 'right' ? ci + colspan - 1 : ci;
                    for (let dr = 0; dr < rowspan; dr++) collectedBorders.push({ relRow: ri + dr, relCol: bCol, edge, ...borderStyle });
                }
            }

            ci += colspan;
        }
    }

    const borders = deduplicateBorders(collectedBorders);
    const cells = grid.map(row => row.map(cell => cell ?? emptyCell()));

    // Trim trailing empty rows
    while (cells.length > 0 && cells[cells.length - 1].every(c => c.v === null)) cells.pop();
    if (cells.length === 0) return null;

    // Trim trailing empty columns
    let trimmedCols = numCols;
    while (trimmedCols > 1 && cells.every(row => (row[trimmedCols - 1]?.v ?? null) === null)) trimmedCols--;
    if (trimmedCols < numCols) {
        for (let i = 0; i < cells.length; i++) cells[i].length = trimmedCols;
        if (colWidths.length > trimmedCols) colWidths.length = trimmedCols;
    }

    return {
        range: { startRow: 0, endRow: cells.length - 1, startCol: 0, endCol: Math.max(0, trimmedCols - 1) },
        cells, borders, merges,
        dataValidations: [], conditionalFormats: [],
        rowCount: cells.length, colCount: trimmedCols,
        colWidths: colWidths.length ? colWidths : null,
        rowHeights,
    };
}

function parseHTMLCell(td, tdStyle, isGoogleSheets) {
    const styleProps = parseHTMLStyleProps(tdStyle);

    const richResult = parseInnerSpansToTfr(td);
    if (richResult?.tfr) {
        return {
            v: richResult.plainText,
            displayValue: richResult.plainText || null,
            isFormula: false,
            ...styleProps,
            tfr: richResult.tfr,
        };
    }

    const anchor = td.querySelector('a');
    let url = null;
    let rawText = richResult ? richResult.plainText.trim() : (td.textContent?.trim() ?? '');
    if (!richResult && anchor) {
        url = anchor.getAttribute('href') || null;
        rawText = anchor.textContent?.trim() || rawText;
    }

    if (!styleProps.fontSize) {
        for (const span of td.querySelectorAll('span[style]')) {
            const sp = parseHTMLStyleProps(span.getAttribute('style') || '');
            if (sp.fontSize) { styleProps.fontSize = sp.fontSize; break; }
        }
    }

    const { v, numberFormat } = inferValueFromText(rawText, tdStyle);
    const cell = { v, displayValue: rawText || null, isFormula: false, ...styleProps };
    if (numberFormat && !cell.numberFormat) cell.numberFormat = numberFormat;
    // A bare <a href> cell becomes a rich-text link run spanning the text so the
    // hyperlink survives the paste (the cell-type 'url' was retired). Skip page
    // anchors and javascript: URIs.
    if (url && rawText && !url.startsWith('#') && !url.startsWith('javascript:')) {
        cell.tfr = [{ startIndex: 0, format: { link: { uri: url } } }];
    }
    return cell;
}

/**
 * Walk a <td>'s inner DOM collecting text runs with accumulated inline styles.
 * Returns { plainText, tfr } when content exists (tfr non-null only for varying
 * styles); null when empty.
 */
function parseInnerSpansToTfr(td) {
    const flatRuns = [];

    function walk(node, style) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (!text) return;
            const last = flatRuns[flatRuns.length - 1];
            if (last && last._key === style._key) last.text += text;
            else flatRuns.push({ text, ...style });
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName.toLowerCase();
        if (tag === 'br') {
            if (flatRuns.length > 0) flatRuns[flatRuns.length - 1].text += '\n';
            else flatRuns.push({ text: '\n', _key: '{}' });
            return;
        }

        const s = { ...style };
        const cs = node.style;
        if (cs) {
            const weight = cs.fontWeight?.toLowerCase?.() || '';
            const weightNum = parseInt(weight, 10);
            if (weight === 'bold' || weight === 'bolder' || (!isNaN(weightNum) && weightNum >= 600)) s.bold = true;
            else if (weight === 'normal' || (!isNaN(weightNum) && weightNum < 600)) delete s.bold;
            if (cs.fontStyle === 'italic') s.italic = true;
            else if (cs.fontStyle === 'normal') delete s.italic;
            const textDecoration = `${cs.textDecoration || ''} ${cs.textDecorationLine || ''}`.toLowerCase();
            if (textDecoration) {
                if (textDecoration.includes('underline')) s.underline = true;
                if (textDecoration.includes('line-through')) s.strikethrough = true;
            }
            if (cs.color) s.foregroundColor = cs.color;
            if (cs.fontSize) {
                const m = cs.fontSize.match(/^(\d+(?:\.\d+)?)(pt|px|em|rem)$/);
                if (m) {
                    const v = parseFloat(m[1]);
                    s.fontSize = m[2] === 'pt' ? Math.round(v)
                              : m[2] === 'px' ? Math.round(v * 3 / 4)
                              : Math.round(v * 12);
                }
            }
            if (cs.fontFamily) s.fontFamily = cs.fontFamily.trim().replace(/^['"]|['"]$/g, '');
        }
        if (tag === 'b' || tag === 'strong') s.bold = true;
        if (tag === 'i' || tag === 'em')     s.italic = true;
        if (tag === 'u')                     s.underline = true;
        if (tag === 's' || tag === 'strike') s.strikethrough = true;
        const dataLink = node.getAttribute?.('data-link');
        if (dataLink) s.link = { uri: dataLink };
        if (tag === 'a') {
            const href = node.getAttribute('href');
            if (href && !href.startsWith('#') && !href.startsWith('javascript:')) s.link = { uri: href };
        }

        const { _key: _old, text: _t, ...fmt } = s;
        s._key = JSON.stringify(fmt);

        for (const child of node.childNodes) walk(child, s);
    }

    for (const child of td.childNodes) walk(child, { _key: '{}' });

    if (flatRuns.length === 0) return null;
    const plainText = flatRuns.map(r => r.text).join('');
    if (!plainText) return null;

    const hasFormatting = flatRuns.some(r => r._key !== '{}');
    if (!hasFormatting) return { plainText, tfr: null };

    const firstKey = flatRuns[0]._key;
    if (flatRuns.every(r => r._key === firstKey)) return { plainText, tfr: null };

    let offset = 0;
    const tfrRuns = [];
    let prevKey = '';
    for (const run of flatRuns) {
        const { text, _key, ...rawStyle } = run;
        const fmt = {};
        if (rawStyle.bold !== undefined)   fmt.bold = rawStyle.bold;
        if (rawStyle.italic !== undefined) fmt.italic = rawStyle.italic;
        if (rawStyle.underline)            fmt.underline = true;
        if (rawStyle.strikethrough)        fmt.strikethrough = true;
        if (rawStyle.foregroundColor)      fmt.foregroundColor = rawStyle.foregroundColor;
        if (rawStyle.fontSize)             fmt.fontSize = rawStyle.fontSize;
        if (rawStyle.fontFamily)           fmt.fontFamily = rawStyle.fontFamily;
        if (rawStyle.link)                 fmt.link = rawStyle.link;
        const key = JSON.stringify(fmt);
        if (key !== prevKey) { tfrRuns.push({ startIndex: offset, format: fmt }); prevKey = key; }
        offset += text.length;
    }

    const tfr = normalizeTfr(tfrRuns, plainText.length);
    if (!tfr) return null;
    return { plainText, tfr };
}

function parseHTMLStyleProps(style) {
    const props = {};
    if (!style) return props;

    const ffMatch = style.match(/font-family:\s*([^;]+)/);
    if (ffMatch) props.fontFamily = ffMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const fsMatch = style.match(/font-size:\s*(\d+(?:\.\d+)?)(pt|px|em|rem)/);
    if (fsMatch) {
        // Storage is points; normalize the CSS unit to pt (mirrors the tfr decode
        // in parseInnerSpansToTfr so cell- and run-level sizes agree).
        const val = parseFloat(fsMatch[1]);
        switch (fsMatch[2]) {
            case 'pt':  props.fontSize = Math.round(val);         break;
            case 'px':  props.fontSize = Math.round(val * 3 / 4); break;
            case 'em':
            case 'rem': props.fontSize = Math.round(val * 12);    break;
        }
    }

    const fwMatch = style.match(/font-weight:\s*([^;]+)/i);
    if (fwMatch) {
        const fw = fwMatch[1].trim().toLowerCase();
        const n = parseInt(fw, 10);
        if (fw === 'bold' || fw === 'bolder' || (!isNaN(n) && n >= 600)) props.bold = true;
        else if (fw === 'normal' || (!isNaN(n) && n < 600)) props.bold = false;
    }

    const fiMatch = style.match(/font-style:\s*(\w+)/);
    if (fiMatch) props.italic = fiMatch[1] === 'italic' || fiMatch[1] === 'oblique';

    const tdMatch = style.match(/text-decoration:\s*([^;]+)/i);
    const tdlMatch = style.match(/text-decoration-line:\s*([^;]+)/i);
    const dec = `${tdMatch?.[1] || ''} ${tdlMatch?.[1] || ''}`.toLowerCase();
    if (dec) {
        if (dec.includes('underline')) props.underline = true;
        if (dec.includes('line-through')) props.strikethrough = true;
        if (dec.includes('none')) { props.underline = false; props.strikethrough = false; }
    }

    const colorMatch = style.match(/(?:^|[\s;])color:\s*([^;]+)/);
    if (colorMatch) props.color = colorMatch[1].trim();

    const bgMatch = style.match(/background-color:\s*([^;]+)/);
    if (bgMatch) props.backgroundColor = bgMatch[1].trim();

    const haMatch = style.match(/text-align:\s*(\w+)/);
    if (haMatch) {
        const ha = haMatch[1].trim();
        if (['left', 'center', 'right', 'justify'].includes(ha)) props.horizontalAlign = ha;
    }

    const vaMatch = style.match(/vertical-align:\s*(\w+)/);
    if (vaMatch) {
        const va = vaMatch[1].trim();
        if (['top', 'middle', 'bottom'].includes(va)) props.verticalAlign = va;
    }

    const wsMatch = style.match(/white-space:\s*(\S+)/);
    if (wsMatch) props.wrapText = wsMatch[1] !== 'nowrap' && wsMatch[1] !== 'pre';

    return props;
}

// Google Sheets serializes its grey gridlines as a 1px solid border on every
// pasted <td>. These aren't borders the user applied — they're an artifact of
// the renderer leaking into the clipboard payload. Capturing them stamps a
// gridline-coloured border on every cell, which previously inflated docs by
// hundreds of KB and shipped a visual difference from the source.
const GOOGLE_GRIDLINE_COLORS = new Set([
    'rgb(204, 204, 204)',
    'rgb(204,204,204)',
    '#cccccc',
]);

function isGoogleGridlineBorder(parsed) {
    if (!parsed) return false;
    if (parsed.style !== 'solid') return false;
    if (parsed.width !== 1) return false;
    return GOOGLE_GRIDLINE_COLORS.has(String(parsed.color).toLowerCase().replace(/\s+/g, ' ').trim());
}

function parseCellBorderCSS(style, isGoogleSheets) {
    const borders = {};
    if (!style) return borders;
    const shorthand = style.match(/(?:^|;)\s*border:\s*([^;]+)/i);
    if (shorthand) {
        const parsed = parseBorderValue(shorthand[1].trim());
        if (parsed && !(isGoogleSheets && isGoogleGridlineBorder(parsed))) {
            borders.top = parsed; borders.right = parsed; borders.bottom = parsed; borders.left = parsed;
        }
    }
    for (const edge of ['top', 'right', 'bottom', 'left']) {
        const match = style.match(new RegExp(`(?:^|;)\\s*border-${edge}:\\s*([^;]+)`, 'i'));
        if (match) {
            const parsed = parseBorderValue(match[1].trim());
            if (parsed && isGoogleSheets && isGoogleGridlineBorder(parsed)) {
                // A per-edge gridline overrides the shorthand — clear that edge.
                delete borders[edge];
                continue;
            }
            if (parsed) borders[edge] = parsed;
        }
    }
    return borders;
}

function parseBorderValue(value) {
    if (!value || value.trim() === 'none') return null;
    const trimmed = value.trim().toLowerCase();
    const styleMatch = trimmed.match(/\b(solid|dashed|dotted|double)\b/);
    const widthMatch = trimmed.match(/(\d+(?:\.\d+)?)(px|pt)?/);
    const colorMatch = trimmed.match(/(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-z]+)\s*$/i);

    if (!styleMatch) return null;
    const unit = widthMatch?.[2] || 'px';
    const rawWidth = widthMatch ? parseFloat(widthMatch[1]) : 1;
    const width = unit === 'pt' ? Math.round(rawWidth * 4 / 3) : rawWidth;
    const color = colorMatch ? colorMatch[1] : '#000000';
    if (color === 'transparent') return null; // Google's overflow-visible sentinel
    return { width, style: styleMatch[1], color };
}

export function inferValueFromText(text) {
    if (!text || text === '') return { v: null };
    if (text === 'TRUE')  return { v: true };
    if (text === 'FALSE') return { v: false };
    const numericPattern = /^[+-]?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?$/;
    if (numericPattern.test(text)) {
        const n = parseFloat(text.replace(/,/g, ''));
        if (!isNaN(n)) return { v: n };
    }
    const currencyPattern = /^(-?)[$€£¥]([\d,]+(?:\.\d+)?)$/;
    const cm = text.match(currencyPattern);
    if (cm) {
        const n = parseFloat((cm[1] + cm[2]).replace(/,/g, ''));
        if (!isNaN(n)) return { v: n, numberFormat: '"$"#,##0.00' };
    }
    return { v: text };
}

function deduplicateBorders(borders) {
    const seen = new Map();
    for (const b of borders) {
        const key = `${b.relRow},${b.relCol},${b.edge}`;
        if (!seen.has(key)) seen.set(key, b);
    }
    return Array.from(seen.values());
}
