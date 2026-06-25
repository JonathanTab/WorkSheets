/**
 * PerfMonitor — lightweight opt-in performance instrumentation for the spreadsheet.
 *
 * Zero overhead when disabled (all hot-path checks are a single boolean read).
 * Enable from the browser console:
 *
 *   window.__spreadsheetPerf.enable()
 *   // ... interact with the spreadsheet ...
 *   window.__spreadsheetPerf.report()
 *
 * Load-path breakdown (no enable() needed — the marks are always emitted by
 * SpreadsheetSession#doLoad). Reload the page, open a sheet, then:
 *
 *   window.__spreadsheetPerf.loadReport()
 *
 * Scripted scroll benchmark (reproducible frame numbers, installed from main.js):
 *
 *   await window.__spreadsheetPerf.scrollBench()            // vertical, round-trip
 *   await window.__spreadsheetPerf.scrollBench({ axis: 'x' })
 *
 * Instrumented categories (recorded automatically once enabled):
 *
 *   render.frame           ms per RAF paint cycle (all panes combined)
 *   render.paintPane       ms per individual pane paint call
 *   render.cellsPerPane    cell count passed to each paintPane call
 *   table.rebuildRowIndex  ms per row-index rebuild (fires on any row/filter/sort change)
 *   data.cellsVersionBump  count of SheetStore.cellsVersion increments (Yjs → UI updates)
 *   text.measureMiss       count of text-measurement canvas calls (cache misses)
 *   text.measureHit        count of text-measurement cache hits
 *
 * Example report output:
 *   [PerfMonitor] Report (12.3s session)
 *     render.frame           avg 3.21ms  p95 8.40ms  max 14.20ms  n=180
 *     render.paintPane       avg 0.82ms  p95 2.10ms  max 4.50ms   n=720
 *     table.rebuildRowIndex  avg 0.34ms  p95 1.20ms  max 3.10ms   n=22
 *     data.cellsVersionBump  count=55
 *     text.measureHit        count=12400
 *     text.measureMiss       count=340
 */

const MAX_SAMPLES = 200;

class PerfMonitor {
    enabled = false;

    /** @type {Map<string, number[]>} category → ring buffer of duration samples (ms) */
    #samples = new Map();

    /** @type {Map<string, number>} category → total call count */
    #counts = new Map();

    /** @type {number} wall-clock time of last reset() */
    #sessionStart = Date.now();

    enable() {
        this.enabled = true;
        this.reset();
        console.info(
            '[PerfMonitor] enabled.\n' +
            '  Interact with the spreadsheet, then call:\n' +
            '    window.__spreadsheetPerf.report()\n' +
            '  Or access raw samples via:\n' +
            '    window.__spreadsheetPerf.data'
        );
    }

    disable() {
        this.enabled = false;
        console.info('[PerfMonitor] disabled');
    }

    reset() {
        this.#samples.clear();
        this.#counts.clear();
        this.#sessionStart = Date.now();
    }

    /**
     * Record a timed measurement for a category.
     * No-op when disabled.
     * @param {string} category
     * @param {number} ms
     */
    record(category, ms) {
        if (!this.enabled) return;
        let buf = this.#samples.get(category);
        if (!buf) { buf = []; this.#samples.set(category, buf); }
        buf.push(ms);
        if (buf.length > MAX_SAMPLES) buf.shift();
        this.#counts.set(category, (this.#counts.get(category) ?? 0) + 1);
    }

    /**
     * Increment a named counter without recording a duration.
     * No-op when disabled.
     * @param {string} category
     */
    count(category) {
        if (!this.enabled) return;
        this.#counts.set(category, (this.#counts.get(category) ?? 0) + 1);
    }

    /**
     * Time a synchronous call and record it under `category`.
     * When disabled, calls fn directly with no overhead.
     * @template T
     * @param {string} category
     * @param {() => T} fn
     * @returns {T}
     */
    time(category, fn) {
        if (!this.enabled) return fn();
        const t = performance.now();
        const result = fn();
        this.record(category, performance.now() - t);
        return result;
    }

    /**
     * Compute summary statistics for a category's recorded samples.
     * @param {string} category
     * @returns {{ count:number, samples:number, avg:number, min:number, max:number, p50:number, p95:number } | null}
     */
    stats(category) {
        const samples = this.#samples.get(category);
        if (!samples || samples.length === 0) return null;
        const sorted = [...samples].sort((a, b) => a - b);
        const n = sorted.length;
        const sum = sorted.reduce((a, b) => a + b, 0);
        return {
            count: this.#counts.get(category) ?? n,
            samples: n,
            avg: sum / n,
            min: sorted[0],
            max: sorted[n - 1],
            p50: sorted[Math.floor(n * 0.5)],
            p95: sorted[Math.floor(n * 0.95)],
        };
    }

    /**
     * Print a formatted summary to the console.
     * Returns the same data as a plain object for programmatic use.
     */
    report() {
        const uptime = ((Date.now() - this.#sessionStart) / 1000).toFixed(1);
        const allCategories = [...new Set([...this.#samples.keys(), ...this.#counts.keys()])].sort();

        console.group(`[PerfMonitor] Report — ${uptime}s session`);

        for (const cat of allCategories) {
            const s = this.stats(cat);
            if (s) {
                console.log(
                    `${cat.padEnd(30)}  avg ${s.avg.toFixed(2)}ms  ` +
                    `p95 ${s.p95.toFixed(2)}ms  max ${s.max.toFixed(2)}ms  n=${s.count}`
                );
            } else {
                const c = this.#counts.get(cat) ?? 0;
                console.log(`${cat.padEnd(30)}  count=${c}`);
            }
        }

        const frameStats = this.stats('render.frame');
        if (frameStats?.avg) {
            console.log(`\nEstimated render-only fps: ${(1000 / frameStats.avg).toFixed(1)}`);
        }

        const hitCount = this.#counts.get('text.measureHit') ?? 0;
        const missCount = this.#counts.get('text.measureMiss') ?? 0;
        const total = hitCount + missCount;
        if (total > 0) {
            console.log(`Text cache hit rate: ${((hitCount / total) * 100).toFixed(1)}%`);
        }

        console.groupEnd();

        return Object.fromEntries(
            allCategories.map(cat => [cat, this.stats(cat) ?? { count: this.#counts.get(cat) ?? 0 }])
        );
    }

    /**
     * Print the load-path breakdown from the `ss:*` performance measures emitted
     * by SpreadsheetSession#doLoad. These marks are written unconditionally (no
     * enable() required). Dedupes by name, keeping the most recent measurement so
     * repeated in-session loads report the latest open.
     *
     * `ss:yjsLoad` covers `storage.drive.loadDoc` — network transfer + IndexedDB
     * (if enabled) + `Y.applyUpdate` decode, lumped together (the WS round-trip
     * cannot be separated from decode on the client alone).
     *
     * @returns {Record<string, number> | null} name → duration(ms), or null if no marks
     */
    loadReport() {
        if (typeof performance === 'undefined' || !performance.getEntriesByType) {
            console.warn('[PerfMonitor] performance.getEntriesByType unavailable');
            return null;
        }
        const measures = performance.getEntriesByType('measure').filter(m => m.name.startsWith('ss:'));
        if (measures.length === 0) {
            console.warn('[PerfMonitor] No ss:* load measures found. Reload the page, open a sheet, then call loadReport().');
            return null;
        }

        // Keep the most recent measurement per name (the buffer accumulates across loads).
        const byName = new Map();
        for (const m of measures) {
            const prev = byName.get(m.name);
            if (!prev || m.startTime > prev.startTime) byName.set(m.name, m);
        }

        const total = byName.get('ss:load:total');
        const phases = [...byName.values()]
            .filter(m => m.name !== 'ss:load:total')
            .sort((a, b) => a.startTime - b.startTime);

        console.group('[PerfMonitor] Load breakdown');
        if (total) console.log(`${total.name.padEnd(22)} ${total.duration.toFixed(1)}ms`);
        for (const m of phases) {
            const pct = total?.duration ? ` (${((m.duration / total.duration) * 100).toFixed(0)}%)` : '';
            console.log(`  ${m.name.padEnd(20)} ${m.duration.toFixed(1)}ms${pct}`);
        }
        console.groupEnd();

        return Object.fromEntries([...byName.values()].map(m => [m.name, +m.duration.toFixed(1)]));
    }

    /**
     * Raw sample arrays for custom analysis or charting.
     * @returns {Record<string, number[]>}
     */
    get data() {
        return Object.fromEntries([...this.#samples.entries()].map(([k, v]) => [k, [...v]]));
    }

    /**
     * Snapshot of all counters.
     * @returns {Record<string, number>}
     */
    get counts() {
        return Object.fromEntries(this.#counts);
    }

    /**
     * Convenience: log the last N render frame durations as a sparkline string.
     * @param {number} [n=40]
     */
    frameSparkline(n = 40) {
        const samples = this.#samples.get('render.frame');
        if (!samples) { console.log('[PerfMonitor] No frame data yet'); return; }
        const recent = samples.slice(-n);
        const max = Math.max(...recent);
        const bars = '▁▂▃▄▅▆▇█';
        const line = recent.map(v => bars[Math.min(7, Math.floor((v / max) * 7))]).join('');
        console.log(`Frame times (last ${recent.length}, max ${max.toFixed(1)}ms): ${line}`);
    }
}

export const perfMon = new PerfMonitor();

// Expose globally for DevTools access — always registered so users can call
// window.__spreadsheetPerf.enable() even before any instrumented code runs.
if (typeof window !== 'undefined') {
    window.__spreadsheetPerf = perfMon;
}
