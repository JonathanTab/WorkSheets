<script>
    /**
     * FormulaInput - Shared formula/text input with colored reference overlay.
     *
     * Renders a plain <input> with a transparent-text trick: when the value is
     * a formula the real input is made transparent and a positioned overlay div
     * renders the same text with per-reference color spans. The caret stays in
     * the real input so editing works normally.
     *
     * Props:
     *   value        — current text (controlled)
     *   readonly     — disables editing (rich-text cells)
     *   onInput(value, selStart, selEnd)
     *   onSelect(selStart, selEnd)
     *   onKeydown(e)
     *   onBlur(e)
     *   scrollable   — true (default) to make overlay scrollable and sync scrollLeft
     *   inputClass   — extra CSS class on the <input>
     *
     * Exports:
     *   focus()      — focus the underlying input
     *   el           — the <input> element (bind:this target)
     */

    import { segmentFormula } from '../../formulas/formulaParser.js';
    import FormulaValuePopup from './FormulaValuePopup.svelte';

    let {
        value    = '',
        readonly = false,
        onInput  = null,
        onSelect = null,
        onKeydown = null,
        onBlur    = null,
        scrollable = true,
        inputClass = '',
        // Desired caret position to apply when `caretSync` bumps (e.g. after a
        // formula ref is inserted by clicking the grid). Left untouched on normal
        // typing so the user's caret is never hijacked.
        selStart  = null,
        selEnd    = null,
        caretSync = 0,
    } = $props();

    let inputEl      = $state(null);
    let overlayEl    = $state(null);

    // Apply a programmatic caret move exactly once per `caretSync` change. The
    // controlled `value` resets the DOM caret to the end, so after a ref insert
    // we must restore the intended position; reading caretSync keeps this from
    // re-running on every keystroke. Seeded from the initial prop so mounting
    // (e.g. a surface switch) doesn't yank the caret to the end of the text.
    let _lastCaretSync = caretSync;
    $effect(() => {
        const sync = caretSync;
        if (sync === _lastCaretSync) return;
        _lastCaretSync = sync;
        if (!inputEl || selStart == null) return;
        const s = selStart;
        const e = selEnd ?? selStart;
        // Defer past the value-driven DOM update, then focus + set the caret in one
        // step. Doing the focus here makes the result independent of any external
        // requestFocus() timing (the in-cell editor focuses via a nested timeout,
        // which would otherwise fire after this and reset the caret to the end).
        // Use a double rAF-equivalent (two timeouts) so we win that ordering.
        setTimeout(() => {
            if (!inputEl) return;
            try { inputEl.focus({ preventScroll: true }); } catch { inputEl.focus(); }
            try { inputEl.setSelectionRange(s, e); } catch { /* not focusable yet */ }
            setTimeout(() => {
                if (!inputEl || document.activeElement !== inputEl) return;
                try { inputEl.setSelectionRange(s, e); } catch { /* ignore */ }
            }, 0);
        }, 0);
    });

    const isFormula   = $derived(typeof value === 'string' && value.startsWith('='));
    const segments    = $derived(isFormula ? segmentFormula(value) : []);

    // ── Scroll sync ───────────────────────────────────────────────────────────

    function syncScroll(scrollLeft = 0) {
        if (overlayEl) overlayEl.scrollLeft = scrollLeft;
    }

    // Reset overlay scroll when switching away from formula mode.
    $effect(() => {
        if (!isFormula || !scrollable) syncScroll(0);
    });

    // ── Public API ────────────────────────────────────────────────────────────

    export function focus() {
        setTimeout(() => {
            try { inputEl?.focus({ preventScroll: true }); }
            catch { inputEl?.focus(); }
        }, 0);
    }

    export { inputEl as el };
</script>

<div class="formula-input-root" class:is-formula={isFormula}>
    <input
        bind:this={inputEl}
        class="fi-input {inputClass}"
        type="text"
        {value}
        {readonly}
        oninput={(e) => {
            const t = /** @type {HTMLInputElement} */ (e.target);
            syncScroll(t.scrollLeft || 0);
            onInput?.(t.value, t.selectionStart, t.selectionEnd);
        }}
        onselect={(e) => {
            const t = /** @type {HTMLInputElement} */ (e.target);
            syncScroll(t.scrollLeft || 0);
            onSelect?.(t.selectionStart, t.selectionEnd);
        }}
        onscroll={(e) => syncScroll(/** @type {HTMLInputElement} */ (e.target).scrollLeft || 0)}
        onkeyup={(e) =>  syncScroll(/** @type {HTMLInputElement} */ (e.target).scrollLeft || 0)}
        onkeydown={onKeydown}
        onblur={onBlur}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
    />
    {#if isFormula}
        <div
            class="fi-overlay"
            class:fi-overlay--scrollable={scrollable}
            aria-hidden="true"
            bind:this={overlayEl}
        >
            <span class="fi-overlay-text">
                {#each segments as seg}
                    {#if seg.color}
                        <span style="color:{seg.color};">{seg.text}</span>
                    {:else if seg.type === 'FUNCTION'}
                        <span class="fi-function">{seg.text}</span>
                    {:else}
                        <span>{seg.text}</span>
                    {/if}
                {/each}
            </span>
        </div>
        <FormulaValuePopup formula={value} visible={true} />
    {/if}
</div>

<style>
    .formula-input-root {
        position: relative;
        display: block;
        width: 100%;
        height: 100%;
    }

    .fi-input {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        margin: 0;
        border: none;
        outline: none;
        background: transparent;
        font: inherit;
        color: inherit;
        padding: 0;
        line-height: inherit;
        letter-spacing: inherit;
        position: relative;
        z-index: 2;
    }

    /* When showing the overlay, make the real input text invisible but keep the caret */
    .is-formula .fi-input {
        color: transparent;
        background: transparent;
        caret-color: var(--text-color, #1e293b);
    }

    .fi-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        box-sizing: border-box;
        font: inherit;
        color: var(--text-color, #1e293b);
        background: var(--input-bg, #ffffff);
        padding: 0;
        line-height: inherit;
        letter-spacing: inherit;
        z-index: 1;
        display: flex;
        align-items: center;
        overflow: hidden;
    }

    .fi-overlay--scrollable {
        overflow-x: scroll;
        overflow-y: hidden;
        scrollbar-width: none;
    }

    .fi-overlay--scrollable::-webkit-scrollbar { display: none; }

    .fi-overlay-text {
        white-space: pre;
        display: inline-block;
        line-height: inherit;
        flex-shrink: 0;
    }

    .fi-function {
        color: var(--function-color, #7c3aed);
    }
</style>
