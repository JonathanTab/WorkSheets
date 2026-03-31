<script>
    /**
     * DocWorkspace — Document editor workspace.
     * Matches the structure of SpreadsheetWorkspace for consistent UX.
     */
    import { onMount, onDestroy } from "svelte";
    import { EditorState } from "prosemirror-state";
    import { EditorView } from "prosemirror-view";
    import { keymap } from "prosemirror-keymap";
    import { baseKeymap, toggleMark } from "prosemirror-commands";
    import {
        splitListItem,
        liftListItem,
        sinkListItem,
    } from "prosemirror-schema-list";
    import { dropCursor } from "prosemirror-dropcursor";
    import { gapCursor } from "prosemirror-gapcursor";
    import {
        ySyncPlugin,
        yCursorPlugin,
        yUndoPlugin,
        undo,
        redo,
    } from "y-prosemirror";

    import { docSchema as schema } from "../../stores/docs/docSchema.js";
    import {
        buildInputRules,
        toggleBold,
        toggleItalic,
        toggleUnderline,
        splitList,
    } from "../../stores/docs/docCommands.js";
    import { docSession, loadDoc } from "../../stores/docs/docStore.svelte.js";
    import { router } from "../../lib/router.svelte.js";
    import { authStore } from "../../stores/authStore.js";
    import DocToolbar from "./DocToolbar.svelte";
    import DocPageSetupPanel from "./DocPageSetupPanel.svelte";
    import HistoryPanel from "../HistoryPanel.svelte";

    let { docId, registry = null } = $props();

    // ── Editor state ─────────────────────────────────────────────────────────
    /** @type {HTMLElement} */ let editorMount = $state(null);
    /** @type {EditorView|null} */ let view = $state.raw(null);
    let pmState = $state.raw(null); // Mirrors view.state for toolbar reactivity

    let isLoading = $state(true);
    let error = $state(null);
    let showHistory = $state(false);
    let showPageSetup = $state(false);

    let currentLoadedDocId = $state.raw(null);
    let isLoadInProgress = false;

    // ── Auth awareness ────────────────────────────────────────────────────────
    let awareness = $derived(docSession.awareness);
    let currentUser = $derived($authStore.user?.username ?? "");

    // User color — deterministic from username
    function userColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++)
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        const h = Math.abs(hash) % 360;
        return `hsl(${h}, 70%, 50%)`;
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
            console.error("[DocWorkspace] load error", e);
            error = e.message;
        } finally {
            isLoading = false;
            isLoadInProgress = false;
        }
    }

    // ── Mount ProseMirror after doc is loaded ─────────────────────────────────
    $effect(() => {
        // Wait until fragment is ready
        const fragment = docSession.fragment;
        if (!fragment || !editorMount || isLoading) return;
        if (view) return; // Already mounted

        // Set awareness user info
        const aw = docSession.awareness;
        if (aw) {
            aw.setLocalStateField("user", {
                name: currentUser,
                color: userColor(currentUser),
            });
        }

        const plugins = [
            ySyncPlugin(fragment),
            ...(aw ? [yCursorPlugin(aw)] : []),
            yUndoPlugin(),
            buildInputRules(),
            keymap({
                "Mod-z": undo,
                "Mod-y": redo,
                "Mod-Shift-z": redo,
                "Mod-b": toggleBold,
                "Mod-i": toggleItalic,
                "Mod-u": toggleUnderline,
                Enter: splitListItem(schema.nodes.list_item),
                Tab: sinkListItem(schema.nodes.list_item),
                "Shift-Tab": liftListItem(schema.nodes.list_item),
            }),
            keymap(baseKeymap),
            dropCursor(),
            gapCursor(),
        ];

        const editorView = new EditorView(editorMount, {
            state: EditorState.create({ schema, plugins }),
            dispatchTransaction(tr) {
                // Use 'this' instead of 'editorView' to avoid TDZ error during construction
                const newState = this.state.apply(tr);
                this.updateState(newState);
                pmState = newState;
                // Touch doc-internal mtime on user edits
                if (tr.docChanged && !tr.getMeta("y-sync$")) {
                    docSession.touchUpdatedAt();
                }
            },
        });
        view = editorView;

        pmState = view.state;
    });

    // ── Cleanup ───────────────────────────────────────────────────────────────
    function destroyView() {
        if (view) {
            view.destroy();
            view = null;
            pmState = null;
        }
    }

    onMount(() => {
        if (docId) loadDocument(docId);
    });

    $effect(() => {
        if (docId && docId !== currentLoadedDocId && !isLoadInProgress) {
            destroyView();
            loadDocument(docId);
        }
    });

    onDestroy(() => {
        destroyView();
        docSession.unload();
    });

    function handleCloseDocument() {
        router.goHome();
    }
</script>

<div class="doc-workspace">
    {#if isLoading}
        <div class="loading-state">
            <div class="spinner"></div>
            <p>Loading document...</p>
        </div>
    {:else if error}
        <div class="error-state">
            <p class="error-text">Failed to load: {error}</p>
            <button class="retry-btn" onclick={() => loadDocument(docId)}>
                Retry
            </button>
        </div>
    {:else}
        <div class="workspace-outer">
            {#if showHistory && registry}
                <HistoryPanel
                    {registry}
                    fileId={docId}
                    currentDoc={docSession.ydoc ?? null}
                    onClose={() => {
                        showHistory = false;
                    }}
                />
            {/if}
            <div class="workspace-container">
                <!-- Toolbar (includes document name, menu bar, presence) -->
                <DocToolbar
                    {view}
                    editorState={pmState}
                    onClose={handleCloseDocument}
                    {awareness}
                    {currentUser}
                    onShowHistory={registry
                        ? () => {
                              showHistory = true;
                          }
                        : undefined}
                    onShowPageSetup={() => {
                        showPageSetup = true;
                    }}
                    {registry}
                />

                <!-- Main editor area -->
                <div class="editor-container">
                    <div class="page-container">
                        <div class="page" bind:this={editorMount}></div>
                    </div>
                </div>
            </div>
        </div>
    {/if}
</div>

{#if showPageSetup}
    <DocPageSetupPanel
        onclose={() => {
            showPageSetup = false;
        }}
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
        background: var(--color-bg, #0d0d1a);
    }

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
        border: 3px solid #f3f3f3;
        border-top: 3px solid #3498db;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .error-text {
        color: var(--color-error, #ef4444);
    }

    .retry-btn {
        padding: 8px 16px;
        background: var(--color-accent, #4f46e5);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
    }

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

    .editor-container {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        background: #f0f0f0;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 40px 20px;
    }

    .page-container {
        width: 100%;
        max-width: 816px; /* ~Letter width at 96dpi */
    }

    /* The actual ProseMirror editor inside a page card */
    .page {
        background: white;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        border-radius: 2px;
        padding: 96px 96px;
        min-height: 1056px; /* ~Letter height at 96dpi */
        color: #1a1a1a;
        font-family: Arial, sans-serif;
        font-size: 11pt;
        line-height: 1.6;
        word-wrap: break-word;
        position: relative;
    }

    @media (max-width: 680px) {
        .page {
            padding: 48px 32px;
        }
        .editor-container {
            padding: 20px 0;
        }
    }

    /* ── ProseMirror content styles ── */
    :global(.ProseMirror) {
        outline: none;
        min-height: 100%;
    }
    :global(.ProseMirror p) {
        margin: 0 0 0.5em;
    }
    :global(.ProseMirror h1) {
        font-size: 2em;
        font-weight: 700;
        margin: 0.67em 0 0.3em;
    }
    :global(.ProseMirror h2) {
        font-size: 1.5em;
        font-weight: 600;
        margin: 0.75em 0 0.3em;
    }
    :global(.ProseMirror h3) {
        font-size: 1.25em;
        font-weight: 600;
        margin: 0.83em 0 0.3em;
    }
    :global(.ProseMirror h4) {
        font-size: 1em;
        font-weight: 600;
        margin: 1em 0 0.3em;
    }
    :global(.ProseMirror h5) {
        font-size: 0.875em;
        font-weight: 600;
        margin: 1em 0 0.3em;
    }
    :global(.ProseMirror h6) {
        font-size: 0.8em;
        font-weight: 600;
        margin: 1em 0 0.3em;
    }
    :global(.ProseMirror ul) {
        padding-left: 2em;
        margin: 0.5em 0;
    }
    :global(.ProseMirror ol) {
        padding-left: 2em;
        margin: 0.5em 0;
    }
    :global(.ProseMirror li p) {
        margin: 0;
    }
    :global(.ProseMirror blockquote) {
        border-left: 3px solid #ccc;
        padding-left: 1em;
        margin: 0.5em 0;
        color: #555;
    }
    :global(.ProseMirror pre) {
        background: #f5f5f5;
        border-radius: 4px;
        padding: 12px 16px;
        font-family: monospace;
        font-size: 0.9em;
        overflow-x: auto;
        margin: 0.5em 0;
    }
    :global(.ProseMirror code) {
        background: #f0f0f0;
        border-radius: 3px;
        padding: 0.1em 0.3em;
        font-family: monospace;
        font-size: 0.9em;
    }
    :global(.ProseMirror hr) {
        border: none;
        border-top: 2px solid #ddd;
        margin: 1em 0;
    }
    :global(.ProseMirror img) {
        max-width: 100%;
    }
    :global(.ProseMirror a) {
        color: #4299e1;
        text-decoration: underline;
    }
    :global(.ProseMirror-gapcursor) {
        display: none;
        pointer-events: none;
        position: absolute;
    }
    :global(.ProseMirror-gapcursor:after) {
        content: "";
        display: block;
        position: absolute;
        top: -2px;
        width: 20px;
        border-top: 1px solid black;
        animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite;
    }
    @keyframes ProseMirror-cursor-blink {
        to {
            visibility: hidden;
        }
    }

    /* ── Y.js cursors ── */
    :global(.ProseMirror > .ProseMirror-yjs-cursor:first-child) {
        margin-top: 16px;
    }
    :global(.ProseMirror-yjs-cursor) {
        position: relative;
        margin-left: -1px;
        margin-right: -1px;
        border-left: 1px solid black;
        border-right: 1px solid black;
        border-color: orange;
        word-break: normal;
        pointer-events: none;
    }
    :global(.ProseMirror-yjs-cursor > div) {
        position: absolute;
        top: -1.05em;
        left: -1px;
        font-size: 13px;
        background-color: rgb(250, 129, 0);
        font-family: serif;
        font-style: normal;
        font-weight: normal;
        line-height: normal;
        user-select: none;
        color: white;
        padding: 0 2px;
        white-space: nowrap;
    }
</style>
