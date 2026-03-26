<?php
require_once 'iauth.php';
// INSTRUMENTA_TOKEN_DIR and SESSION_TOKEN_LIFETIME are defined in iauth.php

// API endpoints
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);

    try {
        switch ($_GET['action'] ?? '') {
            case 'register':
                $username = $data['username'] ?? '';
                $password = $data['password'] ?? '';

                // Validation
                if (strlen($username) < 3 || strlen($username) > 20) {
                    echo json_encode(['success' => false, 'error' => 'Username must be 3-20 characters']);
                    exit;
                }

                if (!preg_match('/^[a-zA-Z0-9_]+$/', $username)) {
                    echo json_encode(['success' => false, 'error' => 'Username can only contain letters, numbers, and underscores']);
                    exit;
                }

                if (strlen($password) < 8) {
                    echo json_encode(['success' => false, 'error' => 'Password must be at least 8 characters']);
                    exit;
                }

                $users = instrumenta_get_users();

                if (isset($users[$username])) {
                    echo json_encode(['success' => false, 'error' => 'Username already exists']);
                    exit;
                }

                // Create new user
                $users[$username] = [
                    'password' => password_hash($password, PASSWORD_DEFAULT),
                    'is_admin' => false,
                    'invited_apps' => [],
                    'api_key' => bin2hex(random_bytes(32))
                ];

                instrumenta_save_users($users);
                log_auth_attempt($username, 'success', 'register', ['new_user' => true]);

                echo json_encode(['success' => true, 'message' => 'Account created successfully']);
                exit;

            case 'login':
                instrumenta_debug_log('LOGIN_ATTEMPT', $data);
                $users = instrumenta_get_users();
                $username = $data['username'] ?? '';

                instrumenta_debug_log('LOGIN_USER_EXISTS', isset($users[$username]));

                if (isset($users[$username]) && password_verify($data['password'], $users[$username]['password'])) {
                    session_regenerate_id(true);

                    $_SESSION['user'] = $username;
                    $_SESSION['is_admin'] = $users[$username]['is_admin'];

                    if (true) {
                        $token   = bin2hex(random_bytes(32));
                        $expires = time() + SESSION_TOKEN_LIFETIME;

                        $tokenData = [
                            'username' => $username,
                            'expires'  => $expires,
                        ];

                        $tokenFilePath = INSTRUMENTA_TOKEN_DIR . $token;
                        instrumenta_debug_log('TOKEN_FILE_PATH', $tokenFilePath);

                        file_put_contents($tokenFilePath, json_encode($tokenData));
                        instrumenta_debug_log('TOKEN_WRITTEN', file_exists($tokenFilePath));
                        _set_session_token_cookie($token, $expires);
                    }

                    log_auth_attempt($username, 'success', 'password', [
                        'session_started' => true,
                        'persistent' => true
                    ]);
                    $users = instrumenta_get_users();
                    $token = $users[$username]['api_key'];
                    echo json_encode([
                        'success' => true,
                        'token'   => $token,  // preferred: use as Authorization: Bearer
                        'apikey'  => $token,  // deprecated: backward compat
                    ]);
                } else {
                    log_auth_attempt($username, 'failed', 'password', [
                        'reason' => isset($users[$username]) ? 'invalid_password' : 'user_not_found'
                    ]);
                    echo json_encode(['success' => false, 'error' => 'Invalid credentials']);
                }
                exit;

            case 'logout':
                if (isset($_COOKIE['session_token'])) {
                    $token = $_COOKIE['session_token'];
                    $tokenFile = INSTRUMENTA_TOKEN_DIR . $_COOKIE['session_token'];

                    if (file_exists($tokenFile)) {
                        unlink($tokenFile);
                    }

                    _clear_session_token_cookie();
                }

                $logged_out_user = $_SESSION['user'] ?? 'unknown';
                session_destroy();
                log_auth_attempt($logged_out_user, 'success', 'logout', [
                    'logout' => true,
                ]);
                echo json_encode(['success' => true]);
                exit;

            case 'get_users':
                if (!isset($_SESSION['is_admin']) || !$_SESSION['is_admin']) {
                    throw new Exception('Unauthorized');
                }
                $users = instrumenta_get_users();
                $sanitized = [];
                foreach ($users as $un => $u) {
                    $sanitized[$un] = [
                        'is_admin' => $u['is_admin'],
                        'invited_apps' => $u['invited_apps'] ?? []
                    ];
                }
                echo json_encode($sanitized);
                exit;

            case 'get_user':
                if (!isset($_SESSION['is_admin']) || !$_SESSION['is_admin']) {
                    throw new Exception('Unauthorized');
                }

                $username = $data['username'] ?? '';
                $users = instrumenta_get_users();

                if (!isset($users[$username])) {
                    throw new Exception('User not found');
                }

                echo json_encode([
                    'is_admin' => $users[$username]['is_admin'],
                    'invited_apps' => $users[$username]['invited_apps'] ?? []
                ]);
                exit;

            case 'user_action':
                if (!isset($_SESSION['is_admin']) || !$_SESSION['is_admin']) {
                    throw new Exception('Unauthorized');
                }

                $users = instrumenta_get_users();
                $action = $data['user_action'];
                $username = $data['username'];

                switch ($action) {
                    case 'create':
                        $users[$username] = [
                            'password' => password_hash($data['password'], PASSWORD_DEFAULT),
                            'is_admin' => $data['is_admin'] ?? false,
                            'invited_apps' => $data['invited_apps'] ?? [],
                            'api_key' => bin2hex(random_bytes(32))
                        ];
                        break;

                    case 'update':
                        if (isset($users[$username])) {
                            if (!empty($data['password'])) {
                                $users[$username]['password'] = password_hash($data['password'], PASSWORD_DEFAULT);
                            }
                            $users[$username]['is_admin'] = $data['is_admin'] ?? $users[$username]['is_admin'];
                            $users[$username]['invited_apps'] = $data['invited_apps'] ?? ($users[$username]['invited_apps'] ?? []);
                        }
                        break;

                    case 'delete':
                        unset($users[$username]);
                        break;
                }

                instrumenta_save_users($users);
                echo json_encode(['success' => true]);
                exit;

            case 'add_invite':
                if (!isset($_SESSION['is_admin']) || !$_SESSION['is_admin']) {
                    throw new Exception('Unauthorized');
                }

                $username = $data['username'] ?? '';
                $app_name = $data['app_name'] ?? '';

                $users = instrumenta_get_users();
                if (!isset($users[$username])) {
                    throw new Exception('User not found');
                }

                if (empty($app_name)) {
                    throw new Exception('App name required');
                }

                if (!isset($users[$username]['invited_apps'])) {
                    $users[$username]['invited_apps'] = [];
                }

                if (!in_array($app_name, $users[$username]['invited_apps'])) {
                    $users[$username]['invited_apps'][] = $app_name;
                    instrumenta_save_users($users);
                }

                echo json_encode(['success' => true, 'invited_apps' => $users[$username]['invited_apps']]);
                exit;

            case 'remove_invite':
                if (!isset($_SESSION['is_admin']) || !$_SESSION['is_admin']) {
                    throw new Exception('Unauthorized');
                }

                $username = $data['username'] ?? '';
                $app_name = $data['app_name'] ?? '';

                $users = instrumenta_get_users();
                if (!isset($users[$username])) {
                    throw new Exception('User not found');
                }

                $users[$username]['invited_apps'] = array_values(array_filter(
                    $users[$username]['invited_apps'] ?? [],
                    fn($app) => $app !== $app_name
                ));
                instrumenta_save_users($users);

                echo json_encode(['success' => true, 'invited_apps' => $users[$username]['invited_apps']]);
                exit;

            case 'get_invite_tools':
                // Available to any authenticated user
                if (!$authorized_user) {
                    throw new Exception('Unauthorized');
                }
                $invite_tools = instrumenta_get_invite_tools();
                echo json_encode($invite_tools);
                exit;

            default:
                throw new Exception('Invalid action');
        }
    } catch (Exception $e) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        exit;
    }
}

// Get
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['action'])) {
    try {
        switch ($_GET['action']) {
            case 'get_apikey':
                if (!isset($_SESSION['user'])) throw new Exception('Unauthorized');
                $users = instrumenta_get_users();
                $user = $users[$_SESSION['user']];
                echo json_encode(['api_key' => $user['api_key']]);
                exit;

            case 'get_current_user':
                if (!$authorized_user) throw new Exception('Unauthorized');
                echo json_encode(['username' => $authorized_user]);
                exit;

            case 'get_all_invite_tools':
                // Available to any authenticated user
                if (!$authorized_user) throw new Exception('Unauthorized');
                $invite_tools = instrumenta_get_invite_tools();
                echo json_encode($invite_tools);
                exit;
        }
    } catch (Exception $e) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        exit;
    }
}
?>
