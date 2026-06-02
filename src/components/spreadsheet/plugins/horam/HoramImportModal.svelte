<script>
    import { onMount } from 'svelte';
    import { closeTopModal } from '../../../../lib/ui/modalStore.svelte.js';
    import { spreadsheetSession } from '../../../../stores/spreadsheetStore.svelte.js';
    import {
        loadHoramDocData,
        computeTotals,
        msToHours,
    } from '../../../../stores/spreadsheet/plugins/horam/HoramConnector.js';
    import { serialToDate } from '../../../../formulas/dateCore.js';
    import ModalHeader from '../../../../lib/ui/ModalHeader.svelte';

    let { sheetStore, pluginId, config } = $props();

    // ── Cell ref helpers ───────────────────────────────────────────────────────
    function colLabel(n) {
        let s = ''; n++;
        while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
        return s;
    }
    function cellRef(row, col) { return `${colLabel(col)}${row + 1}`; }

    function parseRef(str) {
        const m = String(str ?? '').trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
        if (!m) return null;
        let col = 0;
        for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        return { row: parseInt(m[2]) - 1, col: col - 1 };
    }

    /**
     * Read a cell's computed display value and interpret it as a Date.
     * Uses getCellDisplayValue so formula results (=TODAY(), etc.) are resolved.
     */
    function readCellRefAsDate(refStr) {
        const parsed = parseRef(refStr);
        if (!parsed) return null;
        const raw = spreadsheetSession.getCellDisplayValue(parsed.row, parsed.col);
        if (raw == null || raw === '') return null;
        const num = Number(raw);
        if (!isNaN(num) && String(raw).trim() !== '') {
            // Formula engine stores dates as Excel serials (integers ~45000).
            // serialToDate gives local midnight, matching local-time session timestamps.
            const d = num > 100_000_000 ? new Date(num) : serialToDate(num);
            return isNaN(d.getTime()) ? null : d;
        }
        // ISO date-only strings ("2026-05-03") parse as UTC per spec — force local.
        const str = String(raw).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(str + 'T00:00:00');
        const d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    function toDateInput(d) { return d?.toISOString().slice(0, 10) ?? ''; }
    function fmtDate(d) {
        if (!d) return '';
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // ── Resolved dates from config cell refs ──────────────────────────────────
    let resolvedStartDate = $derived(readCellRefAsDate(config.startDateCell));
    let resolvedEndDate   = $derived(readCellRefAsDate(config.endDateCell));

    // Fallback manual inputs (shown only when no cell ref is configured)
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    let startDateManual = $state(toDateInput(firstOfMonth));
    let endDateManual   = $state(toDateInput(today));

    // Start of the start day in local time (local midnight).
    let startMs = $derived.by(() => {
        if (resolvedStartDate) return resolvedStartDate.getTime();
        // Date-only ISO strings parse as UTC — suffix forces local midnight.
        return startDateManual ? new Date(startDateManual + 'T00:00:00').getTime() : 0;
    });

    // End of the end day in local time: one ms before the next local midnight.
    // Uses Date constructor overflow (d+1) so DST "fall-back" nights aren't double-counted.
    let endMs = $derived.by(() => {
        if (resolvedEndDate) {
            const d = resolvedEndDate;
            return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
        }
        return endDateManual ? new Date(endDateManual + 'T23:59:59.999').getTime() : Date.now();
    });

    // ── Output location from config ────────────────────────────────────────────
    let outputRow = $derived(config.outputRow ?? (config.anchorRow ?? 0) + 1);
    let outputCol = $derived(config.outputCol ?? config.anchorCol ?? 0);
    let outputLabel = $derived(cellRef(outputRow, outputCol));

    // ── Load horam data ────────────────────────────────────────────────────────
    let loading   = $state(true);
    let loadError = $state('');
    let projects  = $state([]);

    onMount(async () => {
        try {
            const data = await loadHoramDocData(config.docId);
            projects = data.projects;
        } catch (e) {
            loadError = e.message ?? 'Failed to load horam document';
        } finally {
            loading = false;
        }
    });

    // ── Filter state (seeded from config) ─────────────────────────────────────
    let excludedProjects = $state(new Set(config.excludedProjectIds ?? []));
    let excludedTags     = $state(new Set(config.excludedTags       ?? []));

    function toggleProject(id) {
        const next = new Set(excludedProjects);
        if (next.has(id)) next.delete(id); else next.add(id);
        excludedProjects = next;
    }
    function toggleTag(tag) {
        const next = new Set(excludedTags);
        if (next.has(tag)) next.delete(tag); else next.add(tag);
        excludedTags = next;
    }

    // ── Visible projects/tags in the current period ────────────────────────────
    // A session is "in period" when it completed and its end timestamp falls within the range.
    function sessionInPeriod(s) {
        return s.end !== null && s.end >= startMs && s.end <= endMs;
    }

    let visibleProjects = $derived.by(() => {
        if (!projects.length) return [];
        return projects.filter(p => p.sessions.some(sessionInPeriod));
    });

    let visibleTags = $derived.by(() => {
        if (!projects.length) return [];
        const tags = new Set();
        for (const p of projects)
            for (const s of p.sessions)
                if (sessionInPeriod(s) && s.tag) tags.add(s.tag);
        return [...tags].sort();
    });

    // ── Computed totals ────────────────────────────────────────────────────────
    let totals = $derived.by(() => {
        if (!projects.length) return new Map();
        return computeTotals(projects, startMs, endMs, [...excludedProjects], [...excludedTags]);
    });

    let sortedTotals = $derived(
        [...totals.entries()]
            .map(([userId, ms]) => ({ userId, hours: msToHours(ms) }))
            .sort((a, b) => b.hours - a.hours)
    );

    // ── Write to sheet ─────────────────────────────────────────────────────────
    let writeError = $state('');

    function doImport() {
        if (!sortedTotals.length) { writeError = 'No data matches the current filters.'; return; }
        writeError = '';

        const sheet = sheetStore ?? spreadsheetSession.activeSheetStore;
        if (!sheet) { writeError = 'No active sheet.'; return; }

        const nameRow  = outputRow;
        const hoursRow = outputRow + 1;
        const startCol = outputCol;

        spreadsheetSession.ydoc?.transact(() => {
            sortedTotals.forEach(({ userId, hours }, i) => {
                sheet.setCellProperties(nameRow,  startCol + i, { v: userId });
                sheet.setCellProperties(hoursRow, startCol + i, { v: hours  });
            });
        });

        // Persist exclusion choices back to config
        sheet.setPlugin(pluginId, {
            ...config,
            excludedProjectIds: [...excludedProjects],
            excludedTags:       [...excludedTags],
        });

        closeTopModal();
    }
</script>

<div class="import-modal">
    <ModalHeader title={config.label ?? 'Import Hours from Horam'} />

    {#if loading}
        <div class="status">Loading horam data…</div>
    {:else if loadError}
        <div class="status error">{loadError}</div>
    {:else}
        <div class="body">

            <!-- Date range summary -->
            <div class="section">
                <div class="section-label">Date range</div>
                <div class="date-summary">
                    {#if config.startDateCell}
                        <div class="date-row">
                            <span class="date-source">From <code>{config.startDateCell}</code></span>
                            {#if resolvedStartDate}
                                <span class="date-val">{fmtDate(resolvedStartDate)}</span>
                            {:else}
                                <span class="date-err">No valid date in cell</span>
                            {/if}
                        </div>
                    {:else}
                        <div class="date-row">
                            <label class="manual-label">From</label>
                            <input type="date" bind:value={startDateManual} />
                        </div>
                    {/if}
                    {#if config.endDateCell}
                        <div class="date-row">
                            <span class="date-source">To <code>{config.endDateCell}</code></span>
                            {#if resolvedEndDate}
                                <span class="date-val">{fmtDate(resolvedEndDate)}</span>
                            {:else}
                                <span class="date-err">No valid date in cell</span>
                            {/if}
                        </div>
                    {:else}
                        <div class="date-row">
                            <label class="manual-label">To</label>
                            <input type="date" bind:value={endDateManual} />
                        </div>
                    {/if}
                </div>
                <div class="output-hint">
                    Output: usernames → <code>{outputLabel}</code>, hours → <code>{cellRef(outputRow + 1, outputCol)}</code>
                    (configure in Plugins → Horam Time Import…)
                </div>
            </div>

            <!-- Projects -->
            {#if visibleProjects.length > 0}
                <div class="section">
                    <div class="section-label">Projects <span class="sub">(uncheck to exclude)</span></div>
                    <div class="checklist">
                        {#each visibleProjects as p (p.id)}
                            <label class="check-row">
                                <input
                                    type="checkbox"
                                    checked={!excludedProjects.has(p.id)}
                                    onchange={() => toggleProject(p.id)}
                                />
                                <span>{p.title}</span>
                            </label>
                        {/each}
                    </div>
                </div>
            {/if}

            <!-- Tags -->
            {#if visibleTags.length > 0}
                <div class="section">
                    <div class="section-label">Tags <span class="sub">(uncheck to exclude)</span></div>
                    <div class="checklist">
                        {#each visibleTags as tag (tag)}
                            <label class="check-row">
                                <input
                                    type="checkbox"
                                    checked={!excludedTags.has(tag)}
                                    onchange={() => toggleTag(tag)}
                                />
                                <span class="tag-chip">{tag || '(no tag)'}</span>
                            </label>
                        {/each}
                    </div>
                </div>
            {/if}

            <!-- Preview -->
            <div class="section">
                <div class="section-label">Preview — hours per user</div>
                {#if sortedTotals.length === 0}
                    <div class="empty">No sessions match the current filters.</div>
                {:else}
                    <table class="totals-table">
                        <thead><tr><th>User</th><th>Hours</th></tr></thead>
                        <tbody>
                            {#each sortedTotals as row (row.userId)}
                                <tr>
                                    <td>{row.userId}</td>
                                    <td class="num">{row.hours}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                {/if}
            </div>

            {#if writeError}
                <div class="write-error">{writeError}</div>
            {/if}
        </div>

        <div class="footer">
            <button class="cancel-btn" onclick={closeTopModal}>Cancel</button>
            <button
                class="import-btn"
                onclick={doImport}
                disabled={!sortedTotals.length}
            >
                Import {sortedTotals.length} user{sortedTotals.length === 1 ? '' : 's'}
            </button>
        </div>
    {/if}
</div>

<style>
    .import-modal {
        display: flex; flex-direction: column;
        width: 420px; max-width: 96vw; max-height: 80vh;
    }
    .status { padding: 24px; text-align: center; font-size: 0.875rem; color: #6b7280; }
    .status.error { color: #ef4444; }
    .body { flex: 1; overflow-y: auto; }
    .section { padding: 10px 16px; border-bottom: 1px solid #f1f5f9; }
    .section:last-child { border-bottom: none; }
    .section-label {
        font-size: 0.75rem; font-weight: 600; color: #6b7280;
        text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px;
    }
    .sub { font-weight: 400; text-transform: none; letter-spacing: 0; }
    .date-summary { display: flex; flex-direction: column; gap: 5px; }
    .date-row { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; }
    .date-source { color: #6b7280; }
    .date-source code { font-family: monospace; background: #f1f5f9; padding: 1px 4px; border-radius: 2px; }
    .date-val { color: #374151; font-weight: 500; }
    .date-err { color: #ef4444; font-size: 0.75rem; }
    .manual-label { color: #374151; min-width: 32px; }
    .date-row input[type="date"] {
        border: 1px solid #cbd5e1; border-radius: 3px;
        padding: 3px 6px; font-size: 0.8125rem;
    }
    .output-hint { font-size: 0.75rem; color: #94a3b8; margin-top: 8px; line-height: 1.4; }
    .output-hint code { font-family: monospace; background: #f1f5f9; padding: 1px 3px; border-radius: 2px; }
    .checklist { display: flex; flex-wrap: wrap; gap: 4px 16px; }
    .check-row { display: flex; align-items: center; gap: 5px; cursor: pointer; font-size: 0.8125rem; color: #374151; }
    .check-row input { cursor: pointer; }
    .tag-chip { background: #f1f5f9; border-radius: 3px; padding: 1px 6px; font-size: 0.75rem; }
    .totals-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    .totals-table th { text-align: left; color: #6b7280; font-weight: 600; padding: 3px 0; border-bottom: 1px solid #e2e8f0; }
    .totals-table td { padding: 4px 0; color: #374151; }
    .totals-table td.num { font-family: monospace; text-align: right; }
    .empty { color: #94a3b8; font-style: italic; font-size: 0.8125rem; }
    .write-error { font-size: 0.8125rem; color: #ef4444; padding: 8px 16px; }
    .footer {
        display: flex; justify-content: flex-end; gap: 8px;
        padding: 12px 16px; border-top: 1px solid #e2e8f0; flex-shrink: 0;
    }
    .cancel-btn {
        padding: 6px 14px; background: #f1f5f9; color: #374151;
        border: 1px solid #e2e8f0; border-radius: 4px; cursor: pointer; font-size: 0.8125rem;
    }
    .cancel-btn:hover { background: #e2e8f0; }
    .import-btn {
        padding: 6px 16px; background: #3b82f6; color: white;
        border: none; border-radius: 4px; cursor: pointer; font-size: 0.8125rem; font-weight: 500;
    }
    .import-btn:hover:not(:disabled) { background: #2563eb; }
    .import-btn:disabled { opacity: 0.5; cursor: default; }
</style>
