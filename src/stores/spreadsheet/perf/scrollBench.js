/**
 * scrollBench — scripted scroll benchmark for reproducible scroll-performance numbers.
 *
 * Drives the grid's native scroll container (`.event-layer`) one small step per
 * animation frame so the incremental blit path in GridPaintCoordinator is
 * exercised exactly as a real flick would, then reports frame-pacing stats plus
 * the PerfMonitor render samples captured during the run.
 *
 * Installed onto window.__spreadsheetPerf.scrollBench from main.js.
 *
 *   await window.__spreadsheetPerf.scrollBench()                 // vertical round-trip
 *   await window.__spreadsheetPerf.scrollBench({ axis: 'x' })    // horizontal
 *   await window.__spreadsheetPerf.scrollBench({ axis: 'both', step: 24, frames: 300 })
 *
 * Why measure our own rAF cadence (not just perfMon.render.frame): during a
 * scroll the incremental paint runs via performScrollPaint(), which is NOT routed
 * through RenderScheduler — so render.frame is not recorded mid-scroll. The
 * rAF-to-rAF delta captures true main-thread frame budget (jank) regardless.
 */
import { perfMon } from './PerfMonitor.js';

/** @returns {HTMLElement|null} the grid scroll container */
function findScrollEl() {
    return /** @type {HTMLElement|null} */ (document.querySelector('.event-layer'));
}

/**
 * @param {Object} [opts]
 * @param {'y'|'x'|'both'} [opts.axis='y']  Scroll axis to exercise
 * @param {number} [opts.step=32]           Pixels scrolled per frame (keep < viewport to stay on the incremental-blit path)
 * @param {number} [opts.frames=200]        Frames to drive in each direction
 * @param {boolean} [opts.roundTrip=true]   Scroll to the far edge then back
 * @param {number} [opts.settleMs=150]      Idle wait before reading stats
 * @returns {Promise<Object|null>} summary metrics (also logged to console)
 */
export async function runScrollBench(opts = {}) {
    const {
        axis = 'y',
        step = 32,
        frames = 200,
        roundTrip = true,
        settleMs = 150,
    } = opts;

    const el = findScrollEl();
    if (!el) {
        console.warn('[scrollBench] .event-layer scroll container not found — open a spreadsheet first.');
        return null;
    }

    const spacer = /** @type {HTMLElement|null} */ (el.querySelector('.scroll-spacer'));
    const gridW = spacer?.offsetWidth ?? 0;
    const gridH = spacer?.offsetHeight ?? 0;
    const viewW = el.clientWidth;
    const viewH = el.clientHeight;

    const startTop = el.scrollTop;
    const startLeft = el.scrollLeft;

    const maxTop = Math.max(0, gridH - viewH);
    const maxLeft = Math.max(0, gridW - viewW);

    perfMon.enable();
    perfMon.reset();

    /** @type {number[]} */
    const frameDeltas = [];
    let last = performance.now();

    const driveDir = (sign) => new Promise((resolve) => {
        let i = 0;
        const tick = () => {
            const now = performance.now();
            frameDeltas.push(now - last);
            last = now;
            if (axis === 'y' || axis === 'both') {
                el.scrollTop = Math.min(maxTop, Math.max(0, el.scrollTop + sign * step));
            }
            if (axis === 'x' || axis === 'both') {
                el.scrollLeft = Math.min(maxLeft, Math.max(0, el.scrollLeft + sign * step));
            }
            i++;
            if (i < frames) requestAnimationFrame(tick);
            else resolve(undefined);
        };
        requestAnimationFrame(tick);
    });

    last = performance.now();
    await driveDir(+1);
    if (roundTrip) await driveDir(-1);
    await new Promise(r => setTimeout(r, settleMs));

    // Restore scroll position
    el.scrollTop = startTop;
    el.scrollLeft = startLeft;

    // Drop the first delta (warm-up: includes forced layout / first paint).
    const deltas = frameDeltas.slice(1).sort((a, b) => a - b);
    const n = deltas.length;
    const sum = deltas.reduce((a, b) => a + b, 0);
    const pct = (p) => deltas[Math.min(n - 1, Math.floor(n * p))] ?? 0;
    const over = (t) => deltas.filter(d => d > t).length;
    const avg = n > 0 ? sum / n : 0;
    const fps = avg > 0 ? 1000 / avg : 0;

    const bpd = perfMon.stats('render.buildPaneData');
    const pp = perfMon.stats('render.paintPane');
    const cells = perfMon.stats('render.buildPaneCells');
    const sel = perfMon.stats('render.selectionPaint');

    console.group('[scrollBench] Scroll benchmark');
    console.log(`grid ${gridW}×${gridH}px   viewport ${viewW}×${viewH}px   axis=${axis} step=${step}px frames=${n}`);
    console.log(`frame interval:  avg ${avg.toFixed(1)}ms   p50 ${pct(0.5).toFixed(1)}ms   p95 ${pct(0.95).toFixed(1)}ms   max ${(deltas[n - 1] || 0).toFixed(1)}ms`);
    console.log(`effective fps:   ${fps.toFixed(1)}   |   janky >16.7ms: ${over(16.7)} (${n ? (100 * over(16.7) / n).toFixed(0) : 0}%)   >33ms: ${over(33)}`);
    if (bpd) console.log(`buildPaneData:   avg ${bpd.avg.toFixed(2)}ms   p95 ${bpd.p95.toFixed(2)}ms   max ${bpd.max.toFixed(2)}ms   n=${bpd.count}`);
    if (pp) console.log(`paintPane:       avg ${pp.avg.toFixed(2)}ms   p95 ${pp.p95.toFixed(2)}ms   max ${pp.max.toFixed(2)}ms   n=${pp.count}`);
    if (sel) console.log(`selectionPaint:  avg ${sel.avg.toFixed(2)}ms   p95 ${sel.p95.toFixed(2)}ms   max ${sel.max.toFixed(2)}ms   n=${sel.count}`);
    if (cells) console.log(`cells/paneBuild: avg ${cells.avg.toFixed(0)}   max ${cells.max.toFixed(0)}`);
    console.groupEnd();

    perfMon.disable();

    return {
        fps,
        avgFrameMs: avg,
        p50FrameMs: pct(0.5),
        p95FrameMs: pct(0.95),
        maxFrameMs: deltas[n - 1] || 0,
        jank16: over(16.7),
        jank33: over(33),
        frames: n,
        grid: { gridW, gridH, viewW, viewH },
        buildPaneData: bpd,
        paintPane: pp,
        selectionPaint: sel,
    };
}

/**
 * Attach scrollBench to the PerfMonitor global so it's callable from DevTools.
 * @param {{ scrollBench?: Function }} [target=perfMon]
 */
export function installScrollBench(target = perfMon) {
    // @ts-ignore — augmenting the runtime singleton
    target.scrollBench = runScrollBench;
}

export default runScrollBench;
