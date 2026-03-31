/**
 * pathData.js — SVG path d-attribute parsing, normalization, and serialization.
 * Pure math, no DOM.
 *
 * All public functions work with absolute, expanded PathSegment objects:
 *   { type: 'M', x, y }
 *   { type: 'L', x, y }
 *   { type: 'C', x1, y1, x2, y2, x, y }
 *   { type: 'Q', x1, y1, x, y }
 *   { type: 'A', rx, ry, xRot, large, sweep, x, y }
 *   { type: 'Z' }
 *
 * H/h, V/v are converted to L. S/s is expanded to C. T/t is expanded to Q.
 * Relative commands are converted to absolute. Implicit command repetition is handled.
 */

// ── Tokeniser ─────────────────────────────────────────────────────────────────

const TOKEN_RE = /([MmZzLlHhVvCcSsQqTtAa])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;

function tokenize(d) {
    const tokens = [];
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(d)) !== null) {
        if (m[1]) tokens.push({ t: 'cmd', v: m[1] });
        else      tokens.push({ t: 'num', v: parseFloat(m[2]) });
    }
    return tokens;
}

// ── Public: parse ─────────────────────────────────────────────────────────────

/**
 * parsePath(d) → PathSegment[]
 * Converts a path d-attribute string to an array of absolute, expanded segments.
 * Returns [] for empty / invalid input.
 */
export function parsePath(d) {
    if (!d || typeof d !== 'string') return [];
    const tokens = tokenize(d.trim());
    if (!tokens.length) return [];

    const segments = [];
    let cx = 0, cy = 0;   // current point
    let sx = 0, sy = 0;   // subpath start (for Z)
    let prevCtrl = null;   // { x, y } — last bezier control (for S and T reflection)
    let prevCmdUC = '';    // uppercase of previous command

    let i = 0;
    function num() { return (i < tokens.length && tokens[i].t === 'num') ? tokens[i++].v : 0; }
    function hasNum() { return i < tokens.length && tokens[i].t === 'num'; }

    // cmd may be a real command letter or null for implicit repetition
    let currentCmd = null;

    while (i < tokens.length) {
        // Consume command token if present
        if (tokens[i].t === 'cmd') {
            currentCmd = tokens[i++].v;
        } else if (currentCmd === null) {
            // Stray number with no command yet — skip
            i++;
            continue;
        }
        // else: implicit repetition, reuse currentCmd

        const isRel = currentCmd !== currentCmd.toUpperCase();
        const uc    = currentCmd.toUpperCase();
        const ox    = isRel ? cx : 0;   // relative offset x
        const oy    = isRel ? cy : 0;   // relative offset y

        switch (uc) {
            case 'M': {
                const x = num() + ox, y = num() + oy;
                segments.push({ type: 'M', x, y });
                cx = x; cy = y; sx = x; sy = y;
                prevCtrl = null; prevCmdUC = 'M';
                // After M, implicit repeats are L (or l for m)
                currentCmd = isRel ? 'l' : 'L';
                break;
            }
            case 'Z': {
                segments.push({ type: 'Z' });
                cx = sx; cy = sy;
                prevCtrl = null; prevCmdUC = 'Z';
                // Prevent implicit repetition of Z (it has no params, which would cause
                // an infinite loop since nothing advances i in the Z case).
                currentCmd = null;
                break;
            }
            case 'L': {
                const x = num() + ox, y = num() + oy;
                segments.push({ type: 'L', x, y });
                cx = x; cy = y;
                prevCtrl = null; prevCmdUC = 'L';
                break;
            }
            case 'H': {
                const x = num() + ox;
                segments.push({ type: 'L', x, y: cy });
                cx = x;
                prevCtrl = null; prevCmdUC = 'H';
                break;
            }
            case 'V': {
                const y = num() + oy;
                segments.push({ type: 'L', x: cx, y });
                cy = y;
                prevCtrl = null; prevCmdUC = 'V';
                break;
            }
            case 'C': {
                const x1 = num() + ox, y1 = num() + oy;
                const x2 = num() + ox, y2 = num() + oy;
                const x  = num() + ox, y  = num() + oy;
                segments.push({ type: 'C', x1, y1, x2, y2, x, y });
                prevCtrl = { x: x2, y: y2 };
                cx = x; cy = y; prevCmdUC = 'C';
                break;
            }
            case 'S': {
                // Smooth cubic — x1,y1 is reflection of last C/S control point
                const rx = (prevCmdUC === 'C' || prevCmdUC === 'S') ? 2 * cx - (prevCtrl?.x ?? cx) : cx;
                const ry = (prevCmdUC === 'C' || prevCmdUC === 'S') ? 2 * cy - (prevCtrl?.y ?? cy) : cy;
                const x2 = num() + ox, y2 = num() + oy;
                const x  = num() + ox, y  = num() + oy;
                segments.push({ type: 'C', x1: rx, y1: ry, x2, y2, x, y });
                prevCtrl = { x: x2, y: y2 };
                cx = x; cy = y; prevCmdUC = 'S';
                break;
            }
            case 'Q': {
                const x1 = num() + ox, y1 = num() + oy;
                const x  = num() + ox, y  = num() + oy;
                segments.push({ type: 'Q', x1, y1, x, y });
                prevCtrl = { x: x1, y: y1 };
                cx = x; cy = y; prevCmdUC = 'Q';
                break;
            }
            case 'T': {
                // Smooth quadratic — control point is reflection of last Q/T control
                const rx = (prevCmdUC === 'Q' || prevCmdUC === 'T') ? 2 * cx - (prevCtrl?.x ?? cx) : cx;
                const ry = (prevCmdUC === 'Q' || prevCmdUC === 'T') ? 2 * cy - (prevCtrl?.y ?? cy) : cy;
                const x  = num() + ox, y  = num() + oy;
                segments.push({ type: 'Q', x1: rx, y1: ry, x, y });
                prevCtrl = { x: rx, y: ry };
                cx = x; cy = y; prevCmdUC = 'T';
                break;
            }
            case 'A': {
                const rx   = num(), ry   = num();
                const xRot = num();
                const large = num(), sweep = num();
                const x    = num() + ox, y = num() + oy;
                segments.push({ type: 'A', rx, ry, xRot, large, sweep, x, y });
                cx = x; cy = y;
                prevCtrl = null; prevCmdUC = 'A';
                break;
            }
            default:
                i++; // unknown command — skip
        }

    }

    return segments;
}

// ── Public: serialize ─────────────────────────────────────────────────────────

/** Round to 2 decimal places for compact output */
function r(n) { return Math.round(n * 100) / 100; }

/**
 * serializePath(segments) → d-string
 * Converts absolute segments back to a compact SVG path d-attribute value.
 */
export function serializePath(segments) {
    const parts = [];
    for (const seg of segments) {
        switch (seg.type) {
            case 'M': parts.push(`M${r(seg.x)},${r(seg.y)}`); break;
            case 'L': parts.push(`L${r(seg.x)},${r(seg.y)}`); break;
            case 'C': parts.push(`C${r(seg.x1)},${r(seg.y1)} ${r(seg.x2)},${r(seg.y2)} ${r(seg.x)},${r(seg.y)}`); break;
            case 'Q': parts.push(`Q${r(seg.x1)},${r(seg.y1)} ${r(seg.x)},${r(seg.y)}`); break;
            case 'A': parts.push(`A${r(seg.rx)},${r(seg.ry)} ${r(seg.xRot)} ${seg.large} ${seg.sweep} ${r(seg.x)},${r(seg.y)}`); break;
            case 'Z': parts.push('Z'); break;
        }
    }
    return parts.join(' ');
}

// ── Public: geometry helpers ──────────────────────────────────────────────────

/**
 * segEndPt(seg) → {x,y} | null
 * Returns the endpoint of a segment, or null for Z.
 */
export function segEndPt(seg) {
    if (!seg || seg.type === 'Z') return null;
    return { x: seg.x, y: seg.y };
}

/**
 * anchorPoints(segments) → Array<{x, y, index}>
 * Returns the anchor (endpoint) positions for all non-Z segments.
 */
export function anchorPoints(segments) {
    const result = [];
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.type !== 'Z') {
            result.push({ x: seg.x, y: seg.y, index: i });
        }
    }
    return result;
}

/**
 * nodeHandles(segments, i) → { anchor, inHandle, outHandle } | null
 *
 * Returns the handle geometry for anchor node at index i.
 *   anchor    — the anchor point position
 *   inHandle  — the "in" control handle (x2,y2 of a C, or x1,y1 of a Q), or null
 *   outHandle — the "out" control handle (x1,y1 of the NEXT C or Q), or null
 *
 * These are in SVG user-unit absolute coordinates.
 */
export function nodeHandles(segments, i) {
    const seg = segments[i];
    if (!seg || seg.type === 'Z') return null;

    const anchor = { x: seg.x, y: seg.y };

    let inHandle = null;
    if (seg.type === 'C')      inHandle = { x: seg.x2, y: seg.y2 };
    else if (seg.type === 'Q') inHandle = { x: seg.x1, y: seg.y1 };

    let outHandle = null;
    const next = segments[i + 1];
    if (next?.type === 'C')      outHandle = { x: next.x1, y: next.y1 };
    else if (next?.type === 'Q') outHandle = { x: next.x1, y: next.y1 };

    return { anchor, inHandle, outHandle };
}

/**
 * moveAnchor(segments, i, dx, dy) → PathSegment[]
 * Returns a new segments array with anchor i (and its associated handles) moved by (dx, dy).
 * Handles are moved with the anchor to preserve relative positions.
 */
export function moveAnchor(segments, i, dx, dy) {
    const result = segments.map(s => ({ ...s }));
    const seg = result[i];
    if (!seg || seg.type === 'Z') return result;

    seg.x += dx; seg.y += dy;
    // Move "in" handle (part of this segment)
    if (seg.type === 'C') { seg.x2 += dx; seg.y2 += dy; }
    if (seg.type === 'Q') { seg.x1 += dx; seg.y1 += dy; }
    // Move "out" handle (x1,y1 of next segment)
    const next = result[i + 1];
    if (next?.type === 'C' || next?.type === 'Q') {
        next.x1 += dx; next.y1 += dy;
    }
    return result;
}

/**
 * moveInHandle(segments, i, x, y) → PathSegment[]
 * Moves the "in" control handle of anchor i to absolute position (x, y).
 */
export function moveInHandle(segments, i, x, y) {
    const result = segments.map(s => ({ ...s }));
    const seg = result[i];
    if (!seg) return result;
    if (seg.type === 'C') { seg.x2 = x; seg.y2 = y; }
    if (seg.type === 'Q') { seg.x1 = x; seg.y1 = y; }
    return result;
}

/**
 * moveOutHandle(segments, i, x, y) → PathSegment[]
 * Moves the "out" control handle of anchor i to absolute position (x, y).
 * (This is x1,y1 of the NEXT segment.)
 */
export function moveOutHandle(segments, i, x, y) {
    const result = segments.map(s => ({ ...s }));
    const next = result[i + 1];
    if (!next) return result;
    if (next.type === 'C' || next.type === 'Q') { next.x1 = x; next.y1 = y; }
    return result;
}

/**
 * deleteNodes(segments, indices) → PathSegment[]
 * Removes anchor nodes at the given indices from the segment list.
 * Tries to maintain path continuity (may leave dangling M or Z).
 */
export function deleteNodes(segments, indices) {
    const toDelete = new Set(indices);
    return segments.filter((_, i) => !toDelete.has(i));
}
