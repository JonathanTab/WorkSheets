<script>
    /**
     * NumberConfigPanel — options panel for the number cell type.
     * Receives the current options object and calls onUpdate with the new
     * complete config whenever the user changes a setting.
     */

    /** @type {{ options: Record<string,any>, onUpdate: (config: Record<string,any>) => void }} */
    let { options, onUpdate } = $props();

    const SUB_FORMATS = [
        { id: 'default',    label: '123',  title: 'Number'      },
        { id: 'currency',   label: '$',    title: 'Currency'    },
        { id: 'accounting', label: '$()' , title: 'Accounting'  },
        { id: 'financial',  label: '()',   title: 'Financial'   },
        { id: 'percent',    label: '%',    title: 'Percent'     },
        { id: 'scientific', label: '1ᴱ',  title: 'Scientific'  },
    ];

    let subFormat = $derived(() => options.subFormat || 'default');

    function setSubFormat(sf) {
        const sym = options.symbol ?? '$';
        const decimals = options.decimals ?? 2;
        const thousandsSep = options.thousandsSep ?? (sf !== 'percent' && sf !== 'scientific');
        const negativeStyle = (sf === 'accounting' || sf === 'financial') ? 'parens' : (options.negativeStyle ?? 'minus');
        onUpdate({ type: 'number', subFormat: sf, decimals, thousandsSep, negativeStyle, symbol: sym, symbolAfter: options.symbolAfter ?? false });
    }

    function incrementDecimals() {
        const d = Math.min(10, (options.decimals ?? 2) + 1);
        onUpdate({ type: 'number', ...options, decimals: d });
    }

    function decrementDecimals() {
        const d = Math.max(0, (options.decimals ?? 2) - 1);
        onUpdate({ type: 'number', ...options, decimals: d });
    }

    function toggleThousands() {
        onUpdate({ type: 'number', ...options, thousandsSep: !(options.thousandsSep ?? true) });
    }
</script>

<div class="options-panel">
    <!-- Sub-format presets -->
    <div class="subformat-row">
        {#each SUB_FORMATS as sf}
            <button
                class="sf-btn"
                class:active={subFormat() === sf.id}
                onclick={() => setSubFormat(sf.id)}
                title={sf.title}
            >{sf.label}</button>
        {/each}
    </div>

    <!-- Decimals +/- and thousands toggle -->
    <div class="num-controls-row">
        <div class="decimals-group" title="Decimal places">
            <button class="dec-btn" onclick={decrementDecimals} title="Fewer decimals">.0</button>
            <span class="dec-value">{options.decimals ?? 2}</span>
            <button class="dec-btn" onclick={incrementDecimals} title="More decimals">.00</button>
        </div>
        <button
            class="toggle-btn"
            class:active={options.thousandsSep ?? (subFormat() !== 'percent' && subFormat() !== 'scientific')}
            onclick={toggleThousands}
            title="Thousands separator"
        >,</button>
    </div>

    <details class="more-options">
        <summary>More options</summary>
        <div class="more-body">
            {#if subFormat() === 'currency' || subFormat() === 'accounting'}
                <div class="option-row">
                    <label>Symbol</label>
                    <div class="symbol-row">
                        <input
                            type="text"
                            class="symbol-input"
                            value={options.symbol ?? '$'}
                            onchange={(e) => onUpdate({ type: 'number', ...options, symbol: /** @type {HTMLInputElement} */(e.target).value })}
                        />
                        <label class="inline-label">
                            <input
                                type="checkbox"
                                checked={options.symbolAfter ?? false}
                                onchange={(e) => onUpdate({ type: 'number', ...options, symbolAfter: /** @type {HTMLInputElement} */(e.target).checked })}
                            />
                            After
                        </label>
                    </div>
                </div>
            {/if}

            <div class="option-row">
                <label>Negatives</label>
                <select
                    value={options.negativeStyle ?? ((subFormat() === 'accounting' || subFormat() === 'financial') ? 'parens' : 'minus')}
                    onchange={(e) => onUpdate({ type: 'number', ...options, negativeStyle: /** @type {HTMLSelectElement} */(e.target).value })}
                >
                    <option value="minus">−1,234</option>
                    <option value="parens">(1,234)</option>
                    <option value="red">Red −1,234</option>
                    <option value="redParens">Red (1,234)</option>
                </select>
            </div>
        </div>
    </details>
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
        min-width: 0;
    }

    .sf-btn:hover { background: #f8fafc; }
    .sf-btn.active { background: #eff6ff; border-color: #3b82f6; color: #1d4ed8; }

    .num-controls-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }

    .decimals-group {
        display: flex;
        align-items: center;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        overflow: hidden;
    }

    .dec-btn {
        padding: 3px 8px;
        background: white;
        border: none;
        cursor: pointer;
        font-size: 0.8rem;
        color: #374151;
        font-family: monospace;
    }

    .dec-btn:hover { background: #f1f5f9; }

    .dec-value {
        padding: 3px 6px;
        font-size: 0.8rem;
        font-weight: 600;
        color: #1e293b;
        border-left: 1px solid #e2e8f0;
        border-right: 1px solid #e2e8f0;
        min-width: 22px;
        text-align: center;
    }

    .toggle-btn {
        padding: 3px 10px;
        border: 1px solid #e2e8f0;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9rem;
        font-weight: 600;
        color: #94a3b8;
    }

    .toggle-btn:hover { background: #f8fafc; }
    .toggle-btn.active { background: #eff6ff; border-color: #3b82f6; color: #1d4ed8; }

    .more-options { margin-top: 4px; }

    .more-options summary {
        font-size: 0.75rem;
        color: #64748b;
        cursor: pointer;
        user-select: none;
        padding: 2px 0;
        list-style: none;
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .more-options summary::before {
        content: '▸';
        font-size: 0.65rem;
        transition: transform 0.15s;
    }

    .more-options[open] summary::before { transform: rotate(90deg); }

    .more-body {
        margin-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .option-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.8125rem;
    }

    .option-row label { color: #374151; white-space: nowrap; }

    .option-row select {
        flex: 1;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
    }

    .symbol-row { display: flex; align-items: center; gap: 6px; }

    .symbol-input {
        width: 36px;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 3px;
        font-size: 0.8125rem;
        text-align: center;
    }

    .inline-label {
        display: flex;
        align-items: center;
        gap: 3px;
        font-size: 0.8125rem;
        color: #64748b;
        white-space: nowrap;
        cursor: pointer;
    }
</style>
