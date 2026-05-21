<script>
    /**
     * DateConfigPanel — options panel for the date/time cell type.
     */
    import { DATE_PRESETS, TIME_PRESETS } from './datePresets.js';

    /** @type {{ options: Record<string,any>, onUpdate: (config: Record<string,any>) => void }} */
    let { options, onUpdate } = $props();

    let dateSubFormat = $derived(/** @type {string} */ (options.subFormat || 'date'));

    function setSubFormat(sf) {
        onUpdate({
            type: 'date',
            subFormat:  sf,
            datePreset: options.datePreset ?? 'MM/DD/YYYY',
            timePreset: options.timePreset ?? 'h:mm A',
        });
    }

    function setDatePreset(preset) {
        onUpdate({ type: 'date', ...options, datePreset: preset });
    }

    function setTimePreset(preset) {
        onUpdate({ type: 'date', ...options, timePreset: preset });
    }
</script>

<div class="options-panel">
    <!-- Sub-format tabs -->
    <div class="subformat-row">
        <button class="sf-btn" class:active={dateSubFormat === 'date'}
            onclick={() => setSubFormat('date')} title="Date only">Date</button>
        <button class="sf-btn" class:active={dateSubFormat === 'time'}
            onclick={() => setSubFormat('time')} title="Time only">Time</button>
        <button class="sf-btn" class:active={dateSubFormat === 'datetime'}
            onclick={() => setSubFormat('datetime')} title="Date and time">Date+Time</button>
    </div>

    {#if dateSubFormat !== 'time'}
        <div class="preset-section-label">Date format</div>
        <div class="preset-grid">
            {#each DATE_PRESETS as preset}
                <button
                    class="preset-btn"
                    class:active={(options.datePreset ?? options.format ?? 'MM/DD/YYYY') === preset.id}
                    onclick={() => setDatePreset(preset.id)}
                    title={preset.id}
                >{preset.example}</button>
            {/each}
        </div>
    {/if}

    {#if dateSubFormat !== 'date'}
        <div class="preset-section-label">Time format</div>
        <div class="preset-grid">
            {#each TIME_PRESETS as preset}
                <button
                    class="preset-btn"
                    class:active={(options.timePreset ?? 'h:mm A') === preset.id}
                    onclick={() => setTimePreset(preset.id)}
                    title={preset.id}
                >{preset.example}</button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .options-panel {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #e2e8f0;
    }

    .subformat-row {
        display: flex;
        gap: 3px;
        margin-bottom: 8px;
    }

    .sf-btn {
        flex: 1;
        padding: 4px 2px;
        border: 1px solid #e2e8f0;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.8rem;
        font-weight: 500;
        color: #374151;
        text-align: center;
        line-height: 1.2;
    }

    .sf-btn:hover { background: #f8fafc; }
    .sf-btn.active { background: #eff6ff; border-color: #3b82f6; color: #1d4ed8; }

    .preset-section-label {
        font-size: 0.72rem;
        font-weight: 600;
        color: #94a3b8;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        margin: 6px 0 3px;
    }

    .preset-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 3px;
        margin-bottom: 4px;
        max-height: 180px;
        overflow-y: auto;
    }

    .preset-btn {
        padding: 4px 6px;
        border: 1px solid #e2e8f0;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.78rem;
        color: #374151;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
    }

    .preset-btn:hover { background: #f8fafc; }
    .preset-btn.active { background: #eff6ff; border-color: #3b82f6; color: #1d4ed8; }
</style>
