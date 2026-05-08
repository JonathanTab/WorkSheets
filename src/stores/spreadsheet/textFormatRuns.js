/**
 * Text Format Runs — Google Sheets-style sparse rich text model.
 *
 * Storage:
 *   cell.v   = plain text string
 *   cell.tfr = TextFormatRun[] | null  (only present when inline formatting exists)
 *
 * TextFormatRun: { startIndex: number, format: TextFormat }
 * TextFormat: {
 *   bold?:            boolean
 *   italic?:          boolean
 *   underline?:       boolean
 *   strikethrough?:   boolean
 *   foregroundColor?: string   (CSS color)
 *   fontSize?:        number   (px)
 *   fontFamily?:      string
 *   link?:            { uri: string }
 * }
 *
 * Each run's format overrides the cell-level baseline from its startIndex until
 * the next run's startIndex. An empty format {} resets to the cell baseline.
 * Properties absent in a run's format are inherited from the cell level.
 */

// ─── Build render runs (for CanvasRenderer) ───────────────────────────────────

/**
 * Build flat render runs from plain text + tfr.
 * Returns { t, b?, i?, u?, s?, c?, f?, ff?, link? }[]
 * Only sets properties that are explicitly overridden; renderer inherits the rest
 * from cell-level formatting.
 *
 * @param {string} plainText
 * @param {Array|null} tfr
 * @returns {Array}
 */
export function buildRenderRuns(plainText, tfr) {
    if (!plainText) return [{ t: '' }];
    if (!tfr || tfr.length === 0) return [{ t: plainText }];

    const sorted = [...tfr].sort((a, b) => a.startIndex - b.startIndex);

    // Collect all segment boundaries
    const boundarySet = new Set([0, plainText.length]);
    for (const run of sorted) {
        if (run.startIndex > 0 && run.startIndex < plainText.length) {
            boundarySet.add(run.startIndex);
        }
    }
    const boundaries = [...boundarySet].sort((a, b) => a - b);

    const result = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        const segStart = boundaries[i];
        const segEnd   = boundaries[i + 1];
        const text = plainText.slice(segStart, segEnd);
        if (!text) continue;

        // Active run = last run whose startIndex <= segStart
        let activeFmt = {};
        for (const run of sorted) {
            if (run.startIndex <= segStart) activeFmt = run.format || {};
            else break;
        }

        const renderRun = { t: text };
        if (activeFmt.bold !== undefined)        renderRun.b    = activeFmt.bold;
        if (activeFmt.italic !== undefined)      renderRun.i    = activeFmt.italic;
        if (activeFmt.underline !== undefined)   renderRun.u    = activeFmt.underline;
        if (activeFmt.strikethrough !== undefined) renderRun.s  = activeFmt.strikethrough;
        if (activeFmt.foregroundColor)           renderRun.c    = activeFmt.foregroundColor;
        if (activeFmt.fontSize)                  renderRun.f    = activeFmt.fontSize;
        if (activeFmt.fontFamily)                renderRun.ff   = activeFmt.fontFamily;
        if (activeFmt.link?.uri)                 renderRun.link = activeFmt.link.uri;
        result.push(renderRun);
    }

    return mergeRenderRuns(result.length > 0 ? result : [{ t: plainText }]);
}

function mergeRenderRuns(runs) {
    const out = [];
    for (const run of runs) {
        const last = out[out.length - 1];
        if (last && renderRunKey(last) === renderRunKey(run)) {
            last.t += run.t;
        } else {
            out.push({ ...run });
        }
    }
    return out;
}

function renderRunKey(run) {
    return `${run.b ?? ''}|${run.i ?? ''}|${run.u ? 1 : 0}|${run.s ? 1 : 0}|${run.c ?? ''}|${run.f ?? ''}|${run.ff ?? ''}|${run.link ?? ''}`;
}

// ─── HTML ↔ TFR (editor serialization) ───────────────────────────────────────

/**
 * Build HTML string for contenteditable initialization from plain text + tfr.
 * Outputs <span> elements with inline styles; newlines become <br>.
 *
 * @param {string} plainText
 * @param {Array|null} tfr
 * @returns {string}
 */
export function runsToHtml(plainText, tfr) {
    if (!plainText) return '';
    const renderRuns = buildRenderRuns(plainText, tfr);

    return renderRuns.map(run => {
        // Encode newlines as <br>
        const parts = run.t.split('\n');
        const encoded = parts.map((part, idx) => {
            const esc = escHtml(part);
            return idx < parts.length - 1 ? (esc ? `${esc}<br>` : '<br>') : esc;
        }).join('');

        const styles = [];
        if (run.b === true)       styles.push('font-weight:bold');
        else if (run.b === false) styles.push('font-weight:normal');
        if (run.i === true)       styles.push('font-style:italic');
        else if (run.i === false) styles.push('font-style:normal');
        const dec = [];
        if (run.u) dec.push('underline');
        if (run.s) dec.push('line-through');
        if (dec.length) styles.push(`text-decoration:${dec.join(' ')}`);
        if (run.c)  styles.push(`color:${run.c}`);
        if (run.f)  styles.push(`font-size:${run.f}px`);
        if (run.ff) styles.push(`font-family:${run.ff}`);

        if (styles.length === 0 && !run.link) return encoded;
        const attrs = [`style="${styles.join(';')}"`];
        if (run.link) attrs.push(`data-link="${escAttr(run.link)}"`);
        return `<span ${attrs.join(' ')}>${encoded}</span>`;
    }).join('');
}

/**
 * Parse contenteditable innerHTML → { plainText: string, tfr: Array|null }.
 * Returns tfr = null when there is no inline formatting.
 *
 * @param {string} html
 * @returns {{ plainText: string, tfr: Array|null }}
 */
export function htmlToTfr(html) {
    const el = document.createElement('div');
    el.innerHTML = html;
    return _domToTfr(el);
}

function _domToTfr(el) {
    const flatRuns = [];
    let lastWasBlockBoundary = false;

    function parseNode(node, style) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.replace(/​/g, '');
            if (text) {
                _pushFlat(flatRuns, text, style);
                lastWasBlockBoundary = false;
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName.toLowerCase();
        const cs  = { ...style };
        const s   = node.style;

        if (s.fontWeight === 'bold')         cs.bold = true;
        else if (s.fontWeight === 'normal')  cs.bold = false;
        if (s.fontStyle === 'italic')        cs.italic = true;
        else if (s.fontStyle === 'normal')   cs.italic = false;
        if (s.textDecoration.includes('underline'))   cs.underline     = true;
        if (s.textDecoration.includes('line-through')) cs.strikethrough = true;
        if (s.color)      cs.foregroundColor = s.color;
        if (s.fontSize)   cs.fontSize        = parseFloat(s.fontSize);
        if (s.fontFamily) cs.fontFamily      = s.fontFamily;

        const linkAttr = node.getAttribute('data-link');
        if (linkAttr) cs.link = { uri: linkAttr };

        // Semantic tags
        if (tag === 'b' || tag === 'strong') cs.bold      = true;
        if (tag === 'i' || tag === 'em')     cs.italic    = true;
        if (tag === 'u')                     cs.underline = true;
        if (tag === 's' || tag === 'strike') cs.strikethrough = true;

        if (tag === 'br') {
            if (lastWasBlockBoundary) {
                lastWasBlockBoundary = false;
            } else {
                _pushFlat(flatRuns, '\n', {});
                lastWasBlockBoundary = false;
            }
        } else if (tag === 'div' || tag === 'p') {
            if (flatRuns.length > 0) {
                const last = flatRuns[flatRuns.length - 1];
                if (!last.text.endsWith('\n')) {
                    _pushFlat(flatRuns, '\n', {});
                    lastWasBlockBoundary = true;
                }
            }
            const onlyBr = node.childNodes.length === 1 &&
                node.childNodes[0].nodeType === Node.ELEMENT_NODE &&
                node.childNodes[0].tagName.toLowerCase() === 'br';
            if (onlyBr) {
                _pushFlat(flatRuns, '\n', {});
                lastWasBlockBoundary = false;
            } else {
                for (const child of node.childNodes) parseNode(child, cs);
            }
        } else {
            for (const child of node.childNodes) parseNode(child, cs);
        }
    }

    for (const child of el.childNodes) parseNode(child, {});

    // Trim trailing newline
    if (flatRuns.length > 0) {
        const last = flatRuns[flatRuns.length - 1];
        if (last.text === '\n') {
            flatRuns.pop();
        } else if (last.text.endsWith('\n')) {
            last.text = last.text.slice(0, -1);
            if (!last.text) flatRuns.pop();
        }
    }

    if (flatRuns.length === 0) return { plainText: '', tfr: null };

    const plainText = flatRuns.map(r => r.text).join('');
    const hasFormatting = flatRuns.some(_flatRunHasFormat);
    if (!hasFormatting) return { plainText, tfr: null };

    // Convert to tfr
    let offset = 0;
    const tfr = [];
    for (const run of flatRuns) {
        const fmt = {};
        if (run.bold !== undefined)       fmt.bold            = run.bold;
        if (run.italic !== undefined)     fmt.italic          = run.italic;
        if (run.underline)                fmt.underline       = true;
        if (run.strikethrough)            fmt.strikethrough   = true;
        if (run.foregroundColor)          fmt.foregroundColor = run.foregroundColor;
        if (run.fontSize)                 fmt.fontSize        = run.fontSize;
        if (run.fontFamily)               fmt.fontFamily      = run.fontFamily;
        if (run.link)                     fmt.link            = run.link;
        tfr.push({ startIndex: offset, format: fmt });
        offset += run.text.length;
    }

    return { plainText, tfr: normalizeTfr(tfr, plainText.length) };
}

function _pushFlat(runs, text, style) {
    const run = { text, ...style };
    const last = runs[runs.length - 1];
    if (last && _flatKey(last) === _flatKey(run)) {
        last.text += text;
    } else {
        runs.push(run);
    }
}

function _flatKey(run) {
    return `${run.bold ?? ''}|${run.italic ?? ''}|${run.underline ? 1 : 0}|${run.strikethrough ? 1 : 0}|${run.foregroundColor ?? ''}|${run.fontSize ?? ''}|${run.fontFamily ?? ''}|${JSON.stringify(run.link ?? null)}`;
}

function _flatRunHasFormat(run) {
    return run.bold !== undefined || run.italic !== undefined ||
        run.underline || run.strikethrough ||
        run.foregroundColor || run.fontSize || run.fontFamily || run.link;
}

// ─── Format mutations ─────────────────────────────────────────────────────────

/**
 * Apply a format delta to the character range [start, end).
 * null values in formatDelta remove that property from runs.
 * Returns a new normalized tfr array (or null).
 *
 * @param {Array|null} tfr
 * @param {number} start  inclusive
 * @param {number} end    exclusive
 * @param {Object} formatDelta
 * @param {number} textLen
 * @returns {Array|null}
 */
export function applyFormatToRange(tfr, start, end, formatDelta, textLen) {
    if (start >= end || start < 0 || end > textLen) return tfr;

    const sorted = _sorted(tfr, textLen);

    // Build all segment boundary points
    const boundarySet = new Set([0, start, end, textLen]);
    for (const run of sorted) {
        if (run.startIndex > 0 && run.startIndex < textLen) boundarySet.add(run.startIndex);
    }
    const boundaries = [...boundarySet].sort((a, b) => a - b);

    // Materialise segments
    const segments = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        const segStart = boundaries[i];
        let fmt = {};
        for (const run of sorted) {
            if (run.startIndex <= segStart) fmt = { ...run.format };
            else break;
        }
        segments.push({ start: segStart, format: fmt });
    }

    // Apply delta to segments inside [start, end)
    for (const seg of segments) {
        if (seg.start >= start && seg.start < end) {
            for (const [k, v] of Object.entries(formatDelta)) {
                if (v === null || v === undefined) delete seg.format[k];
                else seg.format[k] = v;
            }
        }
    }

    // Collapse back to tfr (emit run only when format changes)
    const newTfr = [];
    let prevKey = undefined;
    for (const seg of segments) {
        const key = JSON.stringify(seg.format);
        if (key !== prevKey) {
            newTfr.push({ startIndex: seg.start, format: { ...seg.format } });
            prevKey = key;
        }
    }

    return normalizeTfr(newTfr, textLen);
}

/**
 * Toggle bold/italic/underline/strikethrough in [start, end).
 * If all chars in the range already have the property set to true, clears it;
 * otherwise sets it to true.
 *
 * @param {Array|null} tfr
 * @param {number} start
 * @param {number} end
 * @param {'bold'|'italic'|'underline'|'strikethrough'} prop
 * @param {number} textLen
 * @returns {Array|null}
 */
export function toggleFormatInRange(tfr, start, end, prop, textLen) {
    const current = queryFormatInRange(tfr, start, end, textLen, prop);
    const delta = current === true ? { [prop]: null } : { [prop]: true };
    return applyFormatToRange(tfr, start, end, delta, textLen);
}

/**
 * Get the effective format at a character index.
 *
 * @param {Array|null} tfr
 * @param {number} index
 * @returns {Object}
 */
export function getFormatAtIndex(tfr, index) {
    if (!tfr || tfr.length === 0) return {};
    const sorted = [...tfr].sort((a, b) => a.startIndex - b.startIndex);
    let fmt = {};
    for (const run of sorted) {
        if (run.startIndex <= index) fmt = run.format || {};
        else break;
    }
    return fmt;
}

/**
 * Query whether a format property is uniform across [start, end).
 * Returns the value if uniform, 'mixed' if not, undefined if not set anywhere.
 *
 * @param {Array|null} tfr
 * @param {number} start
 * @param {number} end
 * @param {number} textLen
 * @param {string} property
 * @returns {any}
 */
export function queryFormatInRange(tfr, start, end, textLen, property) {
    const sorted = _sorted(tfr, textLen);
    const boundarySet = new Set([start, end]);
    for (const run of sorted) {
        if (run.startIndex > start && run.startIndex < end) boundarySet.add(run.startIndex);
    }
    const boundaries = [...boundarySet].sort((a, b) => a - b);

    const values = new Set();
    for (const segStart of boundaries.slice(0, -1)) {
        let fmt = {};
        for (const run of sorted) {
            if (run.startIndex <= segStart) fmt = run.format || {};
            else break;
        }
        values.add(fmt[property] ?? undefined);
    }
    return values.size === 1 ? [...values][0] : 'mixed';
}

/**
 * Adjust tfr indices after a text insertion or deletion.
 *
 * @param {Array|null} tfr
 * @param {number} offset   position where the edit happened
 * @param {number} inserted characters added (0 if none)
 * @param {number} deleted  characters removed (0 if none)
 * @returns {Array|null}
 */
export function adjustTfrForEdit(tfr, offset, inserted, deleted) {
    if (!tfr || tfr.length === 0) return tfr;
    if (inserted === 0 && deleted === 0) return tfr;

    const deleteEnd = offset + deleted;
    return tfr.map(run => {
        let idx = run.startIndex;
        if (inserted > 0 && idx >= offset)  idx += inserted;
        if (deleted  > 0) {
            if (idx >= deleteEnd)            idx -= deleted;
            else if (idx > offset)           idx  = offset;
        }
        return { startIndex: idx, format: run.format };
    });
}

/**
 * Normalize tfr: sort, merge adjacent identical formats, strip out-of-range runs.
 * Returns null when there are no meaningful runs (no inline formatting).
 *
 * @param {Array|null} tfr
 * @param {number} [textLen]
 * @returns {Array|null}
 */
export function normalizeTfr(tfr, textLen) {
    if (!tfr || tfr.length === 0) return null;

    const sorted = [...tfr]
        .filter(r => r.startIndex >= 0 && (textLen == null || r.startIndex < textLen))
        .sort((a, b) => a.startIndex - b.startIndex);

    if (sorted.length === 0) return null;

    // Merge adjacent identical formats
    const result = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const run = sorted[i];
        const prev = result[result.length - 1];
        if (_fmtEqual(prev.format, run.format)) continue;
        result.push(run);
    }

    // A single run at index 0 with empty format = no inline formatting
    if (result.length === 1 && result[0].startIndex === 0 && _fmtEmpty(result[0].format)) {
        return null;
    }

    // All formats empty = no inline formatting
    if (result.every(r => _fmtEmpty(r.format))) return null;

    return result;
}

// ─── Link hit-testing (Option B: re-measure on hover) ────────────────────────

/** @type {HTMLCanvasElement|null} */
let _measureCanvas = null;
function _measureCtx() {
    if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
    return _measureCanvas.getContext('2d');
}

/**
 * Hit-test a mouse position against the link runs in a cell.
 * Re-measures text on demand (only called on hover, not during scroll).
 * Handles single logical lines; for multi-line cells returns the first link
 * whose horizontal span contains the mouse X.
 *
 * @param {number} mouseXInCell  X offset from cell left edge
 * @param {number} mouseYInCell  Y offset from cell top edge
 * @param {Array}  renderRuns    from buildRenderRuns()
 * @param {number} cellWidth
 * @param {number} cellHeight
 * @param {Object} cellStyle     { hAlign, fontSize, fontFamily, bold, italic }
 * @param {Object} theme         { defaultFontSize, defaultFontFamily }
 * @returns {string|null}        link URI or null
 */
export function hitTestLink(mouseXInCell, mouseYInCell, renderRuns, cellWidth, cellHeight, cellStyle, theme) {
    if (!renderRuns || renderRuns.length === 0) return null;
    if (!renderRuns.some(r => r.link)) return null;

    const ctx            = _measureCtx();
    const pad            = 4;
    const hAlign         = cellStyle?.hAlign    || 'left';
    const defaultSize    = cellStyle?.fontSize  || theme?.defaultFontSize  || 12;
    const defaultFamily  = cellStyle?.fontFamily|| theme?.defaultFontFamily|| 'system-ui';
    const defaultBold    = cellStyle?.bold   || false;
    const defaultItalic  = cellStyle?.italic || false;
    const lineHeight     = defaultSize * 1.5;

    // Split runs into logical lines
    const logicalLines = [[]];
    for (const run of renderRuns) {
        const parts = run.t.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) logicalLines.push([]);
            if (parts[i]) logicalLines[logicalLines.length - 1].push({ ...run, t: parts[i] });
        }
    }

    const totalH  = logicalLines.length * lineHeight;
    const startY  = (cellHeight - totalH) / 2; // center vertical (approximation)

    for (let li = 0; li < logicalLines.length; li++) {
        const lineTop    = startY + li * lineHeight;
        const lineBottom = lineTop + lineHeight;
        if (mouseYInCell < lineTop || mouseYInCell >= lineBottom) continue;

        const lineRuns = logicalLines[li];
        if (!lineRuns.some(r => r.link)) continue;

        // Measure line width
        let lineW = 0;
        const widths = lineRuns.map(run => {
            const bold    = run.b !== undefined ? run.b : defaultBold;
            const italic  = run.i !== undefined ? run.i : defaultItalic;
            const size    = run.f  || defaultSize;
            const family  = run.ff || defaultFamily;
            ctx.font      = `${italic ? 'italic' : 'normal'} ${bold ? 'bold' : 'normal'} ${size}px ${family}`;
            const w = ctx.measureText(run.t).width;
            lineW += w;
            return w;
        });

        let runX;
        if (hAlign === 'right')  runX = cellWidth  - pad - lineW;
        else if (hAlign === 'center') runX = (cellWidth - lineW) / 2;
        else                     runX = pad;

        for (let i = 0; i < lineRuns.length; i++) {
            const endX = runX + widths[i];
            if (mouseXInCell >= runX && mouseXInCell < endX) {
                return lineRuns[i].link || null;
            }
            runX = endX;
        }
    }
    return null;
}

// ─── Selection helpers (used by GridOverlays) ─────────────────────────────────

/**
 * Compute character offset from the start of el to a DOM node:offset point.
 * Counts <br> elements as \n.
 *
 * @param {HTMLElement} el
 * @param {Node} targetNode
 * @param {number} targetOffset
 * @returns {number}
 */
export function getCharOffset(el, targetNode, targetOffset) {
    let count = 0;
    let found = false;

    function walk(node) {
        if (found) return;
        if (node === targetNode) {
            if (node.nodeType === Node.TEXT_NODE) count += targetOffset;
            found = true;
            return;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.replace(/​/g, '');
            count += text.length;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'br') {
                count += 1;
                // If target was the parent element at the index of this br
                if (targetNode === node.parentNode && targetOffset === _childIndex(node)) {
                    found = true;
                }
            } else {
                for (const child of node.childNodes) {
                    if (found) break;
                    walk(child);
                }
            }
        }
    }

    for (const child of el.childNodes) {
        if (found) break;
        walk(child);
    }
    return count;
}

/**
 * Restore a selection [start, end) inside el after innerHTML update.
 *
 * @param {HTMLElement} el
 * @param {number} start
 * @param {number} end
 */
export function restoreSelection(el, start, end) {
    let count = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;

    function walk(node) {
        if (startNode && endNode) return true;
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.replace(/​/g, '');
            const len = text.length;
            if (!startNode && count + len >= start) {
                startNode = node;
                startOff  = start - count;
            }
            if (!endNode && count + len >= end) {
                endNode = node;
                endOff  = end - count;
            }
            count += len;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'br') {
                if (!startNode && count + 1 > start) { startNode = node.parentNode; startOff = _childIndex(node); }
                if (!endNode   && count + 1 > end)   { endNode   = node.parentNode; endOff   = _childIndex(node); }
                count += 1;
            } else {
                for (const child of node.childNodes) {
                    if (walk(child)) return true;
                }
            }
        }
        return false;
    }

    walk(el);
    if (!startNode) { startNode = el; startOff = el.childNodes.length; }
    if (!endNode)   { endNode   = startNode; endOff = startOff; }

    try {
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
    } catch {
        // DOM may have changed — place cursor at end
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _sorted(tfr, textLen) {
    if (!tfr || tfr.length === 0) return [];
    return [...tfr]
        .filter(r => r.startIndex >= 0 && (textLen == null || r.startIndex < textLen))
        .sort((a, b) => a.startIndex - b.startIndex);
}

function _fmtEqual(a, b) {
    return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

function _fmtEmpty(fmt) {
    return !fmt || Object.keys(fmt).length === 0;
}

function _childIndex(node) {
    return [...node.parentNode.childNodes].indexOf(node);
}

function escHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escAttr(str) {
    return String(str).replace(/"/g, '&quot;');
}
