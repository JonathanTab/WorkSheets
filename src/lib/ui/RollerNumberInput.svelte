<script>
    import RollerColumn from "./RollerColumn.svelte";

    let {
        value = $bindable(0),
        min = 0,
        max = 59,
        step = 1,
        label = "",
        itemHeight = 40,
        formatFn = null,
        customValues = null, // Optional custom values array (for non-sequential values like 12-hour format)
    } = $props();

    // Derive possible values array - use customValues if provided
    let values = $derived.by(() => {
        if (customValues) return customValues;
        const arr = [];
        for (let v = min; v <= max; v += step) {
            arr.push(v);
        }
        return arr;
    });

    // Get the effective min/max from values array
    let effectiveMin = $derived(values.length > 0 ? Math.min(...values) : min);
    let effectiveMax = $derived(values.length > 0 ? Math.max(...values) : max);

    // Format display value
    function formatValue(v) {
        if (formatFn) return formatFn(v);
        return String(v).padStart(2, "0");
    }

    // Increment/decrement handlers for desktop buttons
    function decrement() {
        const newValue = value - step;
        value = newValue < min ? max : newValue;
    }

    function increment() {
        const newValue = value + step;
        value = newValue > max ? min : newValue;
    }

    // Handle direct input change
    function handleInput(e) {
        let newValue = parseInt(e.target.value, 10);
        if (!isNaN(newValue)) {
            newValue = Math.max(min, Math.min(max, newValue));
            value = newValue;
        }
    }
</script>

<div class="roller-input-container">
    {#if label}
        <label class="roller-label">{label}</label>
    {/if}

    <!-- Desktop: buttons + input -->
    <div class="desktop-controls">
        <button type="button" class="stepper-btn" onclick={decrement}>
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
            >
                <path d="M5 12h14" />
            </svg>
        </button>

        <input
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            class="value-input"
            value={formatValue(value)}
            oninput={handleInput}
            onblur={() => {
                // Ensure value is within bounds on blur
                value = Math.max(min, Math.min(max, value));
            }}
        />

        <button type="button" class="stepper-btn" onclick={increment}>
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
            >
                <path d="M12 5v14M5 12h14" />
            </svg>
        </button>
    </div>

    <!-- Mobile: Roller wheel -->
    <div class="mobile-roller">
        <RollerColumn {values} bind:selected={value} {itemHeight} {formatFn} />
    </div>
</div>

<style>
    .roller-input-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
    }

    .roller-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--color-text-tertiary);
    }

    /* Desktop controls - hidden on mobile */
    .desktop-controls {
        display: none;
        align-items: center;
        gap: 8px;
    }

    @media (min-width: 768px) {
        .desktop-controls {
            display: flex;
        }

        .mobile-roller {
            display: none;
        }
    }

    .stepper-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border-radius: 8px;
        border: 1px solid var(--color-border);
        background: var(--color-surface);
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all 0.15s ease;
        -webkit-tap-highlight-color: transparent;
    }

    .stepper-btn svg {
        width: 18px;
        height: 18px;
    }

    .stepper-btn:hover {
        background: var(--color-surface-tertiary);
        border-color: var(--color-border-strong);
    }

    .stepper-btn:active {
        transform: scale(0.95);
        background: var(--color-bg-tertiary);
    }

    .value-input {
        width: 56px;
        height: 40px;
        text-align: center;
        font-size: 20px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        border: 1px solid var(--color-border);
        border-radius: 10px;
        background: var(--color-surface);
        color: var(--color-text);
        outline: none;
        transition: all 0.15s ease;
    }

    .value-input:focus {
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.2);
    }

    /* Mobile roller container */
    .mobile-roller {
        width: 72px;
        height: 140px;
    }

    /* On mobile, always show roller */
    @media (max-width: 767px) {
        .roller-input-container {
            gap: 4px;
        }

        .roller-label {
            font-size: 10px;
        }
    }
</style>
