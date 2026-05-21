/**
 * RichTextLayout.js — Shared word-wrap algorithm for rich-text runs.
 *
 * Used by both CanvasRenderer (CSS pixel measurements via ctx.measureText)
 * and VectorPrintEngine (mm measurements via pdf.getStringUnitWidth).
 * The algorithm is unit-agnostic: widths are whatever the caller's measureFn returns.
 *
 * @example — Canvas usage
 *   const lines = buildWrappedLines(lineRuns, maxWidthPx, (token, run) => {
 *       const font = buildRunFont(run, ...); ctx.font = font;
 *       return ctx.measureText(token).width;
 *   });
 *
 * @example — PDF usage
 *   const lines = buildWrappedLines(runs, maxWidthMm, (token, run) => {
 *       applyFont(pdf, cell, scale, run);
 *       return textWidthMm(pdf, token, run.f || defaultSizePt, scale);
 *   });
 */

/**
 * Word-wrap a single logical line (no explicit \n) of rich-text runs to fit
 * within `maxWidth` units. Splits only at whitespace boundaries; a single word
 * wider than maxWidth is never split.
 *
 * Returns an array of visual sub-lines, each being an array of run fragments.
 * Each fragment is a copy of the original run object with a `.t` (text) field
 * containing the fragment text and a `._w` field containing its measured width.
 *
 * @param {Array<{t:string, [key:string]:any}>} lineRuns - Rich-text run objects for this line
 * @param {number} maxWidth - Maximum line width in caller's units
 * @param {(token: string, run: object) => number} measureFn
 *   Called once per token to get its width. The caller is responsible for
 *   setting up fonts/styles before measuring (e.g. `ctx.font =`).
 * @returns {Array<Array<{t:string, _w:number, [key:string]:any}>>}
 */
export function buildWrappedLines(lineRuns, maxWidth, measureFn) {
    if (lineRuns.length === 0) return [[]];

    const visualLines = [[]];
    let lineWidth = 0;

    for (const run of lineRuns) {
        // Split text into word/whitespace tokens, keeping delimiters
        const tokens = run.t.split(/(\s+)/);

        for (const token of tokens) {
            if (!token) continue;
            const isWS = !token.trim();
            const tokenW = measureFn(token, run);

            // Skip leading whitespace on a new visual line
            if (lineWidth === 0 && isWS) continue;

            if (!isWS && lineWidth > 0 && lineWidth + tokenW > maxWidth) {
                // Word doesn't fit — start a new visual line
                visualLines.push([]);
                lineWidth = 0;
            }

            const lastLine = visualLines[visualLines.length - 1];
            const lastFrag = lastLine[lastLine.length - 1];

            // Merge with the last fragment if it belongs to the same run
            // (avoids tiny per-token objects for runs without style changes)
            if (lastFrag && lastFrag._runRef === run) {
                lastFrag.t += token;
                lastFrag._w += tokenW;
            } else {
                lastLine.push({ ...run, t: token, _runRef: run, _w: tokenW });
            }
            lineWidth += tokenW;
        }
    }

    // Remove internal _runRef helper (not needed by callers)
    for (const line of visualLines) {
        for (const frag of line) delete frag._runRef;
    }

    // Drop empty trailing lines
    while (visualLines.length > 1 && visualLines[visualLines.length - 1].length === 0) {
        visualLines.pop();
    }

    return visualLines;
}
