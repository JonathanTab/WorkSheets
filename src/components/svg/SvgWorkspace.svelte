<script>
    /**
     * SvgWorkspace — top-level container for the SVG drawing editor.
     * Mirrors the structure of SpreadsheetWorkspace and DocWorkspace.
     */
    import { onMount, onDestroy } from 'svelte';
    import { svgSession, loadSvgFile } from '../../stores/svg/svgStore.svelte.js';
    import { svgEditorState } from '../../stores/svg/svgEditorState.svelte.js';
    import { router } from '../../lib/router.svelte.js';
    import SvgEditor from './SvgEditor.svelte';
    import SvgMenuBar from './SvgMenuBar.svelte';
    import SvgDrawingToolbar from './SvgDrawingToolbar.svelte';
    import FillStrokePanel from './panels/FillStrokePanel.svelte';
    import TextFontPanel from './panels/TextFontPanel.svelte';
    import AlignPanel from './panels/AlignPanel.svelte';
    import LayersPanel from './panels/LayersPanel.svelte';
    import ExportPanel from './panels/ExportPanel.svelte';
    import DocumentPropertiesPanel from './panels/DocumentPropertiesPanel.svelte';
    import AttributeEditorPanel from './panels/AttributeEditorPanel.svelte';

    let { docId, registry = null } = $props();

    let isSaving = $state(false);
    let currentLoadedDocId = $state.raw(null);
    let isLoadInProgress = false;
    let docPropsOpen = $state(false);

    // ── Load ──────────────────────────────────────────────────────────────────

    async function loadDocument(id) {
        if (!id || isLoadInProgress) return;
        if (currentLoadedDocId === id && !svgSession.error) return;

        isLoadInProgress = true;
        try {
            await loadSvgFile(id);
            currentLoadedDocId = id;
            if (svgSession.svgContent) {
                svgEditorState.loadFromString(svgSession.svgContent);
            }
        } catch (e) {
            console.error('[SvgWorkspace] load error', e);
        } finally {
            isLoadInProgress = false;
        }
    }

    // ── Save ──────────────────────────────────────────────────────────────────

    async function handleSave() {
        if (isSaving) return;
        isSaving = true;
        try {
            const svgString = svgEditorState.getSvgString();
            await svgSession.save(svgString);
        } catch (e) {
            console.error('[SvgWorkspace] save error', e);
        } finally {
            isSaving = false;
        }
    }

    // Ctrl+S handled in SvgEditor keyboard handler; also wire at workspace level
    function handleKeydown(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            handleSave();
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    onMount(() => {
        if (docId) loadDocument(docId);
        window.addEventListener('keydown', handleKeydown);
    });

    $effect(() => {
        if (docId && docId !== currentLoadedDocId && !isLoadInProgress) {
            svgSession.unload();
            loadDocument(docId);
        }
    });

    onDestroy(() => {
        window.removeEventListener('keydown', handleKeydown);
        svgSession.unload();
    });
</script>

<div class="svg-workspace">
    {#if svgSession.isLoading}
        <div class="loading-state">
            <div class="spinner"></div>
            <p>Loading drawing…</p>
        </div>
    {:else if svgSession.error}
        <div class="error-state">
            <p class="error-text">Failed to load: {svgSession.error}</p>
            <button class="retry-btn" onclick={() => loadDocument(docId)}>Retry</button>
        </div>
    {:else if svgSession.svgContent !== null}
        <div class="workspace-container">
            <!-- Row 1: title + menus + save -->
            <SvgMenuBar
                {isSaving}
                onClose={() => router.goBack()}
                onSave={handleSave}
                onToggleDocProps={() => (docPropsOpen = !docPropsOpen)}
            />
            <!-- Row 2: drawing tools + context options -->
            <SvgDrawingToolbar />
            <!-- Body: canvas + right sidebar -->
            <div class="workspace-body">
                <div class="editor-area">
                    <SvgEditor onChanged={() => svgSession.markDirty()} />
                </div>
                <aside class="right-sidebar">
                    {#if docPropsOpen}
                        <DocumentPropertiesPanel />
                    {/if}
                    <FillStrokePanel />
                    <TextFontPanel />
                    <AlignPanel />
                    <AttributeEditorPanel />
                    <LayersPanel />
                    <ExportPanel />
                </aside>
            </div>
        </div>
    {/if}
</div>

<style>
    .svg-workspace {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
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
        color: var(--color-text-secondary, #888);
    }

    .spinner {
        border: 3px solid #333;
        border-top: 3px solid #f97316;
        border-radius: 50%;
        width: 36px;
        height: 36px;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .error-text { color: var(--color-error, #ef4444); }

    .retry-btn {
        padding: 8px 16px;
        background: var(--color-accent, #4f46e5);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
    }

    .workspace-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        overflow: hidden;
    }

    .workspace-body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: row;
        overflow: hidden;
    }

    .editor-area {
        flex: 1;
        overflow: hidden;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .right-sidebar {
        width: 260px;
        flex-shrink: 0;
        background: var(--color-surface, #12122a);
        border-left: 1px solid var(--color-border, #2a2a4a);
        overflow-y: auto;
        overflow-x: hidden;
        display: flex;
        flex-direction: column;
    }

    .right-sidebar::-webkit-scrollbar { width: 4px; }
    .right-sidebar::-webkit-scrollbar-thumb { background: var(--color-border, #333); border-radius: 2px; }
</style>
