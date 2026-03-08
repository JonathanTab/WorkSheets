<?php
/**
 * Document Manager API Reference (SQLite Edition)
 * ============================================================================
 * This API provides robust document management for collaborative editing.
 * It ensures data integrity, race-free room creation, and atomic metadata writes
 * using a SQLite backend with WAL (Write-Ahead Logging) mode.
 *
 * FEATURES:
 * - User-owned folder tree with hierarchical organization
 * - Folder sharing with recursive permission propagation
 * - Two document types: yjs (collaborative) and blob (binary files)
 * - Full-state sync for offline-first clients
 * ============================================================================
 *
 * AUTHENTICATION
 * ==============
 * Handled via iauth.php. Supports session-based or API key-based (?apikey=...) auth.
 * The $authorized_user variable and instrumenta_get_users() is provided by the authentication layer.
 *
 * BASE URL & METHODS
 * ==================
 * Base URL: https://instrumenta.cf/api/congruum-doc-manager.php
 *
 * IMPORTANT:
 * - Read-only actions (list, access, generate_id, full_sync) use GET.
 * - Write/Modify actions (create, rename, share, revoke, delete, create_version, etc.) REQUIRE POST.
 * - Responses are ALWAYS JSON-encoded.
 *
 * CORE INVARIANTS
 * ===============
 * 1. One (doc_id, version) maps to exactly one room_id.
 * 2. Room IDs are immutable once created and unique across the system.
 * 3. Soft-deletion is used to prevent room ID resurrection and maintain history.
 * 4. Permissions (Read/Write) are strictly enforced at the database level.
 * 5. Folder permissions propagate recursively to all documents and subfolders.
 *
 * API ENDPOINTS
 * =============
 *
 * DOCUMENT OPERATIONS:
 * - create: Create a new document (yjs or blob type)
 * - list: List all accessible documents
 * - list_by_app: List documents filtered by app
 * - rename: Rename a document
 * - share: Share a document with a user
 * - revoke: Revoke a user's access to a document
 * - delete: Soft-delete a document
 * - permanent_delete: Permanently delete a document
 * - restore: Restore a soft-deleted document
 * - access: Get document metadata and room ID
 * - create_version: Create a new version of a document
 * - move_document: Move a document to a different folder
 * - generate_id: Generate a random ID
 *
 * FOLDER OPERATIONS:
 * - create_folder: Create a new folder
 * - rename_folder: Rename a folder
 * - delete_folder: Delete an empty folder
 * - move_folder: Move a folder to a different parent
 * - share_folder: Share a folder with a user
 * - revoke_folder_share: Revoke a user's access to a folder
 *
 * SYNC:
 * - full_sync: Get all documents and folders accessible to the user
 */

define('DATA_ROOT', dirname(__DIR__) . '/data/congruum-docs/');
require_once "iauth.php";
define('DB_FILE', DATA_ROOT . 'congruum-docs.sqlite');
define('DOCS_JSON_FILE', DATA_ROOT . 'congruum-docs.json');
define('BLOBS_DIR', DATA_ROOT . 'blobs/');

header('Content-Type: application/json');

/**
 * Initialize SQLite Database
 */
if (!is_dir(DATA_ROOT)) {
    mkdir(DATA_ROOT, 0777, true);
}

if (!is_dir(BLOBS_DIR)) {
    mkdir(BLOBS_DIR, 0777, true);
}

try {
    $db = new PDO("sqlite:" . DB_FILE, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);

    // Enable WAL mode for concurrency and enforce foreign keys
    $db->exec("PRAGMA journal_mode=WAL;");
    $db->exec("PRAGMA foreign_keys=ON;");

    // Initialize Core Schema
    $db->exec("
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            app TEXT,
            title TEXT NOT NULL,
            deleted INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            type TEXT NOT NULL DEFAULT 'yjs',
            folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
            blob_key TEXT UNIQUE,
            mime_type TEXT,
            size INTEGER DEFAULT 0,
            filename TEXT
        );

        CREATE TABLE IF NOT EXISTS document_versions (
            document_id TEXT NOT NULL,
            version TEXT NOT NULL,
            room_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (document_id, version),
            UNIQUE (room_id),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS document_shares (
            document_id TEXT NOT NULL,
            username TEXT NOT NULL,
            can_read INTEGER NOT NULL DEFAULT 1,
            can_write INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (document_id, username),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            parent_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS folder_shares (
            folder_id TEXT NOT NULL,
            username TEXT NOT NULL,
            can_read INTEGER NOT NULL DEFAULT 1,
            can_write INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (folder_id, username),
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS folder_closure (
            ancestor_id TEXT NOT NULL,
            descendant_id TEXT NOT NULL,
            depth INTEGER NOT NULL,
            PRIMARY KEY (ancestor_id, descendant_id),
            FOREIGN KEY (ancestor_id) REFERENCES folders(id) ON DELETE CASCADE,
            FOREIGN KEY (descendant_id) REFERENCES folders(id) ON DELETE CASCADE
        );
    ");

    // Create indexes for performance (only for columns that exist in the initial schema)
    $db->exec("
        CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
        CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
        CREATE INDEX IF NOT EXISTS idx_folder_shares_user ON folder_shares(username);
        CREATE INDEX IF NOT EXISTS idx_folder_closure_descendant ON folder_closure(descendant_id);
        CREATE INDEX IF NOT EXISTS idx_folder_closure_ancestor ON folder_closure(ancestor_id);
        CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
        CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner);
    ");

    // Add new columns to existing documents table if they don't exist
    $columns = $db->query("PRAGMA table_info(documents)")->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('type', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN type TEXT NOT NULL DEFAULT 'yjs'");
    }
    if (!in_array('folder_id', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT");
    }
    if (!in_array('blob_key', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN blob_key TEXT");
        // Create unique index separately (SQLite doesn't support UNIQUE in ALTER TABLE)
        $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_blob_key ON documents(blob_key) WHERE blob_key IS NOT NULL");
    }
    if (!in_array('mime_type', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN mime_type TEXT");
    }
    if (!in_array('size', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN size INTEGER DEFAULT 0");
    }
    if (!in_array('filename', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN filename TEXT");
    }
    if (!in_array('scope', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN scope TEXT NOT NULL DEFAULT 'drive'");
    }
    if (!in_array('public_read', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN public_read INTEGER DEFAULT 0");
    }
    if (!in_array('public_write', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN public_write INTEGER DEFAULT 0");
    }
    if (!in_array('parent_id', $columns)) {
        $db->exec("ALTER TABLE documents ADD COLUMN parent_id TEXT REFERENCES documents(id) ON DELETE CASCADE");
    }

    // Add new columns to folders table if they don't exist
    $folderColumns = $db->query("PRAGMA table_info(folders)")->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('public_read', $folderColumns)) {
        $db->exec("ALTER TABLE folders ADD COLUMN public_read INTEGER DEFAULT 0");
    }
    if (!in_array('public_write', $folderColumns)) {
        $db->exec("ALTER TABLE folders ADD COLUMN public_write INTEGER DEFAULT 0");
    }

    // Create indexes for migrated columns (these must be created after columns exist)
    $db->exec("
        CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(scope);
        CREATE INDEX IF NOT EXISTS idx_documents_public ON documents(public_read, public_write);
        CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_id);
        CREATE INDEX IF NOT EXISTS idx_folders_public ON folders(public_read, public_write);
    ");

} catch (PDOException $e) {
    die(json_encode(['error' => 'Database connection failed: ' . $e->getMessage()]));
}

/**
 * Migration from JSON to SQLite
 */
if (file_exists(DOCS_JSON_FILE)) {
    $stmt = $db->query("SELECT COUNT(*) FROM documents");
    if ($stmt->fetchColumn() == 0) {
        $jsonDocs = json_decode(file_get_contents(DOCS_JSON_FILE), true);
        if ($jsonDocs) {
            $db->beginTransaction();
            foreach ($jsonDocs as $doc) {
                $now = time();
                $stmt = $db->prepare("INSERT INTO documents (id, owner, app, title, type, created_at, updated_at) VALUES (?, ?, ?, ?, 'yjs', ?, ?)");
                $stmt->execute([$doc['id'], $doc['owner'], $doc['tool'] ?? '', $doc['title'], $now, $now]);

                if (isset($doc['versions'])) {
                    foreach ($doc['versions'] as $v => $rid) {
                        $stmt = $db->prepare("INSERT INTO document_versions (document_id, version, room_id, created_at) VALUES (?, ?, ?, ?)");
                        $stmt->execute([$doc['id'], (string)$v, $rid, $now]);
                    }
                }

                if (isset($doc['shared_with'])) {
                    foreach ($doc['shared_with'] as $share) {
                        $canRead = in_array('read', $share['permissions']) ? 1 : 0;
                        $canWrite = in_array('write', $share['permissions']) ? 1 : 0;
                        $stmt = $db->prepare("INSERT INTO document_shares (document_id, username, can_read, can_write) VALUES (?, ?, ?, ?)");
                        $stmt->execute([$doc['id'], $share['username'], $canRead, $canWrite]);
                    }
                }
            }
            $db->commit();
            rename(DOCS_JSON_FILE, DOCS_JSON_FILE . '.bak');
        }
    }
}

/**
 * Helpers
 */

/**
 * Check if a user has administrative privileges.
 * @param string $user
 * @return bool
 */
function isAdmin($user) {
    if (!$user || !function_exists('instrumenta_get_users')) return false;
    $users = instrumenta_get_users();
    return isset($users[$user]['is_admin']) && $users[$user]['is_admin'];
}

/**
 * Validate document/folder ID format.
 * @param string $id
 * @return bool
 */
function validateId($id) {
    return is_string($id) && preg_match('/^[a-zA-Z0-9_\-\.]+$/', $id);
}

/**
 * Validate version string format.
 * @param string $version
 * @return bool
 */
function validateVersion($version) {
    return is_string($version) && preg_match('/^[a-zA-Z0-9\.]+$/', $version);
}

/**
 * Get all ancestor folder IDs for a given folder (including itself).
 * Uses the closure table for efficient queries.
 * @param PDO $db
 * @param string $folderId
 * @return array
 */
function getFolderAncestors($db, $folderId) {
    $stmt = $db->prepare("
        SELECT ancestor_id FROM folder_closure
        WHERE descendant_id = ?
        ORDER BY depth DESC
    ");
    $stmt->execute([$folderId]);
    return $stmt->fetchAll(PDO::FETCH_COLUMN, 0);
}

/**
 * Get all descendant folder IDs for a given folder (including itself).
 * @param PDO $db
 * @param string $folderId
 * @return array
 */
function getFolderDescendants($db, $folderId) {
    $stmt = $db->prepare("
        SELECT descendant_id FROM folder_closure
        WHERE ancestor_id = ?
    ");
    $stmt->execute([$folderId]);
    return $stmt->fetchAll(PDO::FETCH_COLUMN, 0);
}

/**
 * Get the maximum permissions a user has from folder shares for a given folder.
 * Returns ['can_read' => bool, 'can_write' => bool]
 * @param PDO $db
 * @param string $folderId
 * @param string $user
 * @return array
 */
function getFolderSharePermissions($db, $folderId, $user) {
    // Check all ancestors (including self) for folder shares
    $stmt = $db->prepare("
        SELECT MAX(fs.can_read) as can_read, MAX(fs.can_write) as can_write
        FROM folder_closure fc
        JOIN folder_shares fs ON fc.ancestor_id = fs.folder_id
        WHERE fc.descendant_id = ? AND fs.username = ?
    ");
    $stmt->execute([$folderId, $user]);
    $result = $stmt->fetch();

    return [
        'can_read' => (bool)($result['can_read'] ?? 0),
        'can_write' => (bool)($result['can_write'] ?? 0)
    ];
}

/**
 * Get the maximum public flags from a folder and all its ancestors.
 * Returns ['public_read' => bool, 'public_write' => bool]
 * @param PDO $db
 * @param string $folderId
 * @return array
 */
function getFolderPublicFlags($db, $folderId) {
    // First check if folder exists and get its own flags
    $stmt = $db->prepare("SELECT public_read, public_write FROM folders WHERE id = ?");
    $stmt->execute([$folderId]);
    $folder = $stmt->fetch();

    if (!$folder) {
        return ['public_read' => false, 'public_write' => false];
    }

    // Check closure table for ancestors
    $stmt = $db->prepare("
        SELECT MAX(f.public_read) as public_read, MAX(f.public_write) as public_write
        FROM folder_closure fc
        JOIN folders f ON fc.ancestor_id = f.id
        WHERE fc.descendant_id = ?
    ");
    $stmt->execute([$folderId]);
    $result = $stmt->fetch();

    // If no closure entries, return folder's own flags
    if ($result === false || ($result['public_read'] === null && $result['public_write'] === null)) {
        return [
            'public_read' => (bool)$folder['public_read'],
            'public_write' => (bool)$folder['public_write']
        ];
    }

    return [
        'public_read' => (bool)($result['public_read'] ?? 0),
        'public_write' => (bool)($result['public_write'] ?? 0)
    ];
}

/**
 * Check if a user has read access to a document.
 * Considers public flags, direct shares, ownership, folder shares, and parent document inheritance.
 * @param PDO $db
 * @param string $docId
 * @param string|null $user Null for unauthenticated (public-only) access
 * @return bool
 */
function hasReadAccess($db, $docId, $user = null) {
    // Get document with all relevant fields
    $stmt = $db->prepare("
        SELECT d.owner, d.folder_id, d.public_read, d.parent_id
        FROM documents d
        WHERE d.id = ? AND d.deleted = 0
    ");
    $stmt->execute([$docId]);
    $doc = $stmt->fetch();

    if (!$doc) return false;

    // Check document's own public flag
    if ($doc['public_read']) return true;

    // If no user, only public access is allowed
    if ($user === null) return false;

    // Admin has full access
    if (isAdmin($user)) return true;

    // Owner has full access
    if ($doc['owner'] === $user) return true;

    // Check direct document share
    $stmt = $db->prepare("
        SELECT 1 FROM document_shares
        WHERE document_id = ? AND username = ? AND can_read = 1
    ");
    $stmt->execute([$docId, $user]);
    if ($stmt->fetch()) return true;

    // Check folder share and folder public flags (if document is in a folder)
    if ($doc['folder_id']) {
        // Check folder public flags first
        $folderPublic = getFolderPublicFlags($db, $doc['folder_id']);
        if ($folderPublic['public_read']) return true;

        // Check folder shares
        $folderPerms = getFolderSharePermissions($db, $doc['folder_id'], $user);
        if ($folderPerms['can_read']) return true;
    }

    // Check parent document permission (inheritance)
    if ($doc['parent_id']) {
        if (hasReadAccess($db, $doc['parent_id'], $user)) return true;
    }

    return false;
}

/**
 * Check if a user has write access to a document.
 * Considers public flags, direct shares, ownership, folder shares, and parent document inheritance.
 * @param PDO $db
 * @param string $docId
 * @param string|null $user Null for unauthenticated (public-only) access
 * @return bool
 */
function hasWriteAccess($db, $docId, $user = null) {
    // Get document with all relevant fields
    $stmt = $db->prepare("
        SELECT d.owner, d.folder_id, d.public_write, d.parent_id
        FROM documents d
        WHERE d.id = ? AND d.deleted = 0
    ");
    $stmt->execute([$docId]);
    $doc = $stmt->fetch();

    if (!$doc) return false;

    // Check document's own public flag
    if ($doc['public_write']) return true;

    // If no user, only public access is allowed
    if ($user === null) return false;

    // Admin has full access
    if (isAdmin($user)) return true;

    // Owner has full access
    if ($doc['owner'] === $user) return true;

    // Check direct document share
    $stmt = $db->prepare("
        SELECT 1 FROM document_shares
        WHERE document_id = ? AND username = ? AND can_write = 1
    ");
    $stmt->execute([$docId, $user]);
    if ($stmt->fetch()) return true;

    // Check folder share and folder public flags (if document is in a folder)
    if ($doc['folder_id']) {
        // Check folder public flags first
        $folderPublic = getFolderPublicFlags($db, $doc['folder_id']);
        if ($folderPublic['public_write']) return true;

        // Check folder shares
        $folderPerms = getFolderSharePermissions($db, $doc['folder_id'], $user);
        if ($folderPerms['can_write']) return true;
    }

    // Check parent document permission (inheritance)
    if ($doc['parent_id']) {
        if (hasWriteAccess($db, $doc['parent_id'], $user)) return true;
    }

    return false;
}

/**
 * Check if a user has read access to a folder.
 * Considers public flags, ownership, and folder shares.
 * @param PDO $db
 * @param string $folderId
 * @param string|null $user Null for unauthenticated (public-only) access
 * @return bool
 */
function hasFolderReadAccess($db, $folderId, $user = null) {
    // Check folder public flags first (from ancestors too)
    $folderPublic = getFolderPublicFlags($db, $folderId);
    if ($folderPublic['public_read']) return true;

    // If no user, only public access is allowed
    if ($user === null) return false;

    // Admin has full access
    if (isAdmin($user)) return true;

    // Get folder owner
    $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
    $stmt->execute([$folderId]);
    $folder = $stmt->fetch();

    if (!$folder) return false;

    // Owner has full access
    if ($folder['owner'] === $user) return true;

    // Check folder shares (including ancestor folders)
    $folderPerms = getFolderSharePermissions($db, $folderId, $user);
    return $folderPerms['can_read'];
}

/**
 * Check if a user has write access to a folder.
 * Considers public flags, ownership, and folder shares.
 * @param PDO $db
 * @param string $folderId
 * @param string|null $user Null for unauthenticated (public-only) access
 * @return bool
 */
function hasFolderWriteAccess($db, $folderId, $user = null) {
    // Check folder public flags first (from ancestors too)
    $folderPublic = getFolderPublicFlags($db, $folderId);
    if ($folderPublic['public_write']) return true;

    // If no user, only public access is allowed
    if ($user === null) return false;

    // Admin has full access
    if (isAdmin($user)) return true;

    // Get folder owner
    $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
    $stmt->execute([$folderId]);
    $folder = $stmt->fetch();

    if (!$folder) return false;

    // Owner has full access
    if ($folder['owner'] === $user) return true;

    // Check folder shares (including ancestor folders)
    $folderPerms = getFolderSharePermissions($db, $folderId, $user);
    return $folderPerms['can_write'];
}

/**
 * Generate a random ID.
 * @param int $length
 * @return string
 */
function generateRandomId($length = 16) {
    $chars = explode(' ', 'c d e f h j k m n p r t v w x y 2 3 4 5 6 8 9');
    $id = '';
    for ($i = 0; $i < $length; $i++) {
        $id .= $chars[random_int(0, count($chars) - 1)];
    }
    return $id;
}

/**
 * Check if a document is an ancestor of another document (cycle detection).
 * Traverses up the parent_id chain to see if potentialChild is under potentialAncestor.
 * @param PDO $db
 * @param string $potentialAncestor The document that might be an ancestor
 * @param string $potentialChild The document that might be a descendant
 * @return bool True if potentialAncestor is actually an ancestor of potentialChild
 */
function isDocumentAncestorOf($db, $potentialAncestor, $potentialChild) {
    $currentParent = $potentialChild;
    $maxDepth = 100; // Prevent infinite loops in case of data corruption
    $depth = 0;

    while ($currentParent && $depth < $maxDepth) {
        if ($currentParent === $potentialAncestor) {
            return true;
        }
        $stmt = $db->prepare("SELECT parent_id FROM documents WHERE id = ?");
        $stmt->execute([$currentParent]);
        $currentParent = $stmt->fetchColumn();
        $depth++;
    }

    return false;
}

/**
 * Rebuild the folder closure table for a given folder.
 * Should be called after creating, moving, or deleting a folder.
 * @param PDO $db
 * @param string $folderId
 */
function rebuildFolderClosure($db, $folderId) {
    // First, remove all closure entries where this folder is a descendant
    // (this will cascade to delete entries for descendants too)
    $db->prepare("DELETE FROM folder_closure WHERE descendant_id = ?")->execute([$folderId]);

    // Get all descendants of this folder (children, grandchildren, etc.)
    $descendants = [];
    $queue = [$folderId];

    while (!empty($queue)) {
        $current = array_shift($queue);
        $descendants[] = $current;

        // Get children
        $stmt = $db->prepare("SELECT id FROM folders WHERE parent_id = ?");
        $stmt->execute([$current]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $childId) {
            if (!in_array($childId, $descendants)) {
                $queue[] = $childId;
            }
        }
    }

    // For each descendant, find all ancestors and create closure entries
    foreach ($descendants as $descId) {
        // Get ancestors by traversing up the tree
        $ancestors = [];
        $current = $descId;
        $depth = 0;

        while ($current) {
            $ancestors[] = ['id' => $current, 'depth' => $depth];

            $stmt = $db->prepare("SELECT parent_id FROM folders WHERE id = ?");
            $stmt->execute([$current]);
            $current = $stmt->fetchColumn();
            $depth++;
        }

        // Insert closure entries
        foreach ($ancestors as $ancestor) {
            $stmt = $db->prepare("
                INSERT OR IGNORE INTO folder_closure (ancestor_id, descendant_id, depth)
                VALUES (?, ?, ?)
            ");
            $stmt->execute([$ancestor['id'], $descId, $ancestor['depth']]);
        }
    }
}

/**
 * Get the full document record including versions, shares, and computed permissions.
 * @param PDO $db
 * @param string $docId
 * @param string $currentUser
 * @param bool $includeDeleted
 * @return array|null
 */
function getDocumentFull($db, $docId, $currentUser = null, $includeDeleted = false) {
    $stmt = $db->prepare("SELECT * FROM documents WHERE id = ?" . ($includeDeleted ? "" : " AND deleted = 0"));
    $stmt->execute([$docId]);
    $doc = $stmt->fetch();
    if (!$doc) return null;

    // Get versions
    $vStmt = $db->prepare("SELECT version, room_id FROM document_versions WHERE document_id = ?");
    $vStmt->execute([$docId]);
    $doc['versions'] = [];
    foreach ($vStmt->fetchAll() as $v) {
        $doc['versions'][$v['version']] = $v['room_id'];
    }

    // Get shares
    $sStmt = $db->prepare("SELECT username, can_read, can_write FROM document_shares WHERE document_id = ?");
    $sStmt->execute([$docId]);
    $doc['shared_with'] = [];
    foreach ($sStmt->fetchAll() as $s) {
        $perms = [];
        if ($s['can_read']) $perms[] = 'read';
        if ($s['can_write']) $perms[] = 'write';
        $doc['shared_with'][] = [
            'username' => $s['username'],
            'permissions' => $perms
        ];
    }

    // Compute permissions for current user
    if ($currentUser) {
        $isOwner = ($doc['owner'] === $currentUser);
        $isAdminUser = isAdmin($currentUser);

        if ($isOwner || $isAdminUser) {
            $doc['permissions'] = ['read', 'write'];
        } else {
            $perms = [];

            // Check document's own public flags
            if (!empty($doc['public_read'])) $perms[] = 'read';
            if (!empty($doc['public_write'])) $perms[] = 'write';

            // Check direct share
            $stmt = $db->prepare("
                SELECT can_read, can_write FROM document_shares
                WHERE document_id = ? AND username = ?
            ");
            $stmt->execute([$docId, $currentUser]);
            $directShare = $stmt->fetch();

            if ($directShare) {
                if ($directShare['can_read'] && !in_array('read', $perms)) $perms[] = 'read';
                if ($directShare['can_write'] && !in_array('write', $perms)) $perms[] = 'write';
            }

            // Check folder share and folder public flags
            if ($doc['folder_id']) {
                // Check folder public flags
                $folderPublic = getFolderPublicFlags($db, $doc['folder_id']);
                if ($folderPublic['public_read'] && !in_array('read', $perms)) $perms[] = 'read';
                if ($folderPublic['public_write'] && !in_array('write', $perms)) $perms[] = 'write';

                // Check folder shares
                $folderPerms = getFolderSharePermissions($db, $doc['folder_id'], $currentUser);
                if ($folderPerms['can_read'] && !in_array('read', $perms)) $perms[] = 'read';
                if ($folderPerms['can_write'] && !in_array('write', $perms)) $perms[] = 'write';
            }

            // Check parent document permission (inheritance)
            if (!empty($doc['parent_id'])) {
                if (hasReadAccess($db, $doc['parent_id'], $currentUser) && !in_array('read', $perms)) $perms[] = 'read';
                if (hasWriteAccess($db, $doc['parent_id'], $currentUser) && !in_array('write', $perms)) $perms[] = 'write';
            }

            $doc['permissions'] = $perms;
        }
    }

    return $doc;
}

/**
 * Get the full folder record including shares and computed permissions.
 * @param PDO $db
 * @param string $folderId
 * @param string $currentUser
 * @return array|null
 */
function getFolderFull($db, $folderId, $currentUser = null) {
    $stmt = $db->prepare("SELECT * FROM folders WHERE id = ?");
    $stmt->execute([$folderId]);
    $folder = $stmt->fetch();
    if (!$folder) return null;

    // Get shares (only for owner/admin)
    $folder['shared_with'] = [];
    if ($currentUser && ($folder['owner'] === $currentUser || isAdmin($currentUser))) {
        $sStmt = $db->prepare("SELECT username, can_read, can_write FROM folder_shares WHERE folder_id = ?");
        $sStmt->execute([$folderId]);
        foreach ($sStmt->fetchAll() as $s) {
            $perms = [];
            if ($s['can_read']) $perms[] = 'read';
            if ($s['can_write']) $perms[] = 'write';
            $folder['shared_with'][] = [
                'username' => $s['username'],
                'permissions' => $perms
            ];
        }
    }

    // Compute permissions for current user
    if ($currentUser) {
        $isOwner = ($folder['owner'] === $currentUser);
        $isAdminUser = isAdmin($currentUser);

        if ($isOwner || $isAdminUser) {
            $folder['permissions'] = ['read', 'write'];
        } else {
            $folderPerms = getFolderSharePermissions($db, $folderId, $currentUser);
            $folder['permissions'] = [];
            if ($folderPerms['can_read']) $folder['permissions'][] = 'read';
            if ($folderPerms['can_write']) $folder['permissions'][] = 'write';
        }
    }

    return $folder;
}

/**
 * Require a specific HTTP method.
 * @param string $method
 */
function requireMethod($method) {
    if ($_SERVER['REQUEST_METHOD'] !== strtoupper($method)) {
        http_response_code(405);
        die(json_encode(['error' => "Method Not Allowed. Use $method for this action."]));
    }
}

/**
 * Get all folder IDs accessible to a user (owned or shared).
 * @param PDO $db
 * @param string $user
 * @return array
 */
function getAccessibleFolderIds($db, $user) {
    $folderIds = [];

    // Folders owned by user
    $stmt = $db->prepare("SELECT id FROM folders WHERE owner = ?");
    $stmt->execute([$user]);
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
        $folderIds[] = $id;
    }

    // Folders shared with user (via folder_shares)
    $stmt = $db->prepare("
        SELECT DISTINCT fc.descendant_id
        FROM folder_shares fs
        JOIN folder_closure fc ON fs.folder_id = fc.ancestor_id
        WHERE fs.username = ? AND fs.can_read = 1
    ");
    $stmt->execute([$user]);
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
        if (!in_array($id, $folderIds)) {
            $folderIds[] = $id;
        }
    }

    return $folderIds;
}

/**
 * API Logic
 */
$params = array_merge($_GET, $_POST);
$action = $params['action'] ?? '';
$docId = $params['id'] ?? null;

switch ($action) {

    // ==================== DOCUMENT OPERATIONS ====================

    case 'create':
        requireMethod('POST');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        $version = (string)($params['version'] ?? '1');
        if (!validateVersion($version)) { http_response_code(400); die(json_encode(['error' => 'Invalid version format'])); }

        $app = $params['app'] ?? '';
        $title = $params['title'] ?? 'Untitled';
        $type = $params['type'] ?? 'yjs';
        $folderId = $params['folder_id'] ?? null;

        // Validate document type
        if (!in_array($type, ['yjs', 'blob'])) {
            http_response_code(400); die(json_encode(['error' => 'Invalid document type. Must be "yjs" or "blob"']));
        }

        // Check folder write access if folder_id provided
        if ($folderId) {
            if (!validateId($folderId)) { http_response_code(400); die(json_encode(['error' => 'Invalid folder_id format'])); }
            if (!hasFolderWriteAccess($db, $folderId, $authorized_user)) {
                http_response_code(403); die(json_encode(['error' => 'No write access to folder']));
            }
        }

    $now = time();
    $roomId = generateRandomId();
    $blobKey = ($type === 'blob') ? generateRandomId(32) : null;

    // Get scope and public flags from params
    $scope = $params['scope'] ?? 'drive';
    $publicRead = isset($params['public_read']) ? (int)$params['public_read'] : 0;
    $publicWrite = isset($params['public_write']) ? (int)$params['public_write'] : 0;
    $parentId = $params['parent_id'] ?? null;

    // Validate scope
    if (!in_array($scope, ['app', 'drive'])) {
        http_response_code(400); die(json_encode(['error' => 'Invalid scope. Must be "app" or "drive"']));
    }

    // Validate app is required for app scope
    if ($scope === 'app' && empty($app)) {
        http_response_code(400); die(json_encode(['error' => 'app parameter is required when scope is "app"']));
    }

    // Validate parent_id if provided
    if ($parentId) {
        if (!validateId($parentId)) {
            http_response_code(400); die(json_encode(['error' => 'Invalid parent_id format']));
        }
        // Prevent self-referential parent
        if ($parentId === $docId) {
            http_response_code(400); die(json_encode(['error' => 'A file cannot be its own parent']));
        }
        // Check parent exists and user has write access
        $stmt = $db->prepare("SELECT id FROM documents WHERE id = ? AND deleted = 0");
        $stmt->execute([$parentId]);
        if (!$stmt->fetch()) {
            http_response_code(404); die(json_encode(['error' => 'Parent document not found']));
        }
        if (!hasWriteAccess($db, $parentId, $authorized_user)) {
            http_response_code(403); die(json_encode(['error' => 'No write access to parent document']));
        }
    }

    try {
        $db->beginTransaction();
        $stmt = $db->prepare("SELECT 1 FROM documents WHERE id = ?");
        $stmt->execute([$docId]);
        if ($stmt->fetch()) {
            $db->rollBack();
            http_response_code(409);
            die(json_encode(['error' => 'Document already exists']));
        }

        // Insert document with all fields including scope, public flags, and parent_id
        $stmt = $db->prepare("
            INSERT INTO documents (id, owner, app, title, type, folder_id, blob_key, filename, mime_type, size, scope, public_read, public_write, parent_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            $docId,
            $authorized_user,
            $app,
            $title,
            $type,
            $folderId,
            $blobKey,
            $params['filename'] ?? null,
            $params['mime_type'] ?? null,
            intval($params['size'] ?? 0),
            $scope,
            $publicRead,
            $publicWrite,
            $parentId,
            $now,
            $now
        ]);

            // For yjs documents, create initial version/room
            if ($type === 'yjs') {
                $stmt = $db->prepare("INSERT INTO document_versions (document_id, version, room_id, created_at) VALUES (?, ?, ?, ?)");
                $stmt->execute([$docId, $version, $roomId, $now]);
            }

            $db->commit();
            echo json_encode(getDocumentFull($db, $docId, $authorized_user));
        } catch (Exception $e) {
            if ($db->inTransaction()) $db->rollBack();
            http_response_code(500);
            die(json_encode(['error' => $e->getMessage()]));
        }
        break;

    case 'list':
    case 'list_by_app':
        requireMethod('GET');
        $app = $params['app'] ?? null;
        $all = isset($params['all']) && $params['all'] == '1' && isAdmin($authorized_user);
        $showDeleted = isset($params['show_deleted']) && $params['show_deleted'] == '1';

        // Build query for accessible documents
        // 1. Owned documents
        // 2. Directly shared documents
        // 3. Documents in shared folders
        // 4. Public documents (public_read = 1)
        // 5. Documents in public folders

        $sqlParams = [];
        $conditions = ["d.deleted = " . ($showDeleted ? '1' : '0')];

        if (!$all) {
            // Get accessible folders
            $accessibleFolders = getAccessibleFolderIds($db, $authorized_user);

            // Get public folders (folders with public_read = 1 or ancestors with public_read = 1)
            $publicFolderIds = [];
            $stmt = $db->query("
                SELECT DISTINCT fc.descendant_id
                FROM folder_closure fc
                JOIN folders f ON fc.ancestor_id = f.id
                WHERE f.public_read = 1
            ");
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
                $publicFolderIds[] = $id;
            }

            // Build the WHERE clause for documents
            $accessConditions = [];

            // Owned documents
            $accessConditions[] = "d.owner = ?";
            $sqlParams[] = $authorized_user;

            // Directly shared documents
            $accessConditions[] = "EXISTS (SELECT 1 FROM document_shares ds WHERE ds.document_id = d.id AND ds.username = ? AND ds.can_read = 1)";
            $sqlParams[] = $authorized_user;

            // Public documents (document's own public_read flag)
            $accessConditions[] = "d.public_read = 1";

            // Documents in accessible folders
            if (!empty($accessibleFolders)) {
                $accessConditions[] = "d.folder_id IN (" . str_repeat('?,', count($accessibleFolders) - 1) . "?)";
                foreach ($accessibleFolders as $fId) {
                    $sqlParams[] = $fId;
                }
            }

            // Documents in public folders
            if (!empty($publicFolderIds)) {
                $accessConditions[] = "d.folder_id IN (" . str_repeat('?,', count($publicFolderIds) - 1) . "?)";
                foreach ($publicFolderIds as $fId) {
                    $sqlParams[] = $fId;
                }
            }

            $conditions[] = "(" . implode(" OR ", $accessConditions) . ")";

            // Non-admins can only see their own deleted documents
            if ($showDeleted && !isAdmin($authorized_user)) {
                // Replace the access conditions with owner-only for deleted items
                // since deleted items shouldn't be visible via shares
                $conditions[count($conditions) - 1] = "(d.owner = ?)";
                $sqlParams = [$authorized_user];
            }
        }

        $query = "SELECT d.* FROM documents d WHERE " . implode(" AND ", $conditions);

        if ($app) {
            $query .= " AND d.app = ?";
            $sqlParams[] = $app;
        }

        // Filter by scope if provided
        if (isset($params['scope'])) {
            if (!in_array($params['scope'], ['app', 'drive'])) {
                http_response_code(400);
                die(json_encode(['error' => 'Invalid scope. Must be "app" or "drive"']));
            }
            $query .= " AND d.scope = ?";
            $sqlParams[] = $params['scope'];
        }

        // Filter by parent_id if provided (for attachments)
        if (isset($params['parent_id'])) {
            if ($params['parent_id'] === null || $params['parent_id'] === '') {
                $query .= " AND d.parent_id IS NULL";
            } else {
                $query .= " AND d.parent_id = ?";
                $sqlParams[] = $params['parent_id'];
            }
        }

        $stmt = $db->prepare($query);
        $stmt->execute($sqlParams);
        $docsList = $stmt->fetchAll();

        foreach ($docsList as &$d) {
            $full = getDocumentFull($db, $d['id'], $authorized_user, $showDeleted);
            if ($full) {
                $d = $full;
            } else {
                $d['versions'] = [];
                $d['shared_with'] = [];
                $d['permissions'] = [];
            }
        }

        // Include documents accessible via parent inheritance (attachments)
        // This recursively includes documents whose parent_id is in the result set
        // Use a transaction with consistent snapshot for data integrity
        $maxDepth = 10; // Prevent infinite loops
        $depth = 0;
        $existingIds = array_column($docsList, 'id');

        // Begin a read transaction for consistent snapshot
        $db->beginTransaction();
        try {
            while ($depth < $maxDepth) {
                $newDocs = [];
                if (!empty($existingIds)) {
                    $placeholders = str_repeat('?,', count($existingIds) - 1) . '?';
                    $stmt = $db->prepare("
                        SELECT * FROM documents
                        WHERE parent_id IN ($placeholders) AND deleted = " . ($showDeleted ? '1' : '0')
                    );
                    $stmt->execute($existingIds);
                    $children = $stmt->fetchAll();

                    foreach ($children as $child) {
                        if (!in_array($child['id'], $existingIds)) {
                            $full = getDocumentFull($db, $child['id'], $authorized_user, $showDeleted);
                            if ($full) {
                                $newDocs[] = $full;
                                $existingIds[] = $child['id'];
                            }
                        }
                    }
                }
                if (empty($newDocs)) {
                    break; // No more children found
                }
                $docsList = array_merge($docsList, $newDocs);
                $depth++;
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            throw $e;
        }

        echo json_encode(array_values($docsList));
        break;

    case 'rename':
        requireMethod('POST');
        if (!$docId || !isset($params['title'])) { http_response_code(400); die(json_encode(['error' => 'Missing parameters'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }
        if (!hasWriteAccess($db, $docId, $authorized_user)) { http_response_code(404); die(json_encode(['error' => 'Access denied or not found'])); }

        $stmt = $db->prepare("UPDATE documents SET title = ?, updated_at = ? WHERE id = ?");
        $stmt->execute([$params['title'], time(), $docId]);
        echo json_encode(getDocumentFull($db, $docId, $authorized_user));
        break;

    case 'share':
        requireMethod('POST');
        if (!$docId || !isset($params['username'], $params['permissions'])) { http_response_code(400); die(json_encode(['error' => 'Missing parameters'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        $stmt = $db->prepare("SELECT owner FROM documents WHERE id = ? AND deleted = 0");
        $stmt->execute([$docId]);
        $owner = $stmt->fetchColumn();
        if ($owner !== $authorized_user && !isAdmin($authorized_user)) { http_response_code(404); die(json_encode(['error' => 'Not found or not owner'])); }

        $permsArray = explode(',', $params['permissions']);
        $validPerms = ['read', 'write'];
        foreach ($permsArray as $p) {
            if (!in_array($p, $validPerms)) { http_response_code(400); die(json_encode(['error' => 'Invalid permission: ' . $p])); }
        }

        $canRead = in_array('read', $permsArray) ? 1 : 0;
        $canWrite = in_array('write', $permsArray) ? 1 : 0;

        $stmt = $db->prepare("
            INSERT INTO document_shares (document_id, username, can_read, can_write)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(document_id, username)
            DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write
        ");
        $stmt->execute([$docId, $params['username'], $canRead, $canWrite]);
        echo json_encode(getDocumentFull($db, $docId, $authorized_user));
        break;

    case 'revoke':
        requireMethod('POST');
        if (!$docId || !isset($params['username'])) { http_response_code(400); die(json_encode(['error' => 'Missing parameters'])); }

        $stmt = $db->prepare("SELECT owner FROM documents WHERE id = ? AND deleted = 0");
        $stmt->execute([$docId]);
        $owner = $stmt->fetchColumn();
        if ($owner !== $authorized_user && !isAdmin($authorized_user)) { http_response_code(404); die(json_encode(['error' => 'Not found or not owner'])); }

        $stmt = $db->prepare("DELETE FROM document_shares WHERE document_id = ? AND username = ?");
        $stmt->execute([$docId, $params['username']]);
        echo json_encode(getDocumentFull($db, $docId, $authorized_user));
        break;

    case 'delete':
        requireMethod('POST');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }

        // Check write access (owner, direct share, or folder share)
        if (!hasWriteAccess($db, $docId, $authorized_user)) {
            http_response_code(404);
            die(json_encode(['error' => 'Not found or no write access']));
        }

        $stmt = $db->prepare("UPDATE documents SET deleted = 1, updated_at = ? WHERE id = ?");
        $stmt->execute([time(), $docId]);
        echo json_encode(['success' => true]);
        break;

    case 'access':
        requireMethod('GET');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        $version = (string)($params['version'] ?? '1');
        if (!validateVersion($version)) { http_response_code(400); die(json_encode(['error' => 'Invalid version format'])); }

        $doc = getDocumentFull($db, $docId, $authorized_user);

        if (!$doc) { http_response_code(404); die(json_encode(['error' => 'Not found'])); }

        $isOwner = ($doc['owner'] === $authorized_user);
        $isAdminUser = isAdmin($authorized_user);

        if (!$isOwner && !$isAdminUser && !in_array('read', $doc['permissions'] ?? [])) {
            http_response_code(403);
            die(json_encode(['error' => 'Access denied']));
        }

        // For blob documents, return different structure
        if ($doc['type'] === 'blob') {
            echo json_encode([
                'id' => $docId,
                'type' => 'blob',
                'user' => $authorized_user,
                'permissions' => $doc['permissions'],
                'filename' => $doc['filename'],
                'mime_type' => $doc['mime_type'],
                'size' => $doc['size']
            ]);
        } else {
            // Yjs document - return room info
            $room = $doc['versions'][$version] ?? null;
            echo json_encode([
                'id' => $docId,
                'room' => $room,
                'user' => $authorized_user,
                'permissions' => $doc['permissions']
            ]);
        }
        break;

    case 'create_version':
        requireMethod('POST');
        if (!$docId || !isset($params['version'])) { http_response_code(400); die(json_encode(['error' => 'Missing parameters'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        $version = (string)$params['version'];
        if (!validateVersion($version)) { http_response_code(400); die(json_encode(['error' => 'Invalid version format'])); }

        if (!hasWriteAccess($db, $docId, $authorized_user)) { http_response_code(403); die(json_encode(['error' => 'Access denied or not found'])); }

        try {
            $db->beginTransaction();

            // Check if version already exists
            $stmt = $db->prepare("SELECT room_id FROM document_versions WHERE document_id = ? AND version = ?");
            $stmt->execute([$docId, $version]);
            $room = $stmt->fetchColumn();

            if (!$room) {
                $room = generateRandomId();
                // Use INSERT OR IGNORE to handle race condition - if another request
                // inserted the same version between our SELECT and INSERT, this will silently skip
                $stmt = $db->prepare("INSERT OR IGNORE INTO document_versions (document_id, version, room_id, created_at) VALUES (?, ?, ?, ?)");
                $stmt->execute([$docId, $version, $room, time()]);

                // If the insert was ignored (another request won the race), re-fetch the existing room
                if ($stmt->rowCount() === 0) {
                    $stmt = $db->prepare("SELECT room_id FROM document_versions WHERE document_id = ? AND version = ?");
                    $stmt->execute([$docId, $version]);
                    $room = $stmt->fetchColumn();
                }
            }
            $db->commit();
            echo json_encode(['id' => $docId, 'version' => $version, 'room' => $room]);
        } catch (Exception $e) {
            if ($db->inTransaction()) $db->rollBack();
            http_response_code(500);
            die(json_encode(['error' => $e->getMessage()]));
        }
        break;

    case 'move_document':
        requireMethod('POST');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        $targetFolderId = $params['target_folder_id'] ?? null;
        if ($targetFolderId && !validateId($targetFolderId)) {
            http_response_code(400);
            die(json_encode(['error' => 'Invalid target_folder_id format']));
        }

        // Check write access to the document
        if (!hasWriteAccess($db, $docId, $authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'No write access to document']));
        }

        // Check write access to target folder
        if ($targetFolderId && !hasFolderWriteAccess($db, $targetFolderId, $authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'No write access to target folder']));
        }

        $stmt = $db->prepare("UPDATE documents SET folder_id = ?, updated_at = ? WHERE id = ?");
        $stmt->execute([$targetFolderId, time(), $docId]);
        echo json_encode(getDocumentFull($db, $docId, $authorized_user));
        break;

    case 'generate_id':
        requireMethod('GET');
        $length = isset($params['length']) ? intval($params['length']) : 16;
        if ($length < 1 || $length > 128) { http_response_code(400); die(json_encode(['error' => 'Invalid length (1–128 allowed)'])); }
        echo json_encode(['id' => generateRandomId($length)]);
        break;

    case 'permanent_delete':
        requireMethod('POST');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }

        // Check if document exists and is deleted
        $stmt = $db->prepare("SELECT owner, blob_key FROM documents WHERE id = ? AND deleted = 1");
        $stmt->execute([$docId]);
        $doc = $stmt->fetch();
        if (!$doc) { http_response_code(404); die(json_encode(['error' => 'Document not found or not deleted'])); }
        if ($doc['owner'] !== $authorized_user && !isAdmin($authorized_user)) { http_response_code(403); die(json_encode(['error' => 'Access denied'])); }

        // Get blob_key before deleting
        $blobKey = $doc['blob_key'];

        // Delete the document and all related data (versions and shares via CASCADE)
        $stmt = $db->prepare("DELETE FROM documents WHERE id = ?");
        $stmt->execute([$docId]);

        // Delete blob file if exists
        if ($blobKey) {
            $blobPath = BLOBS_DIR . $blobKey;
            if (file_exists($blobPath)) {
                unlink($blobPath);
            }
        }

        echo json_encode(['success' => true]);
        break;

    case 'restore':
        requireMethod('POST');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }

        // Check if document exists and is deleted
        $stmt = $db->prepare("SELECT owner FROM documents WHERE id = ? AND deleted = 1");
        $stmt->execute([$docId]);
        $owner = $stmt->fetchColumn();
        if (!$owner) { http_response_code(404); die(json_encode(['error' => 'Document not found or not deleted'])); }
        if ($owner !== $authorized_user && !isAdmin($authorized_user)) { http_response_code(403); die(json_encode(['error' => 'Access denied'])); }

        // Restore the document
        $stmt = $db->prepare("UPDATE documents SET deleted = 0, updated_at = ? WHERE id = ?");
        $stmt->execute([time(), $docId]);
        echo json_encode(['success' => true]);
        break;

    case 'set_public':
        requireMethod('POST');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        // Check ownership
        $stmt = $db->prepare("SELECT owner FROM documents WHERE id = ? AND deleted = 0");
        $stmt->execute([$docId]);
        $doc = $stmt->fetch();
        if (!$doc) { http_response_code(404); die(json_encode(['error' => 'Document not found'])); }
        if ($doc['owner'] !== $authorized_user && !isAdmin($authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'Only the owner can change public visibility']));
        }

        $publicRead = isset($params['public_read']) ? (int)$params['public_read'] : null;
        $publicWrite = isset($params['public_write']) ? (int)$params['public_write'] : null;

        // Build update query dynamically
        $updates = [];
        $updateParams = [];
        if ($publicRead !== null) {
            $updates[] = 'public_read = ?';
            $updateParams[] = $publicRead ? 1 : 0;
        }
        if ($publicWrite !== null) {
            $updates[] = 'public_write = ?';
            $updateParams[] = $publicWrite ? 1 : 0;
        }

        if (empty($updates)) {
            http_response_code(400);
            die(json_encode(['error' => 'No public flags provided']));
        }

        $updates[] = 'updated_at = ?';
        $updateParams[] = time();
        $updateParams[] = $docId;

        $stmt = $db->prepare("UPDATE documents SET " . implode(', ', $updates) . " WHERE id = ?");
        $stmt->execute($updateParams);
        echo json_encode(getDocumentFull($db, $docId, $authorized_user));
        break;

    case 'set_parent':
        requireMethod('POST');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        $parentId = $params['parent_id'] ?? null;
        if ($parentId && !validateId($parentId)) {
            http_response_code(400);
            die(json_encode(['error' => 'Invalid parent_id format']));
        }

        // Check write access to document
        if (!hasWriteAccess($db, $docId, $authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'No write access to document']));
        }

        // If setting a parent, verify it exists and user has read access
        if ($parentId) {
            $stmt = $db->prepare("SELECT id FROM documents WHERE id = ? AND deleted = 0");
            $stmt->execute([$parentId]);
            if (!$stmt->fetch()) {
                http_response_code(404);
                die(json_encode(['error' => 'Parent document not found']));
            }
            if (!hasReadAccess($db, $parentId, $authorized_user)) {
                http_response_code(403);
                die(json_encode(['error' => 'No read access to parent document']));
            }

            // Prevent circular references using the helper function
            if (isDocumentAncestorOf($db, $docId, $parentId)) {
                http_response_code(400);
                die(json_encode(['error' => 'Circular reference detected: cannot set a descendant as parent']));
            }
        }

        $stmt = $db->prepare("UPDATE documents SET parent_id = ?, updated_at = ? WHERE id = ?");
        $stmt->execute([$parentId, time(), $docId]);
        echo json_encode(getDocumentFull($db, $docId, $authorized_user));
        break;

    case 'set_public_v2':
        requireMethod('POST');
        $targetId = $params['id'] ?? null;
        $isFolder = isset($params['is_folder']) ? (bool)$params['is_folder'] : false;

        if (!$targetId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }
        if (!validateId($targetId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        $publicRead = isset($params['public_read']) ? (int)$params['public_read'] : null;
        $publicWrite = isset($params['public_write']) ? (int)$params['public_write'] : null;

        if ($publicRead === null && $publicWrite === null) {
            http_response_code(400);
            die(json_encode(['error' => 'No public flags provided']));
        }

        if ($isFolder) {
            // Folder public access
            $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
            $stmt->execute([$targetId]);
            $folder = $stmt->fetch();
            if (!$folder) { http_response_code(404); die(json_encode(['error' => 'Folder not found'])); }
            if ($folder['owner'] !== $authorized_user && !isAdmin($authorized_user)) {
                http_response_code(403);
                die(json_encode(['error' => 'Only the owner can change public visibility']));
            }

            // Build update query dynamically
            $updates = [];
            $updateParams = [];
            if ($publicRead !== null) {
                $updates[] = 'public_read = ?';
                $updateParams[] = $publicRead ? 1 : 0;
            }
            if ($publicWrite !== null) {
                $updates[] = 'public_write = ?';
                $updateParams[] = $publicWrite ? 1 : 0;
            }
            $updates[] = 'updated_at = ?';
            $updateParams[] = time();
            $updateParams[] = $targetId;

            $stmt = $db->prepare("UPDATE folders SET " . implode(', ', $updates) . " WHERE id = ?");
            $stmt->execute($updateParams);
            echo json_encode(getFolderFull($db, $targetId, $authorized_user));
        } else {
            // Document public access
            $stmt = $db->prepare("SELECT owner FROM documents WHERE id = ? AND deleted = 0");
            $stmt->execute([$targetId]);
            $doc = $stmt->fetch();
            if (!$doc) { http_response_code(404); die(json_encode(['error' => 'Document not found'])); }
            if ($doc['owner'] !== $authorized_user && !isAdmin($authorized_user)) {
                http_response_code(403);
                die(json_encode(['error' => 'Only the owner can change public visibility']));
            }

            // Build update query dynamically
            $updates = [];
            $updateParams = [];
            if ($publicRead !== null) {
                $updates[] = 'public_read = ?';
                $updateParams[] = $publicRead ? 1 : 0;
            }
            if ($publicWrite !== null) {
                $updates[] = 'public_write = ?';
                $updateParams[] = $publicWrite ? 1 : 0;
            }
            $updates[] = 'updated_at = ?';
            $updateParams[] = time();
            $updateParams[] = $targetId;

            $stmt = $db->prepare("UPDATE documents SET " . implode(', ', $updates) . " WHERE id = ?");
            $stmt->execute($updateParams);
            echo json_encode(getDocumentFull($db, $targetId, $authorized_user));
        }
        break;

    case 'get_children':
        requireMethod('GET');
        if (!$docId) { http_response_code(400); die(json_encode(['error' => 'Missing id'])); }
        if (!validateId($docId)) { http_response_code(400); die(json_encode(['error' => 'Invalid ID format'])); }

        // Check read access to parent document
        if (!hasReadAccess($db, $docId, $authorized_user)) {
            http_response_code(404);
            die(json_encode(['error' => 'Document not found or no access']));
        }

        $stmt = $db->prepare("SELECT id FROM documents WHERE parent_id = ? AND deleted = 0");
        $stmt->execute([$docId]);
        $children = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $childId) {
            $child = getDocumentFull($db, $childId, $authorized_user);
            if ($child) {
                $children[] = $child;
            }
        }
        echo json_encode($children);
        break;

    // ==================== FOLDER OPERATIONS ====================

    case 'create_folder':
        requireMethod('POST');
        $name = $params['name'] ?? null;
        $parentId = $params['parent_id'] ?? null;

        if (!$name) { http_response_code(400); die(json_encode(['error' => 'Missing folder name'])); }

        // Check parent folder ownership (folders can only be created in user's own tree)
        if ($parentId) {
            if (!validateId($parentId)) { http_response_code(400); die(json_encode(['error' => 'Invalid parent_id format'])); }
            $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
            $stmt->execute([$parentId]);
            $parentOwner = $stmt->fetchColumn();
            if (!$parentOwner) { http_response_code(404); die(json_encode(['error' => 'Parent folder not found'])); }
            if ($parentOwner !== $authorized_user) {
                http_response_code(403);
                die(json_encode(['error' => 'Can only create folders in your own tree']));
            }
        }

        // Check for duplicate name under same parent
        $stmt = $db->prepare("SELECT 1 FROM folders WHERE owner = ? AND name = ? AND parent_id " . ($parentId ? "= ?" : "IS NULL"));
        $checkParams = [$authorized_user, $name];
        if ($parentId) $checkParams[] = $parentId;
        $stmt->execute($checkParams);
        if ($stmt->fetch()) {
            http_response_code(409);
            die(json_encode(['error' => 'Folder with this name already exists at this location']));
        }

        $folderId = generateRandomId();
        $now = time();

        try {
            $db->beginTransaction();

            $stmt = $db->prepare("INSERT INTO folders (id, owner, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
            $stmt->execute([$folderId, $authorized_user, $name, $parentId, $now, $now]);

            // Build closure table entry
            rebuildFolderClosure($db, $folderId);

            $db->commit();
            echo json_encode(getFolderFull($db, $folderId, $authorized_user));
        } catch (Exception $e) {
            if ($db->inTransaction()) $db->rollBack();
            http_response_code(500);
            die(json_encode(['error' => $e->getMessage()]));
        }
        break;

    case 'rename_folder':
        requireMethod('POST');
        $folderId = $params['folder_id'] ?? null;
        $newName = $params['new_name'] ?? null;

        if (!$folderId || !$newName) { http_response_code(400); die(json_encode(['error' => 'Missing parameters'])); }
        if (!validateId($folderId)) { http_response_code(400); die(json_encode(['error' => 'Invalid folder_id format'])); }

        // Check ownership
        $stmt = $db->prepare("SELECT owner, parent_id FROM folders WHERE id = ?");
        $stmt->execute([$folderId]);
        $folder = $stmt->fetch();
        if (!$folder) { http_response_code(404); die(json_encode(['error' => 'Folder not found'])); }
        if ($folder['owner'] !== $authorized_user && !isAdmin($authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'Only the owner can rename this folder']));
        }

        // Check for duplicate name under same parent
        $stmt = $db->prepare("SELECT 1 FROM folders WHERE owner = ? AND name = ? AND parent_id " . ($folder['parent_id'] ? "= ?" : "IS NULL") . " AND id != ?");
        $checkParams = [$authorized_user, $newName];
        if ($folder['parent_id']) $checkParams[] = $folder['parent_id'];
        $checkParams[] = $folderId;
        $stmt->execute($checkParams);
        if ($stmt->fetch()) {
            http_response_code(409);
            die(json_encode(['error' => 'Folder with this name already exists at this location']));
        }

        $stmt = $db->prepare("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?");
        $stmt->execute([$newName, time(), $folderId]);
        echo json_encode(getFolderFull($db, $folderId, $authorized_user));
        break;

    case 'delete_folder':
        requireMethod('POST');
        $folderId = $params['folder_id'] ?? null;

        if (!$folderId) { http_response_code(400); die(json_encode(['error' => 'Missing folder_id'])); }
        if (!validateId($folderId)) { http_response_code(400); die(json_encode(['error' => 'Invalid folder_id format'])); }

        // Check ownership
        $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
        $stmt->execute([$folderId]);
        $folder = $stmt->fetch();
        if (!$folder) { http_response_code(404); die(json_encode(['error' => 'Folder not found'])); }
        if ($folder['owner'] !== $authorized_user && !isAdmin($authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'Only the owner can delete this folder']));
        }

        try {
            $db->beginTransaction();

            // Get all descendant folders via closure table (including the folder itself)
            $descendants = getFolderDescendants($db, $folderId);

            // Soft-delete all documents in all descendant folders
            $now = time();
            foreach ($descendants as $descId) {
                $stmt = $db->prepare("UPDATE documents SET deleted = 1, updated_at = ? WHERE folder_id = ? AND deleted = 0");
                $stmt->execute([$now, $descId]);
            }

            // Delete all descendant folders (closure entries cascade)
            // Start from deepest (reverse order by depth)
            $stmt = $db->prepare("
                SELECT fc.descendant_id, fc.depth FROM folder_closure fc
                WHERE fc.ancestor_id = ?
                ORDER BY fc.depth DESC
            ");
            $stmt->execute([$folderId]);
            $toDelete = $stmt->fetchAll();

            foreach ($toDelete as $row) {
                $delId = $row['descendant_id'];
                // Delete folder shares
                $db->prepare("DELETE FROM folder_shares WHERE folder_id = ?")->execute([$delId]);
                // Delete closure entries where this folder is a descendant
                $db->prepare("DELETE FROM folder_closure WHERE descendant_id = ?")->execute([$delId]);
                // Delete folder
                $db->prepare("DELETE FROM folders WHERE id = ?")->execute([$delId]);
            }

            $db->commit();
            echo json_encode(['success' => true]);
        } catch (Exception $e) {
            if ($db->inTransaction()) $db->rollBack();
            http_response_code(500);
            die(json_encode(['error' => $e->getMessage()]));
        }
        break;

    case 'move_folder':
        requireMethod('POST');
        $folderId = $params['folder_id'] ?? null;
        $targetParentId = $params['target_parent_id'] ?? null;

        if (!$folderId) { http_response_code(400); die(json_encode(['error' => 'Missing folder_id'])); }
        if (!validateId($folderId)) { http_response_code(400); die(json_encode(['error' => 'Invalid folder_id format'])); }
        if ($targetParentId && !validateId($targetParentId)) {
            http_response_code(400);
            die(json_encode(['error' => 'Invalid target_parent_id format']));
        }

        // Check ownership of folder being moved
        $stmt = $db->prepare("SELECT owner, parent_id FROM folders WHERE id = ?");
        $stmt->execute([$folderId]);
        $folder = $stmt->fetch();
        if (!$folder) { http_response_code(404); die(json_encode(['error' => 'Folder not found'])); }
        if ($folder['owner'] !== $authorized_user) {
            http_response_code(403);
            die(json_encode(['error' => 'Only the owner can move this folder']));
        }

        // Cannot move to self or descendant
        if ($targetParentId) {
            if ($targetParentId === $folderId) {
                http_response_code(400);
                die(json_encode(['error' => 'Cannot move folder to itself']));
            }

            $descendants = getFolderDescendants($db, $folderId);
            if (in_array($targetParentId, $descendants)) {
                http_response_code(400);
                die(json_encode(['error' => 'Cannot move folder to its own descendant']));
            }

            // Check ownership of target parent
            $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
            $stmt->execute([$targetParentId]);
            $targetParent = $stmt->fetch();
            if (!$targetParent) { http_response_code(404); die(json_encode(['error' => 'Target parent not found'])); }
            if ($targetParent['owner'] !== $authorized_user) {
                http_response_code(403);
                die(json_encode(['error' => 'Can only move to folders you own']));
            }
        }

        // Check for duplicate name at destination
        $stmt = $db->prepare("SELECT name FROM folders WHERE id = ?");
        $stmt->execute([$folderId]);
        $folderName = $stmt->fetchColumn();

        $stmt = $db->prepare("SELECT 1 FROM folders WHERE owner = ? AND name = ? AND parent_id " . ($targetParentId ? "= ?" : "IS NULL"));
        $checkParams = [$authorized_user, $folderName];
        if ($targetParentId) $checkParams[] = $targetParentId;
        $stmt->execute($checkParams);
        if ($stmt->fetch()) {
            http_response_code(409);
            die(json_encode(['error' => 'Folder with this name already exists at destination']));
        }

        try {
            $db->beginTransaction();

            // Update parent
            $stmt = $db->prepare("UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?");
            $stmt->execute([$targetParentId, time(), $folderId]);

            // Rebuild closure table
            rebuildFolderClosure($db, $folderId);

            $db->commit();
            echo json_encode(getFolderFull($db, $folderId, $authorized_user));
        } catch (Exception $e) {
            if ($db->inTransaction()) $db->rollBack();
            http_response_code(500);
            die(json_encode(['error' => $e->getMessage()]));
        }
        break;

    case 'share_folder':
        requireMethod('POST');
        $folderId = $params['folder_id'] ?? null;
        $username = $params['username'] ?? null;
        $permissions = $params['permissions'] ?? '';

        if (!$folderId || !$username || !$permissions) {
            http_response_code(400);
            die(json_encode(['error' => 'Missing parameters']));
        }
        if (!validateId($folderId)) { http_response_code(400); die(json_encode(['error' => 'Invalid folder_id format'])); }

        // Check ownership
        $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
        $stmt->execute([$folderId]);
        $folder = $stmt->fetch();
        if (!$folder) { http_response_code(404); die(json_encode(['error' => 'Folder not found'])); }
        if ($folder['owner'] !== $authorized_user && !isAdmin($authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'Only the owner can share this folder']));
        }

        $permsArray = explode(',', $permissions);
        $validPerms = ['read', 'write'];
        foreach ($permsArray as $p) {
            if (!in_array($p, $validPerms)) {
                http_response_code(400);
                die(json_encode(['error' => 'Invalid permission: ' . $p]));
            }
        }

        $canRead = in_array('read', $permsArray) ? 1 : 0;
        $canWrite = in_array('write', $permsArray) ? 1 : 0;

        $stmt = $db->prepare("
            INSERT INTO folder_shares (folder_id, username, can_read, can_write)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(folder_id, username)
            DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write
        ");
        $stmt->execute([$folderId, $username, $canRead, $canWrite]);

        echo json_encode(getFolderFull($db, $folderId, $authorized_user));
        break;

    case 'revoke_folder_share':
        requireMethod('POST');
        $folderId = $params['folder_id'] ?? null;
        $username = $params['username'] ?? null;

        if (!$folderId || !$username) {
            http_response_code(400);
            die(json_encode(['error' => 'Missing parameters']));
        }

        // Check ownership
        $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
        $stmt->execute([$folderId]);
        $folder = $stmt->fetch();
        if (!$folder) { http_response_code(404); die(json_encode(['error' => 'Folder not found'])); }
        if ($folder['owner'] !== $authorized_user && !isAdmin($authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'Only the owner can revoke folder shares']));
        }

        $stmt = $db->prepare("DELETE FROM folder_shares WHERE folder_id = ? AND username = ?");
        $stmt->execute([$folderId, $username]);

        echo json_encode(getFolderFull($db, $folderId, $authorized_user));
        break;

    case 'set_public_folder':
        requireMethod('POST');
        $folderId = $params['folder_id'] ?? null;
        if (!$folderId) { http_response_code(400); die(json_encode(['error' => 'Missing folder_id'])); }
        if (!validateId($folderId)) { http_response_code(400); die(json_encode(['error' => 'Invalid folder_id format'])); }

        // Check ownership
        $stmt = $db->prepare("SELECT owner FROM folders WHERE id = ?");
        $stmt->execute([$folderId]);
        $folder = $stmt->fetch();
        if (!$folder) { http_response_code(404); die(json_encode(['error' => 'Folder not found'])); }
        if ($folder['owner'] !== $authorized_user && !isAdmin($authorized_user)) {
            http_response_code(403);
            die(json_encode(['error' => 'Only the owner can change public visibility']));
        }

        $publicRead = isset($params['public_read']) ? (int)$params['public_read'] : null;
        $publicWrite = isset($params['public_write']) ? (int)$params['public_write'] : null;

        // Build update query dynamically
        $updates = [];
        $updateParams = [];
        if ($publicRead !== null) {
            $updates[] = 'public_read = ?';
            $updateParams[] = $publicRead ? 1 : 0;
        }
        if ($publicWrite !== null) {
            $updates[] = 'public_write = ?';
            $updateParams[] = $publicWrite ? 1 : 0;
        }

        if (empty($updates)) {
            http_response_code(400);
            die(json_encode(['error' => 'No public flags provided']));
        }

        $updates[] = 'updated_at = ?';
        $updateParams[] = time();
        $updateParams[] = $folderId;

        $stmt = $db->prepare("UPDATE folders SET " . implode(', ', $updates) . " WHERE id = ?");
        $stmt->execute($updateParams);
        echo json_encode(getFolderFull($db, $folderId, $authorized_user));
        break;

    // ==================== SYNC ====================

    case 'full_sync':
        requireMethod('GET');

        $response = [
            'documents' => [],
            'folders' => []
        ];

        // Get all accessible folders (owned or shared)
        $accessibleFolderIds = getAccessibleFolderIds($db, $authorized_user);

        // Get public folders (folders with public_read = 1 or ancestors with public_read = 1)
        $publicFolderIds = [];
        $stmt = $db->query("
            SELECT DISTINCT fc.descendant_id
            FROM folder_closure fc
            JOIN folders f ON fc.ancestor_id = f.id
            WHERE f.public_read = 1
        ");
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
            $publicFolderIds[] = $id;
        }

        // Merge all folder IDs (accessible + public)
        $allFolderIds = array_unique(array_merge($accessibleFolderIds, $publicFolderIds));

        // Get all folders
        foreach ($allFolderIds as $folderId) {
            $folder = getFolderFull($db, $folderId, $authorized_user);
            if ($folder) {
                $response['folders'][] = $folder;
            }
        }

        // Get all accessible documents
        $docIds = [];

        // 1. Owned documents
        $stmt = $db->prepare("SELECT id FROM documents WHERE owner = ? AND deleted = 0");
        $stmt->execute([$authorized_user]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
            $docIds[] = $id;
        }

        // 2. Directly shared documents
        $stmt = $db->prepare("
            SELECT DISTINCT document_id FROM document_shares
            WHERE username = ? AND can_read = 1
        ");
        $stmt->execute([$authorized_user]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
            if (!in_array($id, $docIds)) $docIds[] = $id;
        }

        // 3. Public documents (document's own public_read flag)
        $stmt = $db->query("SELECT id FROM documents WHERE public_read = 1 AND deleted = 0");
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
            if (!in_array($id, $docIds)) $docIds[] = $id;
        }

        // 4. Documents in accessible folders
        if (!empty($accessibleFolderIds)) {
            $placeholders = str_repeat('?,', count($accessibleFolderIds) - 1) . '?';
            $stmt = $db->prepare("
                SELECT DISTINCT id FROM documents
                WHERE folder_id IN ($placeholders) AND deleted = 0
            ");
            $stmt->execute($accessibleFolderIds);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
                if (!in_array($id, $docIds)) $docIds[] = $id;
            }
        }

        // 5. Documents in public folders
        if (!empty($publicFolderIds)) {
            $placeholders = str_repeat('?,', count($publicFolderIds) - 1) . '?';
            $stmt = $db->prepare("
                SELECT DISTINCT id FROM documents
                WHERE folder_id IN ($placeholders) AND deleted = 0
            ");
            $stmt->execute($publicFolderIds);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
                if (!in_array($id, $docIds)) $docIds[] = $id;
            }
        }

        // 6. Documents accessible via parent inheritance (attachments)
        // Recursively include documents whose parent_id is in the accessible set
        $maxDepth = 10; // Prevent infinite loops
        $depth = 0;
        while ($depth < $maxDepth) {
            $newIds = [];
            if (!empty($docIds)) {
                $placeholders = str_repeat('?,', count($docIds) - 1) . '?';
                $stmt = $db->prepare("
                    SELECT DISTINCT id FROM documents
                    WHERE parent_id IN ($placeholders) AND deleted = 0
                ");
                $stmt->execute($docIds);
                foreach ($stmt->fetchAll(PDO::FETCH_COLUMN, 0) as $id) {
                    if (!in_array($id, $docIds)) {
                        $newIds[] = $id;
                        $docIds[] = $id;
                    }
                }
            }
            if (empty($newIds)) {
                break; // No more children found
            }
            $depth++;
        }

        // Get full document data
        foreach ($docIds as $id) {
            $doc = getDocumentFull($db, $id, $authorized_user);
            if ($doc) {
                $response['documents'][] = $doc;
            }
        }

        echo json_encode($response);
        break;

    default:
        http_response_code(400);
        echo json_encode(['error' => 'Unknown action']);
        break;
}
