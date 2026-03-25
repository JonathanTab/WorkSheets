<script>
    import { storage } from "../stores/storage.js";
    import { openModal, closeTopModal } from "../lib/ui/modalStore.svelte.js";
    import Button from "../lib/ui/Button.svelte";
    import CreateDocumentModal from "./modals/CreateDocumentModal.svelte";
    import DeleteConfirmModal from "./modals/DeleteConfirmModal.svelte";
    import RenameDocumentModal from "./modals/RenameDocumentModal.svelte";
    import MoveFileModal from "./modals/MoveFileModal.svelte";
    import ShareFileModal from "./modals/ShareFileModal.svelte";
    import PromptModal from "./modals/PromptModal.svelte";
    import ConfirmModal from "./modals/ConfirmModal.svelte";
    import FolderTree from "./FolderTree.svelte";
    import {
        spreadsheet,
        plus,
        trash,
        edit,
        arrowRight,
        moreVertical,
        folder,
        folderOpen,
        newFolder,
        share,
        move,
        home,
        clock,
        listView,
        gridView,
        refresh,
        chevronRight,
        chevronDown,
        search,
        user,
        checkSquare,
        square,
        sortAsc,
        sortDesc,
        menu,
        close,
    } from "../lib/icons/index.js";

    // ---- State ----
    let tab = $state("recent"); // "drive" | "shared" | "recent" - default to recent
    let sidebarOpen = $state(false); // Mobile sidebar toggle
    let currentFolderId = $state(null); // null = root
    let driveFiles = $state(storage.drive.listFiles());
    let driveFolders = $state(storage.drive.listFolders());
    let searchQuery = $state("");
    let contentSearchResults = $state(/** @type {any[]} */ ([]));
    let isContentSearching = $state(false);
    let viewMode = $state("list"); // "list" | "grid"
    let contextMenu = $state(null); // { x, y, item, type: 'file'|'folder' }
    let renamingFolderId = $state(null);
    let renameFolderValue = $state("");
    let selectedItems = $state(new Set()); // Set of {type, id}
    let sortColumn = $state("modified"); // "name" | "owner" | "modified" | "size"
    let sortDirection = $state("desc"); // "asc" | "desc" - default desc for modified (most recent first)
    let lastSelectedIndex = $state(-1);
    let expandedFolders = $state(new Set()); // For folder tree expansion

    // Keep in sync with storage updates
    $effect(() => {
        const unsubs = [
            storage.drive.files.subscribe((f) => {
                driveFiles = f;
            }),
            storage.drive.folders.subscribe((f) => {
                driveFolders = f;
            }),
        ];
        return () => unsubs.forEach((u) => u());
    });

    // ---- Content search (server-side, debounced) ----
    let _searchTimer = null;
    $effect(() => {
        const q = searchQuery.trim();
        contentSearchResults = [];
        if (_searchTimer) clearTimeout(_searchTimer);
        if (!q || q.length < 2) {
            isContentSearching = false;
            return;
        }
        _searchTimer = setTimeout(async () => {
            isContentSearching = true;
            try {
                contentSearchResults = await storage.drive.search(q);
            } catch {
                contentSearchResults = [];
            } finally {
                isContentSearching = false;
            }
        }, 400);
    });

    // ---- Folder tree for sidebar ----
    let rootFolders = $derived(driveFolders.filter((f) => f.parentId === null));

    // Get child folders for a given parent
    function getChildFolders(parentId) {
        return driveFolders.filter((f) => f.parentId === parentId);
    }

    // Check if folder is expanded
    function isFolderExpanded(folderId) {
        return expandedFolders.has(folderId);
    }

    // Toggle folder expansion
    function toggleFolderExpand(folderId, e) {
        e?.stopPropagation();
        const newExpanded = new Set(expandedFolders);
        if (newExpanded.has(folderId)) {
            newExpanded.delete(folderId);
        } else {
            newExpanded.add(folderId);
        }
        expandedFolders = newExpanded;
    }

    // ---- Current folder contents ----
    let folderContents = $derived.by(() => {
        const username = storage._options?.getUsername?.() ?? "";
        if (tab === "shared") {
            return {
                folders: driveFolders.filter(
                    (f) =>
                        f.owner !== username &&
                        f.sharedWith?.some((s) => s.username === username),
                ),
                files: driveFiles.filter(
                    (f) =>
                        f.owner !== username &&
                        !f.deleted &&
                        f.sharedWith?.some((s) => s.username === username),
                ),
            };
        }
        if (tab === "recent") {
            return { folders: [], files: storage.drive.recentlyOpened(50) };
        }
        // drive tab
        return {
            folders: driveFolders.filter((f) => f.parentId === currentFolderId),
            files: driveFiles.filter(
                (f) =>
                    f.folderId === currentFolderId &&
                    !f.deleted &&
                    f.scope === "drive",
            ),
        };
    });

    // Combined and sorted items
    let allItems = $derived.by(() => {
        const folders = folderContents.folders.map((f) => ({
            ...f,
            itemType: "folder",
        }));
        const files = folderContents.files.map((f) => ({
            ...f,
            itemType: "file",
        }));

        // Folders always first when sorting by name
        let combined = [...folders, ...files];

        if (sortColumn === "name") {
            combined.sort((a, b) => {
                // Folders first
                if (a.itemType !== b.itemType)
                    return a.itemType === "folder" ? -1 : 1;
                const aName = a.name || a.title || "";
                const bName = b.name || b.title || "";
                return sortDirection === "asc"
                    ? aName.localeCompare(bName)
                    : bName.localeCompare(aName);
            });
        } else if (sortColumn === "owner") {
            combined.sort((a, b) => {
                const aOwner = a.owner || "me";
                const bOwner = b.owner || "me";
                return sortDirection === "asc"
                    ? aOwner.localeCompare(bOwner)
                    : bOwner.localeCompare(aOwner);
            });
        } else if (sortColumn === "modified") {
            combined.sort((a, b) => {
                const aTime = new Date(
                    a.updatedAt || a.createdAt || 0,
                ).getTime();
                const bTime = new Date(
                    b.updatedAt || b.createdAt || 0,
                ).getTime();
                return sortDirection === "asc" ? aTime - bTime : bTime - aTime;
            });
        }

        return combined;
    });

    // Search filter — when active, searches all drive files by title + merges server content matches
    let displayItems = $derived.by(() => {
        const q = searchQuery.trim();
        if (!q) return allItems;
        const ql = q.toLowerCase();
        // Title match across ALL drive files (not just current folder)
        const titleMatches = driveFiles
            .filter(
                (f) => !f.deleted && (f.title || "").toLowerCase().includes(ql),
            )
            .map((f) => ({ ...f, itemType: "file" }));
        const titleIds = new Set(titleMatches.map((f) => f.id));
        // Content matches from server (deduped with title results)
        const contentMatches = contentSearchResults
            .filter((f) => !titleIds.has(f.id))
            .map((f) => ({ ...f, itemType: "file", _contentMatch: true }));
        return [...titleMatches, ...contentMatches];
    });

    // ---- Breadcrumb ----
    let breadcrumb = $derived.by(() => {
        const crumbs = [];
        let id = currentFolderId;
        while (id) {
            const folder = driveFolders.find((f) => f.id === id);
            if (!folder) break;
            crumbs.unshift({ id: folder.id, name: folder.name });
            id = folder.parentId;
        }
        return crumbs;
    });

    // ---- Selection helpers ----
    function itemKey(item) {
        return `${item.itemType}-${item.id}`;
    }

    function isSelected(item) {
        return selectedItems.has(itemKey(item));
    }

    function clearSelection() {
        selectedItems = new Set();
    }

    function toggleItem(item, event) {
        const key = itemKey(item);
        const newSelection = new Set(selectedItems);

        if (event?.shiftKey && lastSelectedIndex >= 0) {
            // Range select
            const currentIndex = displayItems.indexOf(item);
            const start = Math.min(lastSelectedIndex, currentIndex);
            const end = Math.max(lastSelectedIndex, currentIndex);
            for (let i = start; i <= end; i++) {
                newSelection.add(itemKey(displayItems[i]));
            }
        } else if (event?.ctrlKey || event?.metaKey) {
            // Toggle individual
            if (newSelection.has(key)) {
                newSelection.delete(key);
            } else {
                newSelection.add(key);
            }
            lastSelectedIndex = displayItems.indexOf(item);
        } else {
            // Single select
            newSelection.clear();
            newSelection.add(key);
            lastSelectedIndex = displayItems.indexOf(item);
        }

        selectedItems = newSelection;
    }

    function selectAll() {
        const newSelection = new Set();
        displayItems.forEach((item) => newSelection.add(itemKey(item)));
        selectedItems = newSelection;
    }

    // ---- Navigation ----
    function navigateFolder(id) {
        currentFolderId = id;
        searchQuery = "";
        clearSelection();
        sidebarOpen = false; // Close mobile sidebar
    }

    function switchTab(newTab) {
        tab = newTab;
        currentFolderId = null;
        searchQuery = "";
        clearSelection();
        sidebarOpen = false; // Close mobile sidebar
    }

    // ---- File actions ----
    function openDocument(docId) {
        window.location.hash = docId;
    }

    function handleCreateDocument() {
        openModal(CreateDocumentModal, {
            onConfirm: async (title) => {
                try {
                    const doc = await storage.drive.createFile({
                        title,
                        folderId: tab === "drive" ? currentFolderId : null,
                    });
                    closeTopModal();
                    openDocument(doc.id);
                } catch (e) {
                    console.error("Failed to create document:", e);
                }
            },
        });
    }

    async function handleCreateFolder() {
        openModal(PromptModal, {
            title: "New Folder",
            label: "Enter a name for the new folder:",
            placeholder: "Folder name",
            confirmText: "Create",
            onConfirm: async (name) => {
                try {
                    await storage.drive.createFolder({
                        name,
                        parentId: tab === "drive" ? currentFolderId : null,
                    });
                    closeTopModal();
                } catch (e) {
                    console.error("Failed to create folder:", e);
                }
            },
        });
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
        openModal(ConfirmModal, {
            title: "Delete Folder",
            message: `Delete folder "${folder.name}" and all its contents? This cannot be undone.`,
            confirmText: "Delete",
            variant: "danger",
            onConfirm: async () => {
                try {
                    await storage.drive.deleteFolder(folder.id);
                    if (currentFolderId === folder.id)
                        currentFolderId = folder.parentId ?? null;
                    closeTopModal();
                } catch (err) {
                    console.error("Failed to delete folder:", err);
                }
            },
        });
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
            await storage.drive
                .renameFolder(folder.id, trimmed)
                .catch(console.error);
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

    function handleKeydown(e) {
        if (e.key === "Escape") {
            if (sidebarOpen) {
                sidebarOpen = false;
            } else if (contextMenu) {
                closeContextMenu();
            } else if (selectedItems.size > 0) {
                clearSelection();
            }
        }
        if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            selectAll();
        }
    }

    // ---- Helpers ----
    function formatDate(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        const now = new Date();
        const diff = Number(now) - Number(d);
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));

        if (days === 0) {
            return d.toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
            });
        } else if (days === 1) {
            return "Yesterday";
        } else if (days < 7) {
            return d.toLocaleDateString(undefined, { weekday: "short" });
        } else {
            return d.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
            });
        }
    }

    function formatSize(bytes) {
        if (!bytes) return "-";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function isOwned(item) {
        const username = storage._options?.getUsername?.() ?? "";
        return item.owner === username;
    }

    function getOwnerName(item) {
        return isOwned(item) ? "Me" : item.owner || "Unknown";
    }

    function toggleSort(column) {
        if (sortColumn === column) {
            sortDirection = sortDirection === "asc" ? "desc" : "asc";
        } else {
            sortColumn = column;
            sortDirection = "asc";
        }
    }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKeydown} />

<div class="drive-browser">
    <!-- Mobile Overlay -->
    {#if sidebarOpen}
        <div
            class="sidebar-overlay"
            onclick={() => (sidebarOpen = false)}
        ></div>
    {/if}

    <!-- Left Sidebar -->
    <aside class="sidebar" class:open={sidebarOpen}>
        <!-- Sidebar Header (Mobile close) -->
        <div class="sidebar-header mobile-only">
            <span class="sidebar-title">Menu</span>
            <button class="sidebar-close" onclick={() => (sidebarOpen = false)}>
                {@html close}
            </button>
        </div>

        <!-- New Button -->
        <div class="sidebar-section">
            <Button
                onclick={handleCreateDocument}
                icon={plus}
                iconPosition="left"
                className="new-btn"
            >
                New Spreadsheet
            </Button>
        </div>

        <!-- Navigation -->
        <nav class="sidebar-nav">
            <button
                class="nav-item"
                class:active={tab === "recent"}
                onclick={() => switchTab("recent")}
            >
                <span class="nav-icon">{@html clock}</span>
                <span class="nav-label">Recent</span>
            </button>

            <!-- My Drive with expandable folder tree -->
            <div class="nav-item-wrapper">
                <button
                    class="nav-item"
                    class:active={tab === "drive" && currentFolderId === null}
                    onclick={() => switchTab("drive")}
                >
                    <span class="nav-icon">{@html folder}</span>
                    <span class="nav-label">My Drive</span>
                </button>
                {#if tab === "drive"}
                    <button
                        class="nav-action"
                        onclick={handleCreateFolder}
                        title="New Folder"
                    >
                        {@html newFolder}
                    </button>
                    {#if rootFolders.length > 0}
                        <span
                            class="tree-expand nav-expand"
                            onclick={(e) => {
                                e.stopPropagation();
                                // Toggle all root folders
                                const allExpanded = rootFolders.every((f) =>
                                    isFolderExpanded(f.id),
                                );
                                const newExpanded = new Set(expandedFolders);
                                rootFolders.forEach((f) => {
                                    if (allExpanded) {
                                        newExpanded.delete(f.id);
                                    } else {
                                        newExpanded.add(f.id);
                                    }
                                });
                                expandedFolders = newExpanded;
                            }}
                            title={rootFolders.every((f) =>
                                isFolderExpanded(f.id),
                            )
                                ? "Collapse all"
                                : "Expand all"}
                        >
                            {@html rootFolders.every((f) =>
                                isFolderExpanded(f.id),
                            )
                                ? chevronDown
                                : chevronRight}
                        </span>
                    {/if}
                {/if}
            </div>

            <!-- Folder Tree (only in drive tab) -->
            {#if tab === "drive" && rootFolders.length > 0}
                <div class="folder-tree">
                    <FolderTree
                        folders={rootFolders}
                        {currentFolderId}
                        {expandedFolders}
                        onNavigate={navigateFolder}
                        onToggleExpand={toggleFolderExpand}
                        {getChildFolders}
                    />
                </div>
            {:else if tab === "drive"}
                <div class="folder-tree">
                    <div class="tree-empty">No folders yet</div>
                </div>
            {/if}

            <button
                class="nav-item"
                class:active={tab === "shared"}
                onclick={() => switchTab("shared")}
            >
                <span class="nav-icon">{@html share}</span>
                <span class="nav-label">Shared</span>
            </button>
        </nav>

        <!-- Sync button -->
        <div class="sidebar-footer">
            <button class="sync-btn" onclick={() => storage.sync()}>
                {@html refresh}
                <span>Sync</span>
            </button>
        </div>
    </aside>

    <!-- Main Content -->
    <div class="main-content">
        <!-- Header -->
        <header class="header">
            <div class="header-left">
                <button
                    class="menu-btn desktop-hidden"
                    onclick={() => (sidebarOpen = true)}
                >
                    {@html menu}
                </button>
                <div class="app-title desktop-only">
                    <span class="app-icon">{@html spreadsheet}</span>
                    <div>
                        <h1>WorkSheets</h1>
                        <p>Collaborative Spreadsheets</p>
                    </div>
                </div>
                <!-- Current location for mobile -->
                <div class="mobile-title mobile-only">
                    {#if tab === "recent"}
                        Recent
                    {:else if tab === "shared"}
                        Shared
                    {:else if currentFolderId}
                        {driveFolders.find((f) => f.id === currentFolderId)
                            ?.name || "My Drive"}
                    {:else}
                        My Drive
                    {/if}
                </div>
            </div>
            <div class="header-actions">
                <Button
                    onclick={handleCreateDocument}
                    size="sm"
                    icon={plus}
                    iconPosition="left"
                    className="mobile-hidden"
                >
                    New
                </Button>
            </div>
        </header>

        <!-- Toolbar -->
        <div class="toolbar">
            <div class="toolbar-left">
                <!-- Breadcrumb (desktop only for drive tab) -->
                {#if tab === "drive"}
                    <div class="breadcrumb desktop-only">
                        <button
                            class="crumb"
                            onclick={() => navigateFolder(null)}
                        >
                            <span class="crumb-icon">{@html home}</span>
                            <span>My Drive</span>
                        </button>
                        {#each breadcrumb as crumb, i}
                            <span class="crumb-sep">{@html chevronRight}</span>
                            <button
                                class="crumb"
                                class:last={i === breadcrumb.length - 1}
                                onclick={() => navigateFolder(crumb.id)}
                            >
                                {crumb.name}
                            </button>
                        {/each}
                    </div>
                {/if}
                {#if selectedItems.size > 0}
                    <div class="selection-info">
                        <span>{selectedItems.size} selected</span>
                        <button class="clear-btn" onclick={clearSelection}
                            >Clear</button
                        >
                    </div>
                {/if}
            </div>
            <div class="toolbar-right">
                <!-- Search -->
                <div class="search-box">
                    <span class="search-icon">{@html search}</span>
                    <input
                        type="search"
                        placeholder="Search..."
                        bind:value={searchQuery}
                    />
                </div>

                <!-- View toggle -->
                <div class="view-toggle">
                    <button
                        class="view-btn"
                        class:active={viewMode === "list"}
                        onclick={() => (viewMode = "list")}
                        title="List view"
                    >
                        {@html listView}
                    </button>
                    <button
                        class="view-btn"
                        class:active={viewMode === "grid"}
                        onclick={() => (viewMode = "grid")}
                        title="Grid view"
                    >
                        {@html gridView}
                    </button>
                </div>

                {#if tab === "drive"}
                    <Button
                        onclick={handleCreateFolder}
                        variant="ghost"
                        size="sm"
                        icon={newFolder}
                        className="mobile-hidden"
                    />
                {/if}
            </div>
        </div>

        <!-- Content -->
        <div class="content-area">
            {#if displayItems.length === 0}
                <div class="empty-state">
                    <div class="empty-icon">{@html spreadsheet}</div>
                    {#if searchQuery}
                        <h2>
                            {isContentSearching
                                ? "Searching…"
                                : "No results found"}
                        </h2>
                        <p>No files or folders match "{searchQuery}"</p>
                    {:else if tab === "shared"}
                        <h2>No shared files</h2>
                        <p>Files shared with you will appear here</p>
                    {:else if tab === "recent"}
                        <h2>No recent files</h2>
                        <p>Files you've opened recently will appear here</p>
                        <div class="empty-actions">
                            <Button
                                onclick={handleCreateDocument}
                                icon={plus}
                                iconPosition="left"
                            >
                                New Spreadsheet
                            </Button>
                        </div>
                    {:else}
                        <h2>No files yet</h2>
                        <p>Create a spreadsheet to get started</p>
                        <div class="empty-actions">
                            <Button
                                onclick={handleCreateDocument}
                                icon={plus}
                                iconPosition="left"
                            >
                                New Spreadsheet
                            </Button>
                            <Button
                                onclick={handleCreateFolder}
                                variant="secondary"
                                icon={newFolder}
                                iconPosition="left"
                            >
                                New Folder
                            </Button>
                        </div>
                    {/if}
                </div>
            {:else if viewMode === "list"}
                <!-- List View (Table) -->
                <div class="file-table-container">
                    <table class="file-table">
                        <thead>
                            <tr>
                                <th class="col-check">
                                    <input
                                        type="checkbox"
                                        checked={selectedItems.size ===
                                            displayItems.length &&
                                            displayItems.length > 0}
                                        indeterminate={selectedItems.size > 0 &&
                                            selectedItems.size <
                                                displayItems.length}
                                        onclick={(e) =>
                                            e.currentTarget.checked
                                                ? selectAll()
                                                : clearSelection()}
                                    />
                                </th>
                                <th
                                    class="col-name"
                                    onclick={() => toggleSort("name")}
                                >
                                    <div class="col-name-header">
                                        <span>Name</span>
                                        {#if sortColumn === "name"}
                                            <span class="sort-icon"
                                                >{@html sortDirection === "asc"
                                                    ? sortAsc
                                                    : sortDesc}</span
                                            >
                                        {:else}
                                            <span class="sort-icon placeholder"
                                                >{@html sortAsc}</span
                                            >
                                        {/if}
                                    </div>
                                </th>
                                <th
                                    class="col-owner desktop-only"
                                    onclick={() => toggleSort("owner")}
                                >
                                    <span>Owner</span>
                                    {#if sortColumn === "owner"}
                                        <span class="sort-icon"
                                            >{@html sortDirection === "asc"
                                                ? sortAsc
                                                : sortDesc}</span
                                        >
                                    {:else}
                                        <span class="sort-icon placeholder"
                                            >{@html sortAsc}</span
                                        >
                                    {/if}
                                </th>
                                <th
                                    class="col-modified"
                                    onclick={() => toggleSort("modified")}
                                >
                                    <span>Modified</span>
                                    {#if sortColumn === "modified"}
                                        <span class="sort-icon"
                                            >{@html sortDirection === "asc"
                                                ? sortAsc
                                                : sortDesc}</span
                                        >
                                    {:else}
                                        <span class="sort-icon placeholder"
                                            >{@html sortAsc}</span
                                        >
                                    {/if}
                                </th>
                                <th class="col-actions"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each displayItems as item, index (itemKey(item))}
                                <tr
                                    class="file-row"
                                    class:selected={isSelected(item)}
                                    class:folder-row={item.itemType ===
                                        "folder"}
                                    onclick={(e) => toggleItem(item, e)}
                                    ondblclick={() => {
                                        if (item.itemType === "folder") {
                                            navigateFolder(item.id);
                                        } else {
                                            openDocument(item.id);
                                        }
                                    }}
                                    oncontextmenu={(e) =>
                                        showContextMenu(e, item, item.itemType)}
                                >
                                    <td class="col-check">
                                        <input
                                            type="checkbox"
                                            checked={isSelected(item)}
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                toggleItem(item, e);
                                            }}
                                        />
                                    </td>
                                    <td class="col-name">
                                        <div class="col-name-content">
                                            <span
                                                class="item-icon {item.itemType}"
                                            >
                                                {#if item.itemType === "folder"}
                                                    {@html folder}
                                                {:else}
                                                    {@html spreadsheet}
                                                {/if}
                                            </span>
                                            {#if renamingFolderId === item.id}
                                                <input
                                                    class="rename-input"
                                                    bind:value={
                                                        renameFolderValue
                                                    }
                                                    onclick={(e) =>
                                                        e.stopPropagation()}
                                                    onblur={() =>
                                                        finishRenameFolder(
                                                            item,
                                                        )}
                                                    onkeydown={(e) => {
                                                        if (e.key === "Enter")
                                                            finishRenameFolder(
                                                                item,
                                                            );
                                                        if (e.key === "Escape")
                                                            renamingFolderId =
                                                                null;
                                                    }}
                                                    autofocus
                                                />
                                            {:else}
                                                <span class="item-name"
                                                    >{item.name ||
                                                        item.title ||
                                                        "Untitled"}</span
                                                >
                                                {#if item._contentMatch}
                                                    <span
                                                        class="content-match-badge"
                                                        >content</span
                                                    >
                                                {/if}
                                            {/if}
                                        </div>
                                    </td>
                                    <td class="col-owner desktop-only"
                                        >{getOwnerName(item)}</td
                                    >
                                    <td class="col-modified"
                                        >{formatDate(
                                            item.updatedAt || item.createdAt,
                                        )}</td
                                    >
                                    <td class="col-actions">
                                        <button
                                            class="action-btn"
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                showContextMenu(
                                                    e,
                                                    item,
                                                    item.itemType,
                                                );
                                            }}
                                        >
                                            {@html moreVertical}
                                        </button>
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {:else}
                <!-- Grid View -->
                <div class="file-grid">
                    {#each displayItems as item (itemKey(item))}
                        <div
                            class="grid-item"
                            class:selected={isSelected(item)}
                            class:folder={item.itemType === "folder"}
                            onclick={(e) => toggleItem(item, e)}
                            ondblclick={() => {
                                if (item.itemType === "folder") {
                                    navigateFolder(item.id);
                                } else {
                                    openDocument(item.id);
                                }
                            }}
                            oncontextmenu={(e) =>
                                showContextMenu(e, item, item.itemType)}
                        >
                            <div class="grid-item-check">
                                <input
                                    type="checkbox"
                                    checked={isSelected(item)}
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        toggleItem(item, e);
                                    }}
                                />
                            </div>
                            <div class="grid-item-icon">
                                {#if item.itemType === "folder"}
                                    {@html folder}
                                {:else if item.thumbnailKey}
                                    <img
                                        class="grid-item-thumbnail"
                                        src={storage.drive.getThumbnailUrl(
                                            item.id,
                                        )}
                                        alt=""
                                        loading="lazy"
                                    />
                                {:else}
                                    {@html spreadsheet}
                                {/if}
                            </div>
                            <div class="grid-item-name">
                                {item.name || item.title || "Untitled"}
                                {#if item._contentMatch}
                                    <span class="content-match-badge"
                                        >content</span
                                    >
                                {/if}
                            </div>
                            <div class="grid-item-meta">
                                {getOwnerName(item)} · {formatDate(
                                    item.updatedAt || item.createdAt,
                                )}
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        <!-- Status Bar -->
        <footer class="status-bar">
            <div class="status-left">
                {displayItems.length} item{displayItems.length !== 1 ? "s" : ""}
                {#if folderContents.folders.length > 0}
                    · {folderContents.folders.length} folder{folderContents
                        .folders.length !== 1
                        ? "s"
                        : ""}
                {/if}
                {#if folderContents.files.length > 0}
                    · {folderContents.files.length} file{folderContents.files
                        .length !== 1
                        ? "s"
                        : ""}
                {/if}
            </div>
            <div class="status-right">
                {#if selectedItems.size > 0}
                    <span class="status-selected"
                        >{selectedItems.size} selected</span
                    >
                {/if}
            </div>
        </footer>
    </div>
</div>

<!-- Context menu -->
{#if contextMenu}
    <div
        class="context-menu"
        class:mobile={typeof window !== "undefined" && window.innerWidth <= 768}
        style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
        onclick={(e) => e.stopPropagation()}
    >
        {#if contextMenu.type === "file"}
            <button
                class="ctx-item"
                onclick={() => {
                    openDocument(contextMenu.item.id);
                    closeContextMenu();
                }}
            >
                {@html arrowRight} Open
            </button>
            <button
                class="ctx-item"
                onclick={(e) => handleRenameFile(contextMenu.item, e)}
            >
                {@html edit} Rename
            </button>
            <button
                class="ctx-item"
                onclick={(e) => handleMoveFile(contextMenu.item, e)}
            >
                {@html move} Move to…
            </button>
            <button
                class="ctx-item"
                onclick={(e) => handleShareFile(contextMenu.item, e)}
            >
                {@html share} Share…
            </button>
            <hr class="ctx-sep" />
            <button
                class="ctx-item danger"
                onclick={(e) => handleDeleteFile(contextMenu.item, e)}
            >
                {@html trash} Delete
            </button>
        {:else}
            <button
                class="ctx-item"
                onclick={() => {
                    navigateFolder(contextMenu.item.id);
                    closeContextMenu();
                }}
            >
                {@html arrowRight} Open
            </button>
            <button
                class="ctx-item"
                onclick={(e) => startRenameFolder(contextMenu.item, e)}
            >
                {@html edit} Rename
            </button>
            <hr class="ctx-sep" />
            <button
                class="ctx-item danger"
                onclick={(e) => handleDeleteFolder(contextMenu.item, e)}
            >
                {@html trash} Delete
            </button>
        {/if}
    </div>
{/if}

<style>
    .drive-browser {
        display: flex;
        height: 100%;
        background: var(--color-bg);
    }

    /* Mobile Overlay */
    .sidebar-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 99;
    }

    /* Sidebar */
    .sidebar {
        display: flex;
        flex-direction: column;
        width: 240px;
        background: var(--color-surface);
        border-right: 1px solid var(--color-border);
        flex-shrink: 0;
        overflow-y: auto;
    }

    .sidebar-header {
        display: none;
        align-items: center;
        justify-content: space-between;
        padding: 1rem;
        border-bottom: 1px solid var(--color-border);
    }

    .sidebar-title {
        font-weight: 600;
        font-size: 1rem;
    }

    .sidebar-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: 6px;
    }

    .sidebar-close:hover {
        background: var(--color-fill);
    }

    .sidebar-close :global(svg) {
        width: 20px;
        height: 20px;
    }

    .sidebar-section {
        padding: 1rem;
    }

    .new-btn {
        width: 100%;
    }

    /* Navigation */
    .sidebar-nav {
        padding: 0.5rem;
    }

    .nav-item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        width: 100%;
        padding: 0.625rem 0.75rem;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s;
        text-align: left;
    }

    .nav-item:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .nav-item.active {
        background: var(--color-primary-soft);
        color: var(--color-primary);
    }

    .nav-icon {
        display: flex;
        align-items: center;
        width: 18px;
        height: 18px;
        flex-shrink: 0;
    }

    .nav-icon :global(svg) {
        width: 18px;
        height: 18px;
    }

    .nav-label {
        flex: 1;
    }

    /* Nav item wrapper for My Drive with actions */
    .nav-item-wrapper {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
    }

    .nav-item-wrapper .nav-item {
        flex: 1;
        min-width: 0;
    }

    .nav-action {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        border-radius: 4px;
        margin-right: 0.5rem;
    }

    .nav-action:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .nav-action :global(svg) {
        width: 14px;
        height: 14px;
    }

    .nav-expand {
        margin-right: 0.5rem;
    }

    /* Section */
    .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 0;
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-text-muted);
    }

    .section-action {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        border-radius: 4px;
    }

    .section-action:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .section-action :global(svg) {
        width: 14px;
        height: 14px;
    }

    /* Folder Tree */
    .folder-tree {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .tree-empty {
        font-size: 0.75rem;
        color: var(--color-text-muted);
        padding: 0.5rem 0.75rem;
    }

    .tree-item-wrapper {
        display: flex;
        flex-direction: column;
    }

    .tree-item {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        width: 100%;
        padding: 0.375rem 0.5rem;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.8125rem;
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.15s;
        text-align: left;
    }

    .tree-item:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .tree-item.active {
        background: var(--color-primary-soft);
        color: var(--color-primary);
    }

    .tree-expand {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        cursor: pointer;
        border-radius: 3px;
    }

    .tree-expand:hover {
        background: var(--color-fill-secondary);
    }

    .tree-expand :global(svg) {
        width: 12px;
        height: 12px;
    }

    .tree-expand.placeholder {
        visibility: hidden;
    }

    .tree-icon {
        display: flex;
        align-items: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        color: #f59e0b;
    }

    .tree-icon :global(svg) {
        width: 16px;
        height: 16px;
    }

    .tree-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tree-children {
        padding-left: 1rem;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    /* Sidebar Footer */
    .sidebar-footer {
        margin-top: auto;
        padding: 0.75rem;
        border-top: 1px solid var(--color-border);
    }

    .sync-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.75rem;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.8125rem;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s;
    }

    .sync-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .sync-btn :global(svg) {
        width: 16px;
        height: 16px;
    }

    /* Main Content */
    .main-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        overflow: hidden;
    }

    /* Header */
    .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem 1rem;
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
        gap: 0.75rem;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-width: 0;
    }

    .menu-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: 6px;
    }

    .menu-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .menu-btn :global(svg) {
        width: 20px;
        height: 20px;
    }

    .app-title {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .app-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        background: var(--color-primary);
        color: white;
        border-radius: 8px;
    }

    .app-icon :global(svg) {
        width: 1.125rem;
        height: 1.125rem;
    }

    .app-title h1 {
        font-size: 1rem;
        font-weight: 600;
        margin: 0;
        color: var(--color-text);
    }

    .app-title p {
        font-size: 0.6875rem;
        color: var(--color-text-muted);
        margin: 0;
    }

    .mobile-title {
        font-size: 1rem;
        font-weight: 600;
        color: var(--color-text);
    }

    .header-actions {
        display: flex;
        gap: 0.5rem;
    }

    /* Toolbar */
    .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.5rem 1rem;
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
        gap: 0.75rem;
    }

    .toolbar-left,
    .toolbar-right {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .breadcrumb {
        display: flex;
        align-items: center;
        gap: 0.125rem;
        font-size: 0.8125rem;
    }

    .crumb {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.25rem 0.5rem;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: 4px;
        font-size: 0.8125rem;
        transition: all 0.15s;
    }

    .crumb:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .crumb.last {
        color: var(--color-text);
        font-weight: 500;
    }

    .crumb-icon {
        display: flex;
        align-items: center;
        width: 14px;
        height: 14px;
    }

    .crumb-icon :global(svg) {
        width: 14px;
        height: 14px;
    }

    .crumb-sep {
        display: flex;
        align-items: center;
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
    }

    .crumb-sep :global(svg) {
        width: 14px;
        height: 14px;
    }

    .selection-info {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.75rem;
        color: var(--color-text-secondary);
    }

    .clear-btn {
        padding: 0.125rem 0.5rem;
        border: none;
        background: var(--color-fill);
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: 3px;
        font-size: 0.75rem;
    }

    .clear-btn:hover {
        background: var(--color-fill-secondary);
        color: var(--color-text);
    }

    .search-box {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.625rem;
        background: var(--color-fill);
        border: 1px solid transparent;
        border-radius: 6px;
        transition: all 0.15s;
    }

    .search-box:focus-within {
        background: var(--color-surface);
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px var(--color-focus-ring);
    }

    .search-icon {
        display: flex;
        align-items: center;
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
    }

    .search-icon :global(svg) {
        width: 14px;
        height: 14px;
    }

    .search-box input {
        border: none;
        background: transparent;
        outline: none;
        font-size: 0.8125rem;
        color: var(--color-text);
        width: 120px;
    }

    .search-box input::placeholder {
        color: var(--color-text-muted);
    }

    .view-toggle {
        display: flex;
        background: var(--color-fill);
        border-radius: 5px;
        padding: 2px;
    }

    .view-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 26px;
        border: none;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        border-radius: 4px;
        transition: all 0.15s;
    }

    .view-btn :global(svg) {
        width: 14px;
        height: 14px;
    }

    .view-btn:hover {
        color: var(--color-text-secondary);
    }

    .view-btn.active {
        background: var(--color-surface);
        color: var(--color-text);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    }

    /* Content */
    .content-area {
        flex: 1;
        overflow: auto;
        padding: 0 1rem;
    }

    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 3rem 1.5rem;
        text-align: center;
        height: 100%;
    }

    .empty-icon {
        width: 3rem;
        height: 3rem;
        color: var(--color-text-muted);
        opacity: 0.5;
        margin-bottom: 1rem;
    }

    .empty-icon :global(svg) {
        width: 100%;
        height: 100%;
    }

    .empty-state h2 {
        font-size: 1rem;
        font-weight: 600;
        margin: 0 0 0.25rem 0;
        color: var(--color-text);
    }

    .empty-state p {
        font-size: 0.8125rem;
        color: var(--color-text-muted);
        margin: 0;
    }

    .empty-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-top: 1.25rem;
        justify-content: center;
    }

    /* Table View */
    .file-table-container {
        padding: 0.5rem 0;
    }

    .file-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.8125rem;
    }

    .file-table thead {
        position: sticky;
        top: 0;
        background: var(--color-bg);
        z-index: 1;
    }

    .file-table th {
        text-align: left;
        padding: 0.5rem 0.5rem;
        font-weight: 500;
        color: var(--color-text-secondary);
        border-bottom: 1px solid var(--color-border);
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        transition: color 0.15s;
    }

    .file-table th:hover {
        color: var(--color-text);
    }

    .col-check {
        width: 36px;
        text-align: center !important;
        cursor: default !important;
    }

    .col-check:hover {
        color: var(--color-text-secondary);
    }

    .col-name {
        width: auto;
    }

    .col-name-header {
        display: flex;
        align-items: center;
    }

    .col-name-content {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .col-owner {
        width: 100px;
    }

    .col-modified {
        width: 100px;
    }

    .col-actions {
        width: 40px;
        cursor: default !important;
    }

    .sort-icon {
        display: inline-flex;
        align-items: center;
        width: 14px;
        height: 14px;
        margin-left: 0.25rem;
        color: var(--color-primary);
    }

    .sort-icon.placeholder {
        opacity: 0.3;
    }

    .sort-icon :global(svg) {
        width: 14px;
        height: 14px;
    }

    .file-row {
        cursor: pointer;
        transition: background 0.1s;
    }

    .file-row:hover {
        background: var(--color-fill);
    }

    .file-row.selected {
        background: var(--color-primary-soft);
    }

    .file-row td {
        padding: 0.5rem 0.5rem;
        border-bottom: 1px solid var(--color-border);
        vertical-align: middle;
        height: 40px;
    }

    .file-row .col-check {
        text-align: center;
        width: 36px;
        padding: 0.5rem 0.25rem;
    }

    .file-row .col-check input {
        margin: 0;
        vertical-align: middle;
    }

    .item-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex-shrink: 0;
    }

    .item-icon :global(svg) {
        width: 18px;
        height: 18px;
    }

    .item-icon.folder {
        color: #f59e0b;
    }

    .item-icon.file {
        color: var(--color-primary);
    }

    .item-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .rename-input {
        width: 100%;
        padding: 0.125rem 0.25rem;
        border: 1px solid var(--color-primary);
        border-radius: 3px;
        font-size: inherit;
        font-family: inherit;
        outline: none;
    }

    .col-owner,
    .col-modified {
        color: var(--color-text-secondary);
    }

    .action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        border-radius: 4px;
        opacity: 0;
        transition: all 0.15s;
    }

    .action-btn :global(svg) {
        width: 14px;
        height: 14px;
    }

    .file-row:hover .action-btn {
        opacity: 1;
    }

    .action-btn:hover {
        background: var(--color-fill-secondary);
        color: var(--color-text);
    }

    /* Grid View */
    .file-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 0.625rem;
        padding: 0.5rem 0;
    }

    .grid-item {
        position: relative;
        display: flex;
        flex-direction: column;
        padding: 0.875rem;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s;
    }

    .grid-item:hover {
        border-color: var(--color-primary);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }

    .grid-item.selected {
        border-color: var(--color-primary);
        background: var(--color-primary-soft);
    }

    .grid-item-check {
        position: absolute;
        top: 0.5rem;
        left: 0.5rem;
        opacity: 0;
        transition: opacity 0.15s;
    }

    .grid-item:hover .grid-item-check,
    .grid-item.selected .grid-item-check {
        opacity: 1;
    }

    .grid-item-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.25rem;
        height: 2.25rem;
        margin-bottom: 0.5rem;
    }

    .grid-item-icon :global(svg) {
        width: 2.25rem;
        height: 2.25rem;
    }

    .grid-item.folder .grid-item-icon {
        color: #f59e0b;
    }

    .grid-item:not(.folder) .grid-item-icon {
        color: var(--color-primary);
    }

    .grid-item-name {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--color-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-bottom: 0.125rem;
    }

    .grid-item-thumbnail {
        width: 2.25rem;
        height: 2.25rem;
        object-fit: cover;
        border-radius: 4px;
    }

    .content-match-badge {
        display: inline-block;
        font-size: 0.6rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--color-primary);
        background: color-mix(in srgb, var(--color-primary) 10%, transparent);
        border-radius: 3px;
        padding: 0 4px;
        margin-left: 5px;
        vertical-align: middle;
    }

    .grid-item-meta {
        font-size: 0.625rem;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* Status Bar */
    .status-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.375rem 1rem;
        background: var(--color-surface);
        border-top: 1px solid var(--color-border);
        font-size: 0.6875rem;
        color: var(--color-text-muted);
    }

    .status-selected {
        color: var(--color-primary);
        font-weight: 500;
    }

    /* Context Menu */
    .context-menu {
        position: fixed;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
        padding: 0.25rem;
        z-index: 1000;
        min-width: 160px;
    }

    .context-menu.mobile {
        position: fixed;
        left: 50% !important;
        top: 50% !important;
        transform: translate(-50%, -50%);
        min-width: 200px;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.25);
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
        font-size: 0.8125rem;
        cursor: pointer;
        border-radius: 5px;
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

    /* Responsive Utilities */
    .mobile-only {
        display: none;
    }

    .desktop-only {
        display: block;
    }

    .desktop-hidden {
        display: none;
    }

    .mobile-hidden {
        display: flex;
    }

    /* Mobile Styles */
    @media (max-width: 768px) {
        .sidebar-overlay {
            display: block;
        }

        .sidebar {
            position: fixed;
            left: 0;
            top: 0;
            bottom: 0;
            z-index: 100;
            transform: translateX(-100%);
            transition: transform 0.25s ease;
        }

        .sidebar.open {
            transform: translateX(0);
        }

        .sidebar-header {
            display: flex;
        }

        .mobile-only {
            display: block;
        }

        .desktop-only {
            display: none !important;
        }

        .desktop-hidden {
            display: flex;
        }

        .mobile-hidden {
            display: none !important;
        }

        .header {
            padding: 0.625rem 0.75rem;
        }

        .toolbar {
            padding: 0.5rem 0.75rem;
        }

        .content-area {
            padding: 0 0.75rem;
        }

        .search-box input {
            width: 100px;
        }

        .col-modified {
            width: 80px;
        }

        .file-grid {
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 0.5rem;
        }

        .grid-item {
            padding: 0.75rem;
        }

        /* Mobile context menu improvements */
        .context-menu.mobile .ctx-item {
            padding: 0.75rem 1rem;
            font-size: 0.9375rem;
            min-height: 44px;
        }
    }
</style>
