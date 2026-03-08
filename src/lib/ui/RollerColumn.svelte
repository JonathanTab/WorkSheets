<script>
    import { onMount } from "svelte";

    let {
        values = [],
        selected = $bindable(),
        itemHeight = 40,
        formatFn = null,
    } = $props();

    let scrollEl = $state(null);
    let isScrolling = false;
    let scrollTimeout;
    let isEditing = $state(false);
    let editInputEl = $state(null);
    let editValue = $state("");

    // Container height from parent (140px in RollerNumberInput)
    // Selection indicator should be centered: (containerHeight - itemHeight) / 2
    // For 140px container with 40px items: (140 - 40) / 2 = 50px
    // We use itemHeight * 1.25 to match the container height ratio
    const containerHeight = itemHeight * 3.5; // 140px when itemHeight=40
    const centerOffset = (containerHeight - itemHeight) / 2; // 50px

    // Format display value
    function formatValue(v) {
        if (formatFn) return formatFn(v);
        return String(v).padStart(2, "0");
    }

    // Scroll to selected value
    function scrollToValue(val, smooth = true) {
        if (!scrollEl) return;
        const index = values.indexOf(val);
        if (index >= 0) {
            const targetScrollTop = index * itemHeight;
            scrollEl.scrollTo({
                top: targetScrollTop,
                behavior: smooth ? "smooth" : "instant",
            });
        }
    }

    // Handle scroll events - update selected value
    function onScroll() {
        if (!scrollEl) return;

        isScrolling = true;
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            isScrolling = false;
            // Snap to nearest item when scrolling stops
            snapToNearest();
        }, 100);

        const index = Math.round(scrollEl.scrollTop / itemHeight);
        const clampedIndex = Math.max(0, Math.min(index, values.length - 1));
        if (values[clampedIndex] !== undefined) {
            selected = values[clampedIndex];
        }
    }

    // Snap to the nearest item
    function snapToNearest() {
        if (!scrollEl) return;
        const index = Math.round(scrollEl.scrollTop / itemHeight);
        const clampedIndex = Math.max(0, Math.min(index, values.length - 1));
        if (values[clampedIndex] !== undefined) {
            scrollToValue(values[clampedIndex], true);
        }
    }

    // Handle direct tap on a value
    function selectValue(v, event) {
        // If tapping the already selected item, enter edit mode
        if (v === selected) {
            event?.preventDefault();
            startEditing();
        } else {
            selected = v;
            scrollToValue(v);
        }
    }

    // Start editing the selected value
    function startEditing() {
        editValue = String(selected);
        isEditing = true;
    }

    // Finish editing and apply value
    function finishEditing() {
        if (!isEditing) return;

        // Parse and validate the entered value
        let newValue = parseInt(editValue, 10);

        if (!isNaN(newValue)) {
            // Find closest match in values array
            // For custom values, find exact match or closest
            if (values.includes(newValue)) {
                selected = newValue;
            } else {
                // Find closest value in the array
                let closest = values.reduce((prev, curr) => {
                    return Math.abs(curr - newValue) < Math.abs(prev - newValue)
                        ? curr
                        : prev;
                });
                selected = closest;
            }
        }

        isEditing = false;
        scrollToValue(selected, true);
    }

    // Handle input key events
    function handleInputKeydown(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            finishEditing();
        } else if (e.key === "Escape") {
            isEditing = false;
        }
        // Stop propagation to prevent modal close
        e.stopPropagation();
    }

    // Focus input when editing starts
    $effect(() => {
        if (isEditing && editInputEl) {
            editInputEl.focus();
            editInputEl.select();
        }
    });

    // When selected changes externally, scroll to it
    $effect(() => {
        if (scrollEl && !isScrolling && !isEditing) {
            scrollToValue(selected);
        }
    });

    onMount(() => {
        // Initial scroll to selected value
        const idx = values.indexOf(selected);
        if (idx >= 0 && scrollEl) {
            scrollEl.scrollTop = idx * itemHeight;
        }
    });
</script>

<div class="roller-container">
    <!-- Center selection indicator (behind items) -->
    <div class="selection-indicator" style="top: {centerOffset}px;"></div>

    <!-- Edit input overlay (shown when editing) -->
    {#if isEditing}
        <div class="edit-overlay" style="top: {centerOffset}px;">
            <input
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                bind:this={editInputEl}
                bind:value={editValue}
                class="edit-input"
                onkeydown={handleInputKeydown}
                onblur={finishEditing}
            />
        </div>
    {/if}

    <div bind:this={scrollEl} class="roller-scroll" onscroll={onScroll}>
        <!-- Top padding for centering first item -->
        <div class="roller-padding" style="height: {centerOffset}px;"></div>

        {#each values as v}
            <button
                type="button"
                class="roller-item"
                class:selected={v === selected && !isEditing}
                style="height: {itemHeight}px;"
                onclick={(e) => selectValue(v, e)}
            >
                {formatValue(v)}
            </button>
        {/each}

        <!-- Bottom padding for centering last item -->
        <div class="roller-padding" style="height: {centerOffset}px;"></div>
    </div>
</div>

<style>
    .roller-container {
        position: relative;
        height: 100%;
        width: 100%;
        overflow: hidden;
        border-radius: 12px;
        background: var(--color-surface);
        -webkit-mask-image: linear-gradient(
            to bottom,
            transparent 0%,
            black 30%,
            black 70%,
            transparent 100%
        );
        mask-image: linear-gradient(
            to bottom,
            transparent 0%,
            black 30%,
            black 70%,
            transparent 100%
        );
    }

    .selection-indicator {
        position: absolute;
        left: 4px;
        right: 4px;
        height: 40px;
        border-radius: 8px;
        background: var(--color-primary-soft);
        border: 2px solid var(--color-primary);
        pointer-events: none;
        z-index: 0;
    }

    .edit-overlay {
        position: absolute;
        left: 4px;
        right: 4px;
        height: 40px;
        border-radius: 8px;
        background: var(--color-surface);
        border: 2px solid var(--color-primary);
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .edit-input {
        width: 100%;
        height: 100%;
        text-align: center;
        font-size: 20px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        border: none;
        background: transparent;
        color: var(--color-text);
        outline: none;
        padding: 0 8px;
    }

    .roller-scroll {
        height: 100%;
        width: 100%;
        overflow-y: scroll;
        scroll-snap-type: y mandatory;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        -ms-overflow-style: none;
        overscroll-behavior: contain;
    }

    .roller-scroll::-webkit-scrollbar {
        display: none;
    }

    .roller-item {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        font-size: 20px;
        font-weight: 600;
        color: var(--color-text-tertiary);
        background: transparent;
        border: none;
        cursor: pointer;
        scroll-snap-align: center;
        scroll-snap-stop: always;
        transition:
            color 0.15s ease,
            transform 0.15s ease;
        -webkit-tap-highlight-color: transparent;
        position: relative;
        z-index: 2;
    }

    .roller-item:hover {
        color: var(--color-text-secondary);
    }

    .roller-item.selected {
        color: var(--color-text);
        transform: scale(1.05);
    }

    .roller-item:active {
        transform: scale(0.98);
    }

    .roller-padding {
        /* No scroll-snap-align on padding to avoid snapping to it */
    }
</style>
