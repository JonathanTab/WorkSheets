<?php
// Hardcoded root directory for this application.
// This file is included from various depths within the project structure,
// so we use an absolute path to ensure consistent access to data directories.
define('INSTRUMENTA_ROOT', '/var/www/instrumenta/');

// Debug toggle - set to true to enable debug output
define('INSTRUMENTA_DEBUG', true);

if (INSTRUMENTA_DEBUG) {
    error_reporting(E_ALL);
    ini_set('display_errors', '0'); // Ensure errors don't go to output stream
    ini_set('log_errors', '1');     // Ensure errors go to error log
} else {
    ini_set('display_errors', '0');
    ini_set('log_errors', '1');
}

define('INSTRUMENTA_TOKEN_DIR', INSTRUMENTA_ROOT . 'data/session_tokens/');

// Ensure session token directory exists
if (!is_dir(INSTRUMENTA_TOKEN_DIR)) {
    mkdir(INSTRUMENTA_TOKEN_DIR, 0700, true);
}

/**
 * Returns true when running on localhost (HTTP dev mode).
 * Used to disable the `secure` cookie flag so session cookies work over plain HTTP.
 */
function isLocalhost(): bool {
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $ip   = $_SERVER['REMOTE_ADDR'] ?? '';
    return $host === 'localhost'
        || str_starts_with($host, 'localhost:')
        || $host === '127.0.0.1'
        || str_starts_with($host, '127.0.0.1:')
        || $host === '[::1]'
        || $ip   === '127.0.0.1'
        || $ip   === '::1';
}

$_secure_cookie = !isLocalhost();

// Initialize session with secure settings
session_set_cookie_params([
    'httponly' => true,
    'secure'   => $_secure_cookie,
    'samesite' => 'Lax',
]);
session_start();

function instrumenta_debug_log($label, $data) {
    if (!INSTRUMENTA_DEBUG) return;
    error_log("[INSTRUMENTA DEBUG] $label: " . print_r($data, true));
}

// Paths
$instrumenta_users_file = '/var/www/users.json';
$auth_log_file = '/var/www/instrumenta_auth.log';
$manifest_file = INSTRUMENTA_ROOT . 'manifest.txt';

// Initialize users file
if (!file_exists($instrumenta_users_file)) {
    file_put_contents($instrumenta_users_file, json_encode([
        'admin' => [
            'password'     => password_hash('admin123', PASSWORD_DEFAULT),
            'is_admin'     => true,
            'invited_apps' => [],
            'api_key'      => bin2hex(random_bytes(32))
        ]
    ], JSON_PRETTY_PRINT));
}


/**
 * Parse manifest file to extract tool definitions with flags
 * @return array [tool_name => ['admin' => bool, 'invite' => bool, ...]]
 */
function instrumenta_parse_manifest() {
    global $manifest_file;

    $tools = [];

    if (!file_exists($manifest_file)) {
        return $tools;
    }

    $lines = file($manifest_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

    foreach ($lines as $line) {
        // Skip comments and empty lines
        $trimmed = trim($line);
        if (empty($trimmed) || $trimmed[0] === '#') {
            continue;
        }

        // Parse line: path [flags...] [key="value"...]
        $parts = preg_split('/\s+/', $trimmed, -1, PREG_SPLIT_NO_EMPTY);
        if (empty($parts)) continue;

        $path     = array_shift($parts);
        $flags    = [];
        $metadata = [];

        foreach ($parts as $part) {
            if (strpos($part, '=') === false) {
                $flags[] = $part;
            } else {
                if (preg_match('/^(\w+)="([^"]*)"$/', $part, $matches)) {
                    $metadata[$matches[1]] = $matches[2];
                }
            }
        }

        // Only process tools
        if (!in_array('tool', $flags)) {
            continue;
        }

        // Get tool name (first directory or file name)
        $tool_name = basename(rtrim($path, '/'));

        $tools[$tool_name] = [
            'path'         => $path,
            'is_admin'     => in_array('admin', $flags),
            'is_invite'    => in_array('invite', $flags),
            'display_name' => $metadata['name'] ?? $tool_name,
            'icon'         => $metadata['icon']        ?? null,
            'description'  => $metadata['description'] ?? null,
            'hidden'       => in_array('hidden', $flags),
            'is_git'       => in_array('git', $flags),
            'build'        => $metadata['build'] ?? null,
        ];
    }

    return $tools;
}

/**
 * Get all tools from manifest
 * @return array
 */
function instrumenta_get_tools() {
    static $tools = null;
    if ($tools === null) {
        $tools = instrumenta_parse_manifest();
    }
    return $tools;
}

/**
 * Get a specific tool by name
 * @param string $tool_name
 * @return array|null
 */
function instrumenta_get_tool($tool_name) {
    $tools = instrumenta_get_tools();
    return $tools[$tool_name] ?? null;
}

/**
 * Get list of invite-only tools
 * @return array
 */
function instrumenta_get_invite_tools() {
    $tools       = instrumenta_get_tools();
    $invite_tools = [];

    foreach ($tools as $name => $tool) {
        if ($tool['is_invite']) {
            $invite_tools[$name] = $tool['display_name'];
        }
    }

    return $invite_tools;
}


function instrumenta_get_users() {
    global $instrumenta_users_file;
    return json_decode(file_get_contents($instrumenta_users_file), true);
}

function instrumenta_save_users($users) {
    global $instrumenta_users_file;
    file_put_contents($instrumenta_users_file, json_encode($users, JSON_PRETTY_PRINT));
}

function log_auth_attempt($username, $status, $method, $details = []) {
    global $auth_log_file;

    $ip = $_SERVER['REMOTE_ADDR'];
    $forwardedHeaders = ['HTTP_CLIENT_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_FORWARDED', 'HTTP_X_CLUSTER_CLIENT_IP', 'HTTP_FORWARDED_FOR', 'HTTP_FORWARDED'];

    foreach ($forwardedHeaders as $header) {
        if (!empty($_SERVER[$header])) {
            $ips = explode(',', $_SERVER[$header]);
            $ip  = trim($ips[0]);
            break;
        }
    }

    if (!filter_var($ip, FILTER_VALIDATE_IP)) {
        $ip = $_SERVER['REMOTE_ADDR'];
    }

    $log_entry = [
        'timestamp' => date('Y-m-d H:i:s'),
        'username'  => $username,
        'status'    => $status,
        'method'    => $method,
        'ip'        => $ip,
        'details'   => $details
    ];

    file_put_contents($auth_log_file, json_encode($log_entry) . PHP_EOL, FILE_APPEND);
}

/**
 * Check if a user has access to a specific tool
 * @param string|null $username
 * @param array|null  $userData
 * @param string      $script_path
 * @param string      $method
 * @return bool
 */
function instrumenta_user_has_access(?string $username, ?array $userData, string $script_path, string $method) {
    $tool_name = instrumenta_get_tool_name($script_path);
    $tool      = instrumenta_get_tool($tool_name);

    // Tool not found in manifest → allow access (permissive default)
    if ($tool === null) {
        log_auth_attempt($username ?? 'anonymous', 'success', $method, [
            'tool'   => $tool_name,
            'access' => 'non_tool_file'
        ]);
        return true;
    }

    // ---- 1. Admin-only tools require admin ----
    if ($tool['is_admin']) {
        if ($username === null || $userData === null || empty($userData['is_admin'])) {
            log_auth_attempt($username ?? 'anonymous', 'failed', $method, [
                'tool'   => $tool_name,
                'reason' => 'admin_required'
            ]);
            return false;
        }
        log_auth_attempt($username, 'success', $method, [
            'tool'   => $tool_name,
            'access' => 'admin'
        ]);
        return true;
    }

    // ---- 2. Must be authenticated for tools ----
    if ($username === null || $userData === null) {
        log_auth_attempt('anonymous', 'failed', $method, [
            'tool'   => $tool_name,
            'reason' => 'not_authenticated'
        ]);
        return false;
    }

    // ---- 3. Invite-required tools ----
    if ($tool['is_invite']) {
        $invited_apps = $userData['invited_apps'] ?? [];
        if (!in_array($tool_name, $invited_apps)) {
            log_auth_attempt($username, 'failed', $method, [
                'tool'         => $tool_name,
                'reason'       => 'invite_required',
                'invited_apps' => $invited_apps
            ]);
            return false;
        }
        log_auth_attempt($username, 'success', $method, [
            'tool'   => $tool_name,
            'access' => 'invite'
        ]);
        return true;
    }

    // ---- 4. Regular tool - all authenticated users ----
    log_auth_attempt($username, 'success', $method, [
        'tool'   => $tool_name,
        'access' => 'standard'
    ]);
    return true;
}


/**
 * Check access via session
 * @param string $script_path
 * @return string|null Username if authorized, null otherwise
 */
function instrumenta_check_access($script_path) {
    $tool_name = instrumenta_get_tool_name($script_path);

    if (!isset($_SESSION['user'])) {
        log_auth_attempt('anonymous', 'failed', 'session', [
            'tool'   => $tool_name,
            'reason' => 'no_session'
        ]);
        return null;
    }

    $users    = instrumenta_get_users();
    $username = $_SESSION['user'];

    if (!isset($users[$username])) {
        log_auth_attempt($username, 'failed', 'session', [
            'tool'         => $tool_name,
            'reason'       => 'user_not_found',
            'session_data' => $_SESSION
        ]);
        return null;
    }

    if (instrumenta_user_has_access($username, $users[$username], $script_path, 'session')) {
        return $username;
    }

    return null;
}


/**
 * Resolve a raw token string (API key) to a username.
 * Used by both the Bearer header and (deprecated) ?apikey= query param paths.
 *
 * @param string $token
 * @param string $script_path
 * @param string $method  'bearer' | 'api' (for logging)
 * @return string|null
 */
function instrumenta_resolve_api_key(string $token, string $script_path, string $method): ?string {
    $users = instrumenta_get_users();

    foreach ($users as $username => $userData) {
        if (!empty($userData['api_key']) && hash_equals($userData['api_key'], $token)) {
            if (instrumenta_user_has_access($username, $userData, $script_path, $method)) {
                return $username;
            }
            return null;
        }
    }

    log_auth_attempt('unknown', 'failed', $method, [
        'tool'   => instrumenta_get_tool_name($script_path),
        'reason' => 'invalid_token',
    ]);

    return null;
}


/**
 * Check access via Bearer token in the Authorization header.
 * This is the preferred method for PWAs and embedded apps.
 *
 * @param string $script_path
 * @return string|null
 */
function instrumenta_check_bearer_access(string $script_path): ?string {
    $auth_header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer\s+(.+)$/i', $auth_header, $matches)) {
        return null;
    }
    return instrumenta_resolve_api_key(trim($matches[1]), $script_path, 'bearer');
}


/**
 * Check access via ?apikey= query parameter.
 * Deprecated: use Authorization: Bearer instead.
 *
 * @param string $script_path
 * @return string|null
 */
function instrumenta_check_api_access($script_path): ?string {
    return instrumenta_resolve_api_key($_GET['apikey'], $script_path, 'api');
}


/**
 * Get tool name from script path
 * @param string $script_path
 * @return string
 */
function instrumenta_get_tool_name($script_path) {
    $doc_root = rtrim($_SERVER['DOCUMENT_ROOT'], '/');
    $relative = ltrim(str_replace($doc_root, '', $script_path), '/');
    $parts    = array_values(array_filter(explode('/', $relative)));

    if (count($parts) === 0) {
        return '';
    }

    // Root-level file → keep extension
    if (count($parts) === 1) {
        return $parts[0];
    }

    // First-level directory
    return $parts[0];
}


// ============================================================
// Session token helpers
// ============================================================

/** Cookie lifetime for persistent session tokens: 30 days */
define('SESSION_TOKEN_LIFETIME', 60 * 60 * 24 * 30);

/**
 * Set the session_token cookie using consistent options.
 */
function _set_session_token_cookie(string $token, int $expires): void {
    global $_secure_cookie;
    setcookie('session_token', $token, [
        'expires'  => $expires,
        'path'     => '/',
        'secure'   => $_secure_cookie,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/**
 * Clear the session_token cookie.
 */
function _clear_session_token_cookie(): void {
    global $_secure_cookie;
    setcookie('session_token', '', [
        'expires'  => 1,
        'path'     => '/',
        'secure'   => $_secure_cookie,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}


// ============================================================
// Auth Resolution  (Priority order)
// ============================================================
// 1. Bearer token in Authorization header  — preferred for PWA / embedded apps
// 2. API key in ?apikey= query param       — deprecated, kept for backward compat
// 3. session_token persistent cookie       — rotated long-lived token
// 4. PHP $_SESSION variable                — set after cookie/password auth
// ============================================================

$authorized_user = null;

// --- Priority 1: Bearer token ---
$authorized_user = instrumenta_check_bearer_access($_SERVER['SCRIPT_FILENAME']);

// --- Priority 2: API key query param (deprecated) ---
if ($authorized_user === null && isset($_GET['apikey'])) {
    $authorized_user = instrumenta_check_api_access($_SERVER['SCRIPT_FILENAME']);
}

// --- Priority 3 & 4: Cookie / session ---
if ($authorized_user === null) {

    // Hydrate $_SESSION from the persistent session_token cookie if needed.
    //
    // Race condition fix: when the PHP session expires, multiple concurrent
    // requests can all arrive with the same session_token cookie. Without
    // serialisation only one would succeed (after rotation deletes the file).
    //
    // We fix this with two measures:
    //   a) flock() on a per-token lock file ensures only ONE request rotates.
    //   b) After rotation we KEEP the old token file valid for a short grace
    //      period (30 s) so concurrent requests that already read the old
    //      cookie value can still hydrate their session without a re-rotate.
    if (!isset($_SESSION['user']) && !empty($_COOKIE['session_token'])) {
        $token = $_COOKIE['session_token'];

        // Security: validate format before using as a filename (path traversal guard)
        if (preg_match('/^[a-f0-9]{64}$/', $token)) {
            $tokenFile = INSTRUMENTA_TOKEN_DIR . $token;
            $lockFile  = $tokenFile . '.lock';

            if (file_exists($tokenFile)) {
                // Acquire an exclusive lock so only one concurrent request rotates.
                // Other requests block here briefly, then see rotated_at is set.
                $lockFd = @fopen($lockFile, 'c');
                $locked = $lockFd && flock($lockFd, LOCK_EX);

                // Re-read inside the lock (another request may have rotated by now)
                $tokenData = $tokenFile && file_exists($tokenFile)
                    ? @json_decode(@file_get_contents($tokenFile), true)
                    : null;

                if ($tokenData && isset($tokenData['username'])) {
                    $users    = instrumenta_get_users();
                    $username = $tokenData['username'];
                    $isValid  = isset($users[$username]);

                    if (!$isValid) {
                        // User no longer exists — clear everything
                        @unlink($tokenFile);
                        _clear_session_token_cookie();
                        log_auth_attempt($username, 'failed', 'token', ['reason' => 'user_not_found']);

                    } elseif (isset($tokenData['rotated_at'])) {
                        // This token was already rotated by a concurrent request.
                        // Honour it during the grace window so the concurrent request
                        // does not get logged out.
                        if ((time() - $tokenData['rotated_at']) < 30) {
                            session_regenerate_id(true);
                            $_SESSION['user']     = $username;
                            $_SESSION['is_admin'] = !empty($users[$username]['is_admin']);
                            log_auth_attempt($username, 'success', 'token', ['token_grace' => true]);
                        } else {
                            // Grace period expired — clean up
                            @unlink($tokenFile);
                            _clear_session_token_cookie();
                        }

                    } elseif ($tokenData['expires'] <= time()) {
                        // Token genuinely expired
                        @unlink($tokenFile);
                        _clear_session_token_cookie();
                        log_auth_attempt($username, 'failed', 'token', ['reason' => 'token_expired']);

                    } else {
                        // Valid, unrotated token — rotate it
                        $newToken    = bin2hex(random_bytes(32));
                        $newExpires  = time() + SESSION_TOKEN_LIFETIME;

                        // Write new token first (so it's ready before clients need it)
                        file_put_contents(
                            INSTRUMENTA_TOKEN_DIR . $newToken,
                            json_encode(['username' => $username, 'expires' => $newExpires])
                        );

                        // Set new cookie
                        _set_session_token_cookie($newToken, $newExpires);

                        // Mark old token as rotated with a short grace window for
                        // in-flight concurrent requests that carry the old cookie value.
                        file_put_contents($tokenFile, json_encode([
                            'username'   => $username,
                            'expires'    => time() + 30,   // keeps file_exists true briefly
                            'rotated_at' => time(),
                        ]));

                        // Hydrate this request's session
                        session_regenerate_id(true);
                        $_SESSION['user']     = $username;
                        $_SESSION['is_admin'] = !empty($users[$username]['is_admin']);

                        log_auth_attempt($username, 'success', 'token', ['token_rotated' => true]);
                    }
                } else {
                    // Corrupt or missing file — clear cookie
                    @unlink($tokenFile);
                    _clear_session_token_cookie();
                    log_auth_attempt('unknown', 'failed', 'token', ['reason' => 'invalid_token']);
                }

                if ($locked) {
                    flock($lockFd, LOCK_UN);
                }
                if ($lockFd) {
                    fclose($lockFd);
                }
                @unlink($lockFile);

            } else {
                // Token file doesn't exist — stale cookie
                _clear_session_token_cookie();
                log_auth_attempt('unknown', 'failed', 'token', ['reason' => 'invalid_token']);
            }
        } else {
            // Malformed token value — clear it
            _clear_session_token_cookie();
        }
    }

    $authorized_user = instrumenta_check_access($_SERVER['SCRIPT_FILENAME']);
}
?>
