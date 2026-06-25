<script>
    /**
     * DocWorkspace — Document editor workspace (overhauled).
     * Full-featured: ruler, status bar, find/replace, floating toolbar, tables,
     * checklists, zoom, paginated/pageless view modes.
     */
    import { onMount, onDestroy } from 'svelte';
    import { EditorState } from 'prosemirror-state';
    import { EditorView } from 'prosemirror-view';
    import { keymap } from 'prosemirror-keymap';
    import { baseKeymap } from 'prosemirror-commands';
    import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
    import { dropCursor } from 'prosemirror-dropcursor';
    import { gapCursor } from 'prosemirror-gapcursor';
    import { tableEditing, columnResizing, goToNextCell } from 'prosemirror-tables';
    import {
        ySyncPlugin, yCursorPlugin, yUndoPlugin,
        undo, redo,
    } from 'y-prosemirror';

    import { docSchema as schema } from '../../stores/docs/docSchema.js';
    import {
        buildInputRules,
        toggleBold, toggleItalic, toggleUnderline,
    } from '../../stores/docs/docCommands.js';
    import { buildFindPlugin } from '../../stores/docs/docFindPlugin.js';
    import { docSession, loadDoc, getDocSchemaVersion } from '../../stores/docs/docStore.svelte.js';
    import { router } from '../../lib/router.svelte.js';
    import { authStore } from '../../stores/authStore.js';

    import DocToolbar from './DocToolbar.svelte';
    import DocRuler from './DocRuler.svelte';
    import DocStatusBar from './DocStatusBar.svelte';
    import DocFindReplace from './DocFindReplace.svelte';
    import DocFloatingToolbar from './DocFloatingToolbar.svelte';
    import DocPageSetupPanel from './DocPageSetupPanel.svelte';
    import HistoryPanel from '../history/HistoryPanel.svelte';
    import HistoryViewer from '../history/HistoryViewer.svelte';
    import { HistoryManager } from '../../lib/history/HistoryManager.svelte.js';

    let { docId, registry = null } = $props();

    // ── Editor refs ───────────────────────────────────────────────────────────
    /** @type {HTMLElement} */ let editorMount = $state(null);
    /** @type {EditorView|null} */ let view    = $state.raw(null);
    let pmState = $state.raw(null);

    // ── UI state ──────────────────────────────────────────────────────────────
    let isLoading       = $state(true);
    let error           = $state(null);
    let showHistory     = $state(false);
    let showPageSetup   = $state(false);
    let showFindReplace = $state(false);
    let showReplacePane = $state(false);
    let showRuler       = $state(true);
    let zoom            = $state(100);   // percent
    let viewMode        = $state('paginated'); // 'paginated' | 'pageless'

    let currentLoadedDocId = $state.raw(null);
    let isLoadInProgress   = false;

    // ── Auth awareness ────────────────────────────────────────────────────────
    let awareness   = $derived(docSession.awareness);
    let currentUser = $derived($authStore.user?.username ?? '');

    function userColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++)
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return `hsl(${Math.abs(hash) % 360}, 70%, 50%)`;
    }

    // ── Load ──────────────────────────────────────────────────────────────────
    async function loadDocument(id) {
        if (!id || isLoadInProgress) return;
        if (currentLoadedDocId === id && !error) return;
        isLoadInProgress = true;
        isLoading = true;
        error = null;
        try {
            await loadDoc(id);
            currentLoadedDocId = id;
        } catch (e) {
            console.error('[DocWorkspace] load error', e);
            error = e.message;
        } finally {
            isLoading = false;
            isLoadInProgress = false;
        }
    }

    // ── Check-list node view ──────────────────────────────────────────────────
    function makeCheckListItemView(node, editorView, getPos) {
        const dom = document.createElement('li');
        dom.className = 'check-list-item';
        dom.dataset.checked = node.attrs.checked ? 'true' : 'false';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'check-box';
        checkbox.checked = node.attrs.checked;
        checkbox.contentEditable = 'false';
        checkbox.addEventListener('change', () => {
            const pos = getPos();
            if (pos == null) return;
            editorView.dispatch(
                editorView.state.tr.setNodeMarkup(pos, null, {
                    ...node.attrs,
                    checked: checkbox.checked,
                })
            );
        });

        const content = document.createElement('span');
        content.className = 'check-content';

        dom.appendChild(checkbox);
        dom.appendChild(content);

        return {
            dom,
            contentDOM: content,
            update(updatedNode) {
                if (updatedNode.type !== node.type) return false;
                dom.dataset.checked = updatedNode.attrs.checked ? 'true' : 'false';
                checkbox.checked = updatedNode.attrs.checked;
                return true;
            },
        };
    }

    // ── Mount ProseMirror ─────────────────────────────────────────────────────
    // Tracks which XmlFragment the live view is bound to. After a snapshot
    // restore, docSession.reload() swaps in a fresh ydoc (new fragment +
    // awareness); we detect the identity change and rebuild the view.
    let boundFragment = null;

    $effect(() => {
        const fragment = docSession.fragment;
        if (!fragment || !editorMount || isLoading) return;
        if (view && boundFragment === fragment) return;
        // Fragment swapped under us (restore) — tear the stale view down first.
        if (view && boundFragment !== fragment) {
            view.destroy();
            view = null;
            pmState = null;
        }

        const aw = docSession.awareness;
        if (aw) {
            aw.setLocalStateField('user', {
                name: currentUser,
                color: userColor(currentUser),
            });
        }

        const plugins = [
            ySyncPlugin(fragment),
            ...(aw ? [yCursorPlugin(aw)] : []),
            yUndoPlugin(),
            buildInputRules(),
            buildFindPlugin(),
            columnResizing(),
            tableEditing(),
            keymap({
                'Mod-z': undo,
                'Mod-y': redo,
                'Mod-Shift-z': redo,
                'Mod-b': toggleBold,
                'Mod-i': toggleItalic,
                'Mod-u': toggleUnderline,
                'Mod-k': () => {
                    triggerLinkDialog?.();
                    return true;
                },
                'Mod-f': () => {
                    showFindReplace = true;
                    return true;
                },
                'Mod-h': () => {
                    showFindReplace = true;
                    showReplacePane = true;
                    return true;
                },
                // Tab: table first, then list indent
                Tab: (state, dispatch, v) => {
                    if (goToNextCell(1)(state, dispatch, v)) return true;
                    return sinkListItem(schema.nodes.list_item)(state, dispatch, v) ||
                           sinkListItem(schema.nodes.check_list_item)(state, dispatch, v);
                },
                'Shift-Tab': (state, dispatch, v) => {
                    if (goToNextCell(-1)(state, dispatch, v)) return true;
                    return liftListItem(schema.nodes.list_item)(state, dispatch, v) ||
                           liftListItem(schema.nodes.check_list_item)(state, dispatch, v);
                },
                // Enter in lists / check lists
                Enter: (state, dispatch, v) => {
                    return splitListItem(schema.nodes.check_list_item)(state, dispatch, v) ||
                           splitListItem(schema.nodes.list_item)(state, dispatch, v);
                },
            }),
            keymap(baseKeymap),
            dropCursor(),
            gapCursor(),
        ];

        const editorView = new EditorView(editorMount, {
            state: EditorState.create({ schema, plugins }),
            // Read-only when the doc was written under a newer schema than this
            // client knows (see prepareDocForUse). Blocks typing/DOM input.
            editable: () => !docSession.readOnly,
            nodeViews: {
                check_list_item: (node, v, getPos) => makeCheckListItemView(node, v, getPos),
            },
            dispatchTransaction(tr) {
                // 'this' is the EditorView instance at runtime; cast to avoid TS error.
                // We cannot use the editorView closure variable because y-prosemirror
                // fires a sync transaction synchronously during EditorView construction,
                // before the assignment `const editorView = new EditorView(...)` completes.
                const v = /** @type {any} */ (this);
                // Read-only enforcement: swallow any local doc-changing transaction
                // (toolbar command, paste, programmatic edit) so a stale client can
                // never corrupt a newer-schema doc. Remote y-sync transactions and
                // selection-only changes still apply.
                if (docSession.readOnly && tr.docChanged && !tr.getMeta('y-sync$')) {
                    return;
                }
                const newState = v.state.apply(tr);
                v.updateState(newState);
                pmState = newState;
                if (tr.docChanged && !tr.getMeta('y-sync$')) {
                    docSession.touchUpdatedAt();
                }
            },
        });
        view = editorView;
        pmState = editorView.state;
        boundFragment = fragment;
    });

    // ── Ctrl+F global handler (catches when editor not focused) ───────────────
    function handleGlobalKeydown(/** @type {KeyboardEvent} */ e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            // Only intercept if the document editor is visible
            if (!isLoading && !error) {
                e.preventDefault();
                showFindReplace = true;
            }
        }
        if (e.key === 'Escape' && showFindReplace) {
            showFindReplace = false;
        }
    }

    // ── Link dialog callback ──────────────────────────────────────────────────
    let triggerLinkDialog = $state(null); // set by DocToolbar via bind

    // ── Cleanup ───────────────────────────────────────────────────────────────
    // ── History ───────────────────────────────────────────────────────────────
    let historyManager = $state(/** @type {HistoryManager|null} */ (null));

    $effect(() => {
        const ydoc = docSession.ydoc;
        if (!ydoc || !registry || !docId) return;
        const hm = new HistoryManager({
            fileId: docId,
            registry,
            appType: 'docs',
            // After a restore the runtime swaps in the restored doc; reload the
            // session so observers/metadata rebind, and the mount effect rebuilds
            // the editor against the new fragment.
            onAfterRestore: () => docSession.reload(),
            getSchemaVersion: () => getDocSchemaVersion(),
        });
        historyManager = hm;
        hm.loadSnapshots();
        const unsubFileMeta = registry.subscribeFileMeta(docId, (meta) => hm.receiveFileMeta(meta));
        return () => unsubFileMeta();
    });

    function destroyView() {
        if (view) { view.destroy(); view = null; pmState = null; }
        boundFragment = null;
    }

    onMount(() => { if (docId) loadDocument(docId); });

    $effect(() => {
        if (docId && docId !== currentLoadedDocId && !isLoadInProgress) {
            destroyView();
            loadDocument(docId);
        }
    });

    onDestroy(() => { destroyView(); docSession.unload(); });

    function handleCloseDocument() {
        router.goBack({
            file: registry?.drive.getFile(docId),
            folderExists: (id) => registry?.drive.getFolder(id) != null,
        });
    }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="doc-workspace">
    {#if isLoading}
        <div class="loading-state">
            <div class="spinner"></div>
            <p>Loading document…</p>
        </div>
    {:else if error}
        <div class="error-state">
            <p class="error-text">Failed to load: {error}</p>
            <button class="retry-btn" onclick={() => loadDocument(docId)}>Retry</button>
        </div>
    {:else}
        <div class="workspace-outer">
            {#if showHistory && historyManager}
                <HistoryPanel
                    {historyManager}
                    onClose={() => { showHistory = false; }}
                />
            {/if}

            <div class="workspace-container">
                <!-- Lifecycle banners: read-only (newer schema) + transient notices -->
                {#if docSession.readOnly}
                    <div class="banner warn">
                        <span>{docSession.readOnlyReason}</span>
                        <button onclick={() => location.reload()}>Reload</button>
                    </div>
                {/if}
                {#each docSession.notices as n (n.id)}
                    <div class="banner {n.severity}">
                        <span>{n.message}</span>
                        <button onclick={() => docSession.dismissNotice(n.id)} aria-label="Dismiss">×</button>
                    </div>
                {/each}

                <!-- Toolbar (rows 1 & 2) -->
                <DocToolbar
                    {view}
                    editorState={pmState}
                    onClose={handleCloseDocument}
                    {awareness}
                    {currentUser}
                    onShowHistory={registry ? () => { showHistory = true; } : undefined}
                    onShowPageSetup={() => { showPageSetup = true; }}
                    onToggleFind={() => { showFindReplace = !showFindReplace; }}
                    onToggleRuler={() => { showRuler = !showRuler; }}
                    {registry}
                    ontriggerlinkdialog={(fn) => { triggerLinkDialog = fn; }}
                />

                <!-- Find & Replace panel -->
                {#if showFindReplace}
                    <DocFindReplace
                        {view}
                        onClose={() => { showFindReplace = false; }}
                        showReplace={showReplacePane}
                    />
                {/if}

                <!-- Horizontal ruler -->
                {#if showRuler}
                    <DocRuler {zoom} {viewMode} />
                {/if}

                <!-- Editor scroll area -->
                <div
                    class="editor-scroll"
                    class:pageless={viewMode === 'pageless'}
                >
                    <div class="page-outer" style="zoom:{zoom / 100}">
                        <div
                            class="page"
                            class:page--pageless={viewMode === 'pageless'}
                            bind:this={editorMount}
                        ></div>
                    </div>
                </div>

                <!-- Status bar -->
                <DocStatusBar
                    editorState={pmState}
                    editorMount={editorMount}
                    bind:zoom
                    bind:viewMode
                />
            </div>
        </div>

        <!-- Floating contextual toolbar (portal, fixed position) -->
        <DocFloatingToolbar {view} editorState={pmState} />
    {/if}
</div>

{#if showPageSetup}
    <DocPageSetupPanel onclose={() => { showPageSetup = false; }} />
{/if}

{#if historyManager?.viewerOpen}
    <HistoryViewer
        {historyManager}
        currentDoc={docSession.ydoc ?? null}
    />
{/if}

<style>
    .doc-workspace {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        min-height: 0;
        overflow: hidden;
        background: var(--color-bg, #fafafa);
    }

    /* ── Loading / Error ── */
    .loading-state,
    .error-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        gap: 1rem;
    }

    .spinner {
        width: 36px;
        height: 36px;
        border: 3px solid var(--color-fill);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .error-text { color: var(--color-error, #ef4444); }
    .retry-btn {
        padding: 7px 16px;
        background: var(--color-primary);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
    }

    /* ── Lifecycle banners ── */
    .banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 14px;
        font-size: 13px;
        line-height: 1.4;
        border-bottom: 1px solid transparent;
    }
    .banner.warn {
        background: #fff4e5;
        color: #7a4f01;
        border-bottom-color: #f4d8a8;
    }
    .banner.info {
        background: #e8f1ff;
        color: #1c4e80;
        border-bottom-color: #bcd6f5;
    }
    .banner button {
        flex-shrink: 0;
        padding: 3px 10px;
        background: rgba(0, 0, 0, 0.06);
        border: 1px solid rgba(0, 0, 0, 0.12);
        border-radius: 5px;
        cursor: pointer;
        font-size: 12px;
        color: inherit;
    }
    .banner button:hover { background: rgba(0, 0, 0, 0.12); }

    /* ── Workspace layout ── */
    .workspace-outer {
        display: flex;
        flex-direction: row;
        height: 100%;
        overflow: hidden;
        min-height: 0;
    }

    .workspace-container {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
        min-height: 0;
    }

    /* ── Editor scroll ── */
    .editor-scroll {
        flex: 1;
        overflow-y: auto;
        overflow-x: auto;
        background: #e8eaed;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 32px 24px 48px;
        min-height: 0;
        scroll-behavior: smooth;
    }

    .editor-scroll.pageless {
        background: var(--color-surface, #fff);
        padding: 24px 20px;
    }

    /* Outer container that receives CSS zoom — zoom affects layout */
    .page-outer {
        width: 816px;
        transform-origin: top center;
    }

    /* ── Page card (paginated) ── */
    .page {
        background: white;
        box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 4px 16px rgba(0,0,0,.08);
        border-radius: 2px;
        padding: 96px;
        min-height: 1056px;
        color: #1a1a1a;
        font-family: Arial, sans-serif;
        font-size: 11pt;
        line-height: 1.6;
        word-wrap: break-word;
        position: relative;
        box-sizing: border-box;
    }

    /* ── Pageless mode ── */
    .page--pageless {
        min-height: 0;
        padding: 32px 96px;
        box-shadow: none;
        border-radius: 0;
        border-bottom: 1px solid var(--color-border);
    }

    @media (max-width: 680px) {
        .page { padding: 48px 32px; }
        .editor-scroll { padding: 16px 0; }
        .page-outer { width: 100%; }
    }

    /* ── ProseMirror base ── */
    :global(.ProseMirror) {
        outline: none;
        min-height: 100%;
    }
    :global(.ProseMirror p)  { margin: 0 0 0.5em; }
    :global(.ProseMirror h1) { font-size: 2em;     font-weight: 700; margin: 0.67em 0 0.3em; }
    :global(.ProseMirror h2) { font-size: 1.5em;   font-weight: 600; margin: 0.75em 0 0.3em; }
    :global(.ProseMirror h3) { font-size: 1.25em;  font-weight: 600; margin: 0.83em 0 0.3em; }
    :global(.ProseMirror h4) { font-size: 1em;     font-weight: 600; margin: 1em 0 0.3em; }
    :global(.ProseMirror h5) { font-size: .875em;  font-weight: 600; margin: 1em 0 0.3em; }
    :global(.ProseMirror h6) { font-size: .8em;    font-weight: 600; margin: 1em 0 0.3em; }
    :global(.ProseMirror ul) { padding-left: 2em; margin: .5em 0; }
    :global(.ProseMirror ol) { padding-left: 2em; margin: .5em 0; }
    :global(.ProseMirror li p) { margin: 0; }
    :global(.ProseMirror blockquote) {
        border-left: 3px solid #c0c8d4;
        padding-left: 1em;
        margin: .5em 0;
        color: #5a6478;
        font-style: italic;
    }
    :global(.ProseMirror pre) {
        background: #f5f7fa;
        border: 1px solid #e2e8f0;
        border-radius: 5px;
        padding: 12px 16px;
        font-family: 'Courier New', monospace;
        font-size: .9em;
        overflow-x: auto;
        margin: .5em 0;
    }
    :global(.ProseMirror code) {
        background: #f0f4f8;
        border: 1px solid #e2e8f0;
        border-radius: 3px;
        padding: .1em .35em;
        font-family: 'Courier New', monospace;
        font-size: .88em;
    }
    :global(.ProseMirror hr) {
        border: none;
        border-top: 2px solid #e2e8f0;
        margin: 1.25em 0;
    }
    :global(.ProseMirror img) { max-width: 100%; height: auto; }
    :global(.ProseMirror a)   { color: #0066cc; text-decoration: underline; }
    :global(.ProseMirror a:hover) { color: #0044aa; }

    /* ── Subscript / Superscript ── */
    :global(.ProseMirror sup) { font-size: 0.75em; vertical-align: super; line-height: 0; }
    :global(.ProseMirror sub) { font-size: 0.75em; vertical-align: sub;   line-height: 0; }

    /* ── Tables ── */
    :global(.ProseMirror table) {
        border-collapse: collapse;
        margin: 1em 0;
        width: 100%;
        table-layout: fixed;
        overflow: hidden;
    }
    :global(.ProseMirror td, .ProseMirror th) {
        border: 1px solid #c6c6c8;
        padding: 7px 12px;
        min-width: 50px;
        vertical-align: top;
        box-sizing: border-box;
        position: relative;
    }
    :global(.ProseMirror th) {
        background: #f2f5f9;
        font-weight: 600;
        text-align: left;
    }
    :global(.ProseMirror td > *, .ProseMirror th > *) { margin: 0; }
    /* selected cell */
    :global(.ProseMirror .selectedCell:after) {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(0, 122, 255, 0.12);
        pointer-events: none;
    }
    /* column resize handle */
    :global(.ProseMirror .column-resize-handle) {
        position: absolute;
        right: -2px;
        top: 0;
        bottom: 0;
        width: 4px;
        background: #007AFF;
        cursor: col-resize;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.15s;
    }
    :global(.ProseMirror td:hover .column-resize-handle,
            .ProseMirror th:hover .column-resize-handle) {
        opacity: 1;
    }
    :global(.resize-cursor) { cursor: col-resize !important; }

    /* ── Check lists ── */
    :global(.ProseMirror .check-list) {
        list-style: none;
        padding-left: 0.5em;
        margin: .5em 0;
    }
    :global(.ProseMirror .check-list-item) {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 1px 0;
    }
    :global(.ProseMirror .check-list-item .check-box) {
        width: 15px;
        height: 15px;
        margin-top: 3px;
        flex-shrink: 0;
        cursor: pointer;
        accent-color: var(--color-primary, #007AFF);
    }
    :global(.ProseMirror .check-list-item[data-checked="true"] .check-content) {
        color: #888;
        text-decoration: line-through;
    }
    :global(.ProseMirror .check-content) { flex: 1; min-width: 0; }

    /* ── Find matches ── */
    :global(.find-match) {
        background: rgba(255, 220, 0, 0.5);
        border-radius: 2px;
    }
    :global(.find-match-active) {
        background: rgba(255, 140, 0, 0.6);
        outline: 1px solid #ff8c00;
        border-radius: 2px;
    }

    /* ── Gap cursor ── */
    :global(.ProseMirror-gapcursor) {
        display: none;
        pointer-events: none;
        position: absolute;
    }
    :global(.ProseMirror-gapcursor:after) {
        content: '';
        display: block;
        position: absolute;
        top: -2px;
        width: 20px;
        border-top: 1px solid black;
        animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite;
    }
    @keyframes ProseMirror-cursor-blink { to { visibility: hidden; } }

    /* ── Yjs cursors ── */
    :global(.ProseMirror-yjs-cursor) {
        position: relative;
        margin-left: -1px;
        margin-right: -1px;
        border-left: 2px solid;
        word-break: normal;
        pointer-events: none;
    }
    :global(.ProseMirror-yjs-cursor > div) {
        position: absolute;
        top: -1.4em;
        left: -2px;
        font-size: 11px;
        background-color: currentColor;
        font-family: system-ui, sans-serif;
        font-style: normal;
        font-weight: 600;
        line-height: 1.4;
        user-select: none;
        color: white;
        padding: 0 4px;
        border-radius: 3px 3px 3px 0;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.2s;
    }
    :global(.ProseMirror-yjs-cursor:hover > div) { opacity: 1; }

    /* ── Print ── */
    @media print {
        .doc-workspace { background: white !important; }
        .editor-scroll { padding: 0 !important; background: white !important; }
        .page {
            box-shadow: none !important;
            border-radius: 0 !important;
            min-height: auto !important;
        }
    }
</style>
