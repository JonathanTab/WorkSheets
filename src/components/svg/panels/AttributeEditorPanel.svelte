<script>
    import { svgEditorState } from '../../../stores/svg/svgEditorState.svelte.js';

    let open = $state(false); // collapsed by default (advanced panel)

    const sel = $derived(svgEditorState.firstSelected);

    // Get raw attribute map for selected node. Re-computes when selection or model changes.
    const rawAttrs = $derived.by(() => {
        if (!sel) return {};
        // Trigger reactivity on svgDocument changes via pushHistory
        void svgEditorState.svgDocument;
        return svgEditorState.getNodeAttributes(sel.id);
    });

    // Editable list of [key, value] entries, sorted by key
    const attrEntries = $derived(
        Object.entries(rawAttrs).sort((a, b) => a[0].localeCompare(b[0]))
    );

    function isNamespaced(key) {
        return key.includes(':');
    }

    function onValueBlur(e, key) {
        if (!sel) return;
        const val = e.currentTarget.value;
        if (val !== rawAttrs[key]) {
            svgEditorState.setNodeAttributeRaw(sel.id, key, val);
            svgEditorState.pushHistory();
        }
    }

    function onKeydown(e, key) {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
            e.currentTarget.value = rawAttrs[key] ?? '';
            e.currentTarget.blur();
        }
    }

    function removeAttr(key) {
        if (!sel) return;
        svgEditorState.setNodeAttributeRaw(sel.id, key, null);
        svgEditorState.pushHistory();
    }

    // Add new attribute
    let newKey = $state('');
    let newVal = $state('');

    function addAttr() {
        if (!sel || !newKey.trim()) return;
        svgEditorState.setNodeAttributeRaw(sel.id, newKey.trim(), newVal);
        svgEditorState.pushHistory();
        newKey = '';
        newVal = '';
    }

    function onAddKeydown(e) {
        if (e.key === 'Enter') addAttr();
    }
</script>

<section class="panel-section">
    <button class="panel-hdr" onclick={() => (open = !open)}>
        <span>Attributes</span>
        <span class="chevron" class:rotated={!open}>▾</span>
    </button>

    {#if open}
        <div class="panel-body">
            {#if !sel}
                <p class="hint">Select an element to inspect its attributes.</p>
            {:else}
                <table class="attr-table">
                    <tbody>
                        {#each attrEntries as [key, val] (key)}
                            <tr class:namespaced={isNamespaced(key)}>
                                <td class="key-cell" title={key}>{key}</td>
                                <td class="val-cell">
                                    <input
                                        class="val-input"
                                        type="text"
                                        value={val}
                                        onblur={(e) => onValueBlur(e, key)}
                                        onkeydown={(e) => onKeydown(e, key)}
                                    />
                                </td>
                                <td class="del-cell">
                                    <button class="del-btn" onclick={() => removeAttr(key)} title="Remove">×</button>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>

                <!-- Add new attribute row -->
                <div class="add-row">
                    <input
                        class="add-input key-add"
                        type="text"
                        placeholder="key"
                        bind:value={newKey}
                        onkeydown={onAddKeydown}
                    />
                    <input
                        class="add-input val-add"
                        type="text"
                        placeholder="value"
                        bind:value={newVal}
                        onkeydown={onAddKeydown}
                    />
                    <button class="add-btn" onclick={addAttr} title="Add attribute">+</button>
                </div>
            {/if}
        </div>
    {/if}
</section>

<style>
    .panel-section {
        border-bottom: 1px solid var(--color-border, #333);
    }
    .panel-hdr {
        width: 100%; display: flex; justify-content: space-between; align-items: center;
        padding: 7px 10px; background: none; border: none; cursor: pointer;
        color: var(--color-text, #fff); font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.05em;
    }
    .panel-hdr:hover { background: var(--color-fill, rgba(255,255,255,0.05)); }
    .chevron { transition: transform 0.15s; font-size: 13px; }
    .chevron.rotated { transform: rotate(-90deg); }
    .panel-body { padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 4px; }
    .hint { font-size: 11px; color: var(--color-text-secondary, #888); margin: 0; }

    .attr-table { width: 100%; border-collapse: collapse; }
    .attr-table tr { border-bottom: 1px solid var(--color-border-subtle, #2a2a2a); }
    .attr-table tr.namespaced .key-cell { color: var(--color-text-secondary, #888); }
    .key-cell {
        font-size: 10px; font-family: monospace; color: var(--color-text, #ccc);
        padding: 3px 4px 3px 0; white-space: nowrap; max-width: 90px;
        overflow: hidden; text-overflow: ellipsis; vertical-align: middle;
    }
    .val-cell { width: 100%; vertical-align: middle; }
    .val-input {
        width: 100%; box-sizing: border-box; height: 20px; padding: 0 4px;
        background: transparent; border: 1px solid transparent;
        border-radius: 2px; color: var(--color-text, #fff); font-size: 10px; font-family: monospace;
    }
    .val-input:hover { border-color: var(--color-border, #333); }
    .val-input:focus { outline: none; background: var(--color-input-bg, #1a1a1a); border-color: #4f8ef7; }
    .del-cell { vertical-align: middle; }
    .del-btn {
        background: none; border: none; color: var(--color-text-secondary, #666);
        cursor: pointer; font-size: 13px; padding: 0 2px; line-height: 1;
    }
    .del-btn:hover { color: #ef4444; }

    .add-row { display: flex; gap: 4px; margin-top: 6px; }
    .add-input {
        height: 22px; padding: 0 4px; font-size: 10px; font-family: monospace;
        background: var(--color-input-bg, #1e1e1e); border: 1px solid var(--color-border, #333);
        border-radius: 3px; color: var(--color-text, #fff);
    }
    .key-add { width: 70px; flex-shrink: 0; }
    .val-add { flex: 1; min-width: 0; }
    .add-btn {
        height: 22px; width: 22px; background: none; border: 1px solid var(--color-border, #333);
        border-radius: 3px; color: var(--color-text-secondary, #888); font-size: 15px;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .add-btn:hover { background: var(--color-fill, rgba(255,255,255,0.08)); color: var(--color-text, #fff); }
</style>
