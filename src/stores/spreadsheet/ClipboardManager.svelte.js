/**
 * ClipboardManager - v3
 *
 * Clipboard event handling strategy:
 *
 * COPY / CUT:
 *   Keyboard (Ctrl+C / Ctrl+X):
 *     1. keydown handler calls copy()/cut() — extracts data, stores in memory, sets
 *        _pendingCopyPayload, kicks off async write as background fallback.
 *     2. keydown does NOT preventDefault, so the browser proceeds and fires a native
 *        `copy` event on the focused element.
 *     3. svelte:window oncopy → handleNativeCopyEvent() intercepts, calls e.preventDefault()
 *        and writes all MIME formats via e.clipboardData.setData(). This path is
 *        synchronous, permission-free, and supports custom MIME types directly.
 *   Context menu Copy:
 *     copy() is called directly; falls back to navigator.clipboard.write() async,
 *     which writes standard types + the 'web ' prefixed custom type for Chrome 104+.
 *
 * PASTE:
 *   Keyboard (Ctrl+V):
 *     keydown sets _pendingPasteMode and does NOT preventDefault. The browser fires a
 *     native `paste` event → handleNativePasteEvent() reads e.clipboardData with full
 *     MIME type access (including custom types). Priority order:
 *       SCRIPTORIUM_MIME → SCRIPTORIUM_MIME_WEB → fingerprint-matched in-memory →
 *       Google compact JSON → HTML table → TSV
 *   Context menu Paste:
 *     paste() validates in-memory clipboard against the system clipboard fingerprint
 *     (embedded in HTML as a <meta> tag). If valid, uses full-fidelity in-memory data.
 *     Otherwise reads system clipboard via navigator.clipboard.read().
 *
 * In-app fidelity:
 *   A UUID fingerprint is generated on every copy/cut and stored in the in-memory
 *   clipboard. It is also embedded in the HTML clipboard data as
 *   <meta name="x-scriptorium-id" content="UUID">. On paste, matching fingerprints
 *   allow context menu paste to use the full-fidelity in-memory data.
 */

import { buildRenderRuns, normalizeTfr } from './textFormatRuns.js';

// ─── MIME types ──────────────────────────────────────────────────────────────

/** App-specific MIME — readable via native copy/paste events (Firefox, Safari) */
const SCRIPTORIUM_MIME = 'application/x-scriptorium-clipboard+json';

/**
 * 'web ' prefixed variant — required for ClipboardItem custom types in Chrome 104+.
 * When read back via navigator.clipboard.read(), the 'web ' prefix is stripped.
 */
const SCRIPTORIUM_MIME_WEB = 'web application/x-scriptorium-clipboard+json';

/** Google Sheets internal compact format — available in native paste events */
const GOOGLE_COMPACT_MIME = 'application/x-vnd.google-spreadsheet-compact-table+json';

/** Meta tag name used to embed the session fingerprint inside the HTML clipboard */
const FINGERPRINT_META = 'x-scriptorium-id';

// ─── Selection state injection (avoids circular dependency) ──────────────────

let _selectionState = null;

/**
 * @param {import('./SelectionState.svelte.js').SelectionState} state
 */
export function setSelectionState(state) {
    _selectionState = state;
}

function getSelectionState() {
    return _selectionState;
}

// ─── ClipboardManager ────────────────────────────────────────────────────────

class ClipboardManager {
    constructor() {
        /** @type {{ type: string, range: object, data: object, fingerprint: string } | null} */
        this.clipboardData = $state(null);

        /** @type {'copy' | 'cut' | null} */
        this.clipboardType = $state(null);

        /** Set by Grid keydown 'v'; consumed by the native paste event handler */
        this._pendingPasteMode = null;

        /** Set by copy()/cut(); consumed by handleNativeCopyEvent() */
        this._pendingCopyPayload = null;
    }

    // ─── Fingerprint ─────────────────────────────────────────────────────────

    #generateFingerprint() {
        return typeof crypto?.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    // ─── Copy ─────────────────────────────────────────────────────────────────

    copy(sheetStore, session) {
        const sel = getSelectionState();
        const allRanges = sel?.allRanges ?? [];
        if (allRanges.length === 0 || !sheetStore) return;

        const rangeDataList = allRanges.map(range => ({
            range: { ...range },
            data: this.extractRangeData(sheetStore, session, range),
        }));
        const fingerprint = this.#generateFingerprint();
        const { range: firstRange, data: firstData } = rangeDataList[0];

        this.clipboardData = { type: 'copy', range: firstRange, data: firstData, ranges: rangeDataList, fingerprint };
        this.clipboardType = 'copy';

        // For keyboard copy: native copy event fires after keydown (no preventDefault),
        // and handleNativeCopyEvent() will consume this payload synchronously.
        // For context menu copy: the async write below is the primary path.
        this._pendingCopyPayload = { data: firstData, range: firstRange, ranges: rangeDataList, fingerprint };
        this.#writeAsyncClipboard(firstData, firstRange, fingerprint, rangeDataList).catch(() => {});
    }

    // ─── Cut ─────────────────────────────────────────────────────────────────

    cut(sheetStore, session, ydoc) {
        const sel = getSelectionState();
        const allRanges = sel?.allRanges ?? [];
        if (allRanges.length === 0 || !sheetStore) return;

        const rangeDataList = allRanges.map(range => ({
            range: { ...range },
            data: this.extractRangeData(sheetStore, session, range),
        }));
        const fingerprint = this.#generateFingerprint();
        const { range: firstRange, data: firstData } = rangeDataList[0];

        this.clipboardData = { type: 'cut', range: firstRange, data: firstData, ranges: rangeDataList, fingerprint };
        this.clipboardType = 'cut';

        this._pendingCopyPayload = { data: firstData, range: firstRange, ranges: rangeDataList, fingerprint };
        this.#writeAsyncClipboard(firstData, firstRange, fingerprint, rangeDataList).catch(() => {});

        // Clear all source ranges immediately
        ydoc?.transact(() => {
            for (const { range } of rangeDataList) {
                for (let r = range.startRow; r <= range.endRow; r++) {
                    for (let c = range.startCol; c <= range.endCol; c++) {
                        sheetStore.clearCellValue(r, c);
                    }
                }
            }
        });
    }

    // ─── Native Copy Event Handler ────────────────────────────────────────────

    /**
     * Called from Grid's svelte:window oncopy handler.
     *
     * The browser fires a `copy` event after the keydown handler runs (provided
     * keydown did NOT call preventDefault). We intercept it here, call
     * e.preventDefault() to suppress the browser's own copy (which would write
     * whatever text is selected — nothing for a canvas grid), and write all our
     * MIME formats synchronously via e.clipboardData.setData().
     *
     * This path is permission-free and is the most compatible way to write custom
     * MIME types to the clipboard.
     *
     * @param {ClipboardEvent} e
     */
    handleNativeCopyEvent(e) {
        const payload = this._pendingCopyPayload;
        if (!payload) return; // Not our copy (e.g. user copied text in an input)
        this._pendingCopyPayload = null;

        e.preventDefault();

        const { data, range, fingerprint, ranges } = payload;
        const tsv  = this.generateTSV(data);
        const html = this.generateHTMLTable(data, fingerprint);
        const json = this.#serializeJSON(data, range, fingerprint, ranges?.length > 1 ? ranges : null);

        e.clipboardData.setData('text/plain', tsv);
        e.clipboardData.setData('text/html', html);

        // Custom MIME type — works in Firefox and Safari via the native event.
        // Chrome ignores non-standard types here; it needs the 'web ' prefix via
        // ClipboardItem (handled in #writeAsyncClipboard).
        try { e.clipboardData.setData(SCRIPTORIUM_MIME, json); } catch (_) { /* browser may reject */ }
    }

    // ─── Async Clipboard Write (fallback / context menu) ─────────────────────

    /**
     * Write all clipboard formats via the async Clipboard API.
     * Used as a fallback when the native copy event is not available (context menu)
     * and to write the 'web ' prefixed custom type for Chrome 104+.
     */
    async #writeAsyncClipboard(data, range, fingerprint, rangeDataList = null) {
        const tsv  = this.generateTSV(data);
        const html = this.generateHTMLTable(data, fingerprint);
        const json = this.#serializeJSON(data, range, fingerprint, rangeDataList?.length > 1 ? rangeDataList : null);

        /** @type {Record<string, Blob>} */
        const itemTypes = {
            'text/plain': new Blob([tsv],  { type: 'text/plain' }),
            'text/html':  new Blob([html], { type: 'text/html' }),
        };

        // Chrome 104+: custom types require the 'web ' prefix as the ClipboardItem key.
        // The Blob itself should use the un-prefixed MIME type.
        try {
            itemTypes[SCRIPTORIUM_MIME_WEB] = new Blob([json], { type: SCRIPTORIUM_MIME });
        } catch (_) { /* unsupported */ }

        try {
            await navigator.clipboard.write([new ClipboardItem(itemTypes)]);
        } catch (_) {
            // Permission denied or ClipboardItem not supported.
            // In-memory clipboard is the fallback for in-app paste.
            try { await navigator.clipboard.writeText(tsv); } catch (_2) { /* give up */ }
        }
    }

    // ─── JSON Serialization ───────────────────────────────────────────────────

    #serializeJSON(data, range, fingerprint, rangeDataList = null) {
        if (rangeDataList && rangeDataList.length > 1) {
            return JSON.stringify({
                version: 4,
                source: 'scriptorium',
                fingerprint,
                multiRange: true,
                ranges: rangeDataList.map(({ range: r, data: d }) => ({
                    range: { startRow: r.startRow, endRow: r.endRow, startCol: r.startCol, endCol: r.endCol },
                    cells:              d.cells,
                    borders:            d.borders,
                    merges:             d.merges,
                    dataValidations:    d.dataValidations,
                    conditionalFormats: d.conditionalFormats,
                    rowHeights:         d.rowHeights,
                    colWidths:          d.colWidths,
                })),
                // Legacy compat: first range inline
                range: { startRow: range.startRow, endRow: range.endRow, startCol: range.startCol, endCol: range.endCol },
                cells:              data.cells,
                borders:            data.borders,
                merges:             data.merges,
                dataValidations:    data.dataValidations,
                conditionalFormats: data.conditionalFormats,
                rowHeights:         data.rowHeights,
                colWidths:          data.colWidths,
            });
        }
        return JSON.stringify({
            version: 3,
            source: 'scriptorium',
            fingerprint,
            range: {
                startRow: range.startRow, endRow: range.endRow,
                startCol: range.startCol, endCol: range.endCol,
            },
            cells:              data.cells,
            borders:            data.borders,
            merges:             data.merges,
            dataValidations:    data.dataValidations,
            conditionalFormats: data.conditionalFormats,
            rowHeights:         data.rowHeights,
            colWidths:          data.colWidths,
        });
    }

    /** @returns {{ cells, borders, merges, dataValidations, conditionalFormats, rowHeights, colWidths, rowCount, colCount, fingerprint, multiRange?, ranges? } | null} */
    #parseInternalJSON(jsonStr) {
        try {
            const json = JSON.parse(jsonStr);
            if (json.source !== 'scriptorium' || !Array.isArray(json.cells)) return null;
            const base = {
                cells:              json.cells,
                borders:            json.borders            || [],
                merges:             json.merges             || [],
                dataValidations:    json.dataValidations    || [],
                conditionalFormats: json.conditionalFormats || [],
                rowHeights:         json.rowHeights         || null,
                colWidths:          json.colWidths          || null,
                rowCount:           json.cells.length,
                colCount:           json.cells[0]?.length   || 0,
                fingerprint:        json.fingerprint        || null,
            };
            if (json.multiRange && Array.isArray(json.ranges)) {
                base.multiRange = true;
                base.ranges = json.ranges.map(item => ({
                    range: item.range,
                    data: {
                        cells:              item.cells,
                        borders:            item.borders            || [],
                        merges:             item.merges             || [],
                        dataValidations:    item.dataValidations    || [],
                        conditionalFormats: item.conditionalFormats || [],
                        rowHeights:         item.rowHeights         || null,
                        colWidths:          item.colWidths          || null,
                        rowCount:           item.cells.length,
                        colCount:           item.cells[0]?.length   || 0,
                    },
                }));
            }
            return base;
        } catch (_) {
            return null;
        }
    }

    // ─── Extract Range Data ───────────────────────────────────────────────────

    extractRangeData(sheetStore, session, range) {
        const cells = [];
        const borders = [];
        const merges = [];
        const dataValidations = [];
        const conditionalFormats = [];
        const rowHeights = [];
        const colWidths = [];
        const { startRow, endRow, startCol, endCol } = range;

        // Cell data
        for (let r = startRow; r <= endRow; r++) {
            const rowData = [];
            for (let c = startCol; c <= endCol; c++) {
                const cell = sheetStore.getCell(r, c);
                const ct   = sheetStore.getCellTypeConfig(r, c);
                // For table cells, cell.exists is false (data lives in TableStore rows,
                // not the sheet cell map). Fall back to session.getCellDisplayValue which
                // now delegates to TableManager for those cells.
                const dispVal = session.getCellDisplayValue(r, c);
                rowData.push({
                    // v holds the raw Yjs value: formula string ("=…") or scalar.
                    // For table cells (cell.exists=false) use the display value as the value.
                    v:            cell.exists ? cell.v : (dispVal !== '' ? dispVal : null),
                    isFormula:    cell.exists && cell.v && String(cell.v).startsWith('='),
                    displayValue: dispVal !== '' ? dispVal : null,
                    tfr:          cell.tfr              || null,
                    ct:           ct            || null,
                    numberFormat: cell.numberFormat     || null,
                    fontFamily:   cell.fontFamily       || null,
                    fontSize:     cell.fontSize         || null,
                    bold:         cell.bold             || false,
                    italic:       cell.italic           || false,
                    underline:    cell.underline        || false,
                    strikethrough:cell.strikethrough    || false,
                    color:        cell.color            || null,
                    backgroundColor: cell.backgroundColor || null,
                    horizontalAlign: cell.horizontalAlign || null,
                    verticalAlign:   cell.verticalAlign   || null,
                    wrapText:     cell.wrapText         || false,
                });
            }
            cells.push(rowData);
        }

        // Borders
        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                const cellBorders = sheetStore.getCellBorders(r, c);
                for (const edge of ['top', 'bottom', 'left', 'right']) {
                    const shouldInclude =
                        (edge === 'top'    && (r === startRow || !this.bordersEqual(cellBorders.top,    sheetStore.getCellBorders(r - 1, c).bottom))) ||
                        (edge === 'bottom' && r === endRow) ||
                        (edge === 'left'   && (c === startCol || !this.bordersEqual(cellBorders.left,   sheetStore.getCellBorders(r, c - 1).right))) ||
                        (edge === 'right'  && c === endCol);
                    if (shouldInclude && cellBorders[edge]) {
                        borders.push({
                            relRow: r - startRow, relCol: c - startCol, edge,
                            style: cellBorders[edge].style,
                            width: cellBorders[edge].width,
                            color: cellBorders[edge].color,
                        });
                    }
                }
            }
        }

        // Merges that fall entirely within the range
        const allMerges = sheetStore.getMerges?.() || [];
        for (const merge of allMerges) {
            if (merge.startRow >= startRow && merge.endRow <= endRow &&
                merge.startCol >= startCol && merge.endCol <= endCol) {
                merges.push({
                    relStartRow: merge.startRow - startRow,
                    relStartCol: merge.startCol - startCol,
                    relEndRow:   merge.endRow   - startRow,
                    relEndCol:   merge.endCol   - startCol,
                });
            }
        }

        // Data validations that fall entirely within the range
        const allValidations = sheetStore.getDataValidations?.() || [];
        for (const rule of allValidations) {
            if (rule.startRow >= startRow && rule.endRow <= endRow &&
                rule.startCol >= startCol && rule.endCol <= endCol) {
                dataValidations.push({
                    ...rule,
                    startRow: rule.startRow - startRow,
                    startCol: rule.startCol - startCol,
                    endRow:   rule.endRow   - startRow,
                    endCol:   rule.endCol   - startCol,
                });
            }
        }

        // Conditional formats that fall entirely within the range
        const allCondFormats = sheetStore.getConditionalFormats?.() || [];
        for (const rule of allCondFormats) {
            if (rule.startRow >= startRow && rule.endRow <= endRow &&
                rule.startCol >= startCol && rule.endCol <= endCol) {
                conditionalFormats.push({
                    ...rule,
                    startRow: rule.startRow - startRow,
                    startCol: rule.startCol - startCol,
                    endRow:   rule.endRow   - startRow,
                    endCol:   rule.endCol   - startCol,
                });
            }
        }

        // Row heights and column widths
        for (let r = startRow; r <= endRow; r++) {
            rowHeights.push(sheetStore.getRowHeight?.(r) ?? null);
        }
        for (let c = startCol; c <= endCol; c++) {
            colWidths.push(sheetStore.getColWidth?.(c) ?? null);
        }

        return {
            cells, borders, merges, dataValidations, conditionalFormats,
            rowHeights, colWidths,
            rowCount: endRow - startRow + 1,
            colCount: endCol - startCol + 1,
        };
    }

    bordersEqual(a, b) {
        if (!a && !b) return true;
        if (!a || !b) return false;
        return a.style === b.style && a.width === b.width && a.color === b.color;
    }

    // ─── Generate TSV ─────────────────────────────────────────────────────────

    generateTSV(data) {
        return data.cells.map(row =>
            row.map(cell => {
                const val = cell.displayValue ?? cell.v ?? '';
                return String(val).replace(/\t/g, '\\t').replace(/\n/g, '\\n');
            }).join('\t')
        ).join('\n');
    }

    // ─── Generate HTML Table ──────────────────────────────────────────────────

    /**
     * @param {object} data
     * @param {string | null} [fingerprint] - Session fingerprint embedded as a <meta> tag
     *   for context menu paste fidelity validation.
     */
    generateHTMLTable(data, fingerprint = null) {
        // Build merge map: "relRow,relCol" → { rowspan, colspan, isPrimary }
        const mergeMap = {};
        for (const m of (data.merges || [])) {
            const rowspan = m.relEndRow - m.relStartRow + 1;
            const colspan = m.relEndCol - m.relStartCol + 1;
            mergeMap[`${m.relStartRow},${m.relStartCol}`] = { rowspan, colspan, isPrimary: true };
            for (let r = m.relStartRow; r <= m.relEndRow; r++) {
                for (let c = m.relStartCol; c <= m.relEndCol; c++) {
                    if (r !== m.relStartRow || c !== m.relStartCol) {
                        mergeMap[`${r},${c}`] = { isPrimary: false };
                    }
                }
            }
        }

        const borderMap = {};
        for (const border of (data.borders || [])) {
            borderMap[`${border.relRow},${border.relCol},${border.edge}`] = border;
        }

        // Fingerprint meta tag — used to validate in-memory clipboard on context menu paste
        const fingerprintMeta = fingerprint
            ? `<meta name="${FINGERPRINT_META}" content="${fingerprint}">`
            : '';

        let html = `<meta charset="utf-8">${fingerprintMeta}<table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">`;

        if (data.colWidths?.some(w => w != null)) {
            html += '<colgroup>';
            for (const w of data.colWidths) {
                html += w ? `<col width="${w}"/>` : '<col/>';
            }
            html += '</colgroup>';
        }

        for (let ri = 0; ri < data.cells.length; ri++) {
            const row = data.cells[ri];
            const rh  = data.rowHeights?.[ri];
            html += rh ? `<tr style="height:${rh}px;">` : '<tr>';

            for (let ci = 0; ci < row.length; ci++) {
                const mergeInfo = mergeMap[`${ri},${ci}`];
                if (mergeInfo && !mergeInfo.isPrimary) continue;

                const cell   = row[ci];
                const styles = ['overflow:hidden', 'padding:2px 3px 2px 3px'];

                for (const edge of ['top', 'right', 'bottom', 'left']) {
                    const b = borderMap[`${ri},${ci},${edge}`];
                    if (b) styles.push(`border-${edge}:${b.width}px ${b.style} ${b.color}`);
                }

                if (cell.fontFamily)       styles.push(`font-family:${cell.fontFamily}`);
                if (cell.fontSize)         styles.push(`font-size:${Math.round(cell.fontSize * 0.75)}pt`);
                if (cell.bold)             styles.push('font-weight:bold');
                if (cell.italic)           styles.push('font-style:italic');
                const textDecor = [];
                if (cell.underline)        textDecor.push('underline');
                if (cell.strikethrough)    textDecor.push('line-through');
                if (textDecor.length)      styles.push(`text-decoration:${textDecor.join(' ')}`);
                if (cell.color)            styles.push(`color:${cell.color}`);
                if (cell.backgroundColor) styles.push(`background-color:${cell.backgroundColor}`);
                if (cell.horizontalAlign)  styles.push(`text-align:${cell.horizontalAlign}`);
                if (cell.verticalAlign)    styles.push(`vertical-align:${cell.verticalAlign}`);
                if (cell.wrapText === false) styles.push('white-space:nowrap');

                const styleAttr  = ` style="${styles.join(';')}"`;
                let spanAttrs = '';
                if (mergeInfo?.isPrimary) {
                    if (mergeInfo.rowspan > 1) spanAttrs += ` rowspan="${mergeInfo.rowspan}"`;
                    if (mergeInfo.colspan > 1) spanAttrs += ` colspan="${mergeInfo.colspan}"`;
                }

                const content = this._cellContentHtml(cell);
                html += `<td${spanAttrs}${styleAttr}>${content}</td>`;
            }
            html += '</tr>';
        }

        html += '</table>';
        return html;
    }

    _cellContentHtml(cell) {
        const str = String(cell.v ?? cell.displayValue ?? '');
        if (cell.tfr && str) return this._serializeRichTextHtml(str, cell.tfr);
        const escaped = this.escapeHtml(str);
        return cell.url ? `<a href="${this.escapeHtml(cell.url)}">${escaped}</a>` : escaped;
    }

    _serializeRichTextHtml(plainText, tfr) {
        const runs = buildRenderRuns(plainText, tfr);
        return runs.map(run => {
            const parts   = run.t.split('\n');
            const encoded = parts.map((part, idx) => {
                const esc = this.escapeHtml(part);
                return idx < parts.length - 1 ? (esc ? `${esc}<br>` : '<br>') : esc;
            }).join('');

            const styles = [];
            if (run.f)           styles.push(`font-size:${Math.round(run.f * 0.75)}pt`);
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
            if (run.link) return `<a href="${this.escapeHtml(run.link)}"${styleAttr}>${encoded}</a>`;
            return styles.length ? `<span${styleAttr}>${encoded}</span>` : encoded;
        }).join('');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ─── Parse HTML Table ─────────────────────────────────────────────────────

    parseHTMLTable(html) {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(html, 'text/html');
        const table  = doc.querySelector('table');
        if (!table) return null;

        const isGoogleSheets = html.includes('google-sheets-html-origin') || html.includes('data-sheets-root');

        const colWidths = [];
        for (const col of table.querySelectorAll('colgroup col')) {
            const w = col.getAttribute('width');
            colWidths.push(w ? parseInt(w, 10) : null);
        }

        const tableRows = Array.from(table.querySelectorAll('tr'));
        const numRows   = tableRows.length;
        if (numRows === 0) return null;

        let numCols = colWidths.length;
        if (numCols === 0) {
            for (const tr of tableRows) {
                let count = 0;
                for (const td of tr.querySelectorAll('td, th')) {
                    count += parseInt(td.getAttribute('colspan') || '1', 10);
                }
                if (count > numCols) numCols = count;
            }
        }
        if (numCols === 0) return null;

        const grid          = Array.from({ length: numRows }, () => Array(numCols).fill(null));
        const spanOccupied  = Array.from({ length: numRows }, () => Array(numCols).fill(false));
        const rowHeights    = [];
        const collectedBorders = [];
        const merges        = [];

        for (let ri = 0; ri < numRows; ri++) {
            const tr      = tableRows[ri];
            const trStyle = tr.getAttribute('style') || '';
            const hMatch  = trStyle.match(/height:\s*(\d+)px/);
            rowHeights.push(hMatch ? parseInt(hMatch[1], 10) : null);

            const tds   = Array.from(tr.querySelectorAll('td, th'));
            let tdIdx   = 0;
            let ci      = 0;

            while (tdIdx < tds.length && ci < numCols) {
                while (ci < numCols && spanOccupied[ri][ci]) ci++;
                if (ci >= numCols) break;

                const td      = tds[tdIdx++];
                const rowspan = Math.max(1, parseInt(td.getAttribute('rowspan') || '1', 10));
                const colspan = Math.max(1, parseInt(td.getAttribute('colspan') || '1', 10));

                if (rowspan > 1 || colspan > 1) {
                    merges.push({
                        relStartRow: ri,             relStartCol: ci,
                        relEndRow:   ri + rowspan - 1, relEndCol: ci + colspan - 1,
                    });
                }

                for (let dr = 0; dr < rowspan; dr++) {
                    for (let dc = 0; dc < colspan; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const sr = ri + dr, sc = ci + dc;
                        if (sr < numRows && sc < numCols) spanOccupied[sr][sc] = true;
                    }
                }

                const tdStyle  = td.getAttribute('style') || '';
                const cellData = this.parseHTMLCell(td, tdStyle, isGoogleSheets);

                const cellBorders = this.parseCellBorderCSS(tdStyle);
                for (const [edge, borderStyle] of Object.entries(cellBorders)) {
                    collectedBorders.push({ relRow: ri, relCol: ci, edge, ...borderStyle });
                }

                grid[ri][ci] = cellData;
                ci += colspan;
            }
        }

        const borders    = this.deduplicateBorders(collectedBorders);
        const emptyCell  = () => ({ v: null, displayValue: null, isFormula: false });
        const cells      = grid.map(row => row.map(cell => cell ?? emptyCell()));

        // Trim trailing empty rows
        while (cells.length > 0 && cells[cells.length - 1].every(c => c.v === null)) {
            cells.pop();
        }
        if (cells.length === 0) return null;

        return {
            cells, borders, merges,
            rowCount: cells.length, colCount: numCols,
            colWidths: colWidths.length ? colWidths : null,
            rowHeights,
        };
    }

    parseHTMLCell(td, tdStyle, isGoogleSheets) {
        const styleProps = this.parseHTMLStyleProps(tdStyle);

        // Try rich-text parse: multiple spans with varying styles → tfr
        const richResult = this._parseInnerSpansToTfr(td);
        if (richResult) {
            return {
                v:            richResult.plainText,
                displayValue: richResult.plainText || null,
                isFormula:    false,
                ...styleProps,
                tfr: richResult.tfr,
            };
        }

        // Plain cell: extract text + optional whole-cell anchor link
        const anchor  = td.querySelector('a');
        let url       = null;
        let rawText   = td.textContent?.trim() ?? '';
        if (anchor) {
            url     = anchor.getAttribute('href') || null;
            rawText = anchor.textContent?.trim() || rawText;
        }

        // Infer font-size from inner spans when absent from td style
        if (!styleProps.fontSize) {
            for (const span of td.querySelectorAll('span[style]')) {
                const sp = this.parseHTMLStyleProps(span.getAttribute('style') || '');
                if (sp.fontSize) { styleProps.fontSize = sp.fontSize; break; }
            }
        }

        const { v } = this.inferValueFromText(rawText, tdStyle);
        const cell  = {
            v,
            displayValue: rawText || null,
            isFormula: false,
            // Explicit false booleans prevent destination style "leak-through" on paste.
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            ...styleProps,
        };
        if (url) cell.url = url;
        return cell;
    }

    /**
     * Walk the inner DOM of a <td> to collect text runs with accumulated inline styles.
     * Returns { plainText, tfr } when multiple distinct run styles are found (rich text),
     * or null when the cell is plain / uniformly styled (cell-level props suffice).
     */
    _parseInnerSpansToTfr(td) {
        const flatRuns = [];

        function walk(node, style) {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent;
                if (!text) return;
                const last = flatRuns[flatRuns.length - 1];
                if (last && last._key === style._key) {
                    last.text += text;
                } else {
                    flatRuns.push({ text, ...style });
                }
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            const tag = node.tagName.toLowerCase();
            if (tag === 'br') {
                if (flatRuns.length > 0) flatRuns[flatRuns.length - 1].text += '\n';
                else flatRuns.push({ text: '\n', _key: '{}' });
                return;
            }

            // Accumulate style from this element
            const s    = { ...style };
            const cs   = node.style;
            if (cs) {
                const weight = cs.fontWeight?.toLowerCase?.() || '';
                const weightNum = parseInt(weight, 10);
                if (weight === 'bold' || weight === 'bolder' || (!isNaN(weightNum) && weightNum >= 600)) s.bold = true;
                else if (weight === 'normal' || (!isNaN(weightNum) && weightNum < 600)) delete s.bold;
                if (cs.fontStyle  === 'italic')       s.italic = true;
                else if (cs.fontStyle === 'normal')   delete s.italic;
                const textDecoration = `${cs.textDecoration || ''} ${cs.textDecorationLine || ''}`.toLowerCase();
                if (textDecoration) {
                    if (textDecoration.includes('underline'))    s.underline = true;
                    if (textDecoration.includes('line-through')) s.strikethrough = true;
                }
                if (cs.color)      s.foregroundColor = cs.color;
                if (cs.fontSize) {
                    const m = cs.fontSize.match(/^(\d+(?:\.\d+)?)(pt|px|em|rem)$/);
                    if (m) {
                        const v = parseFloat(m[1]);
                        s.fontSize = m[2] === 'pt' ? Math.round(v * 4 / 3)
                                   : m[2] === 'px' ? Math.round(v)
                                   : Math.round(v * 16);
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

            // Recompute cache key after accumulating styles for this element
            const { _key: _old, text: _t, ...fmt } = s;
            s._key = JSON.stringify(fmt);

            for (const child of node.childNodes) walk(child, s);
        }

        // Walk children of td with empty initial style
        for (const child of td.childNodes) walk(child, { _key: '{}' });

        if (flatRuns.length === 0) return null;

        // No formatting at all → let cell-level props handle it
        const hasFormatting = flatRuns.some(r => r._key !== '{}');
        if (!hasFormatting) return null;

        // All runs identical → uniform style, no run-level variation needed
        const firstKey = flatRuns[0]._key;
        if (flatRuns.every(r => r._key === firstKey)) return null;

        const plainText = flatRuns.map(r => r.text).join('');
        if (!plainText) return null;

        // Build tfr from flat runs
        let offset  = 0;
        const tfrRuns = [];
        let prevKey = '';
        for (const run of flatRuns) {
            const { text, _key, ...rawStyle } = run;
            const fmt = {};
            if (rawStyle.bold !== undefined)        fmt.bold            = rawStyle.bold;
            if (rawStyle.italic !== undefined)      fmt.italic          = rawStyle.italic;
            if (rawStyle.underline)                 fmt.underline       = true;
            if (rawStyle.strikethrough)             fmt.strikethrough   = true;
            if (rawStyle.foregroundColor)           fmt.foregroundColor = rawStyle.foregroundColor;
            if (rawStyle.fontSize)                  fmt.fontSize        = rawStyle.fontSize;
            if (rawStyle.fontFamily)                fmt.fontFamily      = rawStyle.fontFamily;
            if (rawStyle.link)                      fmt.link            = rawStyle.link;
            const key = JSON.stringify(fmt);
            if (key !== prevKey) {
                tfrRuns.push({ startIndex: offset, format: fmt });
                prevKey = key;
            }
            offset += text.length;
        }

        const tfr = normalizeTfr(tfrRuns, plainText.length);
        if (!tfr) return null;

        return { plainText, tfr };
    }

    parseHTMLStyleProps(style) {
        const props = {};
        if (!style) return props;

        const ffMatch = style.match(/font-family:\s*([^;]+)/);
        if (ffMatch) props.fontFamily = ffMatch[1].trim().replace(/^['"]|['"]$/g, '');

        const fsMatch = style.match(/font-size:\s*(\d+(?:\.\d+)?)(pt|px|em|rem)/);
        if (fsMatch) {
            const val = parseFloat(fsMatch[1]);
            switch (fsMatch[2]) {
                case 'pt':  props.fontSize = Math.round(val * 4 / 3); break;
                case 'px':  props.fontSize = Math.round(val);         break;
                case 'em':
                case 'rem': props.fontSize = Math.round(val * 16);    break;
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
            if (dec.includes('none')) {
                props.underline = false;
                props.strikethrough = false;
            }
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

    parseCellBorderCSS(style) {
        const borders = {};
        if (!style) return borders;
        const shorthand = style.match(/(?:^|;)\s*border:\s*([^;]+)/i);
        if (shorthand) {
            const parsed = this.parseBorderValue(shorthand[1].trim());
            if (parsed) {
                borders.top = parsed;
                borders.right = parsed;
                borders.bottom = parsed;
                borders.left = parsed;
            }
        }
        for (const edge of ['top', 'right', 'bottom', 'left']) {
            const match = style.match(new RegExp(`(?:^|;)\\s*border-${edge}:\\s*([^;]+)`, 'i'));
            if (match) {
                const parsed = this.parseBorderValue(match[1].trim());
                if (parsed) borders[edge] = parsed;
            }
        }
        return borders;
    }

    parseBorderValue(value) {
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

        return { width, style: styleMatch[1], color };
    }

    inferValueFromText(text, style = '') {
        if (!text || text === '') return { v: null };
        if (text === 'TRUE')  return { v: true };
        if (text === 'FALSE') return { v: false };
        const numericPattern = /^[+-]?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?$/;
        if (numericPattern.test(text)) {
            const n = parseFloat(text.replace(/,/g, ''));
            if (!isNaN(n)) return { v: n };
        }
        return { v: text };
    }

    deduplicateBorders(borders) {
        const seen = new Map();
        for (const b of borders) {
            const key = `${b.relRow},${b.relCol},${b.edge}`;
            if (!seen.has(key)) seen.set(key, b);
        }
        return Array.from(seen.values());
    }

    // ─── Google Sheets Compact JSON ───────────────────────────────────────────

    /**
     * Decode RLE-encoded array.
     * Negative N means "repeat next value |N| times", positive values are literals.
     */
    decodeRLE(arr) {
        const result = [];
        let i = 0;
        while (i < arr.length) {
            if (arr[i] < 0) {
                const count = Math.abs(arr[i]);
                const val   = arr[i + 1];
                for (let j = 0; j < count; j++) result.push(val);
                i += 2;
            } else {
                result.push(arr[i]);
                i++;
            }
        }
        return result;
    }

    /**
     * Convert packed RGB integer to hex color string.
     * Google Sheets packs as: blue = bits 0–7, green = bits 8–15, red = bits 16–23
     */
    packedRGBToHex(packed) {
        const b = packed & 0xFF;
        const g = (packed >> 8)  & 0xFF;
        const r = (packed >> 16) & 0xFF;
        return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    }

    /**
     * Convert R1C1 formula notation to A1 notation.
     */
    r1c1ToA1(formula, baseRow, baseCol) {
        if (!formula) return formula;
        let expr = formula.startsWith('=') ? formula.slice(1) : formula;

        expr = expr.replace(/R(\[(-?\d+)\]|(\d+))?C(\[(-?\d+)\]|(\d+))?/g,
            (match, _rPart, rRel, rAbs, _cPart, cRel, cAbs) => {
                let row, col;
                let rowAbsolute = false, colAbsolute = false;

                if (rRel !== undefined)      { row = baseRow + parseInt(rRel, 10); }
                else if (rAbs !== undefined) { row = parseInt(rAbs, 10) - 1; rowAbsolute = true; }
                else                         { row = baseRow; }

                if (cRel !== undefined)      { col = baseCol + parseInt(cRel, 10); }
                else if (cAbs !== undefined) { col = parseInt(cAbs, 10) - 1; colAbsolute = true; }
                else                         { col = baseCol; }

                if (row < 0 || col < 0) return '#REF!';

                const colStr = this.numToCol(col);
                const rowStr = String(row + 1);
                return `${colAbsolute ? '$' : ''}${colStr}${rowAbsolute ? '$' : ''}${rowStr}`;
            }
        );

        return '=' + expr;
    }

    /**
     * Parse Google Sheets compact JSON format.
     * Optionally merges with parsed HTML data for richer formatting.
     */
    parseGoogleSheetsCompactJSON(jsonStr, htmlData = null) {
        let compact;
        try { compact = JSON.parse(jsonStr); }
        catch (e) { console.warn('Failed to parse Google Sheets compact JSON:', e); return null; }

        const dims   = compact['15'] || {};
        const numRows = dims['1'] || 0;
        const numCols = dims['2'] || 0;
        if (numRows === 0 || numCols === 0) return null;

        const cellStream  = this.decodeRLE(compact['2'] || []);
        const pools       = compact['3'] || {};
        const typeSeq     = pools['1'] || [];
        const numPool     = pools['3'] || [];
        const strPool     = pools['4'] || [];
        const specialPool = pools['5'] || [];

        const formatDescs  = compact['4'] || [];
        const formatStream = this.decodeRLE(compact['5'] || []);

        const formulaPool     = compact['8'] || [];
        const formulaStreamRaw = compact['9'] || [];

        const hyperlinkPool = compact['16'] || [];
        const validationRules = compact['10'] || [];

        const grid   = Array.from({ length: numRows }, () => Array(numCols).fill(null));
        const merges = [];

        let numIdx = 0, strIdx = 0, specialIdx = 0, typeIdx = 0, hyperlinkIdx = 0;
        const mergePrimaries = [];

        for (let pos = 0; pos < cellStream.length && pos < numRows * numCols; pos++) {
            const code = cellStream[pos];
            const row  = Math.floor(pos / numCols);
            const col  = pos % numCols;

            if (code === 194) {
                grid[row][col] = { v: null, displayValue: null, isFormula: false };
                continue;
            }
            if (code === 0) {
                grid[row][col] = { v: null, displayValue: null, isFormula: false, _mergeSecondary: true };
                continue;
            }

            let v = null, displayValue = null, isFormula = false;

            if (code !== 210) {
                if (typeIdx < typeSeq.length) {
                    const vType = typeSeq[typeIdx++];
                    if (vType === 1 && numIdx < numPool.length) {
                        v = numPool[numIdx++]; displayValue = v;
                    } else if (vType === 2 && strIdx < strPool.length) {
                        v = strPool[strIdx++]; displayValue = v;
                    } else if (vType === 3 && specialIdx < specialPool.length) {
                        const spec = specialPool[specialIdx++];
                        v = spec?.['4'] === 1 ? true : false;
                        displayValue = v ? 'TRUE' : 'FALSE';
                    }
                }
            }

            if (code === 210 || code === 211) isFormula = true;
            if (code === 1219) mergePrimaries.push({ row, col });

            const cellData = {
                v,
                displayValue,
                isFormula,
                bold: false,
                italic: false,
                underline: false,
                strikethrough: false,
            };
            if (code === 2755 && hyperlinkIdx < hyperlinkPool.length) {
                cellData.url = hyperlinkPool[hyperlinkIdx++];
            }
            grid[row][col] = cellData;
        }

        // Detect merge extents
        for (const mp of mergePrimaries) {
            let endRow = mp.row, endCol = mp.col;
            for (let c = mp.col + 1; c < numCols; c++) {
                if (grid[mp.row]?.[c]?._mergeSecondary) endCol = c; else break;
            }
            for (let r = mp.row + 1; r < numRows; r++) {
                if (grid[r]?.[mp.col]?._mergeSecondary) endRow = r; else break;
            }
            if (endRow > mp.row || endCol > mp.col) {
                merges.push({ relStartRow: mp.row, relStartCol: mp.col, relEndRow: endRow, relEndCol: endCol });
            }
        }

        // Assign formulas
        const nonEmptyCells = [];
        for (let pos = 0; pos < cellStream.length && pos < numRows * numCols; pos++) {
            const code = cellStream[pos];
            if (code !== 194 && code !== 0) {
                nonEmptyCells.push({ row: Math.floor(pos / numCols), col: pos % numCols });
            }
        }

        if (formulaStreamRaw.length > 0 && formulaPool.length > 0) {
            // Formula stream uses the same compact RLE shape as other streams in this payload.
            // Decode first, then map 1:1 over non-empty cells.
            const formulaStream = this.decodeRLE(formulaStreamRaw);
            const limit = Math.min(formulaStream.length, nonEmptyCells.length);
            for (let i = 0; i < limit; i++) {
                const poolIdx = formulaStream[i];
                if (poolIdx == null || poolIdx < 0 || poolIdx >= formulaPool.length) continue;
                const { row, col } = nonEmptyCells[i];
                const cell = grid[row]?.[col];
                if (!cell) continue;
                cell.formula = this.r1c1ToA1(formulaPool[poolIdx], row, col);
                cell.isFormula = true;
            }
        }

        // Apply format descriptors
        for (let pos = 0; pos < formatStream.length && pos < numRows * numCols; pos++) {
            const fmtIdx = formatStream[pos];
            if (fmtIdx == null || fmtIdx < 0 || fmtIdx >= formatDescs.length) continue;

            const row  = Math.floor(pos / numCols);
            const col  = pos % numCols;
            const cell = grid[row]?.[col];
            const fmt  = formatDescs[fmtIdx];
            if (!cell || !fmt) continue;

            if (fmt['3'])  cell.numberFormat    = fmt['3']['2'] || null;
            if (fmt['4'])  cell.backgroundColor = this.packedRGBToHex(fmt['4']['2'] || 0);
            if (fmt['9']  != null) cell.horizontalAlign = fmt['9'] === 1 ? 'center' : fmt['9'] === 2 ? 'right' : null;
            if (fmt['10'] != null) cell.verticalAlign   = fmt['10'] === 0 ? 'top' : fmt['10'] === 1 ? 'middle' : 'bottom';
            if (fmt['14']) cell.color      = this.packedRGBToHex(fmt['14']['2'] || 0);
            if (fmt['15']) cell.fontFamily = fmt['15'];
            if (fmt['16']) cell.fontSize   = Math.round(fmt['16'] * 4 / 3);
            if (fmt['21']) cell.wrapText   = true;

            const bits = fmt['2'] || 0;
            if (bits & 0x20) cell.bold          = true;
            if (bits & 0x40) cell.italic        = true;
            if (bits & 0x04) cell.underline     = true;
            if (bits & 0x08) cell.strikethrough = true;
        }

        // When Google provides HTML, treat HTML cell content/styles as authoritative.
        // Compact JSON is still used for data validations and fallback metadata.
        let outputCells = grid;
        if (htmlData?.cells?.length) {
            const htmlRows = htmlData.cells.length;
            const htmlCols = htmlData.cells[0]?.length || 0;
            outputCells = Array.from({ length: htmlRows }, (_, r) =>
                Array.from({ length: htmlCols }, (_, c) => {
                    const htmlCell = htmlData.cells[r]?.[c] || { v: null, displayValue: null, isFormula: false };
                    const compactCell = grid[r]?.[c] || null;
                    const out = { ...htmlCell };
                    if (!out.url && compactCell?.url) out.url = compactCell.url;
                    // Keep formula fidelity from compact JSON while preserving HTML styling.
                    if (compactCell?.formula) {
                        out.formula = compactCell.formula;
                        out.isFormula = true;
                    } else if (!out.formula && typeof out.v === 'string' && out.v.startsWith('=')) {
                        // Fallback: if HTML text itself is a formula-like token, preserve it as a formula.
                        out.formula = out.v;
                        out.isFormula = true;
                    }
                    return out;
                })
            );
        }

        // Parse data validations
        const parsedValidations = [];
        for (const rule of validationRules) {
            const dv = this.parseGSheetsValidation(rule);
            if (dv) parsedValidations.push(dv);
        }

        // Clean up internal flags
        for (let r = 0; r < numRows; r++) {
            for (let c = 0; c < numCols; c++) {
                if (grid[r][c]) delete grid[r][c]._mergeSecondary;
            }
        }

        return {
            cells: outputCells,
            borders: htmlData?.borders || [],
            merges: htmlData?.merges || merges,
            dataValidations: parsedValidations,
            rowCount: htmlData?.rowCount || numRows,
            colCount: htmlData?.colCount || numCols,
            colWidths: htmlData?.colWidths || null,
            rowHeights: htmlData?.rowHeights || null,
        };
    }

    parseGSheetsValidation(rule) {
        if (!rule) return null;
        const inner   = rule['1'];
        if (!inner) return null;
        const condDef = inner['1'];
        if (!condDef) return null;
        const type  = condDef['1'];
        const items = condDef['2'];

        if (type === 24 && Array.isArray(items)) {
            const options = items
                .map(item => item?.['5']?.['2']?.['2'] || item?.['5']?.['1']?.['2'] || null)
                .filter(Boolean);
            if (options.length > 0) {
                return { type: 'dropdown', options, strict: inner['6'] === 1, message: inner['2'] || '' };
            }
        }
        if (type === 31) return { type: 'checkbox' };
        return null;
    }

    // ─── Paste from Native Event (keyboard Ctrl+V) ────────────────────────────

    /**
     * Called from Grid's svelte:window onpaste handler.
     *
     * Receives the full DataTransfer from the native paste event, which gives
     * access to ALL MIME types including our custom type and Google Sheets'
     * compact JSON format.
     *
     * Priority order:
     *   1. SCRIPTORIUM_MIME          — our custom type, set via native copy event (Firefox/Safari)
     *   2. SCRIPTORIUM_MIME_WEB      — Chrome 104+ async clipboard path (strips 'web ' prefix)
     *   3. In-memory clipboard    — fingerprint-validated for full in-app fidelity
     *   4. Google compact JSON    — merged with HTML for formatting
     *   5. HTML table             — from other spreadsheet apps or rich text
     *   6. Plain text (TSV)       — universal fallback
     *
     * @param {DataTransfer} clipboardData
     * @param {import('./SheetStore.svelte.js').SheetStore} sheetStore
     * @param {import('./SpreadsheetSession.svelte.js').SpreadsheetSession} session
     * @param {import('yjs').Doc} ydoc
     * @param {'full'|'values'|'formulas'|'formatting'|'valuesFormat'|'formulasFormat'} [mode]
     */
    pasteFromEvent(clipboardData, sheetStore, session, ydoc, mode = 'full') {
        const anchor = getSelectionState()?.anchor;
        const range  = getSelectionState()?.range ?? (anchor ? { startRow: anchor.row, endRow: anchor.row, startCol: anchor.col, endCol: anchor.col } : null);
        if (!range || !sheetStore) return;

        const scriptoriumJson     = clipboardData.getData(SCRIPTORIUM_MIME);
        const scriptoriumJsonWeb  = clipboardData.getData(SCRIPTORIUM_MIME_WEB);
        const googleCompactJson = clipboardData.getData(GOOGLE_COMPACT_MIME);
        const htmlText         = clipboardData.getData('text/html');
        const plainText        = clipboardData.getData('text/plain');

        let data       = null;
        let isInternal = false;

        // 1. Our native-event custom MIME (Firefox, Safari, and our own oncopy handler)
        if (scriptoriumJson) {
            data = this.#parseInternalJSON(scriptoriumJson);
            if (data) isInternal = true;
        }

        // 2. Web-prefixed custom MIME (Chrome 104+ async write → native paste event)
        if (!data && scriptoriumJsonWeb) {
            data = this.#parseInternalJSON(scriptoriumJsonWeb);
            if (data) isInternal = true;
        }

        // 3. In-memory clipboard validated by fingerprint in HTML
        if (!data && this.clipboardData && htmlText) {
            const fp = this.clipboardData.fingerprint;
            if (fp && htmlText.includes(`content="${fp}"`)) {
                // Use the full in-memory clipboard object so multi-range paste works.
                // Attach multiRange/ranges from the parent clipboard onto the data object.
                data = { ...this.clipboardData.data };
                if (this.clipboardData.ranges?.length > 1) {
                    data.multiRange = true;
                    data.ranges = this.clipboardData.ranges;
                }
                isInternal = true;
            }
        }

        // 4. Google Sheets compact JSON (merged with HTML for border/formatting data)
        if (!data && googleCompactJson) {
            const htmlData = htmlText ? this.parseHTMLTable(htmlText) : null;
            data = this.parseGoogleSheetsCompactJSON(googleCompactJson, htmlData);
        }

        // 5. HTML table
        if (!data && htmlText) {
            data = this.parseHTMLTable(htmlText);
        }

        // 6. Plain text TSV
        if (!data && plainText) {
            data = this.parseTSV(plainText);
        }

        if (!data) {
            console.warn('[ClipboardManager] pasteFromEvent: no parseable clipboard content');
            return;
        }

        ydoc?.transact(() => {
            if (data.multiRange && data.ranges?.length > 1) {
                this.#applyMultiRangePaste(sheetStore, session, data.ranges, range, mode, isInternal);
            } else {
                this.applyPaste(sheetStore, session, data, range, mode, isInternal);
            }
        });

        // Cut source was already cleared in cut(); nothing to do here.
        if (isInternal && this.clipboardType === 'cut') {
            this.clipboardData  = null;
            this.clipboardType  = null;
        }
    }

    // ─── Paste (context menu) ─────────────────────────────────────────────────

    /**
     * Context menu paste — no access to DataTransfer.
     *
     * Tries to validate the in-memory clipboard against the system clipboard
     * by looking for the session fingerprint. Falls back to reading system
     * clipboard formats via the async Clipboard API.
     *
     * @param {import('./SheetStore.svelte.js').SheetStore} sheetStore
     * @param {import('./SpreadsheetSession.svelte.js').SpreadsheetSession} session
     * @param {import('yjs').Doc} ydoc
     * @param {'full'|'values'|'formulas'|'formatting'|'valuesFormat'|'formulasFormat'} [mode]
     */
    async paste(sheetStore, session, ydoc, mode = 'full') {
        const anchor = getSelectionState()?.anchor;
        const range  = getSelectionState()?.range ?? (anchor ? { startRow: anchor.row, endRow: anchor.row, startCol: anchor.col, endCol: anchor.col } : null);
        if (!range || !sheetStore) return;

        // Try to route menu/context paste through native onpaste first so it can
        // use the same clipboard MIME payloads as Ctrl+V when browser allows it.
        this._pendingPasteMode = mode;
        try {
            if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
                const dispatched = document.execCommand('paste');
                if (dispatched) return;
            }
        } catch (_) {
            // Programmatic paste blocked; continue with async clipboard fallback.
        }

        let data       = null;
        let isInternal = false;

        // Try in-memory clipboard with fingerprint validation first
        if (this.clipboardData?.fingerprint) {
            const valid = await this.#validateInMemoryClipboard();
            if (valid) {
                data = { ...this.clipboardData.data };
                if (this.clipboardData.ranges?.length > 1) {
                    data.multiRange = true;
                    data.ranges = this.clipboardData.ranges;
                }
                isInternal = true;
            }
        }

        // Fall back to reading system clipboard
        if (!data) {
            const result = await this.#readSystemClipboard();
            if (result) {
                data       = result.data;
                isInternal = result.isInternal;
            }
        }

        if (!data) {
            console.warn('[ClipboardManager] paste: no clipboard content available');
            return;
        }

        ydoc?.transact(() => {
            if (data.multiRange && data.ranges?.length > 1) {
                this.#applyMultiRangePaste(sheetStore, session, data.ranges, range, mode, isInternal);
            } else {
                this.applyPaste(sheetStore, session, data, range, mode, isInternal);
            }
        });

        if (isInternal && this.clipboardType === 'cut') {
            this.clipboardData = null;
            this.clipboardType = null;
        }
    }

    /**
     * Paste multiple ranges relative to the paste target's top-left corner.
     * Each source range is offset by (target.startRow - firstSrc.startRow, ...).
     */
    #applyMultiRangePaste(sheetStore, session, rangeDataList, targetRange, mode, isInternal) {
        const firstSrc = rangeDataList[0].range;
        const offsetRow = targetRange.startRow - firstSrc.startRow;
        const offsetCol = targetRange.startCol - firstSrc.startCol;
        for (const { range: srcRange, data } of rangeDataList) {
            const destRange = {
                startRow: srcRange.startRow + offsetRow,
                endRow:   srcRange.endRow   + offsetRow,
                startCol: srcRange.startCol + offsetCol,
                endCol:   srcRange.endCol   + offsetCol,
            };
            this.applyPaste(sheetStore, session, data, destRange, mode, isInternal);
        }
    }

    /**
     * Validate the in-memory clipboard by comparing its fingerprint against what
     * is currently in the system clipboard.
     *
     * Returns true if the in-memory clipboard is still current (fingerprint matches).
     * Returns true also when the system clipboard is unreadable — in that case we
     * assume the user copied within the same tab and the in-memory data is valid.
     */
    async #validateInMemoryClipboard() {
        if (!this.clipboardData?.fingerprint) return false;
        const fp = this.clipboardData.fingerprint;

        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                // Chrome 104+: custom type
                if (item.types.includes(SCRIPTORIUM_MIME_WEB)) {
                    try {
                        const blob = await item.getType(SCRIPTORIUM_MIME_WEB);
                        const json = JSON.parse(await blob.text());
                        if (json.fingerprint === fp) return true;
                    } catch (_) { /* ignore */ }
                }
                // HTML fingerprint meta tag
                if (item.types.includes('text/html')) {
                    try {
                        const blob = await item.getType('text/html');
                        const html = await blob.text();
                        if (html.includes(`content="${fp}"`)) return true;
                    } catch (_) { /* ignore */ }
                }
            }
            // System clipboard was read successfully but fingerprint not found —
            // another application must have overwritten it.
            return false;
        } catch (_) {
            // Permission denied or clipboard unreadable — assume in-memory is valid.
            // This is the common case when the same tab just copied.
            return true;
        }
    }

    /**
     * Read all available formats from the system clipboard via the async Clipboard API.
     */
    async #readSystemClipboard() {
        try {
            const items = await navigator.clipboard.read();

            // Collect HTML and Google compact JSON in one pass
            let htmlText    = null;
            let htmlData    = null;
            let googleJson  = null;

            for (const item of items) {
                // Our custom type (Chrome 104+ web- prefix; 'web ' is stripped on read)
                if (item.types.includes(SCRIPTORIUM_MIME_WEB)) {
                    try {
                        const blob   = await item.getType(SCRIPTORIUM_MIME_WEB);
                        const parsed = this.#parseInternalJSON(await blob.text());
                        if (parsed) return { data: parsed, isInternal: true };
                    } catch (_) { /* ignore */ }
                }

                if (!htmlText && item.types.includes('text/html')) {
                    try {
                        const blob = await item.getType('text/html');
                        htmlText = await blob.text();
                        htmlData = this.parseHTMLTable(htmlText);
                    } catch (_) { /* ignore */ }
                }

                if (!googleJson && item.types.includes(GOOGLE_COMPACT_MIME)) {
                    try {
                        const blob = await item.getType(GOOGLE_COMPACT_MIME);
                        googleJson = await blob.text();
                    } catch (_) { /* ignore */ }
                }
            }

            if (googleJson) {
                const parsed = this.parseGoogleSheetsCompactJSON(googleJson, htmlData);
                if (parsed) return { data: parsed, isInternal: false };
            }

            if (htmlData) return { data: htmlData, isInternal: false };

            for (const item of items) {
                if (item.types.includes('text/plain')) {
                    try {
                        const blob   = await item.getType('text/plain');
                        const parsed = this.parseTSV(await blob.text());
                        if (parsed) return { data: parsed, isInternal: false };
                    } catch (_) { /* ignore */ }
                }
            }
        } catch (_) {
            // Fall back to readText() if read() is unavailable
            try {
                const text   = await navigator.clipboard.readText();
                const parsed = this.parseTSV(text);
                if (parsed) return { data: parsed, isInternal: false };
            } catch (_2) { /* give up */ }
        }

        return null;
    }

    // ─── Parse TSV ────────────────────────────────────────────────────────────

    parseTSV(text) {
        if (!text) return null;
        const rows  = text.split('\n');
        const cells = rows.map(row =>
            row.split('\t').map(cell => ({
                v:            cell || null,
                displayValue: cell || null,
                isFormula:    !!(cell && cell.startsWith('=')),
            }))
        );
        return cells.length > 0
            ? { cells, borders: [], merges: [], rowCount: cells.length, colCount: cells[0]?.length || 0 }
            : null;
    }

    // ─── Apply Paste ──────────────────────────────────────────────────────────

    applyPaste(sheetStore, session, data, targetRange, mode, isInternal) {
        const { cells, borders, merges, dataValidations, conditionalFormats } = data;
        const srcRowCount = data.rowCount || cells.length;
        const srcColCount = data.colCount || cells[0]?.length || 0;

        const destStartRow  = targetRange.startRow;
        const destStartCol  = targetRange.startCol;

        // ── Table paste path ──────────────────────────────────────────────────
        // Entry row → insert clipboard rows as new table rows.
        // Data row  → overwrite cells in place (append overflow rows at bottom).
        const tableManager = session?.renderContext?.tableManager;
        if (tableManager) {
            const info = tableManager.getCellInfo(destStartRow, destStartCol);
            if (info?.table) {
                const rows2D = cells.map(/** @param {any[]} row */ row =>
                    row.map(/** @param {any} cell */ cell => String(cell?.displayValue ?? cell?.v ?? ''))
                );
                const absColOffset = Math.max(0, destStartCol - info.table.startCol);
                if (info.rowType === 'entry') {
                    // pasteRows maps into entryCols[], so count only non-formula
                    // columns before the clicked position as the start offset.
                    const entryColOffset = info.table.columns
                        .slice(0, absColOffset)
                        .filter(/** @param {any} c */ c => !c.isNonEntry).length;
                    info.table.pasteRows(rows2D, entryColOffset);
                } else if (info.rowType === 'data') {
                    // updateRows uses this.columns[] (all cols) internally,
                    // so the absolute offset is correct.
                    info.table.updateRows(rows2D, info.dataIndex, absColOffset);
                }
                return;
            }
        }

        const isSingleCell  = srcRowCount === 1 && srcColCount === 1;
        const destEndRow    = isSingleCell ? targetRange.endRow : destStartRow + srcRowCount - 1;
        const destEndCol    = isSingleCell ? targetRange.endCol : destStartCol + srcColCount - 1;

        const pastePlan = this.getPasteModePlan(mode, isInternal);
        const includesValues = pastePlan.includesValues;
        const includesFormulas = pastePlan.includesFormulas;
        const includesFormatting = pastePlan.includesFormatting;

        for (let r = destStartRow; r <= destEndRow; r++) {
            for (let c = destStartCol; c <= destEndCol; c++) {
                const srcRow = isSingleCell ? 0 : (r - destStartRow) % srcRowCount;
                const srcCol = isSingleCell ? 0 : (c - destStartCol) % srcColCount;
                const cell   = cells[srcRow]?.[srcCol];
                if (!cell) continue;

                // Formula adjustment offset = dest position minus the source cell's
                // absolute sheet position.
                // Internal paste: source cell was at (clipboardOriginRow + srcRow, ...).
                //   rowOffset = r - (clipboardOriginRow + srcRow)
                //   This gives the true delta from source to dest, e.g. copying from row 1
                //   to row 5 → offset 4 for every cell regardless of srcRow.
                // External paste (Google Sheets, HTML): formulas are already expressed
                //   relative to the 0-based clipboard position (row srcRow, col srcCol).
                //   rowOffset = r - srcRow maps clipboard-relative refs to dest sheet coords.
                const rowOffset = isInternal
                    ? r - ((this.clipboardData?.range?.startRow ?? destStartRow) + srcRow)
                    : r - srcRow;
                const colOffset = isInternal
                    ? c - ((this.clipboardData?.range?.startCol ?? destStartCol) + srcCol)
                    : c - srcCol;

                // Keep special-paste modes explicit so behavior is deterministic.
                if (pastePlan.formulasOnly) {
                    this.applyFormulaOnly(sheetStore, cell, r, c, rowOffset, colOffset, isInternal);
                } else if (includesFormulas && (cell.isFormula || cell.formula)) {
                    this.applyValue(sheetStore, cell, r, c, rowOffset, colOffset, isInternal);
                } else if (includesValues) {
                    this.applyValueOnly(sheetStore, cell, r, c);
                }

                if (includesFormatting) {
                    this.applyFormatting(sheetStore, cell, r, c);
                }
            }
        }

        // External clipboard border payloads (especially Google HTML) can be sparse and
        // cause inconsistent "random" border artifacts in formatting-only modes.
        // Keep border pasting for:
        // - internal clipboard payloads, and
        // - full external paste
        if (includesFormatting && pastePlan.includesBorders && borders?.length > 0) {
            this.applyBorders(sheetStore, borders, destStartRow, destStartCol, destEndRow, destEndCol, pastePlan.clearExistingBorders);
        }

        if (mode === 'full' && !isSingleCell && merges?.length > 0) {
            for (const m of merges) {
                const absStartRow = destStartRow + m.relStartRow;
                const absStartCol = destStartCol + m.relStartCol;
                const absEndRow   = destStartRow + m.relEndRow;
                const absEndCol   = destStartCol + m.relEndCol;
                sheetStore.mergeCells?.(absStartRow, absStartCol, absEndRow, absEndCol);
            }
        }

        if (mode === 'full' && dataValidations?.length > 0) {
            for (const rule of dataValidations) {
                sheetStore.addDataValidation?.({
                    ...rule,
                    id:       crypto.randomUUID?.() || Math.random().toString(36).slice(2),
                    startRow: destStartRow + (rule.startRow || 0),
                    startCol: destStartCol + (rule.startCol || 0),
                    endRow:   destStartRow + (rule.endRow   || 0),
                    endCol:   destStartCol + (rule.endCol   || 0),
                });
            }
        }

        if (mode === 'full' && conditionalFormats?.length > 0) {
            for (const rule of conditionalFormats) {
                sheetStore.addConditionalFormat?.({
                    ...rule,
                    id:       crypto.randomUUID?.() || Math.random().toString(36).slice(2),
                    startRow: destStartRow + (rule.startRow || 0),
                    startCol: destStartCol + (rule.startCol || 0),
                    endRow:   destStartRow + (rule.endRow   || 0),
                    endCol:   destStartCol + (rule.endCol   || 0),
                });
            }
        }

        if (mode === 'full' && !isSingleCell) {
            if (data.rowHeights) {
                for (let i = 0; i < data.rowHeights.length; i++) {
                    if (data.rowHeights[i] != null) sheetStore.setRowHeight?.(destStartRow + i, data.rowHeights[i]);
                }
            }
            if (data.colWidths) {
                for (let i = 0; i < data.colWidths.length; i++) {
                    if (data.colWidths[i] != null) sheetStore.setColWidth?.(destStartCol + i, data.colWidths[i]);
                }
            }
        }
    }

    getPasteModePlan(mode, isInternal) {
        const includesValues = ['full', 'values', 'valuesFormat'].includes(mode);
        const includesFormulas = ['full', 'formulas', 'formulasFormat'].includes(mode);
        const includesFormatting = ['full', 'formatting', 'valuesFormat', 'formulasFormat'].includes(mode);
        const formulasOnly = mode === 'formulas';
        // Keep border semantics aligned across formatting-capable modes to avoid
        // mode-specific divergence between "full" and special formatting pastes.
        const includesBorders = includesFormatting;
        const clearExistingBorders = includesFormatting;
        return { includesValues, includesFormulas, includesFormatting, includesBorders, clearExistingBorders, formulasOnly, isInternal };
    }

    applyValue(sheetStore, cell, row, col, rowOffset, colOffset, isInternal) {
        // Google Sheets compact JSON provides a separate .formula field
        if (cell.formula) {
            sheetStore.setCellFormula(row, col, this.adjustFormula(cell.formula, rowOffset, colOffset));
            return;
        }
        // External sources sometimes expose formula-like text in v without .formula.
        if (!isInternal && cell.isFormula && typeof cell.v === 'string' && cell.v.startsWith('=')) {
            sheetStore.setCellFormula(row, col, this.adjustFormula(cell.v, rowOffset, colOffset));
            return;
        }
        // Internal copy: cell.v IS the formula string (starts with '=')
        if (cell.isFormula && isInternal && cell.v) {
            sheetStore.setCellFormula(row, col, this.adjustFormula(cell.v, rowOffset, colOffset));
        } else if (cell.v !== null && cell.v !== undefined) {
            if (cell.tfr) {
                sheetStore.setCellValueWithRuns(row, col, String(cell.v), cell.tfr);
            } else {
                sheetStore.setCellValue(row, col, cell.v);
            }
        }
    }

    applyValueOnly(sheetStore, cell, row, col) {
        // For formula cells (values-only paste): prefer displayValue so the computed
        // result is stored, not the formula string.
        // For regular cells: prefer cell.v to preserve typed values (booleans, numbers).
        // Falling back to the opposite ensures something is stored when one is null.
        const isFormulaCell = cell.isFormula || cell.formula;
        const value = isFormulaCell
            ? (cell.displayValue ?? cell.v)
            : (cell.v ?? cell.displayValue);
        if (value !== null && value !== undefined) {
            if (!isFormulaCell && cell.tfr) {
                sheetStore.setCellValueWithRuns(row, col, String(value), cell.tfr);
            } else {
                sheetStore.setCellValue(row, col, value);
            }
        }
    }

    applyFormulaOnly(sheetStore, cell, row, col, rowOffset, colOffset, isInternal) {
        if (cell.formula) {
            sheetStore.setCellFormula(row, col, this.adjustFormula(cell.formula, rowOffset, colOffset));
        } else if (typeof cell.v === 'string' && cell.v.startsWith('=')) {
            sheetStore.setCellFormula(row, col, this.adjustFormula(cell.v, rowOffset, colOffset));
        } else if (cell.isFormula && isInternal && cell.v) {
            sheetStore.setCellFormula(row, col, this.adjustFormula(cell.v, rowOffset, colOffset));
        }
    }

    applyFormatting(sheetStore, cell, row, col) {
        const props = {};
        // String/null properties: apply only when set (null/undefined means "default", don't override)
        if (cell.fontFamily != null)      props.fontFamily      = cell.fontFamily;
        if (cell.fontSize   != null)      props.fontSize        = cell.fontSize;
        if (cell.color      != null)      props.color           = cell.color;
        if (cell.backgroundColor != null) props.backgroundColor = cell.backgroundColor;
        if (cell.horizontalAlign != null) props.horizontalAlign = cell.horizontalAlign;
        if (cell.verticalAlign   != null) props.verticalAlign   = cell.verticalAlign;
        if (cell.numberFormat    != null) props.numberFormat    = cell.numberFormat;
        if (cell.wrapText        != null) props.wrapText        = cell.wrapText;
        // Boolean properties: always apply so pasting a plain cell clears bold/italic/etc.
        // from the destination. The source cell stores `false` explicitly for these.
        if ('bold'          in cell) props.bold          = !!cell.bold;
        if ('italic'        in cell) props.italic        = !!cell.italic;
        if ('underline'     in cell) props.underline     = !!cell.underline;
        if ('strikethrough' in cell) props.strikethrough = !!cell.strikethrough;

        if (Object.keys(props).length > 0) sheetStore.setCellProperties(row, col, props);
        if (cell.ct) sheetStore.setCellTypeConfig(row, col, cell.ct);
    }

    applyBorders(sheetStore, borders, startRow, startCol, endRow, endCol, clearExisting = true) {
        if (clearExisting) sheetStore.clearBordersInRange(startRow, endRow, startCol, endCol);
        for (const border of borders) {
            const row = startRow + border.relRow;
            const col = startCol + border.relCol;
            if (row < startRow || row > endRow || col < startCol || col > endCol) continue;
            sheetStore.setCellBorder(row, col, border.edge, {
                style: border.style, width: border.width, color: border.color,
            });
        }
    }

    // ─── Formula Adjustment ───────────────────────────────────────────────────

    adjustFormula(formula, rowOffset, colOffset) {
        if (rowOffset === 0 && colOffset === 0) return formula;

        // Protect double-quoted string literals from cell-ref regex
        const literals = [];
        const stripped = formula.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
            literals.push(m);
            return `\x00${literals.length - 1}\x00`;
        });

        const adjusted = stripped.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g,
            (_match, colAbs, col, rowAbs, row) => {
                const colNum = this.colToNum(col);
                const rowNum = parseInt(row, 10);
                const newCol = colAbs ? col : this.numToCol(colNum + colOffset);
                const newRow = rowAbs ? row : String(rowNum + rowOffset);
                return `${colAbs}${newCol}${rowAbs}${newRow}`;
            }
        );

        return adjusted.replace(/\x00(\d+)\x00/g, (_placeholder, i) => literals[+i]);
    }

    colToNum(col) {
        let num = 0;
        for (let i = 0; i < col.length; i++) {
            num = num * 26 + (col.charCodeAt(i) - 64);
        }
        return num - 1;
    }

    numToCol(num) {
        let col = '';
        num++;
        while (num > 0) {
            num--;
            col = String.fromCharCode(65 + (num % 26)) + col;
            num = Math.floor(num / 26);
        }
        return col;
    }

    // ─── Utility ─────────────────────────────────────────────────────────────

    hasClipboard() {
        return this.clipboardData !== null;
    }

    canPaste() {
        return true;
    }
}

// Export singleton instance
export const clipboardManager = new ClipboardManager();
