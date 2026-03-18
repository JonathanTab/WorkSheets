<script>
    import { storage } from "../stores/storage.js";
    import { openModal, closeTopModal } from "../lib/ui/modalStore.svelte.js";
    import Button from "../lib/ui/Button.svelte";
    import CreateDocumentModal from "./modals/CreateDocumentModal.svelte";
    import DeleteConfirmModal from "./modals/DeleteConfirmModal.svelte";
    import RenameDocumentModal from "./modals/RenameDocumentModal.svelte";
    import MoveFileModal from "./modals/MoveFileModal.svelte";
    import ShareFileModal from "./modals/ShareFileModal.svelte";
    import { spreadsheet, plus, trash, edit, arrowRight, moreVertical } from "../lib/icons/index.js";

    // --- Folder SVG (not in icons yet, inline it) ---
    const folderSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    const shareSvg  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
    const moveSvg   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`;
    const newFolderSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`;
    const clockSvg  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

    // ---- State ----
    let tab = $state("drive"); // "drive" | "shared" | "recent"
    let currentFolderId = $state(null); // null = root
    // App.svelte ensures storage.init() completes before DriveBrowser ever mounts,
    // so we can read the stores immediately and stay subscribed to updates.
    let driveFiles = $state(storage.drive.listFiles());
    let driveFolders = $state(storage.drive.listFolders());
    let searchQuery = $state("");
    let contextMenu = $state(null); // { x, y, item, type: 'file'|'folder' }
    let renamingFolderId = $state(null);
    let renameFolderValue = $state("");

    // Keep in sync with any subsequent changes (syncs, mutations, etc.)
    $effect(() => {
        const unsubs = [
            storage.drive.files.subscribe(f => { driveFiles = f; }),
            storage.drive.folders.subscribe(f => { driveFolders = f; }),
        ];
        return () => unsubs.forEach(u => u());
    });

    // ---- Current folder contents ----
    let folderContents = $derived.by(() => {
        if (tab === "shared") {
            const username = storage._options?.getUsername?.() ?? "";
            return {
                folders: driveFolders.filter(f => f.owner !== username && f.sharedWith?.some(s => s.username === username)),
                files:   driveFiles.filter(f => f.owner !== username && !f.deleted && f.sharedWith?.some(s => s.username === username)),
            };
        }
        if (tab === "recent") {
            return { folders: [], files: storage.drive.recentlyOpened(20) };
        }
        // drive tab
        return {
            folders: driveFolders.filter(f => f.parentId === currentFolderId),
            files:   driveFiles.filter(f => f.folderId === currentFolderId && !f.deleted && f.scope === "drive"),
        };
    });

    // Search filter applied on top
    let displayFolders = $derived(
        searchQuery.trim()
            ? folderContents.folders.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()))
            : folderContents.folders
    );
    let displayFiles = $derived(
        searchQuery.trim()
            ? folderContents.files.filter(f => f.title?.toLowerCase().includes(searchQuery.toLowerCase()))
            : folderContents.files
    );

    // ---- Breadcrumb ----
    let breadcrumb = $derived.by(() => {
        const crumbs = [];
        let id = currentFolderId;
        while (id) {
            const folder = driveFolders.find(f => f.id === id);
            if (!folder) break;
            crumbs.unshift({ id: folder.id, name: folder.name });
            id = folder.parentId;
        }
        return crumbs;
    });

    function navigateFolder(id) {
        currentFolderId = id;
        searchQuery = "";
    }

    // ---- File actions ----
    function openDocument(docId) {
        window.location.hash = docId;
    }

    function handleCreateDocument() {
        openModal(CreateDocumentModal, {
            onConfirm: async (title) => {
                try {
                    const doc = await storage.drive.createFile({ title, folderId: tab === "drive" ? currentFolderId : null });
                    closeTopModal();
                    openDocument(doc.id);
                } catch (e) {
                    console.error("Failed to create document:", e);
                }
            },
        });
    }

    async function handleCreateFolder() {
        const name = prompt("Folder name:");
        if (!name?.trim()) return;
        try {
            await storage.drive.createFolder({ name: name.trim(), parentId: tab === "drive" ? currentFolderId : null });
        } catch (e) {
            console.error("Failed to create folder:", e);
        }
    }

    function handleRenameFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(RenameDocumentModal, {
            currentTitle: file.title,
            onConfirm: async (newTitle) => {
                try {
                    await storage.drive.renameFile(file.id, newTitle);
                    closeTopModal();
                } catch (err) {
                    console.error("Failed to rename:", err);
                }
            },
        });
    }

    function handleDeleteFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(DeleteConfirmModal, {
            documentTitle: file.title || "this document",
            onConfirm: async () => {
                try {
                    await storage.drive.deleteFile(file.id);
                    closeTopModal();
                } catch (err) {
                    console.error("Failed to delete:", err);
                }
            },
        });
    }

    function handleMoveFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(MoveFileModal, {
            file,
            onConfirm: async (targetFolderId) => {
                try {
                    await storage.drive.moveFile(file.id, targetFolderId);
                    closeTopModal();
                } catch (err) {
                    console.error("Failed to move:", err);
                }
            },
        });
    }

    function handleShareFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(ShareFileModal, { file });
    }

    async function handleDeleteFolder(folder, e) {
        e?.stopPropagation();
        closeContextMenu();
        if (!confirm(`Delete folder "${folder.name}" and all its contents?`)) return;
        try {
            await storage.drive.deleteFolder(folder.id);
            if (currentFolderId === folder.id) currentFolderId = folder.parentId ?? null;
        } catch (err) {
            console.error("Failed to delete folder:", err);
        }
    }

    function startRenameFolder(folder, e) {
        e?.stopPropagation();
        closeContextMenu();
        renamingFolderId = folder.id;
        renameFolderValue = folder.name;
    }

    async function finishRenameFolder(folder) {
        const trimmed = renameFolderValue.trim();
        renamingFolderId = null;
        if (trimmed && trimmed !== folder.name) {
            await storage.drive.renameFolder(folder.id, trimmed).catch(console.error);
        }
    }

    // ---- Context menu ----
    function showContextMenu(e, item, type) {
        e.preventDefault();
        e.stopPropagation();
        contextMenu = { x: e.clientX, y: e.clientY, item, type };
    }

    function closeContextMenu() {
        contextMenu = null;
    }

    function handleWindowClick() {
        closeContextMenu();
    }

    // ---- Helpers ----
    function formatDate(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }

    function isOwned(item) {
        const username = storage._options?.getUsername?.() ?? "";
        return item.owner === username;
    }
</script>

<svelte:window onclick={handleWindowClick} />

<div class="drive-browser">
    <!-- Header -->
    <div class="header">
        <div class="header-left">
            <div class="app-title">
                <span class="app-icon">{@html spreadsheet}</span>
                <div>
                    <h1 class="text-xl font-bold">WorkSheets</h1>
                    <p class="text-text-muted text-xs">Collaborative Spreadsheets</p>
                </div>
            </div>
        </div>
        <div class="header-actions">
            {#if tab === "drive"}
                <Button onclick={handleCreateFolder} variant="secondary" size="sm" icon={newFolderSvg} iconPosition="left">
                    New Folder
                </Button>
            {/if}
            <Button onclick={handleCreateDocument} size="sm" icon={plus} iconPosition="left">
                New Spreadsheet
            </Button>
        </div>
    </div>

    <!-- Tabs + search row -->
    <div class="toolbar-row">
        <div class="tabs">
            <button class="tab-btn" class:active={tab === "drive"} onclick={() => { tab = "drive"; }}>
                {@html folderSvg} My Drive
            </button>
            <button class="tab-btn" class:active={tab === "shared"} onclick={() => { tab = "shared"; }}>
                {@html shareSvg} Shared with Me
            </button>
            <button class="tab-btn" class:active={tab === "recent"} onclick={() => { tab = "recent"; }}>
                {@html clockSvg} Recent
            </button>
        </div>
        <div class="search-wrap">
            <input
                class="search-input"
                type="search"
                placeholder="Search files…"
                bind:value={searchQuery}
            />
        </div>
    </div>

    <!-- Breadcrumb (drive tab only) -->
    {#if tab === "drive"}
        <div class="breadcrumb">
            <button class="crumb" onclick={() => navigateFolder(null)}>My Drive</button>
            {#each breadcrumb as crumb}
                <span class="crumb-sep">{@html arrowRight}</span>
                <button class="crumb" onclick={() => navigateFolder(crumb.id)}>{crumb.name}</button>
            {/each}
        </div>
    {/if}

    <!-- Content -->
    {#if displayFolders.length === 0 && displayFiles.length === 0}
        <div class="state-center">
            <div class="empty-icon">{@html spreadsheet}</div>
            {#if searchQuery}
                <p class="text-text-muted">No results for "{searchQuery}"</p>
            {:else if tab === "shared"}
                <p class="text-text-muted">Nothing shared with you yet</p>
            {:else if tab === "recent"}
                <p class="text-text-muted">No recently opened files</p>
            {:else}
                <h2 class="text-base font-medium mb-1">This folder is empty</h2>
                <p class="text-text-muted text-sm mb-4">Create a spreadsheet to get started</p>
                <Button onclick={handleCreateDocument} size="sm" icon={plus} iconPosition="left">
                    New Spreadsheet
                </Button>
            {/if}
        </div>
    {:else}
        <div class="content-grid">
            <!-- Folders first -->
            {#each displayFolders as folder (folder.id)}
                <div
                    class="item-card folder-card"
                    role="button"
                    tabindex="0"
                    onclick={() => navigateFolder(folder.id)}
                    onkeydown={(e) => e.key === "Enter" && navigateFolder(folder.id)}
                    oncontextmenu={(e) => showContextMenu(e, folder, "folder")}
                >
                    <div class="item-icon folder-icon">{@html folderSvg}</div>
                    {#if renamingFolderId === folder.id}
                        <input
                            class="rename-input"
                            bind:value={renameFolderValue}
                            onclick={(e) => e.stopPropagation()}
                            onblur={() => finishRenameFolder(folder)}
                            onkeydown={(e) => { if (e.key === "Enter") finishRenameFolder(folder); if (e.key === "Escape") renamingFolderId = null; }}
                            autofocus
                        />
                    {:else}
                        <span class="item-name">{folder.name}</span>
                    {/if}
                    <div class="item-actions" onclick={(e) => e.stopPropagation()}>
                        <button class="action-icon" title="More" onclick={(e) => showContextMenu(e, folder, "folder")}>{@html moreVertical}</button>
                    </div>
                </div>
            {/each}

            <!-- Files -->
            {#each displayFiles as file (file.id)}
                <div
                    class="item-card file-card"
                    role="button"
                    tabindex="0"
                    onclick={() => openDocument(file.id)}
                    onkeydown={(e) => e.key === "Enter" && openDocument(file.id)}
                    oncontextmenu={(e) => showContextMenu(e, file, "file")}
                >
                    <div class="item-icon file-icon">{@html spreadsheet}</div>
                    <span class="item-name">{file.title || "Untitled"}</span>
                    <span class="item-meta">
                        {isOwned(file) ? "Me" : (file.owner || "Shared")} · {formatDate(file.updatedAt)}
                    </span>
                    <div class="item-actions" onclick={(e) => e.stopPropagation()}>
                        <button class="action-icon" title="More" onclick={(e) => showContextMenu(e, file, "file")}>{@html moreVertical}</button>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>

<!-- Context menu -->
{#if contextMenu}
    <div
        class="context-menu"
        style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
        onclick={(e) => e.stopPropagation()}
    >
        {#if contextMenu.type === "file"}
            <button class="ctx-item" onclick={() => { openDocument(contextMenu.item.id); closeContextMenu(); }}>
                {@html arrowRight} Open
            </button>
            <button class="ctx-item" onclick={(e) => handleRenameFile(contextMenu.item, e)}>
                {@html edit} Rename
            </button>
            <button class="ctx-item" onclick={(e) => handleMoveFile(contextMenu.item, e)}>
                {@html moveSvg} Move to…
            </button>
            <button class="ctx-item" onclick={(e) => handleShareFile(contextMenu.item, e)}>
                {@html shareSvg} Share…
            </button>
            <hr class="ctx-sep" />
            <button class="ctx-item danger" onclick={(e) => handleDeleteFile(contextMenu.item, e)}>
                {@html trash} Delete
            </button>
        {:else}
            <button class="ctx-item" onclick={() => { navigateFolder(contextMenu.item.id); closeContextMenu(); }}>
                {@html arrowRight} Open
            </button>
            <button class="ctx-item" onclick={(e) => startRenameFolder(contextMenu.item, e)}>
                {@html edit} Rename
            </button>
            <hr class="ctx-sep" />
            <button class="ctx-item danger" onclick={(e) => handleDeleteFolder(contextMenu.item, e)}>
                {@html trash} Delete
            </button>
        {/if}
    </div>
{/if}

<style>
    .drive-browser {
        padding: 1.5rem 2rem;
        max-width: 1100px;
        margin: 0 auto;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: 0;
    }

    .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.25rem;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 1rem;
    }

    .app-title {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .app-icon {
        display: flex;
        align-items: center;
        width: 2rem;
        height: 2rem;
        color: var(--color-primary);
    }

    .header-actions {
        display: flex;
        gap: 0.5rem;
    }

    .toolbar-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 0.5rem;
    }

    .tabs {
        display: flex;
        gap: 0.25rem;
    }

    .tab-btn {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.375rem 0.75rem;
        border-radius: 8px;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.875rem;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
    }

    .tab-btn :global(svg) {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
    }

    .tab-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .tab-btn.active {
        background: var(--color-fill-secondary);
        color: var(--color-text);
        font-weight: 600;
    }

    .search-wrap {
        flex-shrink: 0;
    }

    .search-input {
        padding: 0.375rem 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: 8px;
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 0.875rem;
        width: 200px;
        outline: none;
    }

    .search-input:focus {
        border-color: var(--color-primary);
        box-shadow: 0 0 0 2px var(--color-focus-ring);
    }

    .breadcrumb {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.5rem 0;
        margin-bottom: 0.25rem;
        font-size: 0.875rem;
    }

    .crumb {
        background: none;
        border: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 0.125rem 0.25rem;
        border-radius: 4px;
        font-size: 0.875rem;
    }

    .crumb:hover {
        color: var(--color-text);
        background: var(--color-fill);
    }

    .crumb:last-child {
        color: var(--color-text);
        font-weight: 600;
        cursor: default;
        pointer-events: none;
    }

    .crumb-sep {
        display: flex;
        align-items: center;
        color: var(--color-text-muted);
        width: 12px;
        height: 12px;
    }

    .crumb-sep :global(svg) {
        width: 12px;
        height: 12px;
    }

    .state-center {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 4rem 2rem;
        text-align: center;
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    .empty-icon {
        width: 3rem;
        height: 3rem;
        color: var(--color-text-muted);
        margin-bottom: 1rem;
    }

    .content-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 0.75rem;
        padding-top: 0.25rem;
        overflow-y: auto;
        flex: 1;
    }

    .item-card {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.25rem;
        padding: 0.875rem;
        border: 1px solid var(--color-border);
        border-radius: 10px;
        background: var(--color-surface);
        cursor: pointer;
        transition: border-color 0.15s, box-shadow 0.15s;
        overflow: hidden;
        min-height: 90px;
    }

    .item-card:hover {
        border-color: var(--color-primary);
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }

    .item-icon {
        width: 1.75rem;
        height: 1.75rem;
        flex-shrink: 0;
        margin-bottom: 0.25rem;
    }

    .folder-icon { color: #f59e0b; }
    .file-icon   { color: var(--color-primary); }

    .item-name {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--color-text);
        line-height: 1.3;
        word-break: break-word;
        max-width: 100%;
    }

    .item-meta {
        font-size: 0.75rem;
        color: var(--color-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
    }

    .item-actions {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        opacity: 0;
        transition: opacity 0.15s;
    }

    .item-card:hover .item-actions {
        opacity: 1;
    }

    .action-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 4px;
        background: var(--color-fill);
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 0;
    }

    .action-icon :global(svg) {
        width: 14px;
        height: 14px;
    }

    .action-icon:hover {
        background: var(--color-fill-secondary);
        color: var(--color-text);
    }

    .rename-input {
        width: 100%;
        font-size: 0.875rem;
        font-weight: 500;
        padding: 0.125rem 0.25rem;
        border: 1px solid var(--color-primary);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
        outline: none;
    }

    /* Context menu */
    .context-menu {
        position: fixed;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        padding: 0.375rem;
        z-index: 1000;
        min-width: 160px;
    }

    .ctx-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.75rem;
        border: none;
        background: transparent;
        color: var(--color-text);
        font-size: 0.875rem;
        cursor: pointer;
        border-radius: 6px;
        text-align: left;
    }

    .ctx-item :global(svg) {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
    }

    .ctx-item:hover {
        background: var(--color-fill);
    }

    .ctx-item.danger {
        color: var(--color-error, #ef4444);
    }

    .ctx-sep {
        border: none;
        border-top: 1px solid var(--color-border);
        margin: 0.25rem 0;
    }
</style>
