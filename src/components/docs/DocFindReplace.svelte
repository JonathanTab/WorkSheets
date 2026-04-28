<script>
    /**
     * DocFindReplace — find & replace panel, slides in below the toolbar.
     * Ctrl+F opens it; Escape closes it.
     */
    import { onMount } from 'svelte';
    import {
        setFind, clearFind, findNext, findPrev,
        replaceActive, replaceAll, getFindState,
    } from '../../stores/docs/docFindPlugin.js';

    let {
        view = null,
        onClose = undefined,
        showReplace = false,
    } = $props();

    let query = $state('');
    let replaceText = $state('');
    let matchCase = $state(false);
    let queryInput = $state(null);

    // Current find plugin state derived from editor state
    let findState = $derived.by(() => {
        if (!view) return null;
        return getFindState(view.state);
    });

    let matchCount = $derived(findState?.matches?.length ?? 0);
    let activeIndex = $derived(findState?.activeIndex ?? -1);

    // Sync query to plugin whenever it changes
    $effect(() => {
        if (!view) return;
        if (query) {
            setFind(query, matchCase)(view.state, view.dispatch);
        } else {
            clearFind(view.state, view.dispatch);
        }
        view.focus();
    });

    $effect(() => {
        if (matchCase !== undefined && query) {
            setFind(query, matchCase)(view.state, view.dispatch);
        }
    });

    onMount(() => {
        setTimeout(() => queryInput?.focus(), 0);
    });

    function close() {
        if (view) clearFind(view.state, view.dispatch);
        onClose?.();
    }

    function next() {
        if (!view || !matchCount) return;
        findNext(view.state, view.dispatch);
        scrollToActive();
        view.focus();
    }

    function prev() {
        if (!view || !matchCount) return;
        findPrev(view.state, view.dispatch);
        scrollToActive();
        view.focus();
    }

    function scrollToActive() {
        // Give ProseMirror a tick to update decorations, then scroll
        requestAnimationFrame(() => {
            const el = view?.dom?.querySelector('.find-match-active');
            el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
    }

    function doReplaceOne() {
        if (!view) return;
        replaceActive(replaceText)(view.state, view.dispatch);
        view.focus();
    }

    function doReplaceAll() {
        if (!view) return;
        const count = matchCount;
        replaceAll(replaceText)(view.state, view.dispatch);
        view.focus();
    }

    function handleKeydown(e) {
        if (e.key === 'Escape') { close(); return; }
        if (e.key === 'Enter') {
            if (e.shiftKey) prev(); else next();
            e.preventDefault();
        }
    }
</script>

<div class="find-bar" role="search" aria-label="Find and replace">
    <div class="find-row">
        <!-- Find input -->
        <div class="input-group">
            <div class="input-wrap" class:has-matches={matchCount > 0} class:no-match={query && matchCount === 0}>
                <input
                    bind:this={queryInput}
                    type="text"
                    placeholder="Find…"
                    class="find-input"
                    bind:value={query}
                    onkeydown={handleKeydown}
                    autocomplete="off"
                    spellcheck="false"
                />
                {#if query}
                    <span class="match-count">
                        {matchCount === 0 ? 'No results' : `${activeIndex + 1} / ${matchCount}`}
                    </span>
                {/if}
            </div>

            <label class="option-toggle" title="Match case">
                <input type="checkbox" bind:checked={matchCase} />
                <span>Aa</span>
            </label>
        </div>

        <!-- Navigation -->
        <div class="nav-group">
            <button class="nav-btn" onclick={prev} disabled={matchCount === 0} title="Previous match (Shift+Enter)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="18 15 12 9 6 15"/>
                </svg>
            </button>
            <button class="nav-btn" onclick={next} disabled={matchCount === 0} title="Next match (Enter)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
        </div>

        <!-- Toggle replace -->
        <button
            class="toggle-replace"
            onclick={() => showReplace = !showReplace}
            title={showReplace ? 'Hide replace' : 'Show replace'}
        >
            Replace {showReplace ? '▲' : '▼'}
        </button>

        <!-- Close -->
        <button class="close-btn" onclick={close} title="Close (Escape)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    </div>

    {#if showReplace}
        <div class="replace-row">
            <input
                type="text"
                placeholder="Replace with…"
                class="find-input replace-input"
                bind:value={replaceText}
                onkeydown={(e) => { if (e.key === 'Escape') close(); }}
                spellcheck="false"
            />
            <button
                class="replace-btn"
                onclick={doReplaceOne}
                disabled={matchCount === 0}
                title="Replace this match"
            >Replace</button>
            <button
                class="replace-btn replace-all-btn"
                onclick={doReplaceAll}
                disabled={matchCount === 0}
                title="Replace all matches"
            >Replace all</button>
        </div>
    {/if}
</div>

<style>
    .find-bar {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 5px 10px;
        background: var(--color-bg-secondary, #f2f2f7);
        border-bottom: 1px solid var(--color-border, #c6c6c8);
        flex-shrink: 0;
    }

    .find-row,
    .replace-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .input-group {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 1;
        min-width: 0;
    }

    .input-wrap {
        display: flex;
        align-items: center;
        position: relative;
        flex: 1;
        min-width: 0;
    }

    .find-input {
        height: 26px;
        border: 1px solid var(--color-border, #c6c6c8);
        border-radius: 5px;
        padding: 0 8px;
        font-size: 12px;
        color: var(--color-text);
        background: var(--color-surface);
        width: 100%;
        min-width: 120px;
        outline: none;
    }
    .find-input:focus {
        border-color: var(--color-primary, #007AFF);
        box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.2);
    }
    .input-wrap.no-match .find-input {
        border-color: #ef4444;
        background: #fff5f5;
    }
    .input-wrap.no-match .find-input:focus {
        box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
    }

    .match-count {
        position: absolute;
        right: 6px;
        font-size: 10px;
        color: var(--color-text-muted, #a1a1aa);
        white-space: nowrap;
        pointer-events: none;
    }

    .option-toggle {
        display: flex;
        align-items: center;
        gap: 0;
        cursor: pointer;
        flex-shrink: 0;
    }
    .option-toggle input { display: none; }
    .option-toggle span {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        color: var(--color-text-secondary);
        background: var(--color-surface);
        transition: all 0.1s;
    }
    .option-toggle input:checked + span {
        background: var(--color-primary, #007AFF);
        border-color: var(--color-primary, #007AFF);
        color: white;
    }
    .option-toggle:hover span { background: var(--color-fill); }

    .nav-group {
        display: flex;
        border: 1px solid var(--color-border);
        border-radius: 5px;
        overflow: hidden;
        flex-shrink: 0;
    }

    .nav-btn {
        width: 28px;
        height: 26px;
        background: var(--color-surface);
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: var(--color-text-secondary);
        transition: background 0.1s;
    }
    .nav-btn + .nav-btn { border-left: 1px solid var(--color-border); }
    .nav-btn:hover:not(:disabled) { background: var(--color-fill); color: var(--color-text); }
    .nav-btn:disabled { opacity: 0.4; cursor: default; }

    .toggle-replace {
        height: 26px;
        padding: 0 8px;
        border: 1px solid var(--color-border);
        border-radius: 5px;
        background: var(--color-surface);
        color: var(--color-text-secondary);
        font-size: 11px;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .toggle-replace:hover { background: var(--color-fill); color: var(--color-text); }

    .close-btn {
        width: 26px;
        height: 26px;
        border: none;
        background: transparent;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: var(--color-text-secondary);
        flex-shrink: 0;
    }
    .close-btn:hover { background: var(--color-fill); color: var(--color-text); }

    /* Replace row */
    .replace-input { max-width: 240px; }

    .replace-btn {
        height: 26px;
        padding: 0 10px;
        border: 1px solid var(--color-border);
        border-radius: 5px;
        background: var(--color-surface);
        color: var(--color-text-secondary);
        font-size: 11px;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
    }
    .replace-btn:hover:not(:disabled) { background: var(--color-fill); color: var(--color-text); }
    .replace-btn:disabled { opacity: 0.4; cursor: default; }

    .replace-all-btn {
        background: var(--color-primary, #007AFF);
        border-color: var(--color-primary, #007AFF);
        color: white;
    }
    .replace-all-btn:hover:not(:disabled) { opacity: 0.9; background: var(--color-primary, #007AFF); }

    @media (max-width: 600px) {
        .toggle-replace { display: none; }
    }
</style>
