<script>
    import { storage } from "../stores/storage.js";
    import { openModal, closeTopModal } from "../lib/ui/modalStore.svelte.js";
    import Button from "../lib/ui/Button.svelte";
    import UserMenu from "./UserMenu.svelte";
    import MoveFileModal from "./modals/MoveFileModal.svelte";
    import ShareFileModal from "./modals/ShareFileModal.svelte";
    import VersionHistoryModal from "./modals/VersionHistoryModal.svelte";
    import PromptModal from "./modals/PromptModal.svelte";
    import ConfirmModal from "./modals/ConfirmModal.svelte";
    import UploadFileModal from "./modals/UploadFileModal.svelte";
    import FolderTree from "./FolderTree.svelte";
    import FileViewer from "./files/FileViewer.svelte";
    import {
        spreadsheet,
        fileText,
        penTool,
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
        externalLink,
        upload,
        copy,
        cut,
        fileImage,
        fileVideo,
        fileAudio,
        filePdf,
        fileArchive,
        fileCode,
        file,
        icons,
    } from "../lib/icons/index.js";
    import { router } from "../lib/router.svelte.js";
    import { getOfflineMode, setOfflineMode } from "../lib/FileRegistry/offlineMode.js";
    import { initializeDocument as initializeSpreadsheet } from "../stores/spreadsheet/schema.js";
    import {
        APP_SHEETS,
        APP_DOCS,
        APP_SVG,
        APP_FILE,
        getAppType,
        getAppIcon,
        getFileRoute,
        getFileCategory,
        getFileIcon,
        isBlobFile,
        isPreviewable,
        DEFAULT_APP,
        getDefaultTitle,
        getAppName,
    } from "../lib/appTypes.js";

    // ---- Props (for standalone / embeddable use) ----
    let {
        registry = storage,
        appTitle = "Scriptorium",
        appSubtitle = "Collaborative Spreadsheets",
    } = $props();

    // ---- Constants ----
    const MOBILE_BREAKPOINT = 768;    // px — window width below which the layout switches to mobile
    const RECENTS_LIMIT = 50;         // max number of recently-opened files shown
    const MIN_SEARCH_LENGTH = 2;      // minimum query length before content search fires
    const SEARCH_DEBOUNCE_MS = 400;   // ms to wait after typing before issuing a search
    const CTX_MENU_MARGIN = 8;        // px gap between context menu and viewport edge
    const CTX_W = 185;                // approximate context menu width for viewport clamping
    const CTX_H = 270;                // approximate context menu height for viewport clamping

    // ---- State ----
    // Seed tab and folderId from the current route so back/forward works on first load
    let tab = $state(
        router.route.view === "browser"
            ? (router.route.tab ?? "recent")
            : "recent",
    );
    let sidebarOpen = $state(false); // Mobile sidebar toggle
    let currentFolderId = $state(
        router.route.view === "browser"
            ? (router.route.folderId ?? null)
            : null,
    );
    let driveFiles = $state(registry.drive.listFiles());
    let driveFolders = $state(registry.drive.listFolders());
    let searchQuery = $state("");
    let contentSearchResults = $state(/** @type {any[]} */ ([]));
    let isContentSearching = $state(false);
    let viewMode = $state(
        (typeof localStorage !== "undefined" &&
            localStorage.getItem("drive-view-mode")) ||
            "grid",
    ); // "list" | "grid"
    $effect(() => {
        localStorage.setItem("drive-view-mode", viewMode);
    });
    let offlineMode = $state(getOfflineMode());
    let contextMenu = $state(null); // { x, y, item, type: 'file'|'folder' }
    let renamingFolderId = $state(null);
    let renameFolderValue = $state("");
    let selectedItems = $state(new Set()); // Set of {type, id}
    let sortColumn = $state("modified"); // "name" | "owner" | "modified" | "size"
    let sortDirection = $state("desc"); // "asc" | "desc" - default desc for modified (most recent first)
    let lastSelectedKey = $state(/** @type {string|null} */ (null)); // key of last clicked item
    let focusedItemKey = $state(/** @type {string|null} */ (null)); // key of single-clicked (focused) item
    let expandedFolders = $state(new Set()); // For folder tree expansion
    let recentFiles = $state(/** @type {any[]} */ ([]));
    let deletedFiles = $state(registry.drive.listDeletedFiles?.() ?? []);
    let syncState = $state({ isSyncing: false, lastSync: null, error: null });
    let isMobile = $state(
        typeof window !== "undefined" && window.innerWidth <= MOBILE_BREAKPOINT,
    );
    /** @type {HTMLInputElement | null} */
    let searchInput = $state(null);

    // File viewer state for blob files
    let viewingFile = $state(null); // File being viewed
    let viewingBlobUrl = $state(null); // Blob URL for the file

    // Drag-and-drop upload state (external files)
    let isDraggingOver = $state(false);
    let dragCounter = $state(0); // Track drag enter/leave events

    // Drag-and-drop move state (internal items)
    const DRAG_MIME = "application/x-drive-item";
    const ROOT_FOLDER_ID = "__root__"; // sentinel for root drop target
    let draggingItem = $state(null); // { id, itemType } being dragged
    let dropTargetId = $state(null); // folder id (or ROOT_FOLDER_ID) being hovered over
    let isInternalDragging = $state(false); // true while dragging an internal item (not external files)
    let isTrashDropTarget = $state(false); // true when dragging a file over the Trash nav item

    // Rubber-band (drag range) selection state
    /** @type {HTMLElement|null} */
    let contentAreaEl = $state(null);
    let dragSelectActive = $state(false);
    let dragSelectRect = $state(/** @type {{x1:number,y1:number,x2:number,y2:number}|null} */ (null));

    // Undo / redo stacks for file operations
    let undoStack = $state(
        /** @type {{ description: string, undo: () => Promise<void>, redo: () => Promise<void> }[]} */ ([]),
    );
    let redoStack = $state(
        /** @type {{ description: string, undo: () => Promise<void>, redo: () => Promise<void> }[]} */ ([]),
    );

    // Clipboard for copy/cut/paste
    let clipboard = $state(null); // { items: [{id, itemType}], op: 'copy'|'cut' }

    // Keep in sync with registry updates
    $effect(() => {
        const unsubs = [
            registry.drive.files.subscribe((f) => {
                driveFiles = f;
            }),
            registry.drive.folders.subscribe((f) => {
                driveFolders = f;
            }),
        ];
        if (registry.drive.deletedFiles) {
            unsubs.push(
                registry.drive.deletedFiles.subscribe((f) => {
                    deletedFiles = f;
                }),
            );
        }
        return () => unsubs.forEach((u) => u());
    });

    // Sync tab/folder from route on back/forward navigation
    $effect(() => {
        const r = router.route;
        if (r.view !== "browser") return;
        const newTab = r.tab ?? "recent";
        const newFolderId = r.folderId ?? null;
        if (newTab !== tab || newFolderId !== currentFolderId) {
            tab = newTab;
            currentFolderId = newFolderId;
            searchQuery = "";
            clearSelection();
        }
    });

    // Sync state — subscribe if available
    $effect(() => {
        if (!registry.syncState) return;
        const unsub = registry.syncState.subscribe((s) => {
            syncState = s;
        });
        return unsub;
    });

    // Recent files — update on every registry change/sync
    $effect(() => {
        function updateRecents() {
            recentFiles = registry.drive.recentlyOpened(RECENTS_LIMIT);
        }
        updateRecents();
        registry.on?.("change", updateRecents);
        registry.on?.("sync", updateRecents);
        return () => {
            registry.off?.("change", updateRecents);
            registry.off?.("sync", updateRecents);
        };
    });

    // Mobile breakpoint — reactive to window resize
    $effect(() => {
        function onResize() {
            isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
        }
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    });

    // ---- Content search (server-side, debounced) ----
    let _searchTimer = null;
    $effect(() => {
        const q = searchQuery.trim();
        contentSearchResults = [];
        if (_searchTimer) clearTimeout(_searchTimer);
        if (!q || q.length < MIN_SEARCH_LENGTH) {
            isContentSearching = false;
            return;
        }
        _searchTimer = setTimeout(async () => {
            isContentSearching = true;
            try {
                contentSearchResults = await registry.drive.search(q);
            } catch {
                contentSearchResults = [];
            } finally {
                isContentSearching = false;
            }
        }, SEARCH_DEBOUNCE_MS);
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
        const username = registry._options?.getUsername?.() ?? "";
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
            return { folders: [], files: recentFiles };
        }
        if (tab === "trash") {
            return { folders: [], files: deletedFiles };
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
                    tab === "recent" && a._activityAt
                        ? a._activityAt
                        : a.mtime || a.ctime || a.birthtime || 0,
                ).getTime();
                const bTime = new Date(
                    tab === "recent" && b._activityAt
                        ? b._activityAt
                        : b.mtime || b.ctime || b.birthtime || 0,
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
        lastSelectedKey = null;
        focusedItemKey = null;
    }

    // Called by checkbox clicks — always accumulates (never clears other selections).
    function toggleItem(item, event) {
        const key = itemKey(item);
        const newSelection = new Set(selectedItems);

        if (event?.shiftKey && lastSelectedKey !== null) {
            // Range select from anchor to here
            const anchorIndex = displayItems.findIndex(
                (i) => itemKey(i) === lastSelectedKey,
            );
            const currentIndex = displayItems.indexOf(item);
            if (anchorIndex !== -1) {
                const start = Math.min(anchorIndex, currentIndex);
                const end = Math.max(anchorIndex, currentIndex);
                for (let i = start; i <= end; i++) {
                    newSelection.add(itemKey(displayItems[i]));
                }
            } else {
                newSelection.add(key);
            }
        } else {
            // Toggle this item in/out without disturbing others
            if (newSelection.has(key)) {
                newSelection.delete(key);
            } else {
                newSelection.add(key);
            }
        }

        lastSelectedKey = key;
        selectedItems = newSelection;
    }

    // Called by row clicks — plain click selects only this item; modifiers accumulate.
    function handleRowClick(item, event) {
        const key = itemKey(item);
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
            toggleItem(item, event);
            focusedItemKey = key;
            return;
        }
        // Plain click: replace selection with just this item
        selectedItems = new Set([key]);
        lastSelectedKey = key;
        focusedItemKey = key;
    }

    function selectAll() {
        const newSelection = new Set();
        displayItems.forEach((item) => newSelection.add(itemKey(item)));
        selectedItems = newSelection;
    }

    // ---- Rubber-band (drag range) selection ----
    function handleDragSelectPointerDown(e) {
        if (e.button !== 0) return;
        if (isInternalDragging) return;
        // Only start if clicking on the content area background, not on an item or interactive element
        if (e.target.closest('.grid-item, .file-row, .folder-chip, .folders-strip, .empty-state, .drop-overlay, button, input, a')) return;
        e.preventDefault();
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) clearSelection();
        dragSelectActive = true;
        dragSelectRect = { x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY };
        contentAreaEl?.setPointerCapture(e.pointerId);
    }

    function handleDragSelectPointerMove(e) {
        if (!dragSelectActive || !dragSelectRect) return;
        dragSelectRect = { ...dragSelectRect, x2: e.clientX, y2: e.clientY };
        const left = Math.min(dragSelectRect.x1, dragSelectRect.x2);
        const top = Math.min(dragSelectRect.y1, dragSelectRect.y2);
        const right = Math.max(dragSelectRect.x1, dragSelectRect.x2);
        const bottom = Math.max(dragSelectRect.y1, dragSelectRect.y2);
        if (right - left < 4 && bottom - top < 4) return;
        if (!contentAreaEl) return;
        const newSelection = new Set();
        contentAreaEl.querySelectorAll('[data-item-key]').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
                newSelection.add(el.dataset.itemKey);
            }
        });
        selectedItems = newSelection;
    }

    function handleDragSelectPointerUp() {
        if (!dragSelectActive) return;
        dragSelectActive = false;
        dragSelectRect = null;
    }

    // ---- Navigation ----
    function navigateFolder(id) {
        searchQuery = "";
        sidebarOpen = false;
        router.navigateBrowser("drive", id);
        // tab/currentFolderId are updated by the route-sync $effect
    }

    function switchTab(newTab) {
        searchQuery = "";
        sidebarOpen = false;
        router.navigateBrowser(newTab, null);
        // tab/currentFolderId are updated by the route-sync $effect
    }

    function goToInstrumentaTools() {
        window.location.href = "/";
    }

    // ---- File actions ----
    // Accepts a full file/item object (which has .app) or falls back to a plain id lookup.
    function openDocument(itemOrId) {
        const item =
            itemOrId && typeof itemOrId === "object"
                ? itemOrId
                : driveFiles.find((f) => f.id === itemOrId);

        if (!item) return;

        // SVG files (native drawings or uploaded SVG files) open in the SVG editor
        if (
            item.app === APP_SVG ||
            (isBlobFile(item) &&
                (item.mimeType === "image/svg+xml" ||
                    item.name?.toLowerCase().endsWith(".svg")))
        ) {
            router.openSvg(item.id);
            // Other blob files open in the file viewer
        } else if (isBlobFile(item)) {
            openBlobFile(item);
        } else {
            router.openFile(item);
        }
    }

    // Build the correct URL for a file (for "open in new tab")
    function fileUrl(item) {
        return getFileRoute(item?.app ?? DEFAULT_APP, item.id);
    }

    function handleCreateSheet() {
        openModal(PromptModal, {
            title: `New ${getAppName(APP_SHEETS)}`,
            value: getDefaultTitle(APP_SHEETS),
            confirmText: "Create",
            onConfirm: async (title) => {
                try {
                    const doc = await registry.drive.createAndInitializeFile({
                        title,
                        app: APP_SHEETS,
                        folderId: tab === "drive" ? currentFolderId : null,
                        initializer: (ydoc) => initializeSpreadsheet(ydoc),
                    });
                    router.openSheet(doc.id);
                } catch (e) {
                    console.error("Failed to create spreadsheet:", e);
                }
            },
        });
    }

    function handleCreateDoc() {
        openModal(PromptModal, {
            title: `New ${getAppName(APP_DOCS)}`,
            value: getDefaultTitle(APP_DOCS),
            confirmText: "Create",
            onConfirm: async (title) => {
                try {
                    const doc = await registry.drive.createFile({
                        title,
                        app: APP_DOCS,
                        folderId: tab === "drive" ? currentFolderId : null,
                    });
                    router.openDoc(doc.id);
                } catch (e) {
                    console.error("Failed to create document:", e);
                }
            },
        });
    }

    function handleCreateSvg() {
        openModal(PromptModal, {
            title: `New ${getAppName(APP_SVG)}`,
            value: getDefaultTitle(APP_SVG),
            confirmText: "Create",
            onConfirm: async (title) => {
                try {
                    const EMPTY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="640" height="480" viewBox="0 0 640 480"><title>${title}</title></svg>`;
                    const svgBlob = new Blob([EMPTY_SVG], {
                        type: "image/svg+xml",
                    });
                    const doc = await registry.drive.createBlob({
                        title,
                        file: svgBlob,
                        filename: "drawing.svg",
                        app: APP_SVG,
                        folderId: tab === "drive" ? currentFolderId : null,
                    });
                    router.openSvg(doc.id);
                } catch (e) {
                    console.error("Failed to create drawing:", e);
                }
            },
        });
    }

    // ---------- Header "New" dropdown ----------
    let newMenuOpen = $state(false);
    let newMenuRef = $state(null);
    let newMenuTriggerRef = $state(null);

    function toggleNewMenu() { newMenuOpen = !newMenuOpen; }

    function closeNewMenu() { newMenuOpen = false; }

    $effect(() => {
        if (!newMenuOpen) return;
        function onClickOutside(e) {
            if (!newMenuRef?.contains(e.target) && !newMenuTriggerRef?.contains(e.target)) {
                newMenuOpen = false;
            }
        }
        function onKeydown(e) { if (e.key === 'Escape') { newMenuOpen = false; newMenuTriggerRef?.focus(); } }
        document.addEventListener('click', onClickOutside);
        document.addEventListener('keydown', onKeydown);
        return () => {
            document.removeEventListener('click', onClickOutside);
            document.removeEventListener('keydown', onKeydown);
        };
    });

    function handleUploadFiles() {
        openModal(UploadFileModal, {
            folderId: tab === "drive" ? currentFolderId : null,
            onConfirm: async (files, folderId) => {
                for (const f of files) {
                    try {
                        await registry.drive.createBlob({
                            title: f.name,
                            file: f.file,
                            folderId,
                        });
                    } catch (err) {
                        console.error("Failed to upload file:", f.name, err);
                    }
                }
                closeTopModal();
            },
        });
    }

    function openBlobFile(file) {
        if (!isPreviewable(file)) {
            // Non-previewable types (zip, etc.) — download directly
            const a = document.createElement('a');
            a.href = registry.drive.getBlobUrl(file.id);
            a.download = file.filename || file.title || 'download';
            a.click();
            return;
        }
        // Use the stream URL (?action=stream) which the server serves with
        // Content-Disposition: inline, so the browser renders rather than downloads.
        registry.drive.recordOpen(file.id);
        viewingFile = file;
        viewingBlobUrl = registry.drive.getStreamUrl(file.id);
    }

    function closeFileViewer() {
        viewingFile = null;
        viewingBlobUrl = null;
    }

    async function handleCreateFolder() {
        openModal(PromptModal, {
            title: "New Folder",
            label: "Enter a name for the new folder:",
            placeholder: "Folder name",
            confirmText: "Create",
            onConfirm: async (name) => {
                try {
                    await registry.drive.createFolder({
                        name,
                        parentId: tab === "drive" ? currentFolderId : null,
                    });
                } catch (e) {
                    console.error("Failed to create folder:", e);
                }
            },
        });
    }

    function handleRenameFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(PromptModal, {
            title: "Rename",
            value: file.title,
            confirmText: "Rename",
            onConfirm: async (newTitle) => {
                const oldTitle = file.title;
                try {
                    await registry.drive.renameFile(file.id, newTitle);
                    pushUndo({
                        description: `Rename "${oldTitle}" → "${newTitle}"`,
                        undo: async () =>
                            registry.drive.renameFile(file.id, oldTitle),
                        redo: async () =>
                            registry.drive.renameFile(file.id, newTitle),
                    });
                } catch (err) {
                    console.error("Failed to rename:", err);
                }
            },
        });
    }

    function handleDeleteFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(ConfirmModal, {
            title: "Delete document",
            message: `Delete "${file.title || "this document"}"? This cannot be undone.`,
            variant: "danger",
            confirmText: "Delete",
            onConfirm: async () => {
                try {
                    await registry.drive.deleteFile(file.id);
                    pushUndo({
                        description: `Delete "${file.title}"`,
                        undo: async () => registry.drive.restoreFile(file.id),
                        redo: async () => registry.drive.deleteFile(file.id),
                    });
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
                    await registry.drive.moveFile(file.id, targetFolderId);
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

    function handleShareFolder(folder, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(ShareFileModal, { file: folder, itemType: 'folder' });
    }

    function handleDeleteSelected(e) {
        e?.stopPropagation();
        closeContextMenu();
        const items = displayItems.filter((item) => isSelected(item));
        const fileItems = items.filter((i) => i.itemType === "file");
        const folderItems = items.filter((i) => i.itemType === "folder");
        const count = items.length;
        openModal(ConfirmModal, {
            title: `Delete ${count} items`,
            message: `Delete ${count} selected items? This cannot be undone.`,
            variant: "danger",
            confirmText: "Delete",
            onConfirm: async () => {
                for (const f of fileItems) {
                    await registry.drive.deleteFile(f.id).catch(console.error);
                }
                for (const f of folderItems) {
                    await registry.drive.deleteFolder(f.id).catch(console.error);
                }
                clearSelection();
            },
        });
    }

    function handleMoveSelected(e) {
        e?.stopPropagation();
        closeContextMenu();
        const fileItems = displayItems.filter(
            (item) => isSelected(item) && item.itemType === "file",
        );
        if (fileItems.length === 0) return;
        openModal(MoveFileModal, {
            file: fileItems[0],
            onConfirm: async (targetFolderId) => {
                for (const f of fileItems) {
                    await registry.drive
                        .moveFile(f.id, targetFolderId)
                        .catch(console.error);
                }
            },
        });
    }

    function handleVersionHistory(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(VersionHistoryModal, { registry, file });
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
                    await registry.drive.deleteFolder(folder.id);
                    if (currentFolderId === folder.id)
                        currentFolderId = folder.parentId ?? null;
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
            await registry.drive
                .renameFolder(folder.id, trimmed)
                .catch(console.error);
        }
    }

    // ---- Context menu ----
    // Context menu state extended for different areas
    // contextMenu can be: { x, y, item, type: 'file'|'folder', area: 'item'|'content'|'sidebar'|'breadcrumb' }
    // Or for no menu in certain areas, we just prevent default

    function showContextMenu(e, item, type) {
        e.preventDefault();
        e.stopPropagation();
        // If the right-clicked item isn't in the current selection, select only it
        if (!isSelected(item)) {
            selectedItems = new Set([itemKey(item)]);
            lastSelectedKey = itemKey(item);
            focusedItemKey = itemKey(item);
        }
        let x = e.clientX;
        let y = e.clientY;
        if (x + CTX_W > window.innerWidth) x = window.innerWidth - CTX_W - CTX_MENU_MARGIN;
        if (y + CTX_H > window.innerHeight) y = window.innerHeight - CTX_H - CTX_MENU_MARGIN;
        x = Math.max(CTX_MENU_MARGIN, x);
        y = Math.max(CTX_MENU_MARGIN, y);
        contextMenu = { x, y, item, type, area: "item" };
    }

    // Context menu for empty content area
    function showContentContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();

        // Only show in drive tab
        if (tab !== "drive") {
            return;
        }

        let x = e.clientX;
        let y = e.clientY;
        if (x + CTX_W > window.innerWidth) x = window.innerWidth - CTX_W - CTX_MENU_MARGIN;
        if (y + CTX_H > window.innerHeight) y = window.innerHeight - CTX_H - CTX_MENU_MARGIN;
        x = Math.max(CTX_MENU_MARGIN, x);
        y = Math.max(CTX_MENU_MARGIN, y);
        contextMenu = { x, y, type: "content", area: "content" };
    }

    // Context menu for sidebar navigation items
    function showSidebarContextMenu(e, navType) {
        e.preventDefault();
        e.stopPropagation();

        let x = e.clientX;
        let y = e.clientY;
        if (x + CTX_W > window.innerWidth) x = window.innerWidth - CTX_W - CTX_MENU_MARGIN;
        if (y + CTX_H > window.innerHeight) y = window.innerHeight - CTX_H - CTX_MENU_MARGIN;
        x = Math.max(CTX_MENU_MARGIN, x);
        y = Math.max(CTX_MENU_MARGIN, y);
        contextMenu = { x, y, type: navType, area: "sidebar" };
    }

    // Context menu for folder tree items
    function showFolderTreeContextMenu(e, folder) {
        e.preventDefault();
        e.stopPropagation();

        let x = e.clientX;
        let y = e.clientY;
        if (x + CTX_W > window.innerWidth) x = window.innerWidth - CTX_W - CTX_MENU_MARGIN;
        if (y + CTX_H > window.innerHeight) y = window.innerHeight - CTX_H - CTX_MENU_MARGIN;
        x = Math.max(CTX_MENU_MARGIN, x);
        y = Math.max(CTX_MENU_MARGIN, y);
        contextMenu = {
            x,
            y,
            item: folder,
            type: "folder",
            area: "foldertree",
        };
    }

    // Prevent default context menu anywhere in DriveBrowser
    function handleContextMenu(e) {
        // If we're not in a specific handled area, prevent default browser menu
        // but don't show our menu either (for areas like header, toolbar, etc.)
        e.preventDefault();
    }

    function closeContextMenu() {
        contextMenu = null;
    }

    function handleWindowClick() {
        closeContextMenu();
    }

    function handleKeydown(e) {
        const inInput = e.target?.matches?.(
            "input, textarea, [contenteditable]",
        );

        if (e.key === "Escape") {
            if (sidebarOpen) {
                sidebarOpen = false;
            } else if (contextMenu) {
                closeContextMenu();
            } else if (selectedItems.size > 0) {
                clearSelection();
            }
            return;
        }

        if (inInput) return;

        if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
            e.preventDefault();
            undoLast();
            return;
        }

        if (
            (e.key === "y" && (e.ctrlKey || e.metaKey)) ||
            (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey)
        ) {
            e.preventDefault();
            redoLast();
            return;
        }

        if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            selectAll();
            return;
        }

        if (
            e.key === "c" &&
            (e.ctrlKey || e.metaKey) &&
            selectedItems.size > 0
        ) {
            e.preventDefault();
            copySelected("copy");
            return;
        }

        if (
            e.key === "x" &&
            (e.ctrlKey || e.metaKey) &&
            selectedItems.size > 0
        ) {
            e.preventDefault();
            copySelected("cut");
            return;
        }

        // Focus search: '/' or Ctrl/Cmd+F
        if (e.key === "/" || (e.key === "f" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            searchInput?.focus();
            searchInput?.select();
            return;
        }

        // New document: Ctrl/Cmd+N
        if (e.key === "n" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleCreateSheet();
            return;
        }

        // Delete selected single file
        if (e.key === "Delete" && selectedItems.size === 1) {
            const selected = displayItems.find((item) => isSelected(item));
            if (selected?.itemType === "file") {
                handleDeleteFile(selected, null);
            }
            return;
        }

        // Open selected: Enter
        if (e.key === "Enter" && selectedItems.size === 1) {
            const selected = displayItems.find((item) => isSelected(item));
            if (selected) {
                if (selected.itemType === "folder") navigateFolder(selected.id);
                else openDocument(selected);
            }
            return;
        }

        // Arrow key navigation through the list
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (displayItems.length === 0) return;
            const cur =
                lastSelectedKey !== null
                    ? displayItems.findIndex(
                          (i) => itemKey(i) === lastSelectedKey,
                      )
                    : -1;
            const next =
                e.key === "ArrowDown"
                    ? cur < displayItems.length - 1
                        ? cur + 1
                        : 0
                    : cur > 0
                      ? cur - 1
                      : displayItems.length - 1;
            const nextKey = itemKey(displayItems[next]);
            selectedItems = new Set([nextKey]);
            lastSelectedKey = nextKey;
            focusedItemKey = nextKey;
        }
    }

    // ---- Helpers ----
    function formatActivity(item) {
        if (!item._activityAt)
            return formatDate(item.mtime || item.ctime || item.birthtime);
        const label = item._activityType === "modified" ? "Modified" : "Opened";
        return `${label} ${formatDate(item._activityAt)}`;
    }

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
        const username = registry._options?.getUsername?.() ?? "";
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

    function formatLastSync(date) {
        if (!date) return null;
        const diff = Date.now() - new Date(date).getTime();
        if (diff < 60000) return "just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        return `${Math.floor(diff / 3600000)}h ago`;
    }

    function formatBuildTime() {
        // __BUILD_TIME__ is injected by vite config at build time
        if (typeof __BUILD_TIME__ === "undefined") return null;
        const d = new Date(__BUILD_TIME__);
        return d.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }

    // ---- Drag and Drop Upload ----
    function handleDragEnter(e) {
        // Only allow drop in drive tab; ignore when moving internal items
        if (tab !== "drive" || isInternalDragging) return;

        // Check if dragging external files
        if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            dragCounter++;
            isDraggingOver = true;
        }
    }

    function handleDragLeave(e) {
        if (tab !== "drive" || isInternalDragging) return;

        if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                isDraggingOver = false;
            }
        }
    }

    function handleDragOver(e) {
        if (tab !== "drive") return;

        if (!isInternalDragging && e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        } else if (e.dataTransfer?.types?.includes(DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
        }
    }

    async function handleDrop(e) {
        if (tab !== "drive") return;

        // Internal item drop — move to current folder
        const driveData = e.dataTransfer?.getData(DRAG_MIME);
        if (driveData) {
            e.preventDefault();
            isDraggingOver = false;
            isInternalDragging = false;
            dragCounter = 0;
            dropTargetId = null;
            draggingItem = null;
            const { id, itemType } = JSON.parse(driveData);
            if (itemType === "folder") {
                const f = driveFolders.find((x) => x.id === id);
                if (f && f.parentId !== currentFolderId) {
                    const prevParentId = f.parentId;
                    const targetId = currentFolderId;
                    await registry.drive
                        .moveFolder(id, targetId)
                        .catch(console.error);
                    pushUndo({
                        description: `Move folder "${f.name}"`,
                        undo: async () =>
                            registry.drive.moveFolder(id, prevParentId),
                        redo: async () =>
                            registry.drive.moveFolder(id, targetId),
                    });
                }
            } else {
                const f = driveFiles.find((x) => x.id === id);
                if (f && f.folderId !== currentFolderId) {
                    const prevFolderId = f.folderId;
                    const targetId = currentFolderId;
                    await registry.drive
                        .moveFile(id, targetId)
                        .catch(console.error);
                    pushUndo({
                        description: `Move "${f.title}"`,
                        undo: async () =>
                            registry.drive.moveFile(id, prevFolderId),
                        redo: async () => registry.drive.moveFile(id, targetId),
                    });
                }
            }
            return;
        }

        e.preventDefault();
        isDraggingOver = false;
        dragCounter = 0;

        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;

        // Upload files to current folder
        for (const file of files) {
            try {
                await registry.drive.createBlob({
                    title: file.name,
                    file: file,
                    folderId: currentFolderId,
                });
            } catch (err) {
                console.error("Failed to upload file:", file.name, err);
            }
        }
    }

    // ---- Item drag (moving files/folders) ----
    let _hoverExpandTimer = null;
    let _hoverExpandFolderId = null;

    function _clearHoverExpand() {
        clearTimeout(_hoverExpandTimer);
        _hoverExpandTimer = null;
        _hoverExpandFolderId = null;
    }

    function handleItemDragStart(e, item) {
        isInternalDragging = true;
        isDraggingOver = false;
        dragCounter = 0;
        draggingItem = { id: item.id, itemType: item.itemType };
        e.dataTransfer.setData(
            DRAG_MIME,
            JSON.stringify({ id: item.id, itemType: item.itemType }),
        );
        e.dataTransfer.effectAllowed = "move";
    }

    function handleItemDragEnd() {
        isInternalDragging = false;
        draggingItem = null;
        dropTargetId = null;
        _clearHoverExpand();
    }

    function handleFolderDragOver(e, folderId) {
        if (!draggingItem) return;
        // Can't drop a folder onto itself
        if (draggingItem.itemType === "folder" && draggingItem.id === folderId)
            return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        dropTargetId = folderId;

        // Auto-expand after 600ms hover if collapsed and has children
        if (_hoverExpandFolderId !== folderId) {
            _clearHoverExpand();
            _hoverExpandFolderId = folderId;
            if (!expandedFolders.has(folderId) && getChildFolders(folderId).length > 0) {
                _hoverExpandTimer = setTimeout(() => {
                    const next = new Set(expandedFolders);
                    next.add(folderId);
                    expandedFolders = next;
                }, 600);
            }
        }
    }

    function handleFolderDragLeave(e, folderId) {
        // Only clear if leaving the element itself (not a child)
        if (!e.currentTarget.contains(e.relatedTarget)) {
            if (dropTargetId === folderId) dropTargetId = null;
            if (_hoverExpandFolderId === folderId) _clearHoverExpand();
        }
    }

    async function handleDropOnFolder(e, folderId) {
        e.preventDefault();
        e.stopPropagation();
        isInternalDragging = false;
        dropTargetId = null;
        draggingItem = null;
        _clearHoverExpand();

        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (!raw) return;

        const { id, itemType } = JSON.parse(raw);
        const targetId = folderId === ROOT_FOLDER_ID ? null : folderId;

        if (itemType === "folder") {
            const f = driveFolders.find((x) => x.id === id);
            if (!f || f.parentId === targetId) return;
            const prevParentId = f.parentId;
            await registry.drive.moveFolder(id, targetId).catch(console.error);
            pushUndo({
                description: `Move folder "${f.name}"`,
                undo: async () => registry.drive.moveFolder(id, prevParentId),
                redo: async () => registry.drive.moveFolder(id, targetId),
            });
        } else {
            const f = driveFiles.find((x) => x.id === id);
            if (!f || f.folderId === targetId) return;
            const prevFolderId = f.folderId;
            await registry.drive.moveFile(id, targetId).catch(console.error);
            pushUndo({
                description: `Move "${f.title}"`,
                undo: async () => registry.drive.moveFile(id, prevFolderId),
                redo: async () => registry.drive.moveFile(id, targetId),
            });
        }
    }

    // ---- Trash drag-and-drop ----
    function handleTrashDragOver(e) {
        if (!draggingItem) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        isTrashDropTarget = true;
    }

    function handleTrashDragLeave(e) {
        if (!e.currentTarget.contains(e.relatedTarget)) {
            isTrashDropTarget = false;
        }
    }

    async function handleDropOnTrash(e) {
        e.preventDefault();
        e.stopPropagation();
        isTrashDropTarget = false;
        isInternalDragging = false;
        dropTargetId = null;

        const raw = e.dataTransfer?.getData(DRAG_MIME);
        if (!raw) return;

        const { id, itemType } = JSON.parse(raw);
        draggingItem = null;

        if (itemType === "folder") {
            const f = driveFolders.find((x) => x.id === id);
            if (!f) return;
            await registry.drive.deleteFolder(id).catch(console.error);
        } else {
            const f = driveFiles.find((x) => x.id === id);
            if (!f) return;
            await registry.drive.deleteFile(id).catch(console.error);
            pushUndo({
                description: `Delete "${f.title}"`,
                undo: async () => registry.drive.restoreFile(id),
                redo: async () => registry.drive.deleteFile(id),
            });
        }
    }

    // ---- Undo / Redo ----
    function pushUndo(action) {
        undoStack = [...undoStack.slice(-49), action]; // cap at 50 entries
        redoStack = [];
    }

    async function undoLast() {
        if (undoStack.length === 0) return;
        const action = undoStack[undoStack.length - 1];
        undoStack = undoStack.slice(0, -1);
        try {
            await action.undo();
            redoStack = [...redoStack, action];
        } catch (err) {
            console.error("Undo failed:", err);
        }
    }

    async function redoLast() {
        if (redoStack.length === 0) return;
        const action = redoStack[redoStack.length - 1];
        redoStack = redoStack.slice(0, -1);
        try {
            await action.redo();
            undoStack = [...undoStack, action];
        } catch (err) {
            console.error("Redo failed:", err);
        }
    }

    // ---- Clipboard (copy/cut/paste items) ----
    function copySelected(op) {
        const items = displayItems
            .filter((item) => isSelected(item))
            .map((item) => ({ id: item.id, itemType: item.itemType }));
        if (items.length === 0) return;
        clipboard = { items, op };
    }

    async function executePaste() {
        if (!clipboard || clipboard.items.length === 0) return;
        const { items, op } = clipboard;

        if (op === "cut") {
            for (const { id, itemType } of items) {
                if (itemType === "folder") {
                    const f = driveFolders.find((x) => x.id === id);
                    if (f && f.parentId !== currentFolderId)
                        await registry.drive
                            .moveFolder(id, currentFolderId)
                            .catch(console.error);
                } else {
                    const f = driveFiles.find((x) => x.id === id);
                    if (f && f.folderId !== currentFolderId)
                        await registry.drive
                            .moveFile(id, currentFolderId)
                            .catch(console.error);
                }
            }
            clipboard = null; // cut is one-shot
        } else {
            // copy — duplicate each item into current folder
            for (const { id, itemType } of items) {
                if (itemType === "file") {
                    await registry.drive
                        .duplicateFile(id, { folderId: currentFolderId })
                        .catch(console.error);
                } else {
                    const f = driveFolders.find((x) => x.id === id);
                    if (f)
                        await registry.drive
                            .createFolder({
                                name: `Copy of ${f.name}`,
                                parentId: currentFolderId,
                            })
                            .catch(console.error);
                }
            }
        }
    }

    async function handleDuplicateFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        try {
            await registry.drive.duplicateFile(file.id, {
                folderId: file.folderId ?? currentFolderId,
            });
        } catch (err) {
            console.error("Failed to duplicate:", err);
        }
    }

    // ---- Trash actions ----
    async function handleRestoreFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        try {
            await registry.drive.restoreFile(file.id);
        } catch (err) {
            console.error("Failed to restore:", err);
        }
    }

    async function handlePermanentDeleteFile(file, e) {
        e?.stopPropagation();
        closeContextMenu();
        openModal(ConfirmModal, {
            title: "Delete Forever",
            message: `Permanently delete "${file.title || "this file"}"? This cannot be undone.`,
            confirmText: "Delete Forever",
            variant: "danger",
            onConfirm: async () => {
                try {
                    await registry.drive.permanentDeleteFile(file.id);
                } catch (err) {
                    console.error("Failed to permanently delete:", err);
                }
            },
        });
    }

    // ---- Paste Upload ----
    async function handlePaste(e) {
        // Only allow paste in drive tab
        if (tab !== "drive") return;

        // Don't interfere with paste in input fields
        if (e.target?.matches?.("input, textarea, [contenteditable]")) return;

        // Internal clipboard paste (Ctrl+C/X then Ctrl+V)
        if (clipboard && clipboard.items.length > 0) {
            e.preventDefault();
            await executePaste();
            return;
        }

        const items = Array.from(e.clipboardData?.items || []);
        const fileItems = items.filter((item) => item.kind === "file");

        if (fileItems.length === 0) return;

        e.preventDefault();

        for (const item of fileItems) {
            const file = item.getAsFile();
            if (!file) continue;

            // Generate name for pasted files (e.g., "pasted-image.png")
            const ext =
                file.name?.split(".").pop() ||
                file.type?.split("/").pop() ||
                "bin";
            const baseName = file.name || `pasted-${Date.now()}`;
            const name = file.name || `${baseName}.${ext}`;

            try {
                await registry.drive.createBlob({
                    title: name,
                    file: file,
                    folderId: currentFolderId,
                });
            } catch (err) {
                console.error("Failed to upload pasted file:", err);
            }
        }
    }

    function handleToggleOfflineMode() {
        const next = !offlineMode;
        setOfflineMode(next);
        offlineMode = next;
        window.location.reload();
    }
</script>

<svelte:window
    onclick={handleWindowClick}
    onkeydown={handleKeydown}
    onpaste={handlePaste}
/>

<div class="drive-browser" oncontextmenu={handleContextMenu}>
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

        <!-- Sidebar actions -->
        <div class="sidebar-section">
            <button class="tools-home-btn" onclick={goToInstrumentaTools}>
                <span class="tools-home-chevron">{@html chevronRight}</span>
                <img src="/favicon.svg" alt="" />
                <span>Instrumenta</span>
            </button>

            <div class="new-menu-wrap sidebar-new-wrap" bind:this={newMenuTriggerRef}>
                <Button
                    onclick={toggleNewMenu}
                    size="md"
                    icon={plus}
                    iconPosition="left"
                    className="new-btn new-btn-prominent"
                    fullWidth={true}
                >
                    New
                </Button>
                {#if newMenuOpen}
                    <div class="new-menu" bind:this={newMenuRef}>
                        <button class="new-menu-item" onclick={() => { closeNewMenu(); handleCreateSheet(); }}>
                            {@html spreadsheet} New Spreadsheet
                        </button>
                        <button class="new-menu-item" onclick={() => { closeNewMenu(); handleCreateDoc(); }}>
                            {@html fileText} New Document
                        </button>
                        <button class="new-menu-item" onclick={() => { closeNewMenu(); handleCreateSvg(); }}>
                            {@html penTool} New Drawing
                        </button>
                        <div class="new-menu-divider"></div>
                        <button class="new-menu-item" onclick={() => { closeNewMenu(); handleCreateFolder(); }}>
                            {@html newFolder} New Folder
                        </button>
                    </div>
                {/if}
            </div>

            <Button
                onclick={handleUploadFiles}
                icon={upload}
                iconPosition="left"
                variant="secondary"
                className="new-btn"
            >
                Upload Files
            </Button>
        </div>

        <!-- Navigation -->
        <nav class="sidebar-nav">
            <button
                class="nav-item"
                class:active={tab === "recent"}
                onclick={() => switchTab("recent")}
                oncontextmenu={(e) => showSidebarContextMenu(e, "recent")}
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
                    oncontextmenu={(e) => showSidebarContextMenu(e, "drive")}
                >
                    <span class="nav-icon">{@html folder}</span>
                    <span class="nav-label">My Drive</span>
                </button>
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
            </div>

            <!-- Folder Tree — always visible so users can discover the file manager from any tab -->
            {#if rootFolders.length > 0}
                <div class="folder-tree">
                    <FolderTree
                        folders={rootFolders}
                        {currentFolderId}
                        {expandedFolders}
                        onNavigate={navigateFolder}
                        onToggleExpand={toggleFolderExpand}
                        {getChildFolders}
                        {dropTargetId}
                        onFolderDragOver={handleFolderDragOver}
                        onFolderDragLeave={handleFolderDragLeave}
                        onFolderDrop={handleDropOnFolder}
                        onContextMenu={showFolderTreeContextMenu}
                    />
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

            <button
                class="nav-item"
                class:active={tab === "trash"}
                class:drag-target={isTrashDropTarget}
                onclick={() => switchTab("trash")}
                ondragover={handleTrashDragOver}
                ondragleave={handleTrashDragLeave}
                ondrop={handleDropOnTrash}
            >
                <span class="nav-icon">{@html trash}</span>
                <span class="nav-label">Trash</span>
            </button>
        </nav>

        <!-- Sync / status footer -->
        <div class="sidebar-footer">
            <button
                class="sync-btn"
                class:syncing={syncState.isSyncing}
                class:error={syncState.error}
                onclick={() => registry.sync?.()}
                title={syncState.error
                    ? `Sync error: ${syncState.error}`
                    : "Sync now"}
            >
                <span class="sync-icon" class:spin={syncState.isSyncing}
                    >{@html refresh}</span
                >
                <span class="sync-label">
                    {#if syncState.isSyncing}
                        Syncing…
                    {:else if syncState.error}
                        Sync error
                    {:else if syncState.lastSync}
                        Synced {formatLastSync(syncState.lastSync)}
                    {:else}
                        Sync
                    {/if}
                </span>
            </button>
            <button
                class="offline-mode-btn"
                class:active={offlineMode}
                onclick={handleToggleOfflineMode}
                title={offlineMode
                    ? "Offline mode enabled — documents cached locally. Click to disable."
                    : "Offline mode disabled — no local Yjs copies. Click to enable."}
            >
                <span class="offline-mode-indicator" class:on={offlineMode}></span>
                <span class="offline-mode-label">Offline mode</span>
                <span class="offline-mode-status">{offlineMode ? "On" : "Off"}</span>
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
                    <span class="app-icon">{@html penTool}</span>
                    <h1>{appTitle}</h1>
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
                <UserMenu {registry} />
            </div>
        </header>

        <!-- Toolbar -->
        <div class="toolbar">
            <div class="toolbar-left">
                <!-- Undo / Redo -->
                <div class="undo-redo">
                    <button
                        class="undo-btn"
                        disabled={undoStack.length === 0}
                        onclick={undoLast}
                        title={undoStack.length > 0
                            ? `Undo: ${undoStack[undoStack.length - 1].description} (Ctrl+Z)`
                            : "Nothing to undo"}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            ><path d="M9 14 4 9l5-5" /><path
                                d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"
                            /></svg
                        >
                    </button>
                    <button
                        class="undo-btn"
                        disabled={redoStack.length === 0}
                        onclick={redoLast}
                        title={redoStack.length > 0
                            ? `Redo: ${redoStack[redoStack.length - 1].description} (Ctrl+Y)`
                            : "Nothing to redo"}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            ><path d="m15 14 5-5-5-5" /><path
                                d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"
                            /></svg
                        >
                    </button>
                </div>

                <!-- Breadcrumb (desktop only for drive tab) -->
                {#if tab === "drive"}
                    <div class="breadcrumb desktop-only">
                        <button
                            class="crumb"
                            class:drag-target={dropTargetId === ROOT_FOLDER_ID}
                            onclick={() => navigateFolder(null)}
                            ondragover={(e) =>
                                handleFolderDragOver(e, ROOT_FOLDER_ID)}
                            ondragleave={(e) =>
                                handleFolderDragLeave(e, ROOT_FOLDER_ID)}
                            ondrop={(e) =>
                                handleDropOnFolder(e, ROOT_FOLDER_ID)}
                        >
                            <span class="crumb-icon">{@html home}</span>
                            <span>My Drive</span>
                        </button>
                        {#each breadcrumb as crumb, i}
                            <span class="crumb-sep">{@html chevronRight}</span>
                            <button
                                class="crumb"
                                class:last={i === breadcrumb.length - 1}
                                class:drag-target={dropTargetId === crumb.id}
                                onclick={() => navigateFolder(crumb.id)}
                                ondragover={(e) =>
                                    handleFolderDragOver(e, crumb.id)}
                                ondragleave={(e) =>
                                    handleFolderDragLeave(e, crumb.id)}
                                ondrop={(e) => handleDropOnFolder(e, crumb.id)}
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
                        placeholder="Search…"
                        bind:value={searchQuery}
                        bind:this={searchInput}
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
        <div
            class="content-area"
            class:drag-over={isDraggingOver && tab === "drive"}
            class:is-dragging-item={!!draggingItem}
            class:drag-selecting={dragSelectActive}
            bind:this={contentAreaEl}
            ondragenter={handleDragEnter}
            ondragleave={handleDragLeave}
            ondragover={handleDragOver}
            ondrop={handleDrop}
            oncontextmenu={showContentContextMenu}
            onpointerdown={handleDragSelectPointerDown}
            onpointermove={handleDragSelectPointerMove}
            onpointerup={handleDragSelectPointerUp}
        >
            <!-- Drop Zone Overlay -->
            {#if isDraggingOver && tab === "drive"}
                <div class="drop-overlay">
                    <div class="drop-zone">
                        <div class="drop-icon">{@html upload}</div>
                        <div class="drop-text">Drop files to upload</div>
                        <div class="drop-hint">
                            Files will be uploaded to
                            {#if currentFolderId}
                                "{driveFolders.find(
                                    (f) => f.id === currentFolderId,
                                )?.name || "My Drive"}"
                            {:else}
                                My Drive
                            {/if}
                        </div>
                    </div>
                </div>
            {/if}
            <!-- Rubber-band selection rect -->
            {#if dragSelectActive && dragSelectRect}
                <div
                    class="drag-select-rect"
                    style="left:{Math.min(dragSelectRect.x1,dragSelectRect.x2)}px;top:{Math.min(dragSelectRect.y1,dragSelectRect.y2)}px;width:{Math.abs(dragSelectRect.x2-dragSelectRect.x1)}px;height:{Math.abs(dragSelectRect.y2-dragSelectRect.y1)}px"
                ></div>
            {/if}
            <!-- Folders quick-access strip on Recent tab -->
            {#if tab === "recent" && !searchQuery && rootFolders.length > 0}
                <div class="folders-strip">
                    <div class="folders-strip-header">
                        <span class="folders-strip-label">{@html folder} Folders</span>
                        <button class="folders-strip-link" onclick={() => switchTab("drive")}>
                            My Drive →
                        </button>
                    </div>
                    <div class="folders-strip-items">
                        {#each rootFolders.slice(0, 8) as f (f.id)}
                            <button
                                class="folder-chip"
                                onclick={() => navigateFolder(f.id)}
                                oncontextmenu={(e) => showFolderTreeContextMenu(e, f)}
                            >
                                <span class="folder-chip-icon">{@html folder}</span>
                                <span class="folder-chip-name">{f.name}</span>
                            </button>
                        {/each}
                        {#if rootFolders.length > 8}
                            <button class="folder-chip folder-chip-more" onclick={() => switchTab("drive")}>
                                +{rootFolders.length - 8} more
                            </button>
                        {/if}
                    </div>
                </div>
            {/if}

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
                    {:else if tab === "trash"}
                        <h2>Trash is empty</h2>
                        <p>Deleted files will appear here</p>
                    {:else if tab === "shared"}
                        <h2>No shared files</h2>
                        <p>Files shared with you will appear here</p>
                    {:else if tab === "recent"}
                        <h2>No recent files</h2>
                        <p>Files you've opened recently will appear here</p>
                        <div class="empty-actions">
                            <Button
                                onclick={handleCreateSheet}
                                icon={plus}
                                iconPosition="left"
                            >
                                New Spreadsheet
                            </Button>
                            <Button
                                onclick={handleCreateDoc}
                                icon={plus}
                                iconPosition="left"
                                variant="secondary"
                            >
                                New Document
                            </Button>
                            <Button
                                onclick={handleCreateSvg}
                                icon={plus}
                                iconPosition="left"
                                variant="secondary"
                            >
                                New Drawing
                            </Button>
                        </div>
                    {:else}
                        <h2>No files yet</h2>
                        <p>
                            Create a spreadsheet, document, or drawing to get
                            started
                        </p>
                        <div class="empty-actions">
                            <Button
                                onclick={handleCreateSheet}
                                icon={plus}
                                iconPosition="left"
                            >
                                New Spreadsheet
                            </Button>
                            <Button
                                onclick={handleCreateDoc}
                                icon={plus}
                                iconPosition="left"
                                variant="secondary"
                            >
                                New Document
                            </Button>
                            <Button
                                onclick={handleCreateSvg}
                                icon={plus}
                                iconPosition="left"
                                variant="secondary"
                            >
                                New Drawing
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
                        <colgroup>
                            <col class="col-check" />
                            <col class="col-name" />
                            {#if !isMobile}
                                <col class="col-owner" />
                            {/if}
                            <col class="col-modified" />
                            <col class="col-actions" />
                        </colgroup>
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
                                <th class="col-name">
                                    <button
                                        class="sort-header"
                                        onclick={() => toggleSort("name")}
                                    >
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
                                    </button>
                                </th>
                                {#if !isMobile}
                                    <th class="col-owner">
                                        <button
                                            class="sort-header"
                                            onclick={() => toggleSort("owner")}
                                        >
                                            <span>Owner</span>
                                            {#if sortColumn === "owner"}
                                                <span class="sort-icon"
                                                    >{@html sortDirection ===
                                                    "asc"
                                                        ? sortAsc
                                                        : sortDesc}</span
                                                >
                                            {:else}
                                                <span
                                                    class="sort-icon placeholder"
                                                    >{@html sortAsc}</span
                                                >
                                            {/if}
                                        </button>
                                    </th>
                                {/if}
                                <th class="col-modified">
                                    <button
                                        class="sort-header"
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
                                    </button>
                                </th>
                                <th class="col-actions"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each displayItems as item, index (itemKey(item))}
                                <tr
                                    class="file-row"
                                    data-item-key={itemKey(item)}
                                    class:selected={isSelected(item)}
                                    class:folder-row={item.itemType ===
                                        "folder"}
                                    class:drag-target={item.itemType ===
                                        "folder" && dropTargetId === item.id}
                                    class:focused={focusedItemKey ===
                                        itemKey(item)}
                                    class:dragging={draggingItem?.id ===
                                        item.id}
                                    draggable={tab !== "trash"}
                                    ondragstart={(e) => {
                                        if (tab !== "trash")
                                            handleItemDragStart(e, item);
                                    }}
                                    ondragend={handleItemDragEnd}
                                    ondragover={(e) => {
                                        if (
                                            tab !== "trash" &&
                                            item.itemType === "folder"
                                        )
                                            handleFolderDragOver(e, item.id);
                                    }}
                                    ondragleave={(e) => {
                                        if (
                                            tab !== "trash" &&
                                            item.itemType === "folder"
                                        )
                                            handleFolderDragLeave(e, item.id);
                                    }}
                                    ondrop={(e) => {
                                        if (
                                            tab !== "trash" &&
                                            item.itemType === "folder"
                                        )
                                            handleDropOnFolder(e, item.id);
                                    }}
                                    onclick={(e) => handleRowClick(item, e)}
                                    ondblclick={() => {
                                        if (item.itemType === "folder") {
                                            navigateFolder(item.id);
                                        } else {
                                            openDocument(item);
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
                                                style={isBlobFile(item)
                                                    ? `color: ${getFileCategory(item.mimeType)?.color || "#6b7280"}`
                                                    : item.itemType !== "folder"
                                                    ? `color: ${getAppType(item.app ?? DEFAULT_APP).color}`
                                                    : ""}
                                            >
                                                {#if item.itemType === "folder"}
                                                    {@html folder}
                                                {:else if isBlobFile(item)}
                                                    {@html icons[
                                                        getFileIcon(item)
                                                    ] || file}
                                                {:else if item.app === APP_DOCS}
                                                    {@html fileText}
                                                {:else if item.app === APP_SVG}
                                                    {@html penTool}
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
                                    {#if !isMobile}
                                        <td class="col-owner"
                                            >{getOwnerName(item)}</td
                                        >
                                    {/if}
                                    <td class="col-modified"
                                        >{tab === "recent"
                                            ? formatActivity(item)
                                            : formatDate(
                                                  item.mtime ||
                                                      item.ctime ||
                                                      item.birthtime,
                                              )}</td
                                    >
                                    <td class="col-actions">
                                        <div class="row-actions">
                                            {#if tab === "trash"}
                                                <button
                                                    class="action-btn"
                                                    title="Restore"
                                                    onclick={(e) =>
                                                        handleRestoreFile(
                                                            item,
                                                            e,
                                                        )}
                                                >
                                                    {@html refresh}
                                                </button>
                                                <button
                                                    class="action-btn danger"
                                                    title="Delete forever"
                                                    onclick={(e) =>
                                                        handlePermanentDeleteFile(
                                                            item,
                                                            e,
                                                        )}
                                                >
                                                    {@html trash}
                                                </button>
                                            {:else}
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
                                            {/if}
                                        </div>
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
                            data-item-key={itemKey(item)}
                            class:selected={isSelected(item)}
                            class:focused={focusedItemKey === itemKey(item)}
                            class:folder={item.itemType === "folder"}
                            class:drag-target={item.itemType === "folder" &&
                                dropTargetId === item.id}
                            class:dragging={draggingItem?.id === item.id}
                            draggable={tab !== "trash"}
                            ondragstart={(e) => {
                                if (tab !== "trash")
                                    handleItemDragStart(e, item);
                            }}
                            ondragend={handleItemDragEnd}
                            ondragover={(e) => {
                                if (
                                    tab !== "trash" &&
                                    item.itemType === "folder"
                                )
                                    handleFolderDragOver(e, item.id);
                            }}
                            ondragleave={(e) => {
                                if (
                                    tab !== "trash" &&
                                    item.itemType === "folder"
                                )
                                    handleFolderDragLeave(e, item.id);
                            }}
                            ondrop={(e) => {
                                if (
                                    tab !== "trash" &&
                                    item.itemType === "folder"
                                )
                                    handleDropOnFolder(e, item.id);
                            }}
                            onclick={(e) => handleRowClick(item, e)}
                            ondblclick={() => {
                                if (item.itemType === "folder") {
                                    navigateFolder(item.id);
                                } else {
                                    openDocument(item);
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
                            <div
                                class="grid-item-icon"
                                style={isBlobFile(item) && !item.thumbnailKey
                                    ? `color: ${getFileCategory(item.mimeType)?.color || "#6b7280"}`
                                    : !isBlobFile(item) && item.itemType !== "folder" && !item.thumbnailKey
                                    ? `color: ${getAppType(item.app ?? DEFAULT_APP).color}`
                                    : ""}
                            >
                                {#if item.itemType === "folder"}
                                    {@html folder}
                                {:else if item.thumbnailKey}
                                    <img
                                        class="grid-item-thumbnail"
                                        src={registry.drive.getThumbnailUrl(
                                            item.id,
                                        )}
                                        alt=""
                                        loading="lazy"
                                        draggable="false"
                                    />
                                {:else if isBlobFile(item)}
                                    {@html icons[getFileIcon(item)] || file}
                                {:else if item.app === APP_DOCS}
                                    {@html fileText}
                                {:else if item.app === APP_SVG}
                                    {@html penTool}
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
                                {getOwnerName(item)} · {tab === "recent"
                                    ? formatActivity(item)
                                    : formatDate(
                                          item.mtime ||
                                              item.ctime ||
                                              item.birthtime,
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
                {#if formatBuildTime()}
                    <span class="status-build">Build: {formatBuildTime()}</span>
                {/if}
            </div>
        </footer>
    </div>
</div>

<!-- Context menu -->
{#if contextMenu}
    <div
        class="context-menu"
        class:mobile={isMobile}
        style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
        onclick={(e) => e.stopPropagation()}
    >
        {#if contextMenu.area === "content"}
            <!-- Empty content area context menu -->
            <button
                class="ctx-item"
                onclick={() => {
                    closeContextMenu();
                    handleCreateSheet();
                }}
            >
                {@html spreadsheet} New Spreadsheet
            </button>
            <button
                class="ctx-item"
                onclick={() => {
                    closeContextMenu();
                    handleCreateDoc();
                }}
            >
                {@html fileText} New Document
            </button>
            <button
                class="ctx-item"
                onclick={() => {
                    closeContextMenu();
                    handleCreateSvg();
                }}
            >
                {@html penTool} New Drawing
            </button>
            <button
                class="ctx-item"
                onclick={() => {
                    closeContextMenu();
                    handleCreateFolder();
                }}
            >
                {@html newFolder} New Folder
            </button>
            <hr class="ctx-sep" />
            <button
                class="ctx-item"
                onclick={() => {
                    closeContextMenu();
                    handleUploadFiles();
                }}
            >
                {@html upload} Upload Files
            </button>
            {#if clipboard && clipboard.items.length > 0}
                <hr class="ctx-sep" />
                <button
                    class="ctx-item"
                    onclick={async () => {
                        closeContextMenu();
                        await executePaste();
                    }}
                >
                    {@html arrowRight} Paste
                </button>
            {/if}
        {:else if contextMenu.area === "item" && selectedItems.size > 1}
            <div class="ctx-header">{selectedItems.size} items selected</div>
            {#if displayItems.some((i) => isSelected(i) && i.itemType === "file")}
                <button class="ctx-item" onclick={handleMoveSelected}>
                    {@html move} Move to…
                </button>
            {/if}
            <hr class="ctx-sep" />
            <button class="ctx-item danger" onclick={handleDeleteSelected}>
                {@html trash} Delete {selectedItems.size} items
            </button>
        {:else if contextMenu.type === "file" && tab === "trash"}
            <button
                class="ctx-item"
                onclick={(e) => handleRestoreFile(contextMenu.item, e)}
            >
                {@html refresh} Restore
            </button>
            <hr class="ctx-sep" />
            <button
                class="ctx-item danger"
                onclick={(e) => handlePermanentDeleteFile(contextMenu.item, e)}
            >
                {@html trash} Delete Forever
            </button>
        {:else if contextMenu.type === "file"}
            <button
                class="ctx-item"
                onclick={() => {
                    openDocument(contextMenu.item);
                    closeContextMenu();
                }}
            >
                {@html arrowRight} Open
            </button>
            <button
                class="ctx-item"
                onclick={() => {
                    window.open(fileUrl(contextMenu.item), "_blank");
                    closeContextMenu();
                }}
            >
                {@html externalLink} Open in new tab
            </button>
            <button
                class="ctx-item"
                onclick={(e) => handleRenameFile(contextMenu.item, e)}
            >
                {@html edit} Rename
            </button>
            <button
                class="ctx-item"
                onclick={(e) => handleDuplicateFile(contextMenu.item, e)}
            >
                {@html copy} Duplicate
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
            {#if !isBlobFile(contextMenu.item)}
                <button
                    class="ctx-item"
                    onclick={(e) => handleVersionHistory(contextMenu.item, e)}
                >
                    {@html clock} Version History…
                </button>
            {/if}
            <hr class="ctx-sep" />
            <button
                class="ctx-item danger"
                onclick={(e) => handleDeleteFile(contextMenu.item, e)}
            >
                {@html trash} Delete
            </button>
        {:else if contextMenu.type === "folder" || contextMenu.area === "foldertree"}
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
            <button
                class="ctx-item"
                onclick={(e) => handleShareFolder(contextMenu.item, e)}
            >
                {@html share} Share…
            </button>
            <hr class="ctx-sep" />
            <button
                class="ctx-item danger"
                onclick={(e) => handleDeleteFolder(contextMenu.item, e)}
            >
                {@html trash} Delete
            </button>
        {:else if contextMenu.area === "sidebar"}
            <!-- Sidebar nav items - minimal menu -->
            {#if contextMenu.type === "drive"}
                <button
                    class="ctx-item"
                    onclick={() => {
                        closeContextMenu();
                        handleCreateFolder();
                    }}
                >
                    {@html newFolder} New Folder
                </button>
            {/if}
        {/if}
    </div>
{/if}

<!-- File Viewer Overlay -->
{#if viewingFile && viewingBlobUrl}
    <div class="file-viewer-overlay">
        <FileViewer
            file={viewingFile}
            blobUrl={viewingBlobUrl}
            onClose={closeFileViewer}
        />
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
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .new-btn {
        width: 100%;
    }

    .tools-home-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        height: 2rem;
        padding: 0 0.125rem;
        border: none;
        border-radius: 0;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.8rem;
        font-weight: 600;
        text-align: left;
        cursor: pointer;
        transition:
            color 0.15s,
            transform 0.15s;
    }

    .tools-home-btn:hover {
        color: var(--color-text);
    }

    .tools-home-btn:active {
        transform: translateY(1px);
    }

    .tools-home-btn img {
        width: 1rem;
        height: 1rem;
        flex-shrink: 0;
    }

    .tools-home-btn span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tools-home-chevron {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-text-muted);
        transform: rotate(180deg);
        transition: transform 0.15s, color 0.15s;
    }

    .tools-home-chevron :global(svg) {
        width: 0.95rem;
        height: 0.95rem;
    }

    .tools-home-btn:hover .tools-home-chevron {
        color: var(--color-text);
        transform: translateX(-2px) rotate(180deg);
    }

    .sidebar-new-wrap {
        width: 100%;
    }

    .new-btn-prominent {
        box-shadow: 0 1px 0 rgba(0, 0, 0, 0.2), 0 6px 14px rgba(0, 119, 255, 0.2);
        font-weight: 600;
    }

    .new-btn-prominent:hover {
        filter: brightness(1.04);
    }

    .new-btn-prominent:active {
        transform: translateY(1px);
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

    .nav-item.drag-target {
        background: color-mix(in srgb, var(--color-danger, #dc2626) 12%, transparent);
        color: var(--color-danger, #dc2626);
        outline: 2px solid var(--color-danger, #dc2626);
        outline-offset: -2px;
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

    .sync-icon {
        display: flex;
        align-items: center;
        flex-shrink: 0;
    }

    .sync-label {
        flex: 1;
        text-align: left;
    }

    .offline-mode-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.4rem 0.75rem;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s;
        margin-top: 0.125rem;
    }

    .offline-mode-btn:hover {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .offline-mode-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--color-border);
        flex-shrink: 0;
        transition: background 0.15s;
    }

    .offline-mode-indicator.on {
        background: var(--color-success, #2ecc71);
    }

    .offline-mode-label {
        flex: 1;
        text-align: left;
    }

    .offline-mode-status {
        font-size: 0.6875rem;
        opacity: 0.7;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .sync-icon.spin :global(svg) {
        animation: spin 1s linear infinite;
    }

    .sync-btn.syncing {
        color: var(--color-primary);
    }

    .sync-btn.error {
        color: var(--color-error, #ef4444);
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

    .new-menu-wrap {
        position: relative;
    }

    .new-menu {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        min-width: 100%;
        z-index: 200;
        overflow: hidden;
    }

    .new-menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 14px;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 13px;
        color: var(--color-text);
        text-align: left;
        white-space: nowrap;
    }
    .new-menu-item:hover { background: var(--color-bg-secondary); }
    .new-menu-item :global(svg) { width: 15px; height: 15px; flex-shrink: 0; opacity: 0.7; }
    .new-menu-divider { height: 1px; background: var(--color-border); margin: 4px 0; }

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
        flex-wrap: wrap;
        gap: 0.125rem;
        font-size: 0.8125rem;
        line-height: 1;
    }

    .crumb {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.25rem 0.5rem;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: 4px;
        font-size: 0.8125rem;
        line-height: 1;
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

    .crumb.drag-target {
        background: color-mix(in srgb, var(--color-primary) 20%, transparent);
        color: var(--color-primary);
        outline: 2px solid var(--color-primary);
        outline-offset: -2px;
        box-shadow: 0 0 12px
            color-mix(in srgb, var(--color-primary) 40%, transparent);
    }

    /* Mute non-droppable crumbs when dragging */
    .crumb:not(.drag-target):not(.last) {
        opacity: 1;
        transition: opacity 0.2s;
    }

    .breadcrumb:has(.drag-target) .crumb:not(.drag-target) {
        opacity: 0.4;
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
        display: inline-flex;
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

    .content-area.drag-selecting {
        user-select: none;
        cursor: default;
    }

    /* Folders strip (Recent tab) */
    .folders-strip {
        padding: 1rem 0 0;
        border-bottom: 1px solid var(--color-border);
        margin-bottom: 0.25rem;
    }

    .folders-strip-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.625rem;
    }

    .folders-strip-label {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--color-text-muted);
    }

    .folders-strip-label :global(svg) {
        width: 13px;
        height: 13px;
    }

    .folders-strip-link {
        font-size: 0.75rem;
        color: var(--color-primary, #3b82f6);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
    }

    .folders-strip-link:hover {
        text-decoration: underline;
    }

    .folders-strip-items {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        padding-bottom: 0.875rem;
    }

    .folder-chip {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.375rem 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: 20px;
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 0.8125rem;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
        max-width: 160px;
    }

    .folder-chip:hover {
        background: var(--color-fill);
        border-color: var(--color-border-strong, var(--color-border));
    }

    .folder-chip-icon {
        display: flex;
        color: var(--color-text-muted);
        flex-shrink: 0;
    }

    .folder-chip-icon :global(svg) {
        width: 14px;
        height: 14px;
    }

    .folder-chip-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .folder-chip-more {
        color: var(--color-text-muted);
        font-style: italic;
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
        table-layout: fixed;
    }

    .file-table col.col-check {
        width: 2.5rem;
    }

    .file-table col.col-name {
        width: auto;
    }

    .file-table col.col-owner {
        width: 11rem;
    }

    .file-table col.col-modified {
        width: 9.5rem;
    }

    .file-table col.col-actions {
        width: 4.25rem;
    }

    .file-table thead {
        position: sticky;
        top: 0;
        background: var(--color-bg);
        z-index: 1;
    }

    .file-table th,
    .file-table td {
        box-sizing: border-box;
    }

    .file-table th {
        text-align: left;
        padding: 0.5rem 0.5rem;
        font-weight: 500;
        color: var(--color-text-secondary);
        border-bottom: 1px solid var(--color-border);
        white-space: nowrap;
        vertical-align: middle;
    }

    .sort-header {
        display: inline-flex;
        align-items: center;
        gap: 0.125rem;
        border: none;
        background: transparent;
        padding: 0;
        font: inherit;
        color: inherit;
        cursor: pointer;
        user-select: none;
        transition: color 0.15s;
    }

    .sort-header:hover {
        color: var(--color-text);
    }

    .file-table th.col-check,
    .file-table td.col-check {
        text-align: center !important;
    }

    .file-table th.col-check {
        cursor: default !important;
    }

    .file-table th.col-check:hover {
        color: var(--color-text-secondary);
    }

    .col-name-content {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
    }

    .file-table th.col-actions {
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

    .file-row.focused {
        background: var(--color-fill);
    }

    .file-row.selected {
        background: var(--color-primary-soft);
    }

    .file-row.drag-target {
        background: color-mix(in srgb, var(--color-primary) 20%, transparent);
        outline: 2px solid var(--color-primary);
        outline-offset: -2px;
        box-shadow: 0 0 16px
            color-mix(in srgb, var(--color-primary) 30%, transparent);
    }

    .file-row.dragging {
        opacity: 0.4;
    }

    /* Mute non-folder items when dragging internal items */
    .content-area.is-dragging-item
        .file-row:not(.folder-row):not(.drag-target):not(.dragging) {
        opacity: 0.4;
        pointer-events: none;
    }

    .content-area.is-dragging-item .file-row.folder-row:not(.drag-target) {
        opacity: 0.6;
    }

    .file-row td {
        padding: 0.5rem 0.5rem;
        border-bottom: 1px solid var(--color-border);
        vertical-align: middle;
        height: 40px;
    }

    .file-row .col-check {
        text-align: center;
        padding: 0.5rem 0.25rem;
    }

    .file-row .col-check input {
        margin: 0;
        vertical-align: middle;
    }

    .file-row .col-actions {
        padding-right: 0.375rem;
    }

    .row-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.125rem;
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

    .item-icon.spreadsheet {
        color: #22c55e;
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

    .file-row .col-owner,
    .file-row .col-modified {
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

    .file-row:hover .action-btn,
    .file-row.focused .action-btn,
    .file-row.selected .action-btn {
        opacity: 1;
    }

    .action-btn:hover {
        background: var(--color-fill-secondary);
        color: var(--color-text);
    }

    .action-btn.danger:hover {
        background: var(--color-danger-fill, #fee2e2);
        color: var(--color-danger, #dc2626);
    }

    /* Undo / Redo */
    .undo-redo {
        display: flex;
        gap: 2px;
        margin-right: 4px;
    }

    .undo-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: 5px;
        padding: 0;
        transition:
            background 0.1s,
            color 0.1s;
    }

    .undo-btn svg {
        width: 16px;
        height: 16px;
    }

    .undo-btn:hover:not(:disabled) {
        background: var(--color-fill);
        color: var(--color-text);
    }

    .undo-btn:disabled {
        opacity: 0.35;
        cursor: default;
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

    .grid-item.focused {
        border-color: var(--color-primary);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }

    .grid-item.selected {
        border-color: var(--color-primary);
        background: var(--color-primary-soft);
    }

    .grid-item.drag-target {
        border-color: var(--color-primary);
        background: color-mix(in srgb, var(--color-primary) 15%, transparent);
        outline: 2px solid var(--color-primary);
        outline-offset: -2px;
        box-shadow: 0 0 20px
            color-mix(in srgb, var(--color-primary) 25%, transparent);
    }

    .grid-item.dragging {
        opacity: 0.4;
    }

    /* Mute non-folder grid items when dragging internal items */
    .content-area.is-dragging-item
        .grid-item:not(.folder):not(.drag-target):not(.dragging) {
        opacity: 0.4;
        pointer-events: none;
    }

    .content-area.is-dragging-item .grid-item.folder:not(.drag-target) {
        opacity: 0.6;
    }

    .grid-item-check {
        position: absolute;
        top: 0.5rem;
        left: 0.5rem;
        opacity: 0;
        transition: opacity 0.15s;
    }

    .grid-item:hover .grid-item-check,
    .grid-item.focused .grid-item-check,
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

    .grid-item.spreadsheet .grid-item-icon {
        color: #22c55e;
    }

    .grid-item:not(.folder):not(.spreadsheet) .grid-item-icon {
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

    .status-build {
        color: var(--color-text-muted);
        font-size: 0.6875rem;
        margin-left: auto;
        padding-left: 1rem;
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

    .ctx-header {
        padding: 0.375rem 0.75rem 0.25rem;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text-secondary);
        pointer-events: none;
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
    @media (max-width: 600px) {
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

        .file-table col.col-modified {
            width: 7.25rem;
        }

        .file-table col.col-actions {
            width: 3.25rem;
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

    /* File Viewer Overlay */
    .file-viewer-overlay {
        position: fixed;
        inset: 0;
        z-index: 1001;
        background: var(--color-bg);
    }

    /* Rubber-band selection rect */
    .drag-select-rect {
        position: fixed;
        border: 1px solid var(--color-primary, #3b82f6);
        background: color-mix(in srgb, var(--color-primary, #3b82f6) 10%, transparent);
        pointer-events: none;
        z-index: 200;
        border-radius: 2px;
    }

    /* Drag and Drop Styles */
    .content-area.drag-over {
        position: relative;
    }

    .drop-overlay {
        position: absolute;
        inset: 0;
        background: color-mix(in srgb, var(--color-primary) 5%, transparent);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
        pointer-events: none;
    }

    .drop-zone {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 2rem 3rem;
        border: 2px dashed var(--color-primary);
        border-radius: 12px;
        background: color-mix(in srgb, var(--color-primary) 8%, transparent);
    }

    .drop-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 3rem;
        height: 3rem;
        color: var(--color-primary);
        margin-bottom: 0.75rem;
    }

    .drop-icon :global(svg) {
        width: 2.5rem;
        height: 2.5rem;
    }

    .drop-text {
        font-size: 1.125rem;
        font-weight: 600;
        color: var(--color-primary);
        margin-bottom: 0.25rem;
    }

    .drop-hint {
        font-size: 0.8125rem;
        color: var(--color-text-secondary);
    }
</style>
